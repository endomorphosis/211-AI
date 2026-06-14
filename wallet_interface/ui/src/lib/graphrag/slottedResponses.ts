export interface SlottedResponseIndex {
  schemaVersion: number;
  sourceGeneratedAt?: string;
  embedding?: {
    provider?: string;
    model?: string;
    kind?: string;
    dimensions?: number;
  };
  summary?: Record<string, unknown>;
  intents: SlottedIntentNode[];
  responseFrames: SlottedResponseFrameNode[];
  edges: SlottedResponseEdge[];
}

export interface SlottedIntentNode {
  id: string;
  canonicalQueryTemplate: string;
  reuseCount: number;
  routes: Record<string, number>;
  evidenceDocIds?: string[];
  examples?: Array<{ recordId?: string; user?: string }>;
  embedding: SparseEmbedding;
}

export interface SlottedResponseFrameNode {
  id: string;
  responseSignature: string;
  reuseCount: number;
  routes: Record<string, number>;
  responseSlotKinds?: Record<string, number>;
  evidenceDocIds?: string[];
  examples?: Array<{ recordId?: string; assistant?: string }>;
}

export interface SlottedResponseEdge {
  id: string;
  source: string;
  target: string;
  route: string;
  reuseCount: number;
  reusable: boolean;
  evidenceDocIds?: string[];
  examples?: Array<{ recordId?: string; user?: string; assistant?: string }>;
}

export interface SlottedResponseMatch {
  canonicalQueryTemplate: string;
  score: number;
  exact: boolean;
  route: string;
  intent: SlottedIntentNode;
  responseFrame: SlottedResponseFrameNode;
  edge: SlottedResponseEdge;
}

type SparseEmbedding = Record<string, number>;

const INDEX_URL = "/assets/rag/slotted-response-index.json";
const MIN_MATCH_SCORE = 0.56;

const STOPWORDS = new Set([
  "a",
  "about",
  "am",
  "and",
  "are",
  "but",
  "can",
  "cannot",
  "do",
  "figure",
  "find",
  "for",
  "get",
  "help",
  "i",
  "in",
  "is",
  "me",
  "my",
  "near",
  "need",
  "not",
  "of",
  "or",
  "out",
  "that",
  "the",
  "thing",
  "to",
  "today",
  "what",
  "where",
  "with",
  "you",
]);

const QUERY_EXPANSIONS: Record<string, string[]> = {
  food: ["pantry", "meal", "meals", "groceries"],
  shelter: ["shelters", "homeless", "overnight", "warming"],
  shelters: ["shelter", "homeless", "overnight", "warming"],
  rent: ["eviction", "assistance"],
  benefits: ["snap", "assistance"],
  legal: ["aid", "attorney", "advocacy"],
  transport: ["ride", "transportation", "bus"],
  transportation: ["transport", "ride", "bus"],
  clinic: ["medical", "health"],
  utility: ["utilities", "heat", "electric"],
  utilities: ["utility", "heat", "electric"],
  heat: ["utility", "utilities", "electric"],
  rental: ["rent", "eviction", "assistance"],
  diaper: ["diapers", "baby"],
  diapers: ["diaper", "baby"],
  employment: ["job", "work"],
  veteran: ["veterans", "va"],
  dental: ["dentist", "clinic"],
};

const LOCATION_ALIASES = [
  "washington county",
  "multnomah county",
  "lane county",
  "oregon city",
  "albany",
  "beaverton",
  "bend",
  "clackamas",
  "eugene",
  "gresham",
  "hillsboro",
  "medford",
  "multnomah",
  "oregon",
  "portland",
  "salem",
];

const SERVICE_ALIASES = [
  "mental health",
  "rent assistance",
  "case manager",
  "child care",
  "food box",
  "safe place",
  "transportation",
  "benefits",
  "clothing",
  "clothes",
  "diapers",
  "diaper",
  "detox",
  "doctor",
  "documents",
  "food",
  "groceries",
  "housing",
  "legal",
  "meal",
  "meals",
  "medicine",
  "medication",
  "phone",
  "pregnant",
  "shelter",
  "snap",
  "suicide",
  "utility",
  "utilities",
  "wallet",
  "warm",
  "clinic",
  "job",
  "rent",
  "ride",
  "id",
];

