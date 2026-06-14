import type {
  DisclosureDataScope,
  DisclosureRecipientDraft,
  EasyBotCheckStatus,
  RegistrationProfileDraft,
  ProofReceiptView,
  RouteId,
  SavedService,
  ServiceInteractionEvent,
  ServicePlan,
  ShelterContactRequest,
  UploadItem
} from "../models/abby";
import {
  defaultCheckInPolicy,
  emptyRegistrationProfile,
  initialRecipients,
  initialShelterContactRequests,
  initialUploads
} from "../services/mockAbbyService";

export const APP_PERSIST_KEY = "abby-ui-state-v1";

export const primaryRoutes: Array<{ id: RouteId; label: string }> = [
  { id: "home", label: "Home" },
  { id: "register", label: "Register" },
  { id: "check-in", label: "Check in" },
  { id: "calendar", label: "Calendar" },
  { id: "messages", label: "Messages" },
  { id: "contacts", label: "Contacts" },
  { id: "sharing-rules", label: "Sharing" },
  { id: "social-services", label: "Services" },
  { id: "interactions", label: "Interactions" },
  { id: "uploads", label: "Wallet" },
  { id: "settings", label: "Settings" },
  { id: "shelter", label: "Overview" },
  { id: "provider-clients", label: "Clients served" },
  { id: "provider-cases", label: "Case management" },
  { id: "provider-messages", label: "Client messages" },
  { id: "provider-analytics", label: "Staff analytics" },
  { id: "provider-proofs", label: "ZK certificates" },
  { id: "provider-operations", label: "Staff operations" }
];

export const secondaryRoutes: Array<{ id: RouteId; label: string }> = [
  { id: "recipient-access", label: "Who can see info" },
  { id: "benefits-protection", label: "Benefits" },
  { id: "analytics", label: "Analytics" },
  { id: "proof-center", label: "Proofs" },
  { id: "exports", label: "Exports" },
  { id: "security", label: "Security" }
];

export const appRoutes = [...primaryRoutes, ...secondaryRoutes];
export const appRouteIds: RouteId[] = [...appRoutes.map((route) => route.id), "audit"];

export const serviceNeeds = ["Shelter", "Food", "Health", "Legal", "Benefits", "Transportation"];

export const shelterOptions = [
  "Rose City Shelter",
  "Downtown Outreach Shelter",
  "Harbor Night Shelter",
  "Northside Family Shelter"
];

export type ShelterStaffAccount = {
  id: string;
  shelter: string;
  displayName: string;
  email: string;
  verified: boolean;
  updatedAt: string;
};

export const initialShelterStaffAccounts: ShelterStaffAccount[] = [
  {
    id: "staff-demo-downtown",
    shelter: "Downtown Outreach Shelter",
    displayName: "Jordan Lee",
    email: "jordan@downtown.example",
    verified: true,
    updatedAt: "Today, 8:30 AM"
  },
  {
    id: "staff-demo-rose",
    shelter: "Rose City Shelter",
    displayName: "Avery Patel",
    email: "avery@rose.example",
    verified: true,
    updatedAt: "Today, 8:35 AM"
  },
  {
    id: "staff-demo-harbor",
    shelter: "Harbor Night Shelter",
    displayName: "Riley Chen",
    email: "riley@harbor.example",
    verified: true,
    updatedAt: "Today, 8:40 AM"
  }
];

export type ShelterUserAccount = {
  id: string;
  shelter: string;
  legalName: string;
  preferredName: string;
  pronouns: string;
  dateOfBirth: string;
  photoAssetId: string;
  phone: string;
  email: string;
  currentLocation: string;
  preferredShelter: string;
  serviceNeeds: string[];
  easyBotCheckStatus: EasyBotCheckStatus;
  captchaToken: string;
  localPrecinctNotified: boolean;
  foundPermanentHousing: boolean;
  createdByStaffId: string;
  createdAt: string;
};

export type ShelterProviderMessage = {
  id: string;
  shelter: string;
  clientId: string;
  clientName: string;
  clientContact: string;
  channel: "sms" | "email" | "in_app";
  subject: string;
  body: string;
  staffId: string;
  staffName: string;
  status: "sent" | "queued";
  clientReadAt?: string;
  clientArchivedAt?: string;
  createdAt: string;
};

