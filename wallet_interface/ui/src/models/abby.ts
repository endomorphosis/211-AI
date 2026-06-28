export type RouteId =
  | "home"
  | "register"
  | "check-in"
  | "calendar"
  | "messages"
  | "contacts"
  | "sharing-rules"
  | "uploads"
  | "settings"
  | "social-services"
  | "interactions"
  | "shelter"
  | "provider-clients"
  | "provider-cases"
  | "provider-messages"
  | "provider-analytics"
  | "provider-proofs"
  | "provider-operations"
  | "recipient-access"
  | "benefits-protection"
  | "analytics"
  | "proof-center"
  | "exports"
  | "security"
  | "audit";

export type CheckInChannel = "email" | "sms" | "web";

export type DisclosureRecipientType =
  | "emergency_contact"
  | "police_precinct"
  | "social_worker"
  | "shelter_staff"
  | "government_liaison"
  | "benefits_agency";

export type DisclosureDataScope =
  | "identity_minimum"
  | "profile"
  | "photo"
  | "current_location"
  | "uploaded_documents"
  | "missed_check_in"
  | "found_permanent_housing"
  | "medical_notes"
  | "shelter_history"
  | "benefits_information"
  | "custom";

export type EasyBotCheckStatus = "pending" | "passed" | "failed";

export interface RegistrationProfileDraft {
  legalName: string;
  preferredName: string;
  pronouns: string;
  dateOfBirth: string;
  photoAssetId: string;
  phone: string;
  email: string;
  currentLocation: string;
  shelterAffiliation: string;
  serviceNeeds: string[];
  servicePartnerHelpRequested: boolean;
  servicePartnerHelpRequestedAt: string;
  preferredCheckInChannels: CheckInChannel[];
  easyBotCheckStatus: EasyBotCheckStatus;
  captchaToken: string;
}

export interface CheckInPolicyDraft {
  intervalDays: number;
  reminderChannels: CheckInChannel[];
  gracePeriodHours: number;
  escalationEnabled: boolean;
  lastCheckInAt: string;
}

export interface DisclosureRecipientDraft {
  id: string;
  type: DisclosureRecipientType;
  displayName: string;
  relationship: string;
  email: string;
  phone: string;
  agencyName: string;
  precinctName: string;
  verified: boolean;
  allowedScopes: DisclosureDataScope[];
}

export type ShelterContactRequestDirection = "shelter_to_user" | "user_to_shelter";

export type ShelterContactRequestStatus = "pending" | "approved" | "denied" | "canceled";

