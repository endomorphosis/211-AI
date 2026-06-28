import {
  load211Bm25,
  load211Bm25GeoShard,
  load211Bm25Slice,
  load211DocumentsSlice,
  load211Embeddings,
  load211EmbeddingGeoShard,
  load211EmbeddingSlice,
  load211DocumentCommunities,
  load211GraphCommunities,
  load211GraphGeoClusters,
  load211RetrievalGeoShards,
  load211ServiceGeoIndex,
} from "./corpus";
import {
  getPrimaryAddress,
  getServiceRichnessScore,
  getServiceSearchMetadataText,
  isServiceDocument,
} from "./serviceDocument";
import { haversineMiles } from "./serviceGeoPreference";
import type {
  Bm25Document,
  CorpusDocument,
  GraphCommunity,
  GraphCommunitySearchResult,
  GraphGeoClusterRecord,
  GraphGeoClusterSearchResult,
  SearchCoordinates,
  SearchFilters,
  SearchMode,
  SearchResult,
  RetrievalGeoShardRecord,
} from "./types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "near",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

interface RankedScore {
  docId: string;
  score: number;
}

// Cache for precomputed service IDs loaded from manifest
let precomputedServiceIdsCache: Set<string> | null = null;
let precomputedServiceIdsCacheLoadedAt = 0;
const PRECOMPUTED_SERVICE_CACHE_TTL_MS = 3600000; // 1 hour

async function getPrecomputedServiceIds(): Promise<Set<string>> {
  const now = Date.now();
  if (precomputedServiceIdsCache && now - precomputedServiceIdsCacheLoadedAt < PRECOMPUTED_SERVICE_CACHE_TTL_MS) {
    return precomputedServiceIdsCache;
  }

  const ids = new Set<string>();
  try {
    // Try to load the precompute manifest with completed responses
    const response = await fetch("docs/211_indextts_sample_manifest.json", { cache: "no-store" }).catch(() =>
      // Fallback to planned manifest if sample is not available
      fetch("docs/211_indextts_precompute_manifest.json", { cache: "no-store" }),
    );

    if (!response.ok) {
      return ids;
    }

    const manifest = await response.json();
    const responses = manifest.responses || [];

    // Extract service doc IDs from response sourceIds
    for (const responseEntry of responses) {
      const sourceIds = responseEntry.sourceIds || [];
      for (const sourceId of sourceIds) {
        // Convert sourceId format (e.g., "birth_certificate_help#turn-1") to doc ID if needed
        // Many service responses will have sourceIds that reference specific service nodes
        if (sourceId && typeof sourceId === "string") {
          // Extract the base service ID (before the # delimiter)
          const baseId = sourceId.split("#")[0];
          if (baseId && baseId.match(/^[a-z0-9_-]+$/i)) {
            ids.add(baseId);
          }
        }
      }
    }
  } catch (error) {
    console.warn("Failed to load precomputed service IDs for search boost:", error);
  }

  precomputedServiceIdsCache = ids;
  precomputedServiceIdsCacheLoadedAt = now;
  return ids;
}

function getPrecomputedBoost(docId: string, precomputedIds: Set<string>): number {
  // Return boost factor if docId is in precomputed set
  // Boost is applied additively to final score
  if (precomputedIds.has(docId)) {
    return 0.4; // Moderate boost that doesn't dominate other ranking signals
  }

  // Check if docId matches pattern service:* and has precomputed audio
  if (docId.startsWith("service:")) {
    // Could add more sophisticated matching here if needed
    return 0;
  }

  return 0;
}

interface WeightedSearchField {
  text: string;
  weight: number;
  phraseWeight?: number;
}

export async function search211Corpus(
  query: string,
  options: {
    filters?: SearchFilters;
    mode?: SearchMode;
    queryEmbedding?: Float32Array | number[];
    limit?: number;
    candidateLimit?: number;
    preferredClusterIds?: number[];
    currentCoordinates?: SearchCoordinates;
  } = {},
): Promise<SearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const mode = options.mode || "hybrid";
  const limit = options.limit || options.filters?.limit || 20;
  const candidateLimit = options.candidateLimit || Math.max(limit * 10, 200);
  const preferredClusterIds = dedupeIntegerList(options.preferredClusterIds || []);

  // Load precomputed service IDs in background for search ranking boost
  const precomputedIdsPromise = getPrecomputedServiceIds().catch(() => new Set<string>());

  const serviceClusterResults = await searchPreferredServiceClusters(trimmedQuery, {
    filters: options.filters,
    limit,
    candidateLimit,
    mode,
    queryEmbedding: options.queryEmbedding,
    preferredClusterIds,
    currentCoordinates: options.currentCoordinates,
    precomputedIds: await precomputedIdsPromise,
  });
  if (serviceClusterResults.length >= limit) {
    return serviceClusterResults.slice(0, limit);
  }

  const sparseServiceResults = await searchSparseServiceClusters(trimmedQuery, {
    filters: options.filters,
    limit,
    candidateLimit,
    mode,
    queryEmbedding: options.queryEmbedding,
    currentCoordinates: options.currentCoordinates,
    preferredClusterIds,
    precomputedIds: await precomputedIdsPromise,
  });
  if (sparseServiceResults.length >= limit) {
    return mergeSearchResults(serviceClusterResults, sparseServiceResults, limit);
  }

  const allServiceShardResults = await searchAllServiceGeoShards(trimmedQuery, {
    filters: options.filters,
    limit,
    candidateLimit,
    mode,
    queryEmbedding: options.queryEmbedding,
    currentCoordinates: options.currentCoordinates,
    precomputedIds: await precomputedIdsPromise,
  });
  if (allServiceShardResults.length >= limit) {
    return mergeSearchResults([...serviceClusterResults, ...sparseServiceResults], allServiceShardResults, limit);
  }
  if (isServiceOnlySearch(options.filters)) {
    return mergeSearchResults([...serviceClusterResults, ...sparseServiceResults], allServiceShardResults, limit);
  }

  const sparseGraphResults = await searchSparseGraphDocuments(trimmedQuery, {
    filters: options.filters,
    limit,
    candidateLimit,
    mode,
    preferredClusterIds,
    currentCoordinates: options.currentCoordinates,
  });
  return mergeSearchResults(
    [...serviceClusterResults, ...sparseServiceResults, ...allServiceShardResults],
    sparseGraphResults,
    limit,
  );
}