export type ShelterCaseStatus = "intake" | "active" | "waiting_on_client" | "eligible" | "closed";
export type ShelterCasePriority = "urgent" | "standard" | "monitor";
export type ShelterEligibilityCriterion =
  | "us_citizen"
  | "service_area_resident"
  | "income_eligible"
  | "identity_verified";

export type ShelterCaseRecord = {
  id: string;
  shelter: string;
  clientId: string;
  caseManagerStaffId: string;
  status: ShelterCaseStatus;
  priority: ShelterCasePriority;
  goal: string;
  nextStep: string;
  dueDate: string;
  services: string[];
  notes: string;
  eligibilityCriteria: ShelterEligibilityCriterion[];
  createdAt: string;
  updatedAt: string;
};

export const providerEligibilityCriteria: Array<{
  id: ShelterEligibilityCriterion;
  label: string;
  certificateType: string;
  claim: string;
}> = [
  {
    id: "us_citizen",
    label: "US citizen",
    certificateType: "us_citizenship",
    claim: "Client meets US citizenship criteria without exposing source identity documents."
  },
  {
    id: "service_area_resident",
    label: "Service-area resident",
    certificateType: "service_area_residency",
    claim: "Client meets service-area residency criteria without exposing exact address."
  },
  {
    id: "income_eligible",
    label: "Income eligible",
    certificateType: "income_eligibility",
    claim: "Client meets income eligibility criteria without exposing income documents."
  },
  {
    id: "identity_verified",
    label: "Identity verified",
    certificateType: "identity_verified",
    claim: "Client identity has been verified without exposing the underlying identity document."
  }
];

export const initialShelterUserAccounts: ShelterUserAccount[] = [
  {
    id: "user-demo-rose-abby",
    shelter: "Rose City Shelter",
    legalName: "Abby Example",
    preferredName: "Abby",
    pronouns: "they/them",
    dateOfBirth: "1990-01-01",
    photoAssetId: "abby-id.pdf",
    phone: "(503) 555-0100",
    email: "abby@example.org",
    currentLocation: "Rose City day room",
    preferredShelter: "Rose City Shelter",
    serviceNeeds: ["Shelter", "Benefits", "Health"],
    easyBotCheckStatus: "passed",
    captchaToken: "demo-check",
    localPrecinctNotified: true,
    foundPermanentHousing: false,
    createdByStaffId: "staff-demo-rose",
    createdAt: "2026-05-05T16:30:00.000Z"
  },
  {
    id: "user-demo-rose-casey",
    shelter: "Rose City Shelter",
    legalName: "Casey Rivera",
    preferredName: "Casey",
    pronouns: "she/her",
    dateOfBirth: "1986-03-14",
    photoAssetId: "casey-id.pdf",
    phone: "(503) 555-0188",
    email: "casey@example.org",
    currentLocation: "Rose City dorm B",
    preferredShelter: "Rose City Shelter",
    serviceNeeds: ["Food", "Transportation"],
    easyBotCheckStatus: "passed",
    captchaToken: "demo-check",
    localPrecinctNotified: false,
    foundPermanentHousing: true,
    createdByStaffId: "staff-demo-rose",
    createdAt: "2026-05-06T18:10:00.000Z"
  },
  {
    id: "user-demo-downtown-morgan",
    shelter: "Downtown Outreach Shelter",
    legalName: "Morgan Lee",
    preferredName: "Morgan",
    pronouns: "he/him",
    dateOfBirth: "1978-08-22",
    photoAssetId: "morgan-id.pdf",
    phone: "(503) 555-0144",
    email: "morgan@example.org",
    currentLocation: "Downtown outreach office",
    preferredShelter: "Downtown Outreach Shelter",
    serviceNeeds: ["Legal", "Benefits"],
    easyBotCheckStatus: "failed",
    captchaToken: "",
    localPrecinctNotified: true,
    foundPermanentHousing: false,
    createdByStaffId: "staff-demo-downtown",
    createdAt: "2026-05-04T14:05:00.000Z"
  }
];

