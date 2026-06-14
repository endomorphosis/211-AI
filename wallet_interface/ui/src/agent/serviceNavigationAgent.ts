import type {
  Answer211QuestionCommandInput,
  Search211ServicesCommandInput,
} from "./commandSchemas";
import type { EvidenceBundle, EvidenceItem } from "./types";
import type { GraphRagAnswer, GraphRagEvidence, SearchResult } from "../lib/graphrag";
import { build211ServiceEvidenceExcerpt } from "../lib/graphrag";
import {
  answer211InfoQuestion,
  build211InfoCitations,
  build211InfoEvidence,
  build211InfoFallbackSummary,
  search211Info,
  type GraphRagCitation,
} from "../services/graphRagService";
import type { WalletApiConfig } from "../services/walletApi";

export interface ServiceNavigationEvidence {
  query: string;
  evidence: GraphRagEvidence;
  evidenceBundle: EvidenceBundle;
  citations: GraphRagCitation[];
  recordIds: string[];
  summary: string;
  nextSteps: string[];
}

export interface ServiceNavigationSearchResponse {
  query: string;
  results: SearchResult[];
  evidenceBundle: EvidenceBundle;
  citations: GraphRagCitation[];
  recordIds: string[];
  summary: string;
  nextSteps: string[];
}

export interface ServiceNavigationAnswerResponse {
  question: string;
  answer: string;
  graphRagAnswer: GraphRagAnswer;
  evidenceBundle: EvidenceBundle;
  citations: GraphRagCitation[];
  recordIds: string[];
  usedLocalModel: boolean;
  nextSteps: string[];
  metadata?: GraphRagAnswer["metadata"];
}

export interface ServiceNavigationAgentOptions {
  useEmbedding?: boolean;
  maxTokens?: number;
  walletApiConfig?: WalletApiConfig;
}

const serviceNavigationPattern =
  /\b(211|service|services|shelter|housing|food|pantry|benefits|legal|clinic|health|transport|crisis|near me|nearby)\b/i;

export function isServiceNavigationQuestion(message: string): boolean {
  return serviceNavigationPattern.test(message);
}

export async function buildServiceNavigationEvidence(
  query: string,
  limit = 6,
  options: ServiceNavigationAgentOptions = {}
): Promise<ServiceNavigationEvidence> {
  const evidence = await build211InfoEvidence(query, limit, {
    useEmbedding: options.useEmbedding,
    walletApiConfig: options.walletApiConfig,
  });
  const citations = build211InfoCitations(evidence.results);
  const evidenceBundle = evidenceBundleFromGraphEvidence(query, evidence);
  return {
    query,
    evidence,
    evidenceBundle,
    citations,
    recordIds: evidence.results.map((result) => result.docId),
    summary: build211InfoFallbackSummary(evidence),
    nextSteps: buildServiceNavigationNextSteps(evidence.results),
  };
}

export async function searchServiceNavigation(
  input: Search211ServicesCommandInput,
  options: ServiceNavigationAgentOptions = {}
): Promise<ServiceNavigationSearchResponse> {
  const query = [input.query, input.city, input.category].filter(Boolean).join(" ");
  const results = await search211Info(query, input.limit ?? 8, {
    useEmbedding: options.useEmbedding,
    walletApiConfig: options.walletApiConfig,
  });
  const evidenceBundle = evidenceBundleFromResults(input.query, results);
  const citations = build211InfoCitations(results);
  return {
    query: input.query,
    results,
    evidenceBundle,
    citations,
    recordIds: results.map((result) => result.docId),
    summary: buildSearchSummary(input.query, results),
    nextSteps: buildServiceNavigationNextSteps(results),
  };
}

