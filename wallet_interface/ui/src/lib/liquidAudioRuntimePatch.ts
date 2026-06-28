export interface LiquidAudioRuntimePatchUrls {
  audioProcessorUrl: string;
  ortWrapperUrl: string;
  transformersWebModuleUrl: string;
}

export interface TransformersRuntimePatchUrls {
  ortWrapperUrl: string;
}

export type LiquidAudioProgressPhase =
  | "queued"
  | "loading-runtime"
  | "downloading-model"
  | "warming-up"
  | "ready"
  | "generating"
  | "decoding";

export interface LiquidAudioWorkerProgress {
  phase: LiquidAudioProgressPhase;
  progress: number;
  status: string;
  file?: string;
  modelName?: string;
}

export interface LiquidAudioRunnerPatchDiagnostic {
  key: string;
  label: string;
  present: boolean;
}

const RUNNER_PATCH_PATTERNS = [
  {
    key: "onnxruntimeImport",
    label: "ONNX Runtime import",
    pattern: /import\s+\*\s+as\s+ort\s+from\s+['"]onnxruntime-web['"];?/,
    replacement: (urls: LiquidAudioRuntimePatchUrls) => `import * as ort from ${JSON.stringify(urls.ortWrapperUrl)};`,
  },
  {
    key: "transformersImport",
    label: "Transformers.js import",
    pattern: /import\s+\{\s*AutoTokenizer,\s*env\s*\}\s+from\s+['"]@huggingface\/transformers['"];?/,
    replacement: (urls: LiquidAudioRuntimePatchUrls) =>
      `import { AutoTokenizer, env } from ${JSON.stringify(urls.transformersWebModuleUrl)};`,
  },
  {
    key: "audioProcessorImport",
    label: "audio processor import",
    pattern:
      /import\s+\{\s*loadMelConfig,\s*computeMelSpectrogram,\s*loadAudioFile\s*\}\s+from\s+['"]\.\/audio-processor\.js['"];?/,
    replacement: (urls: LiquidAudioRuntimePatchUrls) =>
      `import { loadMelConfig, computeMelSpectrogram, loadAudioFile } from ${JSON.stringify(urls.audioProcessorUrl)};`,
  },
  {
    key: "loadOptions",
    label: "AudioModel.load options destructuring",
    pattern:
      /const\s+\{\s*progressCallback,\s*device\s*=\s*['"]webgpu['"],\s*quantization\s*=\s*null\s*\}\s*=\s*options;?/,
    replacement: () =>
      "const { progressCallback, device = 'webgpu', quantization = null, loadAudioEncoder = true } = options;",
  },
  {
    key: "audioEncoderLoad",
    label: "audio encoder session load",
    pattern:
      /this\.audioEncoderSession\s*=\s*await\s+loadOnnxWithExternalData\(['"]audio_encoder['"],\s*50,\s*quantConfig\.audioEncoder\);?/,
    replacement: () =>
      "if (loadAudioEncoder) { this.audioEncoderSession = await loadOnnxWithExternalData('audio_encoder', 50, quantConfig.audioEncoder); }",
  },
  {
    key: "dynamicSessionMemoryPattern",
    label: "dynamic-shape ONNX session memory pattern",
    pattern: /const\s+sessionOptions\s*=\s*\{\s*executionProviders,\s*\.\.\.extraOptions\s*\};?/,
    replacement: () =>
      "const sessionOptions = { executionProviders, enableMemPattern: false, ...extraOptions };",
  },
  {
    key: "vocoderDynamicOutputLocation",
    label: "vocoder WASM execution provider",
    pattern:
      /const\s+vocoderOpts\s*=\s*device\s*===\s*['"]webgpu['"]\s*\?\s*\{\s*preferredOutputLocation\s*:\s*\{\s*new_keys\s*:\s*['"]gpu-buffer['"]\s*,\s*new_values\s*:\s*['"]gpu-buffer['"]\s*,\s*depth_slices\s*:\s*['"]gpu-buffer['"]\s*\}\s*\}\s*:\s*\{\s*\};?/,
    replacement: () =>
      "const vocoderOpts = { executionProviders: ['wasm'], enableMemPattern: false }; // The vocoder grows KV-cache tensors every frame; keep that dynamic stage off WebGPU to avoid output-buffer shape reuse failures.",
  },
  {
    key: "tokenizerEnvFetchCapture",
    label: "Transformers.js env.fetch tokenizer override capture",
    pattern: /const\s+originalFetch\s*=\s*globalThis\.fetch;\s*globalThis\.fetch\s*=/,
    replacement: () => "const originalFetch = globalThis.fetch;\n  const originalEnvFetch = env.fetch;\n  globalThis.fetch =",
  },
  {
    key: "tokenizerEnvFetchOverride",
    label: "Transformers.js env.fetch tokenizer override install",
    pattern: /const\s+originalAllowLocal\s*=\s*env\.allowLocalModels;/,
    replacement: () => "env.fetch = globalThis.fetch;\n  const originalAllowLocal = env.allowLocalModels;",
  },
  {
    key: "tokenizerEnvFetchRestore",
    label: "Transformers.js env.fetch tokenizer override restore",
    pattern: /globalThis\.fetch\s*=\s*originalFetch;\s*env\.allowLocalModels\s*=\s*originalAllowLocal;/,
    replacement: () => "globalThis.fetch = originalFetch;\n    env.fetch = originalEnvFetch;\n    env.allowLocalModels = originalAllowLocal;",
  },
] as const;

const TRANSFORMERS_ONNX_RUNTIME_IMPORT_PATTERN =
  /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]onnxruntime-web(?:\/webgpu)?['"];?/;
const TRANSFORMERS_ONNX_COMMON_NAMESPACE_IMPORT_PATTERN =
  /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]onnxruntime-common['"];?/g;
const TRANSFORMERS_ONNX_COMMON_NAMED_IMPORT_PATTERN =
  /import\s*\{\s*([^}]+?)\s*\}\s*from\s*['"]onnxruntime-common['"];?/g;
const TRANSFORMERS_BARE_ONNX_IMPORT_PATTERN =
  /\bfrom\s*['"]onnxruntime-(?:common|web(?:\/webgpu)?)['"]/;

export function getLiquidAudioRunnerPatchDiagnostics(source: string): LiquidAudioRunnerPatchDiagnostic[] {
  return RUNNER_PATCH_PATTERNS.map((rule) => ({
    key: rule.key,
    label: rule.label,
    present: rule.pattern.test(source),
  }));
}

export function assertLiquidAudioRunnerPatchable(source: string): void {
  const missing = getLiquidAudioRunnerPatchDiagnostics(source).filter((diagnostic) => !diagnostic.present);
  if (!missing.length) return;
  throw new Error(
    `LiquidAI audio runner patch failed; missing ${missing.map((diagnostic) => diagnostic.label).join(", ")}. ` +
      "The upstream LiquidAI demo runner may have changed.",
  );
}

export function patchTransformersWebSource(source: string, urls: TransformersRuntimePatchUrls): string {
  const runtimeImportMatch = source.match(TRANSFORMERS_ONNX_RUNTIME_IMPORT_PATTERN);
  if (!runtimeImportMatch) {
    throw new Error("Transformers.js WebGPU runtime patch failed; missing ONNX Runtime WebGPU import.");
  }

  const patched = source
    .replace(
      TRANSFORMERS_ONNX_RUNTIME_IMPORT_PATTERN,
      (_match, runtimeBinding: string) => `import * as ${runtimeBinding} from ${JSON.stringify(urls.ortWrapperUrl)};`,
    )
    .replace(
      TRANSFORMERS_ONNX_COMMON_NAMESPACE_IMPORT_PATTERN,
      (_match, commonBinding: string) => `import * as ${commonBinding} from ${JSON.stringify(urls.ortWrapperUrl)};`,
    )
    .replace(
      TRANSFORMERS_ONNX_COMMON_NAMED_IMPORT_PATTERN,
      (_match, namedImports: string) => `import { ${namedImports.trim()} } from ${JSON.stringify(urls.ortWrapperUrl)};`,
    );

  if (TRANSFORMERS_BARE_ONNX_IMPORT_PATTERN.test(patched)) {
    throw new Error("Transformers.js WebGPU runtime patch failed; unresolved bare ONNX Runtime import remains.");
  }

  return patched;
}

export function patchAudioModelSource(source: string, urls: LiquidAudioRuntimePatchUrls): string {
  assertLiquidAudioRunnerPatchable(source);
  const patched = RUNNER_PATCH_PATTERNS.reduce(
    (current, rule) => current.replace(rule.pattern, rule.replacement(urls)),
    source,
  );

  return `// Runtime-patched from LiquidAI/LFM2.5-Audio-1.5B-transformers-js.
${patched}`;
}

export function formatLiquidAudioLoadProgress(
  progress: { status: string; progress: number; file?: string },
  modelName: string,
): LiquidAudioWorkerProgress {
  const rawProgress = Number.isFinite(progress.progress) ? progress.progress : 0;
  const normalizedProgress = rawProgress <= 1 ? rawProgress * 100 : rawProgress;
  const scaledProgress = 15 + normalizedProgress * 0.7;
  const fileDetail = progress.file ? ` ${progress.file}` : "";
  return {
    phase: "downloading-model",
    progress: clampAudioProgress(scaledProgress),
    status: `Downloading audio model${fileDetail}.`,
    file: progress.file,
    modelName,
  };
}

export function clampAudioProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
