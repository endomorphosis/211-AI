import { readRuntimePrecomputedAudioManifestUrl } from "./runtimeConfig";

interface PrecomputedAudioManifest {
  responses?: PrecomputedAudioManifestEntry[];
}

interface PrecomputedAudioManifestEntry {
  id: string;
  text?: string;
  originalTexts?: string[];
  routes?: string[];
  slottedIntentIds?: string[];
  slottedCanonicalQueryTemplates?: string[];
  slottedResponseFrameIds?: string[];
  slottedResponseSignatures?: string[];
  slottedEdgeIds?: string[];
  status?: string;
  audioUrl?: string;
  mp3Url?: string;
  preferredAudioUrl?: string;
}

export interface PrecomputedAudioSlottedHints {
  intentId?: string;
  canonicalQueryTemplate?: string;
  responseFrameId?: string;
  responseSignature?: string;
  edgeId?: string;
}

interface PreparedPrecomputedAudioEntry extends PrecomputedAudioManifestEntry {
  resolvedAudioUrl: string;
  normalizedText: string;
  normalizedOriginalTexts: string[];
  normalizedRoutes: Set<string>;
  normalizedSlottedIntentIds: Set<string>;
  normalizedSlottedCanonicalQueryTemplates: Set<string>;
  normalizedSlottedResponseFrameIds: Set<string>;
  normalizedSlottedResponseSignatures: Set<string>;
  normalizedSlottedEdgeIds: Set<string>;
}

export interface PrecomputedAudioReplyMatch {
  id: string;
  audioUrl: string;
  text: string;
  matchedText: string;
  route?: string;
}

const LOCAL_PRECOMPUTED_AUDIO_MANIFEST_URL = "/assets/audio/precomputed/211-dag-indextts/manifest.json";
const DEFAULT_REMOTE_PRECOMPUTED_AUDIO_MANIFEST_URL =
  "https://huggingface.co/datasets/Publicus/211-abby-tts/resolve/main/audio/abby-tts/current/metadata/abby_tts_runtime_manifest.json";

let manifestPromise: Promise<PreparedPrecomputedAudioEntry[] | undefined> | undefined;

export async function findPrecomputedAudioReply(input: {
  candidateTexts: string[];
  routeHints?: string[];
  slottedResponse?: PrecomputedAudioSlottedHints;
}): Promise<PrecomputedAudioReplyMatch | undefined> {
  const manifest = await loadPrecomputedAudioManifest();
  if (!manifest?.length) {
    return undefined;
  }

  const normalizedCandidates = dedupeStrings(input.candidateTexts.map(normalizePrecomputedAudioText).filter(Boolean));
  if (!normalizedCandidates.length) {
    return undefined;
  }
  const normalizedRouteHints = new Set((input.routeHints || []).map(normalizeRouteHint).filter(Boolean));
  const normalizedSlottedHints = normalizeSlottedHints(input.slottedResponse);

  let bestMatch:
    | {
        entry: PreparedPrecomputedAudioEntry;
        matchedText: string;
        score: number;
      }
    | undefined;
  for (const entry of manifest) {
    const identifierScore = scoreSlottedIdentifierMatch(entry, normalizedSlottedHints);
    const matchedOriginalText = entry.normalizedOriginalTexts.find((candidate) => normalizedCandidates.includes(candidate));
    const matchedText = normalizedCandidates.find((candidate) => candidate === entry.normalizedText) || matchedOriginalText;
    if (!matchedText && identifierScore <= 0) {
      continue;
    }
    const score =
      identifierScore +
      (matchedText ? (matchedText === entry.normalizedText ? 2 : 1) : 0) +
      (hasMatchingRoute(entry.normalizedRoutes, normalizedRouteHints) ? 0.25 : 0);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        entry,
        matchedText: matchedText || "",
        score,
      };
    }
  }

  if (!bestMatch) {
    return undefined;
  }
  return {
    id: bestMatch.entry.id,
    audioUrl: bestMatch.entry.resolvedAudioUrl,
    text: bestMatch.entry.text?.trim() || bestMatch.entry.originalTexts?.[0]?.trim() || "",
    matchedText: bestMatch.matchedText,
    route: bestMatch.entry.routes?.[0],
  };
}

async function loadPrecomputedAudioManifest(): Promise<PreparedPrecomputedAudioEntry[] | undefined> {
  if (!manifestPromise) {
    manifestPromise = loadFirstAvailableManifest(getPrecomputedAudioManifestUrls()).catch((error) => {
      console.warn("Precomputed audio manifest unavailable; continuing with generated speech.", error);
      return undefined;
    });
  }
  return manifestPromise;
}