export const initialShelterCaseRecords: ShelterCaseRecord[] = [
  {
    id: "case-demo-rose-abby",
    shelter: "Rose City Shelter",
    clientId: "user-demo-rose-abby",
    caseManagerStaffId: "staff-demo-rose",
    status: "active",
    priority: "urgent",
    goal: "Complete benefits referral and confirm shelter placement.",
    nextStep: "Verify citizenship eligibility for benefits intake.",
    dueDate: "2026-05-12",
    services: ["Shelter", "Benefits", "Health"],
    notes: "Needs a privacy-preserving eligibility proof before referral packet is shared.",
    eligibilityCriteria: ["us_citizen", "identity_verified"],
    createdAt: "2026-05-05T17:10:00.000Z",
    updatedAt: "2026-05-07T17:45:00.000Z"
  },
  {
    id: "case-demo-rose-casey",
    shelter: "Rose City Shelter",
    clientId: "user-demo-rose-casey",
    caseManagerStaffId: "staff-demo-rose",
    status: "eligible",
    priority: "monitor",
    goal: "Close transportation support after stable housing placement.",
    nextStep: "Confirm final ride voucher was used.",
    dueDate: "2026-05-14",
    services: ["Food", "Transportation"],
    notes: "Housing found. Keep case open until transportation handoff is complete.",
    eligibilityCriteria: ["service_area_resident"],
    createdAt: "2026-05-06T18:45:00.000Z",
    updatedAt: "2026-05-07T19:05:00.000Z"
  },
  {
    id: "case-demo-downtown-morgan",
    shelter: "Downtown Outreach Shelter",
    clientId: "user-demo-downtown-morgan",
    caseManagerStaffId: "staff-demo-downtown",
    status: "waiting_on_client",
    priority: "standard",
    goal: "Prepare legal-aid and benefits documentation.",
    nextStep: "Wait for client to approve contact-list sharing.",
    dueDate: "2026-05-15",
    services: ["Legal", "Benefits"],
    notes: "Bot check failed; complete assisted verification before sending documents.",
    eligibilityCriteria: ["identity_verified", "income_eligible"],
    createdAt: "2026-05-04T15:15:00.000Z",
    updatedAt: "2026-05-06T20:20:00.000Z"
  }
];

export const initialShelterProviderMessages: ShelterProviderMessage[] = [
  {
    id: "provider-message-demo-rose-abby",
    shelter: "Rose City Shelter",
    clientId: "user-demo-rose-abby",
    clientName: "Abby",
    clientContact: "(503) 555-0100 / abby@example.org",
    channel: "in_app",
    subject: "Intake appointment reminder",
    body: "Your Rose City Shelter intake appointment is on your Abby calendar. Please bring your ID if you have it.",
    staffId: "staff-demo-rose",
    staffName: "Avery Patel",
    status: "sent",
    createdAt: "2026-05-07T17:45:00.000Z"
  },
  {
    id: "provider-message-demo-rose-casey",
    shelter: "Rose City Shelter",
    clientId: "user-demo-rose-casey",
    clientName: "Casey",
    clientContact: "(503) 555-0188 / casey@example.org",
    channel: "sms",
    subject: "Transportation voucher",
    body: "Your transportation voucher is ready at the front desk after 2 PM today.",
    staffId: "staff-demo-rose",
    staffName: "Avery Patel",
    status: "sent",
    createdAt: "2026-05-07T19:05:00.000Z"
  }
];

export const defaultManagedUserDraft = {
  legalName: "",
  preferredName: "",
  pronouns: "",
  dateOfBirth: "",
  photoAssetId: "",
  phone: "",
  email: "",
  currentLocation: "",
  preferredShelter: "",
  serviceNeeds: [] as string[],
  easyBotCheckStatus: "pending" as EasyBotCheckStatus,
  captchaToken: "",
  localPrecinctNotified: false,
  foundPermanentHousing: false
};

export const disclosureScopes: Array<{ id: DisclosureDataScope; label: string; detail: string }> = [
  { id: "identity_minimum", label: "Minimum identity", detail: "name, birthdate and contact status" },
  { id: "profile", label: "Profile", detail: "Basic profile details and help needs" },
  { id: "photo", label: "Photo or ID file", detail: "The setup file you chose, like an image or PDF" },
  { id: "current_location", label: "Current location", detail: "Most recent safe place or shelter" },
  { id: "uploaded_documents", label: "Wallet files", detail: "Files the person chooses to include" },
  { id: "missed_check_in", label: "Missed check-in", detail: "Whether a check-in was missed" },
  { id: "found_permanent_housing", label: "Found permanent housing", detail: "Whether stable housing was reported" },
  { id: "medical_notes", label: "Medical notes", detail: "Sensitive health notes" },
  { id: "shelter_history", label: "Shelter history", detail: "Shelter stays and staff contact details" },
  { id: "benefits_information", label: "Benefits information", detail: "Benefits status and IDs" },
  { id: "custom", label: "Custom note", detail: "A user-written emergency note" }
];

