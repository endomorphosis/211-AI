export const LLM_CONFIG = {
  inferenceMode: (import.meta.env?.VITE_LLM_INFERENCE_MODE as "client" | "server" | undefined) || "client",
  defaultModel:
    (import.meta.env?.VITE_CLIENT_LLM_MODEL as string | undefined) || "LiquidAI/LFM2.5-1.2B-Instruct-ONNX",
  fallbackModel: "Xenova/LaMini-Flan-T5-77M",
  defaultEmbeddingModel:
    (import.meta.env?.VITE_DEFAULT_EMBEDDING_MODEL as string | undefined) || "Xenova/bge-small-en-v1.5",
  requestTimeoutMs: Number.parseInt(import.meta.env?.VITE_CLIENT_REQUEST_TIMEOUT || "12000", 10),
  modelDownloadTimeoutMs: Number.parseInt(import.meta.env?.VITE_MODEL_DOWNLOAD_TIMEOUT || "10000", 10),
  enableWebGPU: import.meta.env?.VITE_ENABLE_WEBGPU !== "false",
  enableSIMD: import.meta.env?.VITE_ENABLE_SIMD !== "false",
  openRouterEnabled: import.meta.env?.VITE_OPENROUTER_ENABLED !== "false",
  preferOpenRouter: true,
  openRouterApiKey: (import.meta.env?.VITE_OPENROUTER_API_KEY as string | undefined) || "",
  openRouterProxyUrl:
    (import.meta.env?.VITE_OPENROUTER_PROXY_URL as string | undefined) ||
    "https://animegf.chat:8787/api/openrouter/chat/completions",
  openRouterEndpoint:
    (import.meta.env?.VITE_OPENROUTER_ENDPOINT as string | undefined) ||
    "https://openrouter.ai/api/v1/chat/completions",
  openRouterInstructModel:
    (import.meta.env?.VITE_OPENROUTER_INSTRUCT_MODEL as string | undefined) ||
    "openrouter/free",
  openRouterThinkingModel:
    (import.meta.env?.VITE_OPENROUTER_THINKING_MODEL as string | undefined) ||
    "openrouter/free",
  openRouterFallbackDelayMs: Number.parseInt(import.meta.env?.VITE_OPENROUTER_FALLBACK_DELAY || "5000", 10),
  openRouterRequestTimeoutMs: Number.parseInt(import.meta.env?.VITE_OPENROUTER_REQUEST_TIMEOUT || "45000", 10),
  openRouterAllowPrivateContext: import.meta.env?.VITE_OPENROUTER_ALLOW_PRIVATE_CONTEXT === "true",
  localProbeTimeoutMs: Number.parseInt(import.meta.env?.VITE_LOCAL_PROBE_TIMEOUT || "10000", 10),
  localPerfBenchmarkTimeoutMs: Number.parseInt(import.meta.env?.VITE_LOCAL_PERF_BENCHMARK_TIMEOUT || "8000", 10),
} as const;

export type ClientLlmPipelineTask = "text-generation" | "text2text-generation";
export type ClientLlmInputMode = "prompt" | "chat";
export type ClientLlmDevicePreference = "wasm" | "webgpu" | "auto";
export type ClientLlmDType = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

