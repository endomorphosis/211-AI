import type {
  AgentMessage,
  AgentPermissionLevel,
  AgentToolDefinition,
  EvidenceBundle,
  EvidenceItem,
  SurfaceContext
} from "./types";
import { hasPermissionLevel, isRecord } from "./types";

export type PromptRedactionCategory =
  | "private_wallet_context"
  | "precise_location"
  | "private_notes"
  | "document_contents"
  | "provider_conversations"
  | "raw_query_history"
  | "unsupported_value";

export interface PromptRedaction {
  path: string;
  category: PromptRedactionCategory;
  reason: string;
}

export interface PromptGuardAllowances {
  includePrivateWalletContext?: boolean;
  includePreciseLocation?: boolean;
  includePrivateNotes?: boolean;
  includeDocumentContents?: boolean;
  includeProviderConversations?: boolean;
  includeRawQueryHistory?: boolean;
}

export interface PromptGuardLimits {
  maxTextLength?: number;
  maxMetadataStringLength?: number;
  maxIdListItems?: number;
  maxHistoryMessages?: number;
  maxHistoryCharacters?: number;
  maxEvidenceBundles?: number;
  maxEvidenceItemsPerBundle?: number;
  maxTools?: number;
}

export type PromptGuardOptions = PromptGuardAllowances & PromptGuardLimits;

export type SafePromptMetadataValue =
  | string
  | number
  | boolean
  | string[]
  | { [key: string]: SafePromptMetadataValue };

export interface SafeSurfaceContext {
  route: SurfaceContext["route"];
  routeLabel: string;
  capturedAt: string;
  permissionLevel: AgentPermissionLevel;
  walletUnlocked: boolean;
  privateContextAllowed: boolean;
  summary?: string;
  selectedServiceDocId?: string;
  selectedRecordId?: string;
  selectedRecipientId?: string;
  selectedAccessRequestId?: string;
  selectedProofId?: string;
  visibleRecordIds?: string[];
  visibleServiceDocIds?: string[];
  metadata?: Record<string, SafePromptMetadataValue>;
  redactions: string[];
}

export interface CompactedConversationMessage {
  role: AgentMessage["role"];
  content: string;
  createdAt: string;
  status: AgentMessage["status"];
}

const DEFAULT_MAX_HISTORY_MESSAGES = 10;
const DEFAULT_MAX_HISTORY_CHARACTERS = 6000;
const DEFAULT_MAX_EVIDENCE_BUNDLES = 3;
const DEFAULT_MAX_EVIDENCE_ITEMS_PER_BUNDLE = 5;
const DEFAULT_MAX_TOOLS = 20;
const DEFAULT_MAX_TEXT_LENGTH = 1200;
const DEFAULT_MAX_METADATA_STRING_LENGTH = 180;
const DEFAULT_MAX_ID_LIST_ITEMS = 12;

const privateRouteSummaryRoutes = new Set<SurfaceContext["route"]>([
  "home",
  "register",
  "check-in",
  "contacts",
  "sharing-rules",
  "uploads",
  "settings",
  "recipient-access",
  "analytics",
  "proof-center",
  "exports",
  "security",
  "audit"
]);

const safeMetadataKeyPattern = /(count|enabled|status|selected|visible|unlocked|allowed|route|active|pending|total)$/i;

const categoryKeyPatterns: Array<{ category: PromptRedactionCategory; pattern: RegExp }> = [
  {
    category: "precise_location",
    pattern: /(address|coordinates?|currentlocation|geo|gps|lat|latitude|lng|lon|longitude|preciselocation|street|zip|postal)/i
  },
  {
    category: "private_notes",
    pattern: /(case.?notes?|medical.?notes?|notes?.?record|private.?notes?|staff.?notes?|\bnotes?\b)/i
  },
  {
    category: "document_contents",
    pattern: /(attachment|body|content|contents|decrypted|document|extract(ed)?text|file|fulltext|image|ocr|page.?text|photo|raw.?text|upload)/i
  },
  {
    category: "provider_conversations",
    pattern: /(caseworker|conversation|counselor|interaction|message.?thread|provider.?conversation|staff.?contact|transcript)/i
  },
  {
    category: "private_wallet_context",
    pattern:
      /(access.?request|benefits?|birth|check.?in|contact|disclosure|eligibility|email|grant|health|legal|medical|name|phone|policy|profile|pronouns|proof|recipient|saved.?service|shelter|ssn|wallet)/i
  }
];

