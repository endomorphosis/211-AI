import type {
  AuditEvent,
  AnalyticsStudy,
  CheckInPolicyDraft,
  DisclosureRecipientDraft,
  ExportBundleView,
  ProofReceiptView,
  RegistrationProfileDraft,
  RouteId,
  SavedService,
  ServiceInteractionEvent,
  ServicePlan,
  ShelterContactRequest,
  UploadItem,
  WalletAccessRequest,
  WalletGrantReceipt
} from "../models/abby";
import type { ShelterStaffAccount, ShelterUserAccount } from "./appState";
import { type WalletApiConfig } from "../services/walletApi";
import {
  answerServiceNavigationQuestion,
  searchServiceNavigation,
} from "../agent/serviceNavigationAgent";
import { navigateAction, readSurfaceContextAction } from "../agent/tools/navigationTools";
import { openServiceDetailAction } from "../agent/tools/serviceDetailTools";
import { updateRegistrationDraftAction } from "../agent/tools/registrationTools";
import { updateCheckInPolicyAction } from "../agent/tools/checkInTools";
import {
  addRecipientAction,
  editRecipientAction,
  removeRecipientAction
} from "../agent/tools/contactTools";
import {
  addShelterAsRecipientAction,
  approveShelterContactRequestAction,
  approveUserShelterRequestAction,
  createManagedUserAccountAction,
  createShelterStaffAccountAction,
  denyShelterContactRequestAction,
  denyUserShelterRequestAction,
  requestShelterContactAction,
  sendShelterNudgeAction
} from "../agent/tools/shelterTools";
import {
  previewSharingCapabilitiesAction,
  setDisclosureScopesAction,
  updateRecipientScopesAction
} from "../agent/tools/sharingRuleTools";
import {
  analyzeGrantedRecordAction,
  decideAccessRequestAction,
  delegateGrantAction,
  recordControllerApprovalAction,
  revokeAccessRequestAction,
  viewGrantedRecordAction
} from "../agent/tools/recipientAccessTools";
import {
  createLocationRegionProofAction,
  createProofAction,
  explainProofReceiptAction,
  verifyProofStatusAction
} from "../agent/tools/proofTools";
import {
  createVerifiedExportBundleAction,
  importExportBundleAction
} from "../agent/tools/exportTools";
import {
  explainAnalyticsPrivacyBudgetAction,
  selectAnalyticsStudyAction,
  submitAnalyticsConsentAction,
  unselectAnalyticsStudyAction
} from "../agent/tools/analyticsTools";
import {
  refreshWalletAuditAction,
  restoreWalletSnapshotAction,
  saveWalletSnapshotAction
} from "../agent/tools/securityTools";
import {
  explainAuditEventAction,
  searchAuditEventsAction,
  summarizeAuditEventsAction
} from "../agent/tools/auditTools";
import {
  classifyUploadedDocumentAction,
  repairUploadStorageAction,
  summarizeUploadRequirementsAction,
  toggleUploadSharedAction
} from "../agent/tools/uploadTools";
import {
  addServicePlanChecklistItemAction,
  createServicePlanAction,
  recordServiceInteractionAction,
  saveServiceAction,
  setServicePlanReminderAction
} from "../agent/tools/servicePlanTools";
import type {
  AccessRequestDecisionCommandInput,
  AddServicePlanChecklistItemCommandInput,
  AddRecipientCommandInput,
  AddShelterAsRecipientCommandInput,
  AgentCommandName,
  AnalyticsStudyReferenceCommandInput,
  AnalyzeGrantedRecordCommandInput,
  AuditEventReferenceCommandInput,
  Answer211QuestionCommandInput,
  ClassifyUploadedDocumentCommandInput,
  CreateLocationRegionProofCommandInput,
  CreateProofCommandInput,
  CreateManagedUserAccountCommandInput,
  CreateServicePlanCommandInput,
  CreateShelterStaffAccountCommandInput,
  CreateVerifiedExportBundleCommandInput,
  DelegateGrantCommandInput,
  EditRecipientCommandInput,
  ImportExportBundleCommandInput,
  RepairUploadStorageCommandInput,
  RemoveRecipientCommandInput,
  RequestShelterContactCommandInput,
  RefreshWalletAuditCommandInput,
  RecordServiceInteractionCommandInput,
  RecordControllerApprovalCommandInput,
  RestoreWalletSnapshotCommandInput,
  RevokeAccessRequestCommandInput,
  SaveWalletSnapshotCommandInput,
  SaveServiceCommandInput,
  SetServicePlanReminderCommandInput,
  SearchAuditEventsCommandInput,
  Search211ServicesCommandInput,
  SendShelterNudgeCommandInput,
  ShelterContactRequestDecisionCommandInput,
  SubmitAnalyticsConsentCommandInput,
  SummarizeAuditEventsCommandInput,
  ProofReceiptReferenceCommandInput,
  SummarizeUploadRequirementsCommandInput,
  ToggleUploadSharedCommandInput,
  UpdateRecipientScopesCommandInput,
  UserShelterRequestDecisionCommandInput,
  ViewGrantedRecordCommandInput
} from "../agent/commandSchemas";
import { commandSchemas } from "../agent/commandSchemas";
import type { AgentConfirmationRisk, AgentPermissionLevel, EvidenceBundle, SurfaceContext } from "../agent/types";
import { getRouteLabel, getToolDefinition } from "../agent/surfaceRegistry";
import { confirmationRiskForGate, getAgentToolPermissionPolicy } from "../agent/permissionPolicy";

