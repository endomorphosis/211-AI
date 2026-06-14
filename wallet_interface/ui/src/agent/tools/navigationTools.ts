import type { RouteId } from "../../models/abby";
import { appRoutes, getRouteFromHash, setLocationRouteHash } from "../../app/appState";
import type { AppActionResult, AppActionRuntime, AppActionState } from "../../app/appActions";
import type { NavigateCommandInput, ReadSurfaceContextCommandInput } from "../commandSchemas";
import { getRouteLabel, listContextProvidersForSurface } from "../surfaceRegistry";
import type { SurfaceContext } from "../types";
import { hasPermissionLevel } from "../types";

type RouteSummaryBuilder = (state: AppActionState) => string;

export interface NavigationSurface {
  route: RouteId;
  label: string;
  aliases: string[];
}

interface NavigationRouteMatch {
  route: RouteId;
  normalizedAlias: string;
  score: number;
}

const extraRouteAliases = {
  home: ["dashboard", "start", "today", "safety plan"],
  register: ["registration", "profile", "intake"],
  "check-in": ["reminder", "reminders", "checkins"],
  calendar: ["appointments", "appointment", "schedule", "scheduled services", "service schedule"],
  messages: ["inbox", "client messages", "service staff messages", "notifications"],
  contacts: ["people", "recipients"],
  "sharing-rules": ["sharing rules", "disclosure", "permissions"],
  uploads: ["wallet", "documents", "files", "records", "export", "import", "bundle", "bundles", "share proofs"],
  settings: ["account settings", "profile settings", "preferences", "personal information"],
  "social-services": ["service", "services", "service navigator", "211", "211 services"],
  interactions: ["interaction history", "service history", "service interactions", "timeline"],
  shelter: ["provider overview", "provider portal", "shelter staff", "shelters", "shelter services", "beds"],
  "provider-clients": ["served clients", "clients served", "provider clients", "case list"],
  "provider-cases": ["case management", "cases", "caseload", "service cases", "eligibility cases"],
  "provider-messages": ["provider messages", "send client messages", "client notifications", "notifications"],
  "provider-analytics": ["staff analytics", "provider analytics", "staff reports"],
  "provider-proofs": ["zk certificates", "zero knowledge certificates", "provider proofs", "proof certificates"],
  "provider-operations": ["staff operations", "provider operations", "create user account", "contact requests"],
  "recipient-access": ["recipient access", "access requests", "who can see", "requests"],
  "benefits-protection": ["benefits", "benefits protection", "public benefits"],
  analytics: ["reports", "group facts"],
  "proof-center": ["proof center", "proofs", "proof", "verification", "verifications"],
  exports: ["export", "sharing bundle", "bundle", "download"],
  security: ["wallet security", "privacy", "security settings"],
  audit: ["history", "wallet audit", "activity log", "audit log"]
} satisfies Record<RouteId, readonly string[]>;

