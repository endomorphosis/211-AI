import { AUDIO_CHAT_CONFIG, getClientAudioModelInfo } from "./audioChatConfig";
import {
  generateRemoteAudio,
  isRemoteVoiceProxyConfigured,
  preflightRemoteAudioProxy,
  type RemoteAudioGenerationResult,
} from "./remoteAudioClient";
import { parseVoiceGraphRagPrompt } from "./voiceGraphRagPrompt";

type ClientAudioProvider = "remote-voice-proxy" | "local-liquidai" | "browser-speech";
const LOCAL_AUDIO_RETRY_COOLDOWN_MS = 60_000;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (progress: ClientAudioProgress) => void;
}

interface AudioWorkerResponse {
  audioBlob?: Blob;
  mimeType?: string;
  modelName?: string;
  provider?: ClientAudioProvider;
  text?: string;
}

interface AudioWorkerMessage {
  id: string;
  type?: "progress";
  success?: boolean;
  data?: AudioWorkerResponse;
  error?: string;
  progress?: ClientAudioProgress;
}

export type ClientAudioProgressPhase =
  | "queued"
  | "loading-runtime"
  | "downloading-model"
  | "warming-up"
  | "ready"
  | "generating"
  | "decoding"
  | "fallback";

export interface ClientAudioProgress {
  phase: ClientAudioProgressPhase;
  progress: number;
  status: string;
  file?: string;
  modelName?: string;
}

export type ClientAudioReplyResult =
  | {
      kind: "audio";
      audioBlob: Blob;
      mimeType: string;
      modelName: string;
      provider: "remote-voice-proxy" | "local-liquidai";
      text?: string;
    }
  | {
      kind: "browser-speech";
      text: string;
      modelName: string;
      provider: "browser-speech";
      fallbackForModel: string;
      fallbackReason: string;
    };

export type ClientAudioWarmupResult =
  | {
      kind: "remote-ready";
      modelName: string;
      provider: "remote-voice-proxy";
    }
  | {
      kind: "local-ready";
      modelName: string;
      provider: "local-liquidai";
    }
  | {
      kind: "fallback";
      modelName: string;
      provider: "browser-speech";
      fallbackReason: string;
    };

interface ClientAudioProgressOptions {
  onProgress?: (progress: ClientAudioProgress) => void;
}

interface ClientAudioReplyServiceOptions {
  createWorker?: () => Worker;
  generateRemoteAudio?: (options: {
    mode: "tts" | "voice-reply";
    text: string;
    systemPrompt?: string;
    userPrompt?: string;
    fallbackText?: string;
    localModelName?: string;
    audioBlob?: Blob;
  }) => Promise<RemoteAudioGenerationResult>;
  preflightRemoteAudioProxy?: (mode?: "tts" | "voice-reply") => Promise<RemoteAudioGenerationResult>;
  getLocalAudioBlockReason?: () => string | undefined;
  hasWebGPU?: () => boolean;
  hasSpeechSynthesis?: () => boolean;
  now?: () => number;
  voiceProxyEnabled?: boolean;
}

export interface ClientVoiceReplyRequest {
  prompt: string;
  systemPrompt?: string;
  userPrompt?: string;
  fallbackText: string;
  audioBlob?: Blob;
}

export class ClientAudioReplyService {
  private worker: Worker | null = null;
  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest<AudioWorkerResponse>>();
  private localAudioReady = false;
  private warmupInProgress = false;
  private localAudioUnavailableReason: string | undefined;
  private localAudioUnavailableAt = 0;
  private remoteAudioLastError: string | undefined;
  private remoteAudioLastUsedAt: string | undefined;
  private remoteAudioPreflight: "unknown" | "ready" | "failed" = "unknown";
  private remoteAudioPreflightPromise: Promise<boolean> | null = null;
  private remoteSpeechToTextLastError: string | undefined;
  private remoteSpeechToTextPreflight: "unknown" | "ready" | "failed" = "unknown";
  private readonly createWorker: () => Worker;
  private readonly generateRemoteAudio: (options: {
    mode: "tts" | "voice-reply";
    text: string;
    systemPrompt?: string;
    userPrompt?: string;
    fallbackText?: string;
    localModelName?: string;
    audioBlob?: Blob;
  }) => Promise<RemoteAudioGenerationResult>;
  private readonly preflightRemoteAudioProxy: (mode?: "tts" | "voice-reply") => Promise<RemoteAudioGenerationResult>;
  private readonly getLocalAudioBlockReason: () => string | undefined;
  private readonly hasWebGPU: () => boolean;
  private readonly hasSpeechSynthesis: () => boolean;
  private readonly now: () => number;
  private readonly voiceProxyEnabledOverride: boolean | undefined;
  private readonly hasInjectedRemoteAudio: boolean;