export async function keywordSearch211(query: string, limit = 200): Promise<Map<string, number>> {
  const terms = tokenizeSearchText(query);
  if (terms.length === 0) {
    return new Map();
  }

  const payload = await load211Bm25();
  const ranked: RankedScore[] = [];
  for (const document of payload.documents) {
    const score = scoreBm25Document(document, terms, payload.k1, payload.b, payload.avgdl);
    if (score > 0) {
      ranked.push({ docId: document.doc_id, score });
    }
  }
  ranked.sort((left, right) => right.score - left.score);
  return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
}

export async function vectorSearch211(
  queryEmbedding: Float32Array | number[],
  limit = 200,
): Promise<Map<string, number>> {
  const { index, vectors } = await load211Embeddings();
  const queryVector = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);
  if (queryVector.length !== index.dimension) {
    throw new Error(`Query embedding dimension ${queryVector.length} did not match ${index.dimension}`);
  }

  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0) {
    return new Map();
  }

  const ranked: RankedScore[] = [];
  for (let row = 0; row < index.count; row += 1) {
    const offset = row * index.dimension;
    let dot = 0;
    let candidateNormSquared = 0;
    for (let column = 0; column < index.dimension; column += 1) {
      const value = vectors[offset + column] || 0;
      const queryValue = queryVector[column] || 0;
      dot += value * queryValue;
      candidateNormSquared += value * value;
    }
    const candidateNorm = Math.sqrt(candidateNormSquared);
    if (candidateNorm > 0) {
      ranked.push({ docId: index.doc_ids[row], score: dot / (queryNorm * candidateNorm) });
    }
  }

  ranked.sort((left, right) => right.score - left.score);
  return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
}

export async function search211GraphCommunities(
  query: string,
  options: {
    limit?: number;
    preferredClusterIds?: number[];
  } = {},
): Promise<GraphCommunitySearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const [communities, documentCommunities, graphGeoClusters] = await Promise.all([
    load211GraphCommunities(),
    load211DocumentCommunities(),
    load211GraphGeoClusters(),
  ]);
  const preferredClusterIds = new Set(dedupeIntegerList(options.preferredClusterIds || []));
  const matchedDocumentsByCommunity = new Map<string, string[]>();
  for (const row of documentCommunities) {
    if (!matchedDocumentsByCommunity.has(row.community_id)) {
      matchedDocumentsByCommunity.set(row.community_id, []);
    }
    matchedDocumentsByCommunity.get(row.community_id)!.push(row.doc_id);
  }

  const ranked = communities
    .map((community) =>
      rankGraphCommunity(community, matchedDocumentsByCommunity, graphGeoClusters.communityIdToClusterIds, trimmedQuery, preferredClusterIds),
    )
    .filter((result): result is GraphCommunitySearchResult => Boolean(result))
    .sort((left, right) => right.score - left.score);
  return ranked.slice(0, options.limit || 12);
}

export async function search211GraphGeoClusters(
  query: string,
  options: {
    limit?: number;
    preferredClusterIds?: number[];
  } = {},
): Promise<GraphGeoClusterSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const [communities, graphGeoClusters] = await Promise.all([load211GraphCommunities(), load211GraphGeoClusters()]);
  const communityById = new Map<string, GraphCommunity>(communities.map((community) => [community.community_id, community]));
  const preferredClusterIds = new Set(dedupeIntegerList(options.preferredClusterIds || []));
  const ranked = graphGeoClusters.clusters
    .map((cluster) => rankGraphGeoCluster(cluster, communityById, trimmedQuery, preferredClusterIds))
    .filter((result): result is GraphGeoClusterSearchResult => Boolean(result))
    .sort((left, right) => right.score - left.score);
  return ranked.slice(0, options.limit || 10);
}

