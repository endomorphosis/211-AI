import {
  buildIcsEvent,
  createIcsFileName,
  type IcsAlarmInput,
  type IcsEventInput,
} from "../lib/calendar/ics";

export type ServiceActionKind = "call" | "text" | "email" | "map" | "share" | "calendar";
export type ServiceMapProvider = "google" | "apple" | "geo" | "source";
export type ServiceActionHandoff = "link" | "new_window" | "web_share" | "clipboard" | "download";
export type ServiceActionObservedStatus =
  | "prepared"
  | "handoff_requested"
  | "navigator_share_resolved"
  | "clipboard_write_resolved"
  | "download_link_clicked"
  | "unavailable"
  | "failed";

export interface ServiceActionContext {
  serviceDocId?: string;
  serviceTitle?: string;
  providerName?: string;
  programName?: string;
  sourceUrl?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
}

export interface ServiceActionDescriptor {
  kind: ServiceActionKind;
  label: string;
  handoff: ServiceActionHandoff;
  observedStatus: ServiceActionObservedStatus;
  href?: string;
  target?: "_blank" | "_self";
  rel?: string;
  fileName?: string;
  mimeType?: string;
  text?: string;
  shareData?: ShareData;
  ics?: string;
  context?: ServiceActionContext;
  browserCanObserve: string[];
  browserCannotObserve: string[];
}

export interface ServiceActionInvocationResult {
  ok: boolean;
  action: ServiceActionDescriptor;
  observedStatus: ServiceActionObservedStatus;
  message: string;
  error?: string;
}

export interface CallActionInput {
  phone?: string;
  label?: string;
  context?: ServiceActionContext;
}

export interface TextActionInput extends CallActionInput {
  body?: string;
}

export interface EmailActionInput {
  email?: string;
  subject?: string;
  body?: string;
  label?: string;
  context?: ServiceActionContext;
}

export interface MapActionInput {
  query?: string;
  address?: string;
  provider?: ServiceMapProvider;
  label?: string;
  context?: ServiceActionContext;
}

export interface ShareActionInput {
  title?: string;
  text?: string;
  url?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
  context?: ServiceActionContext;
}

export interface CalendarActionInput {
  title?: string;
  notes?: string;
  startsAt?: Date | string;
  endsAt?: Date | string;
  durationMinutes?: number;
  allDay?: boolean;
  location?: string;
  url?: string;
  fileName?: string;
  alarms?: IcsAlarmInput[];
  context?: ServiceActionContext;
}

export interface ServiceActionInvokeOptions {
  window?: Window;
  navigator?: ServiceActionNavigator;
  document?: Document;
  target?: "_blank" | "_self";
}

interface ServiceActionNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
  clipboard?: Pick<Clipboard, "writeText">;
}

const CALENDAR_MIME_TYPE = "text/calendar;charset=utf-8";

export function buildCallAction(input: CallActionInput): ServiceActionDescriptor {
  const phone = formatPhoneForUri(input.phone);
  const label = input.label ?? `Call ${serviceLabel(input.context)}`;
  if (!phone) {
    return unavailableAction("call", label, "No dialable phone number is available.", input.context);
  }

  return {
    kind: "call",
    label,
    handoff: "link",
    observedStatus: "prepared",
    href: `tel:${phone}`,
    context: input.context,
    browserCanObserve: ["The tel: handoff was requested by the user."],
    browserCannotObserve: ["Whether the call connected.", "Whether anyone answered.", "What happened during the call."],
  };
}

export function buildTextAction(input: TextActionInput): ServiceActionDescriptor {
  const phone = formatPhoneForUri(input.phone);
  const label = input.label ?? `Text ${serviceLabel(input.context)}`;
  if (!phone) {
    return unavailableAction("text", label, "No dialable phone number is available for texting.", input.context);
  }

  const body = input.body?.trim();
  return {
    kind: "text",
    label,
    handoff: "link",
    observedStatus: "prepared",
    href: `sms:${phone}${body ? `?body=${encodeUriComponentStrict(body)}` : ""}`,
    text: body,
    context: input.context,
    browserCanObserve: ["The sms: handoff was requested by the user."],
    browserCannotObserve: ["Whether a text was sent.", "Whether the provider received or read the text."],
  };
}

export function buildEmailAction(input: EmailActionInput): ServiceActionDescriptor {
  const email = formatEmailForUri(input.email);
  const label = input.label ?? `Email ${serviceLabel(input.context)}`;
  if (!email) {
    return unavailableAction("email", label, "No valid email address is available.", input.context);
  }

  const query = buildUriQuery([
    ["subject", input.subject],
    ["body", input.body],
  ]);
  return {
    kind: "email",
    label,
    handoff: "link",
    observedStatus: "prepared",
    href: `mailto:${email}${query ? `?${query}` : ""}`,
    text: input.body?.trim(),
    context: input.context,
    browserCanObserve: ["The mailto: handoff was requested by the user."],
    browserCannotObserve: ["Whether an email was sent.", "Whether the provider received or read the email."],
  };
}

