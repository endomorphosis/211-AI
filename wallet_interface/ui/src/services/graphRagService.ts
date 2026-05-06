import {
  build211GraphRagEvidence,
  build211GraphRagPrompt,
  buildEvidenceSummary,
  clean211GraphRagModelAnswer,
  get211CorpusBaseUrl,
  isGrounded211GraphRagAnswer,
  load211ArtifactManifest,
  load211GeneratedManifest,
  ragSearchWorkerService,
  search211Corpus,
} from "../lib/graphrag";
import { backendDetectionWorkerService } from "../lib/backendDetectionWorkerService";
import { clientEmbeddingWorkerService } from "../lib/clientEmbeddingWorkerService";
import type { CorpusDocument, GraphRagAnswer, GraphRagEvidence, SearchResult } from "../lib/graphrag";
import type { BackendDetectionStatus } from "../lib/backendDetectionWorkerService";

interface GraphRagRetrievalOptions {
  useEmbedding?: boolean;
}

export interface GraphRagCitation {
  index: number;
  label: string;
  title: string;
  source: string;
  docId: string;
  url?: string;
  contentCid?: string;
  pageCid?: string;
}

export interface GraphRagRuntimeStatus {
  corpusBaseUrl: string;
  corpus: {
    available: boolean;
    documentCount: number;
    embeddingCount: number;
    embeddingDimension: number;
    embeddingModel: string;
    graphNeighborhoodShardCount: number;
    buildManifestCid: string;
    error?: string;
  };
  retrievalWorker: {
    hasWorker: boolean;
    ready: boolean;
  };
  embeddingWorker: {
    hasWorker: boolean;
    isInitialized: boolean;
    modelName: string;
  };
  backend: {
    available: boolean;
    hasWorker: boolean;
    source: BackendDetectionStatus["source"];
    recommendedBackend: BackendDetectionStatus["recommendedBackend"];
    capabilities: BackendDetectionStatus["capabilities"];
    deviceInfo: BackendDetectionStatus["deviceInfo"];
    crossOriginIsolated: boolean;
    benchmarks: BackendDetectionStatus["benchmarks"];
    error?: string;
  };
}

export interface ServiceProvenanceMetadata {
  buildManifestCid: string;
  documentsArtifactCid: string;
  documentCount: number;
  loadedAt: string;
}

export interface ServiceSourceSpan {
  text: string;
  start: number;
  end: number;
}

export interface ServiceFieldProvenance {
  field: string;
  label: string;
  value: string;
  confidence: number;
  confidenceLabel: string;
  method: string;
  sourceUrl: string;
  sourceContentCid: string;
  sourcePageCid: string;
  sourceSpan?: ServiceSourceSpan;
  warning?: string;
}

export interface ServiceProvenance {
  serviceDocId: string;
  sourceUrl: string;
  sourceContentCid: string;
  sourcePageCid: string;
  buildManifestCid: string;
  documentsArtifactCid: string;
  loadedAt: string;
  documentCount: number;
  scrapeTimestamp: string;
  fields: ServiceFieldProvenance[];
}

export async function search211Info(query: string, limit = 10, options: GraphRagRetrievalOptions = {}) {
  const queryEmbedding = await tryGenerateQueryEmbedding(query, options.useEmbedding);
  return withMainThreadSearchFallback(
    () =>
      ragSearchWorkerService.search(query, {
        mode: queryEmbedding ? "hybrid" : "keyword",
        queryEmbedding,
        limit,
      }),
    () =>
      search211Corpus(query, {
        mode: queryEmbedding ? "hybrid" : "keyword",
        queryEmbedding,
        limit,
      }),
  );
}

export async function build211InfoEvidence(query: string, limit = 6, options: GraphRagRetrievalOptions = {}) {
  const queryEmbedding = await tryGenerateQueryEmbedding(query, options.useEmbedding);
  return withMainThreadSearchFallback(
    () => ragSearchWorkerService.buildEvidence(query, { queryEmbedding, limit }),
    () => build211GraphRagEvidence(query, { queryEmbedding, limit }),
  );
}

export function build211InfoCitations(results: SearchResult[]): GraphRagCitation[] {
  return results.map((result, index) => {
    const document = result.document;
    const title = document.provider_name || document.program_name || document.title || result.docId;
    const source = document.source_url || document.host || "211 corpus";
    return {
      index: index + 1,
      label: `[${index + 1}]`,
      title,
      source,
      docId: result.docId,
      url: document.source_url || undefined,
      contentCid: result.contentCid || document.source_content_cid || undefined,
      pageCid: result.pageCid || document.source_page_cid || undefined,
    };
  });
}