let indexPromise: Promise<PreparedSlottedResponseIndex | undefined> | undefined;

interface PreparedSlottedResponseIndex extends SlottedResponseIndex {
  intentByTemplate: Map<string, SlottedIntentNode>;
  framesById: Map<string, SlottedResponseFrameNode>;
  edgesByIntentId: Map<string, SlottedResponseEdge[]>;
}

export async function findSlottedResponseMatch(query: string): Promise<SlottedResponseMatch | undefined> {
  const index = await loadSlottedResponseIndex();
  if (!index) return undefined;
  const canonicalQueryTemplate = canonicalQuery(query);
  const exactIntent = index.intentByTemplate.get(canonicalQueryTemplate);
  if (exactIntent) {
    const exactMatch = matchForIntent(index, exactIntent, 1, true);
    if (exactMatch) return exactMatch;
  }

  const embedding = fallbackSparseEmbedding(canonicalQueryTemplate);
  let bestIntent: SlottedIntentNode | undefined;
  let bestScore = 0;
  for (const intent of index.intents) {
    const score = cosineSparse(embedding, intent.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }
  if (!bestIntent || bestScore < MIN_MATCH_SCORE) return undefined;
  return matchForIntent(index, bestIntent, bestScore, false);
}

export function buildSlottedResponseRagContext(match: SlottedResponseMatch | undefined): string {
  if (!match) {
    return "No prerendered slotted response frame matched confidently.";
  }
  const examples = [
    ...compactExamples(match.edge.examples?.map((example) => example.assistant)),
    ...compactExamples(match.responseFrame.examples?.map((example) => example.assistant)),
  ].slice(0, 2);
  const evidenceDocIds = uniqueStrings([
    ...(match.edge.evidenceDocIds || []),
    ...(match.intent.evidenceDocIds || []),
    ...(match.responseFrame.evidenceDocIds || []),
  ]).slice(0, 8);
  return [
    `Matched canonical caller intent: ${match.canonicalQueryTemplate}`,
    `Route: ${match.route}`,
    `Match confidence: ${match.exact ? "exact slotted match" : match.score.toFixed(2)}`,
    `Reusable response frame: ${match.responseFrame.responseSignature}`,
    examples.length ? `Example wording:\n${examples.map((example) => `- ${example}`).join("\n")}` : "",
    evidenceDocIds.length ? `Preferred evidence doc IDs: ${evidenceDocIds.join(", ")}` : "",
    "Use this only as a response plan. Fill service names, phone numbers, addresses, hours, and eligibility from the cited 211 evidence above.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function loadSlottedResponseIndex(): Promise<PreparedSlottedResponseIndex | undefined> {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL, { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Slotted response index unavailable (${response.status})`);
        }
        const index = (await response.json()) as SlottedResponseIndex;
        return prepareIndex(index);
      })
      .catch((error) => {
        console.warn("211 slotted response DAG unavailable; continuing with corpus-only RAG", error);
        return undefined;
      });
  }
  return indexPromise;
}

function prepareIndex(index: SlottedResponseIndex): PreparedSlottedResponseIndex {
  const prepared = index as PreparedSlottedResponseIndex;
  prepared.intentByTemplate = new Map(index.intents.map((intent) => [intent.canonicalQueryTemplate, intent]));
  prepared.framesById = new Map(index.responseFrames.map((frame) => [frame.id, frame]));
  prepared.edgesByIntentId = new Map();
  for (const edge of index.edges) {
    const edges = prepared.edgesByIntentId.get(edge.source) || [];
    edges.push(edge);
    prepared.edgesByIntentId.set(edge.source, edges);
  }
  for (const edges of prepared.edgesByIntentId.values()) {
    edges.sort((left, right) => {
      if (left.reusable !== right.reusable) return left.reusable ? -1 : 1;
      return (right.reuseCount || 0) - (left.reuseCount || 0);
    });
  }
  return prepared;
}

function matchForIntent(
  index: PreparedSlottedResponseIndex,
  intent: SlottedIntentNode,
  score: number,
  exact: boolean,
): SlottedResponseMatch | undefined {
  const edge = index.edgesByIntentId.get(intent.id)?.[0];
  if (!edge) return undefined;
  const responseFrame = index.framesById.get(edge.target);
  if (!responseFrame) return undefined;
  return {
    canonicalQueryTemplate: intent.canonicalQueryTemplate,
    score,
    exact,
    route: edge.route,
    intent,
    responseFrame,
    edge,
  };
}

