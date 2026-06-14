export interface BackendCapabilities {
  webnn: boolean;
  webgpu: boolean;
  wasm: boolean;
  webgl: boolean;
  simd: boolean;
  threads: boolean;
}

export type BrowserMlBackend = "webgpu" | "webnn" | "wasm" | "javascript";

export interface BackendBenchmarkResult {
  backend: BrowserMlBackend;
  supported: boolean;
  durationMs: number;
  operations: number;
  gflops: number;
  note?: string;
}

export interface BackendDetectionOptions {
  benchmark?: boolean;
  benchmarkDurationMs?: number;
  forceRefresh?: boolean;
}

export interface BackendDeviceInfo {
  userAgent: string;
  hardwareConcurrency: number;
  deviceMemory?: number;
  crossOriginIsolated: boolean;
}

export interface BackendDetectionResult {
  capabilities: BackendCapabilities;
  recommendedBackend: BrowserMlBackend;
  deviceInfo: BackendDeviceInfo;
  benchmarks: BackendBenchmarkResult[];
}

let detectionPromise: Promise<BackendDetectionResult> | null = null;

export async function detectBrowserMlBackends(options: BackendDetectionOptions = {}): Promise<BackendDetectionResult> {
  const shouldBenchmark = Boolean(options.benchmark);
  const baseDetection = await getBaseDetection(options.forceRefresh);
  if (!shouldBenchmark) {
    return baseDetection;
  }

  return {
    ...baseDetection,
    benchmarks: await benchmarkBrowserMlBackends(baseDetection.capabilities, options),
  };
}

export async function benchmarkBrowserMlBackends(
  capabilities?: BackendCapabilities,
  options: Pick<BackendDetectionOptions, "benchmarkDurationMs"> = {},
): Promise<BackendBenchmarkResult[]> {
  const detectedCapabilities = capabilities || (await detectBrowserMlBackends()).capabilities;
  const benchmarkDurationMs = Math.max(25, Math.min(options.benchmarkDurationMs || 80, 500));
  const benchmarks: BackendBenchmarkResult[] = [];

  if (detectedCapabilities.webgpu) {
    benchmarks.push(await benchmarkWebGpu(benchmarkDurationMs));
  }

  if (detectedCapabilities.wasm) {
    benchmarks.push(benchmarkFloat32Loop("wasm", benchmarkDurationMs));
  }

  benchmarks.push(benchmarkFloat32Loop("javascript", benchmarkDurationMs));
  return benchmarks;
}

async function getBaseDetection(forceRefresh = false): Promise<BackendDetectionResult> {
  if (forceRefresh || !detectionPromise) {
    detectionPromise = detectBackends();
  }
  return detectionPromise;
}

async function detectBackends(): Promise<BackendDetectionResult> {
  const capabilities: BackendCapabilities = {
    webnn: detectWebNN(),
    webgpu: await detectWebGPU(),
    wasm: detectWasm(),
    webgl: detectWebGL(),
    simd: detectWasmSimd(),
    threads: detectWasmThreads(),
  };

  return {
    capabilities,
    recommendedBackend: recommendBackend(capabilities),
    deviceInfo: getDeviceInfo(),
    benchmarks: [],
  };
}

function detectWebNN(): boolean {
  return typeof navigator !== "undefined" && "ml" in navigator;
}

async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = getGpuNavigator();
    if (!gpu?.requestAdapter) {
      return false;
    }
    const adapter =
      (await gpu.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false })) ||
      (await gpu.requestAdapter());
    if (!adapter) {
      return false;
    }
    const device = await adapter.requestDevice();
    device.destroy?.();
    return true;
  } catch {
    return false;
  }
}

function detectWasm(): boolean {
  return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}

function detectWebGL(): boolean {
  try {
    const canvas = createCanvas();
    if (!canvas) {
      return false;
    }
    const canvasContext = canvas as { getContext: (contextId: string) => unknown };
    return Boolean(canvasContext.getContext("webgl") || canvasContext.getContext("experimental-webgl"));
  } catch {
    return false;
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

function detectWasmThreads(): boolean {
  try {
    return (
      typeof SharedArrayBuffer !== "undefined" &&
      typeof Worker !== "undefined" &&
      Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)
    );
  } catch {
    return false;
  }
}

function recommendBackend(capabilities: BackendCapabilities): BrowserMlBackend {
  if (capabilities.webgpu) {
    return "webgpu";
  }
  if (capabilities.webnn) {
    return "webnn";
  }
  if (capabilities.wasm) {
    return "wasm";
  }
  return "javascript";
}

function getDeviceInfo(): BackendDeviceInfo {
  const currentNavigator = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    userAgent: currentNavigator?.userAgent || "unknown",
    hardwareConcurrency: currentNavigator?.hardwareConcurrency || 1,
    deviceMemory: (currentNavigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory,
    crossOriginIsolated: Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated),
  };
}

