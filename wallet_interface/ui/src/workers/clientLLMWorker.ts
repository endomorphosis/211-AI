import { env, pipeline } from "@xenova/transformers";
import { LLM_CONFIG, SUPPORTED_CLIENT_LLM_MODELS, getClientLlmModelInfo } from "../lib/llmConfig";
import { setupGlobalWarningSuppressions, suppressKnownBrowserMlWarnings } from "../lib/warningSuppressionUtils";

env.allowLocalModels = false;
env.useBrowserCache = true;
setupGlobalWarningSuppressions();

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
      simd: boolean;
    };
    isInitialized?: boolean;
  };
  error?: string;
}

let textGenerator: any = null;
let currentModelName = LLM_CONFIG.defaultModel;
let isInitialized = false;
let initializePromise: Promise<void> | null = null;
let capabilities = { webGPU: false, simd: false };

self.onmessage = async (event: MessageEvent<LlmWorkerRequest>) => {
  const { id, type, data } = event.data;

  try {
    if (type === "getCapabilities") {
      capabilities = await detectCapabilities();
      postResponse({
        id,
        success: true,
        data: { capabilities, modelName: currentModelName, isInitialized },
      });
      return;
    }

    if (type === "initialize" || type === "switchModel") {
      const modelName = data.modelName || LLM_CONFIG.defaultModel;
      await initialize(modelName);
      postResponse({
        id,
        success: true,
        data: { capabilities, modelName: currentModelName, isInitialized },
      });
      return;
    }

    if (type === "generate") {
      await initialize(currentModelName);
      const text = await generateText(data.prompt, data.maxTokens || 180);
      postResponse({
        id,
        success: true,
        data: { text, capabilities, modelName: currentModelName, isInitialized },
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
};

async function initialize(modelName: string): Promise<void> {
  if (textGenerator && isInitialized && currentModelName === modelName) {
    return;
  }
  if (initializePromise) {
    await initializePromise;
    return;
  }

  initializePromise = initializePipeline(modelName);
  try {
    await initializePromise;
  } finally {
    initializePromise = null;
  }
}

async function initializePipeline(modelName: string): Promise<void> {
  capabilities = await detectCapabilities();
  configureTransformersRuntime();

  const modelInfo = getClientLlmModelInfo(modelName) || SUPPORTED_CLIENT_LLM_MODELS["Xenova/distilgpt2"];
  const requestedModelName = getClientLlmModelInfo(modelName) ? modelName : "Xenova/distilgpt2";
  if (modelInfo.requiresWebGPU && !capabilities.webGPU) {
    throw new Error(`${modelInfo.name} requires WebGPU. Use a WASM-compatible model on this browser.`);
  }

  const options: Record<string, unknown> = {
    quantized: modelInfo.quantized,
    session_options: createOnnxSessionOptions(),
  };
  if (modelInfo.requiresWebGPU && LLM_CONFIG.enableWebGPU) {
    options.device = "webgpu";
    options.dtype = "fp16";
  } else {
    options.device = "wasm";
  }

  try {
    textGenerator = await suppressKnownBrowserMlWarnings(() =>
      pipeline("text-generation", requestedModelName, options),
    );
  } catch (error) {
    if (options.device === "webgpu") {
      textGenerator = await suppressKnownBrowserMlWarnings(() =>
        pipeline("text-generation", requestedModelName, {
          quantized: true,
          device: "wasm",
          session_options: createOnnxSessionOptions(),
        } as any),
      );
    } else {
      throw error;
    }
  }

  currentModelName = requestedModelName;
  isInitialized = true;
}

async function generateText(prompt: string, maxTokens: number): Promise<string> {
  if (!textGenerator || !isInitialized) {
    throw new Error("LLM is not initialized");
  }

  const output = await textGenerator(prompt, {
    max_new_tokens: maxTokens,
    do_sample: false,
    return_full_text: false,
  });
  if (Array.isArray(output) && output[0]?.generated_text) {
    return String(output[0].generated_text).trim();
  }
  if (typeof output?.generated_text === "string") {
    return output.generated_text.trim();
  }
  return String(output || "").trim();
}

async function detectCapabilities(): Promise<{ webGPU: boolean; simd: boolean }> {
  return {
    webGPU: await detectWebGPU(),
    simd: detectWasmSimd(),
  };
}

async function detectWebGPU(): Promise<boolean> {
  return suppressKnownBrowserMlWarnings(async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter: (options?: unknown) => Promise<any> } }).gpu;
      if (!gpu?.requestAdapter) {
        return false;
      }
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) {
        return false;
      }
      const device = await adapter.requestDevice();
      device.destroy();
      return true;
    } catch {
      return false;
    }
  });
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
  configureOnnxRuntimeLogging();
  const backends = env.backends as unknown as {
    onnx?: {
      wasm?: {
        numThreads?: number;
        simd?: boolean;
      };
    };
  };
  if (backends.onnx?.wasm) {
    backends.onnx.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);
    backends.onnx.wasm.simd = capabilities.simd && LLM_CONFIG.enableSIMD;
  }
}

function createOnnxSessionOptions(): Record<string, unknown> {
  return {
    log_severity_level: 3,
    log_verbosity_level: 0,
    graph_optimization_level: "basic",
    enable_profiling: false,
  };
}

function configureOnnxRuntimeLogging(): void {
  const ort = (globalThis as {
    ort?: {
      env?: {
        logLevel?: string;
        logVerbosityLevel?: number;
        wasm?: {
          numThreads?: number;
          simd?: boolean;
        };
        webgpu?: {
          powerPreference?: string;
          validateInputContent?: boolean;
          enableDebugInfo?: boolean;
        };
      };
    };
  }).ort;

  if (!ort?.env) {
    return;
  }

  ort.env.logLevel = "error";
  ort.env.logVerbosityLevel = 0;
  if (ort.env.wasm) {
    ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);
    ort.env.wasm.simd = capabilities.simd && LLM_CONFIG.enableSIMD;
  }
  if (ort.env.webgpu) {
    ort.env.webgpu.powerPreference = "high-performance";
    ort.env.webgpu.validateInputContent = false;
    ort.env.webgpu.enableDebugInfo = false;
  }
}

function postResponse(response: LlmWorkerResponse): void {
  self.postMessage(response);
}