export const SUPPORTED_CLIENT_LLM_MODELS = {
  "LiquidAI/LFM2.5-1.2B-Instruct-ONNX": {
    name: "LFM2.5 1.2B Instruct Q4",
    size: "1.2B q4f16/q4",
    task: "text-generation",
    inputMode: "chat",
    requiresWebGPU: true,
    preferWebGPU: true,
    device: "webgpu",
    dtype: "q4f16",
    contextLength: 32768,
    description: "LiquidAI ONNX text-chat model for browser WebGPU inference; uses q4 when shader-f16 is unavailable.",
    quantized: true,
  },
  "LiquidAI/LFM2.5-1.2B-Thinking-ONNX": {
    name: "LFM2.5 1.2B Thinking Q4",
    size: "1.2B q4f16/q4",
    task: "text-generation",
    inputMode: "chat",
    requiresWebGPU: true,
    preferWebGPU: true,
    device: "webgpu",
    dtype: "q4f16",
    contextLength: 32768,
    description: "LiquidAI ONNX reasoning-oriented WebGPU model for more deliberate chat responses.",
    quantized: true,
  },
  "onnx-community/Qwen2.5-0.5B-Instruct": {
    name: "Qwen2.5 0.5B Instruct",
    size: "large",
    task: "text-generation",
    inputMode: "chat",
    requiresWebGPU: true,
    preferWebGPU: true,
    device: "webgpu",
    dtype: "q4",
    contextLength: 32768,
    description: "Chat-tuned Transformers.js ONNX model for browser assistant responses; falls back to LaMini when WebGPU fails.",
    quantized: true,
  },
  "onnx-community/Qwen3-0.6B-ONNX": {
    name: "Qwen3 0.6B ONNX",
    size: "medium",
    task: "text-generation",
    inputMode: "chat",
    requiresWebGPU: true,
    preferWebGPU: true,
    device: "webgpu",
    dtype: "q4f16",
    contextLength: 4096,
    description: "WebGPU-first Qwen3 model for comparing the current Transformers.js WebGPU path.",
    quantized: true,
  },
  "onnx-community/Llama-3.2-1B-Instruct-ONNX": {
    name: "Llama 3.2 1B Instruct Q4",
    size: "1.09GB q4f16 / 1.69GB q4",
    task: "text-generation",
    inputMode: "chat",
    requiresWebGPU: true,
    preferWebGPU: true,
    device: "webgpu",
    dtype: "q4f16",
    contextLength: 2048,
    description: "Quantized USTypology-style WebGPU comparison model; uses q4 when shader-f16 is unavailable.",
    quantized: true,
  },
  "Xenova/LaMini-Flan-T5-77M": {
    name: "LaMini-Flan-T5 77M",
    size: "small",
    task: "text2text-generation",
    inputMode: "prompt",
    requiresWebGPU: false,
    preferWebGPU: false,
    device: "wasm",
    dtype: "q8",
    contextLength: 1024,
    description: "Instruction-tuned WASM model for browser chat and tool routing.",
    quantized: true,
  },
  "Xenova/LaMini-Flan-T5-248M": {
    name: "LaMini-Flan-T5 248M",
    size: "medium",
    task: "text2text-generation",
    inputMode: "prompt",
    requiresWebGPU: false,
    preferWebGPU: false,
    device: "wasm",
    dtype: "q8",
    contextLength: 1024,
    description: "Higher-quality WASM model for grounded 211 answers.",
    quantized: true,
  },
  "Xenova/LaMini-Flan-T5-783M": {
    name: "LaMini-Flan-T5 783M",
    size: "large",
    task: "text2text-generation",
    inputMode: "prompt",
    requiresWebGPU: false,
    preferWebGPU: false,
    device: "wasm",
    dtype: "q8",
    contextLength: 1024,
    description: "Largest WASM-compatible instruction model; slower initial load.",
    quantized: true,
  },
  "Xenova/distilgpt2": {
    name: "DistilGPT-2",
    size: "82MB",
    task: "text-generation",
    inputMode: "prompt",
    requiresWebGPU: false,
    preferWebGPU: false,
    device: "wasm",
    dtype: "q8",
    contextLength: 1024,
    description: "Small WASM-compatible fallback model.",
    quantized: true,
  },
  "Xenova/LaMini-GPT-774M": {
    name: "LaMini-GPT 774M",
    size: "310MB",
    task: "text-generation",
    inputMode: "prompt",
    requiresWebGPU: false,
    preferWebGPU: false,
    device: "wasm",
    dtype: "q8",
    contextLength: 1024,
    description: "Larger WASM-capable model for better short summaries.",
    quantized: true,
  },
} as const;

export type ClientLlmModel = keyof typeof SUPPORTED_CLIENT_LLM_MODELS;

export function getClientLlmModelInfo(modelName: string) {
  return SUPPORTED_CLIENT_LLM_MODELS[modelName as ClientLlmModel];
}

export function isSupportedClientLlmModel(modelName: string): modelName is ClientLlmModel {
  return modelName in SUPPORTED_CLIENT_LLM_MODELS;
}