export interface AppActionState {
  activeRoute: RouteId;
  profile: RegistrationProfileDraft;
  policy: CheckInPolicyDraft;
  recipients: DisclosureRecipientDraft[];
  shelterContactRequests?: ShelterContactRequest[];
  shelterStaffAccounts?: ShelterStaffAccount[];
  shelterUserAccounts?: ShelterUserAccount[];
  uploads: UploadItem[];
  accessRequests: WalletAccessRequest[];
  grantReceipts: WalletGrantReceipt[];
  walletAuditEvents: AuditEvent[];
  analyticsStudies?: AnalyticsStudy[];
  analyticsOptIn?: Record<string, boolean>;
  walletProofReceipts: ProofReceiptView[];
  exportBundleViews: ExportBundleView[];
  savedServices?: SavedService[];
  servicePlans?: ServicePlan[];
  serviceInteractions?: ServiceInteractionEvent[];
  walletUnlocked?: boolean;
  privateContextAllowed?: boolean;
  permissionLevel?: AgentPermissionLevel;
}

export interface AppActionRuntime {
  getState: () => AppActionState;
  setActiveRoute?: (route: RouteId) => void;
  setMobileNavOpen?: (open: boolean) => void;
  setProfile?: (profile: RegistrationProfileDraft) => void;
  setPolicy?: (policy: CheckInPolicyDraft) => void;
  setRecipients?: (recipients: DisclosureRecipientDraft[]) => void;
  setShelterContactRequests?: (requests: ShelterContactRequest[]) => void;
  setShelterStaffAccounts?: (accounts: ShelterStaffAccount[]) => void;
  setShelterUserAccounts?: (accounts: ShelterUserAccount[]) => void;
  setUploads?: (uploads: UploadItem[]) => void;
  setAccessRequests?: (requests: WalletAccessRequest[]) => void;
  setGrantReceipts?: (receipts: WalletGrantReceipt[]) => void;
  setWalletAuditEvents?: (events: AuditEvent[]) => void;
  setAnalyticsOptIn?: (optedIn: Record<string, boolean>) => void;
  setWalletProofReceipts?: (proofs: ProofReceiptView[]) => void;
  setExportBundleViews?: (bundles: ExportBundleView[]) => void;
  setSavedServices?: (services: SavedService[]) => void;
  setServicePlans?: (plans: ServicePlan[]) => void;
  setServiceInteractions?: (interactions: ServiceInteractionEvent[]) => void;
  setServiceDetailDocId?: (docId: string | null) => void;
  walletApiConfig?: WalletApiConfig;
  refreshWalletAccessState?: () => Promise<void>;
  refreshWalletAuditEvents?: () => Promise<void>;
}

export interface AppActionOptions {
  confirmed?: boolean;
  userPresent?: boolean;
}

