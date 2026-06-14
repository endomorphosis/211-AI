import { AUDIO_CHAT_CONFIG } from "./audioChatConfig";
import { resolvePublicHttpsUrl } from "./publicEndpointPolicy";
import { createSilentWavBlob, createVoiceProxyFormData, createVoiceProxyTtsBody } from "./voiceProxyPayload";

export interface RemoteAudioGenerationResult {
  audioBlob?: Blob;
  mimeType?: string;
  modelName: string;
  text?: string;
  endpointRole?: "primary" | "fallback";
}

export interface RemoteSpeechToTextResult {
  endpointRole?: "primary" | "fallback";
  modelName: string;
  provider?: string;
  text: string;
}

export function isRemoteVoiceProxyConfigured(): boolean {
  return getRemoteVoiceProxyEndpoints("tts").length > 0 || getRemoteVoiceProxyEndpoints("voice-reply").length > 0;
}

export async function preflightRemoteAudioProxy(mode: "tts" | "voice-reply" = "tts"): Promise<RemoteAudioGenerationResult> {
  return generateRemoteAudio({
    mode,
    text: "Voice proxy preflight.",
    fallbackText: "Voice proxy preflight.",
  });
}

export async function preflightRemoteSpeechToTextProxy(): Promise<RemoteSpeechToTextResult> {
  return transcribeRemoteSpeech({ audioBlob: createSilentWavBlob() });
}

export async function transcribeRemoteSpeech(options: {
  audioBlob: Blob;
  language?: string;
}): Promise<RemoteSpeechToTextResult> {
  const endpoints = getRemoteVoiceProxyEndpoints("stt");
  if (!AUDIO_CHAT_CONFIG.voiceProxyEnabled || endpoints.length === 0) {
    throw new Error("Speech-to-text proxy is unavailable.");
  }

  const errors: string[] = [];
  for (const endpoint of endpoints) {
    let response: Response;
    try {
      response = await fetchWithTimeout(endpoint.url, {
        method: "POST",
        headers: buildHeaders("stt"),
        body: createSpeechToTextFormData(options),
      });
    } catch (error) {
      errors.push(formatRemoteAudioNetworkError(endpoint.url, error));
      continue;
    }

    if (!response.ok) {
      errors.push(`Speech-to-text proxy request to ${endpoint.url} failed with ${response.status}: ${await response.text()}`);
      continue;
    }

    try {
      const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
      if (contentType.startsWith("text/")) {
        const transcriptText = (await response.text()).trim();
        if (transcriptText || options.audioBlob.size > 0) {
          return {
            endpointRole: endpoint.role,
            modelName: endpoint.modelName,
            provider: "remote-voice-proxy",
            text: transcriptText,
          };
        }
      }
      const payload = await response.json();
      const normalized = normalizeSpeechToTextJsonPayload(payload, endpoint);
      if (normalized.text || options.audioBlob.size > 0) return normalized;
    } catch (error) {
      errors.push(`Speech-to-text proxy response from ${endpoint.url} could not be used: ${formatError(error)}`);
    }
  }

  throw new Error(errors.join(" "));
}

export async function generateRemoteAudio(options: {
  mode: "tts" | "voice-reply";
  text: string;
  systemPrompt?: string;
  userPrompt?: string;
  fallbackText?: string;
  localModelName?: string;
  audioBlob?: Blob;
}): Promise<RemoteAudioGenerationResult> {
  const endpoints = getRemoteVoiceProxyEndpoints(options.mode);
  if (!AUDIO_CHAT_CONFIG.voiceProxyEnabled || endpoints.length === 0) {
    throw new Error("Voice proxy is unavailable.");
  }

  const errors: string[] = [];
  for (const endpoint of endpoints) {
    let response: Response;
    try {
      console.info("[Abby] Calling voice proxy.", {
        mode: options.mode,
        role: endpoint.role,
        url: endpoint.url,
        modelName: endpoint.modelName,
      });
      response = await fetchWithTimeout(endpoint.url, buildRequestInit(options));
    } catch (error) {
      console.warn("[Abby] Voice proxy request failed before response.", {
        mode: options.mode,
        role: endpoint.role,
        url: endpoint.url,
        error,
      });
      errors.push(formatRemoteAudioNetworkError(endpoint.url, error));
      continue;
    }

    if (!response.ok) {
      console.warn("[Abby] Voice proxy returned an error response.", {
        mode: options.mode,
        role: endpoint.role,
        url: endpoint.url,
        status: response.status,
      });
      errors.push(`Voice proxy request to ${endpoint.url} failed with ${response.status}: ${await response.text()}`);
      continue;
    }

    try {
      const normalized = await normalizeRemoteAudioResponse(response, endpoint);
      if (!normalized.audioBlob && !normalized.text) {
        throw new Error("Voice proxy returned no audio payload.");
      }
      return normalized;
    } catch (error) {
      errors.push(`Voice proxy response from ${endpoint.url} could not be used: ${formatError(error)}`);
    }
  }

  throw new Error(errors.join(" "));
}