  constructor(options: ClientAudioReplyServiceOptions = {}) {
    this.hasInjectedRemoteAudio = Boolean(options.generateRemoteAudio);
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.generateRemoteAudio = options.generateRemoteAudio ?? generateRemoteAudio;
    this.preflightRemoteAudioProxy = options.preflightRemoteAudioProxy ?? preflightRemoteAudioProxy;
    this.getLocalAudioBlockReason = options.getLocalAudioBlockReason ?? defaultGetLocalAudioBlockReason;
    this.hasWebGPU = options.hasWebGPU ?? defaultHasWebGPU;
    this.hasSpeechSynthesis = options.hasSpeechSynthesis ?? defaultHasSpeechSynthesis;
    this.now = options.now ?? Date.now;
    this.voiceProxyEnabledOverride = options.voiceProxyEnabled;
  }

  async warmUp(options: ClientAudioProgressOptions = {}): Promise<ClientAudioWarmupResult> {
    const modelName = AUDIO_CHAT_CONFIG.defaultModel;
    if (this.canUseRemoteAudio()) {
      options.onProgress?.({
        phase: "queued",
        progress: 0,
        status: "Checking voice proxy before local audio.",
        modelName: AUDIO_CHAT_CONFIG.voiceProxyModel,
      });
      const proxyReady = await this.ensureRemoteAudioPreflight("tts");
      if (!proxyReady) {
        options.onProgress?.({
          phase: "fallback",
          progress: 0,
          status: this.canTryLocalAudioAfterRemoteVoiceFailure()
            ? "Voice proxy unavailable; preparing local audio."
            : "Voice proxy unavailable; using browser speech.",
          modelName,
        });
        if (!this.canTryLocalAudioAfterRemoteVoiceFailure() && this.hasSpeechSynthesis()) {
          return {
            kind: "fallback",
            modelName: AUDIO_CHAT_CONFIG.fallbackVoiceModel,
            provider: "browser-speech",
            fallbackReason: this.getCombinedFallbackReason(modelName, this.remoteAudioLastError, true),
          };
        }
      } else {
        options.onProgress?.({
          phase: "ready",
          progress: 100,
          status: "Voice proxy ready.",
          modelName: AUDIO_CHAT_CONFIG.voiceProxyModel,
        });
        return {
          kind: "remote-ready",
          modelName: AUDIO_CHAT_CONFIG.voiceProxyModel,
          provider: "remote-voice-proxy",
        };
      }
    }
    if (this.localAudioReady && this.canAttemptLocalAudio(modelName)) {
      options.onProgress?.({
        phase: "ready",
        progress: 100,
        status: "Audio model ready.",
        modelName,
      });
      return {
        kind: "local-ready",
        modelName,
        provider: "local-liquidai",
      };
    }
    if (this.canAttemptLocalAudio(modelName)) {
      try {
        this.warmupInProgress = true;
        options.onProgress?.({
          phase: "queued",
          progress: 0,
          status: "Preparing local audio model.",
          modelName,
        });
        await this.sendWorkerRequest(
          "warmUp",
          { modelName },
          AUDIO_CHAT_CONFIG.warmupTimeoutMs,
          "Audio model warmup timed out.",
          options.onProgress,
        );
        this.localAudioReady = true;
        return {
          kind: "local-ready",
          modelName,
          provider: "local-liquidai",
        };
      } catch (error) {
        this.localAudioReady = false;
        this.markLocalAudioUnavailable(formatError(error));
        this.restartWorker(this.localAudioUnavailableReason);
      } finally {
        this.warmupInProgress = false;
      }
    }

    if (!this.hasSpeechSynthesis()) {
      throw new Error(this.getLocalAudioFallbackReason(modelName, false));
    }
    const fallbackReason = this.getLocalAudioFallbackReason(modelName, true);
    options.onProgress?.({
      phase: "fallback",
      progress: 100,
      status: "Using browser speech output.",
      modelName,
    });
    return {
      kind: "fallback",
      modelName: AUDIO_CHAT_CONFIG.fallbackVoiceModel,
      provider: "browser-speech",
      fallbackReason,
    };
  }