export function buildMapAction(input: MapActionInput): ServiceActionDescriptor {
  const provider = input.provider ?? "google";
  const query = buildMapQuery(input);
  const sourceUrl = normalizeHttpUrl(input.context?.sourceUrl);
  const href = provider === "source" ? sourceUrl : query ? mapUrl(provider, query) : sourceUrl;
  const resolvedProvider: ServiceMapProvider = provider === "source" || !query ? "source" : provider;

  if (!href) {
    return unavailableAction("map", input.label ?? "Open map", "No address, place query, or source URL is available.", input.context);
  }

  return {
    kind: "map",
    label: input.label ?? `Map ${serviceLabel(input.context)}`,
    handoff: "new_window",
    observedStatus: "prepared",
    href,
    target: "_blank",
    rel: "noreferrer",
    context: input.context,
    browserCanObserve: [`The ${resolvedProvider} map/source handoff was requested by the user.`],
    browserCannotObserve: ["Whether the user arrived at the location.", "Whether the map result is the correct provider."],
  };
}

export function buildMapLinks(input: Omit<MapActionInput, "provider">): Array<ServiceActionDescriptor & { provider: ServiceMapProvider }> {
  return (["google", "apple", "geo"] as const).map((provider) => ({
    ...buildMapAction({ ...input, provider }),
    provider,
  }));
}

export function buildShareAction(input: ShareActionInput): ServiceActionDescriptor {
  const context = mergeShareContext(input);
  const title = firstPresent(input.title, context.serviceTitle, context.programName, context.providerName);
  const url = normalizeHttpUrl(input.url ?? context.sourceUrl);
  const shareDetails = buildShareDetailLines(input, context, url);
  if (!title && shareDetails.length === 0) {
    return unavailableAction("share", "Share service", "No service details are available to share.", context, "web_share");
  }

  const shareTitle = title ?? "Service details";
  const text = buildShareText(shareDetails);
  return {
    kind: "share",
    label: `Share ${shareTitle}`,
    handoff: "web_share",
    observedStatus: "prepared",
    text,
    shareData: url ? { title: shareTitle, text, url } : { title: shareTitle, text },
    context,
    browserCanObserve: ["The Web Share promise resolved or the clipboard write completed."],
    browserCannotObserve: ["Who received the shared details.", "Whether the recipient opened or acted on the shared details."],
  };
}

