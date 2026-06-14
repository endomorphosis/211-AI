import ortWebGpuModuleUrl from "../../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs?url";
import ortWasmAsyncifyWasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import { AUDIO_CHAT_CONFIG, getClientAudioModelInfo } from "../lib/audioChatConfig";
import {
  clampAudioProgress,
  formatLiquidAudioLoadProgress,
  patchAudioModelSource,
  patchTransformersWebSource,
  type LiquidAudioWorkerProgress as AudioWorkerProgress,
} from "../lib/liquidAudioRuntimePatch";
import { getSafeOnnxWasmThreadCount, installWarningSuppression } from "../lib/warningSuppressionUtils";

installWarningSuppression();

const transformersWebModuleUrl = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.js";

type AudioWorkerRequest = {
  id: string;
  type: "generateAudio" | "generateVoiceReply" | "warmUp";
  data: {
    text?: string;
    fallbackText?: string;
    modelName?: string;
  };
};

interface AudioWorkerResponse {
  id: string;
  type?: "progress";
  success: boolean;
  data?: {
    audioBlob?: Blob;
    mimeType?: string;
    modelName?: string;
    provider?: "local-liquidai";
    text?: string;
  };
  error?: string;
}

let audioModel: LiquidAudioModel | null = null;
let currentModelName = AUDIO_CHAT_CONFIG.defaultModel;
let initializePromise: Promise<void> | null = null;
let requestChain: Promise<void> = Promise.resolve();
let liquidAudioRuntimePromise: Promise<LiquidAudioRuntime> | null = null;
const DEFAULT_VOICE_FALLBACK_TEXT = "I found an answer, but local voice generation could not infer a spoken reply.";
const TTS_SYSTEM_PROMPT = "Perform TTS. Use the UK female voice.";
const INTERLEAVED_SYSTEM_PROMPT =
  "You are Abby voice. Answer naturally using the user's app context and evidence. Do not read raw prompt labels, URLs, CIDs, or citation IDs aloud.";

interface LiquidAudioRuntime {
  AudioModel: new () => LiquidAudioModel;
  revoke: () => void;
}

interface LiquidAudioModel {
  load: (
    modelPath: string,
    options: {
      device: "webgpu";
      quantization: {
        decoder: "q4";
        audioEncoder: "q4";
        audioEmbedding: "q4";
        audioDetokenizer: "q4";
        vocoder: "q4";
      };
      loadAudioEncoder?: boolean;
      progressCallback?: (progress: { status: string; progress: number; file?: string }) => void;
    },
  ) => Promise<boolean>;
  generateSpeech: (
    text: string,
    options: {
      maxNewTokens: number;
      systemPrompt: string;
      textTemperature: number;
      audioTemperature: number;
      audioTopK: number;
      onAudioFrame?: (frame: number[], count: number) => void;
      onToken?: (token: string, tokenId: number) => boolean | void;
    },
  ) => Promise<{ audioCodes: number[][]; textOutput?: string }>;
  generateInterleavedFromText?: (
    text: string,
    options: {
      maxNewTokens: number;
      systemPrompt: string;
      textTemperature: number;
      audioTemperature: number;
      audioTopK: number;
      onAudioFrame?: (frame: number[], count: number) => void;
      onToken?: (token: string, tokenId: number) => boolean | void;
    },
  ) => Promise<{ audioCodes?: number[][]; text?: string }>;
  decodeAudioCodes: (audioCodes: number[][]) => Promise<Float32Array>;
  reset?: () => void;
}

interface LiquidAudioGeneration {
  audioCodes?: number[][];
  text?: string;
  textOutput?: string;
}

self.onmessage = (event: MessageEvent<AudioWorkerRequest>) => {
  const request = event.data;
  requestChain = requestChain.then(
    () => handleWorkerRequest(request),
    () => handleWorkerRequest(request),
  );
};

