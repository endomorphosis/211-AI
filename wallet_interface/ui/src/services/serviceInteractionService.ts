import type {
  ServiceActionDescriptor,
  ServiceActionKind,
  ServiceActionObservedStatus,
} from "./serviceActionService";
import {
  createWalletServiceInteraction,
  type WalletApiConfig,
} from "./walletApi";
import type { ServiceInteractionEvent } from "../models/abby";

export type ServiceInteractionType =
  | "viewed_service"
  | "saved_service"
  | "called_provider"
  | "texted_provider"
  | "emailed_provider"
  | "opened_map"
  | "planned_visit"
  | "created_calendar_reminder"
  | "uploaded_required_document"
  | "shared_service"
  | "shared_service_plan"
  | "provider_contacted_user"
  | "appointment_scheduled"
  | "appointment_completed"
  | "service_unavailable"
  | "needs_follow_up"
  | (string & {});

export type ServiceInteractionChannel =
  | "web"
  | "phone"
  | "sms"
  | "email"
  | "map"
  | "share"
  | "calendar"
  | "wallet"
  | (string & {});

export interface ServiceInteractionIntentContext {
  serviceDocId?: string;
  serviceTitle?: string;
  providerName?: string;
  programName?: string;
  sourceUrl?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
}

export interface ServiceInteractionIntent {
  serviceDocId: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
  providerName?: string;
  programName?: string;
  interactionType: ServiceInteractionType;
  channel?: ServiceInteractionChannel;
  counterpartyName?: string;
  counterpartyContact?: string;
  timestamp: string;
  status: string;
  outcome: string;
  notesRecordId?: string;
  nextAction?: string;
  nextFollowUpAt?: string;
  sourceActionUrl?: string;
  relatedGrantIds?: string[];
  relatedRecordIds?: string[];
  privacyLevel: string;
  metadata: Record<string, unknown>;
}

export interface ServiceInteractionIntentOptions {
  userInitiated: boolean;
  timestamp?: string | Date;
  serviceDocId?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
  providerName?: string;
  programName?: string;
  interactionType?: ServiceInteractionType;
  channel?: ServiceInteractionChannel;
  counterpartyName?: string;
  counterpartyContact?: string;
  status?: string;
  outcome?: string;
  notesRecordId?: string;
  nextAction?: string;
  nextFollowUpAt?: string;
  sourceActionUrl?: string;
  relatedGrantIds?: string[];
  relatedRecordIds?: string[];
  privacyLevel?: string;
  metadata?: Record<string, unknown>;
  observedStatus?: ServiceActionObservedStatus;
}

export interface ManualServiceInteractionIntentInput extends ServiceInteractionIntentOptions {
  context?: ServiceInteractionIntentContext;
  interactionType: ServiceInteractionType;
}

export interface ServiceInteractionIntentResult {
  ok: boolean;
  intent?: ServiceInteractionIntent;
  reason?: string;
}

export interface ServiceInteractionIntentEmitResult extends ServiceInteractionIntentResult {
  event?: ServiceInteractionEvent;
  error?: string;
}

export type ServiceInteractionIntentCreator = (
  config: WalletApiConfig,
  intent: ServiceInteractionIntent
) => Promise<ServiceInteractionEvent>;

interface ActionIntentDefaults {
  interactionType: ServiceInteractionType;
  channel: ServiceInteractionChannel;
  outcome: string;
}

const ACTION_INTENT_DEFAULTS: Record<ServiceActionKind, ActionIntentDefaults> = {
  call: {
    interactionType: "called_provider",
    channel: "phone",
    outcome: "User requested a call handoff. The browser cannot verify whether the call connected.",
  },
  text: {
    interactionType: "texted_provider",
    channel: "sms",
    outcome: "User requested a text message handoff. The browser cannot verify whether a text was sent or received.",
  },
  email: {
    interactionType: "emailed_provider",
    channel: "email",
    outcome: "User requested an email handoff. The browser cannot verify whether an email was sent or received.",
  },
  map: {
    interactionType: "opened_map",
    channel: "map",
    outcome: "User requested a map handoff. The browser cannot verify whether the user visited the location.",
  },
  share: {
    interactionType: "shared_service",
    channel: "share",
    outcome: "User requested a share handoff. The browser cannot verify who received or opened the shared details.",
  },
  calendar: {
    interactionType: "created_calendar_reminder",
    channel: "calendar",
    outcome: "User requested a calendar file handoff. The browser cannot verify whether the event was imported.",
  },
};

