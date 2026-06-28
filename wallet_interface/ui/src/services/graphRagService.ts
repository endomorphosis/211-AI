import {
  build211GraphRagFallbackAnswer,
  build211GraphRagEvidence,
  build211GraphRagPrompt,
  buildEvidenceSummary,
  get211RelatedGraph,
  clean211GraphRagModelAnswer,
  DEFAULT_GRAPH_RAG_MODEL_MAX_TOKENS,
  format211GraphRagDisplayedAnswer,
  get211CorpusBaseUrl,
  buildSlottedResponseRagContext,
  findSlottedResponseMatch,
  isGrounded211GraphRagAnswer,
  load211ArtifactManifest,
  load211DocumentsSlice,
  load211GeneratedManifest,
  ragSearchWorkerService,
  search211GraphCommunities,
  search211GraphGeoClusters,
  search211Corpus,
} from "../lib/graphrag";
import { backendDetectionWorkerService } from "../lib/backendDetectionWorkerService";
import { clientEmbeddingWorkerService } from "../lib/clientEmbeddingWorkerService";
import { resolvePreferred211SearchCoordinates, resolvePreferred211ServiceClusterIds } from "../lib/graphrag/serviceGeoPreference";
import type {
  CorpusDocument,
  GraphCommunitySearchResult,
  GraphGeoClusterSearchResult,
  GraphRagAnswer,
  GraphRagEvidence,
  SearchFilters,
  SearchResult,
  SlottedResponseMatch,
} from "../lib/graphrag";
import type { BackendDetectionStatus } from "../lib/backendDetectionWorkerService";
import { generateWalletRouterEmbeddings, generateWalletRouterText, type WalletApiConfig } from "./walletApi";

interface GraphRagRetrievalOptions {
  useEmbedding?: boolean;
  filters?: SearchFilters;
  serviceOnly?: boolean;
  fallbackToAllDocs?: boolean;
  walletApiConfig?: WalletApiConfig;
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
  llm: {
    hasWorker: boolean;
    isInitialized: boolean;
    isInitializing: boolean;
    currentModel: string;
    currentDevice: "wasm" | "webgpu" | "auto";
    capabilities: {
      webGPU: boolean;
      webGPUError?: string;
      webGPUAdapter?: {
        vendor?: string;
        architecture?: string;
        device?: string;
        description?: string;
      };
      simd: boolean;
      wasmThreads: boolean;
      crossOriginIsolated: boolean;
      sharedArrayBuffer: boolean;
    };
    error?: string;
  };
}

export interface ServiceSourceSpan {
  start: number;
  end: number;
  text: string;
}

export interface ServiceFieldProvenance {
  key: string;
  label: string;
  value: string;
  values: string[];
  confidence: number;
  extractionMethod: string;
  sourceUrl?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
  sourceSpans: ServiceSourceSpan[];
}

export interface ServiceProvenanceReport {
  serviceDocId: string;
  title: string;
  sourceUrl: string;
  sourceContentCid: string;
  sourcePageCid: string;
  buildManifestCid: string;
  documentsArtifactCid: string;
  documentCount: number;
  generatedAt: string;
  fields: ServiceFieldProvenance[];
  warnings: string[];
}

export interface ServiceProvenanceOptions {
  buildManifestCid?: string;
  documentsArtifactCid?: string;
  documentCount?: number;
  generatedAt?: string;
}

interface FieldBuildInput {
  key: string;
  label: string;
  values: string[];
  extractionMethod: string;
  confidenceWithSpan: number;
  confidenceWithoutSpan: number;
  spans?: ServiceSourceSpan[];
}

const SOURCE_FIELD_STOP_PATTERN =
  /\b(?:Eligibility|Hours|Email Address|Email|Phone\/FAX Numbers|INTAKE PROCEDURE|FEES|DOCUMENTS|AREA SERVED|SITE HOURS|Services|Other Services Offered At This Location|If you represent|Get Directions|Visit Website|Print & Share|Main phone)\b\s*:?/gi;

const PHONE_PATTERN =
  /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;