export interface ShelterContactRequest {
  id: string;
  direction: ShelterContactRequestDirection;
  status: ShelterContactRequestStatus;
  shelterName: string;
  userName: string;
  userContact: string;
  staffId?: string;
  staffName?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface UploadItem {
  id: string;
  recordId?: string;
  fileName: string;
  createdAt?: string;
  createdAtRaw?: string;
  machineSummary: string;
  category: string;
  sensitivity: "low" | "moderate" | "high" | "restricted";
  status: "stored" | "encrypting" | "failed";
  storageOk?: boolean;
  shared: boolean;
  sharingMode?: "private" | "public" | "selected_contacts";
  allowedRecipientIds?: string[];
  decentralizedStorageStatus?: "not_configured" | "ready" | "uploading" | "stored" | "failed";
  decentralizedStorageProvider?: "ipfs" | "filecoin" | "ipfs-filecoin" | "walrus" | "wallet-api" | "local";
  decryptedClassification?: string;
  decryptedLabels?: string[];
  decryptedMimeType?: string;
  encryptedMetadataCid?: string;
  encryptedPayloadCid?: string;
  ipfsCid?: string;
  ipfsGatewayUrl?: string;
  ipfsRootCid?: string;
  ipldLinks?: Array<{ "/"?: string; cid?: string; mediaType?: string; name: string }>;
  metadataCid?: string;
  metadataFilecoinPinRequestId?: string;
  metadataFilecoinPinStatus?: "queued" | "pinning" | "pinned" | "failed";
  metadataFilecoinPinStatusUrl?: string;
  metadataGatewayUrl?: string;
  metadataIpldCid?: string;
  metadataIpldLink?: { "/"?: string; cid?: string; mediaType?: string; name: string };
  metadataStorageMessage?: string;
  filecoinPieceCid?: string;
  filecoinDealId?: string;
  filecoinPinRequestId?: string;
  filecoinPinStatus?: "queued" | "pinning" | "pinned" | "failed";
  filecoinPinStatusUrl?: string;
  walrusBlobId?: string;
  walrusEndEpoch?: number;
  walrusGatewayUrl?: string;
  walrusObjectId?: string;
  walrusStorageCost?: number;
  walrusTxDigest?: string;
  decentralizedStorageMessage?: string;
  privacyProfileStatus?: "not_started" | "profiling" | "profiled" | "failed";
  privacyProfileClassification?: string;
  privacyProfileLabels?: string[];
  privacyProfileSummary?: string;
  privacyProfileMimeType?: string;
  privacyProfileProofId?: string;
  privacyProfileArtifactIds?: string[];
  privacyProfileMessage?: string;
  privacyProfilePublicInputs?: Record<string, unknown>;
  privacyProfileSearchText?: string;
  privacyProfileNeedsRefresh?: boolean;
  privacyProfileVectorTerms?: string[];
}

export interface ServiceMatch {
  id: string;
  name: string;
  category: string;
  distance: string;
  availability: string;
}

export interface SavedService {
  saved_service_id: string;
  wallet_id: string;
  service_doc_id: string;
  source_content_cid: string;
  source_page_cid: string;
  title: string;
  provider_name: string;
  program_name: string;
  source_url: string;
  label: string;
  reason: string;
  priority: string;
  status: string;
  created_at: string;
  updated_at: string;
  private_notes_record_id: string;
  metadata: Record<string, unknown>;
}

export interface ServicePlan {
  plan_id: string;
  wallet_id: string;
  service_doc_id: string;
  source_content_cid: string;
  source_page_cid: string;
  service_title: string;
  provider_name: string;
  goal: string;
  steps: string[];
  documents_needed: string[];
  questions_to_ask: string[];
  appointment_at: string;
  reminder_at: string;
  travel_target: string;
  assigned_worker_recipient_id: string;
  status: string;
  related_interaction_ids: string[];
  private_notes_record_id: string;
  created_at: string;
  updated_at: string;
}

export interface ServiceInteractionEvent {
  interaction_id: string;
  wallet_id: string;
  service_doc_id: string;
  source_content_cid: string;
  source_page_cid: string;
  provider_name: string;
  program_name: string;
  interaction_type: string;
  channel: string;
  actor_did: string;
  counterparty_name: string;
  counterparty_contact: string;
  timestamp: string;
  status: string;
  outcome: string;
  notes_record_id: string;
  next_action: string;
  next_follow_up_at: string;
  source_action_url: string;
  related_grant_ids: string[];
  related_record_ids: string[];
  privacy_level: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  timestamp: string;
  resource?: string;
  decision?: string;
  grantId?: string;
}

export interface AnalyticsStudy {
  id: string;
  title: string;
  purpose: string;
  fields: string[];
  minCohortSize: number;
  epsilonBudget: number;
  spentBudget: number;
  status: "available" | "consented" | "draft" | "approved" | "paused" | "retired" | string;
}

export interface WalletAccessRequest {
  id: string;
  requesterName: string;
  requesterDid: string;
  audienceDid: string;
  resourceLabel: string;
  abilities: string[];
  purpose: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  createdAt: string;
  approvalRequired?: boolean;
  approvalId?: string;
  approvalStatus?: "pending" | "approved" | "rejected" | string;
  approvalThreshold?: number;
  approvalCount?: number;
  grantStatus?: "active" | "revoked";
}

export interface WalletGrantReceipt {
  id: string;
  grantId: string;
  audienceName: string;
  audienceDid: string;
  resources: string[];
  recordId?: string;
  resourceLabel: string;
  abilities: string[];
  purpose: string;
  caveats?: Record<string, unknown>;
  receiptHash: string;
  status: "active" | "revoked";
  createdAt: string;
  expiresAt?: string;
}

export interface DerivedArtifactView {
  id: string;
  sourceRecordIds: string[];
  artifactType: string;
  outputPolicy: string;
  encryptedPayloadRef: string;
  createdAt: string;
}

export interface DerivedAnalysisResultView {
  artifact: DerivedArtifactView;
  output: Record<string, unknown>;
}

export interface DecryptedRecordView {
  recordId: string;
  text: string;
  base64?: string;
  sizeBytes: number;
}

export interface ProofReceiptView {
  id: string;
  proofType: string;
  claim: string;
  verifier: string;
  proofSystem: string;
  verificationStatus: string;
  circuitId?: string;
  verifierDigest?: string;
  proofArtifactRef?: string;
  publicInputs: Record<string, string>;
  witnessLabel: string;
  simulated: boolean;
  createdAt: string;
}

export interface ExportBundleView {
  id: string;
  bundleId: string;
  bundleHash: string;
  audienceName: string;
  bundle?: Record<string, unknown>;
  recordCount: number;
  proofCount: number;
  verificationOk: boolean;
  hashOk: boolean;
  schemaOk: boolean;
  schemaError?: string;
  storageOk: boolean;
  imported: boolean;
  createdAt: string;
}