async function keywordSearch211GeoShards(
  query: string,
  clusterIds: number[],
  includeUnclusteredServices: boolean,
  limit = 200,
): Promise<Map<string, number>> {
  const terms = tokenizeSearchText(query);
  if (terms.length === 0) {
    return new Map();
  }
  const shardRecords = await resolveRetrievalGeoShardRecords(clusterIds, includeUnclusteredServices);
  if (shardRecords.length) {
    try {
      const ranked: RankedScore[] = [];
      for (const payload of await Promise.all(shardRecords.map((record) => load211Bm25GeoShard(record.bm25Path)))) {
        for (const document of payload.documents) {
          const score = scoreBm25Document(document, terms, payload.k1, payload.b, payload.avgdl);
          if (score > 0) {
            ranked.push({ docId: document.doc_id, score });
          }
        }
      }
      ranked.sort((left, right) => right.score - left.score);
      return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
    } catch (error) {
      console.warn("211 BM25 geo shard load failed; falling back to parquet slice.", error);
    }
  }
  const parquetPayload = await load211Bm25Slice({ clusterIds, includeUnclusteredServices }).catch(() => null);
  if (!parquetPayload) {
    return new Map();
  }
  const ranked: RankedScore[] = [];
  for (const document of parquetPayload.documents) {
    const score = scoreBm25Document(document, terms, parquetPayload.k1, parquetPayload.b, parquetPayload.avgdl);
    if (score > 0) {
      ranked.push({ docId: document.doc_id, score });
    }
  }
  ranked.sort((left, right) => right.score - left.score);
  return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
}

async function vectorSearch211GeoShards(
  queryEmbedding: Float32Array | number[],
  clusterIds: number[],
  includeUnclusteredServices: boolean,
  limit = 200,
): Promise<Map<string, number>> {
  const shardRecords = await resolveRetrievalGeoShardRecords(clusterIds, includeUnclusteredServices);
  const queryVector = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0) {
    return new Map();
  }

  if (shardRecords.length) {
    try {
      const ranked: RankedScore[] = [];
      const shardEmbeddings = await Promise.all(
        shardRecords.map((record) => load211EmbeddingGeoShard(record.embeddingIndexPath, record.embeddingBinaryPath)),
      );
      for (const { index, vectors } of shardEmbeddings) {
        if (queryVector.length !== index.dimension) {
          throw new Error(`Query embedding dimension ${queryVector.length} did not match ${index.dimension}`);
        }
        const shardScores = rankEmbeddingBundle(index, vectors, queryVector, queryNorm);
        ranked.push(...shardScores);
      }
      ranked.sort((left, right) => right.score - left.score);
      return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
    } catch (error) {
      console.warn("211 embedding geo shard load failed; falling back to parquet slice.", error);
    }
  }
  const parquetEmbeddings = await load211EmbeddingSlice({ clusterIds, includeUnclusteredServices }).catch(() => null);
  if (!parquetEmbeddings) {
    return new Map();
  }
  return vectorSearchFromBundle(parquetEmbeddings.index, parquetEmbeddings.vectors, queryVector, limit);
}

async function searchAllServiceGeoShards(
  query: string,
  options: {
    filters?: SearchFilters;
    limit: number;
    candidateLimit: number;
    mode: SearchMode;
    queryEmbedding?: Float32Array | number[];
    currentCoordinates?: SearchCoordinates;
    precomputedIds?: Set<string>;
  },
): Promise<SearchResult[]> {
  if (!isServiceOnlySearch(options.filters)) {
    return [];
  }
  const [keywordScores, vectorScores, geoScores] = await Promise.all([
    options.mode !== "vector"
      ? keywordSearch211AllServiceGeoShards(query, options.candidateLimit)
      : Promise.resolve(new Map<string, number>()),
    options.mode !== "keyword" && options.queryEmbedding
      ? vectorSearch211AllServiceGeoShards(options.queryEmbedding, options.candidateLimit)
      : Promise.resolve(new Map<string, number>()),
    load211ServiceGeoIndex()
      .then((index) => lookupGeoScores(query, index))
      .catch(() => new Map<string, number>()),
  ]);
  const candidates = new Set([...keywordScores.keys(), ...vectorScores.keys(), ...geoScores.keys()]);
  if (candidates.size === 0) {
    return [];
  }
  const normalizedKeyword = normalizeScores(keywordScores);
  const normalizedVector = normalizeScores(vectorScores);
  const candidateDocIds = [...candidates].slice(0, options.candidateLimit);
  const state = await load211DocumentsSlice({
    docIds: candidateDocIds,
    docTypes: ["service"],
    limit: candidateDocIds.length,
  });
  return rankSearchResults(
    state.documents,
    state.documentById,
    candidates,
    query,
    options.filters,
    options.mode,
    normalizedKeyword,
    normalizedVector,
    geoScores,
    options.currentCoordinates,
    options.limit,
    options.precomputedIds,
  );
}

async function keywordSearch211AllServiceGeoShards(query: string, limit = 200): Promise<Map<string, number>> {
  const terms = tokenizeSearchText(query);
  if (terms.length === 0) {
    return new Map();
  }
  const shardRecords = await resolveAllRetrievalGeoShardRecords();
  const ranked: RankedScore[] = [];
  const shardPayloads = await mapInBatches(shardRecords, 6, (record) => load211Bm25GeoShard(record.bm25Path));
  for (const payload of shardPayloads) {
    for (const document of payload.documents) {
      const score = scoreBm25Document(document, terms, payload.k1, payload.b, payload.avgdl);
      if (score > 0) {
        ranked.push({ docId: document.doc_id, score });
      }
    }
  }
  ranked.sort((left, right) => right.score - left.score);
  return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
}