const ADDRESS_PATTERN =
  /\b\d{1,6}\s+[A-Z0-9][A-Z0-9 .'-]{2,80}\s+(?:Avenue|Ave\.?|Boulevard|Blvd\.?|Court|Ct\.?|Drive|Dr\.?|Highway|Hwy\.?|Lane|Ln\.?|Parkway|Pkwy\.?|Place|Pl\.?|Road|Rd\.?|Street|St\.?|Way)\b(?:[, ]+[A-Z][A-Z .'-]{2,50})?(?:[, ]+[A-Z]{2}\b)?(?:[, ]+\d{5}(?:-\d{4})?)?/gi;

export async function search211Info(query: string, limit = 10, options: GraphRagRetrievalOptions = {}) {
  const queryEmbedding = await tryGenerateQueryEmbedding(query, options.useEmbedding, options.walletApiConfig);
  const initialFilters = preferredServiceFilters(limit, options);
  const [preferredClusterIds, currentCoordinates] = await Promise.all([
    resolvePreferredServiceClusterIds(query, initialFilters),
    resolvePreferred211SearchCoordinates(query, { allowPrompt: true }),
  ]);
  const searchCoordinates = currentCoordinates || undefined;
  const initialResults = await withMainThreadSearchFallback(
    () =>
      ragSearchWorkerService.search(query, {
        filters: initialFilters,
        mode: queryEmbedding ? "hybrid" : "keyword",
        queryEmbedding,
        limit,
        preferredClusterIds,
        currentCoordinates: searchCoordinates,
      }),
    () =>
      search211Corpus(query, {
        filters: initialFilters,
        mode: queryEmbedding ? "hybrid" : "keyword",
        queryEmbedding,
        limit,
        preferredClusterIds,
        currentCoordinates: searchCoordinates,
      }),
  );
  if (initialResults.length > 0 || !shouldFallbackToAllDocuments(options, initialFilters)) {
    return initialResults;
  }
  const allDocumentFilters = fallbackFilters(limit, options);
  return withMainThreadSearchFallback(
    () =>
      ragSearchWorkerService.search(query, {
        filters: allDocumentFilters,
        mode: queryEmbedding ? "hybrid" : "keyword",
        queryEmbedding,
        limit,
        currentCoordinates: searchCoordinates,
      }),
    () =>
      search211Corpus(query, {
        filters: allDocumentFilters,
        mode: queryEmbedding ? "hybrid" : "keyword",
        queryEmbedding,
        limit,
        currentCoordinates: searchCoordinates,
      }),
  );
}

export async function build211InfoEvidence(query: string, limit = 6, options: GraphRagRetrievalOptions = {}) {
  const queryEmbedding = await tryGenerateQueryEmbedding(query, options.useEmbedding, options.walletApiConfig);
  const initialFilters = preferredServiceFilters(limit, options);
  const [preferredClusterIds, currentCoordinates] = await Promise.all([
    resolvePreferredServiceClusterIds(query, initialFilters),
    resolvePreferred211SearchCoordinates(query, { allowPrompt: true }),
  ]);
  const searchCoordinates = currentCoordinates || undefined;
  const initialEvidence = await withMainThreadSearchFallback(
    () =>
      ragSearchWorkerService.buildEvidence(query, {
        filters: initialFilters,
        queryEmbedding,
        limit,
        preferredClusterIds,
        currentCoordinates: searchCoordinates,
      }),
    () =>
      build211GraphRagEvidence(query, {
        filters: initialFilters,
        queryEmbedding,
        limit,
        preferredClusterIds,
        currentCoordinates: searchCoordinates,
      }),
  );
  if (initialEvidence.results.length > 0 || !shouldFallbackToAllDocuments(options, initialFilters)) {
    return initialEvidence;
  }
  const allDocumentFilters = fallbackFilters(limit, options);
  return withMainThreadSearchFallback(
    () =>
      ragSearchWorkerService.buildEvidence(query, {
        filters: allDocumentFilters,
        queryEmbedding,
        limit,
        currentCoordinates: searchCoordinates,
      }),
    () =>
      build211GraphRagEvidence(query, {
        filters: allDocumentFilters,
        queryEmbedding,
        limit,
        currentCoordinates: searchCoordinates,
      }),
  );
}

export async function search211InfoCommunities(
  query: string,
  limit = 12,
  options: Pick<GraphRagRetrievalOptions, "filters"> = {},
): Promise<GraphCommunitySearchResult[]> {
  const preferredClusterIds = await resolvePreferred211ServiceClusterIds(query, limit);
  return withMainThreadSearchFallback(
    () => ragSearchWorkerService.searchCommunities(query, { limit, preferredClusterIds }),
    () => search211GraphCommunities(query, { limit, preferredClusterIds }),
  );
}