  async generateAudio(text: string, options: ClientAudioProgressOptions = {}): Promise<ClientAudioReplyResult> {
    const normalizedText = text.trim().slice(0, AUDIO_CHAT_CONFIG.maxPromptCharacters);
    if (!normalizedText) {
      throw new Error("Audio reply text is empty.");
    }

    const modelName = AUDIO_CHAT_CONFIG.defaultModel;
    if (this.canUseRemoteAudio()) {
      try {
        return await this.generateProxyAudio({
          mode: "tts",
          text: normalizedText,
          localModelName: modelName,
          onProgress: options.onProgress,
        });
      } catch (error) {
        this.markRemoteAudioUnavailable(error);
      }
    }
    if (this.shouldUseWarmupFallback()) {
      return this.browserSpeechFallback(
        normalizedText,
        modelName,
        this.getCombinedFallbackReason(modelName, this.remoteAudioLastError, true),
      );
    }

    if (this.canAttemptLocalAudio(modelName)) {
      try {
        const result = await this.sendWorkerRequest(
          "generateAudio",
          { text: normalizedText, modelName },
          this.getGenerationTimeoutMs(),
          "Audio generation timed out.",
          options.onProgress,
        );
        if (result.audioBlob) {
          this.localAudioReady = true;
          return {
            kind: "audio",
            audioBlob: result.audioBlob,
            mimeType: result.mimeType || result.audioBlob.type || "audio/wav",
            modelName: result.modelName || modelName,
            provider: "local-liquidai",
            text: result.text,
          };
        }
        throw new Error("Audio worker completed without an audio blob.");
      } catch (error) {
        this.localAudioReady = false;
        this.markLocalAudioUnavailable(formatError(error));
        this.restartWorker(this.localAudioUnavailableReason);
      }
    }

    if (this.hasSpeechSynthesis()) {
      return this.browserSpeechFallback(
        normalizedText,
        modelName,
        this.getCombinedFallbackReason(modelName, this.remoteAudioLastError, true),
      );
    }

    throw new Error(this.getCombinedFallbackReason(modelName, this.remoteAudioLastError, false));
  }

  async generateRemoteTextAudio(text: string, options: ClientAudioProgressOptions = {}): Promise<ClientAudioReplyResult> {
    const normalizedText = text.trim().slice(0, AUDIO_CHAT_CONFIG.maxPromptCharacters);
    if (!normalizedText) {
      throw new Error("Audio reply text is empty.");
    }
    if (!this.canUseRemoteAudio()) {
      throw new Error("Voice proxy is unavailable.");
    }
    try {
      return await this.generateProxyAudio({
        mode: "tts",
        text: normalizedText,
        localModelName: AUDIO_CHAT_CONFIG.defaultModel,
        onProgress: options.onProgress,
        requireAudioBlob: true,
        skipPreflight: true,
      });
    } catch (error) {
      this.remoteAudioLastError = formatError(error);
      throw error;
    }
  }