export function buildCalendarAction(input: CalendarActionInput): ServiceActionDescriptor {
  const title = firstPresent(input.title, input.context?.serviceTitle, input.context?.programName, input.context?.providerName);
  const label = `Calendar ${title ?? "service reminder"}`;
  if (!title || !input.startsAt) {
    return unavailableAction("calendar", label, "A title and start time are required to create a calendar event.", input.context, "download");
  }

  let ics: string;
  let fileName: string;
  try {
    const event = calendarInputToIcsEvent({ ...input, title, startsAt: input.startsAt });
    ics = buildIcsEvent(event);
    fileName = input.fileName ?? createIcsFileName(title, input.startsAt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Calendar event data is invalid.";
    return unavailableAction("calendar", label, reason, input.context, "download");
  }

  return {
    kind: "calendar",
    label,
    handoff: "download",
    observedStatus: "prepared",
    fileName,
    mimeType: CALENDAR_MIME_TYPE,
    ics,
    context: input.context,
    browserCanObserve: ["The .ics file was generated and the download/share handoff was requested."],
    browserCannotObserve: ["Whether the user imported the event.", "Whether the calendar app kept or changed the reminder."],
  };
}

export async function invokeLinkAction(
  action: ServiceActionDescriptor,
  options: ServiceActionInvokeOptions = {}
): Promise<ServiceActionInvocationResult> {
  if (!action.href) {
    return invocationResult(false, action, "unavailable", "No link is available for this action.");
  }

  const browserWindow = options.window ?? globalThis.window;
  if (!browserWindow) {
    return invocationResult(false, action, "unavailable", "A browser window is required to request this handoff.");
  }

  if ((options.target ?? action.target) === "_blank") {
    browserWindow.open(action.href, "_blank", "noopener,noreferrer");
  } else {
    browserWindow.location.href = action.href;
  }

  return invocationResult(true, markObserved(action, "handoff_requested"), "handoff_requested", "Browser handoff requested.");
}

export function invokeCallAction(input: CallActionInput, options: ServiceActionInvokeOptions = {}) {
  return invokeLinkAction(buildCallAction(input), { ...options, target: "_self" });
}

export function invokeTextAction(input: TextActionInput, options: ServiceActionInvokeOptions = {}) {
  return invokeLinkAction(buildTextAction(input), { ...options, target: "_self" });
}

export function invokeEmailAction(input: EmailActionInput, options: ServiceActionInvokeOptions = {}) {
  return invokeLinkAction(buildEmailAction(input), { ...options, target: "_self" });
}

export function invokeMapAction(input: MapActionInput, options: ServiceActionInvokeOptions = {}) {
  return invokeLinkAction(buildMapAction(input), { ...options, target: "_blank" });
}

export async function shareServiceAction(
  input: ShareActionInput,
  options: ServiceActionInvokeOptions = {}
): Promise<ServiceActionInvocationResult> {
  const action = buildShareAction(input);
  const browserNavigator = options.navigator ?? globalThis.navigator;
  const shareData = action.shareData;

  if (!shareData) {
    return invocationResult(false, action, "unavailable", "No service details are available to share.");
  }

  if (shareData && browserNavigator?.share) {
    try {
      await browserNavigator.share(shareData);
      return invocationResult(
        true,
        markObserved(action, "navigator_share_resolved"),
        "navigator_share_resolved",
        "Browser share handoff resolved."
      );
    } catch (error) {
      return invocationResult(false, markObserved(action, "failed"), "failed", "Browser share was canceled or failed.", error);
    }
  }

  const shareText = shareDataToClipboardText(action);
  if (browserNavigator?.clipboard?.writeText) {
    try {
      await browserNavigator.clipboard.writeText(shareText);
      return invocationResult(
        true,
        markObserved(action, "clipboard_write_resolved"),
        "clipboard_write_resolved",
        "Share details copied to the clipboard."
      );
    } catch (error) {
      return invocationResult(false, markObserved(action, "failed"), "failed", "Clipboard copy failed.", error);
    }
  }

  return invocationResult(false, markObserved(action, "unavailable"), "unavailable", "Web Share and clipboard are unavailable.");
}

export function downloadCalendarAction(
  input: CalendarActionInput,
  options: ServiceActionInvokeOptions = {}
): ServiceActionInvocationResult {
  const action = buildCalendarAction(input);
  const browserDocument = options.document ?? globalThis.document;
  const objectUrlApi = typeof URL !== "undefined" ? URL : undefined;

  if (!action.ics) {
    return invocationResult(false, action, "unavailable", "No calendar event is available to download.");
  }

  if (!browserDocument || !objectUrlApi || typeof Blob === "undefined") {
    return invocationResult(false, action, "unavailable", "A browser document is required to download the calendar file.");
  }

  const blob = new Blob([action.ics], { type: CALENDAR_MIME_TYPE });
  const url = objectUrlApi.createObjectURL(blob);
  const anchor = browserDocument.createElement("a");
  anchor.href = url;
  anchor.download = action.fileName ?? "calendar-event.ics";
  anchor.rel = "noreferrer";
  browserDocument.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  objectUrlApi.revokeObjectURL(url);

  return invocationResult(
    true,
    markObserved(action, "download_link_clicked"),
    "download_link_clicked",
    "Calendar download link clicked."
  );
}

export async function shareCalendarAction(
  input: CalendarActionInput,
  options: ServiceActionInvokeOptions = {}
): Promise<ServiceActionInvocationResult> {
  const action = buildCalendarAction(input);
  const browserNavigator = options.navigator ?? globalThis.navigator;
  const fileName = action.fileName ?? "calendar-event.ics";

  if (!action.ics) {
    return invocationResult(false, action, "unavailable", "No calendar event is available to share.");
  }

  if (!browserNavigator?.share || typeof File === "undefined") {
    return invocationResult(false, action, "unavailable", "Calendar file sharing is unavailable.");
  }

  const file = new File([action.ics], fileName, { type: CALENDAR_MIME_TYPE });
  const shareData: ShareData = {
    title: firstPresent(input.title, input.context?.serviceTitle, input.context?.programName, input.context?.providerName),
    text: input.notes?.trim() || undefined,
    files: [file],
  };

  if (browserNavigator.canShare && !browserNavigator.canShare(shareData)) {
    return invocationResult(false, action, "unavailable", "This browser cannot share calendar files.");
  }

  try {
    await browserNavigator.share(shareData);
    return invocationResult(
      true,
      markObserved(action, "navigator_share_resolved"),
      "navigator_share_resolved",
      "Calendar share handoff resolved."
    );
  } catch (error) {
    return invocationResult(false, markObserved(action, "failed"), "failed", "Calendar share was canceled or failed.", error);
  }
}

function calendarInputToIcsEvent(input: CalendarActionInput & { title: string; startsAt: Date | string }): IcsEventInput {
  return {
    title: input.title,
    description: input.notes,
    location: input.location,
    url: normalizeHttpUrl(input.url ?? input.context?.sourceUrl),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    durationMinutes: input.durationMinutes,
    allDay: input.allDay,
    alarms: input.alarms,
    uid: input.context?.serviceDocId
      ? `${input.context.serviceDocId}-${hashString([input.title, String(input.startsAt)].join("|"))}@abby-211.local`
      : undefined,
  };
}

function formatPhoneForUri(phone: string | undefined): string | undefined {
  const trimmed = phone?.trim();
  if (!trimmed) {
    return undefined;
  }

  const extensionMatch = trimmed.match(/(?:ext\.?|extension|x)\s*(\d{1,8})\s*$/i);
  const extension = extensionMatch?.[1];
  const withoutExtension = extensionMatch ? trimmed.slice(0, extensionMatch.index).trim() : trimmed;
  const normalized = withoutExtension.replace(/[^\d+*#]/g, "").replace(/(?!^)\+/g, "");
  if (!/\d/.test(normalized)) {
    return undefined;
  }
  return `${normalized}${extension ? `;ext=${extension}` : ""}`;
}

function formatEmailForUri(email: string | undefined): string | undefined {
  const trimmed = email?.trim();
  if (!trimmed || /[\s\r\n]/.test(trimmed) || !/^[^@]+@[^@]+$/.test(trimmed)) {
    return undefined;
  }
  return encodeUriComponentStrict(trimmed).replace(/%40/g, "@").replace(/%2B/g, "+");
}

function mapUrl(provider: ServiceMapProvider, query: string): string {
  const encoded = encodeUriComponentStrict(query);
  if (provider === "apple") return `https://maps.apple.com/?q=${encoded}`;
  if (provider === "geo") return `geo:0,0?q=${encoded}`;
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

function buildMapQuery(input: MapActionInput): string | undefined {
  return firstPresent(input.query, input.address);
}

function buildShareDetailLines(input: ShareActionInput, context: ServiceActionContext, sourceUrl: string | undefined): string[] {
  return [
    input.text,
    !input.text ? input.title : undefined,
    context.providerName ? `Provider: ${context.providerName}` : undefined,
    context.programName ? `Program: ${context.programName}` : undefined,
    sourceUrl ? `Source: ${sourceUrl}` : undefined,
    context.sourceContentCid ? `Source CID: ${context.sourceContentCid}` : undefined,
    context.sourcePageCid ? `Page CID: ${context.sourcePageCid}` : undefined,
  ]
    .filter(isPresent);
}

function buildShareText(detailLines: string[]): string {
  return [...detailLines, "Verify details before visiting or sharing private information."].join("\n");
}

function mergeShareContext(input: ShareActionInput): ServiceActionContext {
  return {
    ...input.context,
    sourceUrl: input.url ?? input.context?.sourceUrl,
    sourceContentCid: input.sourceContentCid ?? input.context?.sourceContentCid,
    sourcePageCid: input.sourcePageCid ?? input.context?.sourcePageCid,
  };
}

function shareDataToClipboardText(action: ServiceActionDescriptor): string {
  return [action.shareData?.title, action.shareData?.text, action.shareData?.url].filter(isPresent).join("\n");
}

function unavailableAction(
  kind: ServiceActionKind,
  label: string,
  reason: string,
  context?: ServiceActionContext,
  handoff: ServiceActionHandoff = "link"
): ServiceActionDescriptor {
  return {
    kind,
    label,
    handoff,
    observedStatus: "unavailable",
    context,
    browserCanObserve: [reason],
    browserCannotObserve: [],
  };
}

function invocationResult(
  ok: boolean,
  action: ServiceActionDescriptor,
  observedStatus: ServiceActionObservedStatus,
  message: string,
  error?: unknown
): ServiceActionInvocationResult {
  return {
    ok,
    action,
    observedStatus,
    message,
    error: error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
  };
}

function markObserved(action: ServiceActionDescriptor, observedStatus: ServiceActionObservedStatus): ServiceActionDescriptor {
  return {
    ...action,
    observedStatus,
  };
}

function serviceLabel(context: ServiceActionContext | undefined): string {
  return firstPresent(context?.providerName, context?.programName, context?.serviceTitle, "provider") ?? "provider";
}

function firstPresent(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()))?.trim();
}

function buildUriQuery(params: Array<[string, string | undefined]>): string {
  return params
    .map(([key, value]) => {
      const trimmed = value?.trim();
      return trimmed ? `${key}=${encodeUriComponentStrict(trimmed)}` : undefined;
    })
    .filter(isPresent)
    .join("&");
}

function encodeUriComponentStrict(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