export async function answerServiceNavigationQuestion(
  input: Answer211QuestionCommandInput,
  options: ServiceNavigationAgentOptions = {}
): Promise<ServiceNavigationAnswerResponse> {
  const graphRagAnswer = await answer211InfoQuestion(input.question, {
    useLocalModel: input.useLocalModel,
    maxTokens: options.maxTokens,
    useEmbedding: options.useEmbedding ?? true,
    walletApiConfig: options.walletApiConfig,
  });
  const citations = build211InfoCitations(graphRagAnswer.evidence.results);
  const evidenceBundle = evidenceBundleFromGraphEvidence(input.question, graphRagAnswer.evidence);
  const nextSteps = buildServiceNavigationNextSteps(graphRagAnswer.evidence.results);
  const answer =
    graphRagAnswer.evidence.results.length > 0 && isNoRelevant211RecordAnswer(graphRagAnswer.answer)
      ? build211InfoFallbackSummary(graphRagAnswer.evidence)
      : graphRagAnswer.answer;
  return {
    question: graphRagAnswer.question,
    answer: appendNextSteps(answer, nextSteps),
    graphRagAnswer,
    evidenceBundle,
    citations,
    recordIds: graphRagAnswer.evidence.results.map((result) => result.docId),
    usedLocalModel: graphRagAnswer.usedLocalModel,
    nextSteps,
    metadata: graphRagAnswer.metadata,
  };
}

function isNoRelevant211RecordAnswer(answer: string): boolean {
  return /could not find (?:a )?relevant record in the local 211 corpus/i.test(answer);
}

export function evidenceBundleFromGraphEvidence(query: string, evidence: GraphRagEvidence): EvidenceBundle {
  return {
    ...evidenceBundleFromResults(query, evidence.results),
    graphNodeIds: evidence.nodes.map((node) => node.node_id),
    graphEdgeIds: evidence.edges.map((edge) => edge.edge_cid),
  };
}

export function evidenceBundleFromResults(query: string, results: SearchResult[]): EvidenceBundle {
  return {
    id: stableEvidenceBundleId(query, results),
    query,
    generatedAt: new Date().toISOString(),
    items: results.map(evidenceItemFromSearchResult),
  };
}

export function buildServiceNavigationNextSteps(results: SearchResult[]): string[] {
  if (results.length === 0) {
    return [
      "Try a more specific service type, neighborhood, or eligibility term.",
      "For urgent service navigation, contact 211 directly.",
    ];
  }

  const firstResult = results[0];
  const firstLabel = firstResult.document.provider_name || firstResult.document.title || firstResult.docId;
  return [
    `Open service detail ${firstResult.docId} to review ${firstLabel}.`,
    "After you review a record, you can ask Abby to save it or create a follow-up plan; wallet writes require confirmation.",
  ];
}

function buildSearchSummary(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `I could not find service records for "${query}" in the local 211 corpus. Try a more specific service type, city, or provider name, or contact 211 directly.`;
  }

  const matches = results
    .slice(0, 4)
    .map((result, index) => {
      const document = result.document;
      const label = document.provider_name || document.program_name || document.title || result.docId;
      return `[${index + 1}] ${label}: ${build211ServiceEvidenceExcerpt(result, 320)}`;
    })
    .join("\n\n");

  return appendNextSteps(
    `Found ${results.length} service records for "${query}".\n\n${matches}\n\nSources:\n${formatCitationList(results)}`,
    buildServiceNavigationNextSteps(results)
  );
}

function appendNextSteps(answer: string, nextSteps: string[]): string {
  if (nextSteps.length === 0 || /\nNext steps:\s*/i.test(answer)) {
    return answer;
  }
  return `${answer}\n\nNext steps:\n${nextSteps.map((step) => `- ${step}`).join("\n")}`;
}

function evidenceItemFromSearchResult(result: SearchResult): EvidenceItem {
  const document = result.document;
  const title = document.title || document.provider_name || document.program_name || result.docId;
  return {
    id: result.docId,
    title,
    source: document.source_url || document.host || "211 corpus",
    snippet: build211ServiceEvidenceExcerpt(result, 500),
    score: result.score,
    citation: {
      label: title,
      url: document.source_url || undefined,
      contentCid: result.contentCid || document.source_content_cid || undefined,
      pageCid: result.pageCid || document.source_page_cid || undefined,
      docId: result.docId,
    },
  };
}

function formatCitationList(results: SearchResult[]): string {
  return build211InfoCitations(results)
    .slice(0, 6)
    .map((citation) => {
      const source = citation.url || citation.contentCid || citation.pageCid || citation.docId;
      return `${citation.label} ${citation.title} - ${source}`;
    })
    .join("\n");
}

function stableEvidenceBundleId(query: string, results: SearchResult[]): string {
  const key = [query, ...results.map((result) => `${result.docId}:${result.contentCid}`)].join("|");
  return `evidence-${hashString(key)}`;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