  async generateVoiceReply(
    input: ClientVoiceReplyRequest,
    options: ClientAudioProgressOptions = {},
  ): Promise<ClientAudioReplyResult> {
    const normalizedPrompt = input.prompt.trim().slice(0, AUDIO_CHAT_CONFIG.maxPromptCharacters);
    const parsedPrompt = parseVoiceGraphRagPrompt(normalizedPrompt);
    const normalizedSystemPrompt = (input.systemPrompt?.trim() || parsedPrompt?.systemPrompt || "")
      .slice(0, AUDIO_CHAT_CONFIG.maxPromptCharacters);
    const normalizedUserPrompt = (input.userPrompt?.trim() || parsedPrompt?.userPrompt || "")
      .slice(0, AUDIO_CHAT_CONFIG.maxPromptCharacters);
    const normalizedFallback = input.fallbackText.trim().slice(0, AUDIO_CHAT_CONFIG.maxPromptCharacters);
    const normalizedSpeechText = normalizedFallback || normalizedPrompt;
    if (!normalizedPrompt) {
      throw new Error("Voice reply prompt is empty.");
    }

    const modelName = AUDIO_CHAT_CONFIG.defaultModel;
    if (this.canUseRemoteAudio()) {
      try {
        return await this.generateProxyAudio({
          mode: "voice-reply",
          text: normalizedFallback || normalizedPrompt,
          systemPrompt: normalizedSystemPrompt || undefined,
          userPrompt: normalizedUserPrompt || undefined,
          fallbackText: normalizedFallback || undefined,
          audioBlob: input.audioBlob,
          localModelName: modelName,
          onProgress: options.onProgress,
        });
      } catch (error) {
        this.markRemoteAudioUnavailable(error);
      }
    }
    if (this.shouldUseWarmupFallback()) {
      return this.browserSpeechFallback(
        normalizedFallback || "I found an answer, but the local audio model is still warming up.",
        modelName,
        this.getCombinedFallbackReason(modelName, this.remoteAudioLastError, true),
      );
    }

    if (this.canAttemptLocalAudio(modelName)) {
      try {
        const result = await this.sendWorkerRequest(
          "generateVoiceReply",
          { text: normalizedPrompt, fallbackText: normalizedFallback, modelName },
          this.getGenerationTimeoutMs(),
          "Voice reply generation timed out.",
          options.onProgress,
        );
        if (result.audioBlob) {
          this.localAudioReady = true;
          return {
            kind: "audio",
            audioBlob: result.audioBlob,
            mimeType: result.mimeType || result.audioBlob.type || "audio/wav",
            modelName: result.modelName || modelName,
            provider: "local-liquidai",
            text: result.text,
          };
        }
        throw new Error("Audio worker completed without an audio blob.");
      } catch (error) {
        this.localAudioReady = false;
        this.markLocalAudioUnavailable(formatError(error));
        this.restartWorker(this.localAudioUnavailableReason);
      }
    }

    if (this.hasSpeechSynthesis()) {
      return this.browserSpeechFallback(
        normalizedFallback || "I found an answer, but local audio generation is not available.",
        modelName,
        this.getCombinedFallbackReason(modelName, this.remoteAudioLastError, true),
      );
    }

    throw new Error(this.getCombinedFallbackReason(modelName, this.remoteAudioLastError, false));
  }

  getStatus() {
    return {
      defaultModel: AUDIO_CHAT_CONFIG.defaultModel,
      defaultModelInfo: getClientAudioModelInfo(AUDIO_CHAT_CONFIG.defaultModel),
      remoteAudioEnabled: this.isVoiceProxyEnabled(),
      remoteAudioConfigured: this.canUseRemoteAudio(),
      remoteAudioEndpoint: AUDIO_CHAT_CONFIG.voiceProxyInferUrl,
      remoteAudioFallbackEndpoint: AUDIO_CHAT_CONFIG.voiceProxyFallbackInferUrl,
      remoteAudioLastError: this.remoteAudioLastError,
      remoteAudioLastUsedAt: this.remoteAudioLastUsedAt,
      remoteAudioPreflight: this.remoteAudioPreflight,
      remoteSpeechToTextLastError: this.remoteSpeechToTextLastError,
      remoteSpeechToTextPreflight: this.remoteSpeechToTextPreflight,
      remoteAudioProxyMode: "multipart-wav",
      localAudioEnabled: AUDIO_CHAT_CONFIG.enableLocalAudio,
      localAudioAvailable: this.canAttemptLocalAudio(AUDIO_CHAT_CONFIG.defaultModel),
      localAudioReady: this.localAudioReady,
      localAudioWarmingUp: this.warmupInProgress,
      localAudioUnavailableReason:
        this.localAudioUnavailableReason || this.getImmediateLocalAudioUnavailableReason(AUDIO_CHAT_CONFIG.defaultModel),
      fallbackVoiceAvailable: this.hasSpeechSynthesis(),
    };
  }