async function vectorSearch211AllServiceGeoShards(
  queryEmbedding: Float32Array | number[],
  limit = 200,
): Promise<Map<string, number>> {
  const shardRecords = await resolveAllRetrievalGeoShardRecords();
  const queryVector = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0) {
    return new Map();
  }

  const ranked: RankedScore[] = [];
  const shardEmbeddings = await mapInBatches(shardRecords, 4, (record) =>
    load211EmbeddingGeoShard(record.embeddingIndexPath, record.embeddingBinaryPath),
  );
  for (const { index, vectors } of shardEmbeddings) {
    if (queryVector.length !== index.dimension) {
      throw new Error(`Query embedding dimension ${queryVector.length} did not match ${index.dimension}`);
    }
    ranked.push(...rankEmbeddingBundle(index, vectors, queryVector, queryNorm));
  }
  ranked.sort((left, right) => right.score - left.score);
  return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
}

export function tokenizeSearchText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

function scoreBm25Document(document: Bm25Document, queryTerms: string[], k1: number, b: number, avgdl: number): number {
  let score = 0;
  const docLength = Math.max(document.document_length || 0, 1);
  const lengthNorm = 1 - b + (b * docLength) / Math.max(avgdl, 1);
  for (const term of queryTerms) {
    const tf = document.terms[term] || 0;
    if (tf <= 0) {
      continue;
    }
    const idf = document.term_idf?.[term] || 1;
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * lengthNorm));
  }
  return score;
}

function normalizeScores(scores: Map<string, number>): Map<string, number> {
  if (scores.size === 0) {
    return new Map();
  }
  const values = [...scores.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    return new Map([...scores.keys()].map((key) => [key, 1]));
  }
  return new Map([...scores.entries()].map(([key, value]) => [key, (value - min) / (max - min)]));
}

async function searchPreferredServiceClusters(
  query: string,
  options: {
    filters?: SearchFilters;
    limit: number;
    candidateLimit: number;
    mode: SearchMode;
    queryEmbedding?: Float32Array | number[];
    preferredClusterIds: number[];
    currentCoordinates?: SearchCoordinates;
    precomputedIds?: Set<string>;
  },
): Promise<SearchResult[]> {
  if (!options.preferredClusterIds.length || !isServiceOnlySearch(options.filters)) {
    return [];
  }
  const clusterPlans = buildClusterLoadPlans(options.preferredClusterIds);
  let bestResults: SearchResult[] = [];
  for (const plan of clusterPlans) {
    const [keywordScores, vectorScores] = await Promise.all([
      options.mode !== "vector"
        ? keywordSearch211GeoShards(query, plan.clusterIds, plan.includeUnclusteredServices, options.candidateLimit)
        : Promise.resolve(new Map<string, number>()),
      options.mode !== "keyword" && options.queryEmbedding
        ? vectorSearch211GeoShards(
            options.queryEmbedding,
            plan.clusterIds,
            plan.includeUnclusteredServices,
            options.candidateLimit,
          )
        : Promise.resolve(new Map<string, number>()),
    ]);
    const normalizedKeyword = normalizeScores(keywordScores);
    const normalizedVector = normalizeScores(vectorScores);
    const candidates = new Set([...keywordScores.keys(), ...vectorScores.keys()]);
    if (candidates.size === 0) {
      continue;
    }
    const state = await load211DocumentsSlice({
      docIds: [...candidates].slice(0, options.candidateLimit),
      docTypes: ["service"],
    });
    const results = rankSearchResults(
      state.documents,
      state.documentById,
      candidates,
      query,
      options.filters,
      options.mode,
      normalizedKeyword,
      normalizedVector,
      new Map(),
      options.currentCoordinates,
      options.limit,
      options.precomputedIds,
    );
    if (results.length > bestResults.length) {
      bestResults = results;
    }
    if (bestResults.length >= options.limit) {
      break;
    }
  }
  return bestResults;
}

async function searchSparseServiceClusters(
  query: string,
  options: {
    filters?: SearchFilters;
    limit: number;
    candidateLimit: number;
    mode: SearchMode;
    queryEmbedding?: Float32Array | number[];
    preferredClusterIds: number[];
    currentCoordinates?: SearchCoordinates;
    precomputedIds?: Set<string>;
  },
): Promise<SearchResult[]> {
  if (options.preferredClusterIds.length || !isServiceOnlySearch(options.filters)) {
    return [];
  }
  const geoClusterResults = await search211GraphGeoClusters(query, { limit: 8 }).catch(() => []);
  const clusterIds = dedupeIntegerList(geoClusterResults.map((result) => result.cluster.clusterId));
  if (!clusterIds.length) {
    return [];
  }
  return searchPreferredServiceClusters(query, {
    filters: options.filters,
    limit: options.limit,
    candidateLimit: options.candidateLimit,
    mode: options.mode,
    queryEmbedding: options.queryEmbedding,
    preferredClusterIds: clusterIds,
    currentCoordinates: options.currentCoordinates,
    precomputedIds: options.precomputedIds,
  });
}

