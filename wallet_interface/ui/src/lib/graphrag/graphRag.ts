import { get211RelatedGraph } from "./corpus";
import { search211Corpus } from "./search";
import type { GraphEdge, GraphNode, GraphRagEvidence, SearchCoordinates, SearchFilters, SearchResult } from "./types";
import {
  getPrimaryAddress,
  getPrimaryEligibilityText,
  getPrimaryIntakeText,
  getPrimaryPhone,
  getPrimaryRequiredDocumentsText,
  getServiceAreaServedText,
  getServiceExtractValues,
  getServiceLocationLabel,
} from "./serviceDocument";
import { generateWalletRouterText, type WalletApiConfig } from "../../services/walletApi";

export interface GraphRagSlottedResponseMetadata extends Record<string, unknown> {
  intentId: string;
  canonicalQueryTemplate: string;
  edgeId: string;
  route: string;
  exact: boolean;
  score: number;
  responseFrameId: string;
  responseSignature: string;
  evidenceDocIds: string[];
}

export interface GraphRagAnswerMetadata extends Record<string, unknown> {
  slottedResponse?: GraphRagSlottedResponseMetadata;
}

export interface GraphRagAnswer {
  question: string;
  answer: string;
  evidence: GraphRagEvidence;
  usedLocalModel: boolean;
  metadata?: GraphRagAnswerMetadata;
}

export const DEFAULT_GRAPH_RAG_MODEL_MAX_TOKENS = 512;

interface GraphRagPromptOptions {
  maxResults?: number;
  excerptCharacters?: number;
  graphNodeLimit?: number;
  graphEdgeLimit?: number;
  slottedResponseContext?: string;
}

export async function build211GraphRagEvidence(
  query: string,
  options: {
    queryEmbedding?: Float32Array | number[];
    filters?: SearchFilters;
    limit?: number;
    preferredClusterIds?: number[];
    currentCoordinates?: SearchCoordinates;
  } = {},
): Promise<GraphRagEvidence> {
  const results = await search211Corpus(query, {
    filters: options.filters,
    mode: options.queryEmbedding ? "hybrid" : "keyword",
    queryEmbedding: options.queryEmbedding,
    limit: options.limit || 6,
    preferredClusterIds: options.preferredClusterIds,
    currentCoordinates: options.currentCoordinates,
  });
  const related = await get211RelatedGraph(results.map((result) => result.docId), {
    maxDocIds: 3,
    maxShards: 2,
    maxNodes: 80,
    maxEdges: 120,
  });
  return {
    query,
    results,
    nodes: related.nodes,
    edges: related.edges,
  };
}

export async function answerWith211GraphRag(
  question: string,
  options: {
    queryEmbedding?: Float32Array | number[];
    useLocalModel?: boolean;
    maxTokens?: number;
    walletApiConfig?: WalletApiConfig;
  } = {},
): Promise<GraphRagAnswer> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("Question is required");
  }

  const evidence = await build211GraphRagEvidence(trimmedQuestion, {
    queryEmbedding: options.queryEmbedding,
    limit: 6,
  });
  if (evidence.results.length === 0) {
    return {
      question: trimmedQuestion,
      answer: build211GraphRagFallbackAnswer(evidence.results),
      evidence,
      usedLocalModel: false,
    };
  }

  const prompt = build211GraphRagPrompt(trimmedQuestion, evidence);
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
        answer: grounded ? format211GraphRagDisplayedAnswer(answer) : build211GraphRagFallbackAnswer(evidence.results),
        evidence,
        usedLocalModel: false,
      };
    } catch (error) {
      console.warn("211 GraphRAG Hugging Face wallet router unavailable; falling back to LFM/OpenRouter path", error);
    }
  }

  try {
    const { clientLLMWorkerService } = await import("../clientLLMWorkerService");
    const rawAnswer = await clientLLMWorkerService.generateText(prompt, maxTokens);
    const answer = clean211GraphRagModelAnswer(rawAnswer);
    const grounded = isGrounded211GraphRagAnswer(answer);
    return {
      question: trimmedQuestion,
      answer: grounded ? format211GraphRagDisplayedAnswer(answer) : build211GraphRagFallbackAnswer(evidence.results),
      evidence,
      usedLocalModel: grounded && options.useLocalModel !== false && !shouldDisableLocalLlm(),
    };
  } catch (error) {
    console.warn("211 GraphRAG local model unavailable; falling back to evidence summary", error);
    return {
      question: trimmedQuestion,
      answer: build211GraphRagFallbackAnswer(evidence.results),
      evidence,
      usedLocalModel: false,
    };
  }
}

