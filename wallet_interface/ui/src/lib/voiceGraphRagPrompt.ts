import type { AgentMessage, EvidenceBundle, EvidenceItem } from "../agent/types";

const MAX_PROMPT_CHARACTERS = 3600;
const MAX_EVIDENCE_ITEMS = 6;
const MAX_USER_TEXT_CHARACTERS = 480;
const MAX_ASSISTANT_DRAFT_CHARACTERS = 900;
const MAX_EVIDENCE_SECTION_CHARACTERS = 1800;
const MAX_SNIPPET_CHARACTERS = 220;
const MAX_FALLBACK_CHARACTERS = 420;

export interface VoiceGraphRagPromptInput {
  userText: string;
  assistantText: string;
  evidenceBundles?: EvidenceBundle[];
  maxEvidenceItems?: number;
}

export interface VoiceGraphRagPromptParts {
  systemPrompt: string;
  userPrompt: string;
  fullPrompt: string;
}

const VOICE_ASSISTANT_INSTRUCTIONS = [
  "You are Abby, a helpful and empathetic voice assistant for a 211 services app.",
  "Infer the best spoken answer from the user query, the app draft, and the evidence bundle below.",
  "Use the evidence when it is relevant. Do not read raw prompt labels, JSON, URLs, CIDs, or citation IDs aloud.",
  "Keep the spoken answer natural, specific, and under 70 words. Mention that sources are shown on screen when evidence is used.",
];

export function buildVoiceGraphRagPromptParts({
  userText,
  assistantText,
  evidenceBundles = [],
  maxEvidenceItems = MAX_EVIDENCE_ITEMS,
}: VoiceGraphRagPromptInput): VoiceGraphRagPromptParts {
  const normalizedUserText = truncatePrompt(
    cleanForPrompt(userText) || "The user asked a voice question.",
    MAX_USER_TEXT_CHARACTERS,
  );
  const normalizedAssistantText = truncatePrompt(
    cleanForPrompt(stripReferenceBlocks(assistantText)) || "No draft answer was available.",
    MAX_ASSISTANT_DRAFT_CHARACTERS,
  );
  const evidenceItems = selectPromptEvidenceItems(evidenceBundles, maxEvidenceItems);
  const evidenceSection = buildEvidenceSection(evidenceItems);
  const systemPrompt = [
    ...VOICE_ASSISTANT_INSTRUCTIONS,
    "",
    `App draft answer: ${normalizedAssistantText}`,
    "Evidence bundle for reasoning:",
    evidenceSection,
  ].join("\n");
  const fullPrompt = [
    ...VOICE_ASSISTANT_INSTRUCTIONS,
    "",
    `User voice query: ${normalizedUserText}`,
    `App draft answer: ${normalizedAssistantText}`,
    "Evidence bundle for reasoning:",
    evidenceSection,
  ].join("\n");

  return {
    systemPrompt: truncatePrompt(systemPrompt, MAX_PROMPT_CHARACTERS),
    userPrompt: normalizedUserText,
    fullPrompt: truncatePrompt(fullPrompt, MAX_PROMPT_CHARACTERS),
  };
}

export function buildVoiceGraphRagPrompt({
  userText,
  assistantText,
  evidenceBundles = [],
  maxEvidenceItems = MAX_EVIDENCE_ITEMS,
}: VoiceGraphRagPromptInput): string {
  return buildVoiceGraphRagPromptParts({
    userText,
    assistantText,
    evidenceBundles,
    maxEvidenceItems,
  }).fullPrompt;
}

export function parseVoiceGraphRagPrompt(prompt: string): { systemPrompt: string; userPrompt: string } | undefined {
  const normalizedPrompt = prompt.trim();
  const userMatch = normalizedPrompt.match(/\bUser voice query:\s*([\s\S]*?)\nApp draft answer:/i);
  if (!userMatch?.[1]) {
    return undefined;
  }
  const userPrompt = cleanForPrompt(userMatch[1]);
  if (!userPrompt) {
    return undefined;
  }
  const systemPrompt = cleanForPrompt(stripUserVoiceQueryBlock(normalizedPrompt));
  if (!systemPrompt) {
    return undefined;
  }
  return { systemPrompt, userPrompt };
}