export function format211InfoCitations(results: SearchResult[], limit = 6): string {
  return build211InfoCitations(results)
    .slice(0, limit)
    .map((citation) => {
      const locator = citation.url || citation.contentCid || citation.pageCid || citation.docId;
      return `${citation.label} ${citation.title} - ${locator}`;
    })
    .join("\n");
}

export function build211InfoFallbackSummary(evidence: GraphRagEvidence): string {
  if (evidence.results.length === 0) {
    return "I could not find a relevant record in the local 211 corpus for that question. For immediate service navigation, contact 211 directly.";
  }
  return append211InfoSources(buildEvidenceSummary(evidence.results), evidence.results);
}

export function build211InfoServiceProvenance(
  document: CorpusDocument,
  metadata: ServiceProvenanceMetadata,
): ServiceProvenance {
  const fields = [
    buildServiceFieldProvenance(document, "provider_name", "Provider name", document.provider_name, {
      emptyWarning: "Provider name was not extracted for this record.",
    }),
    buildServiceFieldProvenance(document, "program_name", "Program name", document.program_name, {
      emptyWarning: "Program name was not extracted for this record.",
    }),
    buildServiceFieldProvenance(document, "title", "Service title", document.title),
    buildServiceFieldProvenance(document, "categories", "Categories", document.categories),
    buildServiceFieldProvenance(document, "city", "City", document.city),
    buildServiceFieldProvenance(document, "state", "State", document.state),
    buildServiceFieldProvenance(document, "source_url", "Source URL", document.source_url, {
      method: "crawler metadata with source URL match",
    }),
    buildServiceFieldProvenance(document, "summary", "Source summary", sourceSummarySpanValue(document.text), {
      method: "source document text excerpt",
      forceFirstSpan: true,
    }),
  ];

  return {
    serviceDocId: document.doc_id,
    sourceUrl: document.source_url,
    sourceContentCid: document.source_content_cid,
    sourcePageCid: document.source_page_cid,
    buildManifestCid: metadata.buildManifestCid,
    documentsArtifactCid: metadata.documentsArtifactCid,
    loadedAt: metadata.loadedAt,
    documentCount: metadata.documentCount,
    scrapeTimestamp: "Not included in the current browser corpus",
    fields,
  };
}

export async function get211InfoRuntimeStatus(): Promise<GraphRagRuntimeStatus> {
  const corpusBaseUrl = get211CorpusBaseUrl();
  const [corpus, retrievalWorker, embeddingWorker, backend] = await Promise.all([
    getCorpusStatus(),
    ragSearchWorkerService.getStatus(),
    clientEmbeddingWorkerService.getStatus(),
    getBackendStatus(),
  ]);
  return {
    corpusBaseUrl,
    corpus,
    retrievalWorker,
    embeddingWorker,
    backend,
  };
}

export async function answer211InfoQuestion(
  question: string,
  options: {
    useLocalModel?: boolean;
    maxTokens?: number;
    useEmbedding?: boolean;
  } = {},
): Promise<GraphRagAnswer> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("Question is required");
  }
  const queryEmbedding = await tryGenerateQueryEmbedding(trimmedQuestion, options.useEmbedding);

  const evidence = await withMainThreadSearchFallback(
    () => ragSearchWorkerService.buildEvidence(trimmedQuestion, { queryEmbedding, limit: 6 }),
    () => build211GraphRagEvidence(trimmedQuestion, { queryEmbedding, limit: 6 }),
  );
  if (evidence.results.length === 0) {
    return {
      question: trimmedQuestion,
      answer: build211InfoFallbackSummary(evidence),
      evidence,
      usedLocalModel: false,
    };
  }

  if (options.useLocalModel === false) {
    return {
      question: trimmedQuestion,
      answer: build211InfoFallbackSummary(evidence),
      evidence,
      usedLocalModel: false,
    };
  }

  try {
    const { clientLLMWorkerService } = await import("../lib/clientLLMWorkerService");
    const rawAnswer = await clientLLMWorkerService.generateText(
      build211GraphRagPrompt(trimmedQuestion, evidence),
      options.maxTokens || 220,
    );
    const answer = clean211GraphRagModelAnswer(rawAnswer);
    const grounded = isGrounded211GraphRagAnswer(answer);
    return {
      question: trimmedQuestion,
      answer: grounded ? append211InfoSources(answer, evidence.results) : build211InfoFallbackSummary(evidence),
      evidence,
      usedLocalModel: grounded,
    };
  } catch (error) {
    console.warn("211 GraphRAG local model unavailable; falling back to evidence summary", error);
    return {
      question: trimmedQuestion,
      answer: build211InfoFallbackSummary(evidence),
      evidence,
      usedLocalModel: false,
    };
  }
}