export function build211GraphRagPrompt(
  question: string,
  evidence: GraphRagEvidence,
  options: GraphRagPromptOptions = {},
): string {
  const maxResults = options.maxResults ?? 4;
  const excerptCharacters = options.excerptCharacters ?? 420;
  const evidenceBlock = evidence.results
    .slice(0, maxResults)
    .map((result, index) => {
      const document = result.document;
      const label = document.provider_name || document.program_name || document.title || document.doc_id;
      const excerpt = build211ServiceEvidenceExcerpt(result, excerptCharacters);
      return [
        `[${index + 1}] ${label}`,
        `Program: ${document.program_name || "not listed"}`,
        `Categories: ${document.categories || "not listed"}`,
        `Location: ${[document.city, document.state].filter(Boolean).join(", ") || "not listed"}`,
        `Evidence ID: ${document.doc_id || result.docId}`,
        `Excerpt: ${excerpt}`,
      ].join("\n");
    })
    .join("\n\n");

  return `You are Abby, answering a public 211 service-navigation question.
Use only the evidence below. Do not use outside knowledge.
Do not invent phone numbers, hours, addresses, eligibility rules, availability, or application steps.
This is not emergency, medical, legal, or eligibility advice.

Question: ${question}

Evidence:
${evidenceBlock}

Related graph hints:
${formatGraphContext(evidence.nodes, evidence.edges, {
  nodeLimit: options.graphNodeLimit ?? 8,
  edgeLimit: options.graphEdgeLimit ?? 8,
})}

Prerendered response-frame retrieval:
${options.slottedResponseContext || "No prerendered slotted response frame was retrieved."}

Write the answer in this format:
- Direct answer: 1-2 short sentences. Cite each factual sentence with [1], [2], etc.
- Best matches: up to 3 bullets with the provider/program and why it matches. Cite every bullet.
- Missing or confirm: one short sentence naming details the evidence does not prove, if any.

Keep it under 120 words. Return only the answer.`;
}

export function buildEvidenceSummary(results: SearchResult[]): string {
  const lead = results
    .slice(0, 4)
    .map((result, index) => {
      const document = result.document;
      const label = document.provider_name || document.program_name || document.title || result.docId;
      return `[${index + 1}] ${label}: ${build211ServiceEvidenceExcerpt(result)}`;
    })
    .join("\n\n");

  return `The strongest local 211 corpus matches are:\n\n${lead}\n\nUse the cited source pages or contact 211/the listed provider to confirm current availability and eligibility.`;
}

export function build211ServiceEvidenceExcerpt(result: SearchResult, maxCharacters = 500): string {
  const document = result.document;
  const structuredParts = [
    labeledPart("Provider", document.provider_name),
    labeledPart("Program", document.program_name || document.title),
    labeledPart("Categories", document.categories),
    labeledPart("Location", getServiceLocationLabel(document)),
    labeledPart("Address", formatStructuredAddress(result)),
    labeledPart("Phone", getPrimaryPhone(document)?.value),
    labeledPart("Hours", firstExtractValue(document.hours)),
    labeledPart("Eligibility", getPrimaryEligibilityText(document)),
    labeledPart("Intake", getPrimaryIntakeText(document)),
    labeledPart("Documents", getPrimaryRequiredDocumentsText(document)),
    labeledPart("Fees", firstExtractValue(document.fees)),
    labeledPart("Languages", firstExtractValue(document.languages)),
    labeledPart("Area served", getServiceAreaServedText(document)),
  ].filter(Boolean);
  const structuredExcerpt = structuredParts.join(". ");
  if (structuredExcerpt) {
    return cleanExcerpt(structuredExcerpt, maxCharacters);
  }
  return cleanExcerpt(cleanRaw211EvidenceText(result.snippet || document.text), maxCharacters);
}