const textRedactionPatterns: Array<{ category: PromptRedactionCategory; pattern: RegExp; replacement: string }> = [
  {
    category: "precise_location",
    pattern:
      /\b\d{1,6}\s+[A-Za-z0-9.' -]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl|way|circle|cir)\b/gi,
    replacement: "[redacted precise location]"
  },
  {
    category: "precise_location",
    pattern: /\b-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b/g,
    replacement: "[redacted precise location]"
  },
  {
    category: "private_wallet_context",
    pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[redacted private contact]"
  },
  {
    category: "private_wallet_context",
    pattern: /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[redacted private contact]"
  },
  {
    category: "private_wallet_context",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[redacted private identifier]"
  },
  {
    category: "private_notes",
    pattern: /\b(?:private\s+)?notes?\s*:\s*[^.\n]+/gi,
    replacement: "[redacted private notes]"
  },
  {
    category: "document_contents",
    pattern: /\b(?:document|file|attachment|transcript|full text|contents?)\s*:\s*[^.\n]+/gi,
    replacement: "[redacted document contents]"
  }
];

export function canIncludePrivateWalletContext(context: SurfaceContext, options: PromptGuardAllowances = {}): boolean {
  return Boolean(
    options.includePrivateWalletContext &&
      context.privateContextAllowed &&
      hasPermissionLevel(context.permissionLevel, "wallet_private")
  );
}

export function buildPromptSafeSurfaceContext(
  context: SurfaceContext,
  options: PromptGuardOptions = {}
): SafeSurfaceContext {
  const redactions: PromptRedaction[] = [];
  const includePrivateWalletContext = canIncludePrivateWalletContext(context, options);
  const guardOptions = {
    ...options,
    includePrivateWalletContext,
    includePreciseLocation: includePrivateWalletContext && options.includePreciseLocation,
    includePrivateNotes: includePrivateWalletContext && options.includePrivateNotes,
    includeDocumentContents: includePrivateWalletContext && options.includeDocumentContents,
    includeProviderConversations: includePrivateWalletContext && options.includeProviderConversations
  };
  const promptPermissionLevel = includePrivateWalletContext ? context.permissionLevel : capPermissionLevel(context.permissionLevel);
  const maxMetadataStringLength = options.maxMetadataStringLength ?? DEFAULT_MAX_METADATA_STRING_LENGTH;

  const metadata = sanitizePromptMetadata(context.metadata, "metadata", guardOptions, redactions);

  if (!includePrivateWalletContext && context.privateContextAllowed) {
    redactions.push({
      path: "surfaceContext",
      category: "private_wallet_context",
      reason: "Private wallet context is available but was not explicitly allowed for this prompt."
    });
  }

  return {
    route: context.route,
    routeLabel: context.routeLabel,
    capturedAt: context.capturedAt,
    permissionLevel: promptPermissionLevel,
    walletUnlocked: context.walletUnlocked,
    privateContextAllowed: includePrivateWalletContext,
    summary: sanitizeSurfaceSummary(context, guardOptions, redactions),
    selectedServiceDocId: context.selectedServiceDocId,
    selectedRecordId: includePrivateWalletContext ? context.selectedRecordId : redactOptionalId(context.selectedRecordId, "selectedRecordId", redactions),
    selectedRecipientId: includePrivateWalletContext
      ? context.selectedRecipientId
      : redactOptionalId(context.selectedRecipientId, "selectedRecipientId", redactions),
    selectedAccessRequestId: includePrivateWalletContext
      ? context.selectedAccessRequestId
      : redactOptionalId(context.selectedAccessRequestId, "selectedAccessRequestId", redactions),
    selectedProofId: includePrivateWalletContext ? context.selectedProofId : redactOptionalId(context.selectedProofId, "selectedProofId", redactions),
    visibleRecordIds: includePrivateWalletContext
      ? limitIdList(context.visibleRecordIds, options.maxIdListItems, maxMetadataStringLength)
      : redactOptionalIds(context.visibleRecordIds, "visibleRecordIds", redactions),
    visibleServiceDocIds: limitIdList(context.visibleServiceDocIds, options.maxIdListItems, maxMetadataStringLength),
    metadata: Object.keys(metadata).length ? metadata : undefined,
    redactions: redactions.map(formatRedaction)
  };
}

export function compactPromptConversationHistory(
  messages: AgentMessage[],
  options: PromptGuardOptions = {}
): CompactedConversationMessage[] {
  const maxMessages = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const maxCharacters = options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const completeMessages = messages.filter((message) => message.status !== "canceled");
  const selected = completeMessages.slice(-maxMessages);
  const compacted: CompactedConversationMessage[] = [];
  let remainingCharacters = maxCharacters;

  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const message = selected[index];
    if (remainingCharacters <= 0) break;

    const content = sanitizeHistoryContent(message, options, Math.min(maxTextLength, remainingCharacters));
    remainingCharacters -= content.length;
    compacted.unshift({
      role: message.role,
      content,
      createdAt: message.createdAt,
      status: message.status
    });
  }

  return compacted;
}

