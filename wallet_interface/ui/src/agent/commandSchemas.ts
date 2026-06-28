import type { RouteId } from "../models/abby";
import type { AgentCommandSchema, AgentSchemaProperty, EvidenceBundle } from "./types";
import {
  isAgentCommandSchema,
  isBoolean,
  isEvidenceBundle,
  isNumber,
  isOptional,
  isRecord,
  isRouteId,
  isString,
  isStringArray
} from "./types";

export const AGENT_COMMAND_NAMES = [
  "navigate",
  "read_surface_context",
  "search_211_services",
  "answer_211_question",
  "open_service_detail",
  "save_service",
  "create_service_plan",
  "add_service_plan_checklist_item",
  "set_service_plan_reminder",
  "record_service_interaction",
  "update_registration_draft",
  "update_check_in_policy",
  "add_recipient",
  "edit_recipient",
  "remove_recipient",
  "update_recipient_scopes",
  "preview_sharing_capabilities",
  "request_shelter_contact",
  "approve_shelter_contact_request",
  "deny_shelter_contact_request",
  "create_managed_user_account",
  "create_shelter_staff_account",
  "send_shelter_nudge",
  "approve_user_shelter_request",
  "deny_user_shelter_request",
  "add_shelter_as_recipient",
  "summarize_upload_requirements",
  "classify_uploaded_document",
  "repair_upload_storage",
  "toggle_upload_shared",
  "set_disclosure_scopes",
  "record_controller_approval",
  "approve_access_request",
  "reject_access_request",
  "revoke_access_request",
  "analyze_granted_record",
  "view_granted_record",
  "delegate_grant",
  "create_proof",
  "create_location_region_proof",
  "explain_proof_receipt",
  "verify_proof_status",
  "create_verified_export_bundle",
  "import_export_bundle",
  "select_analytics_study",
  "unselect_analytics_study",
  "explain_analytics_privacy_budget",
  "submit_analytics_consent",
  "save_wallet_snapshot",
  "restore_wallet_snapshot",
  "refresh_wallet_audit",
  "search_audit_events",
  "summarize_audit_events",
  "explain_audit_event"
] as const;

export type AgentCommandName = (typeof AGENT_COMMAND_NAMES)[number];

export interface CommandSuccessOutput {
  ok: true;
  summary: string;
  route?: RouteId;
  evidenceBundle?: EvidenceBundle;
  recordIds?: string[];
  artifactId?: string;
}

export interface CommandFailureOutput {
  ok: false;
  errorCode: string;
  message: string;
  retryable?: boolean;
}

export type CommandOutput = CommandSuccessOutput | CommandFailureOutput;

const routeIds = [
  "home",
  "register",
  "check-in",
  "calendar",
  "messages",
  "contacts",
  "sharing-rules",
  "uploads",
  "settings",
  "social-services",
  "interactions",
  "shelter",
  "provider-clients",
  "provider-cases",
  "provider-messages",
  "provider-analytics",
  "provider-proofs",
  "provider-operations",
  "recipient-access",
  "benefits-protection",
  "analytics",
  "proof-center",
  "exports",
  "security",
  "audit"
] as const;

const checkInChannels = ["email", "sms", "web"] as const;

const disclosureScopes = [
  "identity_minimum",
  "profile",
  "photo",
  "current_location",
  "uploaded_documents",
  "missed_check_in",
  "found_permanent_housing",
  "medical_notes",
  "shelter_history",
  "benefits_information",
  "custom"
] as const;

const disclosureRecipientTypes = [
  "emergency_contact",
  "police_precinct",
  "social_worker",
  "shelter_staff",
  "government_liaison",
  "benefits_agency"
] as const;

const easyBotCheckStatuses = ["pending", "passed", "failed"] as const;
const servicePlanChecklistNames = ["steps", "documents_needed", "questions_to_ask"] as const;

export interface NavigateCommandInput {
  route: RouteId;
}

export interface ReadSurfaceContextCommandInput {
  route?: RouteId;
  includePrivateContext?: boolean;
}

export interface Search211ServicesCommandInput {
  query: string;
  limit?: number;
  city?: string;
  category?: string;
}

export interface Answer211QuestionCommandInput {
  question: string;
  useLocalModel?: boolean;
}

export interface OpenServiceDetailCommandInput {
  docId: string;
}

export interface SaveServiceCommandInput {
  serviceId: string;
  note?: string;
  title?: string;
  providerName?: string;
  programName?: string;
  sourceUrl?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
  label?: string;
  reason?: string;
  priority?: string;
}

export interface CreateServicePlanCommandInput {
  serviceId: string;
  goal: string;
  steps?: string[];
  documentsNeeded?: string[];
  questionsToAsk?: string[];
  appointmentAt?: string;
  reminderAt?: string;
  travelTarget?: string;
  assignedWorkerRecipientId?: string;
  title?: string;
  providerName?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
}

export interface AddServicePlanChecklistItemCommandInput {
  planId: string;
  item: string;
  checklist: "steps" | "documents_needed" | "questions_to_ask";
}

export interface SetServicePlanReminderCommandInput {
  planId: string;
  reminderAt: string;
  appointmentAt?: string;
}

export interface RecordServiceInteractionCommandInput {
  serviceId: string;
  interactionType: string;
  channel?: string;
  providerName?: string;
  programName?: string;
  counterpartyName?: string;
  counterpartyContact?: string;
  timestamp?: string;
  status?: string;
  outcome?: string;
  notesRecordId?: string;
  nextAction?: string;
  nextFollowUpAt?: string;
  sourceActionUrl?: string;
  sourceContentCid?: string;
  sourcePageCid?: string;
  relatedGrantIds?: string[];
  relatedRecordIds?: string[];
  privacyLevel?: string;
}

export interface UpdateRegistrationDraftCommandInput {
  preferredName?: string;
  pronouns?: string;
  phone?: string;
  email?: string;
  currentLocation?: string;
  shelterAffiliation?: string;
  serviceNeeds?: string[];
  preferredCheckInChannels?: Array<"email" | "sms" | "web">;
}

export interface UpdateCheckInPolicyCommandInput {
  intervalDays?: number;
  reminderChannels?: Array<"email" | "sms" | "web">;
  gracePeriodHours?: number;
  escalationEnabled?: boolean;
}

export interface SetDisclosureScopesCommandInput {
  recipientId: string;
  allowedScopes: string[];
}

export interface AddRecipientCommandInput {
  displayName: string;
  type?: (typeof disclosureRecipientTypes)[number];
  relationship?: string;
  email?: string;
  phone?: string;
  agencyName?: string;
  precinctName?: string;
  verified?: boolean;
  allowedScopes?: string[];
}

export interface EditRecipientCommandInput {
  recipientId: string;
  displayName?: string;
  type?: (typeof disclosureRecipientTypes)[number];
  relationship?: string;
  email?: string;
  phone?: string;
  agencyName?: string;
  precinctName?: string;
  verified?: boolean;
  allowedScopes?: string[];
}

export interface RemoveRecipientCommandInput {
  recipientId: string;
  reason?: string;
}

export interface UpdateRecipientScopesCommandInput {
  recipientId: string;
  allowedScopes: string[];
  stageOnly?: boolean;
}

export interface PreviewSharingCapabilitiesCommandInput {
  recipientId?: string;
  allowedScopes?: string[];
}

export interface RequestShelterContactCommandInput {
  shelterName: string;
  userName?: string;
  userContact?: string;
}

export interface ShelterContactRequestDecisionCommandInput {
  requestId: string;
  reason?: string;
}

export interface CreateManagedUserAccountCommandInput {
  shelter: string;
  staffId: string;
  legalName: string;
  preferredName?: string;
  pronouns?: string;
  dateOfBirth?: string;
  photoAssetId: string;
  phone?: string;
  email?: string;
  currentLocation?: string;
  preferredShelter?: string;
  serviceNeeds?: string[];
  easyBotCheckStatus?: (typeof easyBotCheckStatuses)[number];
  captchaToken?: string;
  localPrecinctNotified?: boolean;
  foundPermanentHousing?: boolean;
}