export function build211GraphRagFallbackAnswer(results: SearchResult[]): string {
  if (results.length === 0) {
    return "I could not find a relevant record in the local 211 corpus for that question. For immediate service navigation, contact 211 directly.";
  }
  return "I found local 211 services that may help. Review the linked results below to compare options and confirm current availability and eligibility.";
}

function formatGraphContext(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: { nodeLimit?: number; edgeLimit?: number } = {},
): string {
  const visibleNodes = nodes.slice(0, options.nodeLimit ?? 18);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.node_id));
  const nodeLabels = new Map(visibleNodes.map((node) => [node.node_id, `${node.label} (${node.node_type})`]));
  const nodeLines =
    visibleNodes
      .map((node) => `- ${nodeLabels.get(node.node_id)}`)
      .join("\n") || "- None retrieved.";
  const edgeLines =
    edges
      .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
      .slice(0, options.edgeLimit ?? 18)
      .map((edge) => {
        const source = nodeLabels.get(edge.source) || edge.source;
        const target = nodeLabels.get(edge.target) || edge.target;
        return `- ${source} ${edge.relation.replace(/_/g, " ").toLowerCase()} ${target}`;
      })
      .join("\n") || "- None retrieved.";
  return `Entities:\n${nodeLines}\nRelationships:\n${edgeLines}`;
}

function shouldDisableLocalLlm(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.localStorage.getItem("211_DISABLE_LOCAL_LLM") === "true";
}

export function clean211GraphRagModelAnswer(answer: string): string {
  return answer
    .replace(/<\|[^>]+?\|>/g, "")
    .replace(/^answer:\s*/i, "")
    .trim();
}

export function format211GraphRagDisplayedAnswer(answer: string): string {
  return answer.replace(/\n+Sources:\s*[\s\S]*$/i, "").trim();
}

export function isGrounded211GraphRagAnswer(answer: string): boolean {
  return answer.length >= 24 && /\[[1-6]\]/.test(answer);
}

function cleanExcerpt(excerpt: string, maxCharacters = 500): string {
  const normalized = cleanRaw211EvidenceText(excerpt);
  if (normalized.length <= maxCharacters) return normalized;
  const truncated = normalized.slice(0, maxCharacters).replace(/\s+\S*$/, "").trim();
  return `${truncated}...`;
}

function labeledPart(label: string, value: unknown): string {
  const text = typeof value === "string" ? cleanRaw211EvidenceText(value) : "";
  return text ? `${label}: ${text}` : "";
}

function firstExtractValue(values: Parameters<typeof getServiceExtractValues>[0]): string {
  return getServiceExtractValues(values)
    .map((item) => item.value || "")
    .map(cleanRaw211EvidenceText)
    .find(Boolean) || "";
}

function formatStructuredAddress(result: SearchResult): string {
  const address = getPrimaryAddress(result.document);
  if (!address) return "";
  return cleanRaw211EvidenceText(
    [
      address.address || address.street || address.maps_query,
      address.city,
      address.state,
      address.postal_code,
    ]
      .filter(Boolean)
      .join(", "),
  );
}

function cleanRaw211EvidenceText(value: string): string {
  return value
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\b(?:Source|Website|URL|CID|contentCid|pageCid|docId)\s*:\s*\S+/gi, "")
    .replace(/\b(?:Email|Get Directions|Visit Website|More Details|Print & Share|Print PDF)\b/gi, " ")
    .replace(/\b(?:latitude|longitude|lat|lon)\s*[:=]?\s*-?\d+(?:\.\d+)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}