export interface AppActionConfirmationMetadata {
  required: boolean;
  title: string;
  summary: string;
  risk: AgentConfirmationRisk;
  permissionLevel: AgentPermissionLevel;
  auditEventType?: string;
  details?: Record<string, unknown>;
}

export interface AppActionSuccess {
  ok: true;
  action: AgentCommandName;
  summary: string;
  route?: RouteId;
  evidenceBundle?: EvidenceBundle;
  surfaceContext?: SurfaceContext;
  recordIds?: string[];
  artifactId?: string;
  auditEventId?: string;
  confirmation?: AppActionConfirmationMetadata;
  metadata?: Record<string, unknown>;
}

export interface AppActionFailure {
  ok: false;
  action: AgentCommandName;
  errorCode: string;
  message: string;
  retryable?: boolean;
  confirmation?: AppActionConfirmationMetadata;
}

export type AppActionResult = AppActionSuccess | AppActionFailure;

type AppActionHandler<TInput> = (
  runtime: AppActionRuntime,
  input: TInput,
  options: AppActionOptions
) => Promise<AppActionResult>;

function success(
  action: AgentCommandName,
  summary: string,
  extra: Omit<AppActionSuccess, "ok" | "action" | "summary"> = {}
): AppActionSuccess {
  return {
    ok: true,
    action,
    summary,
    ...extra
  };
}

function failure(
  action: AgentCommandName,
  errorCode: string,
  message: string,
  extra: Omit<AppActionFailure, "ok" | "action" | "errorCode" | "message"> = {}
): AppActionFailure {
  return {
    ok: false,
    action,
    errorCode,
    message,
    ...extra
  };
}

function confirmationFor(action: AgentCommandName, input: unknown): AppActionConfirmationMetadata {
  const tool = getToolDefinition(action);
  const policy = getAgentToolPermissionPolicy(action);
  return {
    required: tool.requiresConfirmation,
    title: tool.title,
    summary: summarizeConfirmation(action, input),
    risk: confirmationRiskForGate(policy.gate),
    permissionLevel: tool.permissionLevel,
    auditEventType: tool.auditEventType,
    details: input && typeof input === "object" ? { input, permissionGate: policy.gate, requiresAudit: policy.requiresAudit } : undefined
  };
}

