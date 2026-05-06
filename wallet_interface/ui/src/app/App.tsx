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
import { getRouteLabel } from "../agent/surfaceRegistry";
import {
  getServiceDetailDocIdFromHash,
  openCanonicalServiceDetailRoute
} from "../agent/tools/serviceDetailTools";
import type { AppActionRuntime } from "./appActions";
import { useAgentChatService } from "../services/agentChatService";
import { ServiceDetailScreen } from "./ServiceDetailScreen";
import { search211Info } from "../services/graphRagService";
import type { SearchResult } from "../lib/graphrag";
import {
  CheckInChannel,
  AuditEvent,
  DecryptedRecordView,
  DisclosureDataScope,
  DisclosureRecipientDraft,
  DisclosureRecipientType,
  DerivedArtifactView,
  ExportBundleView,
  RegistrationProfileDraft,
  RouteId,
  SavedService,
  ServiceInteractionEvent,
  ServicePlan,
  ShelterContactRequest,
  UploadItem,
  WalletAccessRequest,
  WalletGrantReceipt,
  ProofReceiptView
} from "../models/abby";
import {
  analyticsStudies,
  auditEvents,
  defaultDisclosureScopes,
  defaultCheckInPolicy,
  exportBundles,
  initialAccessRequests,
  initialGrantReceipts,
  initialUploads,
  proofReceipts,
  serviceMatches
} from "../services/mockAbbyService";
import {
  abilitiesForDisclosureScopes,
  capabilitySummary,
  nonGrantedCapabilities,
  plainCapabilityLabel,
  plainCapabilitySummary,
  plainNonGrantedCapabilities
} from "../services/capabilities";
import {
  approveAccessRequest,
  approveThresholdApproval,
  addBinaryDocument,
  addTextDocument,
  analyzeRecordFormRedactedWithGrant,
  analyzeRecordRedactedWithGrant,
  analyzeRecordWithGrant,
  createRedactedGraphRAG,
  createRecordVectorProfileWithGrant,
  createLocationRegionProof,
  createVerifiedExportBundleView,
  delegateGrant,
  decryptRecordWithGrant,
  extractRecordTextRedactedWithGrant,
  importExportBundleView,
  issueRecordAnalysisInvocation,
  issueRecordDecryptInvocation,
  listWalletSnapshots,
  loadExportBundleView,
  loadWalletSnapshot,
  loadWalletAccessState,
  listWalletAuditEvents,
  listWalletDocuments,
  listWalletProofReceipts,
  rejectAccessRequest,
  repairRecordStorage,
  revokeAccessRequest,
  saveWalletSnapshot,
  verifyWalletSnapshot,
  WalletSnapshotVerification,
  WalletApiConfig
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

const WALLET_API_CONFIG_KEY = "abby-wallet-api-config";
const ID_DOCUMENT_ACCEPT_ATTR = "image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf";
const ID_DOCUMENT_ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const ID_DOCUMENT_ACCEPTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];

