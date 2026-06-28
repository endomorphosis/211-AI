import { env, pipeline } from "@xenova/transformers";
import ortWasmAsyncifyMjsUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmAsyncifyWasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import { LLM_CONFIG, SUPPORTED_CLIENT_LLM_MODELS, getClientLlmModelInfo } from "../lib/llmConfig";
import { buildClientLlmChatMessages, buildClientLlmGenerationOptions } from "../lib/clientLlmPrompting";
import { getSafeOnnxWasmThreadCount, installWarningSuppression } from "../lib/warningSuppressionUtils";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;
env.logLevel = "error";
installWarningSuppression();

type ClientLlmDevice = "wasm" | "webgpu" | "auto";

interface LlmCapabilities {
  webGPU: boolean;
  webGPUError?: string;
  webGPUShaderF16: boolean;
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
}

interface WebGpuDetectionResult {
  available: boolean;
  error?: string;
  shaderF16: boolean;
  adapterInfo?: LlmCapabilities["webGPUAdapter"];
}

type LlmWorkerRequest =
  | {
      id: string;
      type: "initialize" | "switchModel";
      data: { modelName?: string };
    }
  | {
      id: string;
      type: "generate";
      data: { prompt: string; maxTokens?: number };
    }
  | {
      id: string;
      type: "getCapabilities";
      data?: Record<string, never>;
    };

interface LlmWorkerResponse {
  id: string;
  success: boolean;
  data?: {
    text?: string;
    modelName?: string;
    capabilities?: {
      webGPU: boolean;
      webGPUError?: string;
      webGPUShaderF16: boolean;
      webGPUAdapter?: LlmCapabilities["webGPUAdapter"];
      simd: boolean;
      wasmThreads: boolean;
      crossOriginIsolated: boolean;
      sharedArrayBuffer: boolean;
    };
    device?: ClientLlmDevice;
    isInitialized?: boolean;
  };
  error?: string;
}

let textGenerator: any = null;
let currentModelName = LLM_CONFIG.defaultModel;
let currentDevice: ClientLlmDevice = "wasm";
let isInitialized = false;
let initializePromise: Promise<void> | null = null;
let initializingModelName: string | null = null;
let capabilities: LlmCapabilities = createUnavailableCapabilities();
let webGPUDetectionCache: { result: WebGpuDetectionResult; timestamp: number } | null = null;
let requestChain: Promise<void> = Promise.resolve();
const WEBGPU_DETECTION_CACHE_MS = 5 * 60 * 1000;
const WORKER_RESTART_REQUIRED_PREFIX = "ABBY_LLM_WORKER_RESTART_REQUIRED:";

self.onmessage = (event: MessageEvent<LlmWorkerRequest>) => {
  const request = event.data;
  requestChain = requestChain.then(
    () => handleWorkerRequest(request),
    () => handleWorkerRequest(request),
  );
};

async function handleWorkerRequest(request: LlmWorkerRequest): Promise<void> {
  const { id, type, data } = request;

  try {
    if (type === "getCapabilities") {
      capabilities = await detectCapabilities();
      postResponse({
        id,
        success: true,
        data: { capabilities, device: currentDevice, modelName: currentModelName, isInitialized },
      });
      return;
    }

    if (type === "initialize" || type === "switchModel") {
      const modelName = data.modelName || LLM_CONFIG.defaultModel;
      await initialize(modelName);
      postResponse({
        id,
        success: true,
        data: { capabilities, device: currentDevice, modelName: currentModelName, isInitialized },
      });
      return;
    }

    if (type === "generate") {
      await initialize(currentModelName);
      const text = await generateText(data.prompt, data.maxTokens || 180);
      postResponse({
        id,
        success: true,
        data: { text, capabilities, device: currentDevice, modelName: currentModelName, isInitialized },
      });
      return;
    }

    throw new Error(`Unknown LLM worker request: ${type}`);
  } catch (error) {
    postResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : "LLM worker failed",
    });
  }
}