async function searchSparseGraphDocuments(
  query: string,
  options: {
    filters?: SearchFilters;
    limit: number;
    candidateLimit: number;
    mode: SearchMode;
    preferredClusterIds: number[];
    currentCoordinates?: SearchCoordinates;
  },
): Promise<SearchResult[]> {
  const communityResults = await search211GraphCommunities(query, {
    limit: 12,
    preferredClusterIds: options.preferredClusterIds,
  }).catch(() => []);
  const candidates = new Set<string>();
  for (const result of communityResults) {
    for (const docId of result.matchedDocIds) {
      candidates.add(docId);
      if (candidates.size >= options.candidateLimit) {
        break;
      }
    }
    if (candidates.size >= options.candidateLimit) {
      break;
    }
  }
  if (candidates.size === 0) {
    return [];
  }

  const candidateDocIds = [...candidates];
  const state = await load211DocumentsSlice({
    docIds: candidateDocIds,
    docTypes: options.filters?.docTypes,
    limit: candidateDocIds.length,
  });
  return rankSearchResults(
    state.documents,
    state.documentById,
    candidates,
    query,
    options.filters,
    options.mode,
    new Map(),
    new Map(),
    new Map(),
    options.currentCoordinates,
    options.limit,
  );
}

async function resolveRetrievalGeoShardRecords(clusterIds: number[], includeUnclusteredServices: boolean) {
  const manifest = await load211RetrievalGeoShards();
  const shardIds = new Set<string>();
  for (const clusterId of dedupeIntegerList(clusterIds)) {
    const shardId = manifest.clusterIdToShardId[String(clusterId)];
    if (shardId) {
      shardIds.add(shardId);
    }
  }
  if (includeUnclusteredServices) {
    const shardId = manifest.clusterIdToShardId["-1"];
    if (shardId) {
      shardIds.add(shardId);
    }
  }
  return manifest.shards.filter((record) => shardIds.has(record.shardId));
}

async function resolveAllRetrievalGeoShardRecords(): Promise<RetrievalGeoShardRecord[]> {
  const manifest = await load211RetrievalGeoShards();
  return manifest.shards;
}

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...(await Promise.all(items.slice(index, index + batchSize).map(mapper))));
  }
  return results;
}

function buildClusterLoadPlans(preferredClusterIds: number[]) {
  const plans: Array<{ clusterIds: number[]; includeUnclusteredServices: boolean }> = [];
  for (const size of [4, 8, 16]) {
    const clusterIds = preferredClusterIds.slice(0, Math.min(size, preferredClusterIds.length));
    if (!clusterIds.length) {
      continue;
    }
    if (!plans.some((plan) => sameIntegerList(plan.clusterIds, clusterIds) && !plan.includeUnclusteredServices)) {
      plans.push({ clusterIds, includeUnclusteredServices: false });
    }
  }
  plans.push({ clusterIds: preferredClusterIds, includeUnclusteredServices: true });
  return plans;
}

function rankSearchResults(
  documents: CorpusDocument[],
  documentById: Map<string, CorpusDocument>,
  candidates: Set<string>,
  query: string,
  filters: SearchFilters | undefined,
  mode: SearchMode,
  normalizedKeyword: Map<string, number>,
  normalizedVector: Map<string, number>,
  geoScores: Map<string, number>,
  currentCoordinates: SearchCoordinates | undefined,
  limit: number,
  precomputedIds: Set<string> | undefined = undefined,
): SearchResult[] {
  const effectiveCandidates = new Set(candidates);
  if (effectiveCandidates.size === 0) {
    const loweredQuery = query.toLowerCase();
    for (const document of documents) {
      if (
        document.title.toLowerCase().includes(loweredQuery) ||
        getServiceSearchMetadataText(document).toLowerCase().includes(loweredQuery)
      ) {
        effectiveCandidates.add(document.doc_id);
      }
    }
  }

  const results: SearchResult[] = [];
  for (const docId of effectiveCandidates) {
    const document = documentById.get(docId);
    if (!document || !matchesFilters(document, filters)) {
      continue;
    }
    const result = scoreSearchResult(
      document,
      docId,
      query,
      mode,
      normalizedKeyword,
      normalizedVector,
      geoScores,
      currentCoordinates,
      precomputedIds,
    );
    results.push(result);
  }
  return mergeDuplicateSearchResults(results).sort(compareSearchResults).slice(0, limit);
}

function scoreSearchResult(
  document: CorpusDocument,
  docId: string,
  query: string,
  mode: SearchMode,
  normalizedKeyword: Map<string, number>,
  normalizedVector: Map<string, number>,
  geoScores: Map<string, number>,
  currentCoordinates: SearchCoordinates | undefined,
  precomputedIds: Set<string> | undefined = undefined,
): SearchResult {
  const keyword = normalizedKeyword.get(docId) || 0;
  const vector = normalizedVector.get(docId) || 0;
  const metadata = metadataScore(document, query, geoScores.get(docId) || 0);
  const distanceMiles = computeDocumentDistanceMiles(document, currentCoordinates);
  const proximity = proximityScore(distanceMiles, document);
  const precomputedBoost = precomputedIds ? getPrecomputedBoost(docId, precomputedIds) : 0;
  const score =
    (mode === "keyword"
      ? keyword * 2 + metadata + proximity * 1.2
      : mode === "vector"
        ? vector * 2 + metadata * 0.5 + proximity
        : keyword * 1.4 + vector * 2 + metadata + proximity * 1.2) + precomputedBoost;

  return {
    docId,
    contentCid: document.source_content_cid,
    pageCid: document.source_page_cid,
    document,
    score,
    duplicateCount: 1,
    mergedDocIds: [docId],
    distanceMiles,
    scoreParts: { keyword, vector, metadata, proximity },
    snippet: buildSnippet(document.text, query),
  };
}