export interface CreateShelterStaffAccountCommandInput {
  shelter: string;
  operatorStaffId: string;
  displayName: string;
  email?: string;
}

export interface SendShelterNudgeCommandInput {
  shelter: string;
  staffId: string;
  userName: string;
  userContact: string;
}

export interface UserShelterRequestDecisionCommandInput {
  requestId: string;
  reason?: string;
}

export interface AddShelterAsRecipientCommandInput {
  shelterName: string;
  staffName?: string;
}

export const UPLOAD_DOCUMENT_CATEGORIES = [
  "Identity",
  "Benefits",
  "Housing",
  "Medical",
  "Legal",
  "Income",
  "Contact",
  "Other"
] as const;
export type UploadDocumentCategory = (typeof UPLOAD_DOCUMENT_CATEGORIES)[number];

export const UPLOAD_DOCUMENT_SENSITIVITIES = ["low", "moderate", "high", "restricted"] as const;
export type UploadDocumentSensitivity = (typeof UPLOAD_DOCUMENT_SENSITIVITIES)[number];

export interface SummarizeUploadRequirementsCommandInput {
  goal?: string;
  documentType?: string;
}

export interface ClassifyUploadedDocumentCommandInput {
  uploadId?: string;
  recordId?: string;
  fileName?: string;
  mimeType?: string;
  machineSummary?: string;
  userSelected: boolean;
  categoryHint?: UploadDocumentCategory;
}

export interface RepairUploadStorageCommandInput {
  uploadId?: string;
  recordId?: string;
}

export interface ToggleUploadSharedCommandInput {
  uploadId: string;
  shared: boolean;
  reason?: string;
}

export interface AccessRequestDecisionCommandInput {
  requestId: string;
  reason?: string;
}

export interface RecordControllerApprovalCommandInput {
  requestId: string;
}

export interface RevokeAccessRequestCommandInput {
  requestId: string;
  reason?: string;
}

export const RECIPIENT_ANALYSIS_MODES = ["summary", "redacted", "vector", "extract-text", "form"] as const;
export type RecipientAnalysisMode = (typeof RECIPIENT_ANALYSIS_MODES)[number];

export interface AnalyzeGrantedRecordCommandInput {
  grantId?: string;
  receiptId?: string;
  recordId?: string;
  mode?: RecipientAnalysisMode;
  maxChars?: number;
  maxBytes?: number;
  chunkSizeWords?: number;
  maxFields?: number;
  useOcr?: boolean;
  userPresent?: boolean;
}

export interface ViewGrantedRecordCommandInput {
  grantId?: string;
  receiptId?: string;
  recordId?: string;
  userPresent?: boolean;
}

export interface DelegateGrantCommandInput {
  grantId?: string;
  receiptId?: string;
  audienceDid: string;
  audienceKeyHex?: string;
  ability?: string;
  purpose?: string;
  expiresAt?: string;
  resources?: string[];
}

export interface CreateLocationRegionProofCommandInput {
  verifier: string;
  regionLabel: string;
  claim?: string;
  witnessLabel?: string;
  recordId?: string;
  grantId?: string;
}

export interface CreateProofCommandInput {
  claim: string;
  verifier: string;
  witnessLabel: string;
  proofType?: string;
  regionLabel?: string;
  recordId?: string;
  grantId?: string;
  publicInputs?: Record<string, string>;
}

export interface ProofReceiptReferenceCommandInput {
  proofId?: string;
  receiptId?: string;
}

export interface CreateVerifiedExportBundleCommandInput {
  audienceName: string;
  audienceDid?: string;
  recordIds: string[];
  proofIds?: string[];
  purpose?: string;
  includeDerivedArtifacts?: boolean;
  includeProofs?: boolean;
  stageOnly?: boolean;
}

export interface ImportExportBundleCommandInput {
  bundleId?: string;
  bundle?: Record<string, unknown>;
  audienceName?: string;
  stageOnly?: boolean;
}

export interface AnalyticsStudyReferenceCommandInput {
  studyId?: string;
}

export interface SubmitAnalyticsConsentCommandInput {
  studyId: string;
  expiresAt?: string;
  stageOnly?: boolean;
}

export interface SaveWalletSnapshotCommandInput {
  reason?: string;
}

export interface RestoreWalletSnapshotCommandInput {
  walletId?: string;
  snapshotHash?: string;
  reason?: string;
}

export interface RefreshWalletAuditCommandInput {
  limit?: number;
}

export interface SearchAuditEventsCommandInput {
  query?: string;
  actor?: string;
  action?: string;
  resource?: string;
  decision?: string;
  grantId?: string;
  limit?: number;
}

export interface SummarizeAuditEventsCommandInput {
  query?: string;
  actor?: string;
  action?: string;
  resource?: string;
  decision?: string;
  grantId?: string;
  limit?: number;
}

export interface AuditEventReferenceCommandInput {
  eventId: string;
}

const stringProperty: AgentSchemaProperty = { type: "string" };
const booleanProperty: AgentSchemaProperty = { type: "boolean" };
const numberProperty: AgentSchemaProperty = { type: "number" };
const stringArrayProperty: AgentSchemaProperty = { type: "array", items: stringProperty };
const stringRecordProperty: AgentSchemaProperty = {
  type: "object",
  additionalProperties: true
};

const commandOutputSchema: AgentSchemaProperty = {
  type: "object",
  required: ["ok"],
  additionalProperties: true,
  properties: {
    ok: booleanProperty,
    summary: stringProperty,
    route: { type: "string", enum: routeIds },
    errorCode: stringProperty,
    message: stringProperty,
    retryable: booleanProperty,
    recordIds: stringArrayProperty,
    artifactId: stringProperty
  }
};

function objectSchema(
  properties: Record<string, AgentSchemaProperty>,
  required: readonly string[] = [],
  additionalProperties = false
): AgentSchemaProperty {
  return {
    type: "object",
    required,
    properties,
    additionalProperties
  };
}

function isCommandOutput(value: unknown): value is CommandOutput {
  if (!isRecord(value) || !isBoolean(value.ok)) {
    return false;
  }
  if (value.ok) {
    return (
      isString(value.summary) &&
      isOptional(value.route, isRouteId) &&
      isOptional(value.evidenceBundle, isEvidenceBundle) &&
      isOptional(value.recordIds, isStringArray) &&
      isOptional(value.artifactId, isString)
    );
  }
  return (
    isString(value.errorCode) &&
    isString(value.message) &&
    isOptional(value.retryable, isBoolean)
  );
}

function isStringOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return isString(value) && values.includes(value);
}

function isOptionalLimitedNumber(value: unknown, min: number, max: number): value is number | undefined {
  return value === undefined || (isNumber(value) && value >= min && value <= max);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isCheckInChannelArray(value: unknown): value is Array<"email" | "sms" | "web"> {
  return Array.isArray(value) && value.every((item) => isStringOneOf(checkInChannels, item));
}

function isDisclosureScopeArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isStringOneOf(disclosureScopes, item));
}

function isDisclosureRecipientType(value: unknown): value is (typeof disclosureRecipientTypes)[number] {
  return isStringOneOf(disclosureRecipientTypes, value);
}

function isEasyBotCheckStatus(value: unknown): value is (typeof easyBotCheckStatuses)[number] {
  return isStringOneOf(easyBotCheckStatuses, value);
}

function isUploadDocumentCategory(value: unknown): value is UploadDocumentCategory {
  return isStringOneOf(UPLOAD_DOCUMENT_CATEGORIES, value);
}

function isServicePlanChecklistName(value: unknown): value is (typeof servicePlanChecklistNames)[number] {
  return isStringOneOf(servicePlanChecklistNames, value);
}

export function isNavigateCommandInput(value: unknown): value is NavigateCommandInput {
  return isRecord(value) && isRouteId(value.route);
}

