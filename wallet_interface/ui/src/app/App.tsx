import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Bell,
  BarChart3,
  CalendarCheck,
  ClipboardCheck,
  ContactRound,
  FileUp,
  HeartHandshake,
  Home,
  KeyRound,
  Landmark,
  LockKeyhole,
  LogOut,
  Menu,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Upload,
  UsersRound,
  Wrench
} from "lucide-react";
import { ActionCard, Badge, Button, Field, Section, StatusBanner } from "../components/ui";
import { AgentChatDrawer } from "../components/agent/AgentChatDrawer";
import { WorldIdVerificationPanel } from "../components/world-id/WorldIdVerificationPanel";
import { getRouteLabel } from "../agent/surfaceRegistry";
import {
  getServiceDetailDocIdFromHash,
  openCanonicalServiceDetailRoute,
  setLocationServiceDetailHash
} from "../agent/tools/serviceDetailTools";
import type { AppActionRuntime } from "./appActions";
import { useAgentChatService } from "../services/agentChatService";
import { ServiceDetailScreen } from "./ServiceDetailScreen";
import { search211Info } from "../services/graphRagService";
import type { SearchResult } from "../lib/graphrag";
import {
  CheckInChannel,
  AuditEvent,
  DisclosureDataScope,
  DisclosureRecipientDraft,
  DisclosureRecipientType,
  EasyBotCheckStatus,
  ExportBundleView,
  RegistrationProfileDraft,
  RouteId,
  SavedService,
  ServiceInteractionEvent,
  ServicePlan,
  ShelterContactRequest,
  UploadItem,
  ProofReceiptView,
  WalletAccessRequest,
  WalletGrantReceipt
} from "../models/abby";
import {
  analyticsStudies,
  auditEvents,
  defaultDisclosureScopes,
  defaultCheckInPolicy,
  exportBundles,
  initialAccessRequests,
  initialGrantReceipts,
  initialRecipients,
  initialShelterContactRequests,
  initialUploads,
  proofReceipts,
  serviceMatches
} from "../services/mockAbbyService";
import {
  abilitiesForDisclosureScopes,
  nonGrantedCapabilities,
  plainCapabilitySummary,
  plainNonGrantedCapabilities
} from "../services/capabilities";
import {
  addBinaryDocument,
  addTextDocument,
  createLocationRegionProof,
  getConsensusDisplayState,
  getConsensusMetadataFromView,
  createVerifiedExportBundleView,
  getProofReceiptUiState,
  importExportBundleView,
  listWalletSnapshots,
  loadWalletAccessState,
  loadExportBundleView,
  loadWalletSnapshot,
  listWalletAuditEvents,
  listWalletDocuments,
  listWalletProofReceipts,
  repairRecordStorage,
  saveWalletSnapshot,
  verifyWalletSnapshot,
  mapProofReceiptRecordForUi,
  WalletApiConsensusFailClosedError,
  WalletApiRequestError,
  WalletSnapshotVerification,
  WalletApiConfig,
  WalletConsensusMetadata
} from "../services/walletApi";
import {
  appRoutes,
  createDefaultAppState,
  defaultManagedUserDraft,
  defaultShelterChecklist,
  disclosureScopes,
  getRouteFromHash,
  primaryRoutes,
  readPersistedAppState,
  secondaryRoutes,
  serviceNeeds,
  setLocationRouteHash,
  shelterOptions,
  ShelterStaffAccount,
  ShelterUserAccount,
  writePersistedAppState
} from "./appState";

const APP_SESSION_KEY = "abby-ui-session-v1";
const WALLET_API_CONFIG_KEY = "abby-wallet-api-config";
const ID_DOCUMENT_ACCEPT_ATTR = "image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf";
const ID_DOCUMENT_ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const DEMO_BOT_CHECK_TOKEN = "mock-captcha-token";
const MANUAL_INTAKE_FALLBACK_TOKEN = "manual-intake-fallback";
const PROVIDER_STAFF_WORLD_ID_ACTION = "provider-staff-world-id-v1";
const ID_DOCUMENT_ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];

const routeIcons: Partial<Record<RouteId, typeof Home>> = {
  home: Home,
  register: ClipboardCheck,
  "check-in": CalendarCheck,
  contacts: ContactRound,
  "sharing-rules": ShieldCheck,
  uploads: FileUp,
  "social-services": HeartHandshake,
  shelter: UsersRound,
  "recipient-access": KeyRound,
  "benefits-protection": Landmark,
  analytics: BarChart3,
  "proof-center": ShieldCheck,
  exports: LogOut,
  security: LockKeyhole,
  audit: ClipboardCheck
};

const removedStandaloneRoutes = new Set<RouteId>(["sharing-rules", "recipient-access", "benefits-protection"]);
const routes = primaryRoutes
  .filter((route) => !removedStandaloneRoutes.has(route.id))
  .map((route) => ({ ...route, icon: routeIcons[route.id] ?? Home }));
const secondaryNavigationRoutes = secondaryRoutes
  .filter((route) => !removedStandaloneRoutes.has(route.id))
  .map((route) => ({ ...route, icon: routeIcons[route.id] ?? Home }));
const navigationRoutes = [...routes, ...secondaryNavigationRoutes];

function normalizeAppRoute(route: RouteId): RouteId {
  return removedStandaloneRoutes.has(route) ? "home" : route;
}

function getInitialRouteFromHash(): RouteId {
  return getServiceDetailDocIdFromHash() ? "social-services" : normalizeAppRoute(getRouteFromHash());
}

function readSignedInUser(): string {
  if (typeof window === "undefined") return "";
  try {
    const raw = window.localStorage.getItem(APP_SESSION_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    return typeof parsed?.username === "string" ? parsed.username : "";
  } catch {
    return "";
  }
}

function isAcceptedIdentityDocument(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return (
    ID_DOCUMENT_ACCEPTED_TYPES.has(file.type) ||
    ID_DOCUMENT_ACCEPTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension))
  );
}

function getIdentityDocumentFileDetail(file: File): string {
  const lowerName = file.name.toLowerCase();
  let fileType = "image";
  if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
    fileType = "PDF";
  } else if (file.type === "image/jpeg" || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
    fileType = "JPG";
  } else if (file.type === "image/png" || lowerName.endsWith(".png")) {
    fileType = "PNG";
  } else if (file.type === "image/webp" || lowerName.endsWith(".webp")) {
    fileType = "WebP";
  }
  return `${file.name} (${fileType})`;
}

function formatRecipientType(type: DisclosureRecipientType): string {
  const labels: Record<DisclosureRecipientType, string> = {
    benefits_agency: "Benefits agency",
    emergency_contact: "Emergency contact",
    government_liaison: "Government help",
    police_precinct: "Police precinct",
    shelter_staff: "Shelter staff",
    social_worker: "Social worker"
  };
  return labels[type];
}

function formatAnalyticsField(field: string): string {
  const labels: Record<string, string> = {
    county: "county",
    need_category: "need type"
  };
  return labels[field] ?? field.replace(/_/g, " ");
}

function toShortSummaryTitle(text: string): string {
  const cleaned = text
    .replace(/machine\s+summary\s*:\s*/gi, " ")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Uploaded document";

  const words = cleaned
    .split(" ")
    .filter((word) => word.length > 1)
    .slice(0, 4);
  if (!words.length) return "Uploaded document";

  const title = words
    .map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
  return title;
}

async function generateUploadSummary(file: File): Promise<string> {
  try {
    if (file.type.startsWith("text/")) {
      return toShortSummaryTitle(await file.text());
    }

    if (file.type.startsWith("image/")) {
      const { recognize } = await import("tesseract.js");
      const result = await recognize(file, "eng");
      return toShortSummaryTitle(result.data.text || file.name);
    }
  } catch {
    // Fall through to a safe fallback summary when extraction/OCR fails.
  }

  const fileNameWithoutExtension = file.name.replace(/\.[^/.]+$/, "");
  return toShortSummaryTitle(fileNameWithoutExtension || "Uploaded document");
}

type WorldIdSurfaceState = {
  actorDidLabel: string;
  availabilityLabel: string;
  canOfferVerification: boolean;
  proofReceiptLabel: string;
  statusLabel: string;
  statusTone: "success" | "warning";
  verified: boolean;
  walletLabel: string;
};

type IntakeVerificationDraft = Pick<RegistrationProfileDraft, "easyBotCheckStatus" | "captchaToken">;

function hasManualIntakeFallback(draft: IntakeVerificationDraft): boolean {
  return draft.easyBotCheckStatus === "failed" || draft.captchaToken === MANUAL_INTAKE_FALLBACK_TOKEN;
}

function hasDemoBotCheck(draft: IntakeVerificationDraft): boolean {
  return draft.easyBotCheckStatus === "passed" && draft.captchaToken === DEMO_BOT_CHECK_TOKEN;
}

function isIntakeVerified(draft: IntakeVerificationDraft, worldIdState: WorldIdSurfaceState): boolean {
  return worldIdState.verified || hasManualIntakeFallback(draft) || hasDemoBotCheck(draft);
}

function getIntakeVerificationMessage(draft: IntakeVerificationDraft, worldIdState: WorldIdSurfaceState): string {
  if (worldIdState.verified) {
    return "World ID proof-of-human satisfies intake without the demo bot check.";
  }
  if (hasManualIntakeFallback(draft)) {
    return "Manual fallback is active for accessibility, device availability, or emergency service access.";
  }
  if (hasDemoBotCheck(draft)) {
    return "Demo bot check is active for local testing only.";
  }
  return "Choose World ID verification, manual fallback, or the local demo bot check before assisted intake is submitted.";
}

function getIntakeVerificationTone(
  draft: IntakeVerificationDraft,
  worldIdState: WorldIdSurfaceState
): "info" | "success" | "warning" {
  if (worldIdState.verified) return "success";
  if (hasManualIntakeFallback(draft)) return "warning";
  if (hasDemoBotCheck(draft)) return "info";
  return "warning";
}

function getWorldIdSurfaceState(apiConfig: WalletApiConfig | undefined, proofs: ProofReceiptView[]): WorldIdSurfaceState {
  const worldIdProofs = proofs.filter((proof) => proof.proofType === "world_id_proof_of_human");
  const verifiedProof = worldIdProofs.find((proof) => getProofReceiptUiState(proof).accepted);
  const latestProof = verifiedProof ?? worldIdProofs[0];
  const walletReady = Boolean(apiConfig?.apiBaseUrl && apiConfig.walletId);
  const actorReady = Boolean(apiConfig?.actorDid);
  const canOfferVerification = walletReady && actorReady;

  return {
    actorDidLabel: apiConfig?.actorDid || "Required",
    availabilityLabel: canOfferVerification ? "Verification available" : walletReady ? "Actor DID required" : "Wallet API required",
    canOfferVerification,
    proofReceiptLabel: latestProof ? getProofReceiptUiState(latestProof).statusLabel : "No proof receipt",
    statusLabel: verifiedProof ? "World ID verified" : "World ID unverified",
    statusTone: verifiedProof ? "success" : "warning",
    verified: Boolean(verifiedProof),
    walletLabel: apiConfig?.walletId ?? "Not connected"
  };
}