const routeIcons: Record<RouteId, typeof Home> = {
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

const routes = primaryRoutes.map((route) => ({ ...route, icon: routeIcons[route.id] }));
const secondaryNavigationRoutes = secondaryRoutes.map((route) => ({ ...route, icon: routeIcons[route.id] }));
const navigationRoutes = appRoutes.map((route) => ({ ...route, icon: routeIcons[route.id] }));

function getInitialRouteFromHash(): RouteId {
  return getServiceDetailDocIdFromHash() ? "social-services" : getRouteFromHash();
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

export function App() {
  const defaultAppState = useMemo(() => createDefaultAppState(readPersistedAppState()), []);
  const [activeRoute, setActiveRoute] = useState<RouteId>(getInitialRouteFromHash);
  const [serviceDetailDocId, setServiceDetailDocId] = useState<string | null>(getServiceDetailDocIdFromHash);
  const activeRouteRef = useRef(activeRoute);
  activeRouteRef.current = activeRoute;
  const [profile, setProfile] = useState<RegistrationProfileDraft>(() => defaultAppState.profile);
  const [policy, setPolicy] = useState(() => defaultAppState.policy);
  const [recipients, setRecipients] = useState<DisclosureRecipientDraft[]>(() => defaultAppState.recipients);
  const [uploads, setUploads] = useState<UploadItem[]>(() => defaultAppState.uploads);
  const [accessRequests, setAccessRequests] = useState<WalletAccessRequest[]>(initialAccessRequests);
  const [shelterContactRequests, setShelterContactRequests] = useState<ShelterContactRequest[]>(
    () => defaultAppState.shelterContactRequests
  );
  const [shelterStaffAccounts, setShelterStaffAccounts] = useState<ShelterStaffAccount[]>(
    () => defaultAppState.shelterStaffAccounts
  );
  const [shelterUserAccounts, setShelterUserAccounts] = useState<ShelterUserAccount[]>(
    () => defaultAppState.shelterUserAccounts
  );
  const [grantReceipts, setGrantReceipts] = useState<WalletGrantReceipt[]>(initialGrantReceipts);
  const [walletAuditEvents, setWalletAuditEvents] = useState<AuditEvent[]>(auditEvents);
  const [walletProofReceipts, setWalletProofReceipts] = useState<ProofReceiptView[]>(proofReceipts);
  const [exportBundleViews, setExportBundleViews] = useState<ExportBundleView[]>(exportBundles);
  const [savedServices, setSavedServices] = useState<SavedService[]>([]);
  const [servicePlans, setServicePlans] = useState<ServicePlan[]>([]);
  const [serviceInteractions, setServiceInteractions] = useState<ServiceInteractionEvent[]>([]);
  const [recipientVerified, setRecipientVerified] = useState(false);
  const [benefitsOptIn, setBenefitsOptIn] = useState(() => defaultAppState.benefitsOptIn);
  const [analyticsOptIn, setAnalyticsOptIn] = useState<Record<string, boolean>>(() => defaultAppState.analyticsOptIn);
  const [shelterChecklist, setShelterChecklist] = useState(() => defaultAppState.shelterChecklist);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agentChatOpen, setAgentChatOpen] = useState(false);
  const walletApiConfig = useMemo(readWalletApiConfig, []);

  async function refreshWalletAccessState() {
    if (!walletApiConfig) return;
    const walletState = await loadWalletAccessState(walletApiConfig);
    setAccessRequests(walletState.accessRequests);
    setGrantReceipts(walletState.grantReceipts);
  }

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
      refreshWalletAccessState().catch(() => {
        setAccessRequests(initialAccessRequests);
        setGrantReceipts(initialGrantReceipts);
      }),
      refreshWalletAuditEvents().catch(() => setWalletAuditEvents(auditEvents)),
      refreshWalletDocuments().catch(() => setUploads(initialUploads)),
      refreshWalletProofReceipts().catch(() => setWalletProofReceipts(proofReceipts))
    ]);
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
        activeRouteRef.current = route;
        setActiveRoute(route);
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
    const syncRouteFromHash = () => {
      const detailDocId = getServiceDetailDocIdFromHash();
      setServiceDetailDocId(detailDocId);
      setActiveRoute(detailDocId ? "social-services" : getRouteFromHash());
      setMobileNavOpen(false);
    };
    window.addEventListener("hashchange", syncRouteFromHash);
    return () => window.removeEventListener("hashchange", syncRouteFromHash);
  }, []);

  useEffect(() => {
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
    refreshWalletAccessState().catch(() => {
      setAccessRequests(initialAccessRequests);
      setGrantReceipts(initialGrantReceipts);
    });
  }, [walletApiConfig]);

  useEffect(() => {
    if (!walletApiConfig) return;
    refreshWalletDocuments().catch(() => setUploads(initialUploads));
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
    setLocationRouteHash(route);
    activeRouteRef.current = route;
    setActiveRoute(route);
    setServiceDetailDocId(null);
    setMobileNavOpen(false);
  }

  function openServiceDetail(docId: string) {
    openCanonicalServiceDetailRoute(docId, {
      setActiveRoute: (route) => {
        activeRouteRef.current = route;
        setActiveRoute(route);
      },
      setServiceDetailDocId,
      setMobileNavOpen
    });
  }

  const nextCheckIn = useMemo(() => {
    const next = new Date(policy.lastCheckInAt);
    next.setDate(next.getDate() + policy.intervalDays);
    return next.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }, [policy.intervalDays, policy.lastCheckInAt]);

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
          <Button ariaLabel="Sign out" variant="quiet">
            <LogOut size={20} />
          </Button>
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
          <HomeScreen navigate={navigate} nextCheckIn={nextCheckIn} recipients={recipients} uploads={uploads} />
        ) : null}
        {activeRoute === "register" ? (
          <RegistrationScreen
            profile={profile}
            setProfile={setProfile}
            shelterStaffAccounts={shelterStaffAccounts}
            setShelterStaffAccounts={setShelterStaffAccounts}
          />
        ) : null}
        {activeRoute === "check-in" ? (
          <CheckInScreen nextCheckIn={nextCheckIn} policy={policy} profile={profile} setPolicy={setPolicy} />
        ) : null}
        {activeRoute === "contacts" || activeRoute === "sharing-rules" ? (
          <ContactsScreen
            contactRequests={shelterContactRequests}
            profile={profile}
            recipients={recipients}
            sharingCompatibility={activeRoute === "sharing-rules"}
            setContactRequests={setShelterContactRequests}
            setRecipients={setRecipients}
          />
        ) : null}
        {activeRoute === "uploads" ? (
          <UploadsScreen
            apiConfig={walletApiConfig}
            refreshWalletAuditEvents={refreshWalletAuditEvents}
            uploads={uploads}
            setUploads={setUploads}
          />
        ) : null}
        {serviceDetailDocId ? (
          <ServiceDetailScreen docId={serviceDetailDocId} onBack={() => navigate("social-services")} />
        ) : null}
        {activeRoute === "social-services" && !serviceDetailDocId ? (
          <SocialServicesScreen onOpenServiceDetail={openServiceDetail} />
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
          />
        ) : null}
        {activeRoute === "recipient-access" ? (
          <RecipientAccessScreen
            accessRequests={accessRequests}
            apiConfig={walletApiConfig}
            grantReceipts={grantReceipts}
            recipients={recipients}
            refreshWalletAuditEvents={refreshWalletAuditEvents}
            refreshWalletAccessState={refreshWalletAccessState}
            setAccessRequests={setAccessRequests}
            setGrantReceipts={setGrantReceipts}
            verified={recipientVerified}
            setVerified={setRecipientVerified}
          />
        ) : null}
        {activeRoute === "benefits-protection" ? (
          <BenefitsProtectionScreen optedIn={benefitsOptIn} setOptedIn={setBenefitsOptIn} />
        ) : null}
        {activeRoute === "analytics" ? (
          <AnalyticsScreen optedIn={analyticsOptIn} setOptedIn={setAnalyticsOptIn} />
        ) : null}
        {activeRoute === "proof-center" ? (
          <ProofCenterScreen
            apiConfig={walletApiConfig}
            proofs={walletProofReceipts}
            refreshWalletAuditEvents={refreshWalletAuditEvents}
            setProofs={setWalletProofReceipts}
          />
        ) : null}
        {activeRoute === "exports" ? (
          <ExportCenterScreen
            apiConfig={walletApiConfig}
            bundles={exportBundleViews}
            setBundles={setExportBundleViews}
          />
        ) : null}
        {activeRoute === "security" ? (
          <SecurityScreen apiConfig={walletApiConfig} onSnapshotLoaded={refreshWalletAfterSnapshotLoad} />
        ) : null}
        {activeRoute === "audit" ? <AuditScreen events={walletAuditEvents} /> : null}
      </main>
      <AgentChatDrawer
        activeRouteLabel={getRouteLabel(activeRoute)}
        confirmations={agentChat.pendingConfirmations}
        evidenceBundles={agentChat.snapshot.session.evidenceBundles}
        messages={agentChat.messages}
        onCancelConfirmation={(confirmationId) => agentChat.denyConfirmation(confirmationId)}
        onClose={() => setAgentChatOpen(false)}
        onConfirmConfirmation={(confirmationId) => agentChat.approveConfirmation(confirmationId)}
        onOpenServiceDetail={openServiceDetail}
        onSend={(message) => {
          void agentChat.sendMessage(message);
        }}
        onToggle={() => setAgentChatOpen((open) => !open)}
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