export function isReadSurfaceContextCommandInput(value: unknown): value is ReadSurfaceContextCommandInput {
  return (
    isRecord(value) &&
    isOptional(value.route, isRouteId) &&
    isOptional(value.includePrivateContext, isBoolean)
  );
}

export function isSearch211ServicesCommandInput(value: unknown): value is Search211ServicesCommandInput {
  return (
    isRecord(value) &&
    isString(value.query) &&
    value.query.trim().length > 0 &&
    isOptionalLimitedNumber(value.limit, 1, 20) &&
    isOptional(value.city, isString) &&
    isOptional(value.category, isString)
  );
}

export function isAnswer211QuestionCommandInput(value: unknown): value is Answer211QuestionCommandInput {
  return (
    isRecord(value) &&
    isString(value.question) &&
    value.question.trim().length > 0 &&
    isOptional(value.useLocalModel, isBoolean)
  );
}

export function isOpenServiceDetailCommandInput(value: unknown): value is OpenServiceDetailCommandInput {
  return isRecord(value) && isString(value.docId) && value.docId.trim().length > 0;
}

export function isSaveServiceCommandInput(value: unknown): value is SaveServiceCommandInput {
  return (
    isRecord(value) &&
    isString(value.serviceId) &&
    value.serviceId.trim().length > 0 &&
    isOptional(value.note, isString) &&
    isOptional(value.title, isString) &&
    isOptional(value.providerName, isString) &&
    isOptional(value.programName, isString) &&
    isOptional(value.sourceUrl, isString) &&
    isOptional(value.sourceContentCid, isString) &&
    isOptional(value.sourcePageCid, isString) &&
    isOptional(value.label, isString) &&
    isOptional(value.reason, isString) &&
    isOptional(value.priority, isString)
  );
}

export function isCreateServicePlanCommandInput(value: unknown): value is CreateServicePlanCommandInput {
  return (
    isRecord(value) &&
    isString(value.serviceId) &&
    value.serviceId.trim().length > 0 &&
    isString(value.goal) &&
    value.goal.trim().length > 0 &&
    isOptional(value.steps, isStringArray) &&
    isOptional(value.documentsNeeded, isStringArray) &&
    isOptional(value.questionsToAsk, isStringArray) &&
    isOptional(value.appointmentAt, isString) &&
    isOptional(value.reminderAt, isString) &&
    isOptional(value.travelTarget, isString) &&
    isOptional(value.assignedWorkerRecipientId, isString) &&
    isOptional(value.title, isString) &&
    isOptional(value.providerName, isString) &&
    isOptional(value.sourceContentCid, isString) &&
    isOptional(value.sourcePageCid, isString)
  );
}

export function isAddServicePlanChecklistItemCommandInput(
  value: unknown
): value is AddServicePlanChecklistItemCommandInput {
  return (
    isRecord(value) &&
    isString(value.planId) &&
    value.planId.trim().length > 0 &&
    isString(value.item) &&
    value.item.trim().length > 0 &&
    isServicePlanChecklistName(value.checklist)
  );
}

export function isSetServicePlanReminderCommandInput(value: unknown): value is SetServicePlanReminderCommandInput {
  return (
    isRecord(value) &&
    isString(value.planId) &&
    value.planId.trim().length > 0 &&
    isString(value.reminderAt) &&
    value.reminderAt.trim().length > 0 &&
    isOptional(value.appointmentAt, isString)
  );
}

export function isRecordServiceInteractionCommandInput(
  value: unknown
): value is RecordServiceInteractionCommandInput {
  return (
    isRecord(value) &&
    isString(value.serviceId) &&
    value.serviceId.trim().length > 0 &&
    isString(value.interactionType) &&
    value.interactionType.trim().length > 0 &&
    isOptional(value.channel, isString) &&
    isOptional(value.providerName, isString) &&
    isOptional(value.programName, isString) &&
    isOptional(value.counterpartyName, isString) &&
    isOptional(value.counterpartyContact, isString) &&
    isOptional(value.timestamp, isString) &&
    isOptional(value.status, isString) &&
    isOptional(value.outcome, isString) &&
    isOptional(value.notesRecordId, isString) &&
    isOptional(value.nextAction, isString) &&
    isOptional(value.nextFollowUpAt, isString) &&
    isOptional(value.sourceActionUrl, isString) &&
    isOptional(value.sourceContentCid, isString) &&
    isOptional(value.sourcePageCid, isString) &&
    isOptional(value.relatedGrantIds, isStringArray) &&
    isOptional(value.relatedRecordIds, isStringArray) &&
    isOptional(value.privacyLevel, isString)
  );
}

export function isUpdateRegistrationDraftCommandInput(value: unknown): value is UpdateRegistrationDraftCommandInput {
  return (
    isRecord(value) &&
    isOptional(value.preferredName, isString) &&
    isOptional(value.pronouns, isString) &&
    isOptional(value.phone, isString) &&
    isOptional(value.email, isString) &&
    isOptional(value.currentLocation, isString) &&
    isOptional(value.shelterAffiliation, isString) &&
    isOptional(value.serviceNeeds, isStringArray) &&
    isOptional(value.preferredCheckInChannels, isCheckInChannelArray) &&
    [
      value.preferredName,
      value.pronouns,
      value.phone,
      value.email,
      value.currentLocation,
      value.shelterAffiliation,
      value.serviceNeeds,
      value.preferredCheckInChannels
    ].some((item) => item !== undefined)
  );
}

export function isUpdateCheckInPolicyCommandInput(value: unknown): value is UpdateCheckInPolicyCommandInput {
  return (
    isRecord(value) &&
    isOptionalLimitedNumber(value.intervalDays, 1, 365) &&
    isOptional(value.reminderChannels, isCheckInChannelArray) &&
    isOptionalLimitedNumber(value.gracePeriodHours, 0, 168) &&
    isOptional(value.escalationEnabled, isBoolean) &&
    [value.intervalDays, value.reminderChannels, value.gracePeriodHours, value.escalationEnabled].some(
      (item) => item !== undefined
    )
  );
}

export function isSetDisclosureScopesCommandInput(value: unknown): value is SetDisclosureScopesCommandInput {
  return (
    isRecord(value) &&
    isString(value.recipientId) &&
    value.recipientId.trim().length > 0 &&
    isDisclosureScopeArray(value.allowedScopes)
  );
}

export function isAddRecipientCommandInput(value: unknown): value is AddRecipientCommandInput {
  return (
    isRecord(value) &&
    isString(value.displayName) &&
    value.displayName.trim().length > 0 &&
    isOptional(value.type, isDisclosureRecipientType) &&
    isOptional(value.relationship, isString) &&
    isOptional(value.email, isString) &&
    isOptional(value.phone, isString) &&
    isOptional(value.agencyName, isString) &&
    isOptional(value.precinctName, isString) &&
    isOptional(value.verified, isBoolean) &&
    isOptional(value.allowedScopes, isDisclosureScopeArray)
  );
}

export function isEditRecipientCommandInput(value: unknown): value is EditRecipientCommandInput {
  return (
    isRecord(value) &&
    isString(value.recipientId) &&
    value.recipientId.trim().length > 0 &&
    isOptional(value.displayName, isString) &&
    isOptional(value.type, isDisclosureRecipientType) &&
    isOptional(value.relationship, isString) &&
    isOptional(value.email, isString) &&
    isOptional(value.phone, isString) &&
    isOptional(value.agencyName, isString) &&
    isOptional(value.precinctName, isString) &&
    isOptional(value.verified, isBoolean) &&
    isOptional(value.allowedScopes, isDisclosureScopeArray)
  );
}

export function isRemoveRecipientCommandInput(value: unknown): value is RemoveRecipientCommandInput {
  return (
    isRecord(value) &&
    isString(value.recipientId) &&
    value.recipientId.trim().length > 0 &&
    isOptional(value.reason, isString)
  );
}

