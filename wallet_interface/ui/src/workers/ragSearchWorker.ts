import { set211CorpusBaseUrl } from "../lib/graphrag/corpus";
import { build211GraphRagEvidence } from "../lib/graphrag/graphRag";
import { search211Corpus, search211GraphCommunities, search211GraphGeoClusters } from "../lib/graphrag/search";
import type {
  GraphCommunitySearchResult,
  GraphGeoClusterSearchResult,
  GraphRagEvidence,
  SearchCoordinates,
  SearchFilters,
  SearchMode,
  SearchResult,
} from "../lib/graphrag/types";

type RagSearchWorkerRequest =
  | {
      id: string;
      type: "configure";
      data: {
        corpusBaseUrl: string;
      };
    }
  | {
      id: string;
      type: "search";
      data: {
        query: string;
        filters?: SearchFilters;
        limit?: number;
        mode?: SearchMode;
        queryEmbedding?: number[];
        preferredClusterIds?: number[];
        currentCoordinates?: SearchCoordinates;
      };
    }
  | {
      id: string;
      type: "evidence";
      data: {
        query: string;
        filters?: SearchFilters;
        limit?: number;
        queryEmbedding?: number[];
        preferredClusterIds?: number[];
        currentCoordinates?: SearchCoordinates;
      };
    }
  | {
      id: string;
      type: "status";
      data?: Record<string, never>;
    }
  | {
      id: string;
      type: "community-search";
      data: {
        query: string;
        limit?: number;
        preferredClusterIds?: number[];
      };
    }
  | {
      id: string;
      type: "cluster-search";
      data: {
        query: string;
        limit?: number;
        preferredClusterIds?: number[];
      };
    };

interface RagSearchWorkerResponse {
  id: string;
  success: boolean;
  data?: {
    results?: SearchResult[];
    evidence?: GraphRagEvidence;
    communityResults?: GraphCommunitySearchResult[];
    clusterResults?: GraphGeoClusterSearchResult[];
    ready?: boolean;
  };
  error?: string;
}

self.onmessage = async (event: MessageEvent<RagSearchWorkerRequest>) => {
  const { id, type, data } = event.data;

  try {
    if (type === "configure") {
      set211CorpusBaseUrl(data.corpusBaseUrl);
      postResponse({ id, success: true, data: { ready: true } });
      return;
    }

    if (type === "status") {
      postResponse({ id, success: true, data: { ready: true } });
      return;
    }

    if (type === "search") {
      const queryEmbedding = data.queryEmbedding ? new Float32Array(data.queryEmbedding) : undefined;
      const results = await search211Corpus(data.query, {
        filters: data.filters,
        mode: data.mode || (queryEmbedding ? "hybrid" : "keyword"),
        queryEmbedding,
        limit: data.limit || 10,
        preferredClusterIds: data.preferredClusterIds,
        currentCoordinates: data.currentCoordinates,
      });
      postResponse({ id, success: true, data: { results } });
      return;
    }

    if (type === "evidence") {
      const queryEmbedding = data.queryEmbedding ? new Float32Array(data.queryEmbedding) : undefined;
      const evidence = await build211GraphRagEvidence(data.query, {
        filters: data.filters,
        queryEmbedding,
        limit: data.limit || 6,
        preferredClusterIds: data.preferredClusterIds,
        currentCoordinates: data.currentCoordinates,
      });
      postResponse({ id, success: true, data: { evidence } });
      return;
    }

    if (type === "community-search") {
      const communityResults = await search211GraphCommunities(data.query, {
        limit: data.limit || 12,
        preferredClusterIds: data.preferredClusterIds,
      });
      postResponse({ id, success: true, data: { communityResults } });
      return;
    }

    if (type === "cluster-search") {
      const clusterResults = await search211GraphGeoClusters(data.query, {
        limit: data.limit || 10,
        preferredClusterIds: data.preferredClusterIds,
      });
      postResponse({ id, success: true, data: { clusterResults } });
      return;
    }

    throw new Error(`Unknown 211 GraphRAG worker request: ${type}`);
  } catch (error) {
    postResponse({
      id,
      success: false,
      error: error instanceof Error ? error.message : "211 GraphRAG worker failed",
    });
  }
};

function postResponse(response: RagSearchWorkerResponse): void {
  self.postMessage(response);
}

export {};