async function handleWorkerRequest(request: AudioWorkerRequest): Promise<void> {
  try {
    if (request.type !== "generateAudio" && request.type !== "generateVoiceReply" && request.type !== "warmUp") {
      throw new Error(`Unknown audio worker request: ${request.type}`);
    }

    const modelName = request.data.modelName || AUDIO_CHAT_CONFIG.defaultModel;
    postProgress(request.id, {
      phase: "queued",
      progress: 0,
      status: "Preparing LiquidAI audio model.",
      modelName,
    });
    const model = await initialize(modelName, (progress) => postProgress(request.id, progress));
    if (request.type === "warmUp") {
      postResponse({
        id: request.id,
        success: true,
        data: {
          modelName: currentModelName,
          provider: "local-liquidai",
        },
      });
      return;
    }

    const text = request.data.text?.trim();
    if (!text) {
      throw new Error("Audio generation text is empty.");
    }
    postProgress(request.id, {
      phase: "generating",
      progress: 90,
      status: request.type === "generateVoiceReply" ? "Generating voice reply with evidence." : "Generating speech audio.",
      modelName,
    });
    const maxAudioFrames = AUDIO_CHAT_CONFIG.maxAudioFrames;
    let generatedText = "";
    const generationStatus = request.type === "generateVoiceReply" ? "Generating voice reply" : "Generating speech audio";
    const audioProgress = (_frame: number[], count: number) => {
      if (count !== 1 && count % 4 !== 0) return;
      postProgress(request.id, {
        phase: "generating",
        progress: 90 + Math.min(6, (count / Math.max(1, maxAudioFrames)) * 6),
        status: `${generationStatus} (${count} frames).`,
        modelName,
      });
    };
    const tokenProgress = (token: string) => {
      generatedText = token;
    };
    const generation: LiquidAudioGeneration = request.type === "generateVoiceReply" && model.generateInterleavedFromText
      ? await generateVoiceReplyWithAudioFallback(model, text, getWorkerFallbackSpeechText(request), {
          maxAudioFrames,
          onAudioFrame: audioProgress,
          onToken: tokenProgress,
        })
      : await generateSpeechAudio(model, request.type === "generateVoiceReply" ? getWorkerFallbackSpeechText(request) : text, {
          maxAudioFrames,
          onAudioFrame: audioProgress,
        });
    const audioCodes = generation.audioCodes || [];
    if (!audioCodes.length) {
      throw new Error("LiquidAI audio model completed without audio frames.");
    }
    postProgress(request.id, {
      phase: "decoding",
      progress: 97,
      status: "Decoding generated audio.",
      modelName,
    });
    const waveform = await model.decodeAudioCodes(audioCodes);
    const audioBlob = createWavBlob(waveform, 24000);
    postProgress(request.id, {
      phase: "ready",
      progress: 100,
      status: "Audio reply ready.",
      modelName,
    });
    postResponse({
      id: request.id,
      success: true,
      data: {
        audioBlob,
        mimeType: audioBlob.type || "audio/wav",
        modelName: currentModelName,
        provider: "local-liquidai",
        text: normalizeGeneratedText(generation.text || generation.textOutput || generatedText),
      },
    });
  } catch (error) {
    postResponse({
      id: request.id,
      success: false,
      error: error instanceof Error ? error.message : "Audio worker failed",
    });
  }
}

async function generateVoiceReplyWithAudioFallback(
  model: LiquidAudioModel,
  text: string,
  fallbackText: string,
  options: {
    maxAudioFrames: number;
    onAudioFrame?: (frame: number[], count: number) => void;
    onToken?: (token: string, tokenId: number) => boolean | void;
  },
): Promise<{ audioCodes?: number[][]; text?: string; textOutput?: string }> {
  if (!model.generateInterleavedFromText) {
    throw new Error("LiquidAI interleaved text-to-audio generation is unavailable.");
  }
  model.reset?.();
  try {
    const generation = await model.generateInterleavedFromText(text, {
      maxNewTokens: options.maxAudioFrames,
      systemPrompt: INTERLEAVED_SYSTEM_PROMPT,
      textTemperature: 0.7,
      audioTemperature: 0.8,
      audioTopK: 64,
      onAudioFrame: options.onAudioFrame,
      onToken: options.onToken,
    });
    if (generation.audioCodes?.length) {
      return generation;
    }
    const inferredText = normalizeGeneratedText(generation.text) || fallbackText;
    const speech = await generateSpeechAudio(model, inferredText, options);
    return {
      ...speech,
      text: inferredText,
    };
  } catch (error) {
    console.warn("[AudioWorker] Interleaved voice generation failed; speaking sanitized fallback text.", error);
    model.reset?.();
    const speech = await generateSpeechAudio(model, fallbackText, options);
    return {
      ...speech,
      text: fallbackText,
    };
  }
}