export function buildVoiceFallbackText(assistantText: string): string {
  const withoutSourceBlocks = stripReferenceBlocks(assistantText);
  return cleanForSpeech(withoutSourceBlocks).slice(0, MAX_FALLBACK_CHARACTERS).trim() || "I found an answer, but audio generation could not read it aloud.";
}

export function selectEvidenceBundlesForMessage(
  message: AgentMessage,
  evidenceBundles: EvidenceBundle[],
): EvidenceBundle[] {
  if (!message.evidenceBundleIds?.length || !evidenceBundles.length) return [];
  const bundlesById = new Map(evidenceBundles.map((bundle) => [bundle.id, bundle]));
  return message.evidenceBundleIds
    .map((bundleId) => bundlesById.get(bundleId))
    .filter((bundle): bundle is EvidenceBundle => Boolean(bundle));
}

function formatEvidenceItem(item: EvidenceItem, index: number): string {
  const citationParts = [
    item.citation?.label,
    item.citation?.docId ? `doc ${item.citation.docId}` : undefined,
    item.source,
  ].filter(Boolean);
  const citation = citationParts.length ? ` Source: ${cleanForPrompt(citationParts.join(", "))}.` : "";
  return `[${index + 1}] ${cleanForPrompt(item.title)} - ${truncatePrompt(cleanForPrompt(item.snippet), MAX_SNIPPET_CHARACTERS)}.${citation}`;
}

function buildEvidenceSection(evidenceItems: EvidenceItem[]): string {
  if (!evidenceItems.length) {
    return "No external evidence bundle was attached to this turn.";
  }
  return truncatePrompt(
    evidenceItems.map(formatEvidenceItem).join("\n"),
    MAX_EVIDENCE_SECTION_CHARACTERS,
  );
}

function selectPromptEvidenceItems(evidenceBundles: EvidenceBundle[], maxEvidenceItems: number): EvidenceItem[] {
  const limit = Math.max(0, maxEvidenceItems);
  if (!limit) return [];
  const selected: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const bundle of evidenceBundles) {
    for (const item of bundle.items) {
      const identity = evidenceItemIdentity(item);
      if (seen.has(identity)) continue;
      seen.add(identity);
      selected.push(item);
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

function evidenceItemIdentity(item: EvidenceItem): string {
  return cleanForPrompt(
    item.citation?.docId ||
      item.id ||
      item.citation?.url ||
      `${item.title}|${item.source}|${item.snippet.slice(0, 80)}`,
  ).toLowerCase();
}

function cleanForPrompt(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripReferenceBlocks(value: string): string {
  return stripHiddenVoicePrompt(value)
    .replace(/\bSources?:[\s\S]*$/i, "")
    .replace(/\bEvidence:[\s\S]*$/i, "")
    .replace(/\bCitations?:[\s\S]*$/i, "")
    .replace(/\bNext steps?:[\s\S]*$/i, "");
}

function stripHiddenVoicePrompt(value: string): string {
  if (!/\b(?:User voice query|App draft answer|Evidence bundle for reasoning):/i.test(value)) return value;
  const appDraft = value.match(/\bApp draft answer:\s*([\s\S]*?)(?:\nEvidence bundle for reasoning:|$)/i)?.[1];
  return appDraft?.trim() || "";
}

function stripUserVoiceQueryBlock(value: string): string {
  return value.replace(/\n?User voice query:\s*[\s\S]*?(\nApp draft answer:)/i, "\n$1").trim();
}

function cleanForSpeech(value: string): string {
  return cleanForPrompt(
    value
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\[[0-9]+\]/g, "")
      .replace(/\b(?:contentCid|pageCid|docId)\s*:\s*\S+/gi, ""),
  );
}

function truncatePrompt(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}