type RemoteVoiceProxyEndpoint = {
  url: string;
  role: "primary" | "fallback";
  modelName: string;
};

function getRemoteVoiceProxyEndpoints(mode: "tts" | "voice-reply" | "stt"): RemoteVoiceProxyEndpoint[] {
  const candidates =
    mode === "tts"
      ? [
          { url: AUDIO_CHAT_CONFIG.voiceProxyTtsUrl, role: "primary" as const, modelName: AUDIO_CHAT_CONFIG.voiceProxyModel },
          {
            url: AUDIO_CHAT_CONFIG.voiceProxyFallbackTtsUrl,
            role: "fallback" as const,
            modelName: AUDIO_CHAT_CONFIG.voiceProxyFallbackModel,
          },
        ]
      : mode === "voice-reply"
        ? [
          { url: AUDIO_CHAT_CONFIG.voiceProxyInferUrl, role: "primary" as const, modelName: AUDIO_CHAT_CONFIG.voiceProxyModel },
          {
            url: AUDIO_CHAT_CONFIG.voiceProxyFallbackInferUrl,
            role: "fallback" as const,
            modelName: AUDIO_CHAT_CONFIG.voiceProxyFallbackModel,
          },
        ]
        : [
          { url: AUDIO_CHAT_CONFIG.voiceProxySttUrl, role: "primary" as const, modelName: AUDIO_CHAT_CONFIG.voiceProxyModel },
          {
            url: AUDIO_CHAT_CONFIG.voiceProxyFallbackSttUrl,
            role: "fallback" as const,
            modelName: AUDIO_CHAT_CONFIG.voiceProxyFallbackModel,
          },
        ];
  const seen = new Set<string>();
  const endpoints: RemoteVoiceProxyEndpoint[] = [];
  for (const candidate of candidates) {
    const url = resolvePublicHttpsUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    endpoints.push({ ...candidate, url });
    seen.add(url);
  }
  return endpoints;
}

function buildHeaders(mode: "tts" | "voice-reply" | "stt"): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "audio/wav, audio/*, application/json",
  };
  if (mode === "tts") {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }
  const origin = getBrowserOrigin();
  if (origin) {
    headers["X-Title"] = "Abby 211";
    headers["X-Client-Origin"] = origin;
  }
  return headers;
}

function createSpeechToTextFormData(options: { audioBlob: Blob; language?: string }): FormData {
  const formData = new FormData();
  formData.append("audio", options.audioBlob, "speech.wav");
  if (options.language?.trim()) {
    formData.append("language", options.language.trim());
  }
  return formData;
}

function buildRequestInit(options: {
  mode: "tts" | "voice-reply";
  text: string;
  systemPrompt?: string;
  userPrompt?: string;
  fallbackText?: string;
  audioBlob?: Blob;
}): RequestInit {
  if (options.mode === "tts") {
    return {
      method: "POST",
      headers: buildHeaders(options.mode),
      body: createVoiceProxyTtsBody({ text: options.text }),
    };
  }
  return {
    method: "POST",
    headers: buildHeaders(options.mode),
    body: createVoiceProxyFormData({
      mode: options.mode,
      audioBlob: options.audioBlob,
      text: options.text,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      fallbackText: options.fallbackText,
    }),
  };
}

