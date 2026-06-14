import { LLM_CONFIG } from "./llmConfig";
import { detectBrowserMlBackends } from "./backendDetection";
import type {
  BackendBenchmarkResult,
  BackendCapabilities,
  BackendDetectionOptions,
  BackendDetectionResult,
  BrowserMlBackend,
} from "./backendDetection";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface BackendDetectionWorkerPayload {
  result?: BackendDetectionResult;
  ready?: boolean;
}

export interface BackendDetectionStatus {
  available: boolean;
  hasWorker: boolean;
  source: "worker" | "main-thread";
  recommendedBackend: BrowserMlBackend | "unknown";
  capabilities: BackendCapabilities | null;
  deviceInfo: BackendDetectionResult["deviceInfo"] | null;
  crossOriginIsolated: boolean;
  benchmarks: BackendBenchmarkResult[];
  error?: string;
}

class BackendDetectionWorkerService {
  private worker: Worker | null = null;
  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest<BackendDetectionWorkerPayload>>();
  private startupError: string | undefined;

  constructor() {
    this.initializeWorker();
  }

  async detect(options: BackendDetectionOptions = {}): Promise<BackendDetectionStatus> {
    if (this.worker) {
      try {
        const response = await this.sendWorkerRequest(
          "detect",
          options,
          options.benchmark ? LLM_CONFIG.localPerfBenchmarkTimeoutMs : LLM_CONFIG.localProbeTimeoutMs,
        );
        if (!response.result) {
          throw new Error("Backend detection worker returned no result");
        }
        return toBackendStatus(response.result, {
          hasWorker: true,
          source: "worker",
        });
      } catch (error) {
        const fallbackReason = error instanceof Error ? error.message : "Backend detection worker failed";
        console.warn("211 backend detection worker unavailable; using main-thread detection", error);
        this.stopWorker(fallbackReason);
        return this.detectOnMainThread(options, fallbackReason);
      }
    }

    return this.detectOnMainThread(options, this.startupError);
  }

  async getStatus(options: BackendDetectionOptions = {}): Promise<BackendDetectionStatus> {
    return this.detect(options);
  }

  destroy(): void {
    this.stopWorker();
  }

  private async detectOnMainThread(
    options: BackendDetectionOptions,
    workerError?: string,
  ): Promise<BackendDetectionStatus> {
    try {
      const result = await detectBrowserMlBackends(options);
      return toBackendStatus(result, {
        hasWorker: false,
        source: "main-thread",
        error: workerError,
      });
    } catch (error) {
      return {
        available: false,
        hasWorker: false,
        source: "main-thread",
        recommendedBackend: "unknown",
        capabilities: null,
        deviceInfo: null,
        crossOriginIsolated: Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated),
        benchmarks: [],
        error: error instanceof Error ? error.message : "Backend detection failed",
      };
    }
  }

  private initializeWorker(): void {
    if (typeof Worker === "undefined") {
      this.startupError = "Worker API unavailable";
      return;
    }
    try {
      this.worker = new Worker(new URL("../workers/backendDetectionWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = this.handleWorkerError.bind(this);
    } catch (error) {
      this.startupError = error instanceof Error ? error.message : "Failed to create backend detection worker";
      console.error("Failed to create 211 backend detection worker:", error);
      this.worker = null;
    }
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const { id, success, data, error } = event.data as {
      id: string;
      success: boolean;
      data?: BackendDetectionWorkerPayload;
      error?: string;
    };
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(id);
    if (success) {
      pending.resolve(data || {});
    } else {
      pending.reject(new Error(error || "Backend detection worker request failed"));
    }
  }

  private handleWorkerError(error: ErrorEvent): void {
    const message = error.message || "Backend detection worker error";
    console.error("211 backend detection worker error:", error);
    this.stopWorker(message);
  }

  private sendWorkerRequest(
    type: string,
    data: BackendDetectionOptions,
    timeoutMs: number,
  ): Promise<BackendDetectionWorkerPayload> {
    if (!this.worker) {
      throw new Error("Backend detection worker is not available");
    }
    const worker = this.worker;

    return new Promise((resolve, reject) => {
      const id = `backend_${++this.requestCounter}`;
      const timeout = globalThis.setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("Backend detection worker request timed out"));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          globalThis.clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          globalThis.clearTimeout(timeout);
          reject(reason);
        },
      });

      worker.postMessage({ id, type, data });
    });
  }

  private stopWorker(error?: string): void {
    this.worker?.terminate();
    this.worker = null;
    if (error) {
      this.startupError = error;
    }
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error(error || "Backend detection worker stopped"));
      this.pendingRequests.delete(id);
    }
  }
}

function toBackendStatus(
  result: BackendDetectionResult,
  metadata: {
    hasWorker: boolean;
    source: BackendDetectionStatus["source"];
    error?: string;
  },
): BackendDetectionStatus {
  return {
    available: true,
    hasWorker: metadata.hasWorker,
    source: metadata.source,
    recommendedBackend: result.recommendedBackend,
    capabilities: result.capabilities,
    deviceInfo: result.deviceInfo,
    crossOriginIsolated: result.deviceInfo.crossOriginIsolated,
    benchmarks: result.benchmarks,
    error: metadata.error,
  };
}

export const backendDetectionWorkerService = new BackendDetectionWorkerService();