  private canAttemptLocalAudio(modelName: string): boolean {
    if (this.getImmediateLocalAudioUnavailableReason(modelName)) return false;
    if (!this.localAudioUnavailableReason) return true;
    if (this.now() - this.localAudioUnavailableAt < LOCAL_AUDIO_RETRY_COOLDOWN_MS) return false;
    this.localAudioUnavailableReason = undefined;
    this.localAudioUnavailableAt = 0;
    return true;
  }

  private getLocalAudioFallbackReason(modelName: string, speechFallbackAvailable = this.hasSpeechSynthesis()): string {
    const immediateReason = this.getImmediateLocalAudioUnavailableReason(modelName);
    if (immediateReason) return appendSpeechFallbackStatus(immediateReason, speechFallbackAvailable);
    if (this.warmupInProgress && !this.localAudioReady) {
      return appendSpeechFallbackStatus(
        `${modelName} is still downloading or warming up.`,
        speechFallbackAvailable,
      );
    }
    const reason =
      this.localAudioUnavailableReason ||
      `${modelName} could not be started in the browser audio worker.`;
    return appendSpeechFallbackStatus(reason, speechFallbackAvailable);
  }

  private getImmediateLocalAudioUnavailableReason(modelName: string): string | undefined {
    if (!AUDIO_CHAT_CONFIG.enableLocalAudio) {
      return "Local audio generation is disabled by configuration.";
    }
    if (!this.canTryLocalAudioAfterRemoteVoiceFailure()) {
      return "Local audio generation waits until IndexTTS preflight fails.";
    }
    const blockReason = this.getLocalAudioBlockReason();
    if (blockReason) return blockReason;
    if (!this.hasWebGPU()) {
      return `${modelName} requires local WebGPU.`;
    }
    return undefined;
  }

  private shouldUseWarmupFallback(): boolean {
    return this.warmupInProgress && !this.localAudioReady && this.hasSpeechSynthesis();
  }

  private canUseRemoteAudio(): boolean {
    return this.isVoiceProxyEnabled() && (this.hasInjectedRemoteAudio || isRemoteVoiceProxyConfigured());
  }

  private isVoiceProxyEnabled(): boolean {
    return this.voiceProxyEnabledOverride ?? AUDIO_CHAT_CONFIG.voiceProxyEnabled;
  }

  shouldPreferRemoteAudioBeforeLocalText(): boolean {
    return this.canUseRemoteAudio() && this.remoteAudioPreflight !== "failed";
  }

  markRemoteSpeechToTextPreflight(ready: boolean, error?: unknown): void {
    this.remoteSpeechToTextPreflight = ready ? "ready" : "failed";
    this.remoteSpeechToTextLastError = ready ? undefined : formatError(error);
  }