async function initialize(modelName: string): Promise<void> {
  if (textGenerator && isInitialized && currentModelName === modelName) {
    return;
  }
  if (initializePromise) {
    await initializePromise;
    if (textGenerator && isInitialized && currentModelName === modelName) {
      return;
    }
    if (initializingModelName !== modelName) {
      return initialize(modelName);
    }
    return;
  }

  initializingModelName = modelName;
  initializePromise = initializePipeline(modelName);
  try {
    await initializePromise;
  } finally {
    initializePromise = null;
    initializingModelName = null;
  }
}

async function initializePipeline(modelName: string): Promise<void> {
  capabilities = await detectCapabilities();
  configureTransformersRuntime();

  const requestedModelName = getClientLlmModelInfo(modelName) ? modelName : LLM_CONFIG.fallbackModel;
  const requestedModelInfo = getClientLlmModelInfo(requestedModelName);
  try {
    await loadPipeline(requestedModelName);
  } catch (error) {
    if (requestedModelName === LLM_CONFIG.fallbackModel) {
      throw error;
    }
    if (requestedModelInfo && capabilities.webGPU && selectModelDevice(requestedModelInfo) === "webgpu") {
      const reason = `WebGPU initialization failed for ${requestedModelInfo.name}; restart the worker before using ${SUPPORTED_CLIENT_LLM_MODELS[LLM_CONFIG.fallbackModel].name} on WASM. ${formatError(error)}`;
      capabilities.webGPUError = reason;
      throw new Error(`${WORKER_RESTART_REQUIRED_PREFIX}${reason}`);
    }
    console.warn(`211 LLM model ${requestedModelName} unavailable; falling back to ${LLM_CONFIG.fallbackModel}.`, error);
    await loadPipeline(LLM_CONFIG.fallbackModel);
  }
}

async function loadPipeline(requestedModelName: string, forcedDevice?: ClientLlmDevice): Promise<void> {
  const modelInfo = getClientLlmModelInfo(requestedModelName) || SUPPORTED_CLIENT_LLM_MODELS[LLM_CONFIG.fallbackModel];
  if (modelInfo.requiresWebGPU && !capabilities.webGPU) {
    throw new Error(
      `${modelInfo.name} requires WebGPU. ${capabilities.webGPUError || "Use a WASM-compatible model on this browser."}`,
    );
  }

  const device = forcedDevice || selectModelDevice(modelInfo);

  try {
    await loadPipelineAttempt(requestedModelName, modelInfo, device);
  } catch (error) {
    if ((device === "webgpu" || device === "auto") && !modelInfo.requiresWebGPU) {
      console.warn(
        `[Worker] WebGPU initialization failed for ${modelInfo.name}; falling back to WASM. ${formatError(error)}`,
      );
      capabilities.webGPUError = `WebGPU initialization failed for ${modelInfo.name}; using WASM fallback. ${formatError(error)}`;
      await loadPipelineAttempt(requestedModelName, modelInfo, "wasm");
    } else {
      throw error;
    }
  }

  currentModelName = requestedModelName;
  isInitialized = true;
}

async function loadPipelineAttempt(
  requestedModelName: string,
  modelInfo: NonNullable<ReturnType<typeof getClientLlmModelInfo>>,
  device: ClientLlmDevice,
): Promise<void> {
  const options = buildPipelineOptions(modelInfo, device);
  const dtype = String(options.dtype || modelInfo.dtype);
  console.info(`[Worker] Loading ${modelInfo.name} with Transformers.js device=${device}, dtype=${dtype}.`);
  await disposeCurrentPipeline();
  textGenerator = await pipeline(modelInfo.task, requestedModelName, options);
  currentDevice = device;
}

async function generateText(prompt: string, maxTokens: number): Promise<string> {
  if (!textGenerator || !isInitialized) {
    throw new Error("LLM is not initialized");
  }

  try {
    return await runTextGeneration(prompt, maxTokens);
  } catch (error) {
    if (currentDevice === "webgpu") {
      return recoverFromWebGpuGenerationFailure(error, prompt, maxTokens);
    }
    throw error;
  }
}