async function fetchWithTimeout(endpoint: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), AUDIO_CHAT_CONFIG.remoteRequestTimeoutMs);
  try {
    return await fetch(endpoint, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function normalizeRemoteAudioResponse(
  response: Response,
  endpoint: RemoteVoiceProxyEndpoint,
): Promise<RemoteAudioGenerationResult> {
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  if (contentType.startsWith("audio/")) {
    const audioBlob = await response.blob();
    return {
      audioBlob,
      endpointRole: endpoint.role,
      mimeType: audioBlob.type || contentType || "audio/wav",
      modelName: endpoint.modelName,
    };
  }

  const payload = await response.json();
  return normalizeJsonPayload(payload, endpoint);
}

function normalizeJsonPayload(payload: unknown, endpoint: RemoteVoiceProxyEndpoint): RemoteAudioGenerationResult {
  if (!isRecord(payload)) {
    throw new Error("Voice proxy returned an invalid JSON payload.");
  }

  const normalizedPayload = unwrapFirstBatchItem(payload);

  const generatedText = firstString(normalizedPayload, ["text", "outputText", "output_text"]);
  const modelName = firstString(normalizedPayload, ["model", "modelName", "model_name"]) || endpoint.modelName;
  const audioBase64 = firstString(normalizedPayload, ["audioBase64", "audio_base64", "audio", "wavBase64", "wav_base64"]);
  if (audioBase64) {
    const mimeType = firstString(normalizedPayload, ["mimeType", "mime_type"]) || "audio/wav";
    return {
      audioBlob: base64ToBlob(audioBase64, mimeType),
      endpointRole: endpoint.role,
      mimeType,
      modelName,
      text: generatedText,
    };
  }

  if (generatedText) {
    return {
      endpointRole: endpoint.role,
      modelName,
      text: generatedText,
    };
  }

  throw new Error("Voice proxy JSON response did not include base64 audio.");
}

function unwrapFirstBatchItem(payload: Record<string, unknown>): Record<string, unknown> {
  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0) return payload;
  const firstItem = items[0];
  if (!isRecord(firstItem)) return payload;
  return {
    ...payload,
    ...firstItem,
  };
}

function normalizeSpeechToTextJsonPayload(payload: unknown, endpoint: RemoteVoiceProxyEndpoint): RemoteSpeechToTextResult {
  if (!isRecord(payload)) {
    throw new Error("Speech-to-text proxy returned an invalid JSON payload.");
  }
  const normalizedPayload = unwrapFirstBatchItem(payload);
  return {
    endpointRole: endpoint.role,
    modelName: firstString(normalizedPayload, ["model", "modelName", "model_name"]) || endpoint.modelName,
    provider: firstString(normalizedPayload, ["provider"]),
    text: extractSpeechToTextText(normalizedPayload),
  };
}

function extractSpeechToTextText(payload: Record<string, unknown>): string {
  const direct = firstString(payload, ["text", "transcript", "transcription", "outputText", "output_text", "generated_text"]);
  if (direct) return direct;

  const nestedArrays = [payload.items, payload.results, payload.segments, payload.chunks, payload.output];
  for (const candidate of nestedArrays) {
    if (!Array.isArray(candidate)) continue;
    const pieces = candidate
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!isRecord(item)) return "";
        return firstString(item, ["text", "transcript", "transcription", "outputText", "output_text", "generated_text"]) || "";
      })
      .filter(Boolean);
    if (pieces.length) {
      return pieces.join(" ").trim();
    }
  }

  return "";
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function base64ToBlob(value: string, mimeType: string): Blob {
  const normalized = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  if (typeof atob === "function") {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }
  const bufferCtor = (globalThis as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } }).Buffer;
  if (bufferCtor) {
    const bytes = Uint8Array.from(bufferCtor.from(normalized, "base64"));
    return new Blob([bytes], { type: mimeType });
  }
  throw new Error("Base64 audio decoding is unavailable in this browser.");
}

function getBrowserOrigin(): string {
  try {
    return typeof window !== "undefined" ? window.location.origin : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRemoteAudioNetworkError(endpoint: string, error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `Voice proxy request to ${endpoint} timed out before any HTTP response. local fallback attempted: pending caller decision.`;
  }
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  if (/failed to fetch/i.test(message) || /networkerror/i.test(message)) {
    return `Voice proxy request to ${endpoint} failed before any HTTP response. Failure type: network, CORS, TLS, or connection refused. local fallback attempted: pending caller decision.`;
  }
  return `Voice proxy request to ${endpoint} failed: ${message || "Unknown network error."}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error || "Unknown error").trim();
}