export function App() {
  const persistedState = useMemo(() => readPersistedAppState(), []);
  const defaultAppState = useMemo(() => createDefaultAppState(persistedState), [persistedState]);
  const [signedInUser, setSignedInUser] = useState(readSignedInUser);
  const activeRouteRef = useRef<RouteId>(getInitialRouteFromHash());
  const [activeRoute, setActiveRoute] = useState<RouteId>(activeRouteRef.current);
  const [serviceDetailDocId, setServiceDetailDocId] = useState<string | null>(getServiceDetailDocIdFromHash());
  const [profile, setProfile] = useState<RegistrationProfileDraft>(() => defaultAppState.profile);
  const [policy, setPolicy] = useState(() => defaultAppState.policy);
  const [recipients, setRecipients] = useState<DisclosureRecipientDraft[]>(() => defaultAppState.recipients);
  const [uploads, setUploads] = useState<UploadItem[]>(() => defaultAppState.uploads);
  const [shelterContactRequests, setShelterContactRequests] = useState<ShelterContactRequest[]>(
    () => defaultAppState.shelterContactRequests
  );
  const [shelterStaffAccounts, setShelterStaffAccounts] = useState<ShelterStaffAccount[]>(
    () => defaultAppState.shelterStaffAccounts
  );
  const [shelterUserAccounts, setShelterUserAccounts] = useState<ShelterUserAccount[]>(
    () => defaultAppState.shelterUserAccounts
  );
  const [walletAuditEvents, setWalletAuditEvents] = useState<AuditEvent[]>(auditEvents);
  const [walletProofReceipts, setWalletProofReceipts] = useState<ProofReceiptView[]>(proofReceipts);
  const [exportBundleViews, setExportBundleViews] = useState<ExportBundleView[]>(exportBundles);
  const [accessRequests, setAccessRequests] = useState(initialAccessRequests);
  const [grantReceipts, setGrantReceipts] = useState(initialGrantReceipts);
  const [savedServices, setSavedServices] = useState<SavedService[]>([]);
  const [servicePlans, setServicePlans] = useState<ServicePlan[]>([]);
  const [serviceInteractions, setServiceInteractions] = useState<ServiceInteractionEvent[]>([]);
  const [analyticsOptIn, setAnalyticsOptIn] = useState<Record<string, boolean>>(() => defaultAppState.analyticsOptIn);
  const [shelterChecklist, setShelterChecklist] = useState(() => defaultAppState.shelterChecklist);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agentChatOpen, setAgentChatOpen] = useState(false);
  const [agentChatMode, setAgentChatMode] = useState<"text" | "audio">("text");
  const walletApiConfig = useMemo(readWalletApiConfig, []);
  const [benefitsOptIn, setBenefitsOptIn] = useState(defaultAppState.benefitsOptIn);

  async function refreshWalletAuditEvents() {
    if (!walletApiConfig) return;
    const events = await listWalletAuditEvents(walletApiConfig);
    setWalletAuditEvents(events.length ? events : auditEvents);
  }

  async function refreshWalletDocuments() {
    if (!walletApiConfig) return;
    const documents = await listWalletDocuments(walletApiConfig);
    setUploads(documents.length ? documents : initialUploads);
  }

  async function refreshWalletProofReceipts() {
    if (!walletApiConfig) return;
    const proofs = await listWalletProofReceipts(walletApiConfig);
    setWalletProofReceipts(proofs.length ? proofs : proofReceipts);
  }

  async function refreshWalletAfterSnapshotLoad() {
    if (!walletApiConfig) return;
    await Promise.all([
      refreshWalletAuditEvents().catch(() => setWalletAuditEvents(auditEvents)),
      refreshWalletDocuments().catch(() => setUploads(initialUploads)),
      refreshWalletProofReceipts().catch(() => setWalletProofReceipts(proofReceipts))
    ]);
  }

  async function refreshWalletAccessState() {
    if (!walletApiConfig) return;
    const state = await loadWalletAccessState(walletApiConfig);
    setAccessRequests(state.accessRequests.length ? state.accessRequests : initialAccessRequests);
    setGrantReceipts(state.grantReceipts.length ? state.grantReceipts : initialGrantReceipts);
  }

  const agentRuntime = useMemo<AppActionRuntime>(
    () => ({
      getState: () => ({
        activeRoute: activeRouteRef.current,
        profile,
        policy,
        recipients,
        shelterContactRequests,
        shelterStaffAccounts,
        shelterUserAccounts,
        uploads,
        accessRequests,
        grantReceipts,
        walletAuditEvents,
        analyticsOptIn,
        walletProofReceipts,
        exportBundleViews,
        savedServices,
        servicePlans,
        serviceInteractions,
        walletUnlocked: true,
        privateContextAllowed: false,
        permissionLevel: "wallet_write" as const
      }),
      setActiveRoute: (route: RouteId) => {
        const nextRoute = normalizeAppRoute(route);
        activeRouteRef.current = nextRoute;
        setActiveRoute(nextRoute);
      },
      setServiceDetailDocId,
      setMobileNavOpen,
      setProfile,
      setPolicy,
      setRecipients,
      setShelterContactRequests,
      setShelterStaffAccounts,
      setShelterUserAccounts,
      setUploads,
      setAccessRequests,
      setGrantReceipts,
      setWalletAuditEvents,
      setAnalyticsOptIn,
      setWalletProofReceipts,
      setExportBundleViews,
      setSavedServices,
      setServicePlans,
      setServiceInteractions,
      walletApiConfig,
      refreshWalletAccessState,
      refreshWalletAuditEvents
    }),
    [
      accessRequests,
      exportBundleViews,
      grantReceipts,
      analyticsOptIn,
      policy,
      profile,
      recipients,
      savedServices,
      serviceInteractions,
      servicePlans,
      shelterContactRequests,
      shelterStaffAccounts,
      shelterUserAccounts,
      uploads,
      walletApiConfig,
      walletAuditEvents,
      walletProofReceipts
    ]
  );
  const agentChat = useAgentChatService(agentRuntime);

  useEffect(() => {
    activeRouteRef.current = activeRoute;
  }, [activeRoute]);

  useEffect(() => {
    const syncRouteFromHash = () => {
      const detailDocId = getServiceDetailDocIdFromHash();
      const nextRoute = detailDocId ? "social-services" : normalizeAppRoute(getRouteFromHash());
      setServiceDetailDocId(detailDocId);
      activeRouteRef.current = nextRoute;
      setActiveRoute(nextRoute);
      setMobileNavOpen(false);
    };
    window.addEventListener("hashchange", syncRouteFromHash);
    return () => window.removeEventListener("hashchange", syncRouteFromHash);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writePersistedAppState({
      profile,
      policy,
      recipients,
      uploads,
      shelterContactRequests,
      shelterStaffAccounts,
      shelterUserAccounts,
      benefitsOptIn,
      analyticsOptIn,
      shelterChecklist
    });
  }, [
    analyticsOptIn,
    benefitsOptIn,
    policy,
    profile,
    recipients,
    shelterContactRequests,
    shelterChecklist,
    shelterStaffAccounts,
    shelterUserAccounts,
    uploads
  ]);

  useEffect(() => {
    if (!walletApiConfig) return;
    refreshWalletDocuments().catch(() => setUploads(initialUploads));
  }, [walletApiConfig]);

  useEffect(() => {
    if (!walletApiConfig) return;
    refreshWalletAccessState().catch(() => {
      setAccessRequests(initialAccessRequests);
      setGrantReceipts(initialGrantReceipts);
    });
  }, [walletApiConfig]);

  useEffect(() => {
    if (!walletApiConfig) return;
    refreshWalletAuditEvents().catch(() => setWalletAuditEvents(auditEvents));
  }, [walletApiConfig]);

  useEffect(() => {
    if (!walletApiConfig) return;
    refreshWalletProofReceipts().catch(() => setWalletProofReceipts(proofReceipts));
  }, [walletApiConfig]);

  useEffect(() => {
    if (!walletApiConfig) return;
    refreshWalletAccessState().catch(() => {
      setAccessRequests([]);
      setGrantReceipts([]);
    });
  }, [walletApiConfig]);

  useEffect(() => {
    if (!walletApiConfig) return;
    const demoBundleJson = import.meta.env.VITE_DEMO_EXPORT_BUNDLE_JSON as string | undefined;
    if (!demoBundleJson) return;

    try {
      const bundle = JSON.parse(demoBundleJson);
      loadExportBundleView({
        apiBaseUrl: walletApiConfig.apiBaseUrl,
        bundle,
        imported: true
      })
        .then((bundleView) => {
          setExportBundleViews((current) =>
            current.some((item) => item.id === bundleView.id) ? current : [bundleView, ...current]
          );
        })
        .catch(() => undefined);
    } catch {
      // Ignore malformed optional demo data and keep the static bundle examples.
    }
  }, [walletApiConfig]);

  function navigate(route: RouteId) {
    const nextRoute = normalizeAppRoute(route);
    setLocationRouteHash(nextRoute);
    activeRouteRef.current = nextRoute;
    setActiveRoute(nextRoute);
    setServiceDetailDocId(null);
    setMobileNavOpen(false);
  }

  function handleSignIn(username: string) {
    const nextUsername = username.trim();
    setSignedInUser(nextUsername);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(APP_SESSION_KEY, JSON.stringify({ username: nextUsername }));
    }
  }

  function handleSignOut() {
    setSignedInUser("");
    setActiveRoute("home");
    setMobileNavOpen(false);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(APP_SESSION_KEY);
      window.location.hash = "#/";
    }
  }

  const nextCheckIn = useMemo(() => {
    const next = new Date(policy.lastCheckInAt);
    next.setDate(next.getDate() + policy.intervalDays);
    return next.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }, [policy.intervalDays, policy.lastCheckInAt]);

  const routes = useMemo(() => primaryRoutes.map((route) => ({ ...route, icon: routeIcons[route.id] ?? Home })), []);
  const secondaryNavigationRoutes = useMemo(() => secondaryRoutes.map((route) => ({ ...route, icon: routeIcons[route.id] ?? Home })), []);
  const navigationRoutes = useMemo(() => appRoutes.map((route) => ({ ...route, icon: routeIcons[route.id] ?? Home })), []);

  if (!signedInUser) {
    return <LoginScreen onSignIn={handleSignIn} />;
  }

  return (
    <div className={`app ${agentChatOpen ? "app-chat-open" : ""}`}>
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>Abby</strong>
            <small>Safety and services</small>
          </div>
        </div>
        <nav className="nav-list">
          {routes.map((route) => (
            <NavButton
              active={activeRoute === route.id}
              icon={route.icon}
              key={route.id}
              label={route.label}
              onClick={() => navigate(route.id)}
            />
          ))}
        </nav>
        <div className="nav-secondary">
          {secondaryNavigationRoutes.map((route) => (
            <NavButton
              active={activeRoute === route.id}
              icon={route.icon}
              key={route.id}
              label={route.label}
              onClick={() => navigate(route.id)}
            />
          ))}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <Button
            ariaControls="mobile-navigation"
            ariaExpanded={mobileNavOpen}
            ariaLabel={mobileNavOpen ? "Close menu" : "Open menu"}
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
            variant="quiet"
          >
            <Menu size={20} />
          </Button>
          <div>
            <strong>Abby</strong>
            <small>Next check-in: {nextCheckIn}</small>
          </div>
          <div className="topbar-actions">
            <Button
              ariaControls="agent-chat-bottom-sheet"
              ariaExpanded={agentChatOpen}
              ariaLabel={agentChatOpen ? "Close assistant" : "Open assistant"}
              onClick={() => setAgentChatOpen((open) => !open)}
              variant="quiet"
            >
              <MessageSquare size={20} />
            </Button>
            <Button ariaLabel="Sign out" onClick={handleSignOut} variant="quiet">
              <LogOut size={20} />
            </Button>
          </div>
        </header>

        {mobileNavOpen ? (
          <nav className="mobile-nav-panel" id="mobile-navigation" aria-label="Mobile navigation">
            {navigationRoutes.map((route) => (
              <NavButton
                active={activeRoute === route.id}
                icon={route.icon}
                key={route.id}
                label={route.label}
                onClick={() => navigate(route.id)}
              />
            ))}
          </nav>
        ) : null}

        {activeRoute === "home" ? (
          <HomeScreen
            accessRequests={accessRequests}
            navigate={navigate}
            nextCheckIn={nextCheckIn}
            recipients={recipients}
            uploads={uploads}
          />
        ) : null}
        {activeRoute === "register" ? (
          <RegistrationScreen
            onVerifyWorldId={() => navigate("proof-center")}
            profile={profile}
            setProfile={setProfile}
            shelterStaffAccounts={shelterStaffAccounts}
            setShelterStaffAccounts={setShelterStaffAccounts}
            worldIdState={worldIdSurfaceState}
          />
        ) : null}
        {activeRoute === "check-in" ? (
          <CheckInScreen nextCheckIn={nextCheckIn} policy={policy} profile={profile} setPolicy={setPolicy} />
        ) : null}
        {activeRoute === "contacts" ? (
          <ContactsScreen
            contactRequests={shelterContactRequests}
            profile={profile}
            recipients={recipients}
            setContactRequests={setShelterContactRequests}
            setRecipients={setRecipients}
          />
        ) : null}
        {activeRoute === "recipient-access" ? (
          <RecipientAccessScreen
            accessRequests={accessRequests}
            grantReceipts={grantReceipts}
          />
        ) : null}
        {activeRoute === "benefits-protection" ? (
          <BenefitsProtectionScreen optedIn={benefitsOptIn} setOptedIn={setBenefitsOptIn} />
        ) : null}
        {activeRoute === "uploads" ? (
          <UploadsScreen
            apiConfig={walletApiConfig}
            onVerifyWorldId={() => navigate("proof-center")}
            proofs={walletProofReceipts}
            refreshWalletAuditEvents={refreshWalletAuditEvents}
            uploads={uploads}
            setUploads={setUploads}
            worldIdState={worldIdSurfaceState}
          />
        ) : null}
        {serviceDetailDocId ? (
          <ServiceDetailScreen docId={serviceDetailDocId} onBack={() => navigate("social-services")} siteLocale="en" />
        ) : null}
        {activeRoute === "social-services" && !serviceDetailDocId ? (
          <SocialServicesScreen proofs={walletProofReceipts} />
        ) : null}
        {activeRoute === "shelter" ? (
          <ShelterScreen
            checklist={shelterChecklist}
            setChecklist={setShelterChecklist}
            contactRequests={shelterContactRequests}
            recipients={recipients}
            setContactRequests={setShelterContactRequests}
            setRecipients={setRecipients}
            shelterStaffAccounts={shelterStaffAccounts}
            setShelterStaffAccounts={setShelterStaffAccounts}
            shelterUserAccounts={shelterUserAccounts}
            setShelterUserAccounts={setShelterUserAccounts}
            worldIdState={worldIdSurfaceState}
          />
        ) : null}
        {activeRoute === "analytics" ? (
          <AnalyticsScreen optedIn={analyticsOptIn} proofs={walletProofReceipts} setOptedIn={setAnalyticsOptIn} />
        ) : null}
        {activeRoute === "proof-center" ? (
          <ProofCenterScreen
            apiConfig={walletApiConfig}
            proofs={walletProofReceipts}
            refreshWalletAuditEvents={refreshWalletAuditEvents}
            refreshWalletProofReceipts={refreshWalletProofReceipts}
            setProofs={setWalletProofReceipts}
            worldIdState={worldIdSurfaceState}
          />
        ) : null}
        {activeRoute === "exports" ? (
          <ExportCenterScreen
            apiConfig={walletApiConfig}
            bundles={exportBundleViews}
            proofs={walletProofReceipts}
            setBundles={setExportBundleViews}
          />
        ) : null}
        {activeRoute === "security" ? (
          <SecurityScreen
            apiConfig={walletApiConfig}
            onVerifyWorldId={() => navigate("proof-center")}
            onSnapshotLoaded={refreshWalletAfterSnapshotLoad}
            proofs={walletProofReceipts}
            worldIdState={worldIdSurfaceState}
          />
        ) : null}
        {activeRoute === "audit" ? <AuditScreen events={walletAuditEvents} proofs={walletProofReceipts} /> : null}
      </main>
      <AgentChatDrawer
        activeRouteLabel={getRouteLabel(activeRoute)}
        confirmations={agentChat.pendingConfirmations}
        evidenceBundles={agentChat.snapshot.session.evidenceBundles}
        messages={agentChat.messages}
        mode={agentChatMode}
        onCancelConfirmation={(confirmationId) => agentChat.denyConfirmation(confirmationId)}
        onClose={() => setAgentChatOpen(false)}
        onConfirmConfirmation={(confirmationId) => agentChat.approveConfirmation(confirmationId)}
        onOpenAudio={() => {
          setAgentChatMode("audio");
          setAgentChatOpen(true);
        }}
        onOpenServiceDetail={(docId) =>
          openCanonicalServiceDetailRoute(docId, {
            setActiveRoute: (route) => {
              const nextRoute = normalizeAppRoute(route);
              activeRouteRef.current = nextRoute;
              setActiveRoute(nextRoute);
            },
            setServiceDetailDocId,
            setMobileNavOpen
          })
        }
        onSend={(message) => {
          void agentChat.sendMessage(message);
        }}
        onOpenText={() => {
          setAgentChatMode("text");
          setAgentChatOpen(true);
        }}
        open={agentChatOpen}
        responding={agentChat.responding}
        toolCalls={agentChat.snapshot.session.toolCalls}
        toolResults={agentChat.snapshot.session.toolResults}
      />
    </div>
  );
}

function readWalletApiConfig(): WalletApiConfig | undefined {
  const apiBaseUrl = import.meta.env.VITE_WALLET_API_BASE_URL as string | undefined;
  const walletId = import.meta.env.VITE_DEMO_WALLET_ID as string | undefined;
  const envConfig =
    apiBaseUrl && walletId
      ? {
          apiBaseUrl,
          walletId,
          actorDid: import.meta.env.VITE_DEMO_ACTOR_DID as string | undefined,
          issuerKeyHex: import.meta.env.VITE_DEMO_ISSUER_KEY_HEX as string | undefined,
          audienceKeyHex: import.meta.env.VITE_DEMO_AUDIENCE_KEY_HEX as string | undefined
        }
      : undefined;
  return envConfig ?? readUrlWalletApiConfig() ?? readStoredWalletApiConfig();
}

function readUrlWalletApiConfig(): WalletApiConfig | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URL(window.location.href).searchParams;
  const apiBaseUrl = params.get("walletApiBaseUrl") ?? undefined;
  const walletId = params.get("walletId") ?? undefined;
  if (!apiBaseUrl || !walletId) return undefined;
  return {
    apiBaseUrl,
    walletId,
    actorDid: params.get("actorDid") ?? undefined,
    issuerKeyHex: params.get("issuerKeyHex") ?? undefined,
    audienceKeyHex: params.get("audienceKeyHex") ?? undefined
  };
}

function readStoredWalletApiConfig(): WalletApiConfig | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const storedConfig = JSON.parse(window.localStorage.getItem(WALLET_API_CONFIG_KEY) ?? "null") as Partial<
      WalletApiConfig
    > | null;
    if (!storedConfig?.apiBaseUrl || !storedConfig.walletId) return undefined;
    return {
      apiBaseUrl: storedConfig.apiBaseUrl,
      walletId: storedConfig.walletId,
      actorDid: storedConfig.actorDid,
      issuerKeyHex: storedConfig.issuerKeyHex,
      audienceKeyHex: storedConfig.audienceKeyHex
    };
  } catch {
    return undefined;
  }
}

function NavButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: typeof Home;
  label: string;
  onClick: () => void;
}) {
  return (
    <button aria-current={active ? "page" : undefined} className="nav-button" onClick={onClick} type="button">
      <Icon aria-hidden="true" size={19} />
      <span>{label}</span>
    </button>
  );
}

function LoginScreen({ onSignIn }: { onSignIn: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const canSignIn = username.trim().length > 0 && password.trim().length > 0;

  function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSignIn) {
      onSignIn(username);
    }
  }

  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={submitLogin}>
        <div className="login-brand">
          <span className="login-mark">A</span>
          <div>
            <p className="eyebrow">Abby</p>
            <h1>Sign in</h1>
          </div>
        </div>
        <Field label="Username" required>
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="Password" required>
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button disabled={!canSignIn} type="submit">
          <LockKeyhole aria-hidden="true" size={18} /> Sign in
        </Button>
      </form>
    </main>
  );
}