async function runTextGeneration(prompt: string, maxTokens: number): Promise<string> {
  const modelInfo = getClientLlmModelInfo(currentModelName) || SUPPORTED_CLIENT_LLM_MODELS[LLM_CONFIG.fallbackModel];
  const input = modelInfo.inputMode === "chat" ? buildClientLlmChatMessages(prompt) : prompt;
  const output = await textGenerator(input, buildClientLlmGenerationOptions(currentModelName, maxTokens));
  return extractGeneratedText(output);
}

async function recoverFromWebGpuGenerationFailure(error: unknown, _prompt: string, _maxTokens: number): Promise<string> {
  const failedModelInfo = getClientLlmModelInfo(currentModelName);
  const failedModelLabel = failedModelInfo?.name || currentModelName;
  const reason = `WebGPU execution failed for ${failedModelLabel}; restart the worker before using ${SUPPORTED_CLIENT_LLM_MODELS[LLM_CONFIG.fallbackModel].name} on WASM. ${formatError(error)}`;
  console.warn(`[Worker] ${reason}`, error);
  capabilities.webGPUError = reason;
  throw new Error(`${WORKER_RESTART_REQUIRED_PREFIX}${reason}`);
}

async function disposeCurrentPipeline(): Promise<void> {
  const previousGenerator = textGenerator;
  textGenerator = null;
  isInitialized = false;
  if (!previousGenerator) {
    return;
  }
  try {
    await previousGenerator.dispose?.();
  } catch (error) {
    console.warn(`[Worker] Failed to dispose previous LLM pipeline. ${formatError(error)}`, error);
  }
}

function selectModelDevice(modelInfo: ReturnType<typeof getClientLlmModelInfo>): "wasm" | "webgpu" | "auto" {
  if (!modelInfo) return "wasm";
  const configuredDevice = modelInfo.device as ClientLlmDevice;
  if (modelInfo.requiresWebGPU) return "webgpu";
  if (configuredDevice === "auto" && modelInfo.preferWebGPU && capabilities.webGPU && LLM_CONFIG.enableWebGPU) {
    return "webgpu";
  }
  if (configuredDevice === "webgpu" && capabilities.webGPU && LLM_CONFIG.enableWebGPU) {
    return "webgpu";
  }
  return "wasm";
}

function buildPipelineOptions(
  modelInfo: NonNullable<ReturnType<typeof getClientLlmModelInfo>>,
  device: ClientLlmDevice,
): Record<string, unknown> {
  const dtype = selectModelDType(modelInfo.dtype, device);
  return {
    dtype,
    device,
    session_options: {
      log_severity_level: 3,
      log_verbosity_level: 0,
      enable_profiling: false,
    },
  };
}

function selectModelDType(dtype: string, device: ClientLlmDevice): string {
  if (device === "webgpu" && (dtype === "fp16" || dtype === "q4f16") && !capabilities.webGPUShaderF16) {
    return "q4";
  }
  return dtype;
}

function extractGeneratedText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  if (first && typeof first === "object" && "generated_text" in first) {
    const generatedText = (first as { generated_text?: unknown }).generated_text;
    if (Array.isArray(generatedText)) {
      const lastMessage = [...generatedText]
        .reverse()
        .find((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
      const content = lastMessage && typeof (lastMessage as { content?: unknown }).content === "string"
        ? (lastMessage as { content: string }).content
        : undefined;
      if (content) return content.trim();
    }
    if (typeof generatedText === "string") {
      return generatedText.trim();
    }
  }
  if (typeof first === "string") return first.trim();
  return String(output || "").trim();
}

async function detectCapabilities(): Promise<LlmCapabilities> {
  const webGPU = await detectWebGPU();
  const sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  const crossOriginIsolated = Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated);
  return {
    webGPU: webGPU.available,
    webGPUError: webGPU.error,
    webGPUShaderF16: webGPU.shaderF16,
    webGPUAdapter: webGPU.adapterInfo,
    simd: detectWasmSimd(),
    wasmThreads: sharedArrayBuffer && crossOriginIsolated && typeof Worker !== "undefined",
    crossOriginIsolated,
    sharedArrayBuffer,
  };
}