function canonicalQuery(query: string): string {
  const masked = maskQuery(query);
  const lowered = masked.toLowerCase();
  const hasService = masked.includes("{service_");
  const hasLocation = masked.includes("{location_");

  if (/\b(repeat|again|slower|missed|cut out|hard of hearing|say that)\b/.test(lowered)) {
    return lowered.includes("number") ? "Please repeat the number slowly." : "Please repeat that more slowly.";
  }
  if (/\b(borrowed|not my|two percent|battery|call drops|phone might die|might die)\b/.test(lowered)) {
    return "My phone may die; give me the most important next step.";
  }
  if (/\b(unsafe|danger|hurt|kill myself|suicide|overdose|bleeding|chest pain|threat|hitting|traffick|keeps my|made to work)\b/.test(lowered)) {
    return hasLocation ? "I may be unsafe in {location_1}; help me now." : "I may be unsafe; help me now.";
  }
  if (/\b(what city|where are you|which county|zip|address)\b/.test(lowered)) {
    return "Clarifying location or address detail.";
  }
  if (hasService && hasLocation) return "I need {service_1} in {location_1}.";
  if (hasService) return "I need {service_1}.";
  if (hasLocation) return "I am in {location_1}.";
  if (/\b(wallet|document|proof|file|upload|recover|qr)\b/.test(lowered)) {
    return "I need help with my wallet or documents.";
  }
  if (/\b(appointment|calendar|reminder|visit|meeting)\b/.test(lowered)) {
    return "I need help with an appointment or reminder.";
  }
  return masked;
}

function maskQuery(query: string): string {
  let masked = query.replace(/\s+/g, " ").trim();
  masked = masked.replace(/\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}\b/g, "{phone_1}");
  masked = masked.replace(/\b\d{5}(?:-\d{4})?\b/g, "{zip_1}");
  for (const location of LOCATION_ALIASES) {
    masked = masked.replace(new RegExp(`\\b${escapeRegExp(location)}\\b`, "gi"), "{location_1}");
  }
  for (const service of SERVICE_ALIASES) {
    masked = masked.replace(new RegExp(`\\b${escapeRegExp(service)}\\b`, "gi"), "{service_1}");
  }
  return masked.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

function fallbackSparseEmbedding(text: string, dimensions = 256): SparseEmbedding {
  const terms = expandQueryTerms(tokenize(text));
  if (!terms.length) return {};
  const counts = new Map<string, number>();
  for (const term of terms) {
    const bucket = String(stableBucket(term, dimensions));
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  const length = Math.sqrt([...counts.values()].reduce((sum, count) => sum + count * count, 0)) || 1;
  return Object.fromEntries([...counts.entries()].map(([bucket, count]) => [bucket, Number((count / length).toFixed(6))]));
}

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[a-z0-9']+/g)]
    .map((match) => match[0])
    .filter((token) => !STOPWORDS.has(token) && token.length > 1);
}

function expandQueryTerms(terms: string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    for (const candidate of [term, ...(QUERY_EXPANSIONS[term] || [])]) {
      if (!seen.has(candidate)) {
        expanded.push(candidate);
        seen.add(candidate);
      }
    }
  }
  return expanded;
}

function stableBucket(term: string, dimensions: number): number {
  let value = 2166136261;
  for (let index = 0; index < term.length; index += 1) {
    value ^= term.charCodeAt(index);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value % dimensions;
}

function cosineSparse(left: SparseEmbedding, right: SparseEmbedding): number {
  let dot = 0;
  for (const [bucket, value] of Object.entries(left)) {
    dot += value * (right[bucket] || 0);
  }
  return dot;
}

function compactExamples(values: Array<string | undefined> | undefined): string[] {
  return uniqueStrings((values || []).map((value) => cleanExample(value)).filter(Boolean));
}

function cleanExample(value: string | undefined): string {
  return (value || "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 320);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      unique.push(value);
      seen.add(value);
    }
  }
  return unique;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
