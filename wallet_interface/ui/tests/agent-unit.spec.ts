import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commandSchemas,
  isCommandOutputFor,
  validateCommandSchemas,
  type AgentCommandName,
} from "../src/agent/commandSchemas";
import { planAgentTurn } from "../src/agent/agentPlanner";
import {
  buildPromptSafeSurfaceContext,
  compactPromptConversationHistory,
  guardAgentToolDefinitions,
  guardEvidenceBundles,
  guardPromptText,
} from "../src/agent/promptGuards";
import {
  confirmationRiskForGate,
  evaluateAgentToolPermissionPolicy,
  getAgentToolPermissionPolicy,
} from "../src/agent/permissionPolicy";
import {
  agentToolDefinitions,
  getToolDefinition,
  validateSurfaceRegistry,
} from "../src/agent/surfaceRegistry";
import { createAgentToolExecutor } from "../src/agent/toolExecutor";
import {
  buildServiceNavigationNextSteps,
  evidenceBundleFromResults,
} from "../src/agent/serviceNavigationAgent";
import { createAgentChatController } from "../src/agent/chatController";
import type { AgentSurfaceApi } from "../src/agent/surfaceApi";
import type {
  AgentMessage,
  AgentPermissionLevel,
  AgentToolCall,
  AgentToolResult,
  EvidenceBundle,
  SurfaceContext,
} from "../src/agent/types";
import type { AppActionResult } from "../src/app/appActions";
import type { RouteId } from "../src/models/abby";
import {
  build211GraphRagPrompt,
  DEFAULT_GRAPH_RAG_MODEL_MAX_TOKENS,
  get211CorpusAssetUrl,
  get211CorpusBaseUrl,
  mergeDuplicateSearchResults,
  ragSearchWorkerService,
  set211CorpusBaseUrl,
} from "../src/lib/graphrag";
import type { GraphRagEvidence, SearchResult } from "../src/lib/graphrag";
import { clientLLMWorkerService } from "../src/lib/clientLLMWorkerService";
import { AUDIO_CHAT_CONFIG, getClientAudioModelInfo } from "../src/lib/audioChatConfig";
import { ClientAudioReplyService, type ClientAudioProgress } from "../src/lib/clientAudioReplyService";
import {
  primeVoiceChatActivation,
  reserveOpeningGreetingForCurrentOpen,
  resetOpeningGreetingReservation,
  buildVoiceInferenceFallbackRequest,
  resolveAudioOpeningClipUrl,
  resolveVoiceGeneratedReplyText,
  resolveVoiceReplyUserText,
} from "../src/components/agent/AgentAudioChatSurface";
import { buildCitationSummaryText } from "../src/components/agent/AgentCitationLink";
import {
  formatLiquidAudioLoadProgress,
  getLiquidAudioRunnerPatchDiagnostics,
  patchAudioModelSource,
  patchTransformersWebSource,
} from "../src/lib/liquidAudioRuntimePatch";
import {
  buildVoiceFallbackText,
  buildVoiceGraphRagPrompt,
  buildVoiceGraphRagPromptParts,
  selectEvidenceBundlesForMessage,
} from "../src/lib/voiceGraphRagPrompt";
import type { ClientLlmPromptInput } from "../src/lib/clientLlmPrompting";
import { LLM_CONFIG, SUPPORTED_CLIENT_LLM_MODELS, type ClientLlmModel } from "../src/lib/llmConfig";
import { OPENROUTER_API_KEY_STORAGE_KEY } from "../src/lib/openRouterClient";
import { answer211InfoQuestion, build211InfoFallbackSummary } from "../src/services/graphRagService";
import {
  createWalletWorldIdRpSignature,
  isWorldIdWalletApiError,
  loadWalletWorldIdConfig,
  loadWalletWorldIdStatus,
  registerWalletWorldIdVerification,
  revokeWalletWorldIdBinding,
} from "../src/services/walletApi";
import { shouldDeleteAppCache } from "../src/pwa/cachePolicy";
import { shouldHandleServiceWorkerRequest } from "../src/pwa/fetchPolicy";
import { resolvePublicHttpsUrl } from "../src/lib/publicEndpointPolicy";
import { createSilentWavBlob, createVoiceProxyFormData } from "../src/lib/voiceProxyPayload";

const NOW = "2026-05-05T12:00:00.000Z";
const WORKER_RESTART_REQUIRED_PREFIX = "ABBY_LLM_WORKER_RESTART_REQUIRED:";
const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ClientLlmDevice = "wasm" | "webgpu" | "auto";

interface TestLlmCapabilities {
  webGPU: boolean;
  webGPUError?: string;
  webGPUShaderF16?: boolean;
  simd: boolean;
  wasmThreads: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
}

interface TestLlmWorkerResponse {
  text?: string;
  modelName?: string;
  capabilities?: TestLlmCapabilities;
  device?: ClientLlmDevice;
  isInitialized?: boolean;
}

interface TestableClientLLMWorkerService {
  worker: { terminate: () => void } | null;
  isInitialized: boolean;
  isInitializing: boolean;
  currentModel: string;
  currentDevice: ClientLlmDevice;
  capabilitiesKnown: boolean;
  webGPUFallbackReason?: string;
  openRouterFallbackDelayMs: number;
  openRouterLastError?: string;
  openRouterLastUsedAt?: string;
  lastGenerationModel: string;
  lastGenerationProvider: "local" | "openrouter";
  generationCounter: number;
  generationWinnerId: number;
  localWarmupPromise: Promise<void> | null;
  capabilities: TestLlmCapabilities;
  pendingRequests: Map<string, { reject: (reason?: unknown) => void }>;
  requestCounter: number;
  initialize: (modelName?: string) => Promise<void>;
  switchModel: (modelName: string) => Promise<void>;
  generateText: (prompt: ClientLlmPromptInput, maxTokens?: number) => Promise<string>;
  getCapabilities: () => Promise<TestLlmWorkerResponse>;
  getStatus: () => {
    currentDevice: ClientLlmDevice;
    currentModel: string;
    capabilities: TestLlmCapabilities;
    isInitialized: boolean;
  };
  initializeWorker: () => void;
  sendWorkerRequest: (
    type: string,
    data: { modelName?: string; prompt?: string; maxTokens?: number },
    timeoutMs: number,
  ) => Promise<TestLlmWorkerResponse>;
}

function createSurfaceContext(
  route: RouteId,
  overrides: Partial<SurfaceContext> = {},
): SurfaceContext {
  return {
    route,
    routeLabel: route,
    capturedAt: NOW,
    walletUnlocked: true,
    privateContextAllowed: false,
    permissionLevel: "public",
    ...overrides,
  };
}

function createToolCall(name: string, input: unknown): AgentToolCall {
  return {
    id: `tool-${name}`,
    sessionId: "agent-session-unit",
    name,
    input,
    status: "pending",
    requestedAt: NOW,
  };
}

function createFakeSurfaceApi(
  context: SurfaceContext,
  invoked: AgentToolCall[] = [],
): AgentSurfaceApi {
  const successOutput = (name: string): AppActionResult => ({
    ok: true,
    action: name,
    summary: `Ran ${name}`,
  } as AppActionResult);

  return {
    getContext: () => context,
    invoke: async (name) => successOutput(name),
    invokeRequest: async (request) => successOutput(request.name),
    invokeToolCall: async (toolCall): Promise<AgentToolResult> => {
      invoked.push(toolCall);
      return {
        id: `tool-result-${toolCall.id}`,
        toolCallId: toolCall.id,
        name: toolCall.name,
        success: true,
        completedAt: NOW,
        output: successOutput(toolCall.name),
        auditEventId: `audit-${toolCall.id}`,
      };
    },
  };
}

function createSearchResult(docId: string, providerName: string): SearchResult {
  return {
    docId,
    contentCid: `cid-${docId}`,
    pageCid: `page-${docId}`,
    score: 9.5,
    scoreParts: { keyword: 9.5, vector: 0, metadata: 0 },
    snippet: `${providerName} offers pantry appointments and referral support.`,
    document: {
      doc_id: docId,
      doc_type: "service",
      title: `${providerName} program`,
      text: `${providerName} offers pantry appointments and referral support in Portland.`,
      text_truncated: false,
      source_url: `https://211.example.test/services/${docId}`,
      source_content_cid: `cid-${docId}`,
      source_page_cid: `page-${docId}`,
      provider_name: providerName,
      program_name: "Pantry appointments",
      categories: "Food",
      host: "211.example.test",
      city: "Portland",
      state: "OR",
    },
  };
}