async function detectWebGPU(): Promise<WebGpuDetectionResult> {
  const cached = webGPUDetectionCache;
  if (cached && Date.now() - cached.timestamp < WEBGPU_DETECTION_CACHE_MS) {
    return cached.result;
  }

  const result = await detectWebGPUUncached();
  webGPUDetectionCache = { result, timestamp: Date.now() };
  return result;
}

async function detectWebGPUUncached(): Promise<WebGpuDetectionResult> {
  try {
    const gpu = typeof navigator !== "undefined"
      ? (navigator as Navigator & { gpu?: { requestAdapter: (options?: unknown) => Promise<any> } }).gpu
      : undefined;
    if (!gpu?.requestAdapter) {
      return { available: false, shaderF16: false, error: "navigator.gpu is unavailable in this browser context." };
    }
    const adapter =
      (await gpu.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false })) ||
      (await gpu.requestAdapter());
    if (!adapter) {
      return { available: false, shaderF16: false, error: "No WebGPU adapter was returned for this browser and device." };
    }
    const adapterInfo = extractWebGpuAdapterInfo(adapter);
    const shaderF16 = Boolean(adapter.features?.has?.("shader-f16"));
    const device = await adapter.requestDevice();
    if (!device?.queue) {
      device?.destroy?.();
      return { available: false, shaderF16, error: "WebGPU device was created without a command queue.", adapterInfo };
    }
    device.destroy?.();
    return { available: true, shaderF16, adapterInfo };
  } catch (error) {
    return { available: false, shaderF16: false, error: `WebGPU device test failed: ${formatError(error)}` };
  }
}

function detectWasmSimd(): boolean {
  try {
    const simdModule = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    ]);
    return WebAssembly.validate(simdModule);
  } catch {
    return false;
  }
}

function configureTransformersRuntime(): void {
  const backends = env.backends as unknown as {
    onnx?: {
      setLogLevel?: (logLevel: number) => void;
      logLevel?: string;
      logVerbosityLevel?: number;
      wasm?: {
        numThreads?: number;
        simd?: boolean;
        wasmPaths?: {
          mjs: string;
          wasm: string;
        };
        wasmBinary?: ArrayBuffer;
      };
      webgpu?: {
        powerPreference?: "low-power" | "high-performance";
        forceFallbackAdapter?: boolean;
        validateInputContent?: boolean;
        profiling?: {
          mode?: "off" | "default";
        };
      };
    };
  };
  const onnx = backends.onnx;
  onnx?.setLogLevel?.(3);
  if (onnx) {
    onnx.logLevel = "error";
    onnx.logVerbosityLevel = 0;
  }
  if (onnx?.webgpu && capabilities.webGPU && LLM_CONFIG.enableWebGPU) {
    onnx.webgpu.powerPreference = "high-performance";
    onnx.webgpu.forceFallbackAdapter = false;
    onnx.webgpu.validateInputContent = false;
    if (onnx.webgpu.profiling) {
      onnx.webgpu.profiling.mode = "off";
    }
  }
  if (onnx?.wasm) {
    onnx.wasm.numThreads = getSafeOnnxWasmThreadCount(8);
    onnx.wasm.simd = capabilities.simd && LLM_CONFIG.enableSIMD;
    onnx.wasm.wasmPaths = {
      mjs: ortWasmAsyncifyMjsUrl,
      wasm: ortWasmAsyncifyWasmUrl,
    };
  }
}

function postResponse(response: LlmWorkerResponse): void {
  self.postMessage(response);
}

function createUnavailableCapabilities(): LlmCapabilities {
  return {
    webGPU: false,
    webGPUShaderF16: false,
    simd: false,
    wasmThreads: false,
    crossOriginIsolated: Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated),
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  };
}

function extractWebGpuAdapterInfo(adapter: any): LlmCapabilities["webGPUAdapter"] {
  const info = adapter?.info;
  if (!info || typeof info !== "object") {
    return undefined;
  }
  return {
    vendor: typeof info.vendor === "string" ? info.vendor : undefined,
    architecture: typeof info.architecture === "string" ? info.architecture : undefined,
    device: typeof info.device === "string" ? info.device : undefined,
    description: typeof info.description === "string" ? info.description : undefined,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || "Unknown error");
}