export function guardPromptText(value: string, path: string, options: PromptGuardOptions = {}): string {
  const redactions: PromptRedaction[] = [];
  return redactSensitiveText(value, path, options, redactions, options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH);
}

export function guardEvidenceBundles(bundles: EvidenceBundle[], options: PromptGuardOptions = {}): EvidenceBundle[] {
  const maxBundles = options.maxEvidenceBundles ?? DEFAULT_MAX_EVIDENCE_BUNDLES;
  const maxItemsPerBundle = options.maxEvidenceItemsPerBundle ?? DEFAULT_MAX_EVIDENCE_ITEMS_PER_BUNDLE;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const maxMetadataStringLength = options.maxMetadataStringLength ?? DEFAULT_MAX_METADATA_STRING_LENGTH;

  return bundles.slice(-maxBundles).map((bundle) => ({
    ...bundle,
    query: options.includeRawQueryHistory ? truncatePromptText(bundle.query, maxMetadataStringLength) : "[redacted raw query]",
    items: bundle.items.slice(0, maxItemsPerBundle).map((item) =>
      guardEvidenceItem(item, {
        ...options,
        maxTextLength,
        maxMetadataStringLength
      })
    )
  }));
}

export function guardAgentToolDefinitions(
  tools: AgentToolDefinition[],
  context: SurfaceContext,
  options: PromptGuardOptions = {}
): AgentToolDefinition[] {
  const includePrivateWalletContext = canIncludePrivateWalletContext(context, options);
  const permissionLevel = includePrivateWalletContext ? context.permissionLevel : capPermissionLevel(context.permissionLevel);
  const maxTools = options.maxTools ?? DEFAULT_MAX_TOOLS;

  return tools
    .filter((tool) => tool.surfaces.includes(context.route))
    .filter((tool) => hasPermissionLevel(permissionLevel, tool.permissionLevel))
    .filter((tool) => includePrivateWalletContext || !tool.requiresPrivateContextOptIn)
    .slice(0, maxTools);
}