async function generateSpeechAudio(
  model: LiquidAudioModel,
  text: string,
  options: {
    maxAudioFrames: number;
    onAudioFrame?: (frame: number[], count: number) => void;
  },
): Promise<LiquidAudioGeneration> {
  const normalizedText = text.trim() || DEFAULT_VOICE_FALLBACK_TEXT;
  return model.generateSpeech(normalizedText, {
    maxNewTokens: options.maxAudioFrames,
    systemPrompt: TTS_SYSTEM_PROMPT,
    textTemperature: 0.7,
    audioTemperature: 0.8,
    audioTopK: 64,
    onAudioFrame: options.onAudioFrame,
  });
}

async function initialize(modelName: string, onProgress: (progress: AudioWorkerProgress) => void): Promise<LiquidAudioModel> {
  if (audioModel && currentModelName === modelName) {
    onProgress({
      phase: "ready",
      progress: 100,
      status: "Audio model ready.",
      modelName,
    });
    return audioModel;
  }
  if (initializePromise) {
    onProgress({
      phase: "warming-up",
      progress: 5,
      status: "Waiting for the audio model to finish warming up.",
      modelName,
    });
    await initializePromise;
    if (audioModel && currentModelName === modelName) {
      onProgress({
        phase: "ready",
        progress: 100,
        status: "Audio model ready.",
        modelName,
      });
      return audioModel;
    }
  }
  initializePromise = initializePipeline(modelName, onProgress);
  try {
    await initializePromise;
  } finally {
    initializePromise = null;
  }
  if (!audioModel) {
    throw new Error("LiquidAI audio model did not initialize.");
  }
  return audioModel;
}

async function initializePipeline(modelName: string, onProgress: (progress: AudioWorkerProgress) => void): Promise<void> {
  const modelInfo = getClientAudioModelInfo(modelName);
  if (!modelInfo) {
    throw new Error(`Unsupported audio chat model: ${modelName}`);
  }
  if (!hasWebGPU()) {
    throw new Error(`${modelInfo.name} requires browser WebGPU for local audio generation.`);
  }

  onProgress({
    phase: "loading-runtime",
    progress: 3,
    status: "Loading LiquidAI audio runtime.",
    modelName,
  });
  const runtime = await loadLiquidAudioRuntime();
  onProgress({
    phase: "warming-up",
    progress: 12,
    status: "Starting local audio model.",
    modelName,
  });
  const model = new runtime.AudioModel();
  await model.load(`https://huggingface.co/${modelName}/resolve/main`, {
    device: "webgpu",
    quantization: {
      decoder: "q4",
      audioEncoder: "q4",
      audioEmbedding: "q4",
      audioDetokenizer: "q4",
      vocoder: "q4",
    },
    loadAudioEncoder: false,
    progressCallback: (progress) => {
      console.info("[AudioWorker] LiquidAI audio load", progress);
      onProgress(formatLiquidAudioLoadProgress(progress, modelName));
    },
  });
  onProgress({
    phase: "ready",
    progress: 100,
    status: "Audio model ready.",
    modelName,
  });
  audioModel = model;
  currentModelName = modelName;
}

async function loadLiquidAudioRuntime(): Promise<LiquidAudioRuntime> {
  if (liquidAudioRuntimePromise) {
    return liquidAudioRuntimePromise;
  }
  liquidAudioRuntimePromise = createLiquidAudioRuntime().catch((error) => {
    liquidAudioRuntimePromise = null;
    throw error;
  });
  return liquidAudioRuntimePromise;
}