async function loadFirstAvailableManifest(urls: string[]): Promise<PreparedPrecomputedAudioEntry[] | undefined> {
  let lastError: Error | undefined;
  for (const manifestUrl of urls) {
    try {
      const response = await fetch(manifestUrl, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Precomputed audio manifest unavailable (${response.status}) at ${manifestUrl}`);
      }
      const manifest = (await response.json()) as PrecomputedAudioManifest;
      return prepareManifestEntries(manifest.responses || []);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || `Failed to load ${manifestUrl}`));
    }
  }
  if (lastError) {
    throw lastError;
  }
  return undefined;
}

function getPrecomputedAudioManifestUrls(): string[] {
  const runtimeUrl = readRuntimePrecomputedAudioManifestUrl();
  const envUrl = normalizeOptionalString(import.meta.env?.VITE_ABBY_TTS_MANIFEST_URL as string | undefined);
  return dedupeStrings(
    [runtimeUrl, envUrl, DEFAULT_REMOTE_PRECOMPUTED_AUDIO_MANIFEST_URL, LOCAL_PRECOMPUTED_AUDIO_MANIFEST_URL].filter(
      (value): value is string => Boolean(value),
    ),
  );
}

function prepareManifestEntries(entries: PrecomputedAudioManifestEntry[]): PreparedPrecomputedAudioEntry[] {
  return entries
    .map((entry) => {
      const resolvedAudioUrl = resolveAudioUrl(entry);
      if (!resolvedAudioUrl) {
        return undefined;
      }
      return {
        ...entry,
        resolvedAudioUrl,
        normalizedText: normalizePrecomputedAudioText(entry.text || ""),
        normalizedOriginalTexts: dedupeStrings((entry.originalTexts || []).map(normalizePrecomputedAudioText).filter(Boolean)),
        normalizedRoutes: new Set((entry.routes || []).map(normalizeRouteHint).filter(Boolean)),
        normalizedSlottedIntentIds: new Set((entry.slottedIntentIds || []).map(normalizeSlottedValue).filter(Boolean)),
        normalizedSlottedCanonicalQueryTemplates: new Set(
          (entry.slottedCanonicalQueryTemplates || []).map(normalizeSlottedValue).filter(Boolean),
        ),
        normalizedSlottedResponseFrameIds: new Set(
          (entry.slottedResponseFrameIds || []).map(normalizeSlottedValue).filter(Boolean),
        ),
        normalizedSlottedResponseSignatures: new Set(
          (entry.slottedResponseSignatures || []).map(normalizeSlottedValue).filter(Boolean),
        ),
        normalizedSlottedEdgeIds: new Set((entry.slottedEdgeIds || []).map(normalizeSlottedValue).filter(Boolean)),
      };
    })
    .filter((entry): entry is PreparedPrecomputedAudioEntry => Boolean(entry));
}

function resolveAudioUrl(entry: PrecomputedAudioManifestEntry): string | undefined {
  const candidate = entry.preferredAudioUrl || entry.mp3Url || entry.audioUrl;
  if (!candidate?.trim()) {
    return undefined;
  }
  try {
    return new URL(candidate, document.baseURI).toString();
  } catch {
    return candidate;
  }
}

function hasMatchingRoute(entryRoutes: Set<string>, routeHints: Set<string>): boolean {
  if (!entryRoutes.size || !routeHints.size) {
    return false;
  }
  for (const routeHint of routeHints) {
    if (entryRoutes.has(routeHint)) {
      return true;
    }
  }
  return false;
}

function normalizeSlottedHints(hints: PrecomputedAudioSlottedHints | undefined): PrecomputedAudioSlottedHints | undefined {
  if (!hints) {
    return undefined;
  }
  const normalized: PrecomputedAudioSlottedHints = {
    intentId: normalizeSlottedValue(hints.intentId),
    canonicalQueryTemplate: normalizeSlottedValue(hints.canonicalQueryTemplate),
    responseFrameId: normalizeSlottedValue(hints.responseFrameId),
    responseSignature: normalizeSlottedValue(hints.responseSignature),
    edgeId: normalizeSlottedValue(hints.edgeId),
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

function scoreSlottedIdentifierMatch(
  entry: PreparedPrecomputedAudioEntry,
  hints: PrecomputedAudioSlottedHints | undefined,
): number {
  if (!hints) {
    return 0;
  }
  let score = 0;
  if (hints.responseFrameId && entry.normalizedSlottedResponseFrameIds.has(hints.responseFrameId)) {
    score += 6;
  }
  if (hints.responseSignature && entry.normalizedSlottedResponseSignatures.has(hints.responseSignature)) {
    score += 4;
  }
  if (hints.intentId && entry.normalizedSlottedIntentIds.has(hints.intentId)) {
    score += 3;
  }
  if (hints.canonicalQueryTemplate && entry.normalizedSlottedCanonicalQueryTemplates.has(hints.canonicalQueryTemplate)) {
    score += 2.5;
  }
  if (hints.edgeId && entry.normalizedSlottedEdgeIds.has(hints.edgeId)) {
    score += 2;
  }
  return score;
}

function normalizePrecomputedAudioText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[0-9]+\]/g, " ")
    .replace(/\b(?:sources?|evidence|citations?|next steps?)\s*:[\s\S]*$/i, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRouteHint(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSlottedValue(value: string | undefined): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}