export function truncatePromptText(value: string, maxLength = DEFAULT_MAX_TEXT_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 13)).trimEnd()} [truncated]`;
}

function sanitizeSurfaceSummary(
  context: SurfaceContext,
  options: PromptGuardOptions,
  redactions: PromptRedaction[]
): string | undefined {
  if (!context.summary) return undefined;
  const includePrivateWalletContext = canIncludePrivateWalletContext(context, options);
  const maxLength = options.maxMetadataStringLength ?? DEFAULT_MAX_METADATA_STRING_LENGTH;

  if (!includePrivateWalletContext && privateRouteSummaryRoutes.has(context.route)) {
    redactions.push({
      path: "summary",
      category: "private_wallet_context",
      reason: "Private route summaries are replaced unless private wallet context is explicitly allowed."
    });
    return `${context.routeLabel} surface is active.`;
  }

  return redactSensitiveText(context.summary, "summary", options, redactions, maxLength);
}

function sanitizePromptMetadata(
  metadata: SurfaceContext["metadata"],
  path: string,
  options: PromptGuardOptions,
  redactions: PromptRedaction[]
): Record<string, SafePromptMetadataValue> {
  if (!metadata) return {};

  return Object.entries(metadata).reduce<Record<string, SafePromptMetadataValue>>((safe, [key, value]) => {
    const childPath = `${path}.${key}`;
    const keyCategory = classifySensitiveKey(key);

    if (keyCategory && !isCategoryAllowed(keyCategory, options) && !safeMetadataKeyPattern.test(key)) {
      redactions.push({
        path: childPath,
        category: keyCategory,
        reason: `${keyCategory} is not explicitly allowed for this prompt.`
      });
      return safe;
    }

    const sanitized = sanitizePromptValue(value, childPath, options, redactions);
    if (sanitized === undefined) {
      redactions.push({
        path: childPath,
        category: "unsupported_value",
        reason: "Only scalar metadata, string arrays, and safe nested objects can be included in prompts."
      });
      return safe;
    }

    safe[key] = sanitized;
    return safe;
  }, {});
}

function sanitizePromptValue(
  value: unknown,
  path: string,
  options: PromptGuardOptions,
  redactions: PromptRedaction[]
): SafePromptMetadataValue | undefined {
  const maxStringLength = options.maxMetadataStringLength ?? DEFAULT_MAX_METADATA_STRING_LENGTH;

  if (typeof value === "string") {
    return redactSensitiveText(value, path, options, redactions, maxStringLength);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) {
    return limitIdList(value, options.maxIdListItems, maxStringLength) ?? [];
  }
  if (isRecord(value)) {
    const nested = sanitizePromptMetadata(value, path, options, redactions);
    return Object.keys(nested).length ? nested : undefined;
  }
  return undefined;
}

function sanitizeHistoryContent(message: AgentMessage, options: PromptGuardOptions, maxLength: number): string {
  if (!options.includeRawQueryHistory && message.role === "user") {
    return "[redacted prior user query]";
  }
  if (!options.includeRawQueryHistory && message.role === "tool") {
    return "[redacted prior tool output]";
  }

  const redactions: PromptRedaction[] = [];
  return redactSensitiveText(message.content, `history.${message.id}`, options, redactions, maxLength);
}

function guardEvidenceItem(item: EvidenceItem, options: PromptGuardOptions): EvidenceItem {
  return {
    ...item,
    title: truncatePromptText(item.title, options.maxMetadataStringLength ?? DEFAULT_MAX_METADATA_STRING_LENGTH),
    source: truncatePromptText(item.source, options.maxMetadataStringLength ?? DEFAULT_MAX_METADATA_STRING_LENGTH),
    snippet: truncatePromptText(item.snippet, options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH)
  };
}

function redactSensitiveText(
  value: string,
  path: string,
  options: PromptGuardOptions,
  redactions: PromptRedaction[],
  maxLength: number
): string {
  let redacted = value;

  for (const rule of textRedactionPatterns) {
    if (isCategoryAllowed(rule.category, options)) continue;
    if (rule.pattern.test(redacted)) {
      redactions.push({
        path,
        category: rule.category,
        reason: `${rule.category} text was removed from the prompt.`
      });
      redacted = redacted.replace(rule.pattern, rule.replacement);
    }
  }

  return truncatePromptText(redacted, maxLength);
}

function classifySensitiveKey(key: string): PromptRedactionCategory | undefined {
  const normalized = key.replace(/[_\-\s]/g, "");
  return categoryKeyPatterns.find((entry) => entry.pattern.test(normalized))?.category;
}

function isCategoryAllowed(category: PromptRedactionCategory, options: PromptGuardAllowances): boolean {
  if (category === "precise_location") return Boolean(options.includePreciseLocation);
  if (category === "private_notes") return Boolean(options.includePrivateNotes);
  if (category === "document_contents") return Boolean(options.includeDocumentContents);
  if (category === "provider_conversations") return Boolean(options.includeProviderConversations);
  if (category === "raw_query_history") return Boolean(options.includeRawQueryHistory);
  if (category === "private_wallet_context") return Boolean(options.includePrivateWalletContext);
  return false;
}

function capPermissionLevel(permissionLevel: AgentPermissionLevel): AgentPermissionLevel {
  if (hasPermissionLevel(permissionLevel, "wallet_private")) return "app_context";
  return permissionLevel;
}

function redactOptionalId(
  value: string | undefined,
  path: string,
  redactions: PromptRedaction[]
): undefined {
  if (value) {
    redactions.push({
      path,
      category: "private_wallet_context",
      reason: "Wallet record identifiers are omitted unless private wallet context is explicitly allowed."
    });
  }
  return undefined;
}

function redactOptionalIds(
  values: string[] | undefined,
  path: string,
  redactions: PromptRedaction[]
): undefined {
  if (values?.length) {
    redactions.push({
      path,
      category: "private_wallet_context",
      reason: "Wallet record identifiers are omitted unless private wallet context is explicitly allowed."
    });
  }
  return undefined;
}

function limitIdList(values: string[] | undefined, maxItems = DEFAULT_MAX_ID_LIST_ITEMS, maxLength = DEFAULT_MAX_METADATA_STRING_LENGTH): string[] | undefined {
  if (!values?.length) return undefined;
  return values.slice(0, maxItems).map((value) => truncatePromptText(value, maxLength));
}

function formatRedaction(redaction: PromptRedaction): string {
  return `${redaction.path}: ${redaction.reason}`;
}