  private async generateProxyAudio(options: {
    mode: "tts" | "voice-reply";
    text: string;
    systemPrompt?: string;
    userPrompt?: string;
    fallbackText?: string;
    audioBlob?: Blob;
    localModelName: string;
    onProgress?: (progress: ClientAudioProgress) => void;
    requireAudioBlob?: boolean;
    skipPreflight?: boolean;
  }): Promise<ClientAudioReplyResult> {
    options.onProgress?.({
      phase: "queued",
      progress: 0,
      status:
        options.skipPreflight || this.remoteAudioPreflight === "ready"
          ? "Sending audio request to voice proxy."
          : "Checking voice proxy before local audio.",
      modelName: AUDIO_CHAT_CONFIG.voiceProxyModel,
    });
    if (!options.skipPreflight && !(await this.ensureRemoteAudioPreflight(options.mode))) {
      throw new Error(this.remoteAudioLastError || "Voice proxy preflight failed.");
    }
    options.onProgress?.({
      phase: "queued",
      progress: 15,
      status: "Sending audio request to voice proxy.",
      modelName: AUDIO_CHAT_CONFIG.voiceProxyModel,
    });
    const result = await this.generateRemoteAudio({
      mode: options.mode,
      text: options.text,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      fallbackText: options.fallbackText,
      audioBlob: options.audioBlob,
      localModelName: options.localModelName,
    });
    this.remoteAudioLastError = undefined;
    this.remoteAudioLastUsedAt = new Date().toISOString();
    this.remoteAudioPreflight = "ready";
    options.onProgress?.({
      phase: "ready",
      progress: 100,
      status: "Audio reply ready.",
      modelName: result.modelName,
    });
    if (!result.audioBlob) {
      if (options.requireAudioBlob) {
        throw new Error("Voice proxy returned text only instead of audio.");
      }
      if (result.text && this.hasSpeechSynthesis()) {
        return this.browserSpeechFallback(
          result.text,
          result.modelName,
          "Voice proxy returned text only; using browser speech output.",
        );
      }
      throw new Error("Voice proxy returned text only, but browser speech output is unavailable.");
    }
    return {
      kind: "audio",
      audioBlob: result.audioBlob,
      mimeType: result.mimeType || result.audioBlob.type || "audio/wav",
      modelName: result.modelName,
      provider: "remote-voice-proxy",
      text: result.text,
    };
  }

  private async ensureRemoteAudioPreflight(mode: "tts" | "voice-reply"): Promise<boolean> {
    if (!this.canUseRemoteAudio()) return false;
    if (this.remoteAudioPreflight === "ready") return true;
    if (this.remoteAudioPreflightPromise) return this.remoteAudioPreflightPromise;
    this.remoteAudioPreflightPromise = this.preflightRemoteAudioProxy(mode)
      .then((result) => {
        this.remoteAudioLastError = undefined;
        this.remoteAudioLastUsedAt = new Date().toISOString();
        this.remoteAudioPreflight = "ready";
        return Boolean(result.audioBlob || result.text);
      })
      .catch((error) => {
        this.remoteAudioLastError = formatError(error);
        this.remoteAudioPreflight = "failed";
        return false;
      })
      .finally(() => {
        this.remoteAudioPreflightPromise = null;
      });
    return this.remoteAudioPreflightPromise;
  }

  private canTryLocalAudioAfterRemoteVoiceFailure(): boolean {
    if (!this.canUseRemoteAudio()) return true;
    return this.remoteAudioPreflight === "failed" || Boolean(this.remoteAudioLastError);
  }

  private markRemoteAudioUnavailable(error: unknown): void {
    this.remoteAudioLastError = formatError(error);
    this.remoteAudioPreflight = "failed";
  }

  private startLocalWarmupInBackground(): void {
    if (this.localAudioReady || this.warmupInProgress || !this.canAttemptLocalAudio(AUDIO_CHAT_CONFIG.defaultModel)) {
      return;
    }
    this.warmupInProgress = true;
    void this.sendWorkerRequest(
      "warmUp",
      { modelName: AUDIO_CHAT_CONFIG.defaultModel },
      AUDIO_CHAT_CONFIG.warmupTimeoutMs,
      "Audio model warmup timed out.",
    )
      .then(() => {
        this.localAudioReady = true;
      })
      .catch((error) => {
        this.localAudioReady = false;
        this.markLocalAudioUnavailable(formatError(error));
        this.restartWorker(this.localAudioUnavailableReason);
      })
      .finally(() => {
        this.warmupInProgress = false;
      });
  }

  private getCombinedFallbackReason(
    modelName: string,
    remoteError: string | undefined,
    speechFallbackAvailable: boolean,
  ): string {
    const localReason = this.getLocalAudioFallbackReason(modelName, speechFallbackAvailable);
    if (!remoteError) {
      return localReason;
    }
    return `${remoteError.trim().replace(/[.;,\s]+$/, "")}. ${localReason}`;
  }