function installMemoryLocalStorage() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  const storage = {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
    get length() {
      return values.size;
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  return () => {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  };
}

interface FetchMockCall {
  url: string;
  method: string;
  body?: unknown;
}

function installJsonFetchMock(
  handler: (call: FetchMockCall) => { status?: number; json?: unknown; text?: string },
) {
  const originalFetch = globalThis.fetch;
  const calls: FetchMockCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const call = {
      url,
      method: init?.method ?? "GET",
      body,
    };
    calls.push(call);
    const result = handler(call);
    const status = result.status ?? 200;
    return new Response(result.text ?? JSON.stringify(result.json ?? {}), {
      headers: { "Content-Type": "application/json" },
      status,
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

interface TestAudioWorkerRequest {
  id: string;
  type: "generateAudio" | "generateVoiceReply" | "warmUp";
  data: {
    modelName?: string;
    text?: string;
    fallbackText?: string;
  };
}

interface TestAudioWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (message: TestAudioWorkerRequest) => void;
  terminate: () => void;
}

function createAudioWorkerStub(
  handler: (message: TestAudioWorkerRequest, worker: TestAudioWorkerStub) => void,
): TestAudioWorkerStub {
  const worker: TestAudioWorkerStub = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => handler(message, worker),
    terminate: () => undefined,
  };
  return worker;
}

function emitAudioWorkerMessage(worker: TestAudioWorkerStub, data: unknown) {
  worker.onmessage?.({ data } as MessageEvent);
}

test.describe("agent unit contracts", () => {
  test("uses LiquidAI ONNX text-chat models for the default WebGPU client LLM path", () => {
    const defaultModelName = LLM_CONFIG.defaultModel as ClientLlmModel;
    const defaultModel = SUPPORTED_CLIENT_LLM_MODELS[defaultModelName];
    const thinkingModel = SUPPORTED_CLIENT_LLM_MODELS["LiquidAI/LFM2.5-1.2B-Thinking-ONNX"];

    expect(defaultModelName).toBe("LiquidAI/LFM2.5-1.2B-Instruct-ONNX");
    expect(defaultModel).toMatchObject({
      task: "text-generation",
      inputMode: "chat",
      device: "webgpu",
      requiresWebGPU: true,
      dtype: "q4f16",
      quantized: true,
    });
    expect(thinkingModel).toMatchObject({
      task: "text-generation",
      inputMode: "chat",
      device: "webgpu",
      requiresWebGPU: true,
      dtype: "q4f16",
      quantized: true,
    });
  });

  test("configures LiquidAI audio chat separately from text chat models", () => {
    const audioModel = getClientAudioModelInfo(AUDIO_CHAT_CONFIG.defaultModel);

    expect(AUDIO_CHAT_CONFIG.defaultModel).toBe("LiquidAI/LFM2.5-Audio-1.5B-ONNX");
    expect(audioModel).toMatchObject({
      task: "text-to-audio",
      device: "webgpu",
      dtype: "q4",
      requiresWebGPU: true,
      quantized: true,
    });
    expect(AUDIO_CHAT_CONFIG.liquidAudioRunnerBaseUrl).toContain("LFM2.5-Audio-1.5B-transformers-js");
    expect(AUDIO_CHAT_CONFIG.enableMobileLocalAudio).toBe(false);
    expect(AUDIO_CHAT_CONFIG.maxAudioFrames).toBeGreaterThan(0);
    expect(AUDIO_CHAT_CONFIG.requestTimeoutMs).toBe(12000);
    expect(AUDIO_CHAT_CONFIG.warmupTimeoutMs).toBe(10000);
    expect(SUPPORTED_CLIENT_LLM_MODELS).not.toHaveProperty(AUDIO_CHAT_CONFIG.defaultModel);
  });

  test("uses same-origin voice proxy defaults when runtime config is empty", () => {
    const runtimeGlobal = globalThis as typeof globalThis & {
      __ABBY_RUNTIME_CONFIG__?: {
        voiceProxy?: {
          enabled?: boolean;
          inferUrl?: string;
          ttsUrl?: string;
          sttUrl?: string;
        };
      };
    };
    const previousConfig = runtimeGlobal.__ABBY_RUNTIME_CONFIG__;

    runtimeGlobal.__ABBY_RUNTIME_CONFIG__ = {};

    try {
      expect(AUDIO_CHAT_CONFIG.voiceProxyEnabled).toBe(true);
      expect(AUDIO_CHAT_CONFIG.voiceProxyInferUrl).toBe("/voice/indextts/infer");
      expect(AUDIO_CHAT_CONFIG.voiceProxyTtsUrl).toBe("/voice/indextts/tts");
      expect(AUDIO_CHAT_CONFIG.voiceProxySttUrl).toBe("/voice/hf-whisper/stt");
    } finally {
      runtimeGlobal.__ABBY_RUNTIME_CONFIG__ = previousConfig;
    }
  });

  test("patches the LiquidAI audio demo runner with local bundled dependencies", () => {
    const source = `
import * as ort from 'onnxruntime-web';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { loadMelConfig, computeMelSpectrogram, loadAudioFile } from './audio-processor.js';
async function loadTokenizerFromPath(modelPath) {
  const fakeModelId = 'tokenizer-test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    return originalFetch(input, init);
  };
  const originalAllowLocal = env.allowLocalModels;
  env.allowLocalModels = false;
  try {
    return AutoTokenizer.from_pretrained(fakeModelId);
  } finally {
    globalThis.fetch = originalFetch;
    env.allowLocalModels = originalAllowLocal;
  }
}
export class AudioModel {
  async load(modelPath, options = {}) {
    const { progressCallback, device = 'webgpu', quantization = null } = options;
    const loadOnnxWithExternalData = async (name, progress, quantSuffix = null, extraOptions = {}) => {
      const sessionOptions = { executionProviders, ...extraOptions };
      return sessionOptions;
    };
    const cache = {
      emptyKeysData: new Float32Array(0),
      emptyValuesData: new Float32Array(0),
    };
    const numLayers = 6;
    const numKvHeads = 8;
    const headDim = 32;
    const pastKeys = new ort.Tensor('float32', cache.emptyKeysData, [numLayers, 1, numKvHeads, 0, headDim]);
    const pastValues = new ort.Tensor('float32', cache.emptyValuesData, [numLayers, 1, numKvHeads, 0, headDim]);
    this.audioEncoderSession = await loadOnnxWithExternalData('audio_encoder', 50, quantConfig.audioEncoder);
    const vocoderOpts = device === 'webgpu'
      ? { preferredOutputLocation: { new_keys: 'gpu-buffer', new_values: 'gpu-buffer', depth_slices: 'gpu-buffer' } }
      : {};
    this.vocoderSession = await loadOnnxWithExternalData('vocoder_depthformer', 95, quantConfig.vocoder, vocoderOpts);
  }
}
`;
    const diagnostics = getLiquidAudioRunnerPatchDiagnostics(source);

    expect(diagnostics.every((diagnostic) => diagnostic.present)).toBe(true);

    const patched = patchAudioModelSource(source, {
      audioProcessorUrl: "blob:audio-processor",
      ortWrapperUrl: "blob:ort-wrapper",
      transformersWebModuleUrl: "blob:transformers-web",
    });

    expect(patched).toContain('import * as ort from "blob:ort-wrapper";');
    expect(patched).toContain('import { AutoTokenizer, env } from "blob:transformers-web";');
    expect(patched).toContain("loadAudioEncoder = true");
    expect(patched).toContain("if (loadAudioEncoder)");
    expect(patched).toContain("enableMemPattern: false");
    expect(patched).toContain("const vocoderOpts = { executionProviders: ['wasm'], enableMemPattern: false };");
    expect(patched).toContain("[numLayers, 1, numKvHeads, 0, headDim]");
    expect(patched).not.toContain("[numLayers, 1, numKvHeads, 1, headDim]");
    expect(patched).not.toContain("new_keys: 'gpu-buffer'");
    expect(patched).toContain("const originalEnvFetch = env.fetch");
    expect(patched).toContain("env.fetch = globalThis.fetch");
    expect(patched).toContain("env.fetch = originalEnvFetch");
    expect(patched).not.toContain("from 'onnxruntime-web'");
  });

  test("patches Transformers.js WebGPU runtime imports for blob-loaded audio modules", () => {
    const source = `
import * as ONNX_WEB from "onnxruntime-web/webgpu";
import { Tensor } from "onnxruntime-common";
export { ONNX_WEB };
`;

    const patched = patchTransformersWebSource(source, {
      ortWrapperUrl: "blob:ort-wrapper",
    });

    expect(patched).toContain('import * as ONNX_WEB from "blob:ort-wrapper";');
    expect(patched).toContain('import { Tensor } from "blob:ort-wrapper";');
    expect(patched).not.toContain("onnxruntime-web/webgpu");
    expect(patched).not.toContain("onnxruntime-common");
  });

  test("patches legacy Transformers.js ONNX runtime imports without the webgpu subpath", () => {
    const source = `
import * as ONNX_WEB from "onnxruntime-web";
export { ONNX_WEB };
`;

    const patched = patchTransformersWebSource(source, {
      ortWrapperUrl: "blob:ort-wrapper",
    });

    expect(patched).toContain('import * as ONNX_WEB from "blob:ort-wrapper";');
    expect(patched).not.toContain("onnxruntime-web");
  });

  test("patches Transformers.js ONNX imports without assuming exact imported symbols", () => {
    const source = `
import * as ORT_COMMON from "onnxruntime-common";
import * as ORT_WEB from "onnxruntime-web/webgpu";
import { Tensor, InferenceSession as OrtSession } from "onnxruntime-common";
export { ORT_COMMON, ORT_WEB, Tensor, OrtSession };
`;

    const patched = patchTransformersWebSource(source, {
      ortWrapperUrl: "blob:ort-wrapper",
    });

    expect(patched).toContain('import * as ORT_COMMON from "blob:ort-wrapper";');
    expect(patched).toContain('import * as ORT_WEB from "blob:ort-wrapper";');
    expect(patched).toContain('import { Tensor, InferenceSession as OrtSession } from "blob:ort-wrapper";');
    expect(/\bfrom\s*["']onnxruntime-(?:common|web(?:\/webgpu)?)["']/.test(patched)).toBe(false);
  });

  test("patches the bundled Transformers.js WebGPU module without leaving bare ONNX imports", () => {
    const transformersWebSource = readFileSync(
      resolve(UI_ROOT, "node_modules/@huggingface/transformers/dist/transformers.web.js"),
      "utf8",
    );

    const patched = patchTransformersWebSource(transformersWebSource, {
      ortWrapperUrl: "blob:ort-wrapper",
    });

    expect(/\bfrom\s*["']onnxruntime-(?:common|web(?:\/webgpu)?)["']/.test(patched)).toBe(false);
    expect(patched).toContain('from "blob:ort-wrapper"');
  });

  test("fails loudly when the upstream LiquidAI runner can no longer be patched safely", () => {
    const source = `
import * as ort from 'onnxruntime-web';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { loadMelConfig, computeMelSpectrogram, loadAudioFile } from './audio-processor.js';
async function loadTokenizerFromPath(modelPath) {
  const fakeModelId = 'tokenizer-test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    return originalFetch(input, init);
  };
  const originalAllowLocal = env.allowLocalModels;
  env.allowLocalModels = false;
  try {
    return AutoTokenizer.from_pretrained(fakeModelId);
  } finally {
    globalThis.fetch = originalFetch;
    env.allowLocalModels = originalAllowLocal;
  }
}
export class AudioModel {
  async load(modelPath, options = {}) {
    const { progressCallback, device = 'webgpu', quantization = null } = options;
    const loadOnnxWithExternalData = async (name, progress, quantSuffix = null, extraOptions = {}) => {
      const sessionOptions = { executionProviders, ...extraOptions };
      return sessionOptions;
    };
    const cache = {
      emptyKeysData: new Float32Array(0),
      emptyValuesData: new Float32Array(0),
    };
    const numLayers = 6;
    const numKvHeads = 8;
    const headDim = 32;
    const pastKeys = new ort.Tensor('float32', cache.emptyKeysData, [numLayers, 1, numKvHeads, 0, headDim]);
    const pastValues = new ort.Tensor('float32', cache.emptyValuesData, [numLayers, 1, numKvHeads, 0, headDim]);
    this.audioEncoderSession = await loadOnnxWithExternalData('speech_encoder', 50, quantConfig.audioEncoder);
    const vocoderOpts = device === 'webgpu'
      ? { preferredOutputLocation: { new_keys: 'gpu-buffer', new_values: 'gpu-buffer', depth_slices: 'gpu-buffer' } }
      : {};
    this.vocoderSession = await loadOnnxWithExternalData('vocoder_depthformer', 95, quantConfig.vocoder, vocoderOpts);
  }
}
`;
    const diagnostics = getLiquidAudioRunnerPatchDiagnostics(source);

    expect(diagnostics.find((diagnostic) => diagnostic.key === "audioEncoderLoad")).toMatchObject({
      present: false,
    });
    expect(() =>
      patchAudioModelSource(source, {
        audioProcessorUrl: "blob:audio-processor",
        ortWrapperUrl: "blob:ort-wrapper",
        transformersWebModuleUrl: "blob:transformers-web",
      }),
    ).toThrow(/audio encoder session load/i);
  });

  test("normalizes LiquidAI audio model download progress for the voice UI", () => {
    expect(
      formatLiquidAudioLoadProgress(
        { status: "loading", progress: 0.5, file: "decoder_q4.onnx" },
        AUDIO_CHAT_CONFIG.defaultModel,
      ),
    ).toMatchObject({
      phase: "downloading-model",
      progress: 50,
      file: "decoder_q4.onnx",
      modelName: AUDIO_CHAT_CONFIG.defaultModel,
    });
    expect(formatLiquidAudioLoadProgress({ status: "done", progress: 100 }, AUDIO_CHAT_CONFIG.defaultModel).progress).toBe(85);
    expect(formatLiquidAudioLoadProgress({ status: "loading", progress: Number.NaN }, AUDIO_CHAT_CONFIG.defaultModel).progress).toBe(15);
  });

  test("falls back to browser speech when local LiquidAI audio cannot start", async () => {
    const service = new ClientAudioReplyService({
      createWorker: () => {
        throw new Error("test audio worker unavailable");
      },
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: false,
    });

    const result = await service.generateAudio("Read this assistant reply aloud.");

    expect(result).toMatchObject({
      kind: "browser-speech",
      provider: "browser-speech",
      modelName: AUDIO_CHAT_CONFIG.fallbackVoiceModel,
      fallbackForModel: AUDIO_CHAT_CONFIG.defaultModel,
    });
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").toContain("test audio worker unavailable");
  });

  test("reports LiquidAI audio model warmup progress from the worker", async () => {
    const progressEvents: ClientAudioProgress[] = [];
    const worker = createAudioWorkerStub((message, activeWorker) => {
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        type: "progress",
        progress: {
          phase: "loading-runtime",
          progress: 4,
          status: "Loading LiquidAI audio runtime.",
          modelName: message.data.modelName,
        },
      });
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        type: "progress",
        progress: {
          phase: "downloading-model",
          progress: 42,
          status: "Downloading audio model.",
          file: "decoder_q4.onnx",
          modelName: message.data.modelName,
        },
      });
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        success: true,
        data: {
          modelName: message.data.modelName,
          provider: "local-liquidai",
        },
      });
    });
    const service = new ClientAudioReplyService({
      createWorker: () => worker as unknown as Worker,
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => false,
      voiceProxyEnabled: false,
    });

    const result = await service.warmUp({ onProgress: (progress) => progressEvents.push(progress) });

    expect(result).toMatchObject({
      kind: "local-ready",
      modelName: AUDIO_CHAT_CONFIG.defaultModel,
      provider: "local-liquidai",
    });
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "queued", progress: 0 }),
        expect.objectContaining({ phase: "loading-runtime", progress: 4 }),
        expect.objectContaining({
          phase: "downloading-model",
          progress: 42,
          file: "decoder_q4.onnx",
        }),
      ]),
    );
  });

  test("preserves the LiquidAI audio worker failure reason across concurrent warmups", async () => {
    let requestCount = 0;
    const worker = createAudioWorkerStub((message, activeWorker) => {
      requestCount += 1;
      if (requestCount === 1) {
        globalThis.setTimeout(() => {
          emitAudioWorkerMessage(activeWorker, {
            id: message.id,
            success: false,
            error: "Failed to fetch decoder_q4.onnx: 404",
          });
        }, 0);
      }
    });
    const service = new ClientAudioReplyService({
      createWorker: () => worker as unknown as Worker,
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: false,
    });

    const results = await Promise.all([service.warmUp(), service.warmUp()]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.kind === "fallback")).toBe(true);
    expect(results.map((result) => (result.kind === "fallback" ? result.fallbackReason : ""))).toEqual([
      "Failed to fetch decoder_q4.onnx: 404. Using browser speech output instead.",
      "Failed to fetch decoder_q4.onnx: 404. Using browser speech output instead.",
    ]);
  });

  test("reports LiquidAI audio generation progress before returning a playable blob", async () => {
    const progressEvents: ClientAudioProgress[] = [];
    const audioBlob = new Blob(["RIFF....WAVE"], { type: "audio/wav" });
    const worker = createAudioWorkerStub((message, activeWorker) => {
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        type: "progress",
        progress: {
          phase: "generating",
          progress: 90,
          status: "Generating speech audio.",
          modelName: message.data.modelName,
        },
      });
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        type: "progress",
        progress: {
          phase: "decoding",
          progress: 97,
          status: "Decoding generated audio.",
          modelName: message.data.modelName,
        },
      });
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        success: true,
        data: {
          audioBlob,
          mimeType: "audio/wav",
          modelName: message.data.modelName,
          provider: "local-liquidai",
        },
      });
    });
    const service = new ClientAudioReplyService({
      createWorker: () => worker as unknown as Worker,
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => false,
      voiceProxyEnabled: false,
    });

    const result = await service.generateAudio("Please speak this reply.", {
      onProgress: (progress) => progressEvents.push(progress),
    });

    expect(result).toMatchObject({
      kind: "audio",
      audioBlob,
      mimeType: "audio/wav",
      modelName: AUDIO_CHAT_CONFIG.defaultModel,
      provider: "local-liquidai",
    });
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "generating", progress: 90 }),
        expect.objectContaining({ phase: "decoding", progress: 97 }),
      ]),
    );
  });

  test("preflights and uses the voice proxy TTS route without warming local audio in the background", async () => {
    const workerRequests: string[] = [];
    const audioBlob = new Blob(["RIFF....WAVE"], { type: "audio/wav" });
    const progressEvents: ClientAudioProgress[] = [];
    const service = new ClientAudioReplyService({
      createWorker: () =>
        createAudioWorkerStub((message, activeWorker) => {
          workerRequests.push(message.type);
          if (message.type === "warmUp") {
            emitAudioWorkerMessage(activeWorker, {
              id: message.id,
              success: true,
              data: {
                modelName: message.data.modelName,
                provider: "local-liquidai",
              },
            });
          }
        }) as unknown as Worker,
      generateRemoteAudio: async (options) => {
        expect(options.mode).toBe("tts");
        expect(options.text).toBe("Neighborhood Pantry can help with food today.");
        expect(options.userPrompt).toBeUndefined();
        expect(options.systemPrompt).toBeUndefined();
        expect(options.fallbackText).toBeUndefined();
        return {
          audioBlob,
          mimeType: "audio/wav",
          modelName: "remote-voice-proxy",
          text: "Remote spoken answer.",
        };
      },
      preflightRemoteAudioProxy: async () => ({
        audioBlob,
        mimeType: "audio/wav",
        modelName: "remote-voice-proxy",
      }),
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: true,
    });

    const result = await service.generateAudio("Neighborhood Pantry can help with food today.", {
      onProgress: (progress) => progressEvents.push(progress),
    });

    expect(result).toMatchObject({
      kind: "audio",
      audioBlob,
      provider: "remote-voice-proxy",
      text: "Remote spoken answer.",
    });
    expect(workerRequests).toEqual([]);
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "queued", status: "Checking voice proxy before local audio." }),
        expect.objectContaining({ phase: "queued", status: "Sending audio request to voice proxy." }),
        expect.objectContaining({ phase: "ready", progress: 100 }),
      ]),
    );
  });

  test("falls back to browser speech when the voice proxy returns text without audio", async () => {
    const workerRequests: string[] = [];
    const progressEvents: ClientAudioProgress[] = [];
    const service = new ClientAudioReplyService({
      createWorker: () =>
        createAudioWorkerStub((message, activeWorker) => {
          workerRequests.push(message.type);
          if (message.type === "warmUp") {
            emitAudioWorkerMessage(activeWorker, {
              id: message.id,
              success: true,
              data: {
                modelName: message.data.modelName,
                provider: "local-liquidai",
              },
            });
          }
        }) as unknown as Worker,
      generateRemoteAudio: async () => ({
        modelName: "mock-remote-voice-proxy",
        text: "This is a local mock spoken reply.",
      }),
      preflightRemoteAudioProxy: async () => ({
        modelName: "mock-remote-voice-proxy",
        text: "preflight ok",
      }),
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: true,
    });

    const result = await service.generateAudio("Neighborhood Pantry can help with food today.", {
      onProgress: (progress) => progressEvents.push(progress),
    });

    expect(result).toMatchObject({
      kind: "browser-speech",
      provider: "browser-speech",
      text: "This is a local mock spoken reply.",
      fallbackForModel: "mock-remote-voice-proxy",
      fallbackReason: "Voice proxy returned text only; using browser speech output.",
    });
    expect(workerRequests).toEqual([]);
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "queued", status: "Sending audio request to voice proxy." }),
        expect.objectContaining({ phase: "ready", progress: 100, modelName: "mock-remote-voice-proxy" }),
      ]),
    );
  });

  test("sends evidence prompts to LiquidAI voice reply generation while preserving fallback speech", async () => {
    let capturedRequest: TestAudioWorkerRequest | undefined;
    const audioBlob = new Blob(["RIFF....WAVE"], { type: "audio/wav" });
    const worker = createAudioWorkerStub((message, activeWorker) => {
      capturedRequest = message;
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        success: true,
        data: {
          audioBlob,
          mimeType: "audio/wav",
          modelName: message.data.modelName,
          provider: "local-liquidai",
          text: "A concise spoken answer.",
        },
      });
    });
    const service = new ClientAudioReplyService({
      createWorker: () => worker as unknown as Worker,
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: false,
    });

    const result = await service.generateVoiceReply({
      prompt: "User voice query: where can I find food?\nEvidence bundle for reasoning:\n[1] Neighborhood Pantry.",
      fallbackText: "Neighborhood Pantry can help with food today.",
    });

    expect(capturedRequest).toMatchObject({
      type: "generateVoiceReply",
      data: {
        fallbackText: "Neighborhood Pantry can help with food today.",
        modelName: AUDIO_CHAT_CONFIG.defaultModel,
      },
    });
    expect(capturedRequest?.data.text).toContain("Evidence bundle for reasoning");
    expect(result).toMatchObject({
      kind: "audio",
      audioBlob,
      text: "A concise spoken answer.",
    });
  });

  test("does not expose the hidden voice evidence prompt when local voice generation fails", async () => {
    let capturedRequest: TestAudioWorkerRequest | undefined;
    const worker = createAudioWorkerStub((message, activeWorker) => {
      capturedRequest = message;
      emitAudioWorkerMessage(activeWorker, {
        id: message.id,
        success: false,
        error: "Interleaved audio generation failed.",
      });
    });
    const service = new ClientAudioReplyService({
      createWorker: () => worker as unknown as Worker,
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: false,
    });

    const result = await service.generateVoiceReply({
      prompt: "User voice query: food help\nEvidence bundle for reasoning:\n[1] Hidden evidence context.",
      fallbackText: "Neighborhood Pantry can help with food today.",
    });

    expect(capturedRequest?.data.text).toContain("Hidden evidence context");
    expect(result).toMatchObject({
      kind: "browser-speech",
      text: "Neighborhood Pantry can help with food today.",
      provider: "browser-speech",
    });
    expect(result.kind === "browser-speech" ? result.text : "").not.toContain("Hidden evidence context");
    expect(result.kind === "browser-speech" ? result.text : "").not.toContain("Evidence bundle for reasoning");
  });

  test("uses browser speech as the final fallback after proxy preflight and local audio fail", async () => {
    const service = new ClientAudioReplyService({
      createWorker: () => {
        throw new Error("Local audio worker failed to start.");
      },
      generateRemoteAudio: async () => {
        throw new Error("Remote generation should not run after failed preflight.");
      },
      preflightRemoteAudioProxy: async () => {
        throw new Error("IndexTTS preflight failed; legacy proxy preflight failed.");
      },
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: true,
    });

    const result = await service.generateVoiceReply({
      prompt: "User voice query: food help\nEvidence bundle for reasoning:\n[1] Hidden evidence context.",
      fallbackText: "Neighborhood Pantry can help with food today.",
    });

    expect(result).toMatchObject({
      kind: "browser-speech",
      provider: "browser-speech",
      text: "Neighborhood Pantry can help with food today.",
    });
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").toContain("IndexTTS preflight failed");
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").toContain("Local audio worker failed to start");
    expect(result.kind === "browser-speech" ? result.text : "").not.toContain("Evidence bundle for reasoning");
  });

  test("tries local audio immediately after IndexTTS preflight failure", async () => {
    const service = new ClientAudioReplyService({
      createWorker: () => {
        throw new Error("Local audio worker failed to start.");
      },
      generateRemoteAudio: async () => {
        throw new Error("Remote generation should not run after failed preflight.");
      },
      preflightRemoteAudioProxy: async () => {
        throw new Error("IndexTTS preflight failed with 502.");
      },
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: true,
    });

    const result = await service.generateAudio("Neighborhood Pantry can help with food today.");

    expect(result).toMatchObject({
      kind: "browser-speech",
      provider: "browser-speech",
      text: "Neighborhood Pantry can help with food today.",
    });
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").toContain("IndexTTS preflight failed");
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").toContain("Local audio worker failed to start");
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").not.toContain(
      "Whisper and IndexTTS preflights both fail",
    );
  });

  test("reports a clear failure when no local audio or browser speech path is available", async () => {
    const service = new ClientAudioReplyService({
      createWorker: () => {
        throw new Error("Audio worker failed to start.");
      },
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => false,
      voiceProxyEnabled: false,
    });

    await expect(
      service.generateVoiceReply({
        prompt: "User voice query: food help",
        fallbackText: "Fallback food answer.",
      }),
    ).rejects.toThrow(/Audio worker failed to start\. Browser speech fallback is also unavailable\./);
  });

  test("uses browser speech while the local audio model is still warming up", async () => {
    let warmupRequest: { message: TestAudioWorkerRequest; worker: TestAudioWorkerStub } | undefined;
    let generateRequests = 0;
    const worker = createAudioWorkerStub((message, activeWorker) => {
      if (message.type === "warmUp") {
        warmupRequest = { message, worker: activeWorker };
        return;
      }
      generateRequests += 1;
    });
    const service = new ClientAudioReplyService({
      createWorker: () => worker as unknown as Worker,
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: false,
    });

    const warmupPromise = service.warmUp();
    const result = await service.generateVoiceReply({
      prompt: "User voice query: food help",
      fallbackText: "Fallback food answer.",
    });
    if (!warmupRequest) throw new Error("Warmup request was not sent.");
    emitAudioWorkerMessage(warmupRequest.worker, {
      id: warmupRequest.message.id,
      success: true,
      data: {
        modelName: warmupRequest.message.data.modelName,
        provider: "local-liquidai",
      },
    });
    await warmupPromise;

    expect(generateRequests).toBe(0);
    expect(result).toMatchObject({
      kind: "browser-speech",
      text: "Fallback food answer.",
    });
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").toContain("still downloading or warming up");
  });

  test("does not start the local audio worker when browser policy blocks mobile local audio", async () => {
    let workerStarted = false;
    const service = new ClientAudioReplyService({
      createWorker: () => {
        workerStarted = true;
        return createAudioWorkerStub(() => undefined) as unknown as Worker;
      },
      getLocalAudioBlockReason: () =>
        "LiquidAI local audio is disabled on iPhone and iPad because the model download is too large for reliable mobile Safari use.",
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      voiceProxyEnabled: false,
    });

    const result = await service.generateVoiceReply({
      prompt: "User voice query: food help",
      fallbackText: "Fallback food answer.",
    });

    expect(workerStarted).toBe(false);
    expect(result).toMatchObject({
      kind: "browser-speech",
      text: "Fallback food answer.",
    });
    expect(result.kind === "browser-speech" ? result.fallbackReason : "").toContain("disabled on iPhone and iPad");
  });

  test("retries local LiquidAI audio after a transient failure cooldown", async () => {
    let now = 1_000;
    let requestCount = 0;
    const audioBlob = new Blob(["RIFF....WAVE"], { type: "audio/wav" });
    const service = new ClientAudioReplyService({
      createWorker: () =>
        createAudioWorkerStub((message, activeWorker) => {
          requestCount += 1;
          if (requestCount === 1) {
            emitAudioWorkerMessage(activeWorker, {
              id: message.id,
              success: false,
              error: "WebGPU device lost.",
            });
            return;
          }
          emitAudioWorkerMessage(activeWorker, {
            id: message.id,
            success: true,
            data: {
              audioBlob,
              mimeType: "audio/wav",
              modelName: message.data.modelName,
              provider: "local-liquidai",
            },
          });
        }) as unknown as Worker,
      hasWebGPU: () => true,
      hasSpeechSynthesis: () => true,
      now: () => now,
      voiceProxyEnabled: false,
    });

    const firstResult = await service.generateVoiceReply({
      prompt: "User voice query: food help",
      fallbackText: "Fallback food answer.",
    });
    now += 60_001;
    const secondResult = await service.generateVoiceReply({
      prompt: "User voice query: food help again",
      fallbackText: "Fallback food answer again.",
    });

    expect(firstResult).toMatchObject({
      kind: "browser-speech",
      text: "Fallback food answer.",
    });
    expect(secondResult).toMatchObject({
      kind: "audio",
      audioBlob,
      provider: "local-liquidai",
    });
    expect(requestCount).toBe(2);
  });

  test("builds a voice GraphRAG prompt without exposing citations in browser-speech fallback", () => {
    const evidence: EvidenceBundle = {
      id: "evidence-food",
      query: "food pantry near Portland",
      generatedAt: NOW,
      items: [
        {
          id: "svc-food-pantry-1",
          title: "Neighborhood Food Pantry",
          source: "211 service corpus",
          snippet: "Offers pantry boxes and walk-in intake on weekday afternoons.",
          citation: {
            label: "211 food pantry record",
            url: "https://example.test/pantry",
            docId: "svc-food-pantry-1",
          },
        },
        {
          id: "duplicate-record-alias",
          title: "Duplicate Neighborhood Food Pantry",
          source: "211 service corpus",
          snippet: "Duplicate copy of the pantry record.",
          citation: {
            label: "211 food pantry record duplicate",
            url: "https://example.test/pantry-copy",
            docId: "svc-food-pantry-1",
          },
        },
      ],
    };
    const assistantMessage: AgentMessage = {
      id: "message-assistant",
      sessionId: "session-unit",
      role: "assistant",
      content: "Neighborhood Food Pantry offers pantry boxes.\n\nSources:\n[1] https://example.test/pantry",
      createdAt: NOW,
      status: "complete",
      evidenceBundleIds: [evidence.id],
    };

    const selectedEvidence = selectEvidenceBundlesForMessage(assistantMessage, [evidence]);
    const prompt = buildVoiceGraphRagPrompt({
      userText: "where can I get food today?",
      assistantText: assistantMessage.content,
      evidenceBundles: selectedEvidence,
    });
    const fallbackText = buildVoiceFallbackText(assistantMessage.content);

    expect(selectedEvidence).toEqual([evidence]);
    expect(prompt).toContain("User voice query: where can I get food today?");
    expect(prompt).toContain("Evidence bundle for reasoning:");
    expect(prompt).toContain("Neighborhood Food Pantry");
    expect(prompt).not.toContain("Duplicate Neighborhood Food Pantry");
    expect(prompt).toContain("doc svc-food-pantry-1");
    expect(prompt).toContain("sources are shown on screen");
    expect(fallbackText).toBe("Neighborhood Food Pantry offers pantry boxes.");
    expect(buildVoiceFallbackText(prompt)).toBe("Neighborhood Food Pantry offers pantry boxes.");
  });

  test("keeps evidence attached to the voice prompt when the draft answer is long", () => {
    const evidence: EvidenceBundle = {
      id: "evidence-food-long",
      query: "food pantry near Portland",
      generatedAt: NOW,
      items: [{
        id: "svc-food-pantry-1",
        title: "Neighborhood Food Pantry",
        source: "211 service corpus",
        snippet: "Offers pantry boxes, walk-in intake, grocery pickup, and referrals for nearby meal sites.",
        citation: {
          label: "211 food pantry record",
          docId: "svc-food-pantry-1",
        },
      }],
    };
    const prompt = buildVoiceGraphRagPrompt({
      userText: "I need food assistance today and I want to know what is nearby.",
      assistantText: `Neighborhood Food Pantry may be relevant. ${"More draft context. ".repeat(80)}`,
      evidenceBundles: [evidence],
    });

    expect(prompt.length).toBeGreaterThan(1200);
    expect(prompt.length).toBeLessThanOrEqual(3600);
    expect(prompt).toContain("Evidence bundle for reasoning:");
    expect(prompt).toContain("Neighborhood Food Pantry");
    expect(prompt).toContain("doc svc-food-pantry-1");
  });

  test("routes audio general questions through GraphRAG when requested", async () => {
    const invoked: AgentToolCall[] = [];
    let localLlmCalls = 0;
    const controller = createAgentChatController({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("home"), invoked),
      localLlmService: {
        tryGenerateText: async () => {
          localLlmCalls += 1;
          throw new Error("local LLM response should not run");
        },
        generateStructuredText: async () => {
          localLlmCalls += 1;
          throw new Error("local LLM tool selection should not run");
        },
      },
      now: () => NOW,
      createId: (prefix) => `${prefix}-unit`,
    });

    await controller.sendMessage("fasting", {
      disableLocalLlmReasoning: true,
      preferGraphRagForGeneralQuestions: true,
    });

    expect(localLlmCalls).toBe(0);
    expect(invoked.map((toolCall) => toolCall.name)).toEqual(["answer_211_question"]);
    expect(invoked[0].input).toMatchObject({
      question: "fasting",
      useLocalModel: false,
    });
  });

  test("prefers the finalized transcript when resolving voice reply user text", () => {
    const messages: AgentMessage[] = [
      {
        id: "user-older",
        sessionId: "session-unit",
        role: "user",
        content: "older typed request",
        createdAt: NOW,
        status: "complete",
      },
      {
        id: "assistant-1",
        sessionId: "session-unit",
        role: "assistant",
        content: "Here is the answer.",
        createdAt: NOW,
        status: "complete",
      },
    ];

    expect(resolveVoiceReplyUserText(messages, messages[1], "latest transcribed request")).toBe("latest transcribed request");
    expect(resolveVoiceReplyUserText(messages, messages[1], "   ")).toBe("older typed request");
  });

  test("builds a voice inference fallback request from the transcript and attached evidence", () => {
    const evidence: EvidenceBundle = {
      id: "evidence-food-fallback",
      query: "food pantry near Portland",
      generatedAt: NOW,
      items: [
        {
          id: "svc-food-pantry-fallback",
          title: "Neighborhood Food Pantry",
          source: "211 service corpus",
          snippet: "Offers pantry boxes and grocery pickup.",
          citation: {
            label: "211 food pantry record",
            docId: "svc-food-pantry-fallback",
          },
        },
      ],
    };
    const messages: AgentMessage[] = [
      {
        id: "user-voice-1",
        sessionId: "session-unit",
        role: "user",
        content: "older typed request",
        createdAt: NOW,
        status: "complete",
      },
      {
        id: "assistant-failed-1",
        sessionId: "session-unit",
        role: "assistant",
        content: "OpenRouter text generation failed.",
        createdAt: NOW,
        status: "failed",
        evidenceBundleIds: [evidence.id],
      },
    ];

    const request = buildVoiceInferenceFallbackRequest({
      messages,
      assistantMessage: messages[1],
      evidenceBundles: [evidence],
      pendingVoiceTranscript: "where can I get food today?",
    });

    expect(request.userPrompt).toBe("where can I get food today?");
    expect(request.systemPrompt).toContain("Evidence bundle for reasoning:");
    expect(request.systemPrompt).toContain("Neighborhood Food Pantry");
    expect(request.prompt).toContain("User voice query: where can I get food today?");
    expect(request.fallbackText).toBe("OpenRouter text generation failed.");
  });

  test("uses the generated spoken reply text for TTS and voice inference fallback", () => {
    const evidence: EvidenceBundle = {
      id: "evidence-food-generated",
      query: "food pantry near Portland",
      generatedAt: NOW,
      items: [
        {
          id: "svc-food-generated",
          title: "Neighborhood Food Pantry",
          source: "211 service corpus",
          snippet: "Offers pantry boxes and grocery pickup.",
          citation: {
            label: "211 food pantry record",
            docId: "svc-food-generated",
          },
        },
      ],
    };
    const messages: AgentMessage[] = [
      {
        id: "user-voice-generated",
        sessionId: "session-unit",
        role: "user",
        content: "older typed request",
        createdAt: NOW,
        status: "complete",
      },
      {
        id: "assistant-generated",
        sessionId: "session-unit",
        role: "assistant",
        content: "Original app draft answer.",
        createdAt: NOW,
        status: "complete",
        evidenceBundleIds: [evidence.id],
      },
    ];

    const spokenReply = resolveVoiceGeneratedReplyText(
      "Abby: Neighborhood Food Pantry can help today. Sources are shown on screen.",
      "Original app draft answer.",
    );
    const request = buildVoiceInferenceFallbackRequest({
      messages,
      assistantMessage: messages[1],
      evidenceBundles: [evidence],
      pendingVoiceTranscript: "where can I get food today?",
      assistantText: spokenReply,
      fallbackText: spokenReply,
    });

    expect(spokenReply).toBe("Neighborhood Food Pantry can help today. Sources are shown on screen.");
    expect(request.prompt).toContain("App draft answer: Neighborhood Food Pantry can help today. Sources are shown on screen.");
    expect(request.fallbackText).toBe("Neighborhood Food Pantry can help today. Sources are shown on screen.");
  });

  test("resolves the intro clip against the document base URI", () => {
    expect(resolveAudioOpeningClipUrl("https://example.com/211-AI/index.html", "./")).toBe(
      "https://example.com/211-AI/assets/audio/intro.wav",
    );
    expect(resolveAudioOpeningClipUrl("https://example.com/app/", "/211-AI/")).toBe(
      "https://example.com/211-AI/assets/audio/intro.wav",
    );
  });

  test("reserves the opening clip only once per voice-chat open session", () => {
    resetOpeningGreetingReservation();

    expect(reserveOpeningGreetingForCurrentOpen()).toBe(true);
    expect(reserveOpeningGreetingForCurrentOpen()).toBe(false);

    primeVoiceChatActivation();

    expect(reserveOpeningGreetingForCurrentOpen()).toBe(true);
    resetOpeningGreetingReservation();
  });

  test("concatenates compact citation summaries with their source labels", () => {
    expect(buildCitationSummaryText("Rapid testing available today.", "211 service corpus")).toBe(
      "Rapid testing available today. · 211 service corpus",
    );
    expect(buildCitationSummaryText(undefined, "211 service corpus")).toBe("211 service corpus");
  });

  test("builds corpus asset URLs from an overridden absolute corpus base", () => {
    const originalCorpusBaseUrl = get211CorpusBaseUrl();
    try {
      set211CorpusBaseUrl("https://example.com/211-AI/corpus/211-info/current");
      expect(get211CorpusAssetUrl("generated/documents.json")).toBe(
        "https://example.com/211-AI/corpus/211-info/current/generated/documents.json",
      );
    } finally {
      set211CorpusBaseUrl(originalCorpusBaseUrl);
    }
  });

  test("deletes stale PWA shell caches instead of keeping old hashed app assets forever", () => {
    const currentCaches = new Set(["abby-shell-portal-081-v1", "abby-public-service-detail-portal-081-v1"]);

    expect(shouldDeleteAppCache("abby-shell-portal-076-v1", currentCaches)).toBe(true);
    expect(shouldDeleteAppCache("abby-public-service-detail-portal-076-v1", currentCaches)).toBe(true);
    expect(shouldDeleteAppCache("abby-shell-portal-081-v1", currentCaches)).toBe(false);
    expect(shouldDeleteAppCache("workbox-precache-v1", currentCaches)).toBe(false);
  });

  test("does not route cross-origin voice proxy requests through the service worker", () => {
    expect(
      shouldHandleServiceWorkerRequest(
        "https://animegf.chat:8790/api/voice/infer",
        "https://endomorphosis.github.io/211-AI/",
      ),
    ).toBe(false);

    expect(
      shouldHandleServiceWorkerRequest(
        "https://endomorphosis.github.io/211-AI/assets/app-example.js",
        "https://endomorphosis.github.io/211-AI/",
      ),
    ).toBe(true);
  });

  test("resolves same-origin voice proxy endpoints while rejecting private cross-origin targets", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          origin: "https://211-ai.com",
        },
      },
    });

    try {
      expect(resolvePublicHttpsUrl("/messaging/voice/infer")).toBe("https://211-ai.com/messaging/voice/infer");
      expect(resolvePublicHttpsUrl("same-origin/messaging/voice/tts")).toBe(
        "https://211-ai.com/messaging/voice/tts",
      );
      expect(resolvePublicHttpsUrl("https://192.168.1.10/api/voice/infer")).toBe("");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  test("builds multipart WAV uploads for the remote infer voice proxy route", async () => {
    const formData = createVoiceProxyFormData({
      mode: "voice-reply",
      text: "where can I find food today?",
      userPrompt: "where can I find food today?",
      systemPrompt: "App draft answer: Pantry boxes are available.\nEvidence bundle for reasoning:\n[1] Neighborhood Pantry.",
      fallbackText: "Pantry boxes are available.",
    });

    const audio = formData.get("audio");
    const text = formData.get("text");
    const mode = formData.get("mode");
    const userPrompt = formData.get("userPrompt");
    const systemPrompt = formData.get("systemPrompt");
    const fallbackText = formData.get("fallbackText");

    expect(text).toBe("where can I find food today?");
    expect(mode).toBe("voice-reply");
    expect(userPrompt).toBe("where can I find food today?");
    expect(systemPrompt).toContain("Evidence bundle for reasoning:");
    expect(fallbackText).toBe("Pantry boxes are available.");
    expect(audio).toBeTruthy();
    expect(typeof (audio as Blob | null)?.arrayBuffer).toBe("function");
    expect((audio as Blob | null)?.type ?? "").toBe("audio/wav");
    expect((audio as { name?: string } | null)?.name ?? "").toBe("input.wav");
    expect((await (audio as Blob).arrayBuffer()).byteLength).toBeGreaterThan(44);
  });

  test("rejects non-WAV audio uploads for the remote voice proxy", () => {
    expect(() =>
      createVoiceProxyFormData({
        text: "Describe the audio.",
        audioBlob: new Blob(["not wav"], { type: "audio/webm" }),
      }),
    ).toThrow(/Voice proxy requires WAV input/);

    expect(createSilentWavBlob().type).toBe("audio/wav");
  });

  test("validates command schemas and rejects malformed command payloads", () => {
    expect(validateCommandSchemas()).toEqual([]);
    expect(validateSurfaceRegistry()).toEqual([]);

    expect(commandSchemas.navigate.isInput({ route: "social-services" })).toBe(true);
    expect(commandSchemas.navigate.isInput({ route: "service-detail" })).toBe(false);

    expect(commandSchemas.search_211_services.isInput({ query: "food pantry", limit: 8 })).toBe(true);
    expect(commandSchemas.search_211_services.isInput({ query: "food pantry", limit: 0 })).toBe(false);
    expect(commandSchemas.search_211_services.isInput({ query: "   ", limit: 8 })).toBe(false);

    expect(commandSchemas.create_verified_export_bundle.isInput({
      audienceName: "Benefits clinic",
      recordIds: ["rec-1"],
      proofIds: ["proof-1"],
    })).toBe(true);
    expect(commandSchemas.create_verified_export_bundle.isInput({
      audienceName: "Benefits clinic",
      recordIds: [],
    })).toBe(false);

    expect(isCommandOutputFor("search_211_services", {
      ok: true,
      summary: "Found pantry records.",
      evidenceBundle: {
        id: "evidence-1",
        query: "pantry",
        generatedAt: NOW,
        items: [{
          id: "svc-food-1",
          title: "Neighborhood Pantry",
          source: "211 corpus",
          snippet: "Food pantry referrals.",
          citation: { label: "Neighborhood Pantry", docId: "svc-food-1" },
        }],
      } satisfies EvidenceBundle,
      recordIds: ["svc-food-1"],
    })).toBe(true);
    expect(isCommandOutputFor("search_211_services", {
      ok: true,
      summary: "Broken evidence.",
      evidenceBundle: { id: "missing-items" },
    })).toBe(false);
  });

  test("routes deterministic planner turns to app, service, wallet, and confirmation actions", () => {
    const homeContext = createSurfaceContext("home");
    const serviceSearch = planAgentTurn({
      content: "Find food pantry services near me",
      context: homeContext,
    });

    expect(serviceSearch.intentKind).toBe("service_navigation");
    expect(serviceSearch.tools.map((tool) => tool.name)).toEqual(["navigate", "search_211_services"]);
    expect(serviceSearch.tools[0].input).toEqual({ route: "social-services" });
    expect(serviceSearch.tools[1].input).toEqual({
      query: "Find food pantry services near me",
      limit: 8,
    });

    const auditTurn = planAgentTurn({
      content: "Open the latest audit history",
      context: createSurfaceContext("home"),
    });
    expect(auditTurn.tools.map((tool) => tool.name)).toEqual(["navigate", "summarize_audit_events"]);
    expect(auditTurn.tools[0].input).toEqual({ route: "audit" });
    expect(auditTurn.tools[1].input).toEqual({ limit: 25 });

    const auditRefreshTurn = planAgentTurn({
      content: "Refresh audit activity",
      context: createSurfaceContext("home"),
    });
    expect(auditRefreshTurn.tools.map((tool) => tool.name)).toEqual(["navigate", "refresh_wallet_audit"]);
    expect(auditRefreshTurn.tools[0].input).toEqual({ route: "audit" });
    expect(auditRefreshTurn.tools[1].input).toEqual({ limit: 25 });

    const saveTurn = planAgentTurn({
      content: "Save this service",
      context: createSurfaceContext("social-services", {
        selectedServiceDocId: "svc-food-1",
        visibleServiceDocIds: ["svc-food-1"],
      }),
    });
    expect(saveTurn.intentKind).toBe("wallet_action");
    expect(saveTurn.tools).toEqual([{
      name: "save_service",
      input: { serviceId: "svc-food-1" },
      title: getToolDefinition("save_service").title,
    }]);

    const confirmationTurn = planAgentTurn({
      content: "yes, go ahead",
      context: createSurfaceContext("social-services"),
      pendingConfirmations: [{
        id: "confirmation-save",
        sessionId: "agent-session-unit",
        toolCallId: "tool-save",
        title: "Save service",
        summary: "Save service svc-food-1.",
        risk: "high",
        permissionLevel: "write_wallet",
        status: "pending",
        requestedAt: NOW,
      }],
    });
    expect(confirmationTurn.confirmationDecision).toEqual({
      confirmationId: "confirmation-save",
      approved: true,
    });

    const serviceAnswerTurn = planAgentTurn({
      content: "Do you know about eviction help?",
      context: createSurfaceContext("social-services"),
    });
    expect(serviceAnswerTurn.tools.map((tool) => tool.name)).toEqual(["answer_211_question"]);
    expect(serviceAnswerTurn.tools[0].input).toEqual({
      question: "Do you know about eviction help?",
      useLocalModel: true,
    });
  });

  test("enforces permission gates before tools can run", () => {
    const savePolicy = getAgentToolPermissionPolicy("save_service");
    expect(savePolicy.gate).toBe("write_wallet");
    expect(confirmationRiskForGate(savePolicy.gate)).toBe("high");

    expect(evaluateAgentToolPermissionPolicy("answer_211_question", {
      route: "home",
      allowedSurfaces: getToolDefinition("answer_211_question").surfaces,
      grantedPermissionLevel: "public",
      walletUnlocked: true,
      privateContextAllowed: false,
      userPresent: true,
      toolTitle: "Answer 211 question",
    })).toMatchObject({ ok: true });

    expect(evaluateAgentToolPermissionPolicy("save_service", {
      route: "home",
      allowedSurfaces: ["social-services"],
      grantedPermissionLevel: "write_wallet",
      walletUnlocked: true,
      privateContextAllowed: false,
      userPresent: true,
      toolTitle: "Save service",
    })).toMatchObject({ ok: false, code: "surface_not_allowed" });

    expect(evaluateAgentToolPermissionPolicy("save_service", {
      route: "social-services",
      allowedSurfaces: ["social-services"],
      grantedPermissionLevel: "public",
      walletUnlocked: true,
      privateContextAllowed: false,
      userPresent: true,
      toolTitle: "Save service",
    })).toMatchObject({ ok: false, code: "permission_denied" });

    expect(evaluateAgentToolPermissionPolicy("save_service", {
      route: "social-services",
      allowedSurfaces: ["social-services"],
      grantedPermissionLevel: "write_wallet",
      walletUnlocked: false,
      privateContextAllowed: false,
      userPresent: true,
      toolTitle: "Save service",
    })).toMatchObject({ ok: false, code: "wallet_locked" });

    expect(evaluateAgentToolPermissionPolicy("create_service_plan", {
      route: "social-services",
      allowedSurfaces: ["social-services"],
      grantedPermissionLevel: "write_wallet",
      walletUnlocked: true,
      privateContextAllowed: false,
      userPresent: true,
      toolTitle: "Create service plan",
    })).toMatchObject({ ok: false, code: "private_context_required" });
  });

  test("requires confirmation for wallet writes and executes public reads directly", async () => {
    const invoked: AgentToolCall[] = [];
    let idCounter = 0;
    const executor = createAgentToolExecutor({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("social-services", {
        permissionLevel: "write_wallet",
        walletUnlocked: true,
      }), invoked),
      sessionId: "agent-session-unit",
      now: () => NOW,
      createId: (prefix) => `${prefix}-${++idCounter}`,
    });

    const publicRead = await executor.execute("search_211_services", { query: "pantry", limit: 3 });
    expect(publicRead.status).toBe("succeeded");
    expect(invoked.map((toolCall) => toolCall.name)).toEqual(["search_211_services"]);

    const save = await executor.execute("save_service", { serviceId: "svc-food-1" });
    expect(save.status).toBe("waiting_for_confirmation");
    expect(save.toolCall.status).toBe("waiting_for_confirmation");
    if (save.status !== "waiting_for_confirmation") {
      throw new Error("save_service should wait for confirmation");
    }
    expect(save.confirmation).toMatchObject({
      id: "agent-confirmation-3",
      sessionId: "agent-session-unit",
      toolCallId: save.toolCall.id,
      title: "Save service",
      risk: "high",
      permissionLevel: "write_wallet",
      status: "pending",
      details: {
        permissionGate: "write_wallet",
        requiresAudit: true,
        auditEventType: "agent.service.save",
      },
    });
    expect(save.confirmation.summary).toContain("Save service svc-food-1");
    expect(invoked.map((toolCall) => toolCall.name)).toEqual(["search_211_services"]);

    const confirmed = await executor.executeToolCall(save.toolCall, {
      confirmed: true,
      confirmationId: save.confirmation.id,
    });
    expect(confirmed.status).toBe("succeeded");
    expect(invoked.map((toolCall) => toolCall.name)).toEqual(["search_211_services", "save_service"]);
  });

  test("redacts private prompt context, raw history, and raw evidence queries by default", () => {
    const privateContext = createSurfaceContext("register", {
      routeLabel: "Register",
      permissionLevel: "wallet_private",
      walletUnlocked: true,
      privateContextAllowed: true,
      selectedRecordId: "rec-state-id",
      visibleRecordIds: ["rec-state-id", "rec-medical-note"],
      summary: "Jordan is at 123 Main Street and uses jordan@example.test.",
      metadata: {
        visibleCount: 2,
        phone: "503-555-0199",
        privateNotes: "notes: disclose only at intake",
        documentContents: "document: full benefits letter text",
        currentLocation: "45.5201, -122.6802",
      },
    });

    const safe = buildPromptSafeSurfaceContext(privateContext);
    expect(safe.permissionLevel).toBe("app_context");
    expect(safe.privateContextAllowed).toBe(false);
    expect(safe.summary).toBe("Register surface is active.");
    expect(safe.selectedRecordId).toBeUndefined();
    expect(safe.visibleRecordIds).toBeUndefined();
    expect(safe.metadata).toEqual({ visibleCount: 2 });
    expect(safe.redactions.join("\n")).toContain("Private route summaries are replaced");
    expect(JSON.stringify(safe)).not.toContain("jordan@example.test");
    expect(JSON.stringify(safe)).not.toContain("503-555-0199");
    expect(JSON.stringify(safe)).not.toContain("rec-state-id");

    expect(guardPromptText(
      "Email jordan@example.test, call 503-555-0199, private notes: urgent intake.",
      "user.message",
    )).toBe("Email [redacted private contact], call [redacted private contact], [redacted private notes].");

    const history: AgentMessage[] = [{
      id: "message-user",
      sessionId: "agent-session-unit",
      role: "user",
      content: "My phone is 503-555-0199. Find shelter.",
      createdAt: NOW,
      status: "complete",
    }];
    expect(compactPromptConversationHistory(history)).toEqual([{
      role: "user",
      content: "[redacted prior user query]",
      createdAt: NOW,
      status: "complete",
    }]);

    const evidence = evidenceBundleFromResults("pantry near 123 Main Street", [
      createSearchResult("svc-food-1", "Neighborhood Pantry"),
    ]);
    expect(guardEvidenceBundles([evidence])[0].query).toBe("[redacted raw query]");

    const visibleTools = guardAgentToolDefinitions(agentToolDefinitions, privateContext);
    expect(visibleTools.map((tool) => tool.name)).not.toContain("update_registration_draft");
  });

  test("allows explicitly approved private prompt context without exposing unrelated categories", () => {
    const privateContext = createSurfaceContext("register", {
      routeLabel: "Register",
      permissionLevel: "wallet_private",
      walletUnlocked: true,
      privateContextAllowed: true,
      selectedRecordId: "rec-state-id",
      visibleRecordIds: ["rec-state-id"],
      summary: "Profile email is jordan@example.test.",
      metadata: {
        phone: "503-555-0199",
        currentLocation: "45.5201, -122.6802",
        documentContents: "document: full benefits letter text",
      },
    });

    const safe = buildPromptSafeSurfaceContext(privateContext, {
      includePrivateWalletContext: true,
    });

    expect(safe.permissionLevel).toBe("wallet_private");
    expect(safe.privateContextAllowed).toBe(true);
    expect(safe.selectedRecordId).toBe("rec-state-id");
    expect(safe.summary).toBe("Profile email is jordan@example.test.");
    expect(safe.metadata).toEqual({ phone: "503-555-0199" });
    expect(JSON.stringify(safe)).not.toContain("45.5201");
    expect(JSON.stringify(safe)).not.toContain("full benefits letter text");
    expect(safe.redactions.join("\n")).toContain("metadata.currentLocation");
    expect(safe.redactions.join("\n")).toContain("metadata.documentContents");
  });

  test("maps GraphRAG evidence into citations, record IDs, and actionable next steps", () => {
    const first = createSearchResult("svc-food-1", "Neighborhood Pantry");
    const second = createSearchResult("svc-food-2", "Community Kitchen");

    const evidence = evidenceBundleFromResults("food pantry", [first, second]);
    expect(evidence.id).toMatch(/^evidence-/);
    expect(evidence.items.map((item) => item.id)).toEqual(["svc-food-1", "svc-food-2"]);
    expect(evidence.items[0]).toMatchObject({
      title: "Neighborhood Pantry program",
      source: "https://211.example.test/services/svc-food-1",
      citation: {
        label: "Neighborhood Pantry program",
        url: "https://211.example.test/services/svc-food-1",
        contentCid: "cid-svc-food-1",
        pageCid: "page-svc-food-1",
        docId: "svc-food-1",
      },
    });

    expect(buildServiceNavigationNextSteps([first, second])).toEqual([
      "Open service detail svc-food-1 to review Neighborhood Pantry.",
      "After you review a record, you can ask Abby to save it or create a follow-up plan; wallet writes require confirmation.",
    ]);
    expect(buildServiceNavigationNextSteps([])).toEqual([
      "Try a more specific service type, neighborhood, or eligibility term.",
      "For urgent service navigation, contact 211 directly.",
    ]);
  });

  test("keeps GraphRAG prompts compact and citation-oriented for browser inference", () => {
    const longSnippet = "Food pantry intake and grocery pickup details. ".repeat(40);
    const results = Array.from({ length: 6 }, (_, index) => {
      const result = createSearchResult(`svc-food-${index + 1}`, `Provider ${index + 1}`);
      result.snippet = longSnippet;
      return result;
    });
    const evidence: GraphRagEvidence = {
      query: "food pantry near Portland",
      results,
      nodes: Array.from({ length: 12 }, (_, index) => ({
        node_id: `node-${index + 1}`,
        node_type: "category",
        label: `Graph node ${index + 1}`,
      })),
      edges: Array.from({ length: 12 }, (_, index) => ({
        source: `node-${index + 1}`,
        target: `node-${Math.min(index + 2, 12)}`,
        relation: "RELATED_TO",
        edge_cid: `edge-${index + 1}`,
      })),
    };

    const prompt = build211GraphRagPrompt("Which food pantry should I try?", evidence);

    expect(DEFAULT_GRAPH_RAG_MODEL_MAX_TOKENS).toBe(512);
    expect(prompt).toContain("Keep it under 120 words");
    expect(prompt).toContain("Cite every bullet");
    expect(prompt).toContain("[4] Provider 4");
    expect(prompt).not.toContain("[5] Provider 5");
    expect(prompt).toContain("Graph node 8");
    expect(prompt).not.toContain("Graph node 9");
    expect(prompt.length).toBeLessThan(5200);
  });

  test("merges duplicate service results that share identity and coordinates", () => {
    const first = createSearchResult("svc-health-1", "NARA Wellness Center");
    first.contentCid = "shared-cid";
    first.pageCid = "shared-page";
    first.document.source_content_cid = "shared-cid";
    first.document.source_page_cid = "shared-page";
    first.document.source_url = "https://211.example.test/services/nara-wellness";
    first.document.geo_lat = 45.5231;
    first.document.geo_lon = -122.6765;
    first.document.addresses = [
      {
        address: "123 Main Street, Portland, OR 97204",
        city: "Portland",
        state: "OR",
        street: "123 Main Street",
      },
    ];

    const second = createSearchResult("svc-health-2", "NARA Wellness Center");
    second.contentCid = "shared-cid";
    second.pageCid = "shared-page";
    second.document.source_content_cid = "shared-cid";
    second.document.source_page_cid = "shared-page";
    second.document.source_url = "https://211.example.test/services/nara-wellness";
    second.document.geo_lat = 45.52311;
    second.document.geo_lon = -122.67649;
    second.document.addresses = [
      {
        address: "123 Main St., Portland, OR",
        city: "Portland",
        state: "OR",
        street: "123 Main St",
      },
    ];

    const merged = mergeDuplicateSearchResults([first, second]);

    expect(merged).toHaveLength(1);
    expect(merged[0].duplicateCount).toBe(2);
    expect([...(merged[0].mergedDocIds || [])].sort()).toEqual(["svc-health-1", "svc-health-2"]);
  });

  test("keeps distinct service locations separate even when provider details match", () => {
    const first = createSearchResult("svc-food-1", "Neighborhood Pantry");
    first.contentCid = "shared-cid";
    first.document.source_content_cid = "shared-cid";
    first.document.source_url = "https://211.example.test/services/neighborhood-pantry";
    first.document.geo_lat = 45.5231;
    first.document.geo_lon = -122.6765;
    first.document.addresses = [
      {
        address: "123 Main Street, Portland, OR 97204",
        city: "Portland",
        state: "OR",
        street: "123 Main Street",
      },
    ];

    const second = createSearchResult("svc-food-2", "Neighborhood Pantry");
    second.contentCid = "shared-cid";
    second.document.source_content_cid = "shared-cid";
    second.document.source_url = "https://211.example.test/services/neighborhood-pantry";
    second.document.geo_lat = 45.5299;
    second.document.geo_lon = -122.7001;
    second.document.addresses = [
      {
        address: "456 Oak Avenue, Portland, OR 97205",
        city: "Portland",
        state: "OR",
        street: "456 Oak Avenue",
      },
    ];

    const merged = mergeDuplicateSearchResults([first, second]);

    expect(merged).toHaveLength(2);
  });

  test("formats 211 fallback summaries without dumping inline source blocks", () => {
    const evidence: GraphRagEvidence = {
      query: "hello testing",
      results: [createSearchResult("svc-health-1", "NARA Wellness Center")],
      nodes: [],
      edges: [],
    };

    const summary = build211InfoFallbackSummary(evidence);

    expect(summary).toContain("Review the linked results below");
    expect(summary).not.toContain("The strongest local 211 corpus matches are");
    expect(summary).not.toContain("Sources:");
  });

  test("keeps every registered tool tied to a concrete permission policy", () => {
    for (const tool of agentToolDefinitions) {
      const commandName = tool.name as AgentCommandName;
      const policy = getAgentToolPermissionPolicy(commandName);
      expect(tool.requiresConfirmation).toBe(policy.requiresConfirmation);
      expect(tool.requiresAudit).toBe(policy.requiresAudit);
      expect(tool.requiresWalletUnlock).toBe(policy.requiresWalletUnlock);
      expect(tool.requiresUserPresence).toBe(policy.requiresUserPresence);
      expect(tool.requiresPrivateContextOptIn).toBe(policy.requiresPrivateContextOptIn);
      expect(tool.permissionLevel as AgentPermissionLevel).toBeTruthy();
    }
  });

  test("caches chat snapshots until controller state changes", () => {
    const controller = createAgentChatController({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("home")),
      now: () => NOW,
      createId: (prefix) => `${prefix}-unit`,
    });

    const initial = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(initial);

    controller.setActiveRoute("exports");
    const updated = controller.getSnapshot();

    expect(updated).not.toBe(initial);
    expect(updated.session.activeRoute).toBe("exports");
    expect(controller.getSnapshot()).toBe(updated);
  });

  test("uses the local LLM service for general assistant chat responses", async () => {
    const invoked: AgentToolCall[] = [];
    const prompts: string[] = [];
    const controller = createAgentChatController({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("home"), invoked),
      enableLocalLlmToolSelection: false,
      enableLocalLlmResponses: true,
      localLlmService: {
        tryGenerateText: async (prompt) => {
          prompts.push(typeof prompt === "string" ? prompt : prompt.prompt);
          return {
            ok: true,
            text: "Abby: I can explain this screen and help you move to the right app surface.",
            modelName: "test-local-model",
          };
        },
        generateStructuredText: async () => ({
          ok: false,
          text: "",
          error: "not used",
        }),
      },
      now: () => NOW,
      createId: (prefix) => `${prefix}-unit`,
    });

    await controller.sendMessage("hello there");

    expect(invoked).toEqual([]);
    expect(prompts[0]).toContain("Safe app context");
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe(
      "I can explain this screen and help you move to the right app surface.",
    );
  });

  test("falls back when local LLM capability answers are too generic", async () => {
    const invoked: AgentToolCall[] = [];
    const controller = createAgentChatController({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("home"), invoked),
      enableLocalLlmToolSelection: false,
      enableLocalLlmResponses: true,
      localLlmService: {
        tryGenerateText: async () => ({
          ok: true,
          text: "Sure! What can I assist you with today?",
          modelName: "test-local-model",
        }),
        generateStructuredText: async () => ({
          ok: false,
          text: "",
          error: "not used",
        }),
      },
      now: () => NOW,
      createId: (prefix) => `${prefix}-unit`,
    });

    await controller.sendMessage("What can you help me with?");

    expect(invoked).toEqual([]);
    expect(controller.getSnapshot().messages.at(-1)?.content).toMatch(
      /I can explain this screen, navigate the app, answer public 211 service questions, and ask for confirmation before changing wallet data\./,
    );
  });

  test("uses local LLM tool selection by default before falling back to deterministic responses", async () => {
    const invoked: AgentToolCall[] = [];
    const controller = createAgentChatController({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("home"), invoked),
      localLlmService: {
        tryGenerateText: async () => ({
          ok: true,
          text: "not used",
        }),
        generateStructuredText: async () => ({
          ok: true,
          text: "{\"action\":\"call_tool\",\"tool\":\"navigate\",\"input\":{\"route\":\"security\"},\"message\":\"Open Security.\"}",
          json: {
            action: "call_tool",
            tool: "navigate",
            input: { route: "security" },
            message: "Open Security.",
          },
          modelName: "test-local-model",
        }),
      },
      now: () => NOW,
      createId: (prefix) => `${prefix}-unit`,
    });

    await controller.sendMessage("organize my verified packet");

    expect(invoked.map((toolCall) => toolCall.name)).toEqual(["navigate"]);
    expect(invoked[0].input).toEqual({ route: "security" });
  });

  test("can disable local LLM reasoning for a single chat turn", async () => {
    const invoked: AgentToolCall[] = [];
    let localLlmCalls = 0;
    const controller = createAgentChatController({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("home"), invoked),
      localLlmService: {
        tryGenerateText: async () => {
          localLlmCalls += 1;
          throw new Error("local LLM response should not run");
        },
        generateStructuredText: async () => {
          localLlmCalls += 1;
          throw new Error("local LLM tool selection should not run");
        },
      },
      now: () => NOW,
      createId: (prefix) => `${prefix}-unit`,
    });

    await controller.sendMessage("hello there", { disableLocalLlmReasoning: true });

    expect(localLlmCalls).toBe(0);
    expect(invoked).toEqual([]);
    expect(controller.getSnapshot().messages.at(-1)?.content).toMatch(/I am here and ready to help\./);
    expect(controller.getSnapshot().messages.at(-1)?.content).not.toMatch(/You are on home\./);
  });

  test("disables local GraphRAG model answers when local LLM reasoning is disabled", async () => {
    const invoked: AgentToolCall[] = [];
    const controller = createAgentChatController({
      surfaceApi: createFakeSurfaceApi(createSurfaceContext("home"), invoked),
      localLlmService: {
        tryGenerateText: async () => {
          throw new Error("local LLM response should not run");
        },
        generateStructuredText: async () => {
          throw new Error("local LLM tool selection should not run");
        },
      },
      now: () => NOW,
      createId: (prefix) => `${prefix}-unit`,
    });

    await controller.sendMessage("tell me about 211 shelter eligibility", { disableLocalLlmReasoning: true });

    expect(invoked.map((toolCall) => toolCall.name)).toEqual(["navigate", "answer_211_question"]);
    expect(invoked[1].input).toMatchObject({
      question: "tell me about 211 shelter eligibility",
      useLocalModel: false,
    });
  });

  test("uses OpenRouter when WebGPU is unavailable for the default client LLM", async () => {
    const service = clientLLMWorkerService as unknown as TestableClientLLMWorkerService;
    const restoreStorage = installMemoryLocalStorage();
    const originalState = {
      worker: service.worker,
      isInitialized: service.isInitialized,
      isInitializing: service.isInitializing,
      currentModel: service.currentModel,
      currentDevice: service.currentDevice,
      capabilitiesKnown: service.capabilitiesKnown,
      webGPUFallbackReason: service.webGPUFallbackReason,
      openRouterLastError: service.openRouterLastError,
      openRouterLastUsedAt: service.openRouterLastUsedAt,
      lastGenerationModel: service.lastGenerationModel,
      lastGenerationProvider: service.lastGenerationProvider,
      generationCounter: service.generationCounter,
      generationWinnerId: service.generationWinnerId,
      localWarmupPromise: service.localWarmupPromise,
      capabilities: service.capabilities,
      pendingRequests: service.pendingRequests,
      requestCounter: service.requestCounter,
      sendWorkerRequest: service.sendWorkerRequest,
      fetch: globalThis.fetch,
    };
    const calls: string[] = [];
    let requestBody: any;

    try {
      globalThis.localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, "test-openrouter-key");
      service.worker = { terminate: () => undefined };
      service.isInitialized = false;
      service.isInitializing = false;
      service.currentModel = LLM_CONFIG.defaultModel;
      service.currentDevice = "wasm";
      service.capabilitiesKnown = true;
      service.webGPUFallbackReason = undefined;
      service.openRouterLastError = undefined;
      service.openRouterLastUsedAt = undefined;
      service.lastGenerationModel = LLM_CONFIG.defaultModel;
      service.lastGenerationProvider = "local";
      service.generationWinnerId = 0;
      service.localWarmupPromise = null;
      service.capabilities = {
        webGPU: false,
        webGPUError: "navigator.gpu is unavailable",
        webGPUShaderF16: false,
        simd: true,
        wasmThreads: true,
        crossOriginIsolated: true,
        sharedArrayBuffer: true,
      };
      service.pendingRequests = new Map();
      service.requestCounter = 0;
      service.sendWorkerRequest = async (type) => {
        calls.push(type);
        throw new Error("local worker should not be used before OpenRouter");
      };
      globalThis.fetch = async (_input, init) => {
        requestBody = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({
            model: "liquid/lfm-2.5-1.2b-instruct:free",
            choices: [{ message: { role: "assistant", content: "remote answer" } }],
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      };

      const text = await service.generateText("What can you do?", 64);

      expect(text).toBe("remote answer");
      expect(calls).toEqual([]);
      expect(requestBody.model).toBe("liquid/lfm-2.5-1.2b-instruct:free");
      expect(requestBody.messages[0]).toMatchObject({ role: "system" });
      expect(requestBody.max_tokens).toBe(64);
      expect(requestBody.temperature).toBe(0.1);
      expect(requestBody.top_k).toBe(50);
      expect(service.lastGenerationProvider).toBe("openrouter");
      expect(service.lastGenerationModel).toBe("liquid/lfm-2.5-1.2b-instruct:free");
    } finally {
      service.worker = originalState.worker;
      service.isInitialized = originalState.isInitialized;
      service.isInitializing = originalState.isInitializing;
      service.currentModel = originalState.currentModel;
      service.currentDevice = originalState.currentDevice;
      service.capabilitiesKnown = originalState.capabilitiesKnown;
      service.webGPUFallbackReason = originalState.webGPUFallbackReason;
      service.openRouterLastError = originalState.openRouterLastError;
      service.openRouterLastUsedAt = originalState.openRouterLastUsedAt;
      service.lastGenerationModel = originalState.lastGenerationModel;
      service.lastGenerationProvider = originalState.lastGenerationProvider;
      service.generationCounter = originalState.generationCounter;
      service.generationWinnerId = originalState.generationWinnerId;
      service.localWarmupPromise = originalState.localWarmupPromise;
      service.capabilities = originalState.capabilities;
      service.pendingRequests = originalState.pendingRequests;
      service.requestCounter = originalState.requestCounter;
      service.sendWorkerRequest = originalState.sendWorkerRequest;
      globalThis.fetch = originalState.fetch;
      restoreStorage();
    }
  });

  test("uses proxy-first LLM synthesis for 211 answers even when local model use is disabled", async () => {
    const service = clientLLMWorkerService as unknown as TestableClientLLMWorkerService;
    const restoreStorage = installMemoryLocalStorage();
    const originalState = {
      worker: service.worker,
      isInitialized: service.isInitialized,
      isInitializing: service.isInitializing,
      currentModel: service.currentModel,
      currentDevice: service.currentDevice,
      capabilitiesKnown: service.capabilitiesKnown,
      webGPUFallbackReason: service.webGPUFallbackReason,
      openRouterLastError: service.openRouterLastError,
      openRouterLastUsedAt: service.openRouterLastUsedAt,
      lastGenerationModel: service.lastGenerationModel,
      lastGenerationProvider: service.lastGenerationProvider,
      generationCounter: service.generationCounter,
      generationWinnerId: service.generationWinnerId,
      localWarmupPromise: service.localWarmupPromise,
      capabilities: service.capabilities,
      pendingRequests: service.pendingRequests,
      requestCounter: service.requestCounter,
      sendWorkerRequest: service.sendWorkerRequest,
      fetch: globalThis.fetch,
      buildEvidence: ragSearchWorkerService.buildEvidence,
    };
    const evidence: GraphRagEvidence = {
      query: "hello testing",
      results: [createSearchResult("svc-health-1", "NARA Wellness Center")],
      nodes: [],
      edges: [],
    };
    let requestBody: any;

    try {
      globalThis.localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, "test-openrouter-key");
      service.worker = { terminate: () => undefined };
      service.isInitialized = false;
      service.isInitializing = false;
      service.currentModel = LLM_CONFIG.defaultModel;
      service.currentDevice = "wasm";
      service.capabilitiesKnown = true;
      service.webGPUFallbackReason = undefined;
      service.openRouterLastError = undefined;
      service.openRouterLastUsedAt = undefined;
      service.lastGenerationModel = LLM_CONFIG.defaultModel;
      service.lastGenerationProvider = "local";
      service.generationWinnerId = 0;
      service.localWarmupPromise = null;
      service.capabilities = {
        webGPU: false,
        webGPUError: "navigator.gpu is unavailable",
        webGPUShaderF16: false,
        simd: true,
        wasmThreads: true,
        crossOriginIsolated: true,
        sharedArrayBuffer: true,
      };
      service.pendingRequests = new Map();
      service.requestCounter = 0;
      service.sendWorkerRequest = async () => {
        throw new Error("local worker should not be used before OpenRouter");
      };
      ragSearchWorkerService.buildEvidence = async () => evidence;
      globalThis.fetch = async (_input, init) => {
        requestBody = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({
            model: "liquid/lfm-2.5-1.2b-instruct:free",
            choices: [{ message: { role: "assistant", content: "NARA Wellness Center may be relevant for health services [1]." } }],
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      };

      const result = await answer211InfoQuestion("hello testing", {
        useLocalModel: false,
        serviceOnly: false,
        maxTokens: 512,
      });

      expect(result.answer).toBe("NARA Wellness Center may be relevant for health services [1].");
      expect(result.answer).not.toContain("The strongest local 211 corpus matches are");
      expect(result.usedLocalModel).toBe(false);
      expect(requestBody.max_tokens).toBe(512);
    } finally {
      service.worker = originalState.worker;
      service.isInitialized = originalState.isInitialized;
      service.isInitializing = originalState.isInitializing;
      service.currentModel = originalState.currentModel;
      service.currentDevice = originalState.currentDevice;
      service.capabilitiesKnown = originalState.capabilitiesKnown;
      service.webGPUFallbackReason = originalState.webGPUFallbackReason;
      service.openRouterLastError = originalState.openRouterLastError;
      service.openRouterLastUsedAt = originalState.openRouterLastUsedAt;
      service.lastGenerationModel = originalState.lastGenerationModel;
      service.lastGenerationProvider = originalState.lastGenerationProvider;
      service.generationCounter = originalState.generationCounter;
      service.generationWinnerId = originalState.generationWinnerId;
      service.localWarmupPromise = originalState.localWarmupPromise;
      service.capabilities = originalState.capabilities;
      service.pendingRequests = originalState.pendingRequests;
      service.requestCounter = originalState.requestCounter;
      service.sendWorkerRequest = originalState.sendWorkerRequest;
      ragSearchWorkerService.buildEvidence = originalState.buildEvidence;
      globalThis.fetch = originalState.fetch;
      restoreStorage();
    }
  });

  test("sends voice system and user prompts separately to OpenRouter", async () => {
    const service = clientLLMWorkerService as unknown as TestableClientLLMWorkerService;
    const restoreStorage = installMemoryLocalStorage();
    const originalState = {
      worker: service.worker,
      isInitialized: service.isInitialized,
      isInitializing: service.isInitializing,
      currentModel: service.currentModel,
      currentDevice: service.currentDevice,
      capabilitiesKnown: service.capabilitiesKnown,
      webGPUFallbackReason: service.webGPUFallbackReason,
      openRouterLastError: service.openRouterLastError,
      openRouterLastUsedAt: service.openRouterLastUsedAt,
      lastGenerationModel: service.lastGenerationModel,
      lastGenerationProvider: service.lastGenerationProvider,
      generationCounter: service.generationCounter,
      generationWinnerId: service.generationWinnerId,
      localWarmupPromise: service.localWarmupPromise,
      capabilities: service.capabilities,
      pendingRequests: service.pendingRequests,
      requestCounter: service.requestCounter,
      sendWorkerRequest: service.sendWorkerRequest,
      fetch: globalThis.fetch,
    };
    let requestBody: any;

    try {
      globalThis.localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, "test-openrouter-key");
      service.worker = { terminate: () => undefined };
      service.isInitialized = false;
      service.isInitializing = false;
      service.currentModel = LLM_CONFIG.defaultModel;
      service.currentDevice = "wasm";
      service.capabilitiesKnown = true;
      service.webGPUFallbackReason = undefined;
      service.openRouterLastError = undefined;
      service.openRouterLastUsedAt = undefined;
      service.lastGenerationModel = LLM_CONFIG.defaultModel;
      service.lastGenerationProvider = "local";
      service.generationWinnerId = 0;
      service.localWarmupPromise = null;
      service.capabilities = {
        webGPU: false,
        webGPUError: "navigator.gpu is unavailable",
        webGPUShaderF16: false,
        simd: true,
        wasmThreads: true,
        crossOriginIsolated: true,
        sharedArrayBuffer: true,
      };
      service.pendingRequests = new Map();
      service.requestCounter = 0;
      service.sendWorkerRequest = async () => {
        throw new Error("local worker should not be used before OpenRouter");
      };
      globalThis.fetch = async (_input, init) => {
        requestBody = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({
            model: "liquid/lfm-2.5-1.2b-instruct:free",
            choices: [{ message: { role: "assistant", content: "remote answer" } }],
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      };

      const promptParts = buildVoiceGraphRagPromptParts({
        userText: "where can I break my fast tonight?",
        assistantText: "Neighborhood Food Pantry can help today. Sources are shown on screen.",
        evidenceBundles: [
          {
            id: "evidence-voice-openrouter",
            query: "food pantry near Portland",
            generatedAt: NOW,
            items: [
              {
                id: "svc-food-openrouter",
                title: "Neighborhood Food Pantry",
                source: "211 service corpus",
                snippet: "Offers pantry boxes and grocery pickup.",
                citation: {
                  label: "211 food pantry record",
                  docId: "svc-food-openrouter",
                },
              },
            ],
          },
        ],
      });

      const text = await service.generateText(
        {
          prompt: promptParts.fullPrompt,
          systemPrompt: promptParts.systemPrompt,
          userPrompt: promptParts.userPrompt,
        },
        64,
      );

      expect(text).toBe("remote answer");
      expect(requestBody.messages).toEqual([
        { role: "system", content: promptParts.systemPrompt },
        { role: "user", content: promptParts.userPrompt },
      ]);
      expect(requestBody.messages[0].content).toContain("Evidence bundle for reasoning:");
      expect(requestBody.messages[0].content).not.toContain("User voice query:");
      expect(requestBody.messages[1].content).toBe("where can I break my fast tonight?");
      expect(requestBody.max_tokens).toBe(64);
    } finally {
      service.worker = originalState.worker;
      service.isInitialized = originalState.isInitialized;
      service.isInitializing = originalState.isInitializing;
      service.currentModel = originalState.currentModel;
      service.currentDevice = originalState.currentDevice;
      service.capabilitiesKnown = originalState.capabilitiesKnown;
      service.webGPUFallbackReason = originalState.webGPUFallbackReason;
      service.openRouterLastError = originalState.openRouterLastError;
      service.openRouterLastUsedAt = originalState.openRouterLastUsedAt;
      service.lastGenerationModel = originalState.lastGenerationModel;
      service.lastGenerationProvider = originalState.lastGenerationProvider;
      service.generationCounter = originalState.generationCounter;
      service.generationWinnerId = originalState.generationWinnerId;
      service.localWarmupPromise = originalState.localWarmupPromise;
      service.capabilities = originalState.capabilities;
      service.pendingRequests = originalState.pendingRequests;
      service.requestCounter = originalState.requestCounter;
      service.sendWorkerRequest = originalState.sendWorkerRequest;
      globalThis.fetch = originalState.fetch;
      restoreStorage();
    }
  });

  test("uses OpenRouter without starting local LLM warmup when proxy-first mode is enabled", async () => {
    const service = clientLLMWorkerService as unknown as TestableClientLLMWorkerService;
    const restoreStorage = installMemoryLocalStorage();
    const originalState = {
      worker: service.worker,
      isInitialized: service.isInitialized,
      isInitializing: service.isInitializing,
      currentModel: service.currentModel,
      currentDevice: service.currentDevice,
      capabilitiesKnown: service.capabilitiesKnown,
      webGPUFallbackReason: service.webGPUFallbackReason,
      openRouterFallbackDelayMs: service.openRouterFallbackDelayMs,
      openRouterLastError: service.openRouterLastError,
      openRouterLastUsedAt: service.openRouterLastUsedAt,
      lastGenerationModel: service.lastGenerationModel,
      lastGenerationProvider: service.lastGenerationProvider,
      generationCounter: service.generationCounter,
      generationWinnerId: service.generationWinnerId,
      localWarmupPromise: service.localWarmupPromise,
      capabilities: service.capabilities,
      pendingRequests: service.pendingRequests,
      requestCounter: service.requestCounter,
      sendWorkerRequest: service.sendWorkerRequest,
      fetch: globalThis.fetch,
    };
    const calls: string[] = [];

    try {
      globalThis.localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, "test-openrouter-key");
      service.worker = { terminate: () => undefined };
      service.isInitialized = false;
      service.isInitializing = false;
      service.currentModel = LLM_CONFIG.defaultModel;
      service.currentDevice = "webgpu";
      service.capabilitiesKnown = true;
      service.webGPUFallbackReason = undefined;
      service.openRouterFallbackDelayMs = 1;
      service.openRouterLastError = undefined;
      service.openRouterLastUsedAt = undefined;
      service.lastGenerationModel = LLM_CONFIG.defaultModel;
      service.lastGenerationProvider = "local";
      service.generationWinnerId = 0;
      service.localWarmupPromise = null;
      service.capabilities = {
        webGPU: true,
        webGPUShaderF16: true,
        simd: true,
        wasmThreads: true,
        crossOriginIsolated: true,
        sharedArrayBuffer: true,
      };
      service.pendingRequests = new Map();
      service.requestCounter = 0;
      service.sendWorkerRequest = async (type, data) => {
        calls.push(`${type}:${data.modelName || ""}`);
        throw new Error(`Unexpected worker request ${type}`);
      };
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            model: "liquid/lfm-2.5-1.2b-instruct:free",
            choices: [{ message: { role: "assistant", content: "remote during warmup" } }],
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );

      const text = await service.generateText("Summarize housing options.", 80);

      expect(text).toBe("remote during warmup");
  expect(calls).toEqual([]);
  expect(service.localWarmupPromise).toBeNull();
      expect(service.lastGenerationProvider).toBe("openrouter");
      expect(service.lastGenerationModel).toBe("liquid/lfm-2.5-1.2b-instruct:free");
    } finally {
      service.worker = originalState.worker;
      service.isInitialized = originalState.isInitialized;
      service.isInitializing = originalState.isInitializing;
      service.currentModel = originalState.currentModel;
      service.currentDevice = originalState.currentDevice;
      service.capabilitiesKnown = originalState.capabilitiesKnown;
      service.webGPUFallbackReason = originalState.webGPUFallbackReason;
      service.openRouterFallbackDelayMs = originalState.openRouterFallbackDelayMs;
      service.openRouterLastError = originalState.openRouterLastError;
      service.openRouterLastUsedAt = originalState.openRouterLastUsedAt;
      service.lastGenerationModel = originalState.lastGenerationModel;
      service.lastGenerationProvider = originalState.lastGenerationProvider;
      service.generationCounter = originalState.generationCounter;
      service.generationWinnerId = originalState.generationWinnerId;
      service.localWarmupPromise = originalState.localWarmupPromise;
      service.capabilities = originalState.capabilities;
      service.pendingRequests = originalState.pendingRequests;
      service.requestCounter = originalState.requestCounter;
      service.sendWorkerRequest = originalState.sendWorkerRequest;
      globalThis.fetch = originalState.fetch;
      restoreStorage();
    }
  });

  test("prefers OpenRouter for the first response without touching the local model", async () => {
    const service = clientLLMWorkerService as unknown as TestableClientLLMWorkerService;
    const restoreStorage = installMemoryLocalStorage();
    const originalState = {
      worker: service.worker,
      isInitialized: service.isInitialized,
      isInitializing: service.isInitializing,
      currentModel: service.currentModel,
      currentDevice: service.currentDevice,
      capabilitiesKnown: service.capabilitiesKnown,
      webGPUFallbackReason: service.webGPUFallbackReason,
      openRouterLastError: service.openRouterLastError,
      openRouterLastUsedAt: service.openRouterLastUsedAt,
      lastGenerationModel: service.lastGenerationModel,
      lastGenerationProvider: service.lastGenerationProvider,
      generationCounter: service.generationCounter,
      generationWinnerId: service.generationWinnerId,
      localWarmupPromise: service.localWarmupPromise,
      capabilities: service.capabilities,
      pendingRequests: service.pendingRequests,
      requestCounter: service.requestCounter,
      sendWorkerRequest: service.sendWorkerRequest,
      fetch: globalThis.fetch,
    };
    const calls: string[] = [];

    try {
      globalThis.localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, "test-openrouter-key");
      service.worker = { terminate: () => undefined };
      service.isInitialized = false;
      service.isInitializing = false;
      service.currentModel = LLM_CONFIG.defaultModel;
      service.currentDevice = "webgpu";
      service.capabilitiesKnown = true;
      service.webGPUFallbackReason = undefined;
      service.openRouterLastError = undefined;
      service.openRouterLastUsedAt = undefined;
      service.lastGenerationModel = LLM_CONFIG.defaultModel;
      service.lastGenerationProvider = "local";
      service.generationWinnerId = 0;
      service.localWarmupPromise = null;
      service.capabilities = {
        webGPU: true,
        webGPUShaderF16: true,
        simd: true,
        wasmThreads: true,
        crossOriginIsolated: true,
        sharedArrayBuffer: true,
      };
      service.pendingRequests = new Map();
      service.requestCounter = 0;
      service.sendWorkerRequest = async (type, data) => {
        calls.push(`${type}:${data.modelName || ""}`);
        if (type === "initialize") {
          service.isInitialized = true;
          return {
            isInitialized: true,
            modelName: data.modelName,
            device: "webgpu",
            capabilities: service.capabilities,
          };
        }
        if (type === "generate") {
          throw new Error("local generation should not run before OpenRouter");
        }
        throw new Error(`Unexpected worker request ${type}`);
      };
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            model: "liquid/lfm-2.5-1.2b-instruct:free",
            choices: [{ message: { role: "assistant", content: "proxy-first answer" } }],
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );

      const text = await service.generateText("Find food nearby.", 72);

      expect(text).toBe("proxy-first answer");
  expect(calls).toEqual([]);
  expect(service.localWarmupPromise).toBeNull();
      expect(service.lastGenerationProvider).toBe("openrouter");
      expect(service.lastGenerationModel).toBe("liquid/lfm-2.5-1.2b-instruct:free");
    } finally {
      service.worker = originalState.worker;
      service.isInitialized = originalState.isInitialized;
      service.isInitializing = originalState.isInitializing;
      service.currentModel = originalState.currentModel;
      service.currentDevice = originalState.currentDevice;
      service.capabilitiesKnown = originalState.capabilitiesKnown;
      service.webGPUFallbackReason = originalState.webGPUFallbackReason;
      service.openRouterLastError = originalState.openRouterLastError;
      service.openRouterLastUsedAt = originalState.openRouterLastUsedAt;
      service.lastGenerationModel = originalState.lastGenerationModel;
      service.lastGenerationProvider = originalState.lastGenerationProvider;
      service.generationCounter = originalState.generationCounter;
      service.generationWinnerId = originalState.generationWinnerId;
      service.localWarmupPromise = originalState.localWarmupPromise;
      service.capabilities = originalState.capabilities;
      service.pendingRequests = originalState.pendingRequests;
      service.requestCounter = originalState.requestCounter;
      service.sendWorkerRequest = originalState.sendWorkerRequest;
      globalThis.fetch = originalState.fetch;
      restoreStorage();
    }
  });

  test("throws the OpenRouter failure instead of falling back to local LLM when proxy-first mode is enabled", async () => {
    const service = clientLLMWorkerService as unknown as TestableClientLLMWorkerService;
    const restoreStorage = installMemoryLocalStorage();
    const originalState = {
      worker: service.worker,
      isInitialized: service.isInitialized,
      isInitializing: service.isInitializing,
      currentModel: service.currentModel,
      currentDevice: service.currentDevice,
      capabilitiesKnown: service.capabilitiesKnown,
      webGPUFallbackReason: service.webGPUFallbackReason,
      openRouterLastError: service.openRouterLastError,
      openRouterLastUsedAt: service.openRouterLastUsedAt,
      lastGenerationModel: service.lastGenerationModel,
      lastGenerationProvider: service.lastGenerationProvider,
      generationCounter: service.generationCounter,
      generationWinnerId: service.generationWinnerId,
      localWarmupPromise: service.localWarmupPromise,
      capabilities: service.capabilities,
      pendingRequests: service.pendingRequests,
      requestCounter: service.requestCounter,
      sendWorkerRequest: service.sendWorkerRequest,
      fetch: globalThis.fetch,
    };
    const calls: string[] = [];

    try {
      globalThis.localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, "test-openrouter-key");
      service.worker = { terminate: () => undefined };
      service.isInitialized = false;
      service.isInitializing = false;
      service.currentModel = LLM_CONFIG.defaultModel;
      service.currentDevice = "webgpu";
      service.capabilitiesKnown = true;
      service.webGPUFallbackReason = undefined;
      service.openRouterLastError = undefined;
      service.openRouterLastUsedAt = undefined;
      service.lastGenerationModel = LLM_CONFIG.defaultModel;
      service.lastGenerationProvider = "local";
      service.generationWinnerId = 0;
      service.localWarmupPromise = null;
      service.capabilities = {
        webGPU: true,
        webGPUShaderF16: true,
        simd: true,
        wasmThreads: true,
        crossOriginIsolated: true,
        sharedArrayBuffer: true,
      };
      service.pendingRequests = new Map();
      service.requestCounter = 0;
      service.sendWorkerRequest = async (type) => {
        calls.push(type);
        throw new Error("local worker should stay idle");
      };
      globalThis.fetch = async () => new Response("proxy failed", { headers: { "Content-Type": "text/plain" }, status: 502 });

      await expect(service.generateText("Need housing help.", 72)).rejects.toThrow(/OpenRouter request failed with 502/i);

      expect(calls).toEqual([]);
      expect(service.openRouterLastError).toMatch(/502/);
    } finally {
      service.worker = originalState.worker;
      service.isInitialized = originalState.isInitialized;
      service.isInitializing = originalState.isInitializing;
      service.currentModel = originalState.currentModel;
      service.currentDevice = originalState.currentDevice;
      service.capabilitiesKnown = originalState.capabilitiesKnown;
      service.webGPUFallbackReason = originalState.webGPUFallbackReason;
      service.openRouterLastError = originalState.openRouterLastError;
      service.openRouterLastUsedAt = originalState.openRouterLastUsedAt;
      service.lastGenerationModel = originalState.lastGenerationModel;
      service.lastGenerationProvider = originalState.lastGenerationProvider;
      service.generationCounter = originalState.generationCounter;
      service.generationWinnerId = originalState.generationWinnerId;
      service.localWarmupPromise = originalState.localWarmupPromise;
      service.capabilities = originalState.capabilities;
      service.pendingRequests = originalState.pendingRequests;
      service.requestCounter = originalState.requestCounter;
      service.sendWorkerRequest = originalState.sendWorkerRequest;
      globalThis.fetch = originalState.fetch;
      restoreStorage();
    }
  });

  test("restarts the LLM worker before using WASM fallback after WebGPU runtime failure", async () => {
    const service = clientLLMWorkerService as unknown as TestableClientLLMWorkerService;
    const originalState = {
      worker: service.worker,
      isInitialized: service.isInitialized,
      isInitializing: service.isInitializing,
      currentModel: service.currentModel,
      currentDevice: service.currentDevice,
      capabilitiesKnown: service.capabilitiesKnown,
      webGPUFallbackReason: service.webGPUFallbackReason,
      openRouterLastError: service.openRouterLastError,
      openRouterLastUsedAt: service.openRouterLastUsedAt,
      lastGenerationModel: service.lastGenerationModel,
      lastGenerationProvider: service.lastGenerationProvider,
      generationCounter: service.generationCounter,
      generationWinnerId: service.generationWinnerId,
      capabilities: service.capabilities,
      pendingRequests: service.pendingRequests,
      requestCounter: service.requestCounter,
      initializeWorker: service.initializeWorker,
      sendWorkerRequest: service.sendWorkerRequest,
      consoleWarn: console.warn,
    };
    const calls: string[] = [];
    const baseCapabilities: TestLlmCapabilities = {
      webGPU: true,
      webGPUShaderF16: false,
      simd: true,
      wasmThreads: true,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    };

    try {
      console.warn = () => undefined;
      service.worker = { terminate: () => calls.push("terminate") };
      service.isInitialized = false;
      service.isInitializing = false;
      service.currentModel = LLM_CONFIG.defaultModel;
      service.currentDevice = "webgpu";
      service.capabilitiesKnown = true;
      service.webGPUFallbackReason = undefined;
      service.openRouterLastError = undefined;
      service.openRouterLastUsedAt = undefined;
      service.lastGenerationModel = LLM_CONFIG.defaultModel;
      service.lastGenerationProvider = "local";
      service.generationWinnerId = 0;
      service.capabilities = baseCapabilities;
      service.pendingRequests = new Map();
      service.requestCounter = 0;
      service.initializeWorker = () => {
        calls.push("initializeWorker");
        service.worker = { terminate: () => calls.push("terminate-fallback") };
      };
      service.sendWorkerRequest = async (type, data) => {
        calls.push(`${type}:${data.modelName || ""}`);
        if (type === "initialize" && data.modelName === LLM_CONFIG.defaultModel) {
          throw new Error(`${WORKER_RESTART_REQUIRED_PREFIX}WebGPU execution failed for test model.`);
        }
        if (type === "initialize" && data.modelName === LLM_CONFIG.fallbackModel) {
          return {
            isInitialized: true,
            modelName: LLM_CONFIG.fallbackModel,
            device: "wasm",
            capabilities: baseCapabilities,
          };
        }
        if (type === "getCapabilities") {
          return {
            isInitialized: true,
            modelName: LLM_CONFIG.fallbackModel,
            device: "wasm",
            capabilities: baseCapabilities,
          };
        }
        throw new Error(`Unexpected worker request ${type}`);
      };

      await service.initialize(LLM_CONFIG.defaultModel);
      const status = service.getStatus();
      const capabilities = await service.getCapabilities();

      expect(calls).toEqual([
        `initialize:${LLM_CONFIG.defaultModel}`,
        "terminate",
        "initializeWorker",
        `initialize:${LLM_CONFIG.fallbackModel}`,
        "getCapabilities:",
      ]);
      expect(status).toMatchObject({
        currentModel: LLM_CONFIG.fallbackModel,
        currentDevice: "wasm",
        isInitialized: true,
      });
      expect(status.capabilities.webGPUError).toContain("WebGPU execution failed");
      expect(capabilities.capabilities?.webGPUError).toContain("WebGPU execution failed");

      calls.length = 0;
      await service.switchModel("onnx-community/Llama-3.2-1B-Instruct-ONNX");
      expect(calls).toEqual([]);
      expect(service.getStatus()).toMatchObject({
        currentModel: LLM_CONFIG.fallbackModel,
        currentDevice: "wasm",
        isInitialized: true,
      });
    } finally {
      service.worker = originalState.worker;
      service.isInitialized = originalState.isInitialized;
      service.isInitializing = originalState.isInitializing;
      service.currentModel = originalState.currentModel;
      service.currentDevice = originalState.currentDevice;
      service.capabilitiesKnown = originalState.capabilitiesKnown;
      service.webGPUFallbackReason = originalState.webGPUFallbackReason;
      service.openRouterLastError = originalState.openRouterLastError;
      service.openRouterLastUsedAt = originalState.openRouterLastUsedAt;
      service.lastGenerationModel = originalState.lastGenerationModel;
      service.lastGenerationProvider = originalState.lastGenerationProvider;
      service.generationCounter = originalState.generationCounter;
      service.generationWinnerId = originalState.generationWinnerId;
      service.capabilities = originalState.capabilities;
      service.pendingRequests = originalState.pendingRequests;
      service.requestCounter = originalState.requestCounter;
      service.initializeWorker = originalState.initializeWorker;
      service.sendWorkerRequest = originalState.sendWorkerRequest;
      console.warn = originalState.consoleWarn;
    }
  });
});