export async function search211InfoGeoClusters(
  query: string,
  limit = 10,
  options: Pick<GraphRagRetrievalOptions, "filters"> = {},
): Promise<GraphGeoClusterSearchResult[]> {
  const preferredClusterIds = await resolvePreferred211ServiceClusterIds(query, limit);
  return withMainThreadSearchFallback(
    () => ragSearchWorkerService.searchGraphGeoClusters(query, { limit, preferredClusterIds }),
    () => search211GraphGeoClusters(query, { limit, preferredClusterIds }),
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

export function build211InfoServiceProvenance(
  document: CorpusDocument,
  options: ServiceProvenanceOptions = {},
): ServiceProvenanceReport {
  const source = {
    sourceUrl: document.source_url || "",
    sourceContentCid: document.source_content_cid || "",
    sourcePageCid: document.source_page_cid || "",
  };
  const fields = [
    buildField(document, source, {
      key: "title",
      label: "Title",
      values: [document.title],
      extractionMethod: "corpus_document.title",
      confidenceWithSpan: 0.97,
      confidenceWithoutSpan: 0.88,
    }),
    buildField(document, source, {
      key: "provider_name",
      label: "Provider",
      values: [document.provider_name],
      extractionMethod: "corpus_document.provider_name",
      confidenceWithSpan: 0.96,
      confidenceWithoutSpan: 0.86,
    }),
    buildField(document, source, {
      key: "program_name",
      label: "Program",
      values: [document.program_name],
      extractionMethod: "corpus_document.program_name",
      confidenceWithSpan: 0.96,
      confidenceWithoutSpan: 0.86,
    }),
    buildField(document, source, {
      key: "categories",
      label: "Categories",
      values: splitCategories(document.categories),
      extractionMethod: "corpus_document.categories",
      confidenceWithSpan: 0.9,
      confidenceWithoutSpan: 0.78,
    }),
    buildField(document, source, {
      key: "location",
      label: "Location",
      values: [[document.city, document.state].filter(Boolean).join(", ")],
      extractionMethod: "corpus_document.city_state",
      confidenceWithSpan: 0.84,
      confidenceWithoutSpan: 0.68,
    }),
    buildField(document, source, {
      key: "source_url",
      label: "Source URL",
      values: [document.source_url],
      extractionMethod: "corpus_document.source_url",
      confidenceWithSpan: 0.99,
      confidenceWithoutSpan: 0.94,
    }),
    buildField(document, source, {
      key: "phones",
      label: "Phone",
      values: regexSpanValues(document.text, PHONE_PATTERN).map((span) => span.text),
      spans: regexSpanValues(document.text, PHONE_PATTERN),
      extractionMethod: "regex.phone",
      confidenceWithSpan: 0.93,
      confidenceWithoutSpan: 0.65,
    }),
    buildField(document, source, {
      key: "emails",
      label: "Email",
      values: regexSpanValues(document.text, EMAIL_PATTERN).map((span) => trimTrailingPunctuation(span.text)),
      spans: regexSpanValues(document.text, EMAIL_PATTERN),
      extractionMethod: "regex.email",
      confidenceWithSpan: 0.94,
      confidenceWithoutSpan: 0.65,
    }),
    buildField(document, source, {
      key: "websites",
      label: "Website",
      values: uniqueValues([
        document.source_url,
        ...regexSpanValues(document.text, URL_PATTERN).map((span) => trimTrailingPunctuation(span.text)),
      ]),
      spans: regexSpanValues(document.text, URL_PATTERN),
      extractionMethod: "regex.url",
      confidenceWithSpan: 0.94,
      confidenceWithoutSpan: document.source_url ? 0.9 : 0.6,
    }),
    buildField(document, source, {
      key: "addresses",
      label: "Address",
      values: regexSpanValues(document.text, ADDRESS_PATTERN).map((span) => trimTrailingPunctuation(span.text)),
      spans: regexSpanValues(document.text, ADDRESS_PATTERN),
      extractionMethod: "regex.street_address",
      confidenceWithSpan: 0.82,
      confidenceWithoutSpan: 0.58,
    }),
    buildField(document, source, {
      key: "hours",
      label: "Hours",
      values: labeledSpanValues(document.text, ["Hours", "SITE HOURS"]).map((span) => span.text),
      spans: labeledSpanValues(document.text, ["Hours", "SITE HOURS"]),
      extractionMethod: "label.hours",
      confidenceWithSpan: 0.8,
      confidenceWithoutSpan: 0.58,
    }),
    buildField(document, source, {
      key: "eligibility",
      label: "Eligibility",
      values: labeledSpanValues(document.text, ["Eligibility"]).map((span) => span.text),
      spans: labeledSpanValues(document.text, ["Eligibility"]),
      extractionMethod: "label.eligibility",
      confidenceWithSpan: 0.82,
      confidenceWithoutSpan: 0.58,
    }),
    buildField(document, source, {
      key: "intake_steps",
      label: "Intake steps",
      values: labeledSpanValues(document.text, ["INTAKE PROCEDURE"]).map((span) => span.text),
      spans: labeledSpanValues(document.text, ["INTAKE PROCEDURE"]),
      extractionMethod: "label.intake_procedure",
      confidenceWithSpan: 0.8,
      confidenceWithoutSpan: 0.58,
    }),
    buildField(document, source, {
      key: "required_documents",
      label: "Required documents",
      values: labeledSpanValues(document.text, ["DOCUMENTS"]).map((span) => span.text),
      spans: labeledSpanValues(document.text, ["DOCUMENTS"]),
      extractionMethod: "label.documents",
      confidenceWithSpan: 0.8,
      confidenceWithoutSpan: 0.58,
    }),
    buildField(document, source, {
      key: "fees",
      label: "Fees",
      values: labeledSpanValues(document.text, ["FEES"]).map((span) => span.text),
      spans: labeledSpanValues(document.text, ["FEES"]),
      extractionMethod: "label.fees",
      confidenceWithSpan: 0.78,
      confidenceWithoutSpan: 0.56,
    }),
    buildField(document, source, {
      key: "source_summary",
      label: "Source summary",
      values: [document.text.replace(/\s+/g, " ").trim().slice(0, 360)],
      spans: firstTextSpan(document.text, 360),
      extractionMethod: "corpus_document.text",
      confidenceWithSpan: document.text_truncated ? 0.72 : 0.86,
      confidenceWithoutSpan: 0.55,
    }),
  ].filter((field): field is ServiceFieldProvenance => Boolean(field));

  return {
    serviceDocId: document.doc_id,
    title: document.program_name || document.provider_name || document.title || document.doc_id,
    sourceUrl: source.sourceUrl,
    sourceContentCid: source.sourceContentCid,
    sourcePageCid: source.sourcePageCid,
    buildManifestCid: options.buildManifestCid || "",
    documentsArtifactCid: options.documentsArtifactCid || "",
    documentCount: options.documentCount || 0,
    generatedAt: options.generatedAt || new Date().toISOString(),
    fields,
    warnings: buildServiceProvenanceWarnings(document, fields, options),
  };
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
  return build211GraphRagFallbackAnswer(evidence.results);
}

export async function get211InfoRuntimeStatus(): Promise<GraphRagRuntimeStatus> {
  const corpusBaseUrl = get211CorpusBaseUrl();
  const [corpus, retrievalWorker, embeddingWorker, backend, llm] = await Promise.all([
    getCorpusStatus(),
    ragSearchWorkerService.getStatus(),
    clientEmbeddingWorkerService.getStatus(),
    getBackendStatus(),
    getLlmStatus(),
  ]);
  return {
    corpusBaseUrl,
    corpus,
    retrievalWorker,
    embeddingWorker,
    backend,
    llm,
  };
}

export async function answer211InfoQuestion(
  question: string,
  options: {
    useLocalModel?: boolean;
    maxTokens?: number;
    useEmbedding?: boolean;
    filters?: SearchFilters;
    serviceOnly?: boolean;
    fallbackToAllDocs?: boolean;
    walletApiConfig?: WalletApiConfig;
  } = {},
): Promise<GraphRagAnswer> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("Question is required");
  }
  const slottedResponseMatchPromise = findSlottedResponseMatch(trimmedQuestion);
  const queryEmbedding = await tryGenerateQueryEmbedding(trimmedQuestion, options.useEmbedding, options.walletApiConfig);

  const initialFilters = preferredServiceFilters(6, options);
  const preferredClusterIds = await resolvePreferredServiceClusterIds(trimmedQuestion, initialFilters);
  const initialEvidence = await withMainThreadSearchFallback(
    () =>
      ragSearchWorkerService.buildEvidence(trimmedQuestion, {
        filters: initialFilters,
        queryEmbedding,
        limit: 6,
        preferredClusterIds,
      }),
    () =>
      build211GraphRagEvidence(trimmedQuestion, {
        filters: initialFilters,
        queryEmbedding,
        limit: 6,
        preferredClusterIds,
      }),
  );
  const initialOrFallbackEvidence =
    initialEvidence.results.length > 0 || !shouldFallbackToAllDocuments(options, initialFilters)
      ? initialEvidence
      : await withMainThreadSearchFallback(
          () =>
            ragSearchWorkerService.buildEvidence(trimmedQuestion, {
              filters: fallbackFilters(6, options),
              queryEmbedding,
              limit: 6,
            }),
          () =>
            build211GraphRagEvidence(trimmedQuestion, {
              filters: fallbackFilters(6, options),
              queryEmbedding,
              limit: 6,
            }),
        );
  const slottedResponseMatch = await slottedResponseMatchPromise;
  const evidence = await mergeSlottedEvidenceResults(
    initialOrFallbackEvidence,
    trimmedQuestion,
    collectSlottedEvidenceDocIds(slottedResponseMatch),
    6,
  );
  const metadata = buildGraphRagAnswerMetadata(slottedResponseMatch);
  if (evidence.results.length === 0) {
    return {
      question: trimmedQuestion,
      answer: build211InfoFallbackSummary(evidence),
      evidence,
      usedLocalModel: false,
      metadata,
    };
  }

  const slottedResponseContext = buildSlottedResponseRagContext(slottedResponseMatch);
  const prompt = build211GraphRagPrompt(trimmedQuestion, evidence, { slottedResponseContext });
  const maxTokens = options.maxTokens || DEFAULT_GRAPH_RAG_MODEL_MAX_TOKENS;
  if (options.walletApiConfig?.actorDid) {
    try {
      const routerAnswer = await generateWalletRouterText(options.walletApiConfig, {
        prompt,
        maxNewTokens: maxTokens,
      });
      const answer = clean211GraphRagModelAnswer(routerAnswer.text);
      const grounded = isGrounded211GraphRagAnswer(answer);
      return {
        question: trimmedQuestion,
        answer: grounded ? format211GraphRagDisplayedAnswer(answer) : build211InfoFallbackSummary(evidence),
        evidence,
        usedLocalModel: false,
        metadata,
      };
    } catch (error) {
      console.warn("211 GraphRAG Hugging Face wallet router unavailable; falling back to LFM/OpenRouter path", error);
    }
  }

  try {
    const { clientLLMWorkerService } = await import("../lib/clientLLMWorkerService");
    const rawAnswer = await clientLLMWorkerService.generateText(prompt, maxTokens);
    const answer = clean211GraphRagModelAnswer(rawAnswer);
    const grounded = isGrounded211GraphRagAnswer(answer);
    return {
      question: trimmedQuestion,
      answer: grounded ? format211GraphRagDisplayedAnswer(answer) : build211InfoFallbackSummary(evidence),
      evidence,
      usedLocalModel: grounded && options.useLocalModel !== false,
      metadata,
    };
  } catch (error) {
    console.warn("211 GraphRAG local model unavailable; falling back to evidence summary", error);
    return {
      question: trimmedQuestion,
      answer: build211InfoFallbackSummary(evidence),
      evidence,
      usedLocalModel: false,
      metadata,
    };
  }
}