function HomeScreen({
  navigate,
  nextCheckIn,
  recipients,
  uploads
}: {
  navigate: (route: RouteId) => void;
  nextCheckIn: string;
  recipients: DisclosureRecipientDraft[];
  uploads: UploadItem[];
}) {
  return (
    <div className="screen home-screen">
      <div className="page-title">
        <p className="eyebrow">Today</p>
        <h1>Your safety plan</h1>
      </div>
      <div className="home-actions" role="group" aria-label="Primary actions">
        <ActionCard
          detail={`${recipients.length} people or services set up`}
          icon={<ContactRound aria-hidden="true" size={28} />}
          onClick={() => navigate("contacts")}
          title="Contacts"
        />
        <ActionCard
          detail="Choose what people can see"
          icon={<ShieldCheck aria-hidden="true" size={28} />}
          onClick={() => navigate("sharing-rules")}
          title="Sharing"
        />
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
      <div className="home-footer">
        <div className="home-footer-stat">
          <small>Saved files</small>
          <span>{uploads.length} file{uploads.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="home-footer-divider" />
        <div className="home-footer-stat">
          <small>Sharing choices</small>
          <span>Ready to review</span>
        </div>
      </div>
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

function RegistrationScreen({
  profile,
  setProfile,
  shelterStaffAccounts,
  setShelterStaffAccounts
}: {
  profile: RegistrationProfileDraft;
  setProfile: (profile: RegistrationProfileDraft) => void;
  shelterStaffAccounts: ShelterStaffAccount[];
  setShelterStaffAccounts: (accounts: ShelterStaffAccount[]) => void;
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
      <StatusBanner tone="info">To start, add your name, birth date, photo or ID, and pass the person check.</StatusBanner>
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
          <input
            checked={Boolean(profile.captchaToken)}
            disabled={profile.easyBotCheckStatus !== "passed"}
            onChange={(event) => update({ captchaToken: event.target.checked ? "mock-captcha-token" : "" })}
            type="checkbox"
          />
          <span>Bot check complete (step 2)</span>
        </label>
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
  sharingCompatibility = false,
  setContactRequests,
  setRecipients
}: {
  contactRequests: ShelterContactRequest[];
  profile: RegistrationProfileDraft;
  recipients: DisclosureRecipientDraft[];
  sharingCompatibility?: boolean;
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
        <p className="eyebrow">{sharingCompatibility ? "Sharing choices" : "Emergency contacts"}</p>
        <h1>People who can help</h1>
      </div>
      <StatusBanner tone="info">
        Sharing choices live with each saved contact. Open a contact below to change what they can see.
      </StatusBanner>
      <Section title="Add shelter or group">
        <StatusBanner tone="info">
          A shelter is added only after the other side says yes. It starts with Minimum identity only.
        </StatusBanner>
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
  refreshWalletAuditEvents,
  uploads,
  setUploads
}: {
  apiConfig?: WalletApiConfig;
  refreshWalletAuditEvents: () => Promise<void>;
  uploads: UploadItem[];
  setUploads: (uploads: UploadItem[]) => void;
}) {
  const [repairingUploadIds, setRepairingUploadIds] = useState<string[]>([]);

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

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Uploads</p>
        <h1>Saved files and info</h1>
      </div>
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
    </div>
  );
}

function SocialServicesScreen({ onOpenServiceDetail }: { onOpenServiceDetail: (docId: string) => void }) {
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
                    <Button onClick={() => onOpenServiceDetail(result.docId)} variant="secondary">
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
  setShelterUserAccounts
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
    const botCheckReady =
      userDraft.easyBotCheckStatus === "failed" ||
      (userDraft.easyBotCheckStatus === "passed" && Boolean(userDraft.captchaToken));
    if (!selectedOperator || !hasRequiredIdentity || !botCheckReady) return;

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
      <StatusBanner tone="info">Shelter workflows are free and keep user sharing choices separate from staff access.</StatusBanner>
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
                      checked={Boolean(userDraft.captchaToken)}
                      disabled={userDraft.easyBotCheckStatus !== "passed"}
                      onChange={(event) =>
                        setUserDraft({ ...userDraft, captchaToken: event.target.checked ? "mock-captcha-token" : "" })
                      }
                      type="checkbox"
                    />
                    <span>Bot check complete (step 2)</span>
                  </label>
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
                        (userDraft.easyBotCheckStatus === "pending") ||
                        (userDraft.easyBotCheckStatus === "passed" && !userDraft.captchaToken)
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
                <StatusBanner tone="info">
                  Send a request only. The person must approve before this shelter is added.
                </StatusBanner>
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
                            {account.easyBotCheckStatus === "failed" ? <Badge tone="warning">Health check</Badge> : null}
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
                            {account.easyBotCheckStatus === "failed" ? <Badge tone="warning">Health check</Badge> : null}
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
                      </div>
                    </div>
                    <Button
                      onClick={() =>
                        setShelterStaffAccounts(
                          shelterStaffAccounts.map((item) =>
                            item.id === account.id
                              ? { ...item, verified: !item.verified, updatedAt: new Date().toISOString() }
                              : item
                          )
                        )
                      }
                      variant="secondary"
                    >
                      {account.verified ? "Revoke verification" : "Re-verify"}
                    </Button>
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

type RecipientAnalysisMode = "summary" | "redacted" | "vector" | "extract-text" | "form" | "graphrag";

function RecipientAccessScreen({
  accessRequests,
  apiConfig,
  grantReceipts,
  recipients,
  refreshWalletAuditEvents,
  refreshWalletAccessState,
  setAccessRequests,
  setGrantReceipts,
  verified,
  setVerified
}: {
  accessRequests: WalletAccessRequest[];
  apiConfig?: WalletApiConfig;
  grantReceipts: WalletGrantReceipt[];
  recipients: DisclosureRecipientDraft[];
  refreshWalletAuditEvents: () => Promise<void>;
  refreshWalletAccessState: () => Promise<void>;
  setAccessRequests: (requests: WalletAccessRequest[]) => void;
  setGrantReceipts: (receipts: WalletGrantReceipt[]) => void;
  verified: boolean;
  setVerified: (verified: boolean) => void;
}) {
  const recipient = recipients[0];
  const [derivedArtifactsByReceiptId, setDerivedArtifactsByReceiptId] = useState<Record<string, DerivedArtifactView>>(
    {}
  );
  const [derivedOutputsByReceiptId, setDerivedOutputsByReceiptId] = useState<Record<string, string>>({});
  const [decryptedRecordsByReceiptId, setDecryptedRecordsByReceiptId] = useState<Record<string, DecryptedRecordView>>(
    {}
  );
  const [analyzingReceiptIds, setAnalyzingReceiptIds] = useState<string[]>([]);
  const [decryptingReceiptIds, setDecryptingReceiptIds] = useState<string[]>([]);
  const [delegatingReceiptIds, setDelegatingReceiptIds] = useState<string[]>([]);
  const [delegationDrafts, setDelegationDrafts] = useState<
    Record<string, { audienceDid: string; audienceKeyHex: string; purpose: string; ability: string }>
  >({});
  const [delegationMessages, setDelegationMessages] = useState<Record<string, string>>({});

  function hasThresholdApproval(request: WalletAccessRequest) {
    if (!request.approvalRequired) return true;
    return (request.approvalCount ?? 0) >= (request.approvalThreshold ?? 1);
  }

  function delegationAbilityOptions(receipt: WalletGrantReceipt) {
    const abilities = receipt.abilities.includes("*") ? ["record/analyze", "record/decrypt"] : receipt.abilities;
    return ["record/analyze", "record/decrypt"].filter((ability) => abilities.includes(ability));
  }

  function receiptHasAbility(receipt: WalletGrantReceipt, ability: string) {
    return receipt.abilities.includes("*") || receipt.abilities.includes(ability);
  }

  function receiptOutputTypes(receipt: WalletGrantReceipt) {
    const rawOutputTypes = receipt.caveats?.output_types ?? receipt.caveats?.allowed_output_types;
    if (!rawOutputTypes) return [];
    if (Array.isArray(rawOutputTypes)) return rawOutputTypes.map(String);
    return [String(rawOutputTypes)];
  }

  function receiptAllowsOutput(receipt: WalletGrantReceipt, outputType: string) {
    const outputTypes = receiptOutputTypes(receipt);
    return outputTypes.length === 0 || outputTypes.includes(outputType);
  }

  function receiptRequiresUserPresence(receipt: WalletGrantReceipt) {
    return receipt.caveats?.user_presence_required === true || receipt.caveats?.require_user_presence === true;
  }

  function analysisActionId(receipt: WalletGrantReceipt, mode: RecipientAnalysisMode) {
    return `${receipt.id}:${mode}`;
  }

  function outputTypeForAnalysisMode(mode: RecipientAnalysisMode) {
    if (mode === "redacted") return "redacted_derived_only";
    if (mode === "vector") return "vector_profile";
    if (mode === "extract-text") return "redacted_extracted_text";
    if (mode === "form") return "redacted_form_analysis";
    if (mode === "graphrag") return "redacted_graphrag";
    return "summary";
  }

  function summarizeDerivedOutput(output: Record<string, unknown>) {
    if (typeof output.summary === "string" && output.summary.trim()) return output.summary;
    if (typeof output.text === "string" && output.text.trim()) return output.text;
    const profile = output.profile;
    if (profile && typeof profile === "object" && !Array.isArray(profile)) {
      const profileRecord = profile as Record<string, unknown>;
      const profileType = typeof profileRecord.profile_type === "string" ? profileRecord.profile_type : "vector profile";
      const chunkCount = typeof profileRecord.chunk_count === "number" ? profileRecord.chunk_count : undefined;
      return chunkCount === undefined ? profileType : `${profileType} · ${chunkCount} chunks`;
    }
    const fields = output.fields;
    if (Array.isArray(fields)) {
      const fieldLabels = fields
        .map((field) => {
          if (!field || typeof field !== "object" || Array.isArray(field)) return "";
          const fieldRecord = field as Record<string, unknown>;
          return String(fieldRecord.label ?? fieldRecord.name ?? "").trim();
        })
        .filter(Boolean)
        .slice(0, 3);
      return fieldLabels.length > 0
        ? `${fields.length} redacted fields: ${fieldLabels.join(", ")}`
        : `${fields.length} redacted fields`;
    }
    const form = output.form;
    if (form && typeof form === "object" && !Array.isArray(form)) {
      const formRecord = form as Record<string, unknown>;
      const fieldCount = typeof formRecord.field_count === "number" ? formRecord.field_count : undefined;
      if (fieldCount !== undefined) return `${fieldCount} redacted form fields`;
    }
    const graph = output.graph;
    if (graph && typeof graph === "object" && !Array.isArray(graph)) {
      const graphRecord = graph as Record<string, unknown>;
      const graphType = typeof graphRecord.graph_type === "string" ? graphRecord.graph_type : "redacted graph";
      const nodeCount = typeof graphRecord.node_count === "number" ? graphRecord.node_count : undefined;
      const edgeCount = typeof graphRecord.edge_count === "number" ? graphRecord.edge_count : undefined;
      if (nodeCount !== undefined && edgeCount !== undefined) return `${graphType} · ${nodeCount} nodes · ${edgeCount} edges`;
      return graphType;
    }
    if (typeof output.output_policy === "string") return output.output_policy;
    return "Safe derived output created.";
  }

  function canDelegateReceipt(receipt: WalletGrantReceipt, abilityOptions: string[]) {
    const hasShare = receipt.abilities.some(
      (ability) => ability === "*" || ability === "record/share" || ability === "document/share"
    );
    return (
      Boolean(apiConfig?.actorDid) &&
      apiConfig?.actorDid === receipt.audienceDid &&
      receipt.status === "active" &&
      hasShare &&
      abilityOptions.length > 0 &&
      receipt.resources.length > 0
    );
  }

  function delegationDraftFor(receipt: WalletGrantReceipt, abilityOptions: string[]) {
    const draft = delegationDrafts[receipt.id];
    const fallbackAbility = abilityOptions[0] ?? "record/analyze";
    if (!draft) {
      return {
        audienceDid: "",
        audienceKeyHex: "",
        purpose: receipt.purpose,
        ability: fallbackAbility
      };
    }
    return {
      ...draft,
      ability: abilityOptions.includes(draft.ability) ? draft.ability : fallbackAbility
    };
  }

  function updateDelegationDraft(
    receipt: WalletGrantReceipt,
    abilityOptions: string[],
    patch: Partial<{ audienceDid: string; audienceKeyHex: string; purpose: string; ability: string }>
  ) {
    setDelegationDrafts({
      ...delegationDrafts,
      [receipt.id]: {
        ...delegationDraftFor(receipt, abilityOptions),
        ...patch
      }
    });
  }

  async function recordControllerApproval(requestId: string) {
    const request = accessRequests.find((item) => item.id === requestId);
    if (apiConfig?.actorDid && request?.approvalId) {
      try {
        await approveThresholdApproval(apiConfig, request.approvalId);
        await refreshWalletAccessState();
        await refreshWalletAuditEvents();
        return;
      } catch {
        // Keep the local demo path responsive if a configured API is unavailable.
      }
    }
    setAccessRequests(
      accessRequests.map((request) =>
        request.id === requestId
          ? {
              ...request,
              approvalCount: Math.min(
                (request.approvalCount ?? 0) + 1,
                request.approvalThreshold ?? (request.approvalCount ?? 0) + 1
              )
            }
          : request
      )
    );
  }

  async function decideRequest(requestId: string, status: "approved" | "rejected") {
    const request = accessRequests.find((item) => item.id === requestId);
    if (apiConfig?.actorDid) {
      try {
        if (status === "approved") {
          await approveAccessRequest(apiConfig, requestId);
        } else {
          await rejectAccessRequest(apiConfig, requestId);
        }
        await refreshWalletAccessState();
        await refreshWalletAuditEvents();
        return;
      } catch {
        // Keep the local demo path responsive if a configured API is unavailable.
      }
    }
    setAccessRequests(
      accessRequests.map((request) =>
        request.id === requestId
          ? { ...request, status, grantStatus: status === "approved" ? "active" : request.grantStatus }
          : request
      )
    );
    if (status === "approved" && request && !grantReceipts.some((receipt) => receipt.id === `receipt-${request.id}`)) {
      setGrantReceipts([
        ...grantReceipts,
        {
          id: `receipt-${request.id}`,
          grantId: `grant-${request.id}`,
          audienceName: request.requesterName,
          audienceDid: request.audienceDid,
          resources: [`wallet://demo-wallet/records/${request.resourceLabel}`],
          recordId: undefined,
          resourceLabel: request.resourceLabel,
          abilities: request.abilities,
          purpose: request.purpose,
          receiptHash: `local-${request.id}-receipt`,
          status: "active",
          createdAt: "Just now",
          expiresAt: "30 days"
        }
      ]);
    }
  }

  async function revokeRequest(requestId: string) {
    const request = accessRequests.find((item) => item.id === requestId);
    if (apiConfig?.actorDid) {
      try {
        await revokeAccessRequest(apiConfig, requestId);
        await refreshWalletAccessState();
        await refreshWalletAuditEvents();
        return;
      } catch {
        // Keep the local demo path responsive if a configured API is unavailable.
      }
    }
    setAccessRequests(
      accessRequests.map((request) =>
        request.id === requestId ? { ...request, grantStatus: "revoked" } : request
      )
    );
    if (request) {
      setGrantReceipts(
        grantReceipts.map((receipt) =>
          receipt.audienceDid === request.audienceDid &&
          receipt.resourceLabel === request.resourceLabel &&
          receipt.status === "active"
            ? { ...receipt, status: "revoked" }
            : receipt
        )
      );
    }
  }

  async function analyzeReceipt(receipt: WalletGrantReceipt, mode: RecipientAnalysisMode = "summary") {
    if (!receipt.recordId || receipt.status !== "active" || !receiptHasAbility(receipt, "record/analyze")) return;
    const recordId = receipt.recordId;
    const actionId = analysisActionId(receipt, mode);
    setAnalyzingReceiptIds((receiptIds) => [...receiptIds, actionId]);
    try {
      let safeOutput = "";
      const artifact = await (async () => {
        if (!apiConfig?.actorDid) {
          const localArtifacts: Record<RecipientAnalysisMode, DerivedArtifactView> = {
            summary: {
              id: `artifact-${receipt.id}`,
              sourceRecordIds: [recordId],
              artifactType: "summary",
              outputPolicy: "derived_only",
              encryptedPayloadRef: "local encrypted derived artifact",
              createdAt: "Just now"
            },
            redacted: {
              id: `artifact-redacted-${receipt.id}`,
              sourceRecordIds: [recordId],
              artifactType: "redacted_document_analysis",
              outputPolicy: "redacted_derived_only",
              encryptedPayloadRef: "local encrypted redacted artifact",
              createdAt: "Just now"
            },
            vector: {
              id: `artifact-vector-${receipt.id}`,
              sourceRecordIds: [recordId],
              artifactType: "redacted_document_vector_profile",
              outputPolicy: "encrypted_vector_profile",
              encryptedPayloadRef: "local encrypted vector profile",
              createdAt: "Just now"
            },
            "extract-text": {
              id: `artifact-text-${receipt.id}`,
              sourceRecordIds: [recordId],
              artifactType: "redacted_document_text_extraction",
              outputPolicy: "redacted_extracted_text",
              encryptedPayloadRef: "local encrypted extracted text",
              createdAt: "Just now"
            },
            form: {
              id: `artifact-form-${receipt.id}`,
              sourceRecordIds: [recordId],
              artifactType: "redacted_document_form_analysis",
              outputPolicy: "redacted_form_analysis",
              encryptedPayloadRef: "local encrypted form analysis",
              createdAt: "Just now"
            },
            graphrag: {
              id: `artifact-graphrag-${receipt.id}`,
              sourceRecordIds: [recordId],
              artifactType: "redacted_document_graphrag",
              outputPolicy: "redacted_graphrag",
              encryptedPayloadRef: "local encrypted GraphRAG",
              createdAt: "Just now"
            }
          };
          safeOutput =
            mode === "redacted"
              ? "Local demo redacted derived output."
              : mode === "vector"
                ? "redacted_lexical_hash_vector · local chunks"
                : mode === "extract-text"
                  ? "Local demo redacted extracted text."
                  : mode === "form"
                    ? "Local demo redacted form fields."
                    : mode === "graphrag"
                      ? "redacted_category_entity_graph · local nodes"
                      : "";
          return localArtifacts[mode];
        }
        const invocationToken = receiptRequiresUserPresence(receipt)
          ? await issueRecordAnalysisInvocation(apiConfig, {
              grantId: receipt.grantId,
              recordId,
              outputTypes: [outputTypeForAnalysisMode(mode)],
              userPresent: true
            })
          : undefined;
        if (mode === "redacted") {
          const result = await analyzeRecordRedactedWithGrant(apiConfig, {
            grantId: receipt.grantId,
            invocationToken,
            recordId,
            maxChars: 500
          });
          safeOutput = summarizeDerivedOutput(result.output);
          return result.artifact;
        }
        if (mode === "vector") {
          const result = await createRecordVectorProfileWithGrant(apiConfig, {
            grantId: receipt.grantId,
            invocationToken,
            recordId,
            chunkSizeWords: 80
          });
          safeOutput = summarizeDerivedOutput(result.output);
          return result.artifact;
        }
        if (mode === "extract-text") {
          const result = await extractRecordTextRedactedWithGrant(apiConfig, {
            grantId: receipt.grantId,
            invocationToken,
            recordId,
            maxBytes: 200_000,
            maxChars: 20_000,
            useOcr: true
          });
          safeOutput = summarizeDerivedOutput(result.output);
          return result.artifact;
        }
        if (mode === "form") {
          const result = await analyzeRecordFormRedactedWithGrant(apiConfig, {
            grantId: receipt.grantId,
            invocationToken,
            recordId,
            maxFields: 100,
            useOcr: false
          });
          safeOutput = summarizeDerivedOutput(result.output);
          return result.artifact;
        }
        if (mode === "graphrag") {
          const result = await createRedactedGraphRAG(apiConfig, {
            grantId: receipt.grantId,
            invocationToken,
            recordIds: [recordId],
            maxBytesPerRecord: 200_000,
            maxCharsPerRecord: 20_000,
            useOcr: true
          });
          safeOutput = summarizeDerivedOutput(result.output);
          return result.artifact;
        }
        return analyzeRecordWithGrant(apiConfig, {
          grantId: receipt.grantId,
          invocationToken,
          recordId,
          maxChars: 200
        });
      })();
      setDerivedArtifactsByReceiptId((artifacts) => ({
        ...artifacts,
        [receipt.id]: artifact
      }));
      setDerivedOutputsByReceiptId((outputs) => ({
        ...outputs,
        [receipt.id]: safeOutput
      }));
      await refreshWalletAuditEvents();
    } catch (error) {
      console.warn("Recipient analysis unavailable", error);
      setDerivedArtifactsByReceiptId((artifacts) => ({
        ...artifacts,
        [receipt.id]: {
          id: `artifact-error-${receipt.id}`,
          sourceRecordIds: [recordId],
          artifactType: "unavailable",
          outputPolicy: "derived_only",
          encryptedPayloadRef: "analysis unavailable",
          createdAt: "Just now"
        }
      }));
      setDerivedOutputsByReceiptId((outputs) => ({
        ...outputs,
        [receipt.id]: ""
      }));
    } finally {
      setAnalyzingReceiptIds((receiptIds) => receiptIds.filter((id) => id !== actionId));
    }
  }

  async function viewReceipt(receipt: WalletGrantReceipt) {
    if (!receipt.recordId || receipt.status !== "active" || !receiptHasAbility(receipt, "record/decrypt")) return;
    const recordId = receipt.recordId;
    setDecryptingReceiptIds((receiptIds) => [...receiptIds, receipt.id]);
    try {
      const decrypted =
        apiConfig?.actorDid
          ? await (async () => {
              let invocationToken: string | undefined;
              if (apiConfig.audienceKeyHex || apiConfig.issuerKeyHex) {
                try {
                  invocationToken = await issueRecordDecryptInvocation(apiConfig, {
                    grantId: receipt.grantId,
                    recordId,
                    userPresent: receiptRequiresUserPresence(receipt)
                  });
                } catch {
                  invocationToken = undefined;
                }
              }
              return decryptRecordWithGrant(apiConfig, {
                grantId: invocationToken ? undefined : receipt.grantId,
                invocationToken,
                recordId
              });
            })()
          : {
              recordId,
              text: "Local demo decrypted document preview.",
              sizeBytes: "Local demo decrypted document preview.".length
            };
      setDecryptedRecordsByReceiptId({
        ...decryptedRecordsByReceiptId,
        [receipt.id]: decrypted
      });
      await refreshWalletAuditEvents();
    } catch {
      setDecryptedRecordsByReceiptId({
        ...decryptedRecordsByReceiptId,
        [receipt.id]: {
          recordId,
          text: "Document view unavailable.",
          sizeBytes: 0
        }
      });
    } finally {
      setDecryptingReceiptIds((receiptIds) => receiptIds.filter((id) => id !== receipt.id));
    }
  }

  async function delegateReceipt(event: FormEvent<HTMLFormElement>, receipt: WalletGrantReceipt) {
    event.preventDefault();
    const abilityOptions = delegationAbilityOptions(receipt);
    const draft = delegationDraftFor(receipt, abilityOptions);
    if (!apiConfig?.actorDid || !draft.audienceDid.trim() || !canDelegateReceipt(receipt, abilityOptions)) return;
    setDelegatingReceiptIds((receiptIds) => [...receiptIds, receipt.id]);
    setDelegationMessages((messages) => ({ ...messages, [receipt.id]: "" }));
    try {
      await delegateGrant(apiConfig, {
        parentGrantId: receipt.grantId,
        audienceDid: draft.audienceDid.trim(),
        audienceKeyHex: draft.audienceKeyHex.trim() || undefined,
        resources: receipt.resources,
        abilities: [draft.ability],
        purpose: draft.purpose.trim() || receipt.purpose
      });
      setDelegationDrafts({
        ...delegationDrafts,
        [receipt.id]: {
          audienceDid: "",
          audienceKeyHex: "",
          purpose: receipt.purpose,
          ability: abilityOptions[0] ?? "record/analyze"
        }
      });
      setDelegationMessages((messages) => ({
        ...messages,
        [receipt.id]: `Delegated to ${draft.audienceDid.trim()}.`
      }));
      await refreshWalletAccessState();
      await refreshWalletAuditEvents();
    } catch {
      setDelegationMessages((messages) => ({
        ...messages,
        [receipt.id]: "Delegation failed."
      }));
    } finally {
      setDelegatingReceiptIds((receiptIds) => receiptIds.filter((id) => id !== receipt.id));
    }
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Secure access</p>
        <h1>Requests to see my info</h1>
      </div>
      <Section title="Check who wants to see info">
        <div className="list-stack">
          {accessRequests.map((request) => {
            const isRevoked = request.status === "approved" && request.grantStatus === "revoked";
            const statusLabel = isRevoked ? "revoked" : request.status;
            const statusTone = isRevoked
              ? "warning"
              : request.status === "approved"
                ? "success"
                : request.status === "rejected"
                  ? "warning"
                  : "neutral";

            return (
              <article className={`list-item access-request-item${isRevoked ? " access-request-revoked" : ""}`} key={request.id}>
                <div>
                  <div className="scope-header">
                    <div>
                      <h3>{request.requesterName}</h3>
                      <p>{request.resourceLabel} · {request.purpose}</p>
                    </div>
                    <Badge tone={statusTone}>{statusLabel}</Badge>
                  </div>
                  <div className="badge-row">
                    {request.abilities.map((ability) => (
                      <Badge key={ability}>{plainCapabilityLabel(ability)}</Badge>
                    ))}
                    <Badge>{request.createdAt}</Badge>
                    {request.approvalRequired ? (
                      <Badge tone={hasThresholdApproval(request) ? "success" : "warning"}>
                        {request.approvalCount ?? 0}/{request.approvalThreshold ?? 1} approvals
                      </Badge>
                    ) : null}
                    {request.status === "approved" && request.grantStatus !== "revoked" ? (
                      <Badge tone="success">active grant</Badge>
                    ) : null}
                  </div>
                  {isRevoked ? (
                    <p className="revoked-note">
                      Access was turned off. This person cannot open or review this file now.
                    </p>
                  ) : null}
                  {request.approvalRequired && !hasThresholdApproval(request) ? (
                    <p className="approval-note">Another approval is needed before this can be shared.</p>
                  ) : null}
                  <div
                    className="capability-preview"
                    role="group"
                    aria-label={`${request.requesterName} access capability preview`}
                  >
                    <div className="scope-header">
                      <div>
                        <h4>What this allows</h4>
                        <p>{request.resourceLabel} · {request.purpose}</p>
                      </div>
                      <Badge tone={hasThresholdApproval(request) ? "success" : "warning"}>
                        {hasThresholdApproval(request) ? "approval ready" : "approval pending"}
                      </Badge>
                    </div>
                    <div className="disclosure-package">
                      <div className="disclosure-row">
                        <strong>Can do</strong>
                        <span>{plainCapabilitySummary(request.abilities)}</span>
                      </div>
                      <div className="disclosure-row">
                        <strong>Recipient code</strong>
                        <span>{request.audienceDid}</span>
                      </div>
                      <div className="disclosure-row">
                        <strong>Not allowed</strong>
                        <span>{plainNonGrantedCapabilities(request.abilities).join(", ")}</span>
                      </div>
                    </div>
                  </div>
                  <small>{request.requesterDid}</small>
                </div>
                {request.status === "pending" ? (
                  <div className="row-actions">
                    {request.approvalRequired && !hasThresholdApproval(request) ? (
                      <Button onClick={() => recordControllerApproval(request.id)} variant="secondary">
                        <ShieldCheck size={18} /> Record approval
                      </Button>
                    ) : null}
                    <Button
                      disabled={!hasThresholdApproval(request)}
                      onClick={() => decideRequest(request.id, "approved")}
                      variant="secondary"
                    >
                      <ShieldCheck size={18} /> Approve
                    </Button>
                    <Button onClick={() => decideRequest(request.id, "rejected")} variant="danger">
                      Reject
                    </Button>
                  </div>
                ) : request.status === "approved" && request.grantStatus !== "revoked" ? (
                  <div className="row-actions">
                    <Button onClick={() => revokeRequest(request.id)} variant="danger">
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </Section>
      <Section title="Sharing history">
        <div className="list-stack">
          {grantReceipts.map((receipt) => {
            const canAnalyze =
              receipt.status === "active" && receiptHasAbility(receipt, "record/analyze") && Boolean(receipt.recordId);
            const canAnalyzeRedacted = canAnalyze && receiptAllowsOutput(receipt, "redacted_derived_only");
            const canCreateVectorProfile = canAnalyze && receiptAllowsOutput(receipt, "vector_profile");
            const canExtractText = canAnalyze && receiptAllowsOutput(receipt, "redacted_extracted_text");
            const canAnalyzeForm = canAnalyze && receiptAllowsOutput(receipt, "redacted_form_analysis");
            const canCreateGraphRAG = canAnalyze && receiptAllowsOutput(receipt, "redacted_graphrag");
            const canView =
              receipt.status === "active" && receiptHasAbility(receipt, "record/decrypt") && Boolean(receipt.recordId);
            const artifact = derivedArtifactsByReceiptId[receipt.id];
            const safeOutput = derivedOutputsByReceiptId[receipt.id];
            const decryptedRecord = decryptedRecordsByReceiptId[receipt.id];
            const delegationOptions = delegationAbilityOptions(receipt);
            const canDelegate = canDelegateReceipt(receipt, delegationOptions);
            const delegationDraft = delegationDraftFor(receipt, delegationOptions);
            const delegationMessage = delegationMessages[receipt.id];
            return (
            <article
                aria-labelledby={`grant-receipt-${receipt.id}`}
                className={`grant-receipt-card${receipt.status === "revoked" ? " grant-receipt-revoked" : ""}`}
                key={receipt.id}
              >
              <div className="scope-header">
                <div>
                  <h3 id={`grant-receipt-${receipt.id}`}>{receipt.audienceName}</h3>
                  <p>{receipt.resourceLabel} · {receipt.purpose}</p>
                </div>
                <Badge tone={receipt.status === "active" ? "success" : "warning"}>{receipt.status}</Badge>
              </div>
              <div className="badge-row">
                {receipt.abilities.map((ability) => (
                  <Badge key={ability}>{plainCapabilityLabel(ability)}</Badge>
                ))}
                <Badge>{receipt.createdAt}</Badge>
                {receipt.expiresAt ? <Badge>expires {receipt.expiresAt}</Badge> : null}
              </div>
              <div className="receipt-hash-row">
                <span>Share proof code</span>
                <code>{receipt.receiptHash}</code>
              </div>
              <div
                className="capability-preview"
                role="group"
                aria-label={`${receipt.audienceName} receipt capability preview`}
              >
                <div className="scope-header">
                  <div>
                    <h4>What this allows</h4>
                    <p>{receipt.resourceLabel} · {receipt.purpose}</p>
                  </div>
                  <Badge tone={receipt.status === "active" ? "success" : "warning"}>
                    {receipt.status === "active" ? "currently active" : "revoked"}
                  </Badge>
                </div>
                <div className="disclosure-package">
                  <div className="disclosure-row">
                    <strong>Can do</strong>
                    <span>{plainCapabilitySummary(receipt.abilities)}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Recipient code</strong>
                    <span>{receipt.audienceDid}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Not allowed</strong>
                    <span>{plainNonGrantedCapabilities(receipt.abilities).join(", ")}</span>
                  </div>
                </div>
              </div>
              {artifact ? (
                <div className="disclosure-package">
                  <div className="disclosure-row">
                    <strong>Safe summary</strong>
                    <span>{artifact.artifactType} · {artifact.outputPolicy}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Locked result</strong>
                    <span>{artifact.encryptedPayloadRef}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Files used</strong>
                    <span>{artifact.sourceRecordIds.join(", ") || "No source records"}</span>
                  </div>
                  {safeOutput ? (
                    <div className="disclosure-row">
                      <strong>Safe output</strong>
                      <span>{safeOutput}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {decryptedRecord ? (
                <div className="disclosure-package">
                  <div className="disclosure-row">
                    <strong>Document view</strong>
                    <span className="document-preview-text">{decryptedRecord.text}</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Plaintext size</strong>
                    <span>{decryptedRecord.sizeBytes} bytes</span>
                  </div>
                </div>
              ) : null}
              {canAnalyze ||
              canAnalyzeRedacted ||
              canCreateVectorProfile ||
              canExtractText ||
              canAnalyzeForm ||
              canCreateGraphRAG ||
              canView ? (
                <div className="row-actions">
                  {canAnalyze ? (
                    <Button
                      disabled={analyzingReceiptIds.includes(analysisActionId(receipt, "summary"))}
                      onClick={() => analyzeReceipt(receipt, "summary")}
                      variant="secondary"
                    >
                      <ShieldCheck size={18} />
                      {analyzingReceiptIds.includes(analysisActionId(receipt, "summary"))
                        ? "Making summary"
                        : "Make safe summary"}
                    </Button>
                  ) : null}
                  {canAnalyzeRedacted ? (
                    <Button
                      disabled={analyzingReceiptIds.includes(analysisActionId(receipt, "redacted"))}
                      onClick={() => analyzeReceipt(receipt, "redacted")}
                      variant="secondary"
                    >
                      <ShieldCheck size={18} />
                      {analyzingReceiptIds.includes(analysisActionId(receipt, "redacted"))
                        ? "Redacting"
                        : "Redacted analysis"}
                    </Button>
                  ) : null}
                  {canCreateVectorProfile ? (
                    <Button
                      disabled={analyzingReceiptIds.includes(analysisActionId(receipt, "vector"))}
                      onClick={() => analyzeReceipt(receipt, "vector")}
                      variant="secondary"
                    >
                      <ShieldCheck size={18} />
                      {analyzingReceiptIds.includes(analysisActionId(receipt, "vector"))
                        ? "Profiling"
                        : "Vector profile"}
                    </Button>
                  ) : null}
                  {canExtractText ? (
                    <Button
                      disabled={analyzingReceiptIds.includes(analysisActionId(receipt, "extract-text"))}
                      onClick={() => analyzeReceipt(receipt, "extract-text")}
                      variant="secondary"
                    >
                      <ShieldCheck size={18} />
                      {analyzingReceiptIds.includes(analysisActionId(receipt, "extract-text"))
                        ? "Extracting"
                        : "Extract text"}
                    </Button>
                  ) : null}
                  {canAnalyzeForm ? (
                    <Button
                      disabled={analyzingReceiptIds.includes(analysisActionId(receipt, "form"))}
                      onClick={() => analyzeReceipt(receipt, "form")}
                      variant="secondary"
                    >
                      <ShieldCheck size={18} />
                      {analyzingReceiptIds.includes(analysisActionId(receipt, "form"))
                        ? "Reading form"
                        : "Analyze form"}
                    </Button>
                  ) : null}
                  {canCreateGraphRAG ? (
                    <Button
                      disabled={analyzingReceiptIds.includes(analysisActionId(receipt, "graphrag"))}
                      onClick={() => analyzeReceipt(receipt, "graphrag")}
                      variant="secondary"
                    >
                      <ShieldCheck size={18} />
                      {analyzingReceiptIds.includes(analysisActionId(receipt, "graphrag"))
                        ? "Building graph"
                        : "Build GraphRAG"}
                    </Button>
                  ) : null}
                  {canView ? (
                    <Button
                      disabled={decryptingReceiptIds.includes(receipt.id)}
                      onClick={() => viewReceipt(receipt)}
                      variant="secondary"
                    >
                      <LockKeyhole size={18} />
                      {decryptingReceiptIds.includes(receipt.id) ? "Opening" : "View document"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {canDelegate ? (
                <form className="delegation-form" onSubmit={(event) => delegateReceipt(event, receipt)}>
                  <div className="form-grid">
                    <Field label="Delegate DID">
                      <input
                        onChange={(event) =>
                          updateDelegationDraft(receipt, delegationOptions, { audienceDid: event.target.value })
                        }
                        placeholder="did:key:case-worker"
                        value={delegationDraft.audienceDid}
                      />
                    </Field>
                    <Field label="Delegate key">
                      <input
                        onChange={(event) =>
                          updateDelegationDraft(receipt, delegationOptions, { audienceKeyHex: event.target.value })
                        }
                        placeholder="optional public key"
                        value={delegationDraft.audienceKeyHex}
                      />
                    </Field>
                    <Field label="Delegated purpose">
                      <input
                        onChange={(event) =>
                          updateDelegationDraft(receipt, delegationOptions, { purpose: event.target.value })
                        }
                        value={delegationDraft.purpose}
                      />
                    </Field>
                    <Field label="Delegated ability">
                      <select
                        onChange={(event) =>
                          updateDelegationDraft(receipt, delegationOptions, { ability: event.target.value })
                        }
                        value={delegationDraft.ability}
                      >
                        {delegationOptions.map((ability) => (
                          <option key={ability} value={ability}>
                            {plainCapabilityLabel(ability)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="row-actions">
                    <Button
                      disabled={!delegationDraft.audienceDid.trim()}
                      loading={delegatingReceiptIds.includes(receipt.id)}
                      loadingLabel="Delegating"
                      type="submit"
                      variant="secondary"
                    >
                      <ShieldCheck size={18} /> Delegate access
                    </Button>
                  </div>
                </form>
              ) : null}
              {delegationMessage ? (
                <p className="delegation-message" role="status">
                  {delegationMessage}
                </p>
              ) : null}
              <small>{receipt.audienceDid}</small>
            </article>
            );
          })}
        </div>
      </Section>
      {!verified ? (
        <Section title="Check this person">
          <StatusBanner tone="warning">We hide private information until this person is checked.</StatusBanner>
          <div className="form-grid">
            <Field label="Access code">
              <input placeholder="Enter code" />
            </Field>
            <Field label="Recipient phone or email">
              <input placeholder="Confirm contact method" />
            </Field>
          </div>
          <Button onClick={() => setVerified(true)}>
            <KeyRound size={18} /> Verify and view
          </Button>
        </Section>
      ) : (
        <Section title={`Shared with ${recipient.displayName}`}>
          <div className="disclosure-package">
            {recipient.allowedScopes.map((scope) => (
              <div className="disclosure-row" key={scope}>
                <strong>{disclosureScopes.find((item) => item.id === scope)?.label ?? scope}</strong>
                <span>Available in this emergency package</span>
              </div>
            ))}
          </div>
          <Button variant="secondary">Contact support</Button>
        </Section>
      )}
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
        <h1>Benefits notice</h1>
      </div>
      <StatusBanner tone="warning">
        Abby can ask approved agencies for help. This does not promise benefits.
      </StatusBanner>
      <Section title="Benefits choice">
        <div
          className="capability-preview"
          role="group"
          aria-label="Benefits notification capability preview"
        >
          <div className="scope-header">
            <div>
              <h4>What this allows</h4>
              <p>benefits status and notice details only</p>
            </div>
            <Badge tone={optedIn ? "success" : "neutral"}>{optedIn ? "ready to save" : "off"}</Badge>
          </div>
          <div className="disclosure-package">
            <div className="disclosure-row">
              <strong>Can do</strong>
              <span>{plainCapabilitySummary(["metadata/read", "derived/read"])}</span>
            </div>
            <div className="disclosure-row">
              <strong>Items</strong>
              <span>Benefits information, Notice request</span>
            </div>
            <div className="disclosure-row">
              <strong>Not allowed</strong>
              <span>{plainNonGrantedCapabilities(["metadata/read", "derived/read"]).join(", ")}</span>
            </div>
          </div>
        </div>
        <label className="consent-box">
          <input checked={optedIn} onChange={(event) => setOptedIn(event.target.checked)} type="checkbox" />
          <span>
            <strong>Allow Abby to prepare a benefits notice for agency help.</strong>
            <small>This starts on. You can turn it off. A privacy and legal team must review this before real use.</small>
          </span>
        </label>
        <Button>
          <Landmark size={18} /> Save setting
        </Button>
      </Section>
    </div>
  );
}

function AnalyticsScreen({
  optedIn,
  setOptedIn
}: {
  optedIn: Record<string, boolean>;
  setOptedIn: (value: Record<string, boolean>) => void;
}) {
  function toggleStudy(studyId: string) {
    setOptedIn({ ...optedIn, [studyId]: !isStudySelected(studyId) });
  }

  function isStudySelected(studyId: string) {
    return optedIn[studyId] ?? true;
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Group facts choice</p>
        <h1>Share group facts, not your name</h1>
      </div>
      <StatusBanner tone="info">
        These choices start on. You can turn off any one. We use group facts, not names or contact details.
      </StatusBanner>
      <StatusBanner tone="warning">
        A privacy and legal team must review this before real use.
      </StatusBanner>
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
  setProofs
}: {
  apiConfig?: WalletApiConfig;
  proofs: ProofReceiptView[];
  refreshWalletAuditEvents: () => Promise<void>;
  setProofs: (proofs: ProofReceiptView[]) => void;
}) {
  const [locationRecordId, setLocationRecordId] = useState(
    (import.meta.env.VITE_DEMO_LOCATION_RECORD_ID as string | undefined) ?? "rec-location-current"
  );
  const [regionId, setRegionId] = useState("multnomah_county");
  const [grantId, setGrantId] = useState("");
  const [proofStatus, setProofStatus] = useState<"idle" | "creating" | "created" | "failed">("idle");

  async function createProof(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiConfig?.actorDid || !locationRecordId.trim() || !regionId.trim()) {
      setProofStatus("failed");
      return;
    }
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
    } catch {
      setProofStatus("failed");
    }
  }

  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Proof center</p>
        <h1>Verified wallet claims</h1>
      </div>
      <StatusBanner tone="info">
        Proof receipts expose public claims and verifier details without showing raw documents or precise location.
      </StatusBanner>
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
            <StatusBanner tone="warning">Proof creation failed. Check the record ID, grant, and API proof mode.</StatusBanner>
          ) : null}
          <Button disabled={!apiConfig?.actorDid || proofStatus === "creating"} type="submit" variant="secondary">
            {proofStatus === "creating" ? "Creating proof..." : "Create proof"}
          </Button>
        </form>
      </article>
      <div className="list-stack">
        {proofs.map((proof) => {
          const titleId = `proof-title-${proof.id}`;

          return (
            <article aria-labelledby={titleId} className="proof-card" key={proof.id}>
              <div className="scope-header">
                <div>
                  <h3 id={titleId}>{proof.claim}</h3>
                  <p>
                    {proof.proofType} · {proof.proofSystem} · {proof.verifier}
                  </p>
                </div>
                <Badge tone={proof.simulated ? "warning" : "success"}>
                  {proof.simulated ? "Simulated" : proof.verificationStatus}
                </Badge>
              </div>
              <div className="badge-row">
                <Badge>{proof.createdAt}</Badge>
                <Badge>{proof.witnessLabel}</Badge>
              </div>
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
                  <Badge tone={proof.simulated ? "warning" : "success"}>
                    {proof.simulated ? "development proof" : "verified proof"}
                  </Badge>
                </div>
                <div className="disclosure-package">
                  <div className="disclosure-row">
                    <strong>Ability</strong>
                    <span>proof/verify</span>
                  </div>
                  <div className="disclosure-row">
                    <strong>Verification</strong>
                    <span>{proof.verificationStatus}</span>
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
  setBundles
}: {
  apiConfig?: WalletApiConfig;
  bundles: ExportBundleView[];
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
      <StatusBanner tone="info">
        Export bundles carry encrypted records, receipt hashes, and storage reports. Importing a bundle does not reveal plaintext.
      </StatusBanner>
      {!apiConfig ? (
        <StatusBanner tone="warning">Connect Abby before you make live export bundles.</StatusBanner>
      ) : null}
      {exportStatus === "created" ? <StatusBanner tone="success">Export bundle verified.</StatusBanner> : null}
      {exportStatus === "failed" ? <StatusBanner tone="warning">Export bundle creation failed.</StatusBanner> : null}
      {importStatus === "imported" ? <StatusBanner tone="success">Export descriptors imported.</StatusBanner> : null}
      {importStatus === "failed" ? <StatusBanner tone="warning">Export import failed.</StatusBanner> : null}
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

function SecurityScreen({
  apiConfig,
  onSnapshotLoaded
}: {
  apiConfig?: WalletApiConfig;
  onSnapshotLoaded: () => Promise<void> | void;
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
    </div>
  );
}

function AuditScreen({ events }: { events: AuditEvent[] }) {
  return (
    <div className="screen">
      <div className="page-title">
        <p className="eyebrow">Audit</p>
        <h1>Consent and access history</h1>
      </div>
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
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