export function isUpdateRecipientScopesCommandInput(value: unknown): value is UpdateRecipientScopesCommandInput {
  return (
    isRecord(value) &&
    isString(value.recipientId) &&
    value.recipientId.trim().length > 0 &&
    isDisclosureScopeArray(value.allowedScopes) &&
    isOptional(value.stageOnly, isBoolean)
  );
}

export function isPreviewSharingCapabilitiesCommandInput(value: unknown): value is PreviewSharingCapabilitiesCommandInput {
  return (
    isRecord(value) &&
    (value.recipientId === undefined || (isString(value.recipientId) && value.recipientId.trim().length > 0)) &&
    isOptional(value.allowedScopes, isDisclosureScopeArray) &&
    (value.recipientId !== undefined || value.allowedScopes !== undefined)
  );
}

export function isRequestShelterContactCommandInput(value: unknown): value is RequestShelterContactCommandInput {
  return (
    isRecord(value) &&
    isString(value.shelterName) &&
    value.shelterName.trim().length > 0 &&
    isOptional(value.userName, isString) &&
    isOptional(value.userContact, isString)
  );
}

export function isShelterContactRequestDecisionCommandInput(
  value: unknown
): value is ShelterContactRequestDecisionCommandInput {
  return (
    isRecord(value) &&
    isString(value.requestId) &&
    value.requestId.trim().length > 0 &&
    isOptional(value.reason, isString)
  );
}

export function isCreateManagedUserAccountCommandInput(value: unknown): value is CreateManagedUserAccountCommandInput {
  return (
    isRecord(value) &&
    isString(value.shelter) &&
    value.shelter.trim().length > 0 &&
    isString(value.staffId) &&
    value.staffId.trim().length > 0 &&
    isString(value.legalName) &&
    value.legalName.trim().length > 0 &&
    isString(value.photoAssetId) &&
    value.photoAssetId.trim().length > 0 &&
    isOptional(value.preferredName, isString) &&
    isOptional(value.pronouns, isString) &&
    isOptional(value.dateOfBirth, isString) &&
    isOptional(value.phone, isString) &&
    isOptional(value.email, isString) &&
    isOptional(value.currentLocation, isString) &&
    isOptional(value.preferredShelter, isString) &&
    isOptional(value.serviceNeeds, isStringArray) &&
    isOptional(value.easyBotCheckStatus, isEasyBotCheckStatus) &&
    isOptional(value.captchaToken, isString) &&
    isOptional(value.localPrecinctNotified, isBoolean) &&
    isOptional(value.foundPermanentHousing, isBoolean)
  );
}

export function isCreateShelterStaffAccountCommandInput(value: unknown): value is CreateShelterStaffAccountCommandInput {
  return (
    isRecord(value) &&
    isString(value.shelter) &&
    value.shelter.trim().length > 0 &&
    isString(value.operatorStaffId) &&
    value.operatorStaffId.trim().length > 0 &&
    isString(value.displayName) &&
    value.displayName.trim().length > 0 &&
    isOptional(value.email, isString)
  );
}

export function isSendShelterNudgeCommandInput(value: unknown): value is SendShelterNudgeCommandInput {
  return (
    isRecord(value) &&
    isString(value.shelter) &&
    value.shelter.trim().length > 0 &&
    isString(value.staffId) &&
    value.staffId.trim().length > 0 &&
    isString(value.userName) &&
    value.userName.trim().length > 0 &&
    isString(value.userContact) &&
    value.userContact.trim().length > 0
  );
}

export function isUserShelterRequestDecisionCommandInput(
  value: unknown
): value is UserShelterRequestDecisionCommandInput {
  return (
    isRecord(value) &&
    isString(value.requestId) &&
    value.requestId.trim().length > 0 &&
    isOptional(value.reason, isString)
  );
}

export function isAddShelterAsRecipientCommandInput(value: unknown): value is AddShelterAsRecipientCommandInput {
  return (
    isRecord(value) &&
    isString(value.shelterName) &&
    value.shelterName.trim().length > 0 &&
    isOptional(value.staffName, isString)
  );
}

export function isSummarizeUploadRequirementsCommandInput(
  value: unknown
): value is SummarizeUploadRequirementsCommandInput {
  return isRecord(value) && isOptional(value.goal, isString) && isOptional(value.documentType, isString);
}

export function isClassifyUploadedDocumentCommandInput(
  value: unknown
): value is ClassifyUploadedDocumentCommandInput {
  return (
    isRecord(value) &&
    value.userSelected === true &&
    (value.uploadId === undefined || (isString(value.uploadId) && value.uploadId.trim().length > 0)) &&
    (value.recordId === undefined || (isString(value.recordId) && value.recordId.trim().length > 0)) &&
    (value.fileName === undefined || (isString(value.fileName) && value.fileName.trim().length > 0)) &&
    isOptional(value.mimeType, isString) &&
    isOptional(value.machineSummary, isString) &&
    isOptional(value.categoryHint, isUploadDocumentCategory) &&
    (value.uploadId !== undefined || value.recordId !== undefined || value.fileName !== undefined)
  );
}

export function isRepairUploadStorageCommandInput(value: unknown): value is RepairUploadStorageCommandInput {
  return (
    isRecord(value) &&
    (value.uploadId === undefined || (isString(value.uploadId) && value.uploadId.trim().length > 0)) &&
    (value.recordId === undefined || (isString(value.recordId) && value.recordId.trim().length > 0)) &&
    (value.uploadId !== undefined || value.recordId !== undefined)
  );
}

export function isToggleUploadSharedCommandInput(value: unknown): value is ToggleUploadSharedCommandInput {
  return (
    isRecord(value) &&
    isString(value.uploadId) &&
    value.uploadId.trim().length > 0 &&
    isBoolean(value.shared) &&
    isOptional(value.reason, isString)
  );
}

export function isAccessRequestDecisionCommandInput(value: unknown): value is AccessRequestDecisionCommandInput {
  return (
    isRecord(value) &&
    isString(value.requestId) &&
    value.requestId.trim().length > 0 &&
    isOptional(value.reason, isString)
  );
}

export function isRecordControllerApprovalCommandInput(value: unknown): value is RecordControllerApprovalCommandInput {
  return isRecord(value) && isString(value.requestId) && value.requestId.trim().length > 0;
}

export function isRevokeAccessRequestCommandInput(value: unknown): value is RevokeAccessRequestCommandInput {
  return (
    isRecord(value) &&
    isString(value.requestId) &&
    value.requestId.trim().length > 0 &&
    isOptional(value.reason, isString)
  );
}

function hasGrantReference(value: Record<string, unknown>): boolean {
  return (
    (isString(value.grantId) && value.grantId.trim().length > 0) ||
    (isString(value.receiptId) && value.receiptId.trim().length > 0)
  );
}

function isRecipientAnalysisMode(value: unknown): value is RecipientAnalysisMode {
  return value === undefined || isStringOneOf(RECIPIENT_ANALYSIS_MODES, value);
}

export function isAnalyzeGrantedRecordCommandInput(value: unknown): value is AnalyzeGrantedRecordCommandInput {
  return (
    isRecord(value) &&
    hasGrantReference(value) &&
    isOptional(value.recordId, isString) &&
    isRecipientAnalysisMode(value.mode) &&
    isOptionalLimitedNumber(value.maxChars, 1, 100_000) &&
    isOptionalLimitedNumber(value.maxBytes, 1, 10_000_000) &&
    isOptionalLimitedNumber(value.chunkSizeWords, 10, 2_000) &&
    isOptionalLimitedNumber(value.maxFields, 1, 1_000) &&
    isOptional(value.useOcr, isBoolean) &&
    isOptional(value.userPresent, isBoolean)
  );
}

export function isViewGrantedRecordCommandInput(value: unknown): value is ViewGrantedRecordCommandInput {
  return (
    isRecord(value) &&
    hasGrantReference(value) &&
    isOptional(value.recordId, isString) &&
    isOptional(value.userPresent, isBoolean)
  );
}