export const defaultShelterChecklist = {
  userPresent: false,
  clearBrowserData: false,
  auditLogConfirmed: false
};

export type PersistedAppState = {
  profile?: RegistrationProfileDraft;
  policy?: typeof defaultCheckInPolicy;
  recipients?: DisclosureRecipientDraft[];
  uploads?: UploadItem[];
  shelterContactRequests?: ShelterContactRequest[];
  shelterStaffAccounts?: ShelterStaffAccount[];
  shelterUserAccounts?: ShelterUserAccount[];
  shelterCaseRecords?: ShelterCaseRecord[];
  shelterProviderMessages?: ShelterProviderMessage[];
  savedServices?: SavedService[];
  servicePlans?: ServicePlan[];
  serviceInteractions?: ServiceInteractionEvent[];
  proofReceipts?: ProofReceiptView[];
  benefitsOptIn?: boolean;
  analyticsOptIn?: Record<string, boolean>;
  missingPersonDeadDropEnabled?: boolean;
  missingPersonDeadDropLastSentForCheckInAt?: string;
  shelterChecklist?: typeof defaultShelterChecklist;
};

export function readPersistedAppState(): PersistedAppState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(APP_PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PersistedAppState) : {};
  } catch {
    return {};
  }
}

export function writePersistedAppState(state: PersistedAppState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(APP_PERSIST_KEY, JSON.stringify(state));
}

export function isAppRouteId(value: unknown): value is RouteId {
  return typeof value === "string" && appRouteIds.includes(value as RouteId);
}

export function routeToHash(route: RouteId): string {
  if (route === "exports") return "#/uploads";
  if (route === "security") return "#/settings";
  return route === "home" ? "#/" : `#/${route}`;
}

export function getRouteFromHash(hash = typeof window === "undefined" ? "" : window.location.hash): RouteId {
  const route = hash.replace("#/", "") || "home";
  return isAppRouteId(route) ? route : "home";
}

export function setLocationRouteHash(route: RouteId): void {
  if (typeof window === "undefined") return;
  window.location.hash = routeToHash(route);
}

export function createDefaultAppState(persistedState: PersistedAppState = {}): Required<PersistedAppState> {
  return {
    profile: {
      ...emptyRegistrationProfile,
      ...persistedState.profile
    },
    policy: {
      ...defaultCheckInPolicy,
      ...persistedState.policy
    },
    recipients: Array.isArray(persistedState.recipients) ? persistedState.recipients : initialRecipients,
    uploads: Array.isArray(persistedState.uploads) ? persistedState.uploads : initialUploads,
    shelterContactRequests: Array.isArray(persistedState.shelterContactRequests)
      ? persistedState.shelterContactRequests
      : initialShelterContactRequests,
    shelterStaffAccounts: Array.isArray(persistedState.shelterStaffAccounts)
      ? persistedState.shelterStaffAccounts
      : initialShelterStaffAccounts,
    shelterUserAccounts: Array.isArray(persistedState.shelterUserAccounts)
      ? persistedState.shelterUserAccounts
      : initialShelterUserAccounts,
    shelterCaseRecords: Array.isArray(persistedState.shelterCaseRecords)
      ? persistedState.shelterCaseRecords
      : initialShelterCaseRecords,
    shelterProviderMessages: Array.isArray(persistedState.shelterProviderMessages)
      ? persistedState.shelterProviderMessages
      : initialShelterProviderMessages,
    savedServices: Array.isArray(persistedState.savedServices) ? persistedState.savedServices : [],
    servicePlans: Array.isArray(persistedState.servicePlans) ? persistedState.servicePlans : [],
    serviceInteractions: Array.isArray(persistedState.serviceInteractions) ? persistedState.serviceInteractions : [],
    proofReceipts: Array.isArray(persistedState.proofReceipts) ? persistedState.proofReceipts : [],
    benefitsOptIn: persistedState.benefitsOptIn ?? true,
    analyticsOptIn:
      persistedState.analyticsOptIn && typeof persistedState.analyticsOptIn === "object"
        ? persistedState.analyticsOptIn
        : {},
    missingPersonDeadDropEnabled: persistedState.missingPersonDeadDropEnabled ?? false,
    missingPersonDeadDropLastSentForCheckInAt: persistedState.missingPersonDeadDropLastSentForCheckInAt ?? "",
    shelterChecklist: {
      ...defaultShelterChecklist,
      ...persistedState.shelterChecklist
    }
  };
}