  private getGenerationTimeoutMs(): number {
    return this.localAudioReady
      ? AUDIO_CHAT_CONFIG.requestTimeoutMs
      : AUDIO_CHAT_CONFIG.warmupTimeoutMs + AUDIO_CHAT_CONFIG.requestTimeoutMs;
  }

  private browserSpeechFallback(text: string, fallbackForModel: string, fallbackReason: string): ClientAudioReplyResult {
    return {
      kind: "browser-speech",
      text,
      modelName: AUDIO_CHAT_CONFIG.fallbackVoiceModel,
      provider: "browser-speech",
      fallbackForModel,
      fallbackReason,
    };
  }

  private sendWorkerRequest(
    type: "generateAudio" | "generateVoiceReply" | "warmUp",
    data: { text?: string; fallbackText?: string; modelName: string },
    timeoutMs: number,
    timeoutMessage: string,
    onProgress?: (progress: ClientAudioProgress) => void,
  ): Promise<AudioWorkerResponse> {
    this.ensureWorker();
    const requestId = `audio-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        onProgress,
        resolve: (value) => {
          globalThis.clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          globalThis.clearTimeout(timeout);
          reject(reason);
        },
      });
      this.worker?.postMessage({ id: requestId, type, data });
    });
  }

  private ensureWorker(): void {
    if (this.worker) return;
    this.worker = this.createWorker();
    this.worker.onmessage = (event: MessageEvent<AudioWorkerMessage>) => {
      const pending = this.pendingRequests.get(event.data.id);
      if (!pending) return;
      if (event.data.type === "progress") {
        if (event.data.progress) pending.onProgress?.(event.data.progress);
        return;
      }
      if (typeof event.data.success !== "boolean") return;
      this.pendingRequests.delete(event.data.id);
      if (event.data.success) {
        pending.resolve(event.data.data || {});
      } else {
        pending.reject(new Error(event.data.error || "Audio worker failed."));
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Audio worker failed.");
      this.pendingRequests.forEach((pending) => pending.reject(error));
      this.pendingRequests.clear();
      this.markLocalAudioUnavailable(error.message);
      this.restartWorker(error.message);
    };
  }

  private markLocalAudioUnavailable(reason: string): void {
    this.localAudioUnavailableReason = reason;
    this.localAudioUnavailableAt = this.now();
  }

  private restartWorker(reason = "Audio worker restarted."): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.localAudioReady = false;
    this.pendingRequests.forEach((pending) => pending.reject(new Error(reason)));
    this.pendingRequests.clear();
  }
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL("../workers/clientAudioWorker.ts", import.meta.url), { type: "module" });
}

function defaultHasWebGPU(): boolean {
  return AUDIO_CHAT_CONFIG.enableWebGPU && typeof navigator !== "undefined" && Boolean((navigator as { gpu?: unknown }).gpu);
}

function defaultGetLocalAudioBlockReason(): string | undefined {
  if (!AUDIO_CHAT_CONFIG.enableMobileLocalAudio && isMobileAppleBrowser()) {
    return `${AUDIO_CHAT_CONFIG.defaultModel} local audio is disabled on iPhone and iPad because the WebGPU model download is too large for reliable mobile Safari use.`;
  }
  return undefined;
}

function defaultHasSpeechSynthesis(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

function appendSpeechFallbackStatus(reason: string, speechFallbackAvailable: boolean): string {
  const normalizedReason = reason.trim().replace(/[.;,\s]+$/, "");
  return speechFallbackAvailable
    ? `${normalizedReason}. Using browser speech output instead.`
    : `${normalizedReason}. Browser speech fallback is also unavailable.`;
}

function isMobileAppleBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  return /\b(iPhone|iPad|iPod)\b/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "Unknown audio error");
  if (/Failed to fetch dynamically imported module:\s*blob:/i.test(message)) {
    return "Local audio runtime could not load in this browser session";
  }
  return message;
}

export const clientAudioReplyService = new ClientAudioReplyService();