export function buildServiceInteractionIntent(
  action: ServiceActionDescriptor,
  options: ServiceInteractionIntentOptions
): ServiceInteractionIntentResult {
  if (!options.userInitiated) {
    return { ok: false, reason: "Interaction intents require an explicit user-initiated action." };
  }

  if (action.observedStatus === "unavailable") {
    return { ok: false, reason: "Unavailable service actions are not wallet-ready interaction intents." };
  }

  const defaults = ACTION_INTENT_DEFAULTS[action.kind];
  const context = mergeContext(action.context, options);
  const serviceDocId = clean(options.serviceDocId) || clean(context.serviceDocId);
  if (!serviceDocId) {
    return { ok: false, reason: "A serviceDocId is required to create a wallet interaction intent." };
  }

  const observedStatus = options.observedStatus ?? action.observedStatus;
  const intent: ServiceInteractionIntent = {
    serviceDocId,
    sourceContentCid: clean(options.sourceContentCid) || clean(context.sourceContentCid),
    sourcePageCid: clean(options.sourcePageCid) || clean(context.sourcePageCid),
    providerName: clean(options.providerName) || clean(context.providerName),
    programName: clean(options.programName) || clean(context.programName),
    interactionType: options.interactionType ?? defaults.interactionType,
    channel: clean(options.channel) || defaults.channel,
    counterpartyName: clean(options.counterpartyName) || clean(context.providerName) || clean(context.programName),
    counterpartyContact: clean(options.counterpartyContact) || contactFromAction(action),
    timestamp: timestampString(options.timestamp),
    status: clean(options.status) || statusForObservedStatus(observedStatus),
    outcome: clean(options.outcome) || defaults.outcome,
    notesRecordId: clean(options.notesRecordId),
    nextAction: clean(options.nextAction),
    nextFollowUpAt: clean(options.nextFollowUpAt),
    sourceActionUrl: clean(options.sourceActionUrl) || safeSourceActionUrl(action),
    relatedGrantIds: cleanList(options.relatedGrantIds),
    relatedRecordIds: cleanList(options.relatedRecordIds),
    privacyLevel: clean(options.privacyLevel) || "private",
    metadata: actionIntentMetadata(action, observedStatus, options.metadata),
  };

  return { ok: true, intent: compactIntent(intent) };
}

export function buildManualServiceInteractionIntent(
  input: ManualServiceInteractionIntentInput
): ServiceInteractionIntentResult {
  if (!input.userInitiated) {
    return { ok: false, reason: "Interaction intents require an explicit user-initiated action." };
  }

  const context = mergeContext(input.context, input);
  const serviceDocId = clean(input.serviceDocId) || clean(context.serviceDocId);
  if (!serviceDocId) {
    return { ok: false, reason: "A serviceDocId is required to create a wallet interaction intent." };
  }

  const intent: ServiceInteractionIntent = {
    serviceDocId,
    sourceContentCid: clean(input.sourceContentCid) || clean(context.sourceContentCid),
    sourcePageCid: clean(input.sourcePageCid) || clean(context.sourcePageCid),
    providerName: clean(input.providerName) || clean(context.providerName),
    programName: clean(input.programName) || clean(context.programName),
    interactionType: input.interactionType,
    channel: clean(input.channel) || "web",
    counterpartyName: clean(input.counterpartyName) || clean(context.providerName) || clean(context.programName),
    counterpartyContact: clean(input.counterpartyContact),
    timestamp: timestampString(input.timestamp),
    status: clean(input.status) || "intent_recorded",
    outcome: clean(input.outcome) || "User recorded a service interaction intent.",
    notesRecordId: clean(input.notesRecordId),
    nextAction: clean(input.nextAction),
    nextFollowUpAt: clean(input.nextFollowUpAt),
    sourceActionUrl: cleanSafeUrl(input.sourceActionUrl) || cleanSafeUrl(context.sourceUrl),
    relatedGrantIds: cleanList(input.relatedGrantIds),
    relatedRecordIds: cleanList(input.relatedRecordIds),
    privacyLevel: clean(input.privacyLevel) || "private",
    metadata: compactMetadata({
      ...input.metadata,
      recorded_by: "service_interaction_service",
      user_initiated: true,
      capture_kind: "manual",
    }),
  };

  return { ok: true, intent: compactIntent(intent) };
}

export async function emitWalletServiceInteractionIntent(
  config: WalletApiConfig,
  action: ServiceActionDescriptor,
  options: ServiceInteractionIntentOptions,
  createInteraction: ServiceInteractionIntentCreator = createWalletServiceInteraction
): Promise<ServiceInteractionIntentEmitResult> {
  const intentResult = buildServiceInteractionIntent(action, options);
  if (!intentResult.ok || !intentResult.intent) {
    return intentResult;
  }

  try {
    const event = await createInteraction(config, intentResult.intent);
    return { ok: true, intent: intentResult.intent, event };
  } catch (error) {
    return {
      ok: false,
      intent: intentResult.intent,
      reason: "Wallet interaction intent emission failed.",
      error: error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
    };
  }
}

export const buildWalletServiceInteractionIntent = buildServiceInteractionIntent;
export const captureServiceInteractionIntent = buildServiceInteractionIntent;
export const emitServiceInteractionIntent = emitWalletServiceInteractionIntent;