function getGpuNavigator():
  | {
      requestAdapter: (options?: unknown) => Promise<{
        requestDevice: () => Promise<{ destroy?: () => void }>;
      } | null>;
    }
  | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  return (navigator as Navigator & { gpu?: { requestAdapter: (options?: unknown) => Promise<any> } }).gpu;
}

function createCanvas(): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== "undefined") {
    return document.createElement("canvas");
  }
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(1, 1);
  }
  return null;
}

function benchmarkFloat32Loop(backend: BrowserMlBackend, targetDurationMs: number): BackendBenchmarkResult {
  const size = 32_768;
  const left = new Float32Array(size);
  const right = new Float32Array(size);
  const output = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    left[index] = (index % 97) / 97;
    right[index] = (index % 89) / 89;
    output[index] = 0.001;
  }

  const startedAt = now();
  let operations = 0;
  let elapsedMs = 0;
  do {
    for (let index = 0; index < size; index += 1) {
      output[index] = output[index] + left[index] * right[index];
    }
    operations += size * 2;
    elapsedMs = now() - startedAt;
  } while (elapsedMs < targetDurationMs);

  return {
    backend,
    supported: true,
    durationMs: roundMetric(elapsedMs),
    operations,
    gflops: calculateGflops(operations, elapsedMs),
    note: backend === "wasm" ? "Float32 runtime baseline for WASM-capable browsers" : undefined,
  };
}

async function benchmarkWebGpu(targetDurationMs: number): Promise<BackendBenchmarkResult> {
  const gpu = getGpuNavigator();
  if (!gpu?.requestAdapter) {
    return unsupportedBenchmark("webgpu", "WebGPU navigator API unavailable");
  }

  let device: any;
  let inputA: any;
  let inputB: any;
  let output: any;

  try {
    const adapter =
      (await gpu.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false })) ||
      (await gpu.requestAdapter());
    if (!adapter) {
      return unsupportedBenchmark("webgpu", "WebGPU adapter unavailable");
    }
    device = await adapter.requestDevice();
    const usage = (globalThis as any).GPUBufferUsage;
    if (!usage) {
      return unsupportedBenchmark("webgpu", "WebGPU constants unavailable");
    }

    const elementCount = 4096;
    const iterationsPerElement = 256;
    const byteLength = elementCount * Float32Array.BYTES_PER_ELEMENT;
    const left = new Float32Array(elementCount);
    const right = new Float32Array(elementCount);
    for (let index = 0; index < elementCount; index += 1) {
      left[index] = (index % 97) / 97;
      right[index] = (index % 89) / 89;
    }

    inputA = device.createBuffer({ size: byteLength, usage: usage.STORAGE | usage.COPY_DST });
    inputB = device.createBuffer({ size: byteLength, usage: usage.STORAGE | usage.COPY_DST });
    output = device.createBuffer({ size: byteLength, usage: usage.STORAGE | usage.COPY_SRC });
    device.queue.writeBuffer(inputA, 0, left);
    device.queue.writeBuffer(inputB, 0, right);

    const shaderModule = device.createShaderModule({
      code: `
        @group(0) @binding(0) var<storage, read> a: array<f32>;
        @group(0) @binding(1) var<storage, read> b: array<f32>;
        @group(0) @binding(2) var<storage, read_write> out: array<f32>;

        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let index = id.x;
          if (index >= ${elementCount}u) {
            return;
          }
          var value = a[index];
          for (var step = 0u; step < ${iterationsPerElement}u; step = step + 1u) {
            value = value * b[index] + 0.000001;
          }
          out[index] = value;
        }
      `,
    });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: shaderModule, entryPoint: "main" },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputA } },
        { binding: 1, resource: { buffer: inputB } },
        { binding: 2, resource: { buffer: output } },
      ],
    });

    const startedAt = now();
    let operations = 0;
    let elapsedMs = 0;
    do {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(elementCount / 64));
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      operations += elementCount * iterationsPerElement * 2;
      elapsedMs = now() - startedAt;
    } while (elapsedMs < targetDurationMs);

    return {
      backend: "webgpu",
      supported: true,
      durationMs: roundMetric(elapsedMs),
      operations,
      gflops: calculateGflops(operations, elapsedMs),
    };
  } catch (error) {
    return unsupportedBenchmark(
      "webgpu",
      error instanceof Error ? error.message : "WebGPU benchmark failed",
    );
  } finally {
    inputA?.destroy?.();
    inputB?.destroy?.();
    output?.destroy?.();
    device?.destroy?.();
  }
}

function unsupportedBenchmark(backend: BrowserMlBackend, note: string): BackendBenchmarkResult {
  return {
    backend,
    supported: false,
    durationMs: 0,
    operations: 0,
    gflops: 0,
    note,
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function calculateGflops(operations: number, durationMs: number): number {
  if (durationMs <= 0) {
    return 0;
  }
  return roundMetric(operations / (durationMs / 1000) / 1_000_000_000);
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
