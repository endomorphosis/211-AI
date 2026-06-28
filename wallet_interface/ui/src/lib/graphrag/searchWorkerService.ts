import type {
  GraphCommunitySearchResult,
  GraphGeoClusterSearchResult,
  GraphRagEvidence,
  SearchCoordinates,
  SearchFilters,
  SearchMode,
  SearchResult,
} from "./types";
import { get211CorpusBaseUrl } from "./corpus";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface RagSearchWorkerPayload {
  results?: SearchResult[];
  evidence?: GraphRagEvidence;
  communityResults?: GraphCommunitySearchResult[];
  clusterResults?: GraphGeoClusterSearchResult[];
  ready?: boolean;
}

class RagSearchWorkerService {
  private worker: Worker | null = null;
  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest<RagSearchWorkerPayload>>();
  private workerInitPromise: Promise<void> | null = null;

  constructor() {
    this.initializeWorker();
  }

  async search(
    query: string,
    options: {
      filters?: SearchFilters;
      limit?: number;
      mode?: SearchMode;
      queryEmbedding?: Float32Array | number[];
      preferredClusterIds?: number[];
      currentCoordinates?: SearchCoordinates;
    } = {},
  ): Promise<SearchResult[]> {
    const response = await this.sendWorkerRequest(
      "search",
      {
        query,
        filters: options.filters,
        limit: options.limit,
        mode: options.mode,
        queryEmbedding: serializeEmbedding(options.queryEmbedding),
        preferredClusterIds: options.preferredClusterIds,
        currentCoordinates: options.currentCoordinates,
      },
      90000,
    );
    return response.results || [];
  }

  async buildEvidence(
    query: string,
    options: {
      filters?: SearchFilters;
      limit?: number;
      queryEmbedding?: Float32Array | number[];
      preferredClusterIds?: number[];
      currentCoordinates?: SearchCoordinates;
    } = {},
  ): Promise<GraphRagEvidence> {
    const response = await this.sendWorkerRequest(
      "evidence",
      {
        query,
        filters: options.filters,
        limit: options.limit,
        queryEmbedding: serializeEmbedding(options.queryEmbedding),
        preferredClusterIds: options.preferredClusterIds,
        currentCoordinates: options.currentCoordinates,
      },
      90000,
    );
    if (!response.evidence) {
      throw new Error("211 GraphRAG worker returned no evidence");
    }
    return response.evidence;
  }

  async searchCommunities(
    query: string,
    options: {
      limit?: number;
      preferredClusterIds?: number[];
    } = {},
  ): Promise<GraphCommunitySearchResult[]> {
    const response = await this.sendWorkerRequest(
      "community-search",
      {
        query,
        limit: options.limit,
        preferredClusterIds: options.preferredClusterIds,
      },
      90000,
    );
    return response.communityResults || [];
  }

  async searchGraphGeoClusters(
    query: string,
    options: {
      limit?: number;
      preferredClusterIds?: number[];
    } = {},
  ): Promise<GraphGeoClusterSearchResult[]> {
    const response = await this.sendWorkerRequest(
      "cluster-search",
      {
        query,
        limit: options.limit,
        preferredClusterIds: options.preferredClusterIds,
      },
      90000,
    );
    return response.clusterResults || [];
  }

  async getStatus(): Promise<{ hasWorker: boolean; ready: boolean }> {
    if (!this.worker) {
      return { hasWorker: false, ready: false };
    }
    try {
      const response = await this.sendWorkerRequest("status", {}, 5000);
      return { hasWorker: true, ready: Boolean(response.ready) };
    } catch {
      return { hasWorker: true, ready: false };
    }
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pendingRequests.clear();
  }

  private initializeWorker(): void {
    if (typeof Worker === "undefined") {
      return;
    }
    void this.ensureWorker();
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const { id, success, data, error } = event.data as {
      id: string;
      success: boolean;
      data?: RagSearchWorkerPayload;
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
      pending.reject(new Error(error || "211 GraphRAG worker request failed"));
    }
  }

  private handleWorkerError(error: ErrorEvent): void {
    console.error("211 GraphRAG search worker error:", error);
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error("211 GraphRAG search worker error"));
      this.pendingRequests.delete(id);
    }
  }

  private async ensureWorker(): Promise<Worker | null> {
    if (typeof Worker === "undefined") {
      return null;
    }
    if (this.worker) {
      return this.worker;
    }
    if (!this.workerInitPromise) {
      this.workerInitPromise = this.createWorker().finally(() => {
        this.workerInitPromise = null;
      });
    }
    await this.workerInitPromise;
    return this.worker;
  }

  private async createWorker(): Promise<void> {
    try {
      const worker = await this.instantiateWorker();
      worker.onmessage = this.handleWorkerMessage.bind(this);
      worker.onerror = this.handleWorkerError.bind(this);
      this.worker = worker;
      await this.sendWorkerRequestWithWorker(
        worker,
        "configure",
        {
          corpusBaseUrl: get211CorpusBaseUrl(),
        },
        5000,
      );
    } catch (error) {
      console.error("Failed to create 211 GraphRAG search worker:", error);
      this.worker?.terminate();
      this.worker = null;
    }
  }

  private async instantiateWorker(): Promise<Worker> {
    try {
      return new Worker(new URL("../../workers/ragSearchWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      if (!shouldRetryRagWorkerWithBundledImport(error)) {
        throw error;
      }
      const module = await import("../../workers/ragSearchWorker?worker");
      return new module.default();
    }
  }

  private async sendWorkerRequest(type: string, data: unknown, timeoutMs: number): Promise<RagSearchWorkerPayload> {
    const worker = await this.ensureWorker();
    if (!worker) {
      throw new Error("211 GraphRAG search worker is not available");
    }

    return this.sendWorkerRequestWithWorker(worker, type, data, timeoutMs);
  }

  private async sendWorkerRequestWithWorker(
    worker: Worker,
    type: string,
    data: unknown,
    timeoutMs: number,
  ): Promise<RagSearchWorkerPayload> {
    return new Promise((resolve, reject) => {
      const id = `rag_${++this.requestCounter}`;
      const timeout = window.setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("211 GraphRAG worker request timed out"));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          window.clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      });

      worker.postMessage({ id, type, data });
    });
  }
}

function shouldRetryRagWorkerWithBundledImport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /Failed to construct 'URL'/i.test(message) || /Invalid base URL/i.test(message);
}

function serializeEmbedding(embedding?: Float32Array | number[]): number[] | undefined {
  if (!embedding) {
    return undefined;
  }
  return Array.from(embedding);
}

export const ragSearchWorkerService = new RagSearchWorkerService();