function actionIntentMetadata(
  action: ServiceActionDescriptor,
  observedStatus: ServiceActionObservedStatus,
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  return compactMetadata({
    ...metadata,
    recorded_by: "service_interaction_service",
    user_initiated: true,
    capture_kind: "service_action",
    action_kind: action.kind,
    action_label: action.label,
    action_handoff: action.handoff,
    action_target: action.target,
    action_rel: action.rel,
    observed_status: observedStatus,
    browser_can_observe: action.browserCanObserve,
    browser_cannot_observe: action.browserCannotObserve,
    file_name: action.fileName,
    mime_type: action.mimeType,
    has_text_payload: Boolean(action.text),
    has_share_payload: Boolean(action.shareData),
    has_calendar_payload: Boolean(action.ics),
  });
}

function statusForObservedStatus(observedStatus: ServiceActionObservedStatus): string {
  if (observedStatus === "handoff_requested" || observedStatus === "download_link_clicked") {
    return "handoff_requested";
  }
  if (observedStatus === "navigator_share_resolved" || observedStatus === "clipboard_write_resolved") {
    return "handoff_resolved";
  }
  if (observedStatus === "failed") {
    return "handoff_failed";
  }
  return "intent_recorded";
}

function mergeContext(
  context: ServiceInteractionIntentContext | undefined,
  overrides: Partial<ServiceInteractionIntentContext>
): ServiceInteractionIntentContext {
  return {
    ...context,
    serviceDocId: clean(overrides.serviceDocId) || clean(context?.serviceDocId),
    sourceContentCid: clean(overrides.sourceContentCid) || clean(context?.sourceContentCid),
    sourcePageCid: clean(overrides.sourcePageCid) || clean(context?.sourcePageCid),
    providerName: clean(overrides.providerName) || clean(context?.providerName),
    programName: clean(overrides.programName) || clean(context?.programName),
  };
}

function safeSourceActionUrl(action: ServiceActionDescriptor): string | undefined {
  if (action.kind === "share") {
    return cleanSafeUrl(action.shareData?.url) || cleanSafeUrl(action.context?.sourceUrl);
  }
  if (action.kind === "calendar") {
    return cleanSafeUrl(action.context?.sourceUrl);
  }
  if (action.kind === "text" || action.kind === "email") {
    return stripUrlQuery(action.href);
  }
  return cleanSafeUrl(action.href);
}

function contactFromAction(action: ServiceActionDescriptor): string | undefined {
  const href = action.href;
  if (!href) return undefined;
  if (action.kind === "call" && href.startsWith("tel:")) {
    return decodeUriValue(href.slice("tel:".length));
  }
  if (action.kind === "text" && href.startsWith("sms:")) {
    return decodeUriValue(href.slice("sms:".length).split("?")[0]);
  }
  if (action.kind === "email" && href.startsWith("mailto:")) {
    return decodeUriValue(href.slice("mailto:".length).split("?")[0]);
  }
  return undefined;
}

function stripUrlQuery(value: string | undefined): string | undefined {
  const safeUrl = cleanSafeUrl(value);
  if (!safeUrl) return undefined;
  const queryIndex = safeUrl.indexOf("?");
  return queryIndex >= 0 ? safeUrl.slice(0, queryIndex) : safeUrl;
}

function cleanSafeUrl(value: string | undefined): string | undefined {
  const trimmed = clean(value);
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function timestampString(value: string | Date | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const trimmed = clean(value);
  return trimmed || new Date().toISOString();
}

function compactIntent(intent: ServiceInteractionIntent): ServiceInteractionIntent {
  return {
    serviceDocId: intent.serviceDocId,
    ...(intent.sourceContentCid ? { sourceContentCid: intent.sourceContentCid } : {}),
    ...(intent.sourcePageCid ? { sourcePageCid: intent.sourcePageCid } : {}),
    ...(intent.providerName ? { providerName: intent.providerName } : {}),
    ...(intent.programName ? { programName: intent.programName } : {}),
    interactionType: intent.interactionType,
    ...(intent.channel ? { channel: intent.channel } : {}),
    ...(intent.counterpartyName ? { counterpartyName: intent.counterpartyName } : {}),
    ...(intent.counterpartyContact ? { counterpartyContact: intent.counterpartyContact } : {}),
    timestamp: intent.timestamp,
    status: intent.status,
    outcome: intent.outcome,
    ...(intent.notesRecordId ? { notesRecordId: intent.notesRecordId } : {}),
    ...(intent.nextAction ? { nextAction: intent.nextAction } : {}),
    ...(intent.nextFollowUpAt ? { nextFollowUpAt: intent.nextFollowUpAt } : {}),
    ...(intent.sourceActionUrl ? { sourceActionUrl: intent.sourceActionUrl } : {}),
    relatedGrantIds: intent.relatedGrantIds ?? [],
    relatedRecordIds: intent.relatedRecordIds ?? [],
    privacyLevel: intent.privacyLevel,
    metadata: intent.metadata,
  };
}

function compactMetadata(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    })
  );
}

function cleanList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function decodeUriValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