const routeSummaries = {
  home: (state) =>
    `Home is active with ${state.uploads.length} uploads, ${state.recipients.length} recipients, and ${pendingAccessRequestCount(
      state
    )} pending access requests.`,
  register: (state) => `Registration draft is active with ${state.profile.serviceNeeds.length} service needs selected.`,
  "check-in": (state) =>
    `Check-in is configured every ${state.policy.intervalDays} days through ${state.policy.reminderChannels.length} channels.`,
  calendar: (state) => {
    const appointments = state.servicePlans?.filter((plan) => Boolean(plan.appointment_at)).length ?? 0;
    const followUps =
      state.serviceInteractions?.filter((interaction) => Boolean(interaction.next_follow_up_at)).length ?? 0;

    return `${appointments + followUps} scheduled appointments, services, and follow-ups.`;
  },
  messages: (state) => `${state.shelterProviderMessages?.length ?? 0} service staff messages are available.`,
  contacts: (state) => `${state.recipients.length} recipients are visible.`,
  "sharing-rules": (state) => `${state.recipients.length} recipients have sharing controls available.`,
  uploads: (state) => `${state.uploads.length} wallet files, ${state.exportBundleViews.length} export bundles, and ${state.walletProofReceipts.length} proof receipts are visible.`,
  settings: (state) =>
    `Settings are active with ${state.profile.serviceNeeds.length} service needs, ${state.policy.reminderChannels.length} check-in channels, and ${Object.values(state.analyticsOptIn ?? {}).filter(Boolean).length} explicit analytics choices.`,
  "social-services": () => "Services search and public 211 guidance are active.",
  interactions: (state) => `${state.serviceInteractions?.length ?? 0} service interactions are visible.`,
  shelter: (state) =>
    `Provider overview is active with ${state.shelterUserAccounts?.length ?? 0} served clients, ${
      state.shelterProviderMessages?.length ?? 0
    } messages, and ${providerProofCount(state)} provider proof certificates.`,
  "provider-clients": (state) => `${state.shelterUserAccounts?.length ?? 0} served clients are visible.`,
  "provider-cases": (state) => `${state.shelterCaseRecords?.length ?? 0} provider case records are visible.`,
  "provider-messages": (state) => `${state.shelterProviderMessages?.length ?? 0} provider messages are visible.`,
  "provider-analytics": (state) =>
    `${state.shelterStaffAccounts?.length ?? 0} provider staff accounts are available for analytics.`,
  "provider-proofs": (state) => `${providerProofCount(state)} provider proof certificates are visible.`,
  "provider-operations": (state) =>
    `Shelter workspace is active with ${state.shelterStaffAccounts?.length ?? 0} staff accounts, ${
      state.shelterUserAccounts?.length ?? 0
    } managed user accounts, and ${state.shelterContactRequests?.filter((request) => request.status === "pending").length ?? 0} pending contact requests.`,
  "recipient-access": (state) => `${pendingAccessRequestCount(state)} pending access requests are visible.`,
  "benefits-protection": () => "Benefits protection resources and public 211 guidance are active.",
  analytics: (state) =>
    `Group facts and aggregate reporting are active with ${Object.values(state.analyticsOptIn ?? {}).filter(Boolean).length} studies selected.`,
  "proof-center": (state) => `${state.walletProofReceipts.length} proof receipts are visible.`,
  exports: (state) => `${state.exportBundleViews.length} export bundles are visible.`,
  security: (state) => `Security settings and wallet safety information are active with ${state.exportBundleViews.length} export bundles visible.`,
  audit: (state) => `${state.walletAuditEvents.length} audit events are visible.`
} satisfies Record<RouteId, RouteSummaryBuilder>;

export const navigationSurfaces: NavigationSurface[] = appRoutes.map((route) => ({
  route: route.id,
  label: getRouteLabel(route.id),
  aliases: buildRouteAliases(route.id, route.label)
}));

export const navigationRouteIds: RouteId[] = navigationSurfaces.map((surface) => surface.route);
const navigationRouteIdSet = new Set<RouteId>(navigationRouteIds);

export async function navigateAction(
  runtime: AppActionRuntime,
  input: NavigateCommandInput
): Promise<AppActionResult> {
  if (!canNavigateToRoute(input.route)) {
    return {
      ok: false,
      action: "navigate",
      errorCode: "route_not_found",
      message: `Route ${String(input.route)} is not available.`
    };
  }

  setLocationRouteHash(input.route);
  runtime.setActiveRoute?.(input.route);
  runtime.setMobileNavOpen?.(false);
  return {
    ok: true,
    action: "navigate",
    summary: `Opened ${getRouteLabel(input.route)}.`,
    route: input.route
  };
}

export async function readSurfaceContextAction(
  runtime: AppActionRuntime,
  input: ReadSurfaceContextCommandInput
): Promise<AppActionResult> {
  const surfaceContext = buildSafeSurfaceContext(runtime.getState(), input);
  return {
    ok: true,
    action: "read_surface_context",
    summary: formatSurfaceContextSummary(surfaceContext),
    route: surfaceContext.route,
    surfaceContext
  };
}