function mergeSearchResults(primary: SearchResult[], secondary: SearchResult[], limit: number): SearchResult[] {
  return mergeDuplicateSearchResults([...primary, ...secondary]).sort(compareSearchResults).slice(0, limit);
}

export function mergeDuplicateSearchResults(results: SearchResult[]): SearchResult[] {
  const byMergeKey = new Map<string, SearchResult>();
  for (const result of results) {
    const mergeKey = buildSearchResultMergeKey(result.document, result.docId);
    const current = byMergeKey.get(mergeKey);
    if (!current) {
      byMergeKey.set(mergeKey, {
        ...result,
        duplicateCount: result.duplicateCount || 1,
        mergedDocIds: [...(result.mergedDocIds || [result.docId])],
      });
      continue;
    }
    const mergedDocIds = dedupeStringList([...(current.mergedDocIds || [current.docId]), result.docId]);
    const better = compareSearchResults(result, current) < 0 ? result : current;
    byMergeKey.set(mergeKey, {
      ...better,
      duplicateCount: mergedDocIds.length,
      mergedDocIds,
      distanceMiles: pickPreferredDistance(current.distanceMiles, result.distanceMiles),
      score: Math.max(current.score, result.score) + Math.min(0.12, (mergedDocIds.length - 1) * 0.04),
      scoreParts: {
        keyword: Math.max(current.scoreParts.keyword, result.scoreParts.keyword),
        vector: Math.max(current.scoreParts.vector, result.scoreParts.vector),
        metadata: Math.max(current.scoreParts.metadata, result.scoreParts.metadata),
        proximity: Math.max(current.scoreParts.proximity || 0, result.scoreParts.proximity || 0),
      },
    });
  }
  return [...byMergeKey.values()];
}

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-6) {
    return scoreDelta;
  }
  const leftDistance = left.distanceMiles ?? Number.POSITIVE_INFINITY;
  const rightDistance = right.distanceMiles ?? Number.POSITIVE_INFINITY;
  if (leftDistance !== rightDistance) {
    return leftDistance - rightDistance;
  }
  return left.docId.localeCompare(right.docId);
}

function buildSearchResultMergeKey(document: CorpusDocument, docId: string): string {
  if (!isServiceDocument(document)) {
    return `doc:${docId}`;
  }
  const primaryAddress = getPrimaryAddress(document);
  const providerKey = normalizeMergeKeyPart(document.provider_name);
  const programKey = normalizeMergeKeyPart(document.program_name || document.title);
  const titleKey = normalizeMergeKeyPart(document.title);
  const geoKey = buildServiceGeoMergeKey(document, primaryAddress);
  const locationKey = normalizeMergeKeyPart(
    primaryAddress?.maps_query ||
      [
        primaryAddress?.street,
        primaryAddress?.city || document.city,
        primaryAddress?.state || document.state,
        primaryAddress?.postal_code,
      ]
        .filter(Boolean)
        .join(" ") ||
      primaryAddress?.address,
  );
  const sourceKey = normalizeMergeKeyPart(document.source_content_cid || document.source_page_cid || document.source_url);
  const fallbackLocationKey = normalizeMergeKeyPart(
    [document.city, document.state, document.source_content_cid].filter(Boolean).join(" "),
  );
  return `service:${providerKey}|${programKey}|${titleKey}|${geoKey || locationKey || sourceKey || fallbackLocationKey || docId}`;
}

function buildServiceGeoMergeKey(document: CorpusDocument, primaryAddress?: ReturnType<typeof getPrimaryAddress>): string {
  const latitude = primaryAddress?.geo?.lat ?? document.geo_lat;
  const longitude = primaryAddress?.geo?.lon ?? document.geo_lon;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return "";
  }
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

function normalizeMergeKeyPart(value: string | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function computeDocumentDistanceMiles(
  document: CorpusDocument,
  currentCoordinates?: SearchCoordinates,
): number | undefined {
  if (!currentCoordinates || !isServiceDocument(document)) {
    return undefined;
  }
  if (typeof document.geo_lat !== "number" || typeof document.geo_lon !== "number") {
    return undefined;
  }
  return haversineMiles(currentCoordinates, { lat: document.geo_lat, lon: document.geo_lon });
}

function proximityScore(distanceMiles: number | undefined, document: CorpusDocument): number {
  if (distanceMiles == null || !Number.isFinite(distanceMiles) || !isServiceDocument(document)) {
    return 0;
  }
  if (distanceMiles <= 1) return 1.35;
  if (distanceMiles <= 3) return 1.1;
  if (distanceMiles <= 5) return 0.9;
  if (distanceMiles <= 10) return 0.65;
  if (distanceMiles <= 25) return 0.35;
  return 0.1;
}

function pickPreferredDistance(...values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!finite.length) {
    return undefined;
  }
  return Math.min(...finite);
}

