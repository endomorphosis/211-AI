import { readRuntimeVoiceProxyConfig } from "./runtimeConfig";

const DEFAULT_VOICE_PROXY_INFER_URL = "/voice/indextts/infer";
const DEFAULT_VOICE_PROXY_TTS_URL = "/voice/indextts/tts";
const DEFAULT_VOICE_PROXY_STT_URL = "/voice/hf-whisper/stt";

type AudioChatConfig = {
  readonly defaultModel: string;
  readonly fallbackVoiceModel: string;
  readonly voiceProxyModel: string;
  readonly voiceProxyEnabled: boolean;
  readonly voiceProxyBaseUrl: string;
  readonly voiceProxyInferUrl: string;
  readonly voiceProxyTtsUrl: string;
  readonly voiceProxySttUrl: string;
  readonly voiceProxyFallbackModel: string;
  readonly voiceProxyFallbackInferUrl: string;
  readonly voiceProxyFallbackTtsUrl: string;
  readonly voiceProxyFallbackSttUrl: string;
  readonly enableLocalAudio: boolean;
  readonly enableMobileLocalAudio: boolean;
  readonly enableWebGPU: boolean;
  readonly requestTimeoutMs: number;
  readonly warmupTimeoutMs: number;
  readonly remoteRequestTimeoutMs: number;
  readonly maxPromptCharacters: number;
  readonly maxAudioFrames: number;
  readonly liquidAudioRunnerBaseUrl: string;
};

export const AUDIO_CHAT_CONFIG: AudioChatConfig = {
  get defaultModel() {
    return (import.meta.env?.VITE_CLIENT_AUDIO_MODEL as string | undefined) || "LiquidAI/LFM2.5-Audio-1.5B-ONNX";
  },
  get fallbackVoiceModel() {
    return "browser-speech-synthesis";
  },
  get voiceProxyModel() {
    return (
      readRuntimeVoiceProxyConfig()?.model ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_MODEL as string | undefined) ||
      "remote-voice-proxy"
    );
  },
  get voiceProxyEnabled() {
    const runtimeConfig = readRuntimeVoiceProxyConfig();
    const runtimeEnabled = runtimeConfig?.enabled;
    if (runtimeEnabled !== undefined) return runtimeEnabled;
    const envEnabled = normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_ENABLED as string | undefined);
    if (envEnabled !== undefined) return envEnabled !== "false";
    return true;
  },
  get voiceProxyBaseUrl() {
    return (
      readRuntimeVoiceProxyConfig()?.baseUrl ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_BASE_URL as string | undefined) ||
      ""
    );
  },
  get voiceProxyInferUrl() {
    const runtimeConfig = readRuntimeVoiceProxyConfig();
    return (
      runtimeConfig?.inferUrl ||
      joinUrl(runtimeConfig?.baseUrl, "infer") ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_INFER_URL as string | undefined) ||
      joinUrl(normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_BASE_URL as string | undefined), "infer") ||
      DEFAULT_VOICE_PROXY_INFER_URL
    );
  },
  get voiceProxyTtsUrl() {
    const runtimeConfig = readRuntimeVoiceProxyConfig();
    return (
      runtimeConfig?.ttsUrl ||
      joinUrl(runtimeConfig?.baseUrl, "tts") ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_TTS_URL as string | undefined) ||
      joinUrl(normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_BASE_URL as string | undefined), "tts") ||
      DEFAULT_VOICE_PROXY_TTS_URL
    );
  },
  get voiceProxySttUrl() {
    const runtimeConfig = readRuntimeVoiceProxyConfig();
    return (
      runtimeConfig?.sttUrl ||
      joinUrl(runtimeConfig?.baseUrl, "stt") ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_STT_URL as string | undefined) ||
      joinUrl(normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_BASE_URL as string | undefined), "stt") ||
      DEFAULT_VOICE_PROXY_STT_URL
    );
  },
  get voiceProxyFallbackModel() {
    return (
      readRuntimeVoiceProxyConfig()?.fallbackModel ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_FALLBACK_MODEL as string | undefined) ||
      "LiquidAI/LFM2.5-Audio-1.5B-proxy"
    );
  },
  get voiceProxyFallbackInferUrl() {
    const runtimeConfig = readRuntimeVoiceProxyConfig();
    return (
      runtimeConfig?.fallbackInferUrl ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_FALLBACK_INFER_URL as string | undefined) ||
      ""
    );
  },
  get voiceProxyFallbackTtsUrl() {
    const runtimeConfig = readRuntimeVoiceProxyConfig();
    return (
      runtimeConfig?.fallbackTtsUrl ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_FALLBACK_TTS_URL as string | undefined) ||
      ""
    );
  },
  get voiceProxyFallbackSttUrl() {
    const runtimeConfig = readRuntimeVoiceProxyConfig();
    return (
      runtimeConfig?.fallbackSttUrl ||
      normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_FALLBACK_STT_URL as string | undefined) ||
      ""
    );
  },
  get enableLocalAudio() {
    return import.meta.env?.VITE_ENABLE_LOCAL_AUDIO !== "false";
  },
  get enableMobileLocalAudio() {
    return import.meta.env?.VITE_ENABLE_MOBILE_LOCAL_AUDIO === "true";
  },
  get enableWebGPU() {
    return import.meta.env?.VITE_ENABLE_WEBGPU !== "false";
  },
  get requestTimeoutMs() {
    return Number.parseInt(import.meta.env?.VITE_CLIENT_AUDIO_REQUEST_TIMEOUT || "12000", 10);
  },
  get warmupTimeoutMs() {
    return Number.parseInt(import.meta.env?.VITE_CLIENT_AUDIO_WARMUP_TIMEOUT || "10000", 10);
  },
  get remoteRequestTimeoutMs() {
    return Number.parseInt(import.meta.env?.VITE_REMOTE_AUDIO_REQUEST_TIMEOUT || "45000", 10);
  },
  get maxPromptCharacters() {
    return Number.parseInt(import.meta.env?.VITE_CLIENT_AUDIO_MAX_PROMPT_CHARS || "1200", 10);
  },
  get maxAudioFrames() {
    return Number.parseInt(import.meta.env?.VITE_CLIENT_AUDIO_MAX_FRAMES || "160", 10);
  },
  get liquidAudioRunnerBaseUrl() {
    return (
      (import.meta.env?.VITE_LIQUID_AUDIO_RUNNER_BASE_URL as string | undefined) ||
      "https://huggingface.co/spaces/LiquidAI/LFM2.5-Audio-1.5B-transformers-js/raw/main"
    );
  },
};

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function joinUrl(baseUrl: string | null | undefined, suffix: string): string | undefined {
  const normalizedBaseUrl = normalizeOptionalString(baseUrl);
  if (!normalizedBaseUrl) return undefined;
  return `${normalizedBaseUrl.replace(/\/$/, "")}/${suffix}`;
}

