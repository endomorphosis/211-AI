import {
  resolveClientLlmPromptText,
  type ClientLlmPromptInput,
} from "./clientLlmPrompting";
import { LLM_CONFIG, getClientLlmModelInfo } from "./llmConfig";
import {
  generateHuggingFaceWalletRouterText,
  getHuggingFaceWalletRouterStatus,
} from "./huggingFaceWalletRouterClient";
import {
  clearOpenRouterApiKey,
  generateOpenRouterText,
  getOpenRouterRuntimeStatus,
  saveOpenRouterApiKey,
  type OpenRouterRuntimeStatus,
} from "./openRouterClient";

const WORKER_RESTART_REQUIRED_PREFIX = "ABBY_LLM_WORKER_RESTART_REQUIRED:";
const ALLOW_LOCAL_FALLBACK_WHEN_OPENROUTER_FAILS = import.meta.env?.VITE_ALLOW_LOCAL_LLM_FALLBACK === "true";
type ClientLlmProvider = "local" | "openrouter" | "huggingface";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface LlmWorkerResponse {
  text?: string;
  modelName?: string;
  capabilities?: {
    webGPU: boolean;
    webGPUError?: string;
    webGPUShaderF16?: boolean;
    webGPUAdapter?: {
      vendor?: string;
      architecture?: string;
      device?: string;
      description?: string;
    };
    simd: boolean;
    wasmThreads: boolean;
    crossOriginIsolated: boolean;
    sharedArrayBuffer: boolean;
  };
  device?: "wasm" | "webgpu" | "auto";
  isInitialized?: boolean;
}

export interface ClientLlmTextGenerationResult {
  ok: boolean;
  text: string;
  modelName?: string;
  error?: string;
}

export interface ClientLlmStructuredTextResult extends ClientLlmTextGenerationResult {
  json?: unknown;
  parseError?: string;
}

export interface ClientLlmRuntimeService {
  tryGenerateText: (prompt: ClientLlmPromptInput, maxTokens?: number) => Promise<ClientLlmTextGenerationResult>;
  generateStructuredText: (prompt: ClientLlmPromptInput, maxTokens?: number) => Promise<ClientLlmStructuredTextResult>;
}