function buildGraphRagAnswerMetadata(slottedResponseMatch: SlottedResponseMatch | undefined): GraphRagAnswer["metadata"] {
  if (!slottedResponseMatch) {
    return undefined;
  }
  return {
    slottedResponse: {
      intentId: slottedResponseMatch.intent.id,
      canonicalQueryTemplate: slottedResponseMatch.canonicalQueryTemplate,
      edgeId: slottedResponseMatch.edge.id,
      route: slottedResponseMatch.route,
      exact: slottedResponseMatch.exact,
      score: slottedResponseMatch.score,
      responseFrameId: slottedResponseMatch.responseFrame.id,
      responseSignature: slottedResponseMatch.responseFrame.responseSignature,
      evidenceDocIds: collectSlottedEvidenceDocIds(slottedResponseMatch),
    },
  };
}

function collectSlottedEvidenceDocIds(slottedResponseMatch: SlottedResponseMatch | undefined): string[] {
  if (!slottedResponseMatch) {
    return [];
  }
  return dedupeStrings([
    ...(slottedResponseMatch.edge.evidenceDocIds || []),
    ...(slottedResponseMatch.intent.evidenceDocIds || []),
    ...(slottedResponseMatch.responseFrame.evidenceDocIds || []),
  ]).slice(0, 6);
}