function dedupeStringList(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function metadataScore(document: CorpusDocument, query: string, geoBoost: number): number {
  const loweredQuery = query.toLowerCase();
  const queryTerms = tokenizeSearchText(query);
  let score = 0;
  if (document.title.toLowerCase().includes(loweredQuery)) {
    score += 1.5;
  }
  for (const value of [document.provider_name, document.program_name, document.categories, document.city]) {
    if (value && value.toLowerCase().includes(loweredQuery)) {
      score += 0.5;
    }
  }
  const metadataText = getServiceSearchMetadataText(document).toLowerCase();
  if (metadataText && metadataText.includes(loweredQuery)) {
    score += 0.8;
  }
  score += Math.min(
    0.8,
    queryTerms.reduce((total, term) => total + (metadataText.includes(term) ? 0.12 : 0), 0),
  );
  if (isServiceDocument(document)) {
    score += 0.25 + getServiceRichnessScore(document);
  }
  return score + geoBoost;
}

function matchesFilters(document: CorpusDocument, filters?: SearchFilters): boolean {
  if (!filters) {
    return true;
  }
  if (filters.docTypes?.length && !filters.docTypes.includes(document.doc_type)) {
    return false;
  }
  const primaryAddress = getPrimaryAddress(document);
  const documentCity = (primaryAddress?.city || document.city || "").toLowerCase();
  const documentState = (primaryAddress?.state || document.state || "").toLowerCase();
  if (filters.city && documentCity !== filters.city.toLowerCase()) {
    return false;
  }
  if (filters.state && documentState !== filters.state.toLowerCase()) {
    return false;
  }
  if (filters.host && document.host.toLowerCase() !== filters.host.toLowerCase()) {
    return false;
  }
  return true;
}

function buildSnippet(text: string, query: string, radius = 180): string {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) {
    return "";
  }
  const terms = tokenizeSearchText(query);
  const loweredText = cleanText.toLowerCase();
  const firstHit = terms
    .map((term) => loweredText.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (firstHit === undefined) {
    return cleanText.slice(0, radius * 2);
  }
  const start = Math.max(0, firstHit - radius);
  const end = Math.min(cleanText.length, firstHit + radius);
  return `${start > 0 ? "..." : ""}${cleanText.slice(start, end)}${end < cleanText.length ? "..." : ""}`;
}

function vectorNorm(vector: Float32Array): number {
  let total = 0;
  for (const value of vector) {
    total += value * value;
  }
  return Math.sqrt(total);
}

function vectorSearchFromBundle(
  index: { count: number; dimension: number; doc_ids: string[] },
  vectors: Float32Array,
  queryEmbedding: Float32Array | number[],
  limit: number,
): Map<string, number> {
  const queryVector = queryEmbedding instanceof Float32Array ? queryEmbedding : new Float32Array(queryEmbedding);
  if (queryVector.length !== index.dimension) {
    throw new Error(`Query embedding dimension ${queryVector.length} did not match ${index.dimension}`);
  }
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0) {
    return new Map();
  }
  const ranked = rankEmbeddingBundle(index, vectors, queryVector, queryNorm);
  ranked.sort((left, right) => right.score - left.score);
  return new Map(ranked.slice(0, limit).map((row) => [row.docId, row.score]));
}

function rankEmbeddingBundle(
  index: { count: number; dimension: number; doc_ids: string[] },
  vectors: Float32Array,
  queryVector: Float32Array,
  queryNorm: number,
): RankedScore[] {
  const ranked: RankedScore[] = [];
  for (let row = 0; row < index.count; row += 1) {
    const offset = row * index.dimension;
    let dot = 0;
    let candidateNormSquared = 0;
    for (let column = 0; column < index.dimension; column += 1) {
      const value = vectors[offset + column] || 0;
      const queryValue = queryVector[column] || 0;
      dot += value * queryValue;
      candidateNormSquared += value * value;
    }
    const candidateNorm = Math.sqrt(candidateNormSquared);
    if (candidateNorm > 0) {
      ranked.push({ docId: index.doc_ids[row], score: dot / (queryNorm * candidateNorm) });
    }
  }
  return ranked;
}

function lookupGeoScores(
  query: string,
  index: {
    docsByCity: Record<string, string[]>;
    docsByState: Record<string, string[]>;
    docsByPlaceTerm: Record<string, string[]>;
  },
): Map<string, number> {
  const scores = new Map<string, number>();
  const normalizedQuery = normalizeLocationKey(query);
  const queryTerms = new Set([normalizedQuery, ...tokenizeSearchText(query).map(normalizeLocationKey)].filter(Boolean));

  for (const term of queryTerms) {
    addGeoScore(scores, index.docsByCity[term], 0.8);
    addGeoScore(scores, index.docsByState[term], 0.45);
    addGeoScore(scores, index.docsByPlaceTerm[term], 0.6);
  }

  return scores;
}

function addGeoScore(scores: Map<string, number>, docIds: string[] | undefined, increment: number): void {
  for (const docId of docIds || []) {
    scores.set(docId, (scores.get(docId) || 0) + increment);
  }
}

function normalizeLocationKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isServiceOnlySearch(filters?: SearchFilters): boolean {
  return Boolean(filters?.docTypes?.length && filters.docTypes.every((docType) => docType === "service"));
}

function dedupeIntegerList(values: number[]): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const value of values) {
    const normalized = Math.trunc(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function sameIntegerList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rankGraphCommunity(
  community: GraphCommunity,
  matchedDocumentsByCommunity: Map<string, string[]>,
  communityIdToClusterIds: Record<string, number[]>,
  query: string,
  preferredClusterIds: Set<number>,
): GraphCommunitySearchResult | null {
  const match = scoreWeightedTextSet(query, [
    { text: community.label, weight: 1.9, phraseWeight: 2.4 },
    { text: weightedTupleText(community.top_terms), weight: 1.2, phraseWeight: 1.7 },
    { text: weightedTupleText(community.top_categories), weight: 1.0, phraseWeight: 1.4 },
    { text: weightedTupleText(community.top_hosts), weight: 0.6, phraseWeight: 0.9 },
  ]);
  if (match.score <= 0) {
    return null;
  }

  const clusterIds = (communityIdToClusterIds[community.community_id] || []).map((value) => Math.trunc(value));
  const preferredOverlap = clusterIds.some((clusterId) => preferredClusterIds.has(clusterId));
  const matchedDocIds = prioritizeServiceDocIds(matchedDocumentsByCommunity.get(community.community_id) || []);
  const score =
    match.score +
    (preferredOverlap ? 1.1 : 0) +
    Math.min(0.9, community.service_count * 0.05) +
    Math.min(0.5, community.document_count * 0.015);
  return {
    community,
    clusterIds,
    matchedTerms: match.matchedTerms,
    matchedDocIds,
    score,
  };
}

function rankGraphGeoCluster(
  cluster: GraphGeoClusterRecord,
  communityById: Map<string, GraphCommunity>,
  query: string,
  preferredClusterIds: Set<number>,
): GraphGeoClusterSearchResult | null {
  const relevantCommunities = cluster.communityIds
    .map((communityId) => communityById.get(communityId))
    .filter((community): community is GraphCommunity => Boolean(community));
  const match = scoreWeightedTextSet(query, [
    { text: cluster.topCommunities.map((community) => community.label).join(" "), weight: 1.8, phraseWeight: 2.3 },
    { text: relevantCommunities.map((community) => weightedTupleText(community.top_terms)).join(" "), weight: 0.9, phraseWeight: 1.2 },
    {
      text: relevantCommunities.map((community) => weightedTupleText(community.top_categories)).join(" "),
      weight: 0.8,
      phraseWeight: 1.0,
    },
    { text: relevantCommunities.map((community) => weightedTupleText(community.top_hosts)).join(" "), weight: 0.5, phraseWeight: 0.7 },
  ]);
  if (match.score <= 0) {
    return null;
  }

  const matchedCommunityIds = relevantCommunities
    .filter((community) => communityMatchesTerms(community, match.matchedTerms))
    .map((community) => community.community_id)
    .slice(0, 12);
  const score =
    match.score +
    (preferredClusterIds.has(cluster.clusterId) ? 1.3 : 0) +
    Math.min(1.1, cluster.serviceDocumentCount * 0.01) +
    Math.min(0.7, cluster.communityCount * 0.05);
  return {
    cluster,
    matchedTerms: match.matchedTerms,
    matchedCommunityIds,
    score,
  };
}

function scoreWeightedTextSet(query: string, fields: WeightedSearchField[]): { score: number; matchedTerms: string[] } {
  const loweredQuery = query.toLowerCase();
  const queryTerms = Array.from(new Set(tokenizeSearchText(query)));
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const field of fields) {
    const normalized = field.text.toLowerCase().trim();
    if (!normalized) {
      continue;
    }
    if (loweredQuery.length > 2 && normalized.includes(loweredQuery)) {
      score += field.phraseWeight ?? field.weight * 1.5;
      matchedTerms.add(loweredQuery);
    }
    for (const term of queryTerms) {
      if (normalized.includes(term)) {
        score += field.weight;
        matchedTerms.add(term);
      }
    }
  }

  return { score, matchedTerms: [...matchedTerms] };
}

function weightedTupleText(values: Array<[string, number]>): string {
  return values.map(([label]) => label).join(" ");
}

function prioritizeServiceDocIds(docIds: string[]): string[] {
  return [...docIds]
    .sort((left, right) => {
      const leftIsService = left.startsWith("service:");
      const rightIsService = right.startsWith("service:");
      if (leftIsService === rightIsService) {
        return left.localeCompare(right);
      }
      return leftIsService ? -1 : 1;
    })
    .slice(0, 24);
}

function communityMatchesTerms(community: GraphCommunity, matchedTerms: string[]): boolean {
  if (!matchedTerms.length) {
    return true;
  }
  const haystack = [
    community.label,
    weightedTupleText(community.top_terms),
    weightedTupleText(community.top_categories),
    weightedTupleText(community.top_hosts),
  ]
    .join(" ")
    .toLowerCase();
  return matchedTerms.some((term) => haystack.includes(term.toLowerCase()));
}