export function isDelegateGrantCommandInput(value: unknown): value is DelegateGrantCommandInput {
  return (
    isRecord(value) &&
    hasGrantReference(value) &&
    isString(value.audienceDid) &&
    value.audienceDid.trim().length > 0 &&
    isOptional(value.audienceKeyHex, isString) &&
    isOptional(value.ability, isString) &&
    isOptional(value.purpose, isString) &&
    isOptional(value.expiresAt, isString) &&
    isOptional(value.resources, isStringArray)
  );
}

export function isCreateLocationRegionProofCommandInput(value: unknown): value is CreateLocationRegionProofCommandInput {
  return (
    isRecord(value) &&
    isString(value.verifier) &&
    value.verifier.trim().length > 0 &&
    isString(value.regionLabel) &&
    value.regionLabel.trim().length > 0 &&
    isOptional(value.claim, isString) &&
    isOptional(value.witnessLabel, isString) &&
    isOptional(value.recordId, isString) &&
    isOptional(value.grantId, isString)
  );
}

export function isCreateProofCommandInput(value: unknown): value is CreateProofCommandInput {
  return (
    isRecord(value) &&
    isString(value.claim) &&
    value.claim.trim().length > 0 &&
    isString(value.verifier) &&
    value.verifier.trim().length > 0 &&
    isString(value.witnessLabel) &&
    value.witnessLabel.trim().length > 0 &&
    isOptional(value.proofType, isString) &&
    isOptional(value.regionLabel, isString) &&
    isOptional(value.recordId, isString) &&
    isOptional(value.grantId, isString) &&
    isOptional(value.publicInputs, isStringRecord)
  );
}

export function isProofReceiptReferenceCommandInput(value: unknown): value is ProofReceiptReferenceCommandInput {
  return (
    isRecord(value) &&
    ((isString(value.proofId) && value.proofId.trim().length > 0) ||
      (isString(value.receiptId) && value.receiptId.trim().length > 0))
  );
}

export function isCreateVerifiedExportBundleCommandInput(value: unknown): value is CreateVerifiedExportBundleCommandInput {
  return (
    isRecord(value) &&
    isString(value.audienceName) &&
    value.audienceName.trim().length > 0 &&
    isOptional(value.audienceDid, isString) &&
    isStringArray(value.recordIds) &&
    value.recordIds.length > 0 &&
    isOptional(value.proofIds, isStringArray) &&
    isOptional(value.purpose, isString) &&
    isOptional(value.includeDerivedArtifacts, isBoolean) &&
    isOptional(value.includeProofs, isBoolean) &&
    isOptional(value.stageOnly, isBoolean)
  );
}

export function isImportExportBundleCommandInput(value: unknown): value is ImportExportBundleCommandInput {
  return (
    isRecord(value) &&
    (isString(value.bundleId) || isRecord(value.bundle)) &&
    isOptional(value.bundleId, isString) &&
    isOptional(value.bundle, isRecord) &&
    isOptional(value.audienceName, isString) &&
    isOptional(value.stageOnly, isBoolean)
  );
}

export function isAnalyticsStudyReferenceCommandInput(value: unknown): value is AnalyticsStudyReferenceCommandInput {
  return isRecord(value) && isOptional(value.studyId, isString);
}

export function isRequiredAnalyticsStudyReferenceCommandInput(
  value: unknown
): value is AnalyticsStudyReferenceCommandInput {
  return isRecord(value) && isString(value.studyId) && value.studyId.trim().length > 0;
}

export function isSubmitAnalyticsConsentCommandInput(value: unknown): value is SubmitAnalyticsConsentCommandInput {
  return (
    isRecord(value) &&
    isString(value.studyId) &&
    value.studyId.trim().length > 0 &&
    isOptional(value.expiresAt, isString) &&
    isOptional(value.stageOnly, isBoolean)
  );
}

export function isSaveWalletSnapshotCommandInput(value: unknown): value is SaveWalletSnapshotCommandInput {
  return isRecord(value) && isOptional(value.reason, isString);
}

export function isRestoreWalletSnapshotCommandInput(value: unknown): value is RestoreWalletSnapshotCommandInput {
  return (
    isRecord(value) &&
    isOptional(value.walletId, isString) &&
    isOptional(value.snapshotHash, isString) &&
    isOptional(value.reason, isString)
  );
}

export function isRefreshWalletAuditCommandInput(value: unknown): value is RefreshWalletAuditCommandInput {
  return isRecord(value) && isOptionalLimitedNumber(value.limit, 1, 100);
}

export function isSearchAuditEventsCommandInput(value: unknown): value is SearchAuditEventsCommandInput {
  return (
    isRecord(value) &&
    isOptional(value.query, isString) &&
    isOptional(value.actor, isString) &&
    isOptional(value.action, isString) &&
    isOptional(value.resource, isString) &&
    isOptional(value.decision, isString) &&
    isOptional(value.grantId, isString) &&
    isOptionalLimitedNumber(value.limit, 1, 100) &&
    [value.query, value.actor, value.action, value.resource, value.decision, value.grantId].some(
      (item) => isString(item) && item.trim().length > 0
    )
  );
}

export function isSummarizeAuditEventsCommandInput(value: unknown): value is SummarizeAuditEventsCommandInput {
  return (
    isRecord(value) &&
    isOptional(value.query, isString) &&
    isOptional(value.actor, isString) &&
    isOptional(value.action, isString) &&
    isOptional(value.resource, isString) &&
    isOptional(value.decision, isString) &&
    isOptional(value.grantId, isString) &&
    isOptionalLimitedNumber(value.limit, 1, 100)
  );
}

export function isAuditEventReferenceCommandInput(value: unknown): value is AuditEventReferenceCommandInput {
  return isRecord(value) && isString(value.eventId) && value.eventId.trim().length > 0;
}