async function mergeSlottedEvidenceResults(
  evidence: GraphRagEvidence,
  query: string,
  preferredDocIds: string[],
  limit: number,
): Promise<GraphRagEvidence> {
  const missingDocIds = preferredDocIds.filter((docId) => !evidence.results.some((result) => result.docId === docId));
  if (missingDocIds.length === 0) {
    return evidence;
  }
  const preferredDocuments = await load211DocumentsSlice({
    docIds: missingDocIds,
    limit: missingDocIds.length,
  });
  if (preferredDocuments.documents.length === 0) {
    return evidence;
  }

  const weakestScore =
    evidence.results.slice(0, limit).at(-1)?.score ?? evidence.results.at(-1)?.score ?? 0.2;
  const documentsById = new Map(preferredDocuments.documents.map((document) => [document.doc_id, document]));
  const injectedResults = missingDocIds
    .map((docId, index) => {
      const document = documentsById.get(docId);
      if (!document) {
        return undefined;
      }
      return buildInjectedSearchResult(document, query, weakestScore + 0.05 - index * 0.001);
    })
    .filter((result): result is SearchResult => Boolean(result));
  if (injectedResults.length === 0) {
    return evidence;
  }

  const mergedResults = [...evidence.results, ...injectedResults]
    .sort(compareMergedSearchResults)
    .slice(0, limit);
  const related = await get211RelatedGraph(mergedResults.map((result) => result.docId), {
    maxDocIds: 3,
    maxShards: 2,
    maxNodes: 80,
    maxEdges: 120,
  });
  return {
    ...evidence,
    results: mergedResults,
    nodes: related.nodes,
    edges: related.edges,
  };
}