async function createLiquidAudioRuntime(): Promise<LiquidAudioRuntime> {
  const [audioModelSource, audioProcessorSource] = await Promise.all([
    fetchRunnerSource("audio-model.js"),
    fetchRunnerSource("audio-processor.js"),
  ]);
  const ortWrapperUrl = URL.createObjectURL(
    new Blob(
      [
        `import * as actual from ${JSON.stringify(ortWebGpuModuleUrl)};
actual.env.logLevel = "error";
actual.env.wasm.numThreads = ${JSON.stringify(getSafeOnnxWasmThreadCount(8))};
actual.env.wasm.wasmPaths = { wasm: ${JSON.stringify(ortWasmAsyncifyWasmUrl)} };
actual.env.webgpu.powerPreference = "high-performance";
actual.env.webgpu.forceFallbackAdapter = false;
export * from ${JSON.stringify(ortWebGpuModuleUrl)};
export default actual.default ?? actual;
`,
      ],
      { type: "text/javascript" },
    ),
  );
  const transformersWrapperUrl = URL.createObjectURL(
    new Blob([patchTransformersWebSource(await fetchModuleSource(transformersWebModuleUrl), { ortWrapperUrl })], {
      type: "text/javascript",
    }),
  );
  const audioProcessorUrl = URL.createObjectURL(
    new Blob([audioProcessorSource], { type: "text/javascript" }),
  );
  const patchedAudioModelSource = patchAudioModelSource(audioModelSource, {
    audioProcessorUrl,
    ortWrapperUrl,
    transformersWebModuleUrl: transformersWrapperUrl,
  });
  const audioModelUrl = URL.createObjectURL(
    new Blob([patchedAudioModelSource], { type: "text/javascript" }),
  );
  try {
    const module = (await import(/* @vite-ignore */ audioModelUrl)) as { AudioModel?: new () => LiquidAudioModel };
    if (!module.AudioModel) {
      throw new Error("LiquidAI audio runner did not export AudioModel.");
    }
    return {
      AudioModel: module.AudioModel,
      revoke: () => {
        URL.revokeObjectURL(audioModelUrl);
        URL.revokeObjectURL(audioProcessorUrl);
        URL.revokeObjectURL(ortWrapperUrl);
        URL.revokeObjectURL(transformersWrapperUrl);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(audioModelUrl);
    URL.revokeObjectURL(audioProcessorUrl);
    URL.revokeObjectURL(ortWrapperUrl);
    URL.revokeObjectURL(transformersWrapperUrl);
    throw error;
  }
}

async function fetchModuleSource(url: string): Promise<string> {
  const response = await fetch(url, {
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch bundled module for runtime patching: ${response.status}`);
  }
  return response.text();
}

async function fetchRunnerSource(fileName: "audio-model.js" | "audio-processor.js"): Promise<string> {
  const response = await fetch(`${AUDIO_CHAT_CONFIG.liquidAudioRunnerBaseUrl}/${fileName}`, {
    mode: "cors",
    credentials: "omit",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch LiquidAI audio runner ${fileName}: ${response.status}`);
  }
  return response.text();
}

function createWavBlob(samples: Float32Array, sampleRate: number): Blob {
  if (!samples.length) {
    throw new Error("LiquidAI audio model decoded an empty waveform.");
  }
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const rawSample = samples[index];
    const sample = Number.isFinite(rawSample) ? Math.max(-1, Math.min(1, rawSample)) : 0;
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function hasWebGPU(): boolean {
  return AUDIO_CHAT_CONFIG.enableWebGPU && typeof navigator !== "undefined" && Boolean((navigator as { gpu?: unknown }).gpu);
}

function normalizeGeneratedText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function getWorkerFallbackSpeechText(request: AudioWorkerRequest): string {
  if (request.type !== "generateVoiceReply") return request.data.text?.trim() || "";
  return request.data.fallbackText?.trim() || DEFAULT_VOICE_FALLBACK_TEXT;
}

function postProgress(id: string, progress: AudioWorkerProgress): void {
  self.postMessage({
    id,
    type: "progress",
    progress: {
      ...progress,
      progress: clampAudioProgress(progress.progress),
    },
    success: false,
  });
}

function postResponse(response: AudioWorkerResponse): void {
  self.postMessage(response);
}