export const commandSchemas = {
  navigate: {
    name: "navigate",
    description: "Move the app to a registered route.",
    inputSchema: objectSchema({ route: { type: "string", enum: routeIds } }, ["route"]),
    outputSchema: commandOutputSchema,
    isInput: isNavigateCommandInput,
    isOutput: isCommandOutput
  },
  read_surface_context: {
    name: "read_surface_context",
    description: "Read public or approved contextual state for the current app surface.",
    inputSchema: objectSchema({
      route: { type: "string", enum: routeIds },
      includePrivateContext: booleanProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isReadSurfaceContextCommandInput,
    isOutput: isCommandOutput
  },
  search_211_services: {
    name: "search_211_services",
    description: "Search the local 211 corpus for service records.",
    inputSchema: objectSchema({
      query: stringProperty,
      limit: numberProperty,
      city: stringProperty,
      category: stringProperty
    }, ["query"]),
    outputSchema: commandOutputSchema,
    isInput: isSearch211ServicesCommandInput,
    isOutput: isCommandOutput
  },
  answer_211_question: {
    name: "answer_211_question",
    description: "Answer a question using grounded local 211 corpus evidence.",
    inputSchema: objectSchema({
      question: stringProperty,
      useLocalModel: booleanProperty
    }, ["question"]),
    outputSchema: commandOutputSchema,
    isInput: isAnswer211QuestionCommandInput,
    isOutput: isCommandOutput
  },
  open_service_detail: {
    name: "open_service_detail",
    description: "Open a specific service record detail surface.",
    inputSchema: objectSchema({ docId: stringProperty }, ["docId"]),
    outputSchema: commandOutputSchema,
    isInput: isOpenServiceDetailCommandInput,
    isOutput: isCommandOutput
  },
  save_service: {
    name: "save_service",
    description: "Save a service to the user's wallet-backed service list.",
    inputSchema: objectSchema({
      serviceId: stringProperty,
      note: stringProperty,
      title: stringProperty,
      providerName: stringProperty,
      programName: stringProperty,
      sourceUrl: stringProperty,
      sourceContentCid: stringProperty,
      sourcePageCid: stringProperty,
      label: stringProperty,
      reason: stringProperty,
      priority: stringProperty
    }, ["serviceId"]),
    outputSchema: commandOutputSchema,
    isInput: isSaveServiceCommandInput,
    isOutput: isCommandOutput
  },
  create_service_plan: {
    name: "create_service_plan",
    description: "Create a follow-up plan for a selected service.",
    inputSchema: objectSchema({
      serviceId: stringProperty,
      goal: stringProperty,
      steps: stringArrayProperty,
      documentsNeeded: stringArrayProperty,
      questionsToAsk: stringArrayProperty,
      appointmentAt: stringProperty,
      reminderAt: stringProperty,
      travelTarget: stringProperty,
      assignedWorkerRecipientId: stringProperty,
      title: stringProperty,
      providerName: stringProperty,
      sourceContentCid: stringProperty,
      sourcePageCid: stringProperty
    }, ["serviceId", "goal"]),
    outputSchema: commandOutputSchema,
    isInput: isCreateServicePlanCommandInput,
    isOutput: isCommandOutput
  },
  add_service_plan_checklist_item: {
    name: "add_service_plan_checklist_item",
    description: "Add one checklist item to a service plan after confirmation.",
    inputSchema: objectSchema({
      planId: stringProperty,
      item: stringProperty,
      checklist: { type: "string", enum: servicePlanChecklistNames }
    }, ["planId", "item", "checklist"]),
    outputSchema: commandOutputSchema,
    isInput: isAddServicePlanChecklistItemCommandInput,
    isOutput: isCommandOutput
  },
  set_service_plan_reminder: {
    name: "set_service_plan_reminder",
    description: "Set a reminder or appointment time on a service plan after confirmation.",
    inputSchema: objectSchema({
      planId: stringProperty,
      reminderAt: stringProperty,
      appointmentAt: stringProperty
    }, ["planId", "reminderAt"]),
    outputSchema: commandOutputSchema,
    isInput: isSetServicePlanReminderCommandInput,
    isOutput: isCommandOutput
  },
  record_service_interaction: {
    name: "record_service_interaction",
    description: "Record a service contact, handoff, appointment, or follow-up interaction after confirmation.",
    inputSchema: objectSchema({
      serviceId: stringProperty,
      interactionType: stringProperty,
      channel: stringProperty,
      providerName: stringProperty,
      programName: stringProperty,
      counterpartyName: stringProperty,
      counterpartyContact: stringProperty,
      timestamp: stringProperty,
      status: stringProperty,
      outcome: stringProperty,
      notesRecordId: stringProperty,
      nextAction: stringProperty,
      nextFollowUpAt: stringProperty,
      sourceActionUrl: stringProperty,
      sourceContentCid: stringProperty,
      sourcePageCid: stringProperty,
      relatedGrantIds: stringArrayProperty,
      relatedRecordIds: stringArrayProperty,
      privacyLevel: stringProperty
    }, ["serviceId", "interactionType"]),
    outputSchema: commandOutputSchema,
    isInput: isRecordServiceInteractionCommandInput,
    isOutput: isCommandOutput
  },
  update_registration_draft: {
    name: "update_registration_draft",
    description: "Update non-legal-name registration draft fields.",
    inputSchema: objectSchema({
      preferredName: stringProperty,
      pronouns: stringProperty,
      phone: stringProperty,
      email: stringProperty,
      currentLocation: stringProperty,
      shelterAffiliation: stringProperty,
      serviceNeeds: stringArrayProperty,
      preferredCheckInChannels: { type: "array", items: { type: "string", enum: checkInChannels } }
    }),
    outputSchema: commandOutputSchema,
    isInput: isUpdateRegistrationDraftCommandInput,
    isOutput: isCommandOutput
  },
  update_check_in_policy: {
    name: "update_check_in_policy",
    description: "Update check-in reminder cadence and escalation settings.",
    inputSchema: objectSchema({
      intervalDays: numberProperty,
      reminderChannels: { type: "array", items: { type: "string", enum: checkInChannels } },
      gracePeriodHours: numberProperty,
      escalationEnabled: booleanProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isUpdateCheckInPolicyCommandInput,
    isOutput: isCommandOutput
  },
  add_recipient: {
    name: "add_recipient",
    description: "Add a contact or sharing recipient to the wallet draft.",
    inputSchema: objectSchema({
      displayName: stringProperty,
      type: { type: "string", enum: disclosureRecipientTypes },
      relationship: stringProperty,
      email: stringProperty,
      phone: stringProperty,
      agencyName: stringProperty,
      precinctName: stringProperty,
      verified: booleanProperty,
      allowedScopes: { type: "array", items: { type: "string", enum: disclosureScopes } }
    }, ["displayName"]),
    outputSchema: commandOutputSchema,
    isInput: isAddRecipientCommandInput,
    isOutput: isCommandOutput
  },
  edit_recipient: {
    name: "edit_recipient",
    description: "Edit saved contact recipient fields or sharing scopes.",
    inputSchema: objectSchema({
      recipientId: stringProperty,
      displayName: stringProperty,
      type: { type: "string", enum: disclosureRecipientTypes },
      relationship: stringProperty,
      email: stringProperty,
      phone: stringProperty,
      agencyName: stringProperty,
      precinctName: stringProperty,
      verified: booleanProperty,
      allowedScopes: { type: "array", items: { type: "string", enum: disclosureScopes } }
    }, ["recipientId"]),
    outputSchema: commandOutputSchema,
    isInput: isEditRecipientCommandInput,
    isOutput: isCommandOutput
  },
  remove_recipient: {
    name: "remove_recipient",
    description: "Remove a saved contact recipient after confirmation.",
    inputSchema: objectSchema({ recipientId: stringProperty, reason: stringProperty }, ["recipientId"]),
    outputSchema: commandOutputSchema,
    isInput: isRemoveRecipientCommandInput,
    isOutput: isCommandOutput
  },
  update_recipient_scopes: {
    name: "update_recipient_scopes",
    description: "Stage and apply updated sharing scopes for a recipient after confirmation.",
    inputSchema: objectSchema({
      recipientId: stringProperty,
      allowedScopes: { type: "array", items: { type: "string", enum: disclosureScopes } },
      stageOnly: booleanProperty
    }, ["recipientId", "allowedScopes"]),
    outputSchema: commandOutputSchema,
    isInput: isUpdateRecipientScopesCommandInput,
    isOutput: isCommandOutput
  },
  preview_sharing_capabilities: {
    name: "preview_sharing_capabilities",
    description: "Preview capabilities implied by disclosure scopes without changing wallet state.",
    inputSchema: objectSchema({
      recipientId: stringProperty,
      allowedScopes: { type: "array", items: { type: "string", enum: disclosureScopes } }
    }),
    outputSchema: commandOutputSchema,
    isInput: isPreviewSharingCapabilitiesCommandInput,
    isOutput: isCommandOutput
  },
  request_shelter_contact: {
    name: "request_shelter_contact",
    description: "Stage a contact request from the user to a shelter.",
    inputSchema: objectSchema({
      shelterName: stringProperty,
      userName: stringProperty,
      userContact: stringProperty
    }, ["shelterName"]),
    outputSchema: commandOutputSchema,
    isInput: isRequestShelterContactCommandInput,
    isOutput: isCommandOutput
  },
  approve_shelter_contact_request: {
    name: "approve_shelter_contact_request",
    description: "Approve a pending shelter contact request and add the shelter contact.",
    inputSchema: objectSchema({ requestId: stringProperty, reason: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isShelterContactRequestDecisionCommandInput,
    isOutput: isCommandOutput
  },
  deny_shelter_contact_request: {
    name: "deny_shelter_contact_request",
    description: "Deny a pending shelter contact request.",
    inputSchema: objectSchema({ requestId: stringProperty, reason: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isShelterContactRequestDecisionCommandInput,
    isOutput: isCommandOutput
  },
  create_managed_user_account: {
    name: "create_managed_user_account",
    description: "Stage a shelter-managed user account using the shelter UI account contract.",
    inputSchema: objectSchema({
      shelter: stringProperty,
      staffId: stringProperty,
      legalName: stringProperty,
      preferredName: stringProperty,
      pronouns: stringProperty,
      dateOfBirth: stringProperty,
      photoAssetId: stringProperty,
      phone: stringProperty,
      email: stringProperty,
      currentLocation: stringProperty,
      preferredShelter: stringProperty,
      serviceNeeds: stringArrayProperty,
      easyBotCheckStatus: { type: "string", enum: easyBotCheckStatuses },
      captchaToken: stringProperty,
      localPrecinctNotified: booleanProperty,
      foundPermanentHousing: booleanProperty
    }, ["shelter", "staffId", "legalName", "photoAssetId"]),
    outputSchema: commandOutputSchema,
    isInput: isCreateManagedUserAccountCommandInput,
    isOutput: isCommandOutput
  },
  create_shelter_staff_account: {
    name: "create_shelter_staff_account",
    description: "Stage a shelter staff account using the shelter UI staff account contract.",
    inputSchema: objectSchema({
      shelter: stringProperty,
      operatorStaffId: stringProperty,
      displayName: stringProperty,
      email: stringProperty
    }, ["shelter", "operatorStaffId", "displayName"]),
    outputSchema: commandOutputSchema,
    isInput: isCreateShelterStaffAccountCommandInput,
    isOutput: isCommandOutput
  },
  send_shelter_nudge: {
    name: "send_shelter_nudge",
    description: "Stage a shelter-to-user contact request from a verified shelter operator.",
    inputSchema: objectSchema({
      shelter: stringProperty,
      staffId: stringProperty,
      userName: stringProperty,
      userContact: stringProperty
    }, ["shelter", "staffId", "userName", "userContact"]),
    outputSchema: commandOutputSchema,
    isInput: isSendShelterNudgeCommandInput,
    isOutput: isCommandOutput
  },
  approve_user_shelter_request: {
    name: "approve_user_shelter_request",
    description: "Approve a pending user-to-shelter contact request and add the shelter recipient.",
    inputSchema: objectSchema({ requestId: stringProperty, reason: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isUserShelterRequestDecisionCommandInput,
    isOutput: isCommandOutput
  },
  deny_user_shelter_request: {
    name: "deny_user_shelter_request",
    description: "Deny a pending user-to-shelter contact request.",
    inputSchema: objectSchema({ requestId: stringProperty, reason: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isUserShelterRequestDecisionCommandInput,
    isOutput: isCommandOutput
  },
  add_shelter_as_recipient: {
    name: "add_shelter_as_recipient",
    description: "Add a shelter staff recipient using the shelter UI recipient contract.",
    inputSchema: objectSchema({ shelterName: stringProperty, staffName: stringProperty }, ["shelterName"]),
    outputSchema: commandOutputSchema,
    isInput: isAddShelterAsRecipientCommandInput,
    isOutput: isCommandOutput
  },
  summarize_upload_requirements: {
    name: "summarize_upload_requirements",
    description: "Guide a user through selecting documents to upload without reading local files.",
    inputSchema: objectSchema({
      goal: stringProperty,
      documentType: stringProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isSummarizeUploadRequirementsCommandInput,
    isOutput: isCommandOutput
  },
  classify_uploaded_document: {
    name: "classify_uploaded_document",
    description: "Classify metadata for a document after the user selected it through an upload event.",
    inputSchema: objectSchema({
      uploadId: stringProperty,
      recordId: stringProperty,
      fileName: stringProperty,
      mimeType: stringProperty,
      machineSummary: stringProperty,
      userSelected: booleanProperty,
      categoryHint: { type: "string", enum: UPLOAD_DOCUMENT_CATEGORIES }
    }, ["userSelected"]),
    outputSchema: commandOutputSchema,
    isInput: isClassifyUploadedDocumentCommandInput,
    isOutput: isCommandOutput
  },
  repair_upload_storage: {
    name: "repair_upload_storage",
    description: "Repair wallet storage for an already uploaded record.",
    inputSchema: objectSchema({
      uploadId: stringProperty,
      recordId: stringProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isRepairUploadStorageCommandInput,
    isOutput: isCommandOutput
  },
  toggle_upload_shared: {
    name: "toggle_upload_shared",
    description: "Change whether an uploaded document is marked as shareable after confirmation.",
    inputSchema: objectSchema({
      uploadId: stringProperty,
      shared: booleanProperty,
      reason: stringProperty
    }, ["uploadId", "shared"]),
    outputSchema: commandOutputSchema,
    isInput: isToggleUploadSharedCommandInput,
    isOutput: isCommandOutput
  },
  set_disclosure_scopes: {
    name: "set_disclosure_scopes",
    description: "Set which disclosure scopes a recipient may access.",
    inputSchema: objectSchema({
      recipientId: stringProperty,
      allowedScopes: { type: "array", items: { type: "string", enum: disclosureScopes } }
    }, ["recipientId", "allowedScopes"]),
    outputSchema: commandOutputSchema,
    isInput: isSetDisclosureScopesCommandInput,
    isOutput: isCommandOutput
  },
  record_controller_approval: {
    name: "record_controller_approval",
    description: "Record one required controller approval toward an access request threshold.",
    inputSchema: objectSchema({ requestId: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isRecordControllerApprovalCommandInput,
    isOutput: isCommandOutput
  },
  approve_access_request: {
    name: "approve_access_request",
    description: "Approve a pending wallet access request.",
    inputSchema: objectSchema({ requestId: stringProperty, reason: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isAccessRequestDecisionCommandInput,
    isOutput: isCommandOutput
  },
  reject_access_request: {
    name: "reject_access_request",
    description: "Reject a pending wallet access request.",
    inputSchema: objectSchema({ requestId: stringProperty, reason: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isAccessRequestDecisionCommandInput,
    isOutput: isCommandOutput
  },
  revoke_access_request: {
    name: "revoke_access_request",
    description: "Revoke an active wallet access grant created from an access request.",
    inputSchema: objectSchema({ requestId: stringProperty, reason: stringProperty }, ["requestId"]),
    outputSchema: commandOutputSchema,
    isInput: isRevokeAccessRequestCommandInput,
    isOutput: isCommandOutput
  },
  analyze_granted_record: {
    name: "analyze_granted_record",
    description: "Create an allowed derived analysis artifact from a record covered by an active grant.",
    inputSchema: objectSchema({
      grantId: stringProperty,
      receiptId: stringProperty,
      recordId: stringProperty,
      mode: { type: "string", enum: RECIPIENT_ANALYSIS_MODES },
      maxChars: numberProperty,
      maxBytes: numberProperty,
      chunkSizeWords: numberProperty,
      maxFields: numberProperty,
      useOcr: booleanProperty,
      userPresent: booleanProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isAnalyzeGrantedRecordCommandInput,
    isOutput: isCommandOutput
  },
  view_granted_record: {
    name: "view_granted_record",
    description: "View plaintext for a record covered by an active grant with decrypt ability.",
    inputSchema: objectSchema({
      grantId: stringProperty,
      receiptId: stringProperty,
      recordId: stringProperty,
      userPresent: booleanProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isViewGrantedRecordCommandInput,
    isOutput: isCommandOutput
  },
  delegate_grant: {
    name: "delegate_grant",
    description: "Delegate one allowed ability from an active grant to another recipient DID.",
    inputSchema: objectSchema({
      grantId: stringProperty,
      receiptId: stringProperty,
      audienceDid: stringProperty,
      audienceKeyHex: stringProperty,
      ability: stringProperty,
      purpose: stringProperty,
      expiresAt: stringProperty,
      resources: stringArrayProperty
    }, ["audienceDid"]),
    outputSchema: commandOutputSchema,
    isInput: isDelegateGrantCommandInput,
    isOutput: isCommandOutput
  },
  create_location_region_proof: {
    name: "create_location_region_proof",
    description: "Create a verifier-scoped proof about being within a location region.",
    inputSchema: objectSchema({
      verifier: stringProperty,
      regionLabel: stringProperty,
      claim: stringProperty,
      witnessLabel: stringProperty,
      grantId: stringProperty,
      recordId: stringProperty
    }, ["verifier", "regionLabel"]),
    outputSchema: commandOutputSchema,
    isInput: isCreateLocationRegionProofCommandInput,
    isOutput: isCommandOutput
  },
  create_proof: {
    name: "create_proof",
    description: "Stage proof creation from an explicit claim, verifier, and witness label.",
    inputSchema: objectSchema({
      claim: stringProperty,
      verifier: stringProperty,
      witnessLabel: stringProperty,
      proofType: stringProperty,
      regionLabel: stringProperty,
      recordId: stringProperty,
      grantId: stringProperty,
      publicInputs: stringRecordProperty
    }, ["claim", "verifier", "witnessLabel"]),
    outputSchema: commandOutputSchema,
    isInput: isCreateProofCommandInput,
    isOutput: isCommandOutput
  },
  explain_proof_receipt: {
    name: "explain_proof_receipt",
    description: "Explain a proof receipt using only public receipt fields and wallet-safe metadata.",
    inputSchema: objectSchema({
      proofId: stringProperty,
      receiptId: stringProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isProofReceiptReferenceCommandInput,
    isOutput: isCommandOutput
  },
  verify_proof_status: {
    name: "verify_proof_status",
    description: "Report the current verification status for a proof receipt.",
    inputSchema: objectSchema({
      proofId: stringProperty,
      receiptId: stringProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isProofReceiptReferenceCommandInput,
    isOutput: isCommandOutput
  },
  create_verified_export_bundle: {
    name: "create_verified_export_bundle",
    description: "Create a shareable export bundle from selected wallet records and proofs.",
    inputSchema: objectSchema({
      audienceName: stringProperty,
      audienceDid: stringProperty,
      recordIds: stringArrayProperty,
      proofIds: stringArrayProperty,
      purpose: stringProperty,
      includeDerivedArtifacts: booleanProperty,
      includeProofs: booleanProperty,
      stageOnly: booleanProperty
    }, ["audienceName", "recordIds"]),
    outputSchema: commandOutputSchema,
    isInput: isCreateVerifiedExportBundleCommandInput,
    isOutput: isCommandOutput
  },
  import_export_bundle: {
    name: "import_export_bundle",
    description: "Import a verified export bundle descriptor without exposing plaintext records.",
    inputSchema: objectSchema({
      bundleId: stringProperty,
      bundle: { type: "object", additionalProperties: true },
      audienceName: stringProperty,
      stageOnly: booleanProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isImportExportBundleCommandInput,
    isOutput: isCommandOutput
  },
  select_analytics_study: {
    name: "select_analytics_study",
    description: "Select an analytics study for staged consent without submitting wallet consent.",
    inputSchema: objectSchema({ studyId: stringProperty }, ["studyId"]),
    outputSchema: commandOutputSchema,
    isInput: isRequiredAnalyticsStudyReferenceCommandInput,
    isOutput: isCommandOutput
  },
  unselect_analytics_study: {
    name: "unselect_analytics_study",
    description: "Remove an analytics study from staged consent without changing submitted wallet consents.",
    inputSchema: objectSchema({ studyId: stringProperty }, ["studyId"]),
    outputSchema: commandOutputSchema,
    isInput: isRequiredAnalyticsStudyReferenceCommandInput,
    isOutput: isCommandOutput
  },
  explain_analytics_privacy_budget: {
    name: "explain_analytics_privacy_budget",
    description: "Explain analytics epsilon budgets, cohort floors, and safe derived fields without raw documents.",
    inputSchema: objectSchema({ studyId: stringProperty }),
    outputSchema: commandOutputSchema,
    isInput: isAnalyticsStudyReferenceCommandInput,
    isOutput: isCommandOutput
  },
  submit_analytics_consent: {
    name: "submit_analytics_consent",
    description: "Submit analytics consent from a selected template after confirmation without exposing raw documents.",
    inputSchema: objectSchema({
      studyId: stringProperty,
      expiresAt: stringProperty,
      stageOnly: booleanProperty
    }, ["studyId"]),
    outputSchema: commandOutputSchema,
    isInput: isSubmitAnalyticsConsentCommandInput,
    isOutput: isCommandOutput
  },
  save_wallet_snapshot: {
    name: "save_wallet_snapshot",
    description: "Save an encrypted wallet snapshot after high-risk confirmation.",
    inputSchema: objectSchema({ reason: stringProperty }),
    outputSchema: commandOutputSchema,
    isInput: isSaveWalletSnapshotCommandInput,
    isOutput: isCommandOutput
  },
  restore_wallet_snapshot: {
    name: "restore_wallet_snapshot",
    description: "Restore an encrypted wallet snapshot after high-risk confirmation.",
    inputSchema: objectSchema({
      walletId: stringProperty,
      snapshotHash: stringProperty,
      reason: stringProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isRestoreWalletSnapshotCommandInput,
    isOutput: isCommandOutput
  },
  refresh_wallet_audit: {
    name: "refresh_wallet_audit",
    description: "Refresh wallet audit events.",
    inputSchema: objectSchema({ limit: numberProperty }),
    outputSchema: commandOutputSchema,
    isInput: isRefreshWalletAuditCommandInput,
    isOutput: isCommandOutput
  },
  search_audit_events: {
    name: "search_audit_events",
    description: "Search wallet audit events using safe event metadata without exposing private notes.",
    inputSchema: objectSchema({
      query: stringProperty,
      actor: stringProperty,
      action: stringProperty,
      resource: stringProperty,
      decision: stringProperty,
      grantId: stringProperty,
      limit: numberProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isSearchAuditEventsCommandInput,
    isOutput: isCommandOutput
  },
  summarize_audit_events: {
    name: "summarize_audit_events",
    description: "Summarize wallet audit history from safe event metadata without exposing private notes.",
    inputSchema: objectSchema({
      query: stringProperty,
      actor: stringProperty,
      action: stringProperty,
      resource: stringProperty,
      decision: stringProperty,
      grantId: stringProperty,
      limit: numberProperty
    }),
    outputSchema: commandOutputSchema,
    isInput: isSummarizeAuditEventsCommandInput,
    isOutput: isCommandOutput
  },
  explain_audit_event: {
    name: "explain_audit_event",
    description: "Explain one audit event from safe event metadata without exposing private notes.",
    inputSchema: objectSchema({ eventId: stringProperty }, ["eventId"]),
    outputSchema: commandOutputSchema,
    isInput: isAuditEventReferenceCommandInput,
    isOutput: isCommandOutput
  }
} satisfies Record<AgentCommandName, AgentCommandSchema>;

export function validateCommandSchemas(): string[] {
  const errors: string[] = [];

  for (const name of AGENT_COMMAND_NAMES) {
    const schema = commandSchemas[name];
    if (!isAgentCommandSchema(schema)) {
      errors.push(`Invalid agent command schema: ${name}`);
      continue;
    }
    if (schema.name !== name) {
      errors.push(`Command schema key ${name} has mismatched name ${schema.name}.`);
    }
  }

  for (const name of Object.keys(commandSchemas)) {
    if (!isAgentCommandName(name)) {
      errors.push(`Unexpected agent command schema: ${name}`);
    }
  }

  return errors;
}

export function isAgentCommandName(value: unknown): value is AgentCommandName {
  return isString(value) && AGENT_COMMAND_NAMES.includes(value as AgentCommandName);
}

export function getCommandSchema(name: AgentCommandName): AgentCommandSchema {
  return commandSchemas[name];
}

export function isCommandInput(name: AgentCommandName, value: unknown): boolean {
  return commandSchemas[name].isInput(value);
}

export function isCommandOutputFor(name: AgentCommandName, value: unknown): value is CommandOutput {
  return commandSchemas[name].isOutput(value);
}

export { isCommandOutput };