function getConfiguredVoiceProxyBaseUrl(runtimeConfig: ReturnType<typeof readRuntimeVoiceProxyConfig>): string | undefined {
  return (
    runtimeConfig?.baseUrl ||
    normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_BASE_URL as string | undefined)
  );
}

function getConfiguredVoiceProxyRouteUrl(
  runtimeConfig: ReturnType<typeof readRuntimeVoiceProxyConfig>,
  route: "infer" | "tts" | "stt",
): string | undefined {
  if (route === "infer") {
    return runtimeConfig?.inferUrl || normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_INFER_URL as string | undefined);
  }
  if (route === "tts") {
    return runtimeConfig?.ttsUrl || normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_TTS_URL as string | undefined);
  }
  return runtimeConfig?.sttUrl || normalizeOptionalString(import.meta.env?.VITE_VOICE_PROXY_STT_URL as string | undefined);
}

export type ClientAudioPipelineTask = "text-to-audio";
export type ClientAudioDevicePreference = "webgpu";
export type ClientAudioDType = "q4";

export const SUPPORTED_CLIENT_AUDIO_MODELS = {
  "LiquidAI/LFM2.5-Audio-1.5B-ONNX": {
    name: "LFM2.5 Audio 1.5B Q4",
    size: "1.5B q4",
    task: "text-to-audio",
    requiresWebGPU: true,
    preferWebGPU: true,
    device: "webgpu",
    dtype: "q4",
    description:
      "LiquidAI ONNX audio model for browser WebGPU speech generation; used as a dedicated audio-chat path, separate from text chat models.",
    quantized: true,
  },
} as const;

export type ClientAudioModel = keyof typeof SUPPORTED_CLIENT_AUDIO_MODELS;

export function getClientAudioModelInfo(modelName: string) {
  return SUPPORTED_CLIENT_AUDIO_MODELS[modelName as ClientAudioModel];
}