function HomeScreen({
  accessRequests,
  navigate,
  nextCheckIn,
  recipients,
  uploads
}: {
  accessRequests: WalletAccessRequest[];
  navigate: (route: RouteId) => void;
  nextCheckIn: string;
  recipients: DisclosureRecipientDraft[];
  uploads: UploadItem[];
}) {
  const accessConsensusItems = accessRequests.length
    ? accessRequests.slice(0, 2)
    : [
        {
          id: "direct-recipient-access",
          purpose: "Advisory recipient-access summary",
          requesterName: "Local wallet",
          resourceLabel: "derived artifacts"
        }
      ];

  return (
    <div className="screen home-screen">
      <div className="page-title home-hero">
        <p className="eyebrow">Today</p>
        <h1>Welcome to your safety plan!</h1>
      </div>
      <Section title="Quick actions">
        <div className="quick-actions">
          <button className="checkin-panel" onClick={() => navigate("check-in")} type="button">
            <div className="checkin-panel-icon">
              <CalendarCheck size={24} aria-hidden="true" />
            </div>
            <div className="checkin-panel-text">
              <span className="checkin-panel-label">Next check-in</span>
              <span className="checkin-panel-value">{nextCheckIn}</span>
            </div>
            <span className="checkin-panel-cta">Check in now</span>
          </button>
        </div>
      </Section>
      <div className="home-actions" aria-label="Safety plan setup">
        <ActionCard
          detail={`${recipients.length} people or services set up`}
          icon={<ContactRound aria-hidden="true" size={28} />}
          onClick={() => navigate("contacts")}
          title="Contacts"
        />
        <ActionCard
          detail="Review what helpers can see"
          icon={<ShieldCheck aria-hidden="true" size={28} />}
          onClick={() => navigate("contacts")}
          title="Sharing"
        />
      </div>
      <div className="home-footer">
        <div className="home-footer-stat">
          <small>Saved files</small>
          <span>{uploads.length} file{uploads.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="home-footer-divider" />
        <div className="home-footer-stat">
          <small>Contact sharing</small>
          <span>Ready to review</span>
        </div>
      </div>
      <Section title="Recipient access artifacts">
        <div className="consensus-surface-list">
          {accessConsensusItems.map((item) => (
            <article className="consensus-surface-item" key={item.id}>
              <div>
                <h3>{item.resourceLabel}</h3>
                <p>{item.requesterName} · {item.purpose}</p>
              </div>
              <ConsensusMetadataPanel
                directLabel="Direct AI response"
                metadata={getConsensusMetadataFromView(item)}
                surfaceLabel="Recipient access derived artifacts"
              />
            </article>
          ))}
        </div>
      </Section>
      <section className="support-card" aria-labelledby="support-card-title">
        <span className="support-card-badge" aria-hidden="true" />
        <div className="support-card-content">
          <h2 id="support-card-title">Need help today?</h2>
          <p>Find shelter, services, and support through your local 211 network.</p>
          <Button onClick={() => navigate("social-services")}>
            <HeartHandshake aria-hidden="true" size={18} /> Find help near you
          </Button>
        </div>
      </section>
    </div>
  );
}

function StatusPanel({ label, value, tone, onClick }: { label: string; value: string; tone: string; onClick?: () => void }) {
  return (
    <div className={`status-panel panel-${tone}${onClick ? " status-panel-clickable" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function formatConsensusMode(mode: string): string {
  const labels: Record<string, string> = {
    chainlink_cre: "Chainlink CRE",
    hybrid: "Hybrid consensus",
    libp2p_quorum: "libp2p quorum",
    receipt_only: "Receipt-only",
    tee_or_zkml: "TEE or ZKML",
    zkml_required: "ZKML required"
  };
  return labels[mode] ?? mode.replace(/_/g, " ");
}

function ConsensusMetadataPanel({
  directLabel = "Direct AI response",
  metadata,
  surfaceLabel
}: {
  directLabel?: string;
  metadata?: WalletConsensusMetadata;
  surfaceLabel: string;
}) {
  const state = getConsensusDisplayState(metadata);
  const modeLabel = metadata ? formatConsensusMode(metadata.mode) : "Direct";
  const quorumLabel = metadata
    ? metadata.operator_count > 0
      ? `${metadata.selected_operator_count}/${metadata.operator_count}`
      : "Not reported"
    : "None";

  return (
    <div className={`consensus-panel consensus-${state.family}`} aria-label={`${surfaceLabel} ${state.statusLabel}`}>
      <div className="consensus-panel-header">
        <div>
          <strong>{metadata ? state.statusLabel : directLabel}</strong>
          <span>{state.detailLabel}</span>
        </div>
        <Badge tone={state.tone}>{state.badgeLabel}</Badge>
      </div>
      <div className="consensus-row-grid">
        <div className="consensus-row">
          <span>Mode</span>
          <strong>{modeLabel}</strong>
        </div>
        <div className="consensus-row">
          <span>Quorum</span>
          <strong>{quorumLabel}</strong>
        </div>
        <div className="consensus-row">
          <span>Evidence</span>
          <strong>{state.evidenceLabel}</strong>
        </div>
        <div className="consensus-row">
          <span>Boundary</span>
          <strong>{state.inputBoundaryLabel}</strong>
        </div>
      </div>
      {metadata ? (
        <div className="consensus-metadata-list">
          <span>{metadata.comparison.replace(/_/g, " ")}</span>
          {metadata.receipt_hash ? <span>receipt {shortHash(metadata.receipt_hash)}</span> : null}
          {metadata.receipt_cid ? <span>CID {shortHash(metadata.receipt_cid)}</span> : null}
          {metadata.proof_cid ? <span>proof {shortHash(metadata.proof_cid)}</span> : null}
          {metadata.public_inputs_hash ? <span>public inputs {shortHash(metadata.public_inputs_hash)}</span> : null}
          {metadata.tee_attestation_hash ? <span>TEE {shortHash(metadata.tee_attestation_hash)}</span> : null}
          {metadata.cre_workflow_id ? <span>CRE workflow {metadata.cre_workflow_id}</span> : null}
          {metadata.cre_report_id ? <span>CRE report {metadata.cre_report_id}</span> : null}
          {metadata.chain_id || metadata.tx_hash ? <span>{state.onChainLabel}</span> : null}
          {metadata.fail_closed_error ? <span>{metadata.fail_closed_error.replace(/_/g, " ")}</span> : null}
          {metadata.failure_reason ? <span>{metadata.failure_reason}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ConsensusSurfaceStats({ proofs }: { proofs: ProofReceiptView[] }) {
  const consensusStates = proofs.map(getConsensusMetadataFromView).filter(Boolean) as WalletConsensusMetadata[];
  const creCount = consensusStates.filter((metadata) => metadata.mode === "chainlink_cre").length;
  const zkmlCount = consensusStates.filter((metadata) => metadata.proof_mode === "zkml_required" || metadata.mode === "zkml_required").length;
  const teeCount = consensusStates.filter((metadata) => metadata.proof_mode === "tee_or_zkml" || Boolean(metadata.tee_attestation_hash)).length;
  const manualCount = consensusStates.filter((metadata) => getConsensusDisplayState(metadata).manualReview).length;

  return (
    <div className="privacy-metrics consensus-metrics">
      <StatusPanel label="CRE claims" value={String(creCount)} tone="teal" />
      <StatusPanel label="ZKML claims" value={String(zkmlCount)} tone="gold" />
      <StatusPanel label="TEE attestations" value={String(teeCount)} tone="teal" />
      <StatusPanel label="Manual review" value={String(manualCount)} tone="red" />
    </div>
  );
}

function proofApiErrorMessage(error: unknown): string {
  if (error instanceof WalletApiRequestError) {
    return error.detail || error.message;
  }
  return error instanceof Error ? error.message : "Proof request failed.";
}

function proofSurfaceMessage(proof: ProofReceiptView, surface: "uploads" | "provider" | "dashboard" | "export" | "security" | "audit" | "qr"): string {
  const state = getProofReceiptUiState(proof);
  if (surface === "provider") return state.providerLabel;
  if (surface === "dashboard") return state.dashboardLabel;
  if (surface === "export") return state.exportLabel;
  if (surface === "qr") return state.qrReviewLabel;
  if (surface === "security") return state.failClosed ? "Verifier state fails closed" : state.inputBoundaryLabel;
  if (surface === "audit") return `${state.statusLabel} · ${state.proofSystemLabel}`;
  return state.inputBoundaryLabel;
}

function ProofSurfaceSummary({
  emptyMessage = "No proof receipts are available yet.",
  limit = 4,
  proofs,
  surface,
  title
}: {
  emptyMessage?: string;
  limit?: number;
  proofs: ProofReceiptView[];
  surface: "uploads" | "provider" | "dashboard" | "export" | "security" | "audit" | "qr";
  title: string;
}) {
  const visibleProofs = proofs.slice(0, limit);

  return (
    <Section title={title}>
      {visibleProofs.length ? (
        <div className="proof-surface-grid">
          {visibleProofs.map((proof) => {
            const state = getProofReceiptUiState(proof);
            return (
              <article
                aria-label={`${proof.claim} ${state.proofSystemLabel} ${state.statusLabel}`}
                className={`proof-surface-card proof-system-${state.proofSystemFamily}`}
                key={`${surface}-${proof.id}`}
              >
                <div className="scope-header">
                  <div>
                    <h3>{proof.claim}</h3>
                    <p>{proof.verifier}</p>
                  </div>
                  <Badge tone={state.statusTone}>{state.statusLabel}</Badge>
                </div>
                <div className="badge-row">
                  <Badge>{state.proofSystemLabel}</Badge>
                  <Badge tone={state.productionEvidence ? "success" : "warning"}>{state.dashboardLabel}</Badge>
                </div>
                <div className="proof-state-row">
                  <strong>Surface</strong>
                  <span>{proofSurfaceMessage(proof, surface)}</span>
                </div>
                <div className="proof-state-row">
                  <strong>On-chain</strong>
                  <span>{state.onChainLabel}</span>
                </div>
                <ConsensusMetadataPanel
                  directLabel="Direct wallet proof"
                  metadata={state.consensus}
                  surfaceLabel={`${title} consensus state`}
                />
              </article>
            );
          })}
        </div>
      ) : (
        <StatusBanner tone="info">{emptyMessage}</StatusBanner>
      )}
    </Section>
  );
}

function WorldIdSurfaceSummary({
  description,
  onVerify,
  state,
  surfaceLabel
}: {
  description: string;
  onVerify: () => void;
  state: WorldIdSurfaceState;
  surfaceLabel: string;
}) {
  const headingId = `world-id-${surfaceLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-status`;

  return (
    <section aria-label={`${surfaceLabel} World ID status`} className="world-id-surface-summary">
      <div className="scope-header">
        <div>
          <p className="eyebrow">{surfaceLabel} World ID status</p>
          <h2 id={headingId}>Proof-of-human status</h2>
        </div>
        <Badge tone={state.statusTone}>{state.statusLabel}</Badge>
      </div>
      <p className="world-id-surface-copy">{description}</p>
      <div className="world-id-surface-facts" aria-label={`${surfaceLabel} World ID facts`}>
        <StatusPanel label="Status" tone={state.statusTone} value={state.verified ? "Verified proof-of-human" : "Not verified"} />
        <StatusPanel label="Proof receipt" tone={state.statusTone} value={state.proofReceiptLabel} />
        <StatusPanel label="Verification" tone={state.canOfferVerification ? "success" : "warning"} value={state.availabilityLabel} />
        <StatusPanel label="Wallet" tone={state.walletLabel === "Not connected" ? "warning" : "success"} value={state.walletLabel} />
        <StatusPanel label="Actor DID" tone={state.actorDidLabel === "Required" ? "warning" : "success"} value={state.actorDidLabel} />
      </div>
      <StatusBanner tone="info">
        World ID is optional on this surface. Emergency and essential-service flows remain available even when World ID is unavailable.
      </StatusBanner>
      <div className="world-id-surface-actions">
        {state.canOfferVerification ? (
          <Button onClick={onVerify} variant="secondary">
            <ShieldCheck aria-hidden="true" size={18} /> Verify with World ID
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function RegistrationScreen({
  onVerifyWorldId,
  profile,
  setProfile,
  shelterStaffAccounts,
  setShelterStaffAccounts,
  worldIdState
}: {
  onVerifyWorldId: () => void;
  profile: RegistrationProfileDraft;
  setProfile: (profile: RegistrationProfileDraft) => void;
  shelterStaffAccounts: ShelterStaffAccount[];
  setShelterStaffAccounts: (accounts: ShelterStaffAccount[]) => void;
  worldIdState: WorldIdSurfaceState;
}) {
  const update = (patch: Partial<RegistrationProfileDraft>) => setProfile({ ...profile, ...patch });
  const [photoFileDetail, setPhotoFileDetail] = useState("");
  const [photoUploadError, setPhotoUploadError] = useState("");
  const [isShelterStaff, setIsShelterStaff] = useState(false);
  const [selectedShelter, setSelectedShelter] = useState("");
  const [shelterPin, setShelterPin] = useState("");
  const [currentStaffAccountId, setCurrentStaffAccountId] = useState("");

  const currentStaffAccount = shelterStaffAccounts.find((account) => account.id === currentStaffAccountId);
  const staffVerified = Boolean(currentStaffAccount?.verified);

  async function handleProfileUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      update({ photoAssetId: "" });
      setPhotoFileDetail("");
      setPhotoUploadError("");
      return;
    }

    if (!isAcceptedIdentityDocument(file)) {
      update({ photoAssetId: "" });
      setPhotoFileDetail("");
      setPhotoUploadError("We can't use this file. Use JPG, PNG, WebP, or PDF.");
      return;
    }

    update({ photoAssetId: file.name });
    setPhotoFileDetail(getIdentityDocumentFileDetail(file));
    setPhotoUploadError("");
  }

  function toggleNeed(need: string) {
    update({
      serviceNeeds: profile.serviceNeeds.includes(need)
        ? profile.serviceNeeds.filter((item) => item !== need)
        : [...profile.serviceNeeds, need]
    });
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Registration</p>
        <h1>Create your Abby profile</h1>
      </div>
      <p className="page-note">To start, add your name, birth date, photo or ID.</p>
      <WorldIdSurfaceSummary
        description="World ID can add an optional proof-of-human receipt to the wallet. It does not prove legal name, age, citizenship, address, or document ownership."
        onVerify={onVerifyWorldId}
        state={worldIdState}
        surfaceLabel="Register"
      />
      <form className="form-grid" onSubmit={(event) => event.preventDefault()}>
        <Field help="This helps us know it is you in an emergency." label="Legal or full name" required>
          <input value={profile.legalName} onChange={(event) => update({ legalName: event.target.value })} />
        </Field>
        <Field help="Shown in the app when provided." label="Preferred name">
          <input value={profile.preferredName} onChange={(event) => update({ preferredName: event.target.value })} />
        </Field>
        <Field help="Optional. You can use any words you want." label="Pronouns">
          <input
            placeholder="call me she/her, he/him, they/them"
            value={profile.pronouns}
            onChange={(event) => update({ pronouns: event.target.value })}
          />
        </Field>
        <Field help="This helps tell people with the same name apart." label="Birth date" required>
          <input
            type="date"
            value={profile.dateOfBirth}
            onChange={(event) => update({ dateOfBirth: event.target.value })}
          />
        </Field>
        <Field
          error={photoUploadError}
          help="Use a JPG, PNG, WebP, or PDF file. We will not show a preview."
          label="Photo or photo ID"
          required
        >
          <input
            accept={ID_DOCUMENT_ACCEPT_ATTR}
            type="file"
            onChange={handleProfileUploadChange}
          />
          {photoFileDetail ? (
            <small className="registration-file-detail" aria-live="polite">
              Selected file: {photoFileDetail}
            </small>
          ) : null}
        </Field>
        <hr className="form-divider full-span" />
        <Field help="Used for text reminders." label="Phone">
          <input value={profile.phone} onChange={(event) => update({ phone: event.target.value })} />
        </Field>
        <Field help="Used for email reminders." label="Email">
          <input type="email" value={profile.email} onChange={(event) => update({ email: event.target.value })} />
        </Field>
        <Field help="Can be a neighborhood, shelter, or general area." label="Current safe location">
          <input value={profile.currentLocation} onChange={(event) => update({ currentLocation: event.target.value })} />
        </Field>
        <Field help="Optional; useful for assisted setup." label="Preferred shelter">
          <input
            value={profile.shelterAffiliation}
            onChange={(event) => update({ shelterAffiliation: event.target.value })}
          />
        </Field>
        <div className="full-span">
          <span className="field-label">Service needs</span>
          <div className="chip-grid">
            {serviceNeeds.map((need) => (
              <button
                aria-pressed={profile.serviceNeeds.includes(need)}
                className="choice-chip"
                key={need}
                onClick={() => toggleNeed(need)}
                type="button"
              >
                {need}
              </button>
            ))}
          </div>
        </div>
        <label className="captcha-box full-span">
          <input
            checked={profile.easyBotCheckStatus === "passed"}
            onChange={(event) =>
              update({ easyBotCheckStatus: event.target.checked ? "passed" : "failed", captchaToken: "" })
            }
            type="checkbox"
          />
          <span>Quick health check complete (step 1)</span>
        </label>
        <label className="captcha-box full-span">
          <input checked={worldIdState.verified} disabled type="checkbox" />
          <span>
            <strong>World ID proof-of-human verified for intake</strong>
            <small>
              Uses the wallet-bound World ID receipt instead of the demo bot check when available.
            </small>
          </span>
        </label>
        <label className="captcha-box full-span">
          <input
            checked={hasManualIntakeFallback(profile)}
            disabled={worldIdState.verified}
            onChange={(event) =>
              update({
                easyBotCheckStatus: event.target.checked ? "failed" : "pending",
                captchaToken: event.target.checked ? MANUAL_INTAKE_FALLBACK_TOKEN : ""
              })
            }
            type="checkbox"
          />
          <span>
            <strong>Use manual intake fallback</strong>
            <small>Available for accessibility, device availability, or emergency service access.</small>
          </span>
        </label>
        <label className="captcha-box full-span">
          <input
            checked={hasDemoBotCheck(profile)}
            disabled={
              worldIdState.verified ||
              hasManualIntakeFallback(profile) ||
              profile.easyBotCheckStatus !== "passed"
            }
            onChange={(event) => update({ captchaToken: event.target.checked ? DEMO_BOT_CHECK_TOKEN : "" })}
            type="checkbox"
          />
          <span>
            <strong>Bot check complete (legacy demo fallback)</strong>
            <small>Use only when World ID is not available in the local demo.</small>
          </span>
        </label>
        <div className="full-span" aria-label="Client intake verification status">
          <StatusBanner tone={getIntakeVerificationTone(profile, worldIdState)}>
            {getIntakeVerificationMessage(profile, worldIdState)}
          </StatusBanner>
        </div>
        <label className="consent-box full-span">
          <input
            checked={isShelterStaff}
            onChange={(event) => {
              const checked = event.target.checked;
              setIsShelterStaff(checked);
              if (!checked) {
                setSelectedShelter("");
                setShelterPin("");
                setCurrentStaffAccountId("");
              }
            }}
            type="checkbox"
          />
          <span>
            <strong>I am shelter staff</strong>
          </span>
        </label>
        {isShelterStaff ? (
          <div className="shelter-staff-panel full-span">
            <Field help="Choose the shelter where you currently work." label="Shelter" required>
              <select
                value={selectedShelter}
                onChange={(event) => {
                  setSelectedShelter(event.target.value);
                  setCurrentStaffAccountId("");
                }}
              >
                <option value="">Select shelter</option>
                {shelterOptions.map((shelter) => (
                  <option key={shelter} value={shelter}>
                    {shelter}
                  </option>
                ))}
              </select>
            </Field>
            <Field help="Enter your assigned shelter staff PIN to verify this account." label="Shelter staff PIN" required>
              <input
                placeholder="Enter PIN"
                value={shelterPin}
                onChange={(event) => setShelterPin(event.target.value)}
              />
            </Field>
            <div>
              <Button
                disabled={!selectedShelter || !shelterPin.trim()}
                onClick={() => {
                  const displayName = profile.preferredName || profile.legalName || "Shelter staff";
                  const emailKey = profile.email.trim().toLowerCase();
                  const existingAccount = shelterStaffAccounts.find(
                    (account) =>
                      account.shelter === selectedShelter &&
                      ((emailKey && account.email.toLowerCase() === emailKey) ||
                        (!emailKey && account.displayName.toLowerCase() === displayName.toLowerCase()))
                  );

                  if (existingAccount) {
                    const updated = shelterStaffAccounts.map((account) =>
                      account.id === existingAccount.id
                        ? {
                            ...account,
                            displayName,
                            email: profile.email,
                            verified: true,
                            updatedAt: new Date().toISOString()
                          }
                        : account
                    );
                    setShelterStaffAccounts(updated);
                    setCurrentStaffAccountId(existingAccount.id);
                    return;
                  }

                  const createdAccount: ShelterStaffAccount = {
                    id: `staff-${Date.now()}`,
                    shelter: selectedShelter,
                    displayName,
                    email: profile.email,
                    verified: true,
                    updatedAt: new Date().toISOString()
                  };
                  setShelterStaffAccounts([...shelterStaffAccounts, createdAccount]);
                  setCurrentStaffAccountId(createdAccount.id);
                }}
                type="button"
              >
                Verify shelter staff
              </Button>
              {staffVerified ? <small className="pin-request-note">Shelter staff verified.</small> : null}
              {!staffVerified && currentStaffAccountId ? (
                <small className="pin-request-note">Verification revoked by shelter administrator.</small>
              ) : null}
            </div>
          </div>
        ) : null}
      </form>
    </div>
  );
}

function CheckInScreen({
  policy,
  profile,
  setPolicy,
  nextCheckIn
}: {
  policy: typeof defaultCheckInPolicy;
  profile: RegistrationProfileDraft;
  setPolicy: (policy: typeof defaultCheckInPolicy) => void;
  nextCheckIn: string;
}) {
  const [checkInMessage, setCheckInMessage] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const update = (patch: Partial<typeof defaultCheckInPolicy>) => setPolicy({ ...policy, ...patch });
  const channelLabels: Record<CheckInChannel, string> = {
    sms: "Texting allowed",
    email: "Email allowed",
    web: "Web allowed"
  };
  const checkInMethodLabels: Record<CheckInChannel, string> = {
    sms: "text",
    email: "email",
    web: "web"
  };
  const channelIsAllowed = (channel: CheckInChannel) => policy.reminderChannels.includes(channel);
  const toggleChannel = (channel: CheckInChannel) => {
    update({
      reminderChannels: policy.reminderChannels.includes(channel)
        ? policy.reminderChannels.filter((item) => item !== channel)
        : [...policy.reminderChannels, channel]
    });
    setCheckInMessage(null);
  };

  function checkInBy(channel: CheckInChannel) {
    if (!channelIsAllowed(channel)) {
      setCheckInMessage({
        tone: "warning",
        text:
          channel === "web"
            ? "Web check-in is off. Choose an allowed check-in method."
            : `${channel === "sms" ? "Texting" : "Email"} is off. Choose an allowed check-in method.`
      });
      return;
    }

    if (channel === "sms" && !profile.phone.trim()) {
      setCheckInMessage({
        tone: "warning",
        text: "Add a phone number to your account, or use another allowed check-in method."
      });
      return;
    }

    if (channel === "email" && !profile.email.trim()) {
      setCheckInMessage({
        tone: "warning",
        text: "Add an email to your account, or use another allowed check-in method."
      });
      return;
    }

    update({ lastCheckInAt: new Date().toISOString() });
    setCheckInMessage({
      tone: "success",
      text: `Checked in by ${channel === "sms" ? "text" : channel}.`
    });
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Check-in</p>
        <h1>Set your schedule</h1>
      </div>
      <StatusBanner tone="warning">You can wait up to 30 days between check-ins. After that, Abby starts the next help step.</StatusBanner>
      <Section title="Reminder schedule">
        <div className="form-grid">
          <Field help="Choose 1 to 30 days." label="Days between check-ins" required>
            <input
              max={30}
              min={1}
              type="number"
              value={policy.intervalDays}
              onChange={(event) =>
                update({ intervalDays: Math.max(1, Math.min(30, Number(event.target.value || 1))) })
              }
            />
          </Field>
          <Field help="Extra time after a missed check-in before Abby starts the next help step." label="Extra hours after a missed check-in">
            <input
              min={0}
              type="number"
              value={policy.gracePeriodHours}
              onChange={(event) => update({ gracePeriodHours: Number(event.target.value || 0) })}
            />
          </Field>
        </div>
        <p className="supporting-copy">You can check in by text, email, or web when that method is allowed.</p>
        <div className="channel-controls" role="group" aria-label="Allowed check-in methods">
          {(["sms", "email", "web"] as CheckInChannel[]).map((channel) => (
            <button
              aria-pressed={policy.reminderChannels.includes(channel)}
              className="choice-chip channel-toggle"
              key={channel}
              onClick={() => toggleChannel(channel)}
              type="button"
            >
              <span>{channelLabels[channel]}</span>
              <small>{channelIsAllowed(channel) ? "On" : "Off"}</small>
            </button>
          ))}
        </div>
        {!policy.reminderChannels.length ? (
          <StatusBanner tone="warning">No check-in method is on. Turn on text, email, or web to check in.</StatusBanner>
        ) : null}
        <div className="schedule-preview">
          <CalendarCheck aria-hidden="true" size={28} />
          <div>
            <small>Next check-in</small>
            <strong>{nextCheckIn}</strong>
          </div>
        </div>
        {checkInMessage ? <StatusBanner tone={checkInMessage.tone}>{checkInMessage.text}</StatusBanner> : null}
        <div className="method-checkin-grid" role="group" aria-label="Check in now">
          {(["sms", "email", "web"] as CheckInChannel[]).map((channel) => {
            const allowed = channelIsAllowed(channel);
            return (
              <Button key={channel} onClick={() => checkInBy(channel)} variant={allowed ? "primary" : "secondary"}>
                <Bell size={18} /> Check in by {checkInMethodLabels[channel]}{allowed ? "" : " (off)"}
              </Button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function toggleScopeSelection(scopes: DisclosureDataScope[], scope: DisclosureDataScope): DisclosureDataScope[] {
  return scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope];
}

function SharingScopeChecklist({
  label,
  scopes,
  onToggle,
  help
}: {
  label: string;
  scopes: DisclosureDataScope[];
  onToggle: (scope: DisclosureDataScope) => void;
  help?: string;
}) {
  return (
    <fieldset className="scope-fieldset">
      <legend>{label}</legend>
      {help ? <p className="scope-help">{help}</p> : null}
      <div className="scope-grid">
        {disclosureScopes.map((scope) => (
          <label className="scope-option" key={scope.id}>
            <input checked={scopes.includes(scope.id)} onChange={() => onToggle(scope.id)} type="checkbox" />
            <span>
              <strong>{scope.label}</strong>
              <small>{scope.detail}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function getDisclosureScopeLabels(scopes: DisclosureDataScope[]): string {
  return scopes.map((scope) => disclosureScopes.find((item) => item.id === scope)?.label ?? scope).join(", ");
}

function SharingCapabilityPreview({ recipientName, scopes }: { recipientName: string; scopes: DisclosureDataScope[] }) {
  const abilities = abilitiesForDisclosureScopes(scopes);

  return (
    <div className="capability-preview" role="group" aria-label={`${recipientName} sharing capability preview`}>
      <div className="scope-header">
        <div>
          <h4>What this allows</h4>
          <p>{scopes.length} selected items</p>
        </div>
        <Badge tone={scopes.length > 0 ? "success" : "warning"}>{scopes.length > 0 ? "limited share" : "no access"}</Badge>
      </div>
      <div className="disclosure-package">
        <div className="disclosure-row">
          <strong>Can do</strong>
          <span>{plainCapabilitySummary(abilities) || "No access selected"}</span>
        </div>
        <div className="disclosure-row">
          <strong>Items</strong>
          <span>{getDisclosureScopeLabels(scopes) || "No items selected"}</span>
        </div>
        <div className="disclosure-row">
          <strong>Not allowed</strong>
          <span>{plainNonGrantedCapabilities(abilities).join(", ")}</span>
        </div>
      </div>
    </div>
  );
}

function ContactsScreen({
  contactRequests,
  profile,
  recipients,
  setContactRequests,
  setRecipients
}: {
  contactRequests: ShelterContactRequest[];
  profile: RegistrationProfileDraft;
  recipients: DisclosureRecipientDraft[];
  setContactRequests: (requests: ShelterContactRequest[]) => void;
  setRecipients: (recipients: DisclosureRecipientDraft[]) => void;
}) {
  const [draft, setDraft] = useState({
    displayName: "",
    relationship: "",
    email: "",
    phone: "",
    type: "emergency_contact" as DisclosureRecipientType
  });
  const [draftScopes, setDraftScopes] = useState<DisclosureDataScope[]>([...defaultDisclosureScopes]);
  const [editingRecipientId, setEditingRecipientId] = useState<string | null>(null);
  const [editingScopes, setEditingScopes] = useState<DisclosureDataScope[]>([]);
  const [requestedShelter, setRequestedShelter] = useState(shelterOptions[0]);

  const userName = profile.preferredName || profile.legalName || "Abby Example";
  const userContact = profile.email || profile.phone || "abby@example.org";
  const userContactKey = userContact.trim().toLowerCase();
  const requestBelongsToCurrentUser = (request: ShelterContactRequest) =>
    request.userName.trim().toLowerCase() === userName.trim().toLowerCase() ||
    request.userContact.trim().toLowerCase() === userContactKey;
  const userShelterRequests = contactRequests.filter(requestBelongsToCurrentUser);
  const incomingShelterNudges = contactRequests.filter(
    (request) =>
      request.direction === "shelter_to_user" && request.status === "pending" && requestBelongsToCurrentUser(request)
  );
  const hasPendingRequestedShelter = contactRequests.some(
    (request) =>
      request.status === "pending" &&
      request.shelterName === requestedShelter &&
      requestBelongsToCurrentUser(request)
  );
  const editingRecipient = recipients.find((recipient) => recipient.id === editingRecipientId);

  function addShelterRecipient(shelterName: string) {
    if (recipients.some((recipient) => recipient.type === "shelter_staff" && recipient.agencyName === shelterName)) {
      return;
    }

    setRecipients([
      ...recipients,
      {
        id: `rec-${Date.now()}`,
        type: "shelter_staff",
        displayName: shelterName,
        relationship: "Shelter",
        email: "",
        phone: "",
        agencyName: shelterName,
        precinctName: "",
        verified: true,
        allowedScopes: ["identity_minimum"]
      }
    ]);
  }

  function addRecipient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.displayName) return;
    setRecipients([
      ...recipients,
      {
        id: `rec-${Date.now()}`,
        ...draft,
        agencyName: "",
        precinctName: "",
        verified: false,
        allowedScopes: [...draftScopes]
      }
    ]);
    setDraft({ displayName: "", relationship: "", email: "", phone: "", type: "emergency_contact" });
    setDraftScopes([...defaultDisclosureScopes]);
  }

  function openRecipientEditor(recipient: DisclosureRecipientDraft) {
    setEditingRecipientId(recipient.id);
    setEditingScopes([...recipient.allowedScopes]);
    window.setTimeout(() => document.getElementById(`recipient-edit-${recipient.id}`)?.focus(), 0);
  }

  function closeRecipientEditor(recipientId: string) {
    setEditingRecipientId(null);
    setEditingScopes([]);
    window.setTimeout(() => document.getElementById(`recipient-open-${recipientId}`)?.focus(), 0);
  }

  function saveRecipientScopes(recipientId: string) {
    setRecipients(
      recipients.map((recipient) =>
        recipient.id === recipientId ? { ...recipient, allowedScopes: [...editingScopes] } : recipient
      )
    );
    closeRecipientEditor(recipientId);
  }

  function removeRecipient(recipientId: string) {
    setRecipients(recipients.filter((item) => item.id !== recipientId));
    if (editingRecipientId === recipientId) {
      setEditingRecipientId(null);
      setEditingScopes([]);
    }
  }

  function requestShelterContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hasPendingRequestedShelter) return;

    setContactRequests([
      ...contactRequests,
      {
        id: `shelter-request-${Date.now()}`,
        direction: "user_to_shelter",
        status: "pending",
        shelterName: requestedShelter,
        userName,
        userContact,
        createdAt: new Date().toISOString()
      }
    ]);
  }

  function decideShelterNudge(requestId: string, status: "approved" | "denied") {
    const request = contactRequests.find((item) => item.id === requestId);
    if (!request) return;

    if (status === "approved") {
      addShelterRecipient(request.shelterName);
    }

    setContactRequests(
      contactRequests.map((item) =>
        item.id === requestId ? { ...item, status, decidedAt: new Date().toISOString() } : item
      )
    );
  }

  function cancelShelterRequest(requestId: string) {
    setContactRequests(
      contactRequests.map((item) =>
        item.id === requestId && item.direction === "user_to_shelter" && item.status === "pending"
          ? { ...item, status: "canceled", decidedAt: new Date().toISOString() }
          : item
      )
    );
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Emergency contacts</p>
        <h1>People who can help</h1>
      </div>
      <p className="page-note">
        Sharing choices live with each saved contact. Open a contact below to change what they can see.
      </p>
      <Section title="Add shelter or group">
        <p className="section-note">
          A shelter is added only after the other side says yes. It starts with Minimum identity only.
        </p>
        <form className="form-grid" onSubmit={requestShelterContact}>
          <Field label="Shelter">
            <select value={requestedShelter} onChange={(event) => setRequestedShelter(event.target.value)}>
              {shelterOptions.map((shelter) => (
                <option key={shelter} value={shelter}>
                  {shelter}
                </option>
              ))}
            </select>
          </Field>
          <div className="full-span centered-action">
            <Button disabled={hasPendingRequestedShelter} type="submit" variant="secondary">
              <MessageSquare aria-hidden="true" size={18} /> Ask to add shelter
            </Button>
          </div>
          {hasPendingRequestedShelter ? (
            <small className="full-span pin-request-note">
              A request is already waiting for this shelter and person.
            </small>
          ) : null}
        </form>
        <div className="list-stack">
          {incomingShelterNudges.map((request) => (
            <article className="list-item access-request-item" key={request.id}>
              <div>
                <h3>{request.shelterName}</h3>
                <p>{request.staffName || "Shelter staff"} asked to be added to your contacts.</p>
                <Badge>{request.status}</Badge>
              </div>
              <div className="row-actions">
                <Button onClick={() => decideShelterNudge(request.id, "approved")} variant="secondary">
                  Approve
                </Button>
                <Button onClick={() => decideShelterNudge(request.id, "denied")} variant="danger">
                  Deny
                </Button>
              </div>
            </article>
          ))}
          {userShelterRequests.map((request) => (
            <article className="list-item" key={`status-${request.id}`}>
              <div>
                <h3>{request.shelterName}</h3>
                <p>{request.direction === "user_to_shelter" ? "You asked this shelter." : "Shelter asked you."}</p>
              </div>
              <div className="row-actions">
                <Badge tone={request.status === "approved" ? "success" : request.status === "denied" ? "warning" : "neutral"}>
                  {request.status}
                </Badge>
                {request.direction === "user_to_shelter" && request.status === "pending" ? (
                  <Button onClick={() => cancelShelterRequest(request.id)} variant="secondary">
                    Cancel
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </Section>
      <Section title="Add person">
        <form className="form-grid" onSubmit={addRecipient}>
          <Field label="Name or group" required>
            <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
          </Field>
          <Field label="Relationship or role">
            <input value={draft.relationship} onChange={(event) => setDraft({ ...draft, relationship: event.target.value })} />
          </Field>
          <Field label="Phone">
            <input value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} />
          </Field>
          <Field label="Email">
            <input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
          </Field>
          <Field label="Type">
            <select
              value={draft.type}
              onChange={(event) => setDraft({ ...draft, type: event.target.value as DisclosureRecipientType })}
            >
              <option value="emergency_contact">Emergency contact</option>
              <option value="social_worker">Social worker</option>
              <option value="police_precinct">Police precinct</option>
              <option value="shelter_staff">Shelter staff</option>
              <option value="government_liaison">Government help</option>
              <option value="benefits_agency">Benefits agency</option>
            </select>
          </Field>
          <SharingScopeChecklist
            help="These start on. Turn off anything this person should not see."
            label="Sharing choices for this person"
            onToggle={(scope) => setDraftScopes(toggleScopeSelection(draftScopes, scope))}
            scopes={draftScopes}
          />
          <div className="full-span centered-action">
            <Button type="submit">
              <UsersRound aria-hidden="true" size={18} /> Add person
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Saved contacts">
        {recipients.length === 0 ? (
          <p className="empty-state">No saved contacts yet. Add a shelter, group, or person above.</p>
        ) : (
          <div className="list-stack">
            {recipients.map((recipient) => {
              const isEditing = editingRecipient?.id === recipient.id;

              return (
                <article className="list-item recipient-list-item" key={recipient.id}>
                  <div className="recipient-row">
                    <button
                      aria-controls={`recipient-edit-${recipient.id}`}
                      aria-expanded={isEditing}
                      aria-label={`Edit sharing for ${recipient.displayName}`}
                      className="recipient-open-button"
                      id={`recipient-open-${recipient.id}`}
                      onClick={() => openRecipientEditor(recipient)}
                      type="button"
                    >
                      <span className="recipient-summary">
                        <span className="recipient-name">{recipient.displayName}</span>
                        <span className="recipient-details">
                          <span>{recipient.relationship || recipient.agencyName || formatRecipientType(recipient.type)}</span>
                          {recipient.email ? <span>{recipient.email}</span> : null}
                          {recipient.phone ? <span>{recipient.phone}</span> : null}
                        </span>
                        <span className="badge-row" aria-label={`${recipient.displayName} status`}>
                          <Badge tone={recipient.verified ? "success" : "warning"}>
                            {recipient.verified ? "Verified" : "Needs a check"}
                          </Badge>
                          <Badge>{recipient.allowedScopes.length} items</Badge>
                        </span>
                      </span>
                    </button>
                    <div className="row-actions">
                      <Button
                        ariaControls={`recipient-edit-${recipient.id}`}
                        ariaExpanded={isEditing}
                        className="compact-list-action"
                        onClick={() => openRecipientEditor(recipient)}
                        variant="secondary"
                      >
                        Edit sharing
                      </Button>
                      <Button
                        ariaLabel={`Remove ${recipient.displayName}`}
                        className="compact-list-action"
                        onClick={() => removeRecipient(recipient.id)}
                        variant="quiet"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  {isEditing ? (
                    <div
                      aria-labelledby={`recipient-edit-heading-${recipient.id}`}
                      className="recipient-edit-panel"
                      id={`recipient-edit-${recipient.id}`}
                      role="region"
                      tabIndex={-1}
                    >
                      <div className="scope-header">
                        <div>
                          <h3 id={`recipient-edit-heading-${recipient.id}`}>Edit sharing for {recipient.displayName}</h3>
                          <p>Save only what this contact should see.</p>
                        </div>
                        <Badge>{editingScopes.length} selected</Badge>
                      </div>
                      <SharingScopeChecklist
                        label={`Sharing choices for ${recipient.displayName}`}
                        onToggle={(scope) => setEditingScopes(toggleScopeSelection(editingScopes, scope))}
                        scopes={editingScopes}
                      />
                      <SharingCapabilityPreview recipientName={recipient.displayName} scopes={editingScopes} />
                      <div className="row-actions">
                        <Button onClick={() => saveRecipientScopes(recipient.id)}>Save sharing</Button>
                        <Button onClick={() => closeRecipientEditor(recipient.id)} variant="secondary">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

function UploadsScreen({
  apiConfig,
  onVerifyWorldId,
  proofs,
  refreshWalletAuditEvents,
  uploads,
  setUploads,
  worldIdState
}: {
  apiConfig?: WalletApiConfig;
  onVerifyWorldId: () => void;
  proofs: ProofReceiptView[];
  refreshWalletAuditEvents: () => Promise<void>;
  uploads: UploadItem[];
  setUploads: (uploads: UploadItem[]) => void;
  worldIdState: WorldIdSurfaceState;
}) {
  const [repairingUploadIds, setRepairingUploadIds] = useState<string[]>([]);
  const [walrusUploadIds, setWalrusUploadIds] = useState<string[]>([]);
  const walrusStorageConfig = getWalrusStorageConfig();
  const walrusStorageReady = Boolean(walrusStorageConfig);

  async function addUpload(file: File | null) {
    if (!file) return;
    const machineSummary = await generateUploadSummary(file);
    if (apiConfig?.actorDid) {
      try {
        const uploaded = await addBinaryDocument(apiConfig, { file, title: machineSummary });
        setUploads([uploaded, ...uploads]);
        await refreshWalletAuditEvents();
        return;
      } catch {
        try {
          const uploaded = await addTextDocument(apiConfig, {
            filename: file.name,
            text: await file.text(),
            title: machineSummary
          });
          setUploads([uploaded, ...uploads]);
          await refreshWalletAuditEvents();
          return;
        } catch {
          // Keep local document capture available if the configured API is unavailable.
        }
      }
    }
    setUploads([
      ...uploads,
      {
        id: `up-${Date.now()}`,
        fileName: file.name,
        machineSummary,
        category: "Uncategorized",
        sensitivity: "high",
        status: "stored",
        shared: false
      }
    ]);
  }

  async function repairUploadStorage(upload: UploadItem) {
    if (!apiConfig?.actorDid || !upload.recordId) return;
    setRepairingUploadIds((uploadIds) => [...uploadIds, upload.id]);
    try {
      const storageOk = await repairRecordStorage(apiConfig, upload.recordId);
      setUploads(
        uploads.map((item) =>
          item.id === upload.id
            ? {
                ...item,
                status: storageOk ? "stored" : item.status,
                storageOk
              }
            : item
        )
      );
      await refreshWalletAuditEvents();
    } catch {
      setUploads(uploads.map((item) => (item.id === upload.id ? { ...item, storageOk: false } : item)));
    } finally {
      setRepairingUploadIds((uploadIds) => uploadIds.filter((id) => id !== upload.id));
    }
  }

  async function storeWalletRecordOnWalrus(upload: UploadItem) {
    if (!walrusStorageConfig || !upload.recordId) return;
    setWalrusUploadIds((uploadIds) => [...uploadIds, upload.id]);
    updateUpload(upload.id, {
      decentralizedStorageMessage: "Sending wallet record to Walrus.",
      decentralizedStorageStatus: "uploading"
    });
    try {
      const result = await uploadWalletRecordToWalrusStorage(upload, {
        clientConfig: walrusStorageConfig,
        walletConfig: apiConfig
      });
      const patch = toWalrusStoragePatch(result, walrusStorageConfig);
      updateUpload(upload.id, patch);
    } catch (error) {
      updateUpload(upload.id, {
        decentralizedStorageMessage: error instanceof Error ? error.message : "Walrus upload failed.",
        decentralizedStorageStatus: "failed"
      });
    } finally {
      setWalrusUploadIds((uploadIds) => uploadIds.filter((id) => id !== upload.id));
    }
  }

  function updateUpload(uploadId: string, patch: Partial<UploadItem>) {
    setUploads(uploads.map((item) => (item.id === uploadId ? { ...item, ...patch } : item)));
  }

  function allowSharing(upload: UploadItem) {
    updateUpload(upload.id, {
      shared: true,
      sharingMode: "public"
    });
  }

  function makePrivate(upload: UploadItem) {
    updateUpload(upload.id, {
      allowedRecipientIds: [],
      shared: false,
      sharingMode: "private"
    });
  }

  function toggleSharingRecipient(upload: UploadItem, recipientId: string) {
    const currentRecipients = upload.allowedRecipientIds ?? [];
    const allowedRecipientIds = currentRecipients.includes(recipientId)
      ? currentRecipients.filter((id) => id !== recipientId)
      : [...currentRecipients, recipientId];
    updateUpload(upload.id, {
      allowedRecipientIds,
      shared: allowedRecipientIds.length > 0,
      sharingMode: allowedRecipientIds.length > 0 ? "selected_contacts" : "private"
    });
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Uploads</p>
        <h1>Saved files and info</h1>
      </div>
      <WorldIdSurfaceSummary
        description="Saved files can carry an optional World ID proof-of-human receipt beside other wallet proof receipts. Uploads do not require World ID."
        onVerify={onVerifyWorldId}
        state={worldIdState}
        surfaceLabel="Uploads"
      />
      <Section title="Add information">
        <label className="upload-dropzone">
          <Upload aria-hidden="true" size={28} />
          <span>Choose a file or photo</span>
          <small>Files stay private until you choose to share them.</small>
          <span className="upload-picker">
            <FileUp aria-hidden="true" size={18} /> Select file
          </span>
          <input
            type="file"
            onChange={(event) => addUpload(event.target.files?.[0] ?? null)}
            aria-label="Choose file to upload"
          />
        </label>
      </Section>
      <div className="list-stack">
        {uploads.map((upload) => (
          <article className="list-item upload-list-item" key={upload.id}>
            <div>
              <h3>{upload.fileName}</h3>
              <p>{upload.category}</p>
              <small className="upload-machine-summary">{toShortSummaryTitle(upload.machineSummary)}</small>
              <div className="badge-row">
                <Badge tone="success">{upload.status}</Badge>
                {upload.storageOk !== undefined ? (
                  <Badge tone={upload.storageOk ? "success" : "warning"}>
                    {upload.storageOk ? "saved" : "save needs fix"}
                  </Badge>
                ) : null}
                <Badge>{upload.shared ? "Shared" : "Private"}</Badge>
              </div>
              <ConsensusMetadataPanel
                directLabel="Direct upload profile"
                metadata={getConsensusMetadataFromView(upload)}
                surfaceLabel="Wallet uploads profiling"
              />
            </div>
            <div className="row-actions list-item-action">
              {upload.storageOk === false && upload.recordId && apiConfig?.actorDid ? (
                <Button
                  disabled={repairingUploadIds.includes(upload.id)}
                  onClick={() => repairUploadStorage(upload)}
                  variant="secondary"
                >
                  <Wrench aria-hidden="true" size={18} />
                  {repairingUploadIds.includes(upload.id) ? "Fixing" : "Fix save"}
                </Button>
              ) : null}
              {walrusStorageReady && upload.recordId && !upload.walrusBlobId ? (
                <Button
                  disabled={walrusUploadIds.includes(upload.id)}
                  onClick={() => void storeWalletRecordOnWalrus(upload)}
                  variant="secondary"
                >
                  <Upload aria-hidden="true" size={18} />
                  {walrusUploadIds.includes(upload.id) ? "Storing" : "Store on Walrus"}
                </Button>
              ) : null}
              <Button
                onClick={() =>
                  setUploads(uploads.map((item) => (item.id === upload.id ? { ...item, shared: !item.shared } : item)))
                }
                variant="secondary"
              >
                {upload.shared ? "Make private" : "Allow sharing"}
              </Button>
            </div>
          </article>
        ))}
      </div>
      <ProofSurfaceSummary
        emptyMessage="No wallet proof receipts are linked to uploaded records yet."
        proofs={proofs}
        surface="uploads"
        title="Wallet proof receipts"
      />
    </div>
  );
}

function SocialServicesScreen({ proofs }: { proofs: ProofReceiptView[] }) {
  const categories = ["Shelter", "Food", "Health", "Legal", "Benefits", "Transportation", "Employment", "Crisis"];
  const suggestedPrompts = ["food pantry near Portland", "emergency shelter", "utility bill help"];
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "complete" | "error">("idle");
  const [searchError, setSearchError] = useState("");

  async function runSearch(nextQuery = query) {
    const trimmedQuery = nextQuery.trim();
    if (!trimmedQuery) return;

    setQuery(trimmedQuery);
    setSearchStatus("loading");
    setSearchError("");
    try {
      const searchResults = await search211Info(trimmedQuery, 18);
      const serviceResults = searchResults.filter((result) => result.document.doc_type === "service");
      setResults((serviceResults.length ? serviceResults : searchResults).slice(0, 8));
      setSearchStatus("complete");
    } catch (error) {
      setResults([]);
      setSearchStatus("error");
      setSearchError(error instanceof Error ? error.message : "Search failed");
    }
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch();
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Social services</p>
        <h1>Find support</h1>
      </div>
      <Section title="Search 211 services">
        <form className="form-grid" onSubmit={handleSearchSubmit}>
          <Field label="Search by need, provider, or place">
            <input
              placeholder="food pantry near Beaverton"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <div className="row-actions">
            <Button disabled={!query.trim()} loading={searchStatus === "loading"} loadingLabel="Searching" type="submit">
              Search
            </Button>
          </div>
        </form>
        <div className="chip-grid" aria-label="Suggested searches">
          {suggestedPrompts.map((prompt) => (
            <button className="choice-chip" key={prompt} onClick={() => void runSearch(prompt)} type="button">
              {prompt}
            </button>
          ))}
        </div>
        {searchStatus === "error" ? (
          <StatusBanner tone="warning">211 service search is unavailable: {searchError}</StatusBanner>
        ) : null}
        {searchStatus === "complete" && results.length === 0 ? (
          <StatusBanner tone="info">No local 211 records matched. Try a broader need or contact 211 directly.</StatusBanner>
        ) : null}
        {results.length ? (
          <div className="list-stack" aria-label="211 service search results">
            {results.map((result) => {
              const document = result.document;
              const provider = document.provider_name || "Provider not listed";
              const program = document.program_name || document.title || "Program not listed";
              return (
                <article className="list-item" key={result.docId}>
                  <div>
                    <h3>{program}</h3>
                    <p>{provider}</p>
                    <small className="upload-machine-summary">{result.snippet}</small>
                    <div className="badge-row">
                      <Badge>{document.doc_type}</Badge>
                      {document.city || document.state ? (
                        <Badge>
                          {[document.city, document.state].filter(Boolean).join(", ")}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="row-actions list-item-action">
                    {document.source_url ? <Badge tone="success">source</Badge> : null}
                    <Button onClick={() => setLocationServiceDetailHash(result.docId)} variant="secondary">
                      Open detail
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
      </Section>
      <div className="category-grid">
        {categories.map((category) => (
          <button className="category-tile" key={category} onClick={() => void runSearch(category)} type="button">
            <HeartHandshake aria-hidden="true" size={22} />
            <span>{category}</span>
          </button>
        ))}
      </div>
      <Section title="Government help">
        <div className="liaison-panel">
          <MessageSquare aria-hidden="true" size={28} />
          <div>
            <h3>Get help with benefits, ID, housing, or forms.</h3>
            <p>Only the details you choose to share will be included in the request.</p>
          </div>
          <Button>Start request</Button>
        </div>
      </Section>
      <ProofSurfaceSummary
        emptyMessage="No provider-reviewable proof receipts are ready yet."
        proofs={proofs}
        surface="provider"
        title="Provider proof review"
      />
      <Section title="Provider eligibility claims">
        <ConsensusSurfaceStats proofs={proofs} />
      </Section>
      <Section title="Matched services">
        <div className="list-stack">
          {serviceMatches.map((service) => (
            <article className="list-item" key={service.id}>
              <div>
                <h3>{service.name}</h3>
                <p>
                  {service.category} · {service.distance}
                </p>
              </div>
              <Badge tone="success">{service.availability}</Badge>
            </article>
          ))}
        </div>
      </Section>
    </div>
  );
}

function ShelterScreen({
  checklist,
  setChecklist,
  contactRequests,
  recipients,
  setContactRequests,
  setRecipients,
  shelterStaffAccounts,
  setShelterStaffAccounts,
  shelterUserAccounts,
  setShelterUserAccounts,
  worldIdState
}: {
  checklist: typeof defaultShelterChecklist;
  setChecklist: (value: typeof defaultShelterChecklist) => void;
  contactRequests: ShelterContactRequest[];
  recipients: DisclosureRecipientDraft[];
  setContactRequests: (requests: ShelterContactRequest[]) => void;
  setRecipients: (recipients: DisclosureRecipientDraft[]) => void;
  shelterStaffAccounts: ShelterStaffAccount[];
  setShelterStaffAccounts: (accounts: ShelterStaffAccount[]) => void;
  shelterUserAccounts: ShelterUserAccount[];
  setShelterUserAccounts: (accounts: ShelterUserAccount[]) => void;
  worldIdState: WorldIdSurfaceState;
}) {
  const [isShelterAdmin, setIsShelterAdmin] = useState(false);
  const [adminShelter, setAdminShelter] = useState(shelterOptions[0]);
  const [operatorShelter, setOperatorShelter] = useState(shelterOptions[0]);
  const [operatorStaffId, setOperatorStaffId] = useState("");
  const [userDraft, setUserDraft] = useState(defaultManagedUserDraft);
  const [staffDraft, setStaffDraft] = useState({ displayName: "", email: "" });
  const [nudgeDraft, setNudgeDraft] = useState({ userName: "Abby Example", userContact: "abby@example.org" });
  const [managedUserFileDetail, setManagedUserFileDetail] = useState("");
  const [managedUserUploadError, setManagedUserUploadError] = useState("");
  const [providerStaffWorldIdProofs, setProviderStaffWorldIdProofs] = useState<Record<string, boolean>>({});

  const staffForShelter = shelterStaffAccounts.filter((account) => account.shelter === adminShelter);
  const verifiedStaffForOperatorShelter = shelterStaffAccounts.filter(
    (account) => account.shelter === operatorShelter && account.verified
  );
  const selectedOperator = shelterStaffAccounts.find((account) => account.id === operatorStaffId && account.verified);
  const usersForOperatorShelter = shelterUserAccounts.filter((account) => account.shelter === operatorShelter);
  const requestsForOperatorShelter = contactRequests.filter((request) => request.shelterName === operatorShelter);
  const oversightShelter = isShelterAdmin ? adminShelter : operatorShelter;

  function accountSortByHousingThenDate(a: ShelterUserAccount, b: ShelterUserAccount) {
    if (a.foundPermanentHousing !== b.foundPermanentHousing) {
      return a.foundPermanentHousing ? 1 : -1;
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  }

  const staffRegisteredUsersForShelter = shelterUserAccounts
    .filter((account) => account.shelter === oversightShelter)
    .sort(accountSortByHousingThenDate);

  const preferredShelterMentionUsers = shelterUserAccounts
    .filter(
      (account) =>
        account.shelter !== oversightShelter &&
        account.preferredShelter.toLowerCase().includes(oversightShelter.toLowerCase())
    )
    .sort(accountSortByHousingThenDate);

  function toggleManagedUserNeed(need: string) {
    setUserDraft((prev) => ({
      ...prev,
      serviceNeeds: prev.serviceNeeds.includes(need)
        ? prev.serviceNeeds.filter((item) => item !== need)
        : [...prev.serviceNeeds, need]
    }));
  }

  function handleManagedUserUploadChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      setUserDraft({ ...userDraft, photoAssetId: "" });
      setManagedUserFileDetail("");
      setManagedUserUploadError("");
      return;
    }

    if (!isAcceptedIdentityDocument(file)) {
      setUserDraft({ ...userDraft, photoAssetId: "" });
      setManagedUserFileDetail("");
      setManagedUserUploadError("We can't use this file. Use JPG, PNG, WebP, or PDF.");
      return;
    }

    setUserDraft({ ...userDraft, photoAssetId: file.name });
    setManagedUserFileDetail(getIdentityDocumentFileDetail(file));
    setManagedUserUploadError("");
  }

  function createManagedUserAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const hasRequiredIdentity = userDraft.legalName.trim() && userDraft.photoAssetId;
    if (!selectedOperator || !hasRequiredIdentity || !isIntakeVerified(userDraft, worldIdState)) return;

    const newUser: ShelterUserAccount = {
      id: `user-${Date.now()}`,
      shelter: operatorShelter,
      legalName: userDraft.legalName.trim(),
      preferredName: userDraft.preferredName.trim(),
      pronouns: userDraft.pronouns.trim(),
      dateOfBirth: userDraft.dateOfBirth,
      photoAssetId: userDraft.photoAssetId,
      phone: userDraft.phone.trim(),
      email: userDraft.email.trim(),
      currentLocation: userDraft.currentLocation.trim(),
      preferredShelter: userDraft.preferredShelter.trim(),
      serviceNeeds: userDraft.serviceNeeds,
      easyBotCheckStatus: userDraft.easyBotCheckStatus,
      captchaToken: userDraft.captchaToken,
      localPrecinctNotified: userDraft.localPrecinctNotified,
      foundPermanentHousing: userDraft.foundPermanentHousing,
      createdByStaffId: selectedOperator.id,
      createdAt: new Date().toISOString()
    };
    setShelterUserAccounts([...shelterUserAccounts, newUser]);
    setUserDraft(defaultManagedUserDraft);
    setManagedUserFileDetail("");
    setManagedUserUploadError("");
  }

  function createStaffAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOperator || !staffDraft.displayName.trim()) return;

    const newStaff: ShelterStaffAccount = {
      id: `staff-${Date.now()}`,
      shelter: operatorShelter,
      displayName: staffDraft.displayName.trim(),
      email: staffDraft.email.trim(),
      verified: false,
      updatedAt: new Date().toISOString()
    };
    setShelterStaffAccounts([...shelterStaffAccounts, newStaff]);
    setStaffDraft({ displayName: "", email: "" });
  }

  function verifyStaffWithProviderWorldId(account: ShelterStaffAccount) {
    if (!isShelterAdmin || account.shelter !== adminShelter) return;
    setShelterStaffAccounts(
      shelterStaffAccounts.map((item) =>
        item.id === account.id ? { ...item, verified: true, updatedAt: new Date().toISOString() } : item
      )
    );
    setProviderStaffWorldIdProofs({ ...providerStaffWorldIdProofs, [account.id]: true });
  }

  function revokeStaffWorldIdVerification(account: ShelterStaffAccount) {
    const { [account.id]: _removed, ...remainingProofs } = providerStaffWorldIdProofs;
    setProviderStaffWorldIdProofs(remainingProofs);
    setShelterStaffAccounts(
      shelterStaffAccounts.map((item) =>
        item.id === account.id ? { ...item, verified: false, updatedAt: new Date().toISOString() } : item
      )
    );
  }

  function shelterRecipientExists(shelterName: string) {
    return recipients.some((recipient) => recipient.type === "shelter_staff" && recipient.agencyName === shelterName);
  }

  function addShelterRecipient(shelterName: string) {
    if (shelterRecipientExists(shelterName)) return;

    setRecipients([
      ...recipients,
      {
        id: `rec-${Date.now()}`,
        type: "shelter_staff",
        displayName: shelterName,
        relationship: "Shelter",
        email: "",
        phone: "",
        agencyName: shelterName,
        precinctName: "",
        verified: true,
        allowedScopes: ["identity_minimum"]
      }
    ]);
  }

  function hasPendingShelterNudge() {
    const nudgeContactKey = nudgeDraft.userContact.trim().toLowerCase();
    const nudgeNameKey = nudgeDraft.userName.trim().toLowerCase();
    return contactRequests.some(
      (request) =>
        request.status === "pending" &&
        request.shelterName === operatorShelter &&
        (request.userContact.trim().toLowerCase() === nudgeContactKey ||
          request.userName.trim().toLowerCase() === nudgeNameKey)
    );
  }

  function sendShelterNudge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOperator || !nudgeDraft.userName.trim() || !nudgeDraft.userContact.trim() || hasPendingShelterNudge()) {
      return;
    }

    setContactRequests([
      ...contactRequests,
      {
        id: `shelter-request-${Date.now()}`,
        direction: "shelter_to_user",
        status: "pending",
        shelterName: operatorShelter,
        userName: nudgeDraft.userName.trim(),
        userContact: nudgeDraft.userContact.trim(),
        staffId: selectedOperator.id,
        staffName: selectedOperator.displayName,
        createdAt: new Date().toISOString()
      }
    ]);
  }

  function decideUserShelterRequest(requestId: string, status: "approved" | "denied") {
    const request = contactRequests.find((item) => item.id === requestId);
    if (!request) return;

    if (status === "approved") {
      addShelterRecipient(request.shelterName);
    }

    setContactRequests(
      contactRequests.map((item) =>
        item.id === requestId ? { ...item, status, decidedAt: new Date().toISOString() } : item
      )
    );
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Shelter portal</p>
        <h1>Assisted access</h1>
      </div>
      <p className="page-note">Shelter workflows are free and keep user sharing choices separate from staff access.</p>
      <Section title="Staff tools">
        <div className="tool-grid">
          <button className="tool-tile" type="button">
            <ClipboardCheck size={24} /> Assist registration
          </button>
          <button className="tool-tile" type="button">
            <UsersRound size={24} /> Verify contact
          </button>
          <button className="tool-tile" type="button">
            <ShieldCheck size={24} /> Review staff audit
          </button>
        </div>
      </Section>
      <Section title="Verified staff workspace">
        <div className="shelter-staff-panel">
          <Field label="Shelter" required>
            <select
              value={operatorShelter}
              onChange={(event) => {
                setOperatorShelter(event.target.value);
                setOperatorStaffId("");
              }}
            >
              {shelterOptions.map((shelter) => (
                <option key={shelter} value={shelter}>
                  {shelter}
                </option>
              ))}
            </select>
          </Field>
          <Field help="Only verified staff can create accounts." label="Verified staff operator" required>
            <select value={operatorStaffId} onChange={(event) => setOperatorStaffId(event.target.value)}>
              <option value="">Select verified staff</option>
              {verifiedStaffForOperatorShelter.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.displayName}
                </option>
              ))}
            </select>
          </Field>
          {!selectedOperator ? (
            <small className="pin-request-note">Select a verified staff operator to create client or staff accounts.</small>
          ) : (
            <>
              <Section title="Create user account">
                <form className="form-grid" onSubmit={createManagedUserAccount}>
                  <Field label="Legal or full name" required>
                    <input
                      value={userDraft.legalName}
                      onChange={(event) => setUserDraft({ ...userDraft, legalName: event.target.value })}
                    />
                  </Field>
                  <Field label="Preferred name">
                    <input
                      value={userDraft.preferredName}
                      onChange={(event) => setUserDraft({ ...userDraft, preferredName: event.target.value })}
                    />
                  </Field>
                  <Field label="Pronouns">
                    <input
                      placeholder="call me she/her, he/him, they/them"
                      value={userDraft.pronouns}
                      onChange={(event) => setUserDraft({ ...userDraft, pronouns: event.target.value })}
                    />
                  </Field>
                  <Field label="Birth date">
                    <input
                      type="date"
                      value={userDraft.dateOfBirth}
                      onChange={(event) => setUserDraft({ ...userDraft, dateOfBirth: event.target.value })}
                    />
                  </Field>
                  <Field
                    error={managedUserUploadError}
                    help="Use a JPG, PNG, WebP, or PDF file. We will not show a preview."
                    label="Photo or photo ID"
                    required
                  >
                    <input
                      accept={ID_DOCUMENT_ACCEPT_ATTR}
                      type="file"
                      onChange={handleManagedUserUploadChange}
                    />
                    {managedUserFileDetail ? (
                      <small className="registration-file-detail" aria-live="polite">
                        Selected file: {managedUserFileDetail}
                      </small>
                    ) : null}
                  </Field>
                  <Field help="Used for text reminders." label="Phone">
                    <input
                      value={userDraft.phone}
                      onChange={(event) => setUserDraft({ ...userDraft, phone: event.target.value })}
                    />
                  </Field>
                  <Field help="Used for email reminders." label="Email">
                    <input
                      type="email"
                      value={userDraft.email}
                      onChange={(event) => setUserDraft({ ...userDraft, email: event.target.value })}
                    />
                  </Field>
                  <Field label="Current safe location">
                    <input
                      value={userDraft.currentLocation}
                      onChange={(event) => setUserDraft({ ...userDraft, currentLocation: event.target.value })}
                    />
                  </Field>
                  <Field label="Preferred shelter">
                    <input
                      value={userDraft.preferredShelter}
                      onChange={(event) => setUserDraft({ ...userDraft, preferredShelter: event.target.value })}
                    />
                  </Field>
                  <label className="captcha-box full-span">
                    <input
                      checked={userDraft.easyBotCheckStatus === "passed"}
                      onChange={(event) =>
                        setUserDraft({
                          ...userDraft,
                          easyBotCheckStatus: event.target.checked ? "passed" : "failed",
                          captchaToken: ""
                        })
                      }
                      type="checkbox"
                    />
                    <span>Quick health check complete (step 1)</span>
                  </label>
                  <label className="captcha-box full-span">
                    <input checked={worldIdState.verified} disabled type="checkbox" />
                    <span>
                      <strong>World ID proof-of-human verified for assisted intake</strong>
                      <small>
                        Uses the wallet-bound World ID receipt instead of the demo bot check when available.
                      </small>
                    </span>
                  </label>
                  <label className="captcha-box full-span">
                    <input
                      checked={hasManualIntakeFallback(userDraft)}
                      disabled={worldIdState.verified}
                      onChange={(event) =>
                        setUserDraft({
                          ...userDraft,
                          easyBotCheckStatus: event.target.checked ? "failed" : "pending",
                          captchaToken: event.target.checked ? MANUAL_INTAKE_FALLBACK_TOKEN : ""
                        })
                      }
                      type="checkbox"
                    />
                    <span>
                      <strong>Use manual intake fallback</strong>
                      <small>Available for accessibility, device availability, or emergency service access.</small>
                    </span>
                  </label>
                  <div className="full-span">
                    <span className="field-label">Service needs</span>
                    <div className="chip-grid">
                      {serviceNeeds.map((need) => (
                        <button
                          aria-pressed={userDraft.serviceNeeds.includes(need)}
                          className="choice-chip"
                          key={need}
                          onClick={() => toggleManagedUserNeed(need)}
                          type="button"
                        >
                          {need}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="captcha-box full-span">
                    <input
                      checked={hasDemoBotCheck(userDraft)}
                      disabled={
                        worldIdState.verified ||
                        hasManualIntakeFallback(userDraft) ||
                        userDraft.easyBotCheckStatus !== "passed"
                      }
                      onChange={(event) =>
                        setUserDraft({ ...userDraft, captchaToken: event.target.checked ? DEMO_BOT_CHECK_TOKEN : "" })
                      }
                      type="checkbox"
                    />
                    <span>
                      <strong>Bot check complete (legacy demo fallback)</strong>
                      <small>Use only when World ID is not available in the local demo.</small>
                    </span>
                  </label>
                  <div className="full-span" aria-label="Assisted intake verification status">
                    <StatusBanner tone={getIntakeVerificationTone(userDraft, worldIdState)}>
                      {getIntakeVerificationMessage(userDraft, worldIdState)}
                    </StatusBanner>
                  </div>
                  <label className="consent-box full-span">
                    <input
                      checked={userDraft.localPrecinctNotified}
                      onChange={(event) => setUserDraft({ ...userDraft, localPrecinctNotified: event.target.checked })}
                      type="checkbox"
                    />
                    <span>
                      <strong>Local precinct notified as emergency contact</strong>
                    </span>
                  </label>
                  <label className="consent-box full-span">
                    <input
                      checked={userDraft.foundPermanentHousing}
                      onChange={(event) => setUserDraft({ ...userDraft, foundPermanentHousing: event.target.checked })}
                      type="checkbox"
                    />
                    <span>
                      <strong>Found permanent housing</strong>
                    </span>
                  </label>
                  <div className="full-span">
                    <Button
                      disabled={
                        !userDraft.legalName.trim() ||
                        !userDraft.photoAssetId ||
                        !isIntakeVerified(userDraft, worldIdState)
                      }
                      type="submit"
                    >
                      Create user account
                    </Button>
                  </div>
                </form>
              </Section>

              <Section title="Create staff account">
                <form className="form-grid" onSubmit={createStaffAccount}>
                  <Field label="Staff name" required>
                    <input
                      value={staffDraft.displayName}
                      onChange={(event) => setStaffDraft({ ...staffDraft, displayName: event.target.value })}
                    />
                  </Field>
                  <Field label="Staff email">
                    <input
                      type="email"
                      value={staffDraft.email}
                      onChange={(event) => setStaffDraft({ ...staffDraft, email: event.target.value })}
                    />
                  </Field>
                  <div className="full-span">
                    <Button type="submit">Create staff account</Button>
                  </div>
                </form>
              </Section>

              <Section title="Contact list requests">
                <p className="section-note">
                  Send a request only. The person must approve before this shelter is added.
                </p>
                <form className="form-grid" onSubmit={sendShelterNudge}>
                  <Field label="Person name" required>
                    <input
                      value={nudgeDraft.userName}
                      onChange={(event) => setNudgeDraft({ ...nudgeDraft, userName: event.target.value })}
                    />
                  </Field>
                  <Field label="Phone or email" required>
                    <input
                      value={nudgeDraft.userContact}
                      onChange={(event) => setNudgeDraft({ ...nudgeDraft, userContact: event.target.value })}
                    />
                  </Field>
                  <div className="full-span centered-action">
                    <Button disabled={hasPendingShelterNudge()} type="submit" variant="secondary">
                      <MessageSquare size={18} /> Send contact request
                    </Button>
                  </div>
                  {hasPendingShelterNudge() ? (
                    <small className="full-span pin-request-note">
                      A request is already waiting for this shelter and person.
                    </small>
                  ) : null}
                </form>
                <div className="list-stack">
                  {requestsForOperatorShelter.length ? (
                    requestsForOperatorShelter.map((request) => (
                      <article className="list-item access-request-item" key={`shelter-contact-${request.id}`}>
                        <div>
                          <h3>{request.userName}</h3>
                          <p>
                            {request.direction === "user_to_shelter"
                              ? `User asked to add ${request.shelterName}.`
                              : `${request.shelterName} asked this user.`}
                          </p>
                          <div className="badge-row">
                            <Badge>{request.userContact}</Badge>
                            <Badge tone={request.status === "approved" ? "success" : request.status === "denied" ? "warning" : "neutral"}>
                              {request.status}
                            </Badge>
                          </div>
                        </div>
                        {request.direction === "user_to_shelter" && request.status === "pending" ? (
                          <div className="row-actions">
                            <Button onClick={() => decideUserShelterRequest(request.id, "approved")} variant="secondary">
                              Approve
                            </Button>
                            <Button onClick={() => decideUserShelterRequest(request.id, "denied")} variant="danger">
                              Deny
                            </Button>
                          </div>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <small>No contact list requests for this shelter yet.</small>
                  )}
                </div>
              </Section>

              <div className="list-stack">
                {usersForOperatorShelter.length ? (
                  usersForOperatorShelter.map((account) => (
                    <article className="list-item" key={account.id}>
                      <div>
                        <h3>{account.preferredName || account.legalName}</h3>
                        <p>{account.legalName}</p>
                        <small>
                          Created by {shelterStaffAccounts.find((item) => item.id === account.createdByStaffId)?.displayName ?? "Staff"}
                          {account.dateOfBirth ? ` · DOB ${account.dateOfBirth}` : ""}
                        </small>
                      </div>
                      <Badge>User account</Badge>
                    </article>
                  ))
                ) : (
                  <small>No user accounts created for this shelter yet.</small>
                )}
              </div>

              <Section title="Shelter user oversight">
                <div className="list-stack">
                  {staffRegisteredUsersForShelter.length ? (
                    staffRegisteredUsersForShelter.map((account) => (
                      <article className="list-item" key={`overview-${account.id}`}>
                        <div>
                          <h3>{account.preferredName || account.legalName}</h3>
                          <p>{account.legalName}</p>
                          <div className="badge-row">
                            <Badge tone={account.localPrecinctNotified ? "success" : "warning"}>
                              {account.localPrecinctNotified ? "Precinct notified" : "Precinct not notified"}
                            </Badge>
                            <Badge tone={account.foundPermanentHousing ? "success" : "neutral"}>
                              {account.foundPermanentHousing ? "Found housing" : "Housing not found"}
                            </Badge>
                            {hasManualIntakeFallback(account) ? <Badge tone="warning">Manual fallback</Badge> : null}
                            {hasDemoBotCheck(account) ? <Badge tone="neutral">Demo bot check</Badge> : null}
                          </div>
                        </div>
                      </article>
                    ))
                  ) : (
                    <small>No shelter-registered users for this shelter yet.</small>
                  )}
                </div>
                <div className="list-stack">
                  {preferredShelterMentionUsers.length ? (
                    preferredShelterMentionUsers.map((account) => (
                      <article className="list-item" key={`preferred-${account.id}`}>
                        <div>
                          <h3>{account.preferredName || account.legalName}</h3>
                          <p>{account.legalName}</p>
                          <div className="badge-row">
                            <Badge tone={account.localPrecinctNotified ? "success" : "warning"}>
                              {account.localPrecinctNotified ? "Precinct notified" : "Precinct not notified"}
                            </Badge>
                            <Badge tone={account.foundPermanentHousing ? "success" : "neutral"}>
                              {account.foundPermanentHousing ? "Found housing" : "Housing not found"}
                            </Badge>
                            {hasManualIntakeFallback(account) ? <Badge tone="warning">Manual fallback</Badge> : null}
                            {hasDemoBotCheck(account) ? <Badge tone="neutral">Demo bot check</Badge> : null}
                          </div>
                        </div>
                      </article>
                    ))
                  ) : (
                    <small>No users listed this shelter as preferred shelter.</small>
                  )}
                </div>
              </Section>
            </>
          )}
        </div>
      </Section>
      <Section title="Shared-device safety">
        <div className="checklist">
          <label>
            <input
              checked={checklist.userPresent}
              onChange={(event) => setChecklist({ ...checklist, userPresent: event.target.checked })}
              type="checkbox"
            />{" "}
            Confirm user is present for assisted setup
          </label>
          <label>
            <input
              checked={checklist.clearBrowserData}
              onChange={(event) => setChecklist({ ...checklist, clearBrowserData: event.target.checked })}
              type="checkbox"
            />{" "}
            Clear browser data after shared-device session
          </label>
          <label>
            <input
              checked={checklist.auditLogConfirmed}
              onChange={(event) => setChecklist({ ...checklist, auditLogConfirmed: event.target.checked })}
              type="checkbox"
            />{" "}
            Staff action will be added to the audit log
          </label>
        </div>
      </Section>
      <Section title="Shelter administrator">
        <label className="consent-box">
          <input
            checked={isShelterAdmin}
            onChange={(event) => setIsShelterAdmin(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>I am shelter administrator</strong>
          </span>
        </label>
        {isShelterAdmin ? (
          <div className="shelter-staff-panel">
            <Field label="Shelter" required>
              <select value={adminShelter} onChange={(event) => setAdminShelter(event.target.value)}>
                {shelterOptions.map((shelter) => (
                  <option key={shelter} value={shelter}>
                    {shelter}
                  </option>
                ))}
              </select>
            </Field>
            <div className="list-stack">
              {staffForShelter.length ? (
                staffForShelter.map((account) => (
                  <article className="list-item" key={account.id}>
                    <div>
                      <h3>{account.displayName}</h3>
                      <p>{account.email || "No email provided"}</p>
                      <div className="badge-row">
                        <Badge tone={account.verified ? "success" : "warning"}>
                          {account.verified ? "Verified" : "Revoked"}
                        </Badge>
                        {providerStaffWorldIdProofs[account.id] ? (
                          <Badge tone="success">World ID staff proof</Badge>
                        ) : null}
                      </div>
                      <small>World ID action: {PROVIDER_STAFF_WORLD_ID_ACTION}</small>
                    </div>
                    {account.verified ? (
                      <Button
                        onClick={() => revokeStaffWorldIdVerification(account)}
                        variant="secondary"
                      >
                        Revoke verification
                      </Button>
                    ) : (
                      <Button onClick={() => verifyStaffWithProviderWorldId(account)} variant="secondary">
                        Verify with provider staff World ID
                      </Button>
                    )}
                  </article>
                ))
              ) : (
                <small>No staff accounts registered for this shelter yet.</small>
              )}
            </div>
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function AnalyticsScreen({
  optedIn,
  proofs,
  setOptedIn
}: {
  optedIn: Record<string, boolean>;
  proofs: ProofReceiptView[];
  setOptedIn: (value: Record<string, boolean>) => void;
}) {
  function toggleStudy(studyId: string) {
    setOptedIn({ ...optedIn, [studyId]: !isStudySelected(studyId) });
  }

  function isStudySelected(studyId: string) {
    return optedIn[studyId] ?? true;
  }

  const productionProofCount = proofs.filter((proof) => getProofReceiptUiState(proof).productionEvidence).length;
  const onChainWrapperCount = proofs.filter((proof) => {
    const state = getProofReceiptUiState(proof);
    return state.accepted && state.proofSystemFamily === "provekit_recursive_groth16";
  }).length;
  const failClosedCount = proofs.filter((proof) => getProofReceiptUiState(proof).failClosed).length;

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Group facts choice</p>
        <h1>Share group facts, not your name</h1>
      </div>
      <p className="page-note">
        These choices start on. You can turn off any one. We use group facts, not names or contact details.
      </p>
      <StatusBanner tone="warning">
        A privacy and legal team must review this before real use.
      </StatusBanner>
      <Section title="Public proof dashboard">
        <div className="privacy-metrics">
          <StatusPanel label="Production proof evidence" value={String(productionProofCount)} tone="teal" />
          <StatusPanel label="Recursive wrappers" value={String(onChainWrapperCount)} tone="gold" />
          <StatusPanel label="Fail-closed receipts" value={String(failClosedCount)} tone="red" />
        </div>
        <ConsensusSurfaceStats proofs={proofs} />
        <ProofSurfaceSummary
          emptyMessage="No public proof receipts are available for the dashboard yet."
          limit={6}
          proofs={proofs}
          surface="dashboard"
          title="Dashboard proof systems"
        />
      </Section>
      <div className="analytics-grid">
        {analyticsStudies.map((study) => {
          const selected = isStudySelected(study.id);
          const budgetRemaining = Math.max(0, study.epsilonBudget - study.spentBudget);
          const titleId = `analytics-title-${study.id}`;
          return (
            <article aria-labelledby={titleId} className="analytics-card" key={study.id}>
              <div className="scope-header">
                <div>
                  <h3 id={titleId}>{study.title}</h3>
                  <p>{study.purpose}</p>
                </div>
                <Badge tone={study.status === "paused" ? "warning" : selected ? "success" : "neutral"}>
                  {study.status === "paused" ? "paused" : selected ? "on" : "off"}
                </Badge>
              </div>
              <div className="privacy-metrics">
                <StatusPanel label="Group size" value={String(study.minCohortSize)} tone="teal" />
                <StatusPanel label="Privacy left" value={budgetRemaining.toFixed(2)} tone="gold" />
              </div>
              <div className="badge-row">
                {study.fields.map((field) => (
                  <Badge key={field}>{formatAnalyticsField(field)}</Badge>
                ))}
              </div>
              <div
                className="capability-preview"
                role="group"
                aria-label={`${study.title} analytics capability preview`}
              >
                <div className="scope-header">
                  <div>
                    <h4>What this allows</h4>
                    <p>{study.fields.length} safe details · group size {study.minCohortSize}</p>
                  </div>
                  <Badge tone={study.status === "paused" ? "warning" : "success"}>
                    {study.status === "paused" ? "paused" : "limited group share"}
                  </Badge>
                </div>
                <div className="disclosure-package">
                  <div className="disclosure-row">
                    <strong>Can do</strong>
                    <span>{plainCapabilitySummary(["analytics/contribute"])}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Safe details</strong>
                    <span>{study.fields.map(formatAnalyticsField).join(", ")}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Not allowed</strong>
                    <span>{plainNonGrantedCapabilities(["analytics/contribute"]).join(", ")}</span>
                  </div>
                </div>
              </div>
              <label className="consent-box">
                <input
                  checked={selected}
                  onChange={() => toggleStudy(study.id)}
                  type="checkbox"
                />
                <span>
                  <strong>Allow this choice to use the group facts listed above.</strong>
                  <small>Exact location, files, names, and contact details are not used.</small>
                </span>
              </label>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ProofCenterScreen({
  apiConfig,
  proofs,
  refreshWalletAuditEvents,
  refreshWalletProofReceipts,
  setProofs,
  worldIdState
}: {
  apiConfig?: WalletApiConfig;
  proofs: ProofReceiptView[];
  refreshWalletAuditEvents: () => Promise<void>;
  refreshWalletProofReceipts: () => Promise<void>;
  setProofs: (proofs: ProofReceiptView[]) => void;
  worldIdState: WorldIdSurfaceState;
}) {
  const [locationRecordId, setLocationRecordId] = useState(
    (import.meta.env.VITE_DEMO_LOCATION_RECORD_ID as string | undefined) ?? "rec-location-current"
  );
  const [regionId, setRegionId] = useState("multnomah_county");
  const [grantId, setGrantId] = useState("");
  const [proofStatus, setProofStatus] = useState<"idle" | "creating" | "created" | "failed">("idle");
  const [proofError, setProofError] = useState("");
  const worldIdProofs = proofs.filter((proof) => proof.proofType === "world_id_proof_of_human");
  const verifiedWorldIdProof = worldIdProofs.find((proof) => getProofReceiptUiState(proof).accepted);
  const worldIdReceiptState = verifiedWorldIdProof ? getProofReceiptUiState(verifiedWorldIdProof) : null;
  const worldIdStatusLabel = worldIdState.verified
    ? "Verified proof-of-human"
    : worldIdState.canOfferVerification
      ? "Ready to verify"
      : worldIdState.availabilityLabel;
  const [proofFailureConsensus, setProofFailureConsensus] = useState<WalletConsensusMetadata | undefined>();

  async function createProof(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiConfig?.actorDid || !locationRecordId.trim() || !regionId.trim()) {
      setProofError("A connected wallet API, actor DID, location record, and region ID are required.");
      setProofStatus("failed");
      return;
    }
    setProofError("");
    setProofFailureConsensus(undefined);
    setProofStatus("creating");
    try {
      const proof = await createLocationRegionProof(apiConfig, {
        grantId: grantId.trim() || undefined,
        locationRecordId: locationRecordId.trim(),
        regionId: regionId.trim()
      });
      setProofs([proof, ...proofs.filter((item) => item.id !== proof.id)]);
      await refreshWalletAuditEvents().catch(() => undefined);
      setProofStatus("created");
    } catch (error) {
      setProofError(proofApiErrorMessage(error));
      setProofFailureConsensus(error instanceof WalletApiConsensusFailClosedError ? error.consensus : undefined);
      setProofStatus("failed");
    }
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Proof center</p>
        <h1>Verified wallet claims</h1>
      </div>
      <p className="page-note">
        Proof receipts expose public claims and verifier details without showing raw documents or precise location.
      </p>
      <section className="world-id-proof-center-summary" aria-label="World ID wallet status">
        <div>
          <p className="eyebrow">World ID wallet status</p>
          <h2>{worldIdStatusLabel}</h2>
          <p>
            Proof-of-human can show that a World ID human credential is bound to this wallet. It does not disclose
            or prove legal name, age, citizenship, address, government ID, or other legal identity attributes.
          </p>
          <p>
            World ID is optional here. Emergency and essential-service flows remain available when World ID is
            unavailable or cannot be used.
          </p>
        </div>
        <div className="world-id-proof-center-facts" aria-label="World ID proof center facts">
          <StatusPanel
            label="Wallet"
            tone={apiConfig ? "success" : "warning"}
            value={apiConfig?.walletId ?? "Not connected"}
          />
          <StatusPanel
            label="Actor DID"
            tone={apiConfig?.actorDid ? "success" : "warning"}
            value={apiConfig?.actorDid ?? "Required"}
          />
          <StatusPanel
            label="Proof receipt"
            tone={worldIdReceiptState?.statusTone ?? "warning"}
            value={worldIdReceiptState?.statusLabel ?? "Not created"}
          />
        </div>
      </section>
      <WorldIdVerificationPanel
        apiConfig={apiConfig}
        onAuditRefresh={refreshWalletAuditEvents}
        onProofsRefresh={refreshWalletProofReceipts}
      />
      <article className="proof-card" aria-label="Create location region proof">
        <div className="scope-header">
          <div>
            <h3>Create location-region proof</h3>
            <p>location/prove_region · public inputs only</p>
          </div>
          <Badge tone={apiConfig ? "success" : "warning"}>{apiConfig ? "API connected" : "API required"}</Badge>
        </div>
        <form className="form-grid" onSubmit={createProof}>
          <Field label="Location record ID" required>
            <input
              onChange={(event) => setLocationRecordId(event.target.value)}
              placeholder="rec-location-current"
              value={locationRecordId}
            />
          </Field>
          <Field label="Region ID" required>
            <input
              onChange={(event) => setRegionId(event.target.value)}
              placeholder="multnomah_county"
              value={regionId}
            />
          </Field>
          <Field label="Grant ID">
            <input
              onChange={(event) => setGrantId(event.target.value)}
              placeholder="Owner wallets can leave this blank"
              value={grantId}
            />
          </Field>
          <div className="capability-preview" role="group" aria-label="Create proof capability preview">
            <div className="disclosure-package">
              <div className="disclosure-row">
                <strong>Ability</strong>
                <span>location/prove_region</span>
              </div>
              <div className="disclosure-row">
                <strong>Public output</strong>
                <span>region_id, claim, region_policy_hash</span>
              </div>
              <div className="disclosure-row">
                <strong>Not allowed</strong>
                <span>{nonGrantedCapabilities(["proof/verify", "location/prove_region"]).join(", ")}</span>
              </div>
            </div>
          </div>
          {proofStatus === "created" ? (
            <StatusBanner tone="success">Proof receipt created and added to the wallet timeline.</StatusBanner>
          ) : null}
          {proofStatus === "failed" ? (
            <StatusBanner tone="warning">
              Proof creation failed. {proofError || "Check the record ID, grant, and API proof mode."} No simulated
              fallback was created.
            </StatusBanner>
          ) : null}
          {proofFailureConsensus ? (
            <ConsensusMetadataPanel
              metadata={proofFailureConsensus}
              surfaceLabel="Proof Center fail-closed proof creation"
            />
          ) : null}
          <Button disabled={!apiConfig?.actorDid || proofStatus === "creating"} type="submit" variant="secondary">
            {proofStatus === "creating" ? "Creating proof..." : "Create proof"}
          </Button>
        </form>
      </article>
      <ConsensusSurfaceStats proofs={proofs} />
      <div className="list-stack">
        {proofs.map((proof) => {
          const titleId = `proof-title-${proof.id}`;
          const state = getProofReceiptUiState(proof);
          const isWorldIdProof = proof.proofType === "world_id_proof_of_human";

          return (
            <article
              aria-labelledby={titleId}
              className={`proof-card proof-system-${state.proofSystemFamily}${isWorldIdProof ? " world-id-proof-receipt-card" : ""}`}
              key={proof.id}
            >
              <div className="scope-header">
                <div>
                  <h3 id={titleId}>{proof.claim}</h3>
                  <p>
                    {proof.proofType} · {proof.verifier}
                  </p>
                </div>
                <Badge tone={state.statusTone}>{state.statusLabel}</Badge>
              </div>
              <div className="badge-row">
                <Badge>{proof.createdAt}</Badge>
                {proof.simulated ? <Badge tone="warning">Simulated</Badge> : null}
                <Badge>{state.inputBoundaryLabel}</Badge>
                <Badge tone={state.productionEvidence ? "success" : "warning"}>{state.dashboardLabel}</Badge>
              </div>
              {isWorldIdProof ? (
                <StatusBanner tone="info">
                  This World ID proof-of-human receipt is not legal identity. It does not disclose or prove legal name,
                  age, citizenship, address, government ID, or document possession.
                </StatusBanner>
              ) : null}
              <div
                className="capability-preview"
                role="group"
                aria-label={`${proof.claim} proof capability preview`}
              >
                <div className="scope-header">
                  <div>
                    <h4>What this allows</h4>
                    <p>{proof.proofType} · public inputs only</p>
                  </div>
                  <Badge tone={state.statusTone}>{state.accepted ? state.evidenceLabel : "not accepted"}</Badge>
                </div>
                <div className="disclosure-package">
                  <div className="disclosure-row">
                    <strong>Ability</strong>
                    <span>proof/verify</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Proof system</strong>
                    <span>{state.proofSystemLabel}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Verification</strong>
                    <span>{state.statusLabel}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Provider review</strong>
                    <span>{state.providerLabel}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Public dashboard</strong>
                    <span>{state.dashboardLabel}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>QR and export</strong>
                    <span>{state.exportLabel}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>On-chain status</strong>
                    <span>{state.onChainLabel}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Evidence label</strong>
                    <span>{state.evidenceLabel}</span>
                  </div>
                  {proof.circuitId ? (
                    <div className="disclosure-row">
                      <strong>Circuit</strong>
                      <span>{proof.circuitId}</span>
                    </div>
                  ) : null}
                  {proof.verifierDigest ? (
                    <div className="disclosure-row">
                      <strong>Verifier digest</strong>
                      <span>{proof.verifierDigest.slice(0, 16)}...</span>
                    </div>
                  ) : null}
                  <div className="disclosure-row">
                    <strong>Public inputs</strong>
                    <span>{Object.keys(proof.publicInputs).join(", ")}</span>
                  </div>
                  {isWorldIdProof ? (
                    <div className="disclosure-row">
                      <strong>Not a legal ID claim</strong>
                      <span>Legal name, age, citizenship, address, government ID, document possession</span>
                    </div>
                  ) : null}
                  <div className="disclosure-row">
                    <strong>Not allowed</strong>
                    <span>{nonGrantedCapabilities(["proof/verify"]).join(", ")}</span>
                  </div>
                </div>
              </div>
              <div className="proof-inputs" aria-label={`${proof.claim} public inputs`}>
                {Object.entries(proof.publicInputs).map(([key, value]) => (
                  <div className="disclosure-row" key={key}>
                    <strong>{key}</strong>
                    <span>{value}</span>
                  </div>
                ))}
              </div>
              <ConsensusMetadataPanel
                directLabel="Direct wallet proof"
                metadata={state.consensus}
                surfaceLabel="Proof Center proof card"
              />
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ExportCenterScreen({
  apiConfig,
  bundles,
  proofs,
  setBundles
}: {
  apiConfig?: WalletApiConfig;
  bundles: ExportBundleView[];
  proofs: ProofReceiptView[];
  setBundles: (bundles: ExportBundleView[]) => void;
}) {
  const [audienceDid, setAudienceDid] = useState("did:key:legal-aid-desk");
  const [audienceName, setAudienceName] = useState("Legal Aid desk");
  const [recordIds, setRecordIds] = useState("rec-document-benefits\nrec-location-current");
  const [purpose, setPurpose] = useState("user_export");
  const [exportStatus, setExportStatus] = useState<"idle" | "creating" | "created" | "failed">("idle");
  const [importingBundleId, setImportingBundleId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<"idle" | "imported" | "failed">("idle");
  const exportRecordIds = useMemo(() => parseRecordIds(recordIds), [recordIds]);

  async function createBundle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiConfig) return;
    if (!audienceDid.trim() || exportRecordIds.length === 0) {
      setExportStatus("failed");
      return;
    }
    setExportStatus("creating");
    try {
      const bundleView = await createVerifiedExportBundleView(apiConfig, {
        audienceDid: audienceDid.trim(),
        audienceName: audienceName.trim() || undefined,
        purpose: purpose.trim() || "user_export",
        recordIds: exportRecordIds
      });
      setBundles([bundleView, ...bundles.filter((bundle) => bundle.bundleId !== bundleView.bundleId)]);
      setExportStatus("created");
    } catch {
      setExportStatus("failed");
    }
  }

  async function importBundle(bundleView: ExportBundleView) {
    if (!apiConfig || !bundleView.bundle || bundleView.imported) return;
    setImportingBundleId(bundleView.bundleId);
    setImportStatus("idle");
    try {
      const importedBundle = await importExportBundleView({
        apiBaseUrl: apiConfig.apiBaseUrl,
        bundleView
      });
      setBundles(bundles.map((bundle) => (bundle.bundleId === importedBundle.bundleId ? importedBundle : bundle)));
      setImportStatus("imported");
    } catch {
      setImportStatus("failed");
    } finally {
      setImportingBundleId(null);
    }
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Encrypted exports</p>
        <h1>Shareable wallet bundles</h1>
      </div>
      <p className="page-note">
        Export bundles carry encrypted records, receipt hashes, and storage reports. Importing a bundle does not reveal plaintext.
      </p>
      {!apiConfig ? (
        <StatusBanner tone="warning">Connect Abby before you make live export bundles.</StatusBanner>
      ) : null}
      {exportStatus === "created" ? <StatusBanner tone="success">Export bundle verified.</StatusBanner> : null}
      {exportStatus === "failed" ? <StatusBanner tone="warning">Export bundle creation failed.</StatusBanner> : null}
      {importStatus === "imported" ? <StatusBanner tone="success">Export descriptors imported.</StatusBanner> : null}
      {importStatus === "failed" ? <StatusBanner tone="warning">Export import failed.</StatusBanner> : null}
      <ProofSurfaceSummary
        emptyMessage="No proof receipts are ready for QR review yet."
        limit={6}
        proofs={proofs}
        surface="qr"
        title="QR proof review"
      />
      <Section title="Create export bundle">
        <form className="form-grid export-builder" onSubmit={createBundle}>
          <Field label="Recipient DID" required>
            <input
              onChange={(event) => setAudienceDid(event.target.value)}
              placeholder="did:key:recipient"
              value={audienceDid}
            />
          </Field>
          <Field label="Recipient label">
            <input
              onChange={(event) => setAudienceName(event.target.value)}
              placeholder="Legal Aid desk"
              value={audienceName}
            />
          </Field>
          <Field label="Purpose">
            <input onChange={(event) => setPurpose(event.target.value)} value={purpose} />
          </Field>
          <Field label="Record IDs" required>
            <textarea
              onChange={(event) => setRecordIds(event.target.value)}
              placeholder="rec-document-benefits"
              rows={3}
              value={recordIds}
            />
          </Field>
          <div className="row-actions full-span">
            <Button disabled={!apiConfig || exportStatus === "creating"} type="submit" variant="secondary">
              <ShieldCheck size={18} /> {exportStatus === "creating" ? "Creating" : "Create bundle"}
            </Button>
          </div>
          <div className="capability-preview full-span" role="group" aria-label="Export capability preview">
            <div className="scope-header">
              <div>
                <h3>What this allows</h3>
                <p>{audienceName.trim() || audienceDid.trim() || "Recipient"} · {purpose.trim() || "user_export"}</p>
              </div>
              <Badge tone={exportRecordIds.length > 0 ? "success" : "warning"}>
                {exportRecordIds.length} records
              </Badge>
            </div>
            <div className="disclosure-package">
              <div className="disclosure-row">
                <strong>Ability</strong>
                <span>export/create</span>
              </div>
              <div className="disclosure-row">
                <strong>Records</strong>
                <span>{exportRecordIds.length > 0 ? exportRecordIds.join(", ") : "No records selected"}</span>
              </div>
              <div className="disclosure-row">
                <strong>Outputs</strong>
                <span>Encrypted descriptors, proof receipts, derived artifacts, storage report</span>
              </div>
              <div className="disclosure-row">
                <strong>Not allowed</strong>
                <span>{nonGrantedCapabilities(["export/create"]).join(", ")}</span>
              </div>
            </div>
          </div>
        </form>
      </Section>
      <div className="list-stack">
        {bundles.map((bundle) => {
          const titleId = `export-title-${bundle.id}`;
          const bundleProofs = proofReceiptsFromExportBundle(bundle);
          const proofSystemLabels = uniqueProofSystemLabels(bundleProofs);
          const failClosedProofCount = bundleProofs.filter((proof) => getProofReceiptUiState(proof).failClosed).length;
          const onChainLabel = bundleProofs.some((proof) => {
            const state = getProofReceiptUiState(proof);
            return state.accepted && state.proofSystemFamily === "provekit_recursive_groth16";
          })
            ? "Recursive wrapper evidence included"
            : "No on-chain claim in this export";

          return (
            <article aria-labelledby={titleId} className="export-card" key={bundle.id}>
              <div className="scope-header">
                <div>
                  <h3 id={titleId}>{bundle.audienceName}</h3>
                  <p>{bundle.bundleId}</p>
                </div>
                <Badge tone={bundle.verificationOk && bundle.storageOk ? "success" : "warning"}>
                  {!bundle.verificationOk ? "receipt invalid" : bundle.storageOk ? "storage verified" : "storage missing"}
                </Badge>
              </div>
              <div className="privacy-metrics">
                <StatusPanel label="Records" value={String(bundle.recordCount)} tone="teal" />
                <StatusPanel label="Proofs" value={String(bundle.proofCount)} tone="gold" />
              </div>
              <div className="receipt-hash-row">
                <span>Bundle hash</span>
                <code>{bundle.bundleHash}</code>
              </div>
              <div className="disclosure-package" aria-label={`${bundle.audienceName} export proof review`}>
                <div className="disclosure-row">
                  <strong>Proof systems</strong>
                  <span>
                    {proofSystemLabels.length
                      ? proofSystemLabels.join(", ")
                      : bundle.proofCount
                        ? "Proof receipts included; source wallet metadata only"
                        : "No proofs included"}
                  </span>
                </div>
                <div className="disclosure-row">
                  <strong>QR review</strong>
                  <span>Public proof metadata only; witness and private axiom content are not exported.</span>
                </div>
                <div className="disclosure-row">
                  <strong>Verifier state</strong>
                  <span>{failClosedProofCount ? `${failClosedProofCount} proof receipts fail closed` : "No blocked proof receipts"}</span>
                </div>
                <div className="disclosure-row">
                  <strong>On-chain status</strong>
                  <span>{onChainLabel}</span>
                </div>
              </div>
              <div className="badge-row">
                <Badge tone={bundle.hashOk ? "success" : "warning"}>
                  {bundle.hashOk ? "hash verified" : "hash mismatch"}
                </Badge>
                <Badge tone={bundle.schemaOk ? "success" : "warning"}>
                  {bundle.schemaOk ? "schema verified" : "schema failed"}
                </Badge>
                <Badge>{bundle.createdAt}</Badge>
                <Badge tone={bundle.imported ? "success" : "neutral"}>
                  {bundle.imported ? "import verified" : "not imported"}
                </Badge>
              </div>
              {bundle.schemaError ? <p className="receipt-error">{bundle.schemaError}</p> : null}
              <div className="row-actions">
                <Button
                  disabled={!apiConfig || !bundle.bundle || bundle.imported || importingBundleId === bundle.bundleId}
                  onClick={() => importBundle(bundle)}
                  variant="secondary"
                >
                  <ShieldCheck size={18} /> {importingBundleId === bundle.bundleId ? "Importing" : "Import descriptors"}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function parseRecordIds(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((recordId) => recordId.trim())
        .filter(Boolean)
    )
  );
}

function shortHash(value?: string): string {
  if (!value) return "Unavailable";
  return value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function proofReceiptsFromExportBundle(bundle: ExportBundleView): ProofReceiptView[] {
  const rawProofs = isPlainRecord(bundle.bundle) && Array.isArray(bundle.bundle.proofs) ? bundle.bundle.proofs : [];
  return rawProofs.filter(isPlainRecord).map(mapProofReceiptRecordForUi);
}

function uniqueProofSystemLabels(proofs: ProofReceiptView[]): string[] {
  return Array.from(new Set(proofs.map((proof) => getProofReceiptUiState(proof).proofSystemLabel)));
}

function SecurityScreen({
  apiConfig,
  onVerifyWorldId,
  onSnapshotLoaded,
  proofs,
  worldIdState
}: {
  apiConfig?: WalletApiConfig;
  onVerifyWorldId: () => void;
  onSnapshotLoaded: () => Promise<void> | void;
  proofs: ProofReceiptView[];
  worldIdState: WorldIdSurfaceState;
}) {
  const [snapshotIds, setSnapshotIds] = useState<string[]>([]);
  const [snapshotStatus, setSnapshotStatus] = useState<"idle" | "saving" | "saved" | "loading" | "loaded" | "failed">(
    "idle"
  );
  const [snapshotReport, setSnapshotReport] = useState<WalletSnapshotVerification | null>(null);
  const hasCurrentSnapshot = Boolean(apiConfig && snapshotIds.includes(apiConfig.walletId));

  async function refreshSnapshotState(): Promise<string[]> {
    if (!apiConfig) return [];
    const ids = await listWalletSnapshots(apiConfig);
    setSnapshotIds(ids);
    if (ids.includes(apiConfig.walletId)) {
      setSnapshotReport(await verifyWalletSnapshot(apiConfig));
    } else {
      setSnapshotReport(null);
    }
    return ids;
  }

  useEffect(() => {
    if (!apiConfig) return;
    let cancelled = false;
    refreshSnapshotState()
      .then(() => undefined)
      .catch(() => {
        if (!cancelled) {
          setSnapshotReport(null);
        }
      })
    return () => {
      cancelled = true;
    };
  }, [apiConfig]);

  async function saveSnapshot() {
    if (!apiConfig) return;
    setSnapshotStatus("saving");
    try {
      await saveWalletSnapshot(apiConfig);
      await refreshSnapshotState();
      setSnapshotStatus("saved");
    } catch {
      setSnapshotStatus("failed");
    }
  }

  async function restoreSnapshot() {
    if (!apiConfig || !hasCurrentSnapshot) return;
    setSnapshotStatus("loading");
    try {
      await loadWalletSnapshot(apiConfig);
      setSnapshotReport(await verifyWalletSnapshot(apiConfig));
      await onSnapshotLoaded();
      setSnapshotStatus("loaded");
    } catch {
      setSnapshotStatus("failed");
    }
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Security</p>
        <h1>Account safety</h1>
      </div>
      {!apiConfig ? (
        <StatusBanner tone="warning">Connect Abby to save and load wallet backups.</StatusBanner>
      ) : null}
      {snapshotStatus === "saved" ? <StatusBanner tone="success">Wallet backup saved.</StatusBanner> : null}
      {snapshotStatus === "loaded" ? <StatusBanner tone="success">Wallet backup loaded.</StatusBanner> : null}
      {snapshotStatus === "failed" ? <StatusBanner tone="warning">Wallet backup action failed.</StatusBanner> : null}
      <WorldIdSurfaceSummary
        description="Security review shows the same World ID proof-of-human state as the wallet proof center. Backups and recovery do not require World ID."
        onVerify={onVerifyWorldId}
        state={worldIdState}
        surfaceLabel="Security"
      />
      <Section
        title="Wallet backups"
        actions={
          <Badge tone={hasCurrentSnapshot ? "success" : "warning"}>
            {hasCurrentSnapshot ? "backup ready" : "no backup"}
          </Badge>
        }
      >
        <div className="disclosure-package">
          <div className="disclosure-row">
            <strong>Wallet</strong>
            <span>{apiConfig?.walletId ?? "Not connected"}</span>
          </div>
          <div className="disclosure-row">
            <strong>Backups</strong>
            <span>{snapshotIds.length}</span>
          </div>
          <div className="disclosure-row">
            <strong>Backup place</strong>
            <span>{apiConfig ? "backup store" : "API required"}</span>
          </div>
          <div className="disclosure-row">
            <strong>Backup check</strong>
            <span>{snapshotReport ? (snapshotReport.valid ? "verified" : "failed") : "not checked"}</span>
          </div>
          <div className="disclosure-row">
            <strong>Backup code</strong>
            <span>{snapshotReport?.computed_hash ? <code>{shortHash(snapshotReport.computed_hash)}</code> : "Unavailable"}</span>
          </div>
        </div>
        <div className="row-actions">
          <Button disabled={!apiConfig || snapshotStatus === "saving" || snapshotStatus === "loading"} onClick={saveSnapshot}>
            <Archive size={18} /> {snapshotStatus === "saving" ? "Saving" : "Save backup"}
          </Button>
          <Button
            disabled={!apiConfig || !hasCurrentSnapshot || snapshotStatus === "saving" || snapshotStatus === "loading"}
            onClick={restoreSnapshot}
            variant="secondary"
          >
            <RefreshCw size={18} /> {snapshotStatus === "loading" ? "Loading" : "Load backup"}
          </Button>
        </div>
      </Section>
      <div className="tool-grid">
        <button className="tool-tile" type="button">
          <LockKeyhole size={24} /> Session timeout
        </button>
        <button className="tool-tile" type="button">
          <KeyRound size={24} /> Recovery settings
        </button>
        <button className="tool-tile" type="button">
          <ShieldCheck size={24} /> Bot check settings
        </button>
      </div>
      <ProofSurfaceSummary
        emptyMessage="No proof receipts are available for security review yet."
        limit={6}
        proofs={proofs}
        surface="security"
        title="Proof security review"
      />
    </div>
  );
}

function AuditScreen({ events, proofs }: { events: AuditEvent[]; proofs: ProofReceiptView[] }) {
  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Audit</p>
        <h1>Consent and access history</h1>
      </div>
      <ProofSurfaceSummary
        emptyMessage="No proof receipts have been recorded in the audit coverage view yet."
        limit={6}
        proofs={proofs}
        surface="audit"
        title="Proof audit coverage"
      />
      <div className="timeline">
        {events.map((event) => (
          <article className="timeline-event" key={event.id}>
            <span aria-hidden="true" />
            <div>
              <h3>{event.action}</h3>
              <p>
                {event.actor} · {event.timestamp}
              </p>
              {event.resource || event.decision || event.grantId ? (
                <small>
                  {[event.decision, event.resource, event.grantId].filter(Boolean).join(" · ")}
                </small>
              ) : null}
              {getConsensusMetadataFromView(event) ? (
                <ConsensusMetadataPanel
                  metadata={getConsensusMetadataFromView(event)}
                  surfaceLabel="Security audit event"
                />
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function RecipientAccessScreen({
  accessRequests,
  grantReceipts
}: {
  accessRequests: WalletAccessRequest[];
  grantReceipts: WalletGrantReceipt[];
}) {
  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Recipient access</p>
        <h1>Who can see your info</h1>
      </div>
      {accessRequests.length === 0 && grantReceipts.length === 0 ? (
        <p>No access requests or grant receipts yet.</p>
      ) : null}
      {accessRequests.length > 0 ? (
        <Section title="Access requests">
          {accessRequests.map((req) => (
            <ActionCard key={req.id} title={req.requesterName} detail={req.purpose} icon={<KeyRound size={18} />} />
          ))}
        </Section>
      ) : null}
      {grantReceipts.length > 0 ? (
        <Section title="Grant receipts">
          {grantReceipts.map((receipt) => (
            <ActionCard key={receipt.id} title={receipt.audienceName} detail={receipt.purpose} icon={<ShieldCheck size={18} />} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function BenefitsProtectionScreen({
  optedIn,
  setOptedIn
}: {
  optedIn: boolean;
  setOptedIn: (optedIn: boolean) => void;
}) {
  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Benefits protection</p>
        <h1>Protect your benefits</h1>
      </div>
      <Section title="Benefits opt-in">
        <label>
          <input
            type="checkbox"
            checked={optedIn}
            onChange={(e) => setOptedIn(e.target.checked)}
          />
          {" "}Enable benefits protection
        </label>
      </Section>
    </div>
  );
}