export function buildSafeSurfaceContext(
  state: AppActionState,
  input: ReadSurfaceContextCommandInput = {}
): SurfaceContext {
  const route = resolveSurfaceRoute(state, input);
  const walletUnlocked = state.walletUnlocked ?? true;
  const includePrivateContext = canReadPrivateSurfaceContext(route, state, input, walletUnlocked);
  const visibleRecordIds = includePrivateContext ? getVisibleRecordIds(route, state) : undefined;
  const visibleServiceDocIds = getVisibleServiceDocIds(route);

  return {
    route,
    routeLabel: getRouteLabel(route),
    capturedAt: new Date().toISOString(),
    visibleRecordIds,
    visibleServiceDocIds,
    walletUnlocked,
    privateContextAllowed: includePrivateContext,
    permissionLevel: includePrivateContext ? "wallet_private" : "app_context",
    summary: summarizeRouteState(route, state),
    metadata: includePrivateContext ? privateSurfaceMetadata(route, state) : publicSurfaceMetadata(route, state)
  };
}

export function summarizeRouteState(route: RouteId, state: AppActionState): string {
  return routeSummaries[route](state);
}

export function formatSurfaceContextSummary(surfaceContext: SurfaceContext): string {
  const summary = surfaceContext.summary?.trim();
  if (!summary) {
    return `You are on ${surfaceContext.routeLabel}.`;
  }
  if (startsWithRouteLabel(summary, surfaceContext.routeLabel)) {
    return summary;
  }
  return `${surfaceContext.routeLabel}: ${summary}`;
}

export function canNavigateToRoute(route: unknown): route is RouteId {
  return navigationRouteIdSet.has(route as RouteId);
}

export function validateNavigationRouteCoverage(): string[] {
  const errors: string[] = [];
  const routeSummaryIds = Object.keys(routeSummaries) as RouteId[];
  const appRouteIdSet = new Set(appRoutes.map((route) => route.id));

  for (const route of routeSummaryIds) {
    if (!appRouteIdSet.has(route)) {
      errors.push(`Route ${route} has a navigation summary but is not registered in appRoutes.`);
    }
    if (!navigationRouteIdSet.has(route)) {
      errors.push(`Route ${route} is missing from navigation surfaces.`);
    }
  }

  for (const route of navigationRouteIds) {
    if (!routeSummaries[route]) {
      errors.push(`Route ${route} has a navigation surface but no safe summary builder.`);
    }
  }

  return errors;
}

export function resolveNavigationRoute(input: string): RouteId | undefined {
  const normalized = normalizeRouteText(input);
  if (!normalized) return undefined;
  const exactMatch = navigationSurfaces.find((surface) =>
    surface.aliases.some((alias) => normalizeRouteText(alias) === normalized)
  )?.route;
  if (exactMatch) return exactMatch;

  return navigationSurfaces
    .flatMap((surface) =>
      surface.aliases.map((alias) => ({
        route: surface.route,
        normalizedAlias: normalizeRouteText(alias),
        score: scoreRouteAliasMatch(surface, alias, normalized)
      }))
    )
    .filter((candidate) => candidate.score > 0)
    .sort(compareRouteMatches)[0]?.route;
}

export async function summarizeCurrentScreenAction(runtime: AppActionRuntime): Promise<AppActionResult> {
  return readSurfaceContextAction(runtime, {});
}

function buildRouteAliases(route: RouteId, appLabel: string): string[] {
  const label = getRouteLabel(route);
  return uniqueStrings([
    route,
    route.replace(/-/g, " "),
    label,
    appLabel,
    appLabel.toLowerCase(),
    label.toLowerCase(),
    ...extraRouteAliases[route]
  ]);
}