class ClientLLMWorkerService {
  private worker: Worker | null = null;
  private isInitialized = false;
  private isInitializing = false;
  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest<LlmWorkerResponse>>();
  private currentModel = LLM_CONFIG.defaultModel;
  private currentDevice: "wasm" | "webgpu" | "auto" = "wasm";
  private capabilitiesKnown = false;
  private webGPUFallbackReason: string | undefined;
  private openRouterFallbackDelayMs = LLM_CONFIG.openRouterFallbackDelayMs;
  private openRouterLastError: string | undefined;
  private openRouterLastUsedAt: string | undefined;
  private huggingFaceRouterLastError: string | undefined;
  private huggingFaceRouterLastUsedAt: string | undefined;
  private lastGenerationModel = LLM_CONFIG.defaultModel;
  private lastGenerationProvider: ClientLlmProvider = "local";
  private generationCounter = 0;
  private generationWinnerId = 0;
  private localWarmupPromise: Promise<void> | null = null;
  private capabilities: NonNullable<LlmWorkerResponse["capabilities"]> = {
    webGPU: false,
    webGPUShaderF16: false,
    simd: false,
    wasmThreads: false,
    crossOriginIsolated: Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated),
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  };

  constructor() {
    this.initializeWorker();
    if (this.shouldWarmLocalInBackground()) {
      this.startLocalWarmupInBackground();
    }
  }

  async initialize(modelName = this.currentModel): Promise<void> {
    const targetModelName = this.resolveModelNameForSession(modelName);
    if (this.isInitialized && this.currentModel === targetModelName) {
      return;
    }
    if (this.isInitializing) {
      while (this.isInitializing) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      const nextTargetModelName = this.resolveModelNameForSession(modelName);
      if (this.isInitialized && this.currentModel === nextTargetModelName) {
        return;
      }
      return this.initialize(nextTargetModelName);
    }

    this.isInitializing = true;
    try {
      let result: LlmWorkerResponse;
      try {
        result = await this.sendWorkerRequest("initialize", { modelName: targetModelName }, LLM_CONFIG.modelDownloadTimeoutMs);
      } catch (error) {
        if (isWorkerRestartRequiredError(error)) {
          await this.restartWorkerWithFallback(formatWorkerRestartReason(error));
          return;
        }
        throw error;
      }
      this.isInitialized = Boolean(result.isInitialized ?? true);
      this.currentModel = result.modelName || targetModelName;
      this.currentDevice = result.device || this.currentDevice;
      if (this.currentDevice === "webgpu") {
        this.webGPUFallbackReason = undefined;
      }
      if (result.capabilities) {
        this.applyCapabilities(result.capabilities);
      }
    } finally {
      this.isInitializing = false;
    }
  }

  async switchModel(modelName: string): Promise<void> {
    const targetModelName = this.resolveModelNameForSession(modelName);
    if (this.isInitialized && this.currentModel === targetModelName) {
      return;
    }
    let result: LlmWorkerResponse;
    try {
      result = await this.sendWorkerRequest("switchModel", { modelName: targetModelName }, LLM_CONFIG.modelDownloadTimeoutMs);
    } catch (error) {
      if (isWorkerRestartRequiredError(error)) {
        await this.restartWorkerWithFallback(formatWorkerRestartReason(error));
        return;
      }
      throw error;
    }
    this.currentModel = result.modelName || targetModelName;
    this.currentDevice = result.device || this.currentDevice;
    if (this.currentDevice === "webgpu") {
      this.webGPUFallbackReason = undefined;
    }
    if (result.capabilities) {
      this.applyCapabilities(result.capabilities);
    }
    this.isInitialized = true;
  }

  async generateText(prompt: ClientLlmPromptInput, maxTokens = 180, didRestart = false): Promise<string> {
    const generationId = ++this.generationCounter;
    const promptText = resolveClientLlmPromptText(prompt);
    if (this.isHuggingFaceWalletRouterUsable(prompt)) {
      try {
        return await this.generateTextWithHuggingFaceWalletRouter(prompt, maxTokens, "proxy_first", generationId);
      } catch (error) {
        this.recordHuggingFaceRouterError(error);
        console.warn(`Hugging Face wallet router unavailable; checking secondary text paths. ${formatError(error)}`, error);
      }
    }

    if (LLM_CONFIG.preferOpenRouter && this.isOpenRouterFallbackUsable(prompt)) {
      try {
        return await this.generateTextWithOpenRouter(prompt, maxTokens, "proxy_first", generationId);
      } catch (error) {
        this.recordOpenRouterError(error);
        if (!this.shouldAllowLocalFallback()) {
          throw toError(error, "OpenRouter text generation failed.");
        }
        console.warn(`OpenRouter proxy unavailable; using local LLM path. ${formatError(error)}`, error);
      }
    }

    const remoteFallbackReason = this.getImmediateOpenRouterFallbackReason(prompt);
    if (remoteFallbackReason) {
      try {
        return await this.generateTextWithOpenRouter(prompt, maxTokens, remoteFallbackReason, generationId);
      } catch (error) {
        this.recordOpenRouterError(error);
        console.warn(`OpenRouter fallback unavailable; using local LLM path. ${formatError(error)}`, error);
      }
    }

    const localPromise = this.generateLocalText(promptText, maxTokens, didRestart, generationId);
    if (LLM_CONFIG.preferOpenRouter || !this.shouldRaceOpenRouterFallback(prompt)) {
      return localPromise;
    }

    return this.raceLocalWithOpenRouterFallback(localPromise, prompt, maxTokens, generationId);
  }

  async tryGenerateText(prompt: ClientLlmPromptInput, maxTokens = 180): Promise<ClientLlmTextGenerationResult> {
    try {
      const text = await this.generateText(prompt, maxTokens);
      return {
        ok: true,
        text,
        modelName: this.lastGenerationModel
      };
    } catch (error) {
      return {
        ok: false,
        text: "",
        modelName: this.lastGenerationModel,
        error: error instanceof Error ? error.message : "LLM worker text generation failed"
      };
    }
  }

  async generateStructuredText(prompt: ClientLlmPromptInput, maxTokens = 180): Promise<ClientLlmStructuredTextResult> {
    const result = await this.tryGenerateText(prompt, maxTokens);
    if (!result.ok) return result;

    const parsed = extractFirstJsonValue(result.text);
    if (!parsed.ok) {
      return {
        ...result,
        parseError: parsed.error
      };
    }

    return {
      ...result,
      json: parsed.value
    };
  }

  saveOpenRouterApiKey(apiKey: string): OpenRouterRuntimeStatus {
    saveOpenRouterApiKey(apiKey);
    this.openRouterLastError = undefined;
    return this.getOpenRouterStatus();
  }

  clearOpenRouterApiKey(): OpenRouterRuntimeStatus {
    clearOpenRouterApiKey();
    this.openRouterLastError = undefined;
    return this.getOpenRouterStatus();
  }

  getOpenRouterStatus(): OpenRouterRuntimeStatus {
    return getOpenRouterRuntimeStatus({
      localModelName: this.currentModel,
      lastError: this.openRouterLastError,
      lastUsedAt: this.openRouterLastUsedAt,
    });
  }

  private async generateLocalText(
    prompt: string,
    maxTokens: number,
    didRestart: boolean,
    generationId: number,
  ): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    let result: LlmWorkerResponse;
    try {
      result = await this.sendWorkerRequest("generate", { prompt, maxTokens }, LLM_CONFIG.requestTimeoutMs);
    } catch (error) {
      if (!didRestart && isWorkerRestartRequiredError(error)) {
        await this.restartWorkerWithFallback(formatWorkerRestartReason(error));
        return this.generateLocalText(prompt, maxTokens, true, generationId);
      }
      throw error;
    }
    if (!result.text) {
      throw new Error("LLM worker returned an empty response");
    }
    this.markGeneration("local", result.modelName || this.currentModel, generationId);
    return result.text;
  }

  async getCapabilities(): Promise<LlmWorkerResponse> {
    try {
      const result = await this.sendWorkerRequest("getCapabilities", {}, 5000);
      if (result.capabilities) {
        this.applyCapabilities(result.capabilities);
      }
      return {
        ...result,
        capabilities: result.capabilities ? this.mergeCapabilities(result.capabilities) : this.capabilities,
      };
    } catch {
      return {
        modelName: this.currentModel,
        device: this.currentDevice,
        capabilities: this.capabilities,
        isInitialized: this.isInitialized,
      };
    }
  }

  getStatus() {
    return {
      isInitialized: this.isInitialized,
      isInitializing: this.isInitializing,
      hasWorker: this.worker !== null,
      currentModel: this.currentModel,
      currentDevice: this.currentDevice,
      lastGenerationProvider: this.lastGenerationProvider,
      lastGenerationModel: this.lastGenerationModel,
      capabilities: this.capabilities,
      huggingFaceRouter: this.getHuggingFaceRouterStatus(),
      openRouter: this.getOpenRouterStatus(),
    };
  }

  destroy(reason = "LLM worker was stopped"): void {
    this.worker?.terminate();
    this.worker = null;
    this.isInitialized = false;
    this.isInitializing = false;
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
    this.pendingRequests.clear();
  }

  private async restartWorkerWithFallback(reason: string): Promise<void> {
    console.warn(`Restarting 211 LLM worker after WebGPU runtime failure. ${reason}`);
    this.webGPUFallbackReason = reason;
    this.destroy("LLM worker restarted after WebGPU runtime failure");
    this.currentModel = LLM_CONFIG.fallbackModel;
    this.currentDevice = "wasm";
    this.capabilities = {
      ...this.capabilities,
      webGPUError: reason,
    };
    this.initializeWorker();
    await this.initialize(LLM_CONFIG.fallbackModel);
    this.capabilities = {
      ...this.capabilities,
      webGPUError: reason,
    };
  }

  private startLocalWarmupInBackground(modelName = this.currentModel): void {
    if (!this.shouldWarmLocalInBackground()) {
      return;
    }
    if (this.localWarmupPromise || this.isInitialized || this.isInitializing || !this.worker) {
      return;
    }
    const targetModelName = this.resolveModelNameForSession(modelName);
    this.localWarmupPromise = this.initialize(targetModelName)
      .catch((error) => {
        console.warn(`Background local LLM warmup failed. ${formatError(error)}`, error);
      })
      .finally(() => {
        this.localWarmupPromise = null;
      });
  }

  private resolveModelNameForSession(modelName: string): string {
    if (!this.webGPUFallbackReason) {
      return modelName;
    }
    const modelInfo = getClientLlmModelInfo(modelName);
    if (modelInfo?.requiresWebGPU || modelInfo?.preferWebGPU || (modelInfo?.device as string | undefined) === "webgpu") {
      return LLM_CONFIG.fallbackModel;
    }
    return modelName;
  }

  private applyCapabilities(capabilities: NonNullable<LlmWorkerResponse["capabilities"]>): void {
    this.capabilitiesKnown = true;
    this.capabilities = this.mergeCapabilities(capabilities);
  }

  private mergeCapabilities(capabilities: NonNullable<LlmWorkerResponse["capabilities"]>): NonNullable<LlmWorkerResponse["capabilities"]> {
    return {
      ...capabilities,
      webGPUError: capabilities.webGPUError || this.webGPUFallbackReason,
    };
  }

  private initializeWorker(): void {
    if (typeof Worker === "undefined") {
      return;
    }
    try {
      this.worker = new Worker(new URL("../workers/clientLLMWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = this.handleWorkerError.bind(this);
    } catch (error) {
      console.error("Failed to create 211 LLM worker:", error);
      this.worker = null;
    }
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const { id, success, data, error } = event.data as {
      id: string;
      success: boolean;
      data?: LlmWorkerResponse;
      error?: string;
    };
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(id);
    if (success) {
      if (data?.modelName) {
        this.currentModel = data.modelName;
      }
      if (data?.device) {
        this.currentDevice = data.device;
      }
      if (this.currentDevice === "webgpu") {
        this.webGPUFallbackReason = undefined;
      }
      if (data?.capabilities) {
        this.applyCapabilities(data.capabilities);
      }
      pending.resolve(data || {});
    } else {
      pending.reject(new Error(error || "LLM worker request failed"));
    }
  }

  private handleWorkerError(error: ErrorEvent): void {
    console.error("211 LLM worker error:", error);
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error("LLM worker error"));
      this.pendingRequests.delete(id);
    }
  }

  private sendWorkerRequest(type: string, data: unknown, timeoutMs: number): Promise<LlmWorkerResponse> {
    if (!this.worker) {
      throw new Error("LLM worker is not available");
    }
    const worker = this.worker;

    return new Promise((resolve, reject) => {
      const id = `llm_${++this.requestCounter}`;
      const timeout = window.setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("LLM worker request timed out"));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          window.clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      });

      worker.postMessage({ id, type, data });
    });
  }

  private shouldRaceOpenRouterFallback(prompt: ClientLlmPromptInput): boolean {
    return this.isOpenRouterFallbackUsable(prompt);
  }

  private shouldAllowLocalFallback(): boolean {
    return true;
  }

  private shouldWarmLocalInBackground(): boolean {
    return LLM_CONFIG.preferOpenRouter && ALLOW_LOCAL_FALLBACK_WHEN_OPENROUTER_FAILS;
  }

  private getImmediateOpenRouterFallbackReason(prompt: ClientLlmPromptInput): string | undefined {
    if (!this.isOpenRouterFallbackUsable(prompt)) {
      return undefined;
    }
    const modelInfo = getClientLlmModelInfo(this.currentModel) || getClientLlmModelInfo(LLM_CONFIG.defaultModel);
    if (!this.worker) {
      return "local_worker_unavailable";
    }
    if (this.webGPUFallbackReason) {
      return "webgpu_runtime_failed";
    }
    if (
      this.capabilitiesKnown &&
      !this.capabilities.webGPU &&
      (modelInfo?.requiresWebGPU || modelInfo?.preferWebGPU || (modelInfo?.device as string | undefined) === "webgpu")
    ) {
      return "webgpu_unavailable";
    }
    return undefined;
  }

  private isOpenRouterFallbackUsable(prompt: ClientLlmPromptInput): boolean {
    const status = this.getOpenRouterStatus();
    return status.enabled && status.configured;
  }

  private isHuggingFaceWalletRouterUsable(prompt: ClientLlmPromptInput): boolean {
    const status = this.getHuggingFaceRouterStatus();
    return status.enabled && status.configured;
  }

  private getHuggingFaceRouterStatus() {
    return getHuggingFaceWalletRouterStatus({
      lastError: this.huggingFaceRouterLastError,
      lastUsedAt: this.huggingFaceRouterLastUsedAt,
    });
  }

  private async raceLocalWithOpenRouterFallback(
    localPromise: Promise<string>,
    prompt: ClientLlmPromptInput,
    maxTokens: number,
    generationId: number,
  ): Promise<string> {
    type RaceResult = { source: "local" | "openrouter"; text: string } | { source: "local" | "openrouter"; error: unknown };
    const localResult: Promise<RaceResult> = localPromise.then(
      (text) => ({ source: "local", text }),
      (error) => ({ source: "local", error }),
    );
    const remoteResult: Promise<RaceResult> = wait(this.openRouterFallbackDelayMs)
      .then(() => this.generateTextWithOpenRouter(prompt, maxTokens, "local_model_warming", generationId))
      .then(
        (text) => ({ source: "openrouter", text }),
        (error) => ({ source: "openrouter", error }),
      );

    const first = await Promise.race([localResult, remoteResult]);
    if ("text" in first) {
      return first.text;
    }
    if (first.source === "local") {
      throw first.error;
    }

    this.recordOpenRouterError(first.error);
    const local = await localResult;
    if ("text" in local) {
      return local.text;
    }
    throw local.error;
  }

  private async generateTextWithOpenRouter(
    prompt: ClientLlmPromptInput,
    maxTokens: number,
    fallbackReason: string,
    generationId: number,
  ): Promise<string> {
    const result = await generateOpenRouterText({
      prompt,
      maxTokens,
      localModelName: this.currentModel,
      fallbackReason,
    });
    this.openRouterLastError = undefined;
    this.openRouterLastUsedAt = new Date().toISOString();
    this.markGeneration("openrouter", result.model, generationId);
    return result.text;
  }

  private async generateTextWithHuggingFaceWalletRouter(
    prompt: ClientLlmPromptInput,
    maxTokens: number,
    fallbackReason: string,
    generationId: number,
  ): Promise<string> {
    const result = await generateHuggingFaceWalletRouterText({
      prompt,
      maxTokens,
      fallbackReason,
    });
    this.huggingFaceRouterLastError = undefined;
    this.huggingFaceRouterLastUsedAt = new Date().toISOString();
    this.markGeneration("huggingface", result.model, generationId);
    return result.text;
  }

  private recordOpenRouterError(error: unknown): void {
    this.openRouterLastError = formatError(error);
  }

  private recordHuggingFaceRouterError(error: unknown): void {
    this.huggingFaceRouterLastError = formatError(error);
  }

  private markGeneration(provider: ClientLlmProvider, modelName: string, generationId: number): void {
    if (generationId !== this.generationCounter) {
      return;
    }
    if (this.generationWinnerId === generationId) {
      return;
    }
    this.generationWinnerId = generationId;
    this.lastGenerationProvider = provider;
    this.lastGenerationModel = modelName;
  }
}

function isWorkerRestartRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(WORKER_RESTART_REQUIRED_PREFIX);
}

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function formatWorkerRestartReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(WORKER_RESTART_REQUIRED_PREFIX, "").trim();
  }
  return "WebGPU runtime failed; using WASM fallback.";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, ms)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function extractFirstJsonValue(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = stripJsonFence(text.trim());
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const balanced = firstBalancedJsonValue(trimmed);
    if (!balanced) {
      return { ok: false, error: "No JSON object or array found in LLM response" };
    }
    try {
      return { ok: true, value: JSON.parse(balanced) };
    } catch {
      return { ok: false, error: "LLM response JSON could not be parsed" };
    }
  }
}

function stripJsonFence(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return fence?.[1] ?? text;
}

function firstBalancedJsonValue(text: string): string | undefined {
  const start = text.search(/[\[{]/);
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
}

export const clientLLMWorkerService = new ClientLLMWorkerService();