async function getCorpusStatus(): Promise<GraphRagRuntimeStatus["corpus"]> {
  try {
    const [artifactManifest, generatedManifest] = await Promise.all([
      load211ArtifactManifest(),
      load211GeneratedManifest(),
    ]);
    return {
      available: true,
      documentCount: generatedManifest.documentCount,
      embeddingCount: generatedManifest.embeddingCount,
      embeddingDimension: generatedManifest.embeddingDimension,
      embeddingModel: generatedManifest.embeddingModel,
      graphNeighborhoodShardCount: generatedManifest.graphNeighborhoodShardCount,
      buildManifestCid: artifactManifest.sourcePackage.build_manifest_cid,
    };
  } catch (error) {
    return {
      available: false,
      documentCount: 0,
      embeddingCount: 0,
      embeddingDimension: 0,
      embeddingModel: "",
      graphNeighborhoodShardCount: 0,
      buildManifestCid: "",
      error: error instanceof Error ? error.message : "Corpus manifest unavailable",
    };
  }
}

async function getBackendStatus(): Promise<GraphRagRuntimeStatus["backend"]> {
  return backendDetectionWorkerService.getStatus();
}

function append211InfoSources(answer: string, results: SearchResult[]): string {
  if (results.length === 0 || /\nSources:\s*/i.test(answer)) {
    return answer;
  }
  const sources = format211InfoCitations(results);
  return sources ? `${answer}\n\nSources:\n${sources}` : answer;
}

async function tryGenerateQueryEmbedding(query: string, enabled = false): Promise<Float32Array | undefined> {
  if (!enabled) {
    return undefined;
  }

  try {
    return await clientEmbeddingWorkerService.generateEmbedding(query);
  } catch (error) {
    console.warn("211 query embedding unavailable; using keyword retrieval only", error);
    return undefined;
  }
}

function buildServiceFieldProvenance(
  document: CorpusDocument,
  field: string,
  label: string,
  rawValue: string,
  options: { emptyWarning?: string; method?: string; forceFirstSpan?: boolean } = {},
): ServiceFieldProvenance {
  const value = rawValue.trim();
  const sourceSpan = options.forceFirstSpan ? firstSourceSpan(document.text, value) : findSourceSpan(document.text, value);
  const confidence = serviceFieldConfidence(value, sourceSpan);
  return {
    field,
    label,
    value,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    method: value
      ? sourceSpan
        ? options.method || "corpus metadata with exact source text span"
        : "corpus metadata; exact source text span unavailable"
      : "field not extracted from current corpus package",
    sourceUrl: document.source_url,
    sourceContentCid: document.source_content_cid,
    sourcePageCid: document.source_page_cid,
    sourceSpan,
    warning: value ? undefined : options.emptyWarning || "Field was not extracted for this record.",
  };
}

function serviceFieldConfidence(value: string, sourceSpan?: ServiceSourceSpan): number {
  if (!value) {
    return 0;
  }
  return sourceSpan ? 0.95 : 0.7;
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "High";
  if (confidence >= 0.6) return "Medium";
  if (confidence > 0) return "Low";
  return "Missing";
}

function findSourceSpan(sourceText: string, value: string): ServiceSourceSpan | undefined {
  if (!sourceText || !value) {
    return undefined;
  }
  const exactIndex = sourceText.indexOf(value);
  if (exactIndex >= 0) {
    return sourceSpanFromIndex(sourceText, exactIndex, value.length);
  }

  const lowerSource = sourceText.toLowerCase();
  const lowerValue = value.toLowerCase();
  const lowerIndex = lowerSource.indexOf(lowerValue);
  if (lowerIndex >= 0) {
    return sourceSpanFromIndex(sourceText, lowerIndex, value.length);
  }

  return undefined;
}

function firstSourceSpan(sourceText: string, value: string): ServiceSourceSpan | undefined {
  if (!sourceText || !value) {
    return undefined;
  }
  return sourceSpanFromIndex(sourceText, 0, Math.min(value.length, sourceText.length));
}

function sourceSpanFromIndex(sourceText: string, start: number, length: number): ServiceSourceSpan {
  const end = Math.min(sourceText.length, start + length);
  const previewStart = Math.max(0, start - 80);
  const previewEnd = Math.min(sourceText.length, end + 80);
  const prefix = previewStart > 0 ? "..." : "";
  const suffix = previewEnd < sourceText.length ? "..." : "";
  return {
    start,
    end,
    text: `${prefix}${sourceText.slice(previewStart, previewEnd).replace(/\s+/g, " ").trim()}${suffix}`,
  };
}

function sourceSummarySpanValue(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 360);
}

async function withMainThreadSearchFallback<T extends SearchResult[] | GraphRagEvidence>(
  workerCall: () => Promise<T>,
  fallbackCall: () => Promise<T>,
): Promise<T> {
  try {
    return await workerCall();
  } catch (error) {
    console.warn("211 GraphRAG search worker unavailable; using main-thread retrieval", error);
    return fallbackCall();
  }
}