function normalizeRouteText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function includesNormalizedPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|\\W)${escaped}(?=\\W|$)`, "i").test(text);
}

function scoreRouteAliasMatch(surface: NavigationSurface, alias: string, normalizedInput: string): number {
  const normalizedAlias = normalizeRouteText(alias);
  if (!normalizedAlias || !includesNormalizedPhrase(normalizedInput, normalizedAlias)) {
    return 0;
  }

  const isRouteIdAlias = normalizedAlias === normalizeRouteText(surface.route);
  const isLabelAlias = normalizedAlias === normalizeRouteText(surface.label);
  const routeWordCount = normalizedAlias.split(" ").length;
  return normalizedAlias.length + routeWordCount * 4 + (isRouteIdAlias ? 12 : 0) + (isLabelAlias ? 8 : 0);
}

function compareRouteMatches(left: NavigationRouteMatch, right: NavigationRouteMatch): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.normalizedAlias.length !== right.normalizedAlias.length) {
    return right.normalizedAlias.length - left.normalizedAlias.length;
  }
  return navigationRouteIds.indexOf(left.route) - navigationRouteIds.indexOf(right.route);
}

function startsWithRouteLabel(summary: string, routeLabel: string): boolean {
  const normalizedSummary = normalizeRouteText(summary);
  const normalizedLabel = normalizeRouteText(routeLabel);
  return normalizedSummary === normalizedLabel || normalizedSummary.startsWith(`${normalizedLabel} `);
}

function getVisibleRecordIds(route: RouteId, state: AppActionState): string[] | undefined {
  if (!routeHasVisibleWalletRecords(route)) {
    return undefined;
  }
  return state.uploads.map((upload) => upload.recordId || upload.id);
}

function publicSurfaceMetadata(route: RouteId, state: AppActionState): Record<string, unknown> {
  return {
    route,
    routeLabel: getRouteLabel(route),
    activeRoute: state.activeRoute,
    uploadCount: state.uploads.length,
    recipientCount: state.recipients.length,
    pendingAccessRequestCount: pendingAccessRequestCount(state),
    activeGrantCount: state.grantReceipts.filter((receipt) => receipt.status === "active").length,
    proofCount: state.walletProofReceipts.length,
    exportBundleCount: state.exportBundleViews.length,
    auditEventCount: state.walletAuditEvents.length,
    selectedAnalyticsStudyCount: Object.values(state.analyticsOptIn ?? {}).filter(Boolean).length,
    ...routePublicMetadata(route, state)
  };
}

function privateSurfaceMetadata(route: RouteId, state: AppActionState): Record<string, unknown> {
  return {
    ...publicSurfaceMetadata(route, state),
    profile: {
      preferredName: state.profile.preferredName,
      currentLocation: state.profile.currentLocation,
      serviceNeeds: state.profile.serviceNeeds,
      preferredCheckInChannels: state.profile.preferredCheckInChannels
    },
    policy: state.policy,
    recipients: state.recipients.map((recipient) => ({
      id: recipient.id,
      displayName: recipient.displayName,
      type: recipient.type,
      allowedScopes: recipient.allowedScopes
    })),
    uploads: state.uploads.map((upload) => ({
      id: upload.id,
      recordId: upload.recordId,
      category: upload.category,
      sensitivity: upload.sensitivity,
      status: upload.status,
      shared: upload.shared
    })),
    ...privateRouteMetadata(route, state)
  };
}

function routePublicMetadata(route: RouteId, state: AppActionState): Record<string, unknown> {
  switch (route) {
    case "register":
      return {
        selectedServiceNeedCount: state.profile.serviceNeeds.length,
        preferredCheckInChannelCount: state.profile.preferredCheckInChannels.length
      };
    case "settings":
      return {
        selectedServiceNeedCount: state.profile.serviceNeeds.length,
        intervalDays: state.policy.intervalDays,
        reminderChannelCount: state.policy.reminderChannels.length,
        benefitsOptIn: state.benefitsOptIn,
        selectedAnalyticsStudyCount: Object.values(state.analyticsOptIn ?? {}).filter(Boolean).length
      };
    case "check-in":
      return {
        intervalDays: state.policy.intervalDays,
        reminderChannelCount: state.policy.reminderChannels.length,
        escalationEnabled: state.policy.escalationEnabled
      };
    case "contacts":
    case "sharing-rules":
      return {
        verifiedRecipientCount: state.recipients.filter((recipient) => recipient.verified).length,
        recipientTypeCounts: countBy(state.recipients.map((recipient) => recipient.type))
      };
    case "shelter":
      return {
        shelterStaffAccountCount: state.shelterStaffAccounts?.length ?? 0,
        verifiedShelterStaffAccountCount: state.shelterStaffAccounts?.filter((account) => account.verified).length ?? 0,
        shelterUserAccountCount: state.shelterUserAccounts?.length ?? 0,
        pendingShelterContactRequestCount:
          state.shelterContactRequests?.filter((request) => request.status === "pending").length ?? 0
      };
    case "uploads":
      return {
        storedUploadCount: state.uploads.filter((upload) => upload.status === "stored").length,
        sharedUploadCount: state.uploads.filter((upload) => upload.shared).length,
        uploadCategoryCounts: countBy(state.uploads.map((upload) => upload.category)),
        uploadSensitivityCounts: countBy(state.uploads.map((upload) => upload.sensitivity))
      };
    case "interactions":
      return {
        serviceInteractionCount: state.serviceInteractions?.length ?? 0,
        serviceInteractionStatusCounts: countBy(
          (state.serviceInteractions ?? []).map((interaction) => interaction.status).filter(Boolean)
        )
      };
    case "recipient-access":
      return {
        approvedAccessRequestCount: state.accessRequests.filter((request) => request.status === "approved").length,
        rejectedAccessRequestCount: state.accessRequests.filter((request) => request.status === "rejected").length
      };
    case "analytics":
      return {
        activeGrantCount: state.grantReceipts.filter((receipt) => receipt.status === "active").length,
        selectedAnalyticsStudyCount: Object.values(state.analyticsOptIn ?? {}).filter(Boolean).length
      };
    case "proof-center":
      return {
        verifiedProofCount: state.walletProofReceipts.filter((proof) => proof.verificationStatus === "verified").length,
        simulatedProofCount: state.walletProofReceipts.filter((proof) => proof.simulated).length
      };
    case "exports":
      return {
        verifiedExportBundleCount: state.exportBundleViews.filter((bundle) => bundle.verificationOk).length
      };
    case "security":
      return {
        verifiedExportBundleCount: state.exportBundleViews.filter((bundle) => bundle.verificationOk).length
      };
    default:
      return {};
  }
}

function privateRouteMetadata(route: RouteId, state: AppActionState): Record<string, unknown> {
  switch (route) {
    case "recipient-access":
      return {
        visibleAccessRequestIds: state.accessRequests.map((request) => request.id)
      };
    case "shelter":
      return {
        visibleShelterStaffAccountIds: state.shelterStaffAccounts?.map((account) => account.id) ?? [],
        visibleShelterUserAccountIds: state.shelterUserAccounts?.map((account) => account.id) ?? [],
        visibleShelterContactRequestIds: state.shelterContactRequests?.map((request) => request.id) ?? []
      };
    case "proof-center":
      return {
        visibleProofReceiptIds: state.walletProofReceipts.map((proof) => proof.id)
      };
    case "exports":
      return {
        visibleExportBundleIds: state.exportBundleViews.map((bundle) => bundle.bundleId || bundle.id)
      };
    case "security":
      return {
        visibleExportBundleIds: state.exportBundleViews.map((bundle) => bundle.bundleId || bundle.id)
      };
    default:
      return {};
  }
}

function resolveSurfaceRoute(state: AppActionState, input: ReadSurfaceContextCommandInput): RouteId {
  if (input.route && canNavigateToRoute(input.route)) {
    return input.route;
  }
  if (canNavigateToRoute(state.activeRoute)) {
    return state.activeRoute;
  }
  const hashRoute = getRouteFromHash();
  return canNavigateToRoute(hashRoute) ? hashRoute : "home";
}

function getVisibleServiceDocIds(route: RouteId): string[] | undefined {
  return isServiceRoute(route) ? [] : undefined;
}

function isServiceRoute(route: RouteId): boolean {
  return route === "social-services" || route === "shelter" || route === "benefits-protection";
}

function routeHasVisibleWalletRecords(route: RouteId): boolean {
  return route === "uploads";
}

function canReadPrivateSurfaceContext(
  route: RouteId,
  state: AppActionState,
  input: ReadSurfaceContextCommandInput,
  walletUnlocked: boolean
): boolean {
  if (!input.includePrivateContext || !state.privateContextAllowed || !walletUnlocked) {
    return false;
  }
  if (!hasPermissionLevel(state.permissionLevel ?? "wallet_write", "wallet_private")) {
    return false;
  }
  return listContextProvidersForSurface(route, "wallet_private").some(
    (provider) => provider.permissionLevel === "wallet_private"
  );
}

function pendingAccessRequestCount(state: AppActionState): number {
  return state.accessRequests.filter((request) => request.status === "pending").length;
}

function providerProofCount(state: AppActionState): number {
  return state.walletProofReceipts.filter((proof) => proof.proofType.startsWith("provider_")).length;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