function buildInjectedSearchResult(document: CorpusDocument, query: string, score: number): SearchResult {
  return {
    docId: document.doc_id,
    contentCid: document.source_content_cid,
    pageCid: document.source_page_cid,
    document,
    score,
    duplicateCount: 1,
    mergedDocIds: [document.doc_id],
    scoreParts: {
      keyword: 0,
      vector: 0,
      metadata: 0,
      proximity: 0,
    },
    snippet: buildInjectedSnippet(document, query),
  };
}

function buildInjectedSnippet(document: CorpusDocument, query: string): string {
  const normalizedText = document.text.replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return document.title || document.provider_name || document.program_name || document.doc_id;
  }
  const lowerQuery = query.trim().toLowerCase();
  const lowerText = normalizedText.toLowerCase();
  const hitIndex = lowerQuery ? lowerText.indexOf(lowerQuery) : -1;
  if (hitIndex < 0) {
    return normalizedText.slice(0, 360);
  }
  const start = Math.max(0, hitIndex - 120);
  const end = Math.min(normalizedText.length, hitIndex + Math.max(lowerQuery.length, 1) + 220);
  return normalizedText.slice(start, end);
}

function compareMergedSearchResults(left: SearchResult, right: SearchResult): number {
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

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function preferredServiceFilters(limit: number, options: GraphRagRetrievalOptions): SearchFilters {
  const filters: SearchFilters = { ...(options.filters || {}) };
  filters.limit = limit;
  if (!filters.docTypes?.length && options.serviceOnly !== false) {
    filters.docTypes = ["service"];
  }
  return filters;
}

function fallbackFilters(limit: number, options: GraphRagRetrievalOptions): SearchFilters {
  const filters: SearchFilters = { ...(options.filters || {}) };
  filters.limit = limit;
  if (!options.filters?.docTypes?.length) {
    delete filters.docTypes;
  }
  return filters;
}

function shouldFallbackToAllDocuments(options: GraphRagRetrievalOptions, filters: SearchFilters): boolean {
  return options.fallbackToAllDocs !== false && Boolean(filters.docTypes?.length) && !options.filters?.docTypes?.length;
}

async function resolvePreferredServiceClusterIds(query: string, filters: SearchFilters): Promise<number[]> {
  if (!filters.docTypes?.length || filters.docTypes.some((docType) => docType !== "service")) {
    return [];
  }
  return resolvePreferred211ServiceClusterIds(query);
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

async function getLlmStatus(): Promise<GraphRagRuntimeStatus["llm"]> {
  try {
    const { clientLLMWorkerService } = await import("../lib/clientLLMWorkerService");
    return clientLLMWorkerService.getStatus();
  } catch (error) {
    return {
      hasWorker: false,
      isInitialized: false,
      isInitializing: false,
      currentModel: "",
      currentDevice: "wasm",
      capabilities: {
        webGPU: false,
        simd: false,
        wasmThreads: false,
        crossOriginIsolated: Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated),
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      },
      error: error instanceof Error ? error.message : "LLM runtime status unavailable",
    };
  }
}

async function tryGenerateQueryEmbedding(
  query: string,
  enabled = false,
  walletApiConfig?: WalletApiConfig,
): Promise<Float32Array | undefined> {
  if (!enabled) {
    return undefined;
  }

  if (walletApiConfig?.actorDid) {
    try {
      const manifest = await load211GeneratedManifest();
      const response = await generateWalletRouterEmbeddings(walletApiConfig, {
        text: query,
        modelName: manifest.embeddingModel,
      });
      const embedding = response.embeddings?.[0];
      if (Array.isArray(embedding) && embedding.length === manifest.embeddingDimension) {
        return Float32Array.from(embedding);
      }
      console.warn("211 Hugging Face embeddings router returned an incompatible embedding; using browser embedding fallback");
    } catch (error) {
      console.warn("211 Hugging Face embeddings router unavailable; using browser embedding fallback", error);
    }
  }

  try {
    return await clientEmbeddingWorkerService.generateEmbedding(query);
  } catch (error) {
    console.warn("211 query embedding unavailable; using keyword retrieval only", error);
    return undefined;
  }
}

async function withMainThreadSearchFallback<
  T extends SearchResult[] | GraphRagEvidence | GraphCommunitySearchResult[] | GraphGeoClusterSearchResult[],
>(
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

function buildField(
  document: CorpusDocument,
  source: Pick<ServiceFieldProvenance, "sourceContentCid" | "sourcePageCid" | "sourceUrl">,
  input: FieldBuildInput,
): ServiceFieldProvenance | null {
  const values = uniqueValues(input.values.map((value) => cleanFieldValue(value)).filter(Boolean));
  if (values.length === 0) {
    return null;
  }
  const spans =
    input.spans && input.spans.length > 0
      ? uniqueSpans(input.spans)
      : uniqueSpans(values.flatMap((value) => findSourceSpans(document.text, value)));
  const confidence = clampConfidence(spans.length > 0 ? input.confidenceWithSpan : input.confidenceWithoutSpan);
  return {
    key: input.key,
    label: input.label,
    value: values.join("; "),
    values,
    confidence,
    extractionMethod: input.extractionMethod,
    sourceUrl: source.sourceUrl,
    sourceContentCid: source.sourceContentCid,
    sourcePageCid: source.sourcePageCid,
    sourceSpans: spans,
  };
}

function buildServiceProvenanceWarnings(
  document: CorpusDocument,
  fields: ServiceFieldProvenance[],
  options: ServiceProvenanceOptions,
): string[] {
  const fieldKeys = new Set(fields.map((field) => field.key));
  const warnings: string[] = [];
  if (!document.source_url) {
    warnings.push("Source URL is missing from this corpus record.");
  }
  if (!document.source_content_cid || !document.source_page_cid) {
    warnings.push("One or more source CIDs are missing from this corpus record.");
  }
  if (document.text_truncated) {
    warnings.push("The browser corpus marks this source text as truncated.");
  }
  if (!options.buildManifestCid) {
    warnings.push("Build manifest CID is unavailable in this browser session.");
  }
  if (!fieldKeys.has("phones") && !fieldKeys.has("emails")) {
    warnings.push("No phone or email was confidently extracted; confirm contact options on the source page or through 211.");
  }
  if (!fieldKeys.has("hours")) {
    warnings.push("Hours were not confidently extracted from this source text.");
  }
  if (!fields.some((field) => field.sourceSpans.length > 0)) {
    warnings.push("No exact source spans could be matched for extracted fields.");
  }
  warnings.push("Scrape timestamp is not included in the current browser corpus; use the build manifest CID for corpus provenance.");
  return uniqueValues(warnings);
}

function splitCategories(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function regexSpanValues(text: string, pattern: RegExp): ServiceSourceSpan[] {
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const spans: ServiceSourceSpan[] = [];
  for (const match of text.matchAll(regex)) {
    if (typeof match.index !== "number" || !match[0]) continue;
    const cleanText = trimTrailingPunctuation(match[0].replace(/\s+/g, " ").trim());
    if (!cleanText) continue;
    spans.push({ start: match.index, end: match.index + match[0].length, text: cleanText });
  }
  return uniqueSpans(spans);
}

function labeledSpanValues(text: string, labels: string[]): ServiceSourceSpan[] {
  const spans: ServiceSourceSpan[] = [];
  for (const label of labels) {
    const labelPattern = new RegExp(`\\b${escapeRegExp(label)}\\s*:\\s*`, "gi");
    for (const match of text.matchAll(labelPattern)) {
      if (typeof match.index !== "number") continue;
      const valueStart = match.index + match[0].length;
      const valueEnd = findNextFieldBoundary(text, valueStart);
      const rawValue = text.slice(valueStart, valueEnd);
      const leadingWhitespaceLength = rawValue.match(/^\s*/)?.[0].length || 0;
      const trailingWhitespaceLength = rawValue.match(/\s*$/)?.[0].length || 0;
      const start = valueStart + leadingWhitespaceLength;
      const end = Math.max(start, valueEnd - trailingWhitespaceLength);
      const cleanText = cleanFieldValue(text.slice(start, end));
      if (!cleanText) continue;
      spans.push({ start, end, text: cleanText });
    }
  }
  return uniqueSpans(spans);
}

function findNextFieldBoundary(text: string, start: number): number {
  SOURCE_FIELD_STOP_PATTERN.lastIndex = start;
  let match = SOURCE_FIELD_STOP_PATTERN.exec(text);
  while (match) {
    if (typeof match.index === "number" && match.index > start) {
      return match.index;
    }
    match = SOURCE_FIELD_STOP_PATTERN.exec(text);
  }
  return text.length;
}

function findSourceSpans(text: string, value: string): ServiceSourceSpan[] {
  const cleanValue = cleanFieldValue(value);
  if (!cleanValue) return [];
  const loweredText = text.toLowerCase();
  const loweredValue = cleanValue.toLowerCase();
  const spans: ServiceSourceSpan[] = [];
  let searchIndex = 0;
  while (searchIndex < loweredText.length) {
    const start = loweredText.indexOf(loweredValue, searchIndex);
    if (start < 0) break;
    const end = start + cleanValue.length;
    spans.push({ start, end, text: text.slice(start, end) });
    searchIndex = end;
    if (spans.length >= 3) break;
  }
  return spans;
}

function firstTextSpan(text: string, limit: number): ServiceSourceSpan[] {
  const cleanText = text.replace(/\s+/g, " ").trim();
  if (!cleanText) return [];
  const start = text.search(/\S/);
  if (start < 0) return [];
  const end = Math.min(text.length, start + limit);
  return [{ start, end, text: text.slice(start, end).replace(/\s+/g, " ").trim() }];
}

function cleanFieldValue(value: string): string {
  return trimTrailingPunctuation(value.replace(/\s+/g, " ").trim());
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:)\]]+$/g, "").trim();
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const cleanValue = cleanFieldValue(value);
    const key = cleanValue.toLowerCase();
    if (!cleanValue || seen.has(key)) continue;
    seen.add(key);
    unique.push(cleanValue);
  }
  return unique;
}

function uniqueSpans(spans: ServiceSourceSpan[]): ServiceSourceSpan[] {
  const seen = new Set<string>();
  const unique: ServiceSourceSpan[] = [];
  for (const span of spans) {
    const cleanText = cleanFieldValue(span.text);
    const key = `${span.start}:${span.end}:${cleanText.toLowerCase()}`;
    if (!cleanText || seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...span, text: cleanText });
  }
  return unique.slice(0, 4);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