function summarizeConfirmation(action: AgentCommandName, input: unknown): string {
  if (action === "set_disclosure_scopes" && isRecord(input)) {
    return `Update sharing scopes for recipient ${String(input.recipientId ?? "")}.`;
  }
  if (action === "update_recipient_scopes" && isRecord(input)) {
    return `Update sharing scopes for recipient ${String(input.recipientId ?? "")}.`;
  }
  if ((action === "add_recipient" || action === "edit_recipient") && isRecord(input)) {
    return `${action === "add_recipient" ? "Add" : "Edit"} recipient ${String(
      input.displayName ?? input.recipientId ?? ""
    )}.`;
  }
  if (action === "remove_recipient" && isRecord(input)) {
    return `Remove recipient ${String(input.recipientId ?? "")}.`;
  }
  if (action === "request_shelter_contact" && isRecord(input)) {
    return `Request shelter contact with ${String(input.shelterName ?? "")}.`;
  }
  if (
    (action === "approve_shelter_contact_request" || action === "deny_shelter_contact_request") &&
    isRecord(input)
  ) {
    return `${action === "approve_shelter_contact_request" ? "Approve" : "Deny"} shelter contact request ${String(
      input.requestId ?? ""
    )}.`;
  }
  if (action === "create_managed_user_account" && isRecord(input)) {
    return `Create managed shelter user account for ${String(input.legalName ?? "")}.`;
  }
  if (action === "create_shelter_staff_account" && isRecord(input)) {
    return `Create shelter staff account for ${String(input.displayName ?? "")}.`;
  }
  if (action === "send_shelter_nudge" && isRecord(input)) {
    return `Send shelter contact request to ${String(input.userName ?? "the selected person")}.`;
  }
  if (
    (action === "approve_user_shelter_request" || action === "deny_user_shelter_request") &&
    isRecord(input)
  ) {
    return `${action === "approve_user_shelter_request" ? "Approve" : "Deny"} user shelter request ${String(
      input.requestId ?? ""
    )}.`;
  }
  if (action === "add_shelter_as_recipient" && isRecord(input)) {
    return `Add ${String(input.shelterName ?? "the selected shelter")} as a shelter recipient.`;
  }
  if (
    (action === "record_controller_approval" ||
      action === "approve_access_request" ||
      action === "reject_access_request" ||
      action === "revoke_access_request") &&
    isRecord(input)
  ) {
    const verbs: Partial<Record<AgentCommandName, string>> = {
      record_controller_approval: "Record controller approval for",
      approve_access_request: "Approve",
      reject_access_request: "Reject",
      revoke_access_request: "Revoke"
    };
    return `${verbs[action] ?? "Update"} access request ${String(input.requestId ?? "")}.`;
  }
  if (
    (action === "analyze_granted_record" || action === "view_granted_record" || action === "delegate_grant") &&
    isRecord(input)
  ) {
    const verbs: Partial<Record<AgentCommandName, string>> = {
      analyze_granted_record: "Analyze",
      view_granted_record: "View",
      delegate_grant: "Delegate"
    };
    return `${verbs[action] ?? "Use"} grant ${String(input.grantId ?? input.receiptId ?? "")}.`;
  }
  if (action === "create_location_region_proof" && isRecord(input)) {
    return `Create a location-region proof for ${String(input.regionLabel ?? "the selected region")}.`;
  }
  if (action === "create_proof" && isRecord(input)) {
    return `Stage proof "${String(input.claim ?? "")}" for verifier ${String(input.verifier ?? "")} using witness label ${String(
      input.witnessLabel ?? ""
    )}.`;
  }
  if (action === "create_verified_export_bundle" && isRecord(input)) {
    return `Create an export bundle for ${String(input.audienceName ?? "the selected recipient")}.`;
  }
  if (action === "repair_upload_storage" && isRecord(input)) {
    return `Repair storage for upload ${String(input.uploadId ?? input.recordId ?? "")}.`;
  }
  if (action === "toggle_upload_shared" && isRecord(input)) {
    return `${input.shared ? "Allow sharing for" : "Make private"} upload ${String(input.uploadId ?? "")}.`;
  }
  if (action === "import_export_bundle" && isRecord(input)) {
    return `Import export bundle ${String(input.bundleId ?? "from provided bundle data")}.`;
  }
  if (action === "save_wallet_snapshot") return "Save an encrypted wallet snapshot.";
  if (action === "restore_wallet_snapshot" && isRecord(input)) {
    return `Restore wallet snapshot${input.walletId ? ` for ${String(input.walletId)}` : ""}.`;
  }
  if (action === "update_registration_draft") return "Update private registration profile fields.";
  if (action === "update_check_in_policy") return "Update check-in reminder and escalation settings.";
  if (action === "save_service") return "Save this service to the wallet-backed service list.";
  if (action === "create_service_plan") return "Create a private service follow-up plan.";
  if (action === "add_service_plan_checklist_item" && isRecord(input)) {
    return `Add a checklist item to plan ${String(input.planId ?? "")}.`;
  }
  if (action === "set_service_plan_reminder" && isRecord(input)) {
    return `Set a reminder for plan ${String(input.planId ?? "")}.`;
  }
  if (action === "record_service_interaction" && isRecord(input)) {
    return `Record a service interaction for ${String(input.serviceId ?? "")}.`;
  }
  return getToolDefinition(action).title;
}

function requiresConfirmation(action: AgentCommandName, input: unknown, options: AppActionOptions): AppActionFailure | undefined {
  const confirmation = confirmationFor(action, input);
  if (!confirmation.required || options.confirmed) return undefined;
  return failure(action, "confirmation_required", confirmation.summary, { confirmation });
}

function requireSetter<T>(
  action: AgentCommandName,
  setter: ((value: T) => void) | undefined,
  label: string
): ((value: T) => void) | AppActionFailure {
  if (setter) return setter;
  return failure(action, "missing_app_setter", `${label} is not writable in this app action runtime.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function search211ServicesAction(
  _runtime: AppActionRuntime,
  input: Search211ServicesCommandInput
): Promise<AppActionResult> {
  const response = await searchServiceNavigation(input);
  return success("search_211_services", response.summary, {
    evidenceBundle: response.evidenceBundle,
    recordIds: response.recordIds
  });
}

async function answer211QuestionAction(
  _runtime: AppActionRuntime,
  input: Answer211QuestionCommandInput
): Promise<AppActionResult> {
  const response = await answerServiceNavigationQuestion(input);
  return success("answer_211_question", response.answer, {
    evidenceBundle: response.evidenceBundle,
    recordIds: response.recordIds
  });
}

export const appActionHandlers = {
  navigate: navigateAction,
  read_surface_context: readSurfaceContextAction,
  search_211_services: search211ServicesAction,
  answer_211_question: answer211QuestionAction,
  open_service_detail: openServiceDetailAction,
  save_service: (runtime, input: SaveServiceCommandInput, options) => saveServiceAction(runtime, input, options),
  create_service_plan: (runtime, input: CreateServicePlanCommandInput, options) =>
    createServicePlanAction(runtime, input, options),
  add_service_plan_checklist_item: (runtime, input: AddServicePlanChecklistItemCommandInput, options) =>
    addServicePlanChecklistItemAction(runtime, input, options),
  set_service_plan_reminder: (runtime, input: SetServicePlanReminderCommandInput, options) =>
    setServicePlanReminderAction(runtime, input, options),
  record_service_interaction: (runtime, input: RecordServiceInteractionCommandInput, options) =>
    recordServiceInteractionAction(runtime, input, options),
  update_registration_draft: updateRegistrationDraftAction,
  update_check_in_policy: updateCheckInPolicyAction,
  add_recipient: (runtime, input: AddRecipientCommandInput, options) => addRecipientAction(runtime, input, options),
  edit_recipient: (runtime, input: EditRecipientCommandInput, options) => editRecipientAction(runtime, input, options),
  remove_recipient: (runtime, input: RemoveRecipientCommandInput, options) =>
    removeRecipientAction(runtime, input, options),
  update_recipient_scopes: (runtime, input: UpdateRecipientScopesCommandInput, options) =>
    updateRecipientScopesAction(runtime, input, options),
  preview_sharing_capabilities: previewSharingCapabilitiesAction,
  request_shelter_contact: (runtime, input: RequestShelterContactCommandInput, options) =>
    requestShelterContactAction(runtime, input, options),
  approve_shelter_contact_request: (runtime, input: ShelterContactRequestDecisionCommandInput, options) =>
    approveShelterContactRequestAction(runtime, input, options),
  deny_shelter_contact_request: (runtime, input: ShelterContactRequestDecisionCommandInput, options) =>
    denyShelterContactRequestAction(runtime, input, options),
  create_managed_user_account: (runtime, input: CreateManagedUserAccountCommandInput, options) =>
    createManagedUserAccountAction(runtime, input, options),
  create_shelter_staff_account: (runtime, input: CreateShelterStaffAccountCommandInput, options) =>
    createShelterStaffAccountAction(runtime, input, options),
  send_shelter_nudge: (runtime, input: SendShelterNudgeCommandInput, options) =>
    sendShelterNudgeAction(runtime, input, options),
  approve_user_shelter_request: (runtime, input: UserShelterRequestDecisionCommandInput, options) =>
    approveUserShelterRequestAction(runtime, input, options),
  deny_user_shelter_request: (runtime, input: UserShelterRequestDecisionCommandInput, options) =>
    denyUserShelterRequestAction(runtime, input, options),
  add_shelter_as_recipient: (runtime, input: AddShelterAsRecipientCommandInput, options) =>
    addShelterAsRecipientAction(runtime, input, options),
  summarize_upload_requirements: (runtime, input: SummarizeUploadRequirementsCommandInput) =>
    summarizeUploadRequirementsAction(runtime, input),
  classify_uploaded_document: (runtime, input: ClassifyUploadedDocumentCommandInput) =>
    classifyUploadedDocumentAction(runtime, input),
  repair_upload_storage: (runtime, input: RepairUploadStorageCommandInput, options) =>
    repairUploadStorageAction(runtime, input, options),
  toggle_upload_shared: (runtime, input: ToggleUploadSharedCommandInput, options) =>
    toggleUploadSharedAction(runtime, input, options),
  set_disclosure_scopes: setDisclosureScopesAction,
  record_controller_approval: (runtime, input: RecordControllerApprovalCommandInput, options) =>
    recordControllerApprovalAction(runtime, input, options),
  approve_access_request: (runtime, input, options) =>
    decideAccessRequestAction(runtime, input, "approved", "approve_access_request", options),
  reject_access_request: (runtime, input, options) =>
    decideAccessRequestAction(runtime, input, "rejected", "reject_access_request", options),
  revoke_access_request: (runtime, input: RevokeAccessRequestCommandInput, options) =>
    revokeAccessRequestAction(runtime, input, options),
  analyze_granted_record: (runtime, input: AnalyzeGrantedRecordCommandInput, options) =>
    analyzeGrantedRecordAction(runtime, input, options),
  view_granted_record: (runtime, input: ViewGrantedRecordCommandInput, options) =>
    viewGrantedRecordAction(runtime, input, options),
  delegate_grant: (runtime, input: DelegateGrantCommandInput, options) =>
    delegateGrantAction(runtime, input, options),
  create_proof: (runtime, input: CreateProofCommandInput, options) => createProofAction(runtime, input, options),
  create_location_region_proof: (runtime, input: CreateLocationRegionProofCommandInput, options) =>
    createLocationRegionProofAction(runtime, input, options),
  explain_proof_receipt: (runtime, input: ProofReceiptReferenceCommandInput) =>
    explainProofReceiptAction(runtime, input),
  verify_proof_status: (runtime, input: ProofReceiptReferenceCommandInput) => verifyProofStatusAction(runtime, input),
  create_verified_export_bundle: (runtime, input: CreateVerifiedExportBundleCommandInput, options) =>
    createVerifiedExportBundleAction(runtime, input, options),
  import_export_bundle: (runtime, input: ImportExportBundleCommandInput, options) =>
    importExportBundleAction(runtime, input, options),
  select_analytics_study: (runtime, input: AnalyticsStudyReferenceCommandInput) =>
    selectAnalyticsStudyAction(runtime, input),
  unselect_analytics_study: (runtime, input: AnalyticsStudyReferenceCommandInput) =>
    unselectAnalyticsStudyAction(runtime, input),
  explain_analytics_privacy_budget: (runtime, input: AnalyticsStudyReferenceCommandInput) =>
    explainAnalyticsPrivacyBudgetAction(runtime, input),
  submit_analytics_consent: (runtime, input: SubmitAnalyticsConsentCommandInput, options) =>
    submitAnalyticsConsentAction(runtime, input, options),
  save_wallet_snapshot: (runtime, input: SaveWalletSnapshotCommandInput, options) =>
    saveWalletSnapshotAction(runtime, input, options),
  restore_wallet_snapshot: (runtime, input: RestoreWalletSnapshotCommandInput, options) =>
    restoreWalletSnapshotAction(runtime, input, options),
  refresh_wallet_audit: (runtime, input: RefreshWalletAuditCommandInput) => refreshWalletAuditAction(runtime, input),
  search_audit_events: (runtime, input: SearchAuditEventsCommandInput) => searchAuditEventsAction(runtime, input),
  summarize_audit_events: (runtime, input: SummarizeAuditEventsCommandInput) =>
    summarizeAuditEventsAction(runtime, input),
  explain_audit_event: (runtime, input: AuditEventReferenceCommandInput) => explainAuditEventAction(runtime, input)
} satisfies Record<AgentCommandName, AppActionHandler<never>>;

export async function runAppAction(
  runtime: AppActionRuntime,
  action: AgentCommandName,
  input: unknown,
  options: AppActionOptions = {}
): Promise<AppActionResult> {
  const schema = commandSchemas[action];
  if (!schema.isInput(input)) {
    return failure(action, "invalid_input", `Invalid input for ${action}.`);
  }
  return appActionHandlers[action](runtime, input as never, options);
}

export function listAppActionConfirmations(): Record<AgentCommandName, AppActionConfirmationMetadata> {
  return Object.fromEntries(
    Object.keys(commandSchemas).map((name) => {
      const action = name as AgentCommandName;
      return [action, confirmationFor(action, {})];
    })
  ) as Record<AgentCommandName, AppActionConfirmationMetadata>;
}
