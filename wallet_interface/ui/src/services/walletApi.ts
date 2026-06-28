import {
  AuditEvent,
  AnalyticsStudy,
  DecryptedRecordView,
  DerivedAnalysisResultView,
  DerivedArtifactView,
  ExportBundleView,
  ProofReceiptView,
  SavedService,
  ServiceInteractionEvent,
  ServicePlan,
  UploadItem,
  WalletAccessRequest,
  WalletGrantReceipt
} from "../models/abby";

interface AccessRequestApiRecord {
  request_id: string;
  requester_did: string;
  audience_did: string;
  resources: string[];
  abilities: string[];
  purpose: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  created_at: string;
  approval_required?: boolean;
  approval_id?: string | null;
  approval_status?: string | null;
  approval_threshold?: number | null;
  approval_count?: number;
  grant_status?: "active" | "revoked" | null;
  consensus?: unknown;
  metadata?: Record<string, unknown>;
}

interface AccessRequestApiResponse {
  requests: AccessRequestApiRecord[];
}

interface GrantReceiptApiRecord {
  receipt_id: string;
  grant_id: string;
  audience_did: string;
  resources: string[];
  abilities: string[];
  purpose: string | null;
  caveats?: Record<string, unknown>;
  receipt_hash: string;
  status: "active" | "revoked";
  created_at: string;
  expires_at?: string | null;
  consensus?: unknown;
  metadata?: Record<string, unknown>;
}

interface GrantReceiptApiResponse {
  receipts: GrantReceiptApiRecord[];
}

interface AuditEventApiRecord {
  event_id?: string;
  created_at: string;
  actor_did: string;
  action: string;
  resource: string;
  decision: string;
  grant_id?: string | null;
  consensus?: unknown;
  metadata?: Record<string, unknown>;
}

interface AuditEventApiResponse {
  events: AuditEventApiRecord[];
}

interface WalletRecordApiRecord {
  record_id: string;
  data_type: string;
  sensitivity: "low" | "moderate" | "high" | "restricted";
  public_descriptor: string;
  status: string;
  created_at: string;
  consensus?: unknown;
  metadata?: Record<string, unknown>;
}

interface WalletRecordsApiResponse {
  records: WalletRecordApiRecord[];
}

interface SavedServicesApiResponse {
  saved_services: SavedService[];
}

interface ServicePlansApiResponse {
  plans: ServicePlan[];
}

interface ServiceInteractionsApiResponse {
  interactions: ServiceInteractionEvent[];
}

export interface ProofReceiptApiRecord {
  proof_id: string;
  proof_type: string;
  statement?: Record<string, unknown>;
  verifier_id: string;
  public_inputs: Record<string, unknown>;
  proof_hash: string;
  witness_record_ids: string[];
  is_simulated: boolean;
  proof_system?: string;
  circuit_id?: string | null;
  verifier_digest?: string | null;
  proof_artifact_ref?: string | null;
  verification_status?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
  wallet_id?: string;
  witness_label?: string;
  consensus?: unknown;
}

interface ProofReceiptsApiResponse {
  proofs: ProofReceiptApiRecord[];
}

interface RecordStorageApiResponse {
  ok: boolean;
}

export interface StorageReplicaStatusView {
  uri: string;
  storage_type: string;
  role: string;
  ok: boolean;
  size_bytes?: number | null;
  sha256?: string | null;
  error?: string | null;
  repaired?: boolean;
}

export interface RecordStorageReportView {
  wallet_id: string;
  record_id: string;
  version_id: string;
  payload: StorageReplicaStatusView[];
  metadata: StorageReplicaStatusView[];
  ok: boolean;
  repaired?: boolean;
  created_at: string;
}

export interface WalletStorageReportView {
  wallet_id: string;
  record_count: number;
  reports: RecordStorageReportView[];
  ok: boolean;
  replica_count: number;
  failed_replica_count: number;
  repaired?: boolean;
  repaired_replica_count?: number;
  storage_types: Record<string, number>;
  created_at: string;
}

interface WalletSnapshotListApiResponse {
  wallet_ids: string[];
}

interface WalletSnapshotMutationApiResponse {
  wallet_id: string;
  path?: string;
  loaded?: boolean;
}

interface AnalyticsTemplateApiRecord {
  template_id: string;
  title: string;
  purpose: string;
  allowed_record_types: string[];
  allowed_derived_fields: string[];
  aggregation_policy: Record<string, unknown>;
  created_by: string;
  status: string;
  expires_at?: string | null;
}

interface AnalyticsTemplatesApiResponse {
  templates: AnalyticsTemplateApiRecord[];
}

interface AnalyticsConsentApiRecord {
  consent_id: string;
  wallet_id: string;
  template_id: string;
  allowed_record_types: string[];
  allowed_derived_fields: string[];
  aggregation_policy: Record<string, unknown>;
  created_at: string;
  expires_at?: string | null;
  revoked_at?: string | null;
  status: "active" | "revoked" | string;
}

interface AnalyticsConsentsApiResponse {
  consents: AnalyticsConsentApiRecord[];
}

export interface WalletGovernancePolicy {
  approver_dids?: string[];
  threshold?: number;
  sensitive_abilities?: string[];
  sensitive_operations?: string[];
  recovery_policy?: WalletRecoveryPolicy;
  [key: string]: unknown;
}

export interface WalletRecoveryPolicy {
  contact_dids: string[];
  threshold: number;
  status: "active" | "disabled" | string;
  updated_at?: string;
}

export interface WalletDetails {
  wallet_id: string;
  owner_did: string;
  controller_dids: string[];
  device_dids: string[];
  governance_policy: WalletGovernancePolicy;
  manifest_head?: string | null;
  updated_at?: string;
}

export interface WalletSnapshotVerification {
  wallet_id: string;
  path: string;
  exists: boolean;
  valid: boolean;
  format?: string;
  snapshot_hash?: string;
  computed_hash?: string;
  error?: string;
}

export interface WalletAnalyticsConsent {
  id: string;
  templateId: string;
  fields: string[];
  status: "active" | "revoked" | string;
  createdAt: string;
  expiresAt?: string;
  expiresAtRaw?: string;
}

interface DerivedArtifactApiResponse {
  artifact_id: string;
  source_record_ids: string[];
  artifact_type: string;
  output_policy: string;
  encrypted_payload_ref?: {
    uri?: string;
    storage_type?: string;
    digest?: string;
  };
  created_at: string;
  consensus?: unknown;
  metadata?: Record<string, unknown>;
}

interface DerivedAnalysisResultApiResponse {
  artifact: DerivedArtifactApiResponse;
  output: Record<string, unknown>;
  consensus?: unknown;
}

interface DecryptedRecordApiResponse {
  record_id?: string;
  text: string;
  size_bytes: number;
}

interface RecordInvocationApiResponse {
  token: string;
  invocation: {
    invocation_id: string;
    grant_id: string;
    audience_did: string;
    resource: string;
    ability: string;
  };
}

export interface ExportBundleApi {
  actor_did?: string;
  bundle_id?: string;
  bundle_hash?: string;
  created_at?: string;
  records?: Array<Record<string, unknown>>;
  proofs?: Array<Record<string, unknown>>;
  wallet?: {
    wallet_id?: string;
    owner_did?: string;
  };
  [key: string]: unknown;
}

export interface ExportBundleVerifyResponse {
  valid: boolean;
  hash_valid?: boolean;
  schema_valid?: boolean;
  schema_error?: string;
  bundle_id?: string;
  bundle_hash?: string;
  computed_hash: string;
}

export interface ExportBundleImportResponse {
  wallet_id: string;
  bundle_id?: string;
  bundle_hash?: string;
  record_count: number;
  version_count: number;
  proof_count: number;
  derived_artifact_count: number;
}

export interface ExportBundleStorageResponse {
  bundle_id?: string;
  bundle_hash?: string;
  wallet_id: string;
  ok: boolean;
  record_count: number;
  reports: Array<Record<string, unknown>>;
}

export interface ExportGrantResponse {
  grant_id: string;
  audience_did: string;
  resources: string[];
  abilities: string[];
  caveats?: Record<string, unknown>;
  status?: string;
  created_at?: string;
}

export interface ExportInvocationResponse {
  invocation_id: string;
  grant_id: string;
  actor_did: string;
  invocation_token: string;
  caveats?: Record<string, unknown>;
  created_at?: string;
}

export interface DelegatedGrantResponse {
  grant_id: string;
  issuer_did: string;
  audience_did: string;
  resources: string[];
  abilities: string[];
  caveats?: Record<string, unknown>;
  proof_chain?: string[];
  status?: string;
  created_at?: string;
  expires_at?: string | null;
}

export interface RecordGrantResponse {
  grant_id: string;
  issuer_did: string;
  audience_did: string;
  resources: string[];
  abilities: string[];
  caveats?: Record<string, unknown>;
  status?: string;
  created_at?: string;
  expires_at?: string | null;
}

export interface ThresholdApprovalResponse {
  approval_id: string;
  wallet_id: string;
  operation: string;
  requested_by: string;
  resources: string[];
  abilities: string[];
  threshold: number;
  approver_dids?: string[];
  approvals?: Record<string, string>;
  status: string;
  created_at?: string;
  expires_at?: string | null;
  details?: Record<string, unknown>;
}

interface ThresholdApprovalListResponse {
  approvals: ThresholdApprovalResponse[];
}

export type WalletAdminOperation =
  | "wallet/controller_add"
  | "wallet/controller_remove"
  | "wallet/device_add"
  | "wallet/device_revoke"
  | "wallet/recovery_policy_set"
  | "wallet/controller_recover"
  | "wallet/emergency_revoke";

export interface OpsHealthCheck {
  name: string;
  status: "ok" | "warning" | "error" | string;
  summary: string;
  details: Record<string, unknown>;
}

export interface OpsHealthReport {
  status: "ok" | "warning" | "error" | string;
  generated_at: string;
  wallet_count: number;
  check_count: number;
  checks: OpsHealthCheck[];
}

export interface EmergencyRevokeReport {
  wallet_id: string;
  revoked_grant_ids: string[];
  revoked_grant_count: number;
  rotated_record_ids: string[];
  rotated_record_count: number;
  rotation_errors?: Record<string, string>;
  rotate_keys: boolean;
  reason?: string | null;
}

export interface WalletApiConfig {
  apiBaseUrl: string;
  walletId: string;
  actorDid?: string;
  issuerKeyHex?: string;
  audienceKeyHex?: string;
}

export interface WorldIdWalletConfig {
  enabled: boolean;
  environment: "staging" | "production" | string;
  app_id: string;
  rp_id: string;
  allowed_actions: string[];
  default_action: string;
  credential_policy: string;
  allow_legacy_proofs: boolean;
  require_user_presence: boolean;
  rp_signature_ttl_seconds?: number;
  verify_base_url?: string;
  http_timeout_seconds?: number;
}

export interface WorldIdBinding {
  binding_id: string;
  wallet_id: string;
  actor_did: string;
  rp_id: string;
  action: string;
  protocol_version: string;
  environment: string;
  nullifier_ref: string;
  app_id?: string;
  credential_identifiers?: string[];
  issuer_schema_ids?: number[];
  proof_receipt_id?: string | null;
  session_id?: string;
  signal_hash_ref?: string;
  verification_status?: string;
  status: "active" | "revoked" | string;
  verified_at: string;
  expires_at_min?: number | null;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface WorldIdWalletStatus {
  enabled: boolean;
  environment: "staging" | "production" | string;
  app_id: string;
  rp_id: string;
  allowed_actions: string[];
  default_action: string;
  credential_policy: string;
  configured?: {
    nullifier_hmac_key?: boolean;
    rp_signing_key?: boolean;
  };
  wallet?: {
    active_binding_count: number;
    binding_count: number;
    bindings: WorldIdBinding[];
    wallet_id: string;
  };
}

export interface WorldIdRpSignatureResponse {
  rp_id: string;
  sig: string;
  signature: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  action: string;
}

export interface WorldIdRpSignatureRequest {
  action?: string;
}

export type WorldIdIdkitPayload = Record<string, unknown>;

export interface WorldIdVerificationRequest {
  idkitPayload: WorldIdIdkitPayload;
}

export interface WorldIdVerificationResult {
  success: boolean;
  action?: string;
  nullifier?: string;
  created_at?: string;
  environment?: string;
  session_id?: string;
  message?: string;
  results?: Array<Record<string, unknown>>;
}

export interface WorldIdVerificationResponse {
  binding: WorldIdBinding;
  proof?: ProofReceiptView;
  verification: WorldIdVerificationResult;
}

export interface WorldIdBindingRevokeRequest {
  reason?: string;
}

export type WorldIdWalletApiErrorCode =
  | "disabled"
  | "replayed"
  | "conflict"
  | "expired"
  | "verification_failed"
  | "request_failed";

export class WorldIdWalletApiError extends Error {
  readonly code: WorldIdWalletApiErrorCode;
  readonly detail: unknown;
  readonly status: number;

  constructor({
    code,
    detail,
    message,
    status
  }: {
    code: WorldIdWalletApiErrorCode;
    detail: unknown;
    message: string;
    status: number;
  }) {
    super(message);
    this.name = "WorldIdWalletApiError";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export function isWorldIdWalletApiError(error: unknown): error is WorldIdWalletApiError {
  return error instanceof WorldIdWalletApiError;
}

export type WalletConsensusMode =
  | "direct"
  | "receipt_only"
  | "libp2p_quorum"
  | "chainlink_cre"
  | "zkml_required"
  | "tee_or_zkml"
  | "hybrid";

export type WalletConsensusProofMode = "receipt_only" | "zkml_required" | "tee_or_zkml";

export type WalletConsensusComparison = "exact" | "normalized_text" | "canonical_json" | "semantic";

export type WalletConsensusFailClosedError =
  | "consensus_unavailable"
  | "quorum_not_reached"
  | "proof_verification_failed"
  | "cre_workflow_mismatch"
  | "receipt_replay_or_mismatch"
  | "policy_requires_manual_review";

export interface WalletConsensusRequestPolicy {
  mode: Exclude<WalletConsensusMode, "direct">;
  comparison?: WalletConsensusComparison;
  quorum?: number;
  minOperators?: number;
  failClosed?: boolean;
  timeoutSeconds?: number;
}

export interface WalletProofPolicy {
  mode: WalletConsensusProofMode;
}

export interface WalletConsensusMetadata {
  schema_version: "llm-router-consensus-receipt-v1";
  mode: Exclude<WalletConsensusMode, "direct">;
  comparison: WalletConsensusComparison;
  quorum_reached: boolean;
  operator_count: number;
  selected_operator_count: number;
  proof_mode: WalletConsensusProofMode;
  verification_label: string;
  receipt_hash?: string;
  receipt_cid?: string;
  created_at: string;
  failure_reason?: string;
  fail_closed_error?: WalletConsensusFailClosedError;
  proof_cid?: string;
  public_inputs_hash?: string;
  tee_attestation_hash?: string;
  cre_workflow_id?: string;
  cre_report_id?: string;
  chain_id?: string;
  tx_hash?: string;
}

export type WalletConsensusSurfaceFamily =
  | "direct"
  | "consensus"
  | "chainlink-cre"
  | "zkml"
  | "tee"
  | "manual-review";

export interface WalletConsensusDisplayState {
  family: WalletConsensusSurfaceFamily;
  statusLabel: string;
  badgeLabel: string;
  tone: "neutral" | "success" | "warning" | "danger";
  detailLabel: string;
  evidenceLabel: string;
  providerLabel: string;
  dashboardLabel: string;
  exportLabel: string;
  qrReviewLabel: string;
  inputBoundaryLabel: string;
  onChainLabel: string;
  failClosed: boolean;
  manualReview: boolean;
  mathematicalZkProof: boolean;
  receiptOnly: boolean;
}

export interface ConsensusBearingView {
  consensus?: WalletConsensusMetadata;
}

export interface WalletRouterTextRequest {
  prompt: string;
  systemPrompt?: string;
  provider?: string;
  modelName?: string;
  walletCid?: string;
  maxTokens?: number;
  maxNewTokens?: number;
  kwargs?: Record<string, unknown>;
  consensus?: WalletConsensusRequestPolicy;
  proofPolicy?: WalletProofPolicy;
}

export interface WalletRouterTextResult {
  router: string;
  walletId: string;
  walletCid: string;
  provider: string;
  modelName: string;
  text: string;
  rateLimit?: {
    limit: number;
    remaining: number;
    resetAt: number;
  };
  consensus?: WalletConsensusMetadata;
}

export interface WalletEmbeddingsRouterResponse {
  router?: string;
  wallet_id?: string;
  wallet_cid?: string;
  provider?: string;
  model_name?: string;
  embeddings?: number[][];
  dimension?: number;
  text_count?: number;
  raw?: Record<string, unknown>;
}

export interface WalletHmisOperationResult {
  status?: string;
  summary?: string;
  clients?: Array<Record<string, unknown>>;
  programs?: Array<Record<string, unknown>>;
  referralDraft?: Record<string, unknown>;
  eligibility?: Record<string, unknown>;
  raw: Record<string, unknown>;
  consensus?: WalletConsensusMetadata;
}

export interface WalletAnalyticsContributionResult {
  contributionId?: string;
  templateId?: string;
  status?: string;
  raw: Record<string, unknown>;
  consensus?: WalletConsensusMetadata;
}

export interface WalletAnalyticsAggregateResult {
  templateId?: string;
  metric?: string;
  released?: boolean;
  suppressed?: boolean;
  count?: number | null;
  noisyCount?: number | null;
  groupBy?: string[];
  groups?: Array<Record<string, unknown>>;
  privacyBudgetSpent?: number;
  raw: Record<string, unknown>;
  consensus?: WalletConsensusMetadata;
}

export interface DerivedServiceMatchResult {
  matches: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
  consensus?: WalletConsensusMetadata;
}

export type ProofSystemFamily =
  | "simulated"
  | "groth16"
  | "provekit"
  | "provekit_recursive_groth16"
  | "consensus_receipt"
  | "chainlink_cre"
  | "zkml"
  | "tee"
  | "unknown";

export interface ProofReceiptDisplayState {
  proofSystemFamily: ProofSystemFamily;
  proofSystemLabel: string;
  statusLabel: string;
  statusTone: "neutral" | "success" | "warning" | "danger";
  accepted: boolean;
  productionEvidence: boolean;
  failClosed: boolean;
  manualFallback: boolean;
  onChainLabel: string;
  providerLabel: string;
  dashboardLabel: string;
  exportLabel: string;
  qrReviewLabel: string;
  inputBoundaryLabel: string;
  evidenceLabel: string;
  consensus?: WalletConsensusMetadata;
  mathematicalZkProof: boolean;
}

const PRIVATE_PUBLIC_INPUT_KEY_PATTERN =
  /(^|_)(private|private_axiom|private_axioms|private_axiom_text|witness|prover|prover_key|pkp|pkp_path|prover_toml)(_|$)/i;

const PRIVATE_CONSENSUS_VALUE_PATTERNS = [
  /SHOULD_NOT_RENDER/i,
  /RAW_PROMPT/i,
  /WALLET_PLAINTEXT/i,
  /OPERATOR_SECRET/i,
  /RAW_ZK_PROOF_PAYLOAD/i,
  /TEE_QUOTE_BYTES/i,
  /CRE_PRIVATE_REPORT/i,
  /BEARER_TOKEN/i,
  /sk_live/i,
  /quote_base64/i,
  /private_don_report/i
];

const PRIVATE_PUBLIC_INPUT_VALUE_PATTERNS = [
  /PRIVATE_WITNESS_SENTINEL/i,
  /private_axiom_text/i,
  /Prover\.toml/i,
  /witness_theorem_hash_field/i,
  /prover_key_path/i,
  /pkp_path/i
];

export class WalletApiRequestError extends Error {
  code?: string;
  detail?: string;
  status: number;
  consensus?: WalletConsensusMetadata;

  constructor(label: string, status: number, detail?: string, code?: string, consensus?: WalletConsensusMetadata) {
    super(`${label} request failed with status ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "WalletApiRequestError";
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.consensus = consensus;
  }
}

export class WalletApiConsensusFailClosedError extends WalletApiRequestError {
  failClosedError: WalletConsensusFailClosedError;
  mode?: Exclude<WalletConsensusMode, "direct">;
  retryable: boolean;

  constructor({
    code,
    consensus,
    detail,
    label,
    mode,
    retryable,
    status
  }: {
    code: WalletConsensusFailClosedError;
    consensus?: WalletConsensusMetadata;
    detail?: string;
    label: string;
    mode?: Exclude<WalletConsensusMode, "direct">;
    retryable?: boolean;
    status: number;
  }) {
    super(label, status, detail, code, consensus);
    this.name = "WalletApiConsensusFailClosedError";
    this.failClosedError = code;
    this.mode = mode;
    this.retryable = retryable ?? false;
  }
}

export interface ServicePlanShareGrantResponse {
  grantId: string;
  receiptId?: string;
  audienceDid: string;
  resources: string[];
  abilities: string[];
  scopes: string[];
  expiresAt?: string;
  plan?: ServicePlan;
  receipt?: WalletGrantReceipt;
}

export async function loadWalletAccessState(config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">): Promise<{
  accessRequests: WalletAccessRequest[];
  grantReceipts: WalletGrantReceipt[];
}> {
  const [accessRequests, grantReceipts] = await Promise.all([
    listAccessRequests(config),
    listGrantReceipts(config)
  ]);
  return { accessRequests, grantReceipts };
}

export async function loadWalletDetails(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<WalletDetails> {
  const url = new URL(`/wallets/${config.walletId}`, normalizedBaseUrl(config.apiBaseUrl));
  return fetchJson<WalletDetails>(url, "Wallet details");
}

export async function listWalletAuditEvents(config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">): Promise<AuditEvent[]> {
  const url = new URL(`/wallets/${config.walletId}/audit`, normalizedBaseUrl(config.apiBaseUrl));
  const data = await fetchJson<AuditEventApiResponse>(url, "Wallet audit");
  return data.events.map(toAuditEventView);
}

export async function listWalletDocuments(config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">): Promise<UploadItem[]> {
  const url = new URL(`/wallets/${config.walletId}/records`, normalizedBaseUrl(config.apiBaseUrl));
  url.searchParams.set("data_type", "document");
  const data = await fetchJson<WalletRecordsApiResponse>(url, "Wallet records");
  return Promise.all(data.records.map((record) => toUploadItemViewWithStorage(config, record)));
}

export async function listWalletProofReceipts(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<ProofReceiptView[]> {
  const url = new URL(`/wallets/${config.walletId}/proofs`, normalizedBaseUrl(config.apiBaseUrl));
  const data = await fetchJson<ProofReceiptsApiResponse>(url, "Proof receipts");
  return data.proofs.map(toProofReceiptView);
}

export async function loadWalletWorldIdConfig(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<WorldIdWalletConfig> {
  const url = new URL(`/wallets/${config.walletId}/world-id/config`, normalizedBaseUrl(config.apiBaseUrl));
  return fetchWorldIdJson<WorldIdWalletConfig>(url, "World ID config");
}

export async function loadWalletWorldIdStatus(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId" | "actorDid">
): Promise<WorldIdWalletStatus> {
  const url = new URL(`/wallets/${config.walletId}/world-id/status`, normalizedBaseUrl(config.apiBaseUrl));
  url.searchParams.set("actor_did", requiredActorDid(config));
  return fetchWorldIdJson<WorldIdWalletStatus>(url, "World ID status");
}

export async function createWalletWorldIdRpSignature(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId" | "actorDid">,
  { action }: WorldIdRpSignatureRequest = {}
): Promise<WorldIdRpSignatureResponse> {
  const url = new URL(`/wallets/${config.walletId}/world-id/rp-signature`, normalizedBaseUrl(config.apiBaseUrl));
  return postWorldIdJson<WorldIdRpSignatureResponse>(url, "World ID RP signature", {
    action,
    actor_did: requiredActorDid(config)
  });
}

export async function registerWalletWorldIdVerification(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId" | "actorDid">,
  { idkitPayload }: WorldIdVerificationRequest
): Promise<WorldIdVerificationResponse> {
  const url = new URL(`/wallets/${config.walletId}/world-id/verifications`, normalizedBaseUrl(config.apiBaseUrl));
  const data = await postWorldIdJson<{
    binding: WorldIdBinding;
    proof?: ProofReceiptApiRecord | null;
    verification: WorldIdVerificationResult;
  }>(url, "World ID verification", {
    actor_did: requiredActorDid(config),
    idkit_payload: idkitPayload
  });
  return {
    binding: data.binding,
    proof: data.proof ? toProofReceiptView(data.proof) : undefined,
    verification: data.verification
  };
}

export async function revokeWalletWorldIdBinding(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId" | "actorDid">,
  bindingId: string,
  { reason = "" }: WorldIdBindingRevokeRequest = {}
): Promise<WorldIdBinding> {
  const url = new URL(
    `/wallets/${config.walletId}/world-id/bindings/${bindingId}/revoke`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  return postWorldIdJson<WorldIdBinding>(url, "World ID binding revoke", {
    actor_did: requiredActorDid(config),
    reason
  });
}

export const loadWorldIdConfig = loadWalletWorldIdConfig;
export const loadWorldIdStatus = loadWalletWorldIdStatus;
export const createWorldIdRpSignature = createWalletWorldIdRpSignature;
export const registerWorldIdVerification = registerWalletWorldIdVerification;
export const revokeWorldIdBinding = revokeWalletWorldIdBinding;

export async function listAnalyticsTemplates({
  apiBaseUrl,
  includeInactive = true
}: Pick<WalletApiConfig, "apiBaseUrl"> & { includeInactive?: boolean }): Promise<AnalyticsStudy[]> {
  const url = new URL("/analytics/templates", normalizedBaseUrl(apiBaseUrl));
  if (includeInactive) {
    url.searchParams.set("include_inactive", "true");
  }
  const data = await fetchJson<AnalyticsTemplatesApiResponse>(url, "Analytics templates");
  return data.templates.map(toAnalyticsStudyView);
}

export async function listWalletAnalyticsConsents(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<WalletAnalyticsConsent[]> {
  const url = new URL(`/wallets/${config.walletId}/analytics/consents`, normalizedBaseUrl(config.apiBaseUrl));
  const data = await fetchJson<AnalyticsConsentsApiResponse>(url, "Analytics consents");
  return data.consents.map(toWalletAnalyticsConsentView);
}

export async function createWalletAnalyticsConsent(
  config: WalletApiConfig,
  templateId: string,
  expiresAt?: string
): Promise<WalletAnalyticsConsent> {
  const url = new URL(
    `/wallets/${config.walletId}/analytics/consents/from-template`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const consent = await postJson<AnalyticsConsentApiRecord>(url, "Analytics consent", {
    actor_did: requiredActorDid(config),
    expires_at: expiresAt || undefined,
    template_id: templateId
  });
  return toWalletAnalyticsConsentView(consent);
}

export async function revokeWalletAnalyticsConsent(
  config: WalletApiConfig,
  consentId: string
): Promise<WalletAnalyticsConsent> {
  const url = new URL(
    `/wallets/${config.walletId}/analytics/consents/${consentId}/revoke`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const consent = await postJson<AnalyticsConsentApiRecord>(url, "Analytics consent revoke", {
    actor_did: requiredActorDid(config)
  });
  return toWalletAnalyticsConsentView(consent);
}

export async function createWalletAnalyticsContribution(
  config: WalletApiConfig,
  input: {
    consentId: string;
    templateId: string;
    fields: Record<string, unknown>;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  }
): Promise<WalletAnalyticsContributionResult> {
  const url = new URL(`/wallets/${config.walletId}/analytics/contributions`, normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "Analytics contribution", {
    actor_did: requiredActorDid(config),
    consent_id: input.consentId,
    fields: input.fields,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    template_id: input.templateId,
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletAnalyticsContributionResult(payload);
}

export async function countAnalyticsTemplate(
  config: Pick<WalletApiConfig, "apiBaseUrl"> & { actorDid?: string },
  templateId: string,
  input: {
    epsilon?: number;
    minCohortSize?: number;
    budgetKey?: string;
    budgetLimit?: number;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  } = {}
): Promise<WalletAnalyticsAggregateResult> {
  const url = new URL(`/analytics/${templateId}/count`, normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "Analytics aggregate count", {
    actor_did: config.actorDid,
    budget_key: input.budgetKey,
    budget_limit: input.budgetLimit,
    epsilon: input.epsilon,
    min_cohort_size: input.minCohortSize,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletAnalyticsAggregateResult(payload);
}

export async function countAnalyticsTemplateByFields(
  config: Pick<WalletApiConfig, "apiBaseUrl"> & { actorDid?: string },
  templateId: string,
  input: {
    groupBy: string[];
    epsilon?: number;
    minCohortSize?: number;
    budgetKey?: string;
    budgetLimit?: number;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  }
): Promise<WalletAnalyticsAggregateResult> {
  const url = new URL(`/analytics/${templateId}/count-by-fields`, normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "Analytics aggregate count by fields", {
    actor_did: config.actorDid,
    budget_key: input.budgetKey,
    budget_limit: input.budgetLimit,
    epsilon: input.epsilon,
    group_by: input.groupBy,
    min_cohort_size: input.minCohortSize,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletAnalyticsAggregateResult(payload);
}

export async function generateWalletRouterText(
  config: WalletApiConfig,
  input: WalletRouterTextRequest
): Promise<WalletRouterTextResult> {
  const url = new URL(`/wallets/${config.walletId}/ai-router/llm`, normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "Wallet router LLM", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.issuerKeyHex || config.audienceKeyHex,
    kwargs: input.kwargs,
    max_new_tokens: input.maxNewTokens ?? input.maxTokens,
    model_name: input.modelName,
    prompt: input.prompt,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    provider: input.provider,
    system_prompt: input.systemPrompt,
    wallet_cid: input.walletCid,
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletRouterTextResult(payload, config);
}

export async function generateWalletRouterEmbeddings(
  config: WalletApiConfig,
  input: {
    text?: string;
    texts?: string[];
    modelName?: string;
    provider?: string;
    walletCid?: string;
    kwargs?: Record<string, unknown>;
  }
): Promise<WalletEmbeddingsRouterResponse> {
  const url = new URL(`/wallets/${config.walletId}/ai-router/embeddings`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletEmbeddingsRouterResponse>(url, "Wallet embeddings router", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.issuerKeyHex || config.audienceKeyHex,
    kwargs: input.kwargs ?? {},
    model_name: input.modelName,
    provider: input.provider ?? "hf_inference_api",
    text: input.text,
    texts: input.texts ?? [],
    wallet_cid: input.walletCid
  });
}

export async function lookupHmisClients(
  config: WalletApiConfig,
  input: {
    query?: Record<string, unknown>;
    localSubjectRef?: string;
    consentGrantId?: string;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  } = {}
): Promise<WalletHmisOperationResult> {
  const url = new URL(`/wallets/${config.walletId}/hmis/lookup-clients`, normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "HMIS client lookup", {
    actor_did: requiredActorDid(config),
    consent_grant_id: input.consentGrantId,
    local_subject_ref: input.localSubjectRef,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    query: input.query || {},
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletHmisOperationResult(payload);
}

export async function listHmisProgramLinks(
  config: WalletApiConfig,
  input: {
    clientRef?: string;
    programId?: string;
    consentGrantId?: string;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  } = {}
): Promise<WalletHmisOperationResult> {
  const url = new URL(`/wallets/${config.walletId}/hmis/program-links`, normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "HMIS program links", {
    actor_did: requiredActorDid(config),
    client_ref: input.clientRef,
    consent_grant_id: input.consentGrantId,
    program_id: input.programId,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletHmisOperationResult(payload);
}

export async function createHmisReferralDraft(
  config: WalletApiConfig,
  input: {
    clientRef: string;
    programId: string;
    fields?: Record<string, unknown>;
    consentGrantId?: string;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  }
): Promise<WalletHmisOperationResult> {
  const url = new URL(`/wallets/${config.walletId}/hmis/referral-drafts`, normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "HMIS referral draft", {
    actor_did: requiredActorDid(config),
    client_ref: input.clientRef,
    consent_grant_id: input.consentGrantId,
    fields: input.fields || {},
    program_id: input.programId,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletHmisOperationResult(payload);
}

export async function updateHmisReferralDraft(
  config: WalletApiConfig,
  referralDraftId: string,
  input: {
    fields?: Record<string, unknown>;
    status?: string;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  }
): Promise<WalletHmisOperationResult> {
  const url = new URL(
    `/wallets/${config.walletId}/hmis/referral-drafts/${referralDraftId}`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const payload = await patchJson<Record<string, unknown>>(url, "HMIS referral draft update", {
    actor_did: requiredActorDid(config),
    fields: input.fields || {},
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    status: input.status,
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletHmisOperationResult(payload);
}

export async function validateHmisReferralDraft(
  config: WalletApiConfig,
  referralDraftId: string,
  input: {
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  } = {}
): Promise<WalletHmisOperationResult> {
  const url = new URL(
    `/wallets/${config.walletId}/hmis/referral-drafts/${referralDraftId}/validate`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const payload = await postJson<Record<string, unknown>>(url, "HMIS referral draft validation", {
    actor_did: requiredActorDid(config),
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletHmisOperationResult(payload);
}

export async function submitHmisReferralDraft(
  config: WalletApiConfig,
  referralDraftId: string,
  input: {
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  } = {}
): Promise<WalletHmisOperationResult> {
  const url = new URL(
    `/wallets/${config.walletId}/hmis/referral-drafts/${referralDraftId}/submit`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const payload = await postJson<Record<string, unknown>>(url, "HMIS referral draft submit", {
    actor_did: requiredActorDid(config),
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    ...toConsensusRequestPayload(input.consensus)
  });
  return toWalletHmisOperationResult(payload);
}

export async function matchDerivedServices(
  config: Pick<WalletApiConfig, "apiBaseUrl"> & { actorDid?: string },
  input: {
    needTerms: string[];
    locationClaim?: Record<string, unknown>;
    limit?: number;
    consensus?: WalletConsensusRequestPolicy;
    proofPolicy?: WalletProofPolicy;
  }
): Promise<DerivedServiceMatchResult> {
  const url = new URL("/services/match-derived", normalizedBaseUrl(config.apiBaseUrl));
  const payload = await postJson<Record<string, unknown>>(url, "Derived service match", {
    actor_did: config.actorDid,
    limit: input.limit,
    location_claim: input.locationClaim,
    need_terms: input.needTerms,
    proof_policy: toProofPolicyPayload(input.proofPolicy),
    ...toConsensusRequestPayload(input.consensus)
  });
  return toDerivedServiceMatchResult(payload);
}

export async function createLocationRegionProof(
  config: WalletApiConfig,
  {
    locationRecordId,
    regionId,
    grantId
  }: {
    locationRecordId: string;
    regionId: string;
    grantId?: string;
  }
): Promise<ProofReceiptView> {
  const url = new URL(
    `/wallets/${config.walletId}/locations/${locationRecordId}/region-proofs`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const proof = await postJson<ProofReceiptApiRecord>(url, "Location region proof", {
    actor_did: requiredActorDid(config),
    grant_id: grantId || undefined,
    region_id: regionId
  });
  return toProofReceiptView(proof);
}

export async function createLocationDistanceProof(
  config: WalletApiConfig,
  {
    locationRecordId,
    targetId,
    targetLat,
    targetLon,
    maxDistanceKm,
    grantId
  }: {
    locationRecordId: string;
    targetId: string;
    targetLat: number;
    targetLon: number;
    maxDistanceKm: number;
    grantId?: string;
  }
): Promise<ProofReceiptView> {
  const url = new URL(
    `/wallets/${config.walletId}/locations/${locationRecordId}/distance-proofs`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const proof = await postJson<ProofReceiptApiRecord>(url, "Location distance proof", {
    actor_did: requiredActorDid(config),
    grant_id: grantId || undefined,
    max_distance_km: maxDistanceKm,
    target_id: targetId,
    target_lat: targetLat,
    target_lon: targetLon
  });
  return toProofReceiptView(proof);
}

export async function listWalletSavedServices(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">,
  status?: string
): Promise<SavedService[]> {
  const url = new URL(`/wallets/${config.walletId}/portal/saved-services`, normalizedBaseUrl(config.apiBaseUrl));
  if (status) url.searchParams.set("status", status);
  const data = await fetchJson<SavedServicesApiResponse>(url, "Saved services");
  return data.saved_services;
}

export async function saveWalletService(
  config: WalletApiConfig,
  input: {
    serviceDocId: string;
    sourceContentCid: string;
    sourcePageCid?: string;
    title?: string;
    providerName?: string;
    programName?: string;
    sourceUrl?: string;
    label?: string;
    reason?: string;
    priority?: string;
    status?: string;
    privateNotesRecordId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<SavedService> {
  const url = new URL(`/wallets/${config.walletId}/portal/saved-services`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<SavedService>(url, "Saved service", {
    actor_did: requiredActorDid(config),
    service_doc_id: input.serviceDocId,
    source_content_cid: input.sourceContentCid,
    source_page_cid: input.sourcePageCid || "",
    title: input.title || "",
    provider_name: input.providerName || "",
    program_name: input.programName || "",
    source_url: input.sourceUrl || "",
    label: input.label || "",
    reason: input.reason || "",
    priority: input.priority || "normal",
    status: input.status || "saved",
    private_notes_record_id: input.privateNotesRecordId || "",
    metadata: input.metadata || {}
  });
}

export async function listWalletServicePlans(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">,
  filters: { serviceDocId?: string; status?: string } = {}
): Promise<ServicePlan[]> {
  const url = new URL(`/wallets/${config.walletId}/portal/plans`, normalizedBaseUrl(config.apiBaseUrl));
  if (filters.serviceDocId) url.searchParams.set("service_doc_id", filters.serviceDocId);
  if (filters.status) url.searchParams.set("status", filters.status);
  const data = await fetchJson<ServicePlansApiResponse>(url, "Service plans");
  return data.plans;
}

export async function createWalletServicePlan(
  config: WalletApiConfig,
  input: {
    serviceDocId: string;
    sourceContentCid?: string;
    sourcePageCid?: string;
    serviceTitle?: string;
    providerName?: string;
    goal?: string;
    steps?: string[];
    documentsNeeded?: string[];
    questionsToAsk?: string[];
    appointmentAt?: string;
    reminderAt?: string;
    travelTarget?: string;
    assignedWorkerRecipientId?: string;
    status?: string;
    relatedInteractionIds?: string[];
    privateNotesRecordId?: string;
  }
): Promise<ServicePlan> {
  const url = new URL(`/wallets/${config.walletId}/portal/plans`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<ServicePlan>(url, "Service plan", {
    actor_did: requiredActorDid(config),
    service_doc_id: input.serviceDocId,
    source_content_cid: input.sourceContentCid || "",
    source_page_cid: input.sourcePageCid || "",
    service_title: input.serviceTitle || "",
    provider_name: input.providerName || "",
    goal: input.goal || "",
    steps: input.steps || [],
    documents_needed: input.documentsNeeded || [],
    questions_to_ask: input.questionsToAsk || [],
    appointment_at: input.appointmentAt || "",
    reminder_at: input.reminderAt || "",
    travel_target: input.travelTarget || "",
    assigned_worker_recipient_id: input.assignedWorkerRecipientId || "",
    status: input.status || "active",
    related_interaction_ids: input.relatedInteractionIds || [],
    private_notes_record_id: input.privateNotesRecordId || ""
  });
}

export async function updateWalletServicePlan(
  config: WalletApiConfig,
  planId: string,
  input: {
    sourceContentCid?: string;
    sourcePageCid?: string;
    serviceTitle?: string;
    providerName?: string;
    goal?: string;
    steps?: string[];
    documentsNeeded?: string[];
    questionsToAsk?: string[];
    appointmentAt?: string;
    reminderAt?: string;
    travelTarget?: string;
    assignedWorkerRecipientId?: string;
    status?: string;
    relatedInteractionIds?: string[];
    privateNotesRecordId?: string;
  }
): Promise<ServicePlan> {
  const url = new URL(`/wallets/${config.walletId}/portal/plans/${planId}`, normalizedBaseUrl(config.apiBaseUrl));
  return patchJson<ServicePlan>(url, "Service plan update", {
    actor_did: requiredActorDid(config),
    source_content_cid: input.sourceContentCid,
    source_page_cid: input.sourcePageCid,
    service_title: input.serviceTitle,
    provider_name: input.providerName,
    goal: input.goal,
    steps: input.steps,
    documents_needed: input.documentsNeeded,
    questions_to_ask: input.questionsToAsk,
    appointment_at: input.appointmentAt,
    reminder_at: input.reminderAt,
    travel_target: input.travelTarget,
    assigned_worker_recipient_id: input.assignedWorkerRecipientId,
    status: input.status,
    related_interaction_ids: input.relatedInteractionIds,
    private_notes_record_id: input.privateNotesRecordId
  });
}

export async function createWalletServicePlanShareGrant(
  config: WalletApiConfig,
  planId: string,
  input: {
    audienceDid: string;
    expiresAt?: string;
    scopes?: string[];
    workerName?: string;
    workerRecipientId?: string;
  }
): Promise<ServicePlanShareGrantResponse> {
  const url = new URL(
    `/wallets/${config.walletId}/portal/plans/${planId}/share-grants`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const payload = await postJson<Record<string, unknown>>(url, "Service plan share grant", {
    actor_did: requiredActorDid(config),
    audience_did: input.audienceDid,
    expires_at: input.expiresAt,
    scopes: input.scopes || [],
    worker_name: input.workerName || "",
    worker_recipient_id: input.workerRecipientId || ""
  });
  return toServicePlanShareGrantResponse(payload, input);
}

export async function listWalletServiceInteractions(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">,
  filters: { serviceDocId?: string; interactionType?: string; status?: string } = {}
): Promise<ServiceInteractionEvent[]> {
  const url = new URL(`/wallets/${config.walletId}/portal/interactions`, normalizedBaseUrl(config.apiBaseUrl));
  if (filters.serviceDocId) url.searchParams.set("service_doc_id", filters.serviceDocId);
  if (filters.interactionType) url.searchParams.set("interaction_type", filters.interactionType);
  if (filters.status) url.searchParams.set("status", filters.status);
  const data = await fetchJson<ServiceInteractionsApiResponse>(url, "Service interactions");
  return data.interactions;
}

export async function createWalletServiceInteraction(
  config: WalletApiConfig,
  input: {
    serviceDocId: string;
    sourceContentCid?: string;
    sourcePageCid?: string;
    providerName?: string;
    programName?: string;
    interactionType: string;
    channel?: string;
    counterpartyName?: string;
    counterpartyContact?: string;
    timestamp?: string;
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
  }
): Promise<ServiceInteractionEvent> {
  const url = new URL(`/wallets/${config.walletId}/portal/interactions`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<ServiceInteractionEvent>(url, "Service interaction", {
    actor_did: requiredActorDid(config),
    service_doc_id: input.serviceDocId,
    source_content_cid: input.sourceContentCid || "",
    source_page_cid: input.sourcePageCid || "",
    provider_name: input.providerName || "",
    program_name: input.programName || "",
    interaction_type: input.interactionType,
    channel: input.channel || "",
    counterparty_name: input.counterpartyName || "",
    counterparty_contact: input.counterpartyContact || "",
    timestamp: input.timestamp || "",
    status: input.status || "",
    outcome: input.outcome || "",
    notes_record_id: input.notesRecordId || "",
    next_action: input.nextAction || "",
    next_follow_up_at: input.nextFollowUpAt || "",
    source_action_url: input.sourceActionUrl || "",
    related_grant_ids: input.relatedGrantIds || [],
    related_record_ids: input.relatedRecordIds || [],
    privacy_level: input.privacyLevel || "private",
    metadata: input.metadata || {}
  });
}

export async function addTextDocument(
  config: WalletApiConfig,
  {
    filename,
    text,
    title
  }: {
    filename: string;
    text: string;
    title?: string;
  }
): Promise<UploadItem> {
  const url = new URL(`/wallets/${config.walletId}/documents/text`, normalizedBaseUrl(config.apiBaseUrl));
  const record = await postJson<WalletRecordApiRecord>(url, "Document upload", {
    actor_did: requiredActorDid(config),
    key_hex: config.issuerKeyHex,
    filename,
    title,
    text
  });
  return toUploadItemViewWithStorage(config, record);
}

export async function addBinaryDocument(
  config: WalletApiConfig,
  {
    file,
    title
  }: {
    file: File;
    title?: string;
  }
): Promise<UploadItem> {
  const url = new URL(`/wallets/${config.walletId}/documents`, normalizedBaseUrl(config.apiBaseUrl));
  const form = new FormData();
  form.set("actor_did", requiredActorDid(config));
  if (config.issuerKeyHex) {
    form.set("key_hex", config.issuerKeyHex);
  }
  if (title) {
    form.set("title", title);
  }
  form.set("file", file, file.name);
  const response = await fetch(url, {
    body: form,
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(`Document upload request failed with status ${response.status}`);
  }
  return toUploadItemViewWithStorage(config, (await response.json()) as WalletRecordApiRecord);
}

export async function verifyRecordStorage(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">,
  recordId: string
): Promise<boolean> {
  const url = new URL(`/wallets/${config.walletId}/records/${recordId}/storage`, normalizedBaseUrl(config.apiBaseUrl));
  const report = await fetchJson<RecordStorageApiResponse>(url, "Record storage");
  return report.ok;
}

export async function verifyWalletStorage(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<WalletStorageReportView> {
  const url = new URL(`/wallets/${config.walletId}/storage`, normalizedBaseUrl(config.apiBaseUrl));
  return fetchJson<WalletStorageReportView>(url, "Wallet storage");
}

export async function repairWalletStorage(config: WalletApiConfig): Promise<WalletStorageReportView> {
  const url = new URL(`/wallets/${config.walletId}/storage/repair`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletStorageReportView>(url, "Wallet storage repair", {
    actor_did: requiredActorDid(config)
  });
}

export async function repairRecordStorage(config: WalletApiConfig, recordId: string): Promise<boolean> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/storage/repair`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const report = await postJson<RecordStorageApiResponse>(url, "Record storage repair", {
    actor_did: requiredActorDid(config)
  });
  return report.ok;
}

export async function rotateRecordKey(config: WalletApiConfig, recordId: string): Promise<void> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/rotate-key`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  await postJson<Record<string, unknown>>(url, "Record key rotation", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.issuerKeyHex
  });
}

export async function listWalletSnapshots(config: Pick<WalletApiConfig, "apiBaseUrl">): Promise<string[]> {
  const url = new URL("/wallets/snapshots", normalizedBaseUrl(config.apiBaseUrl));
  const data = await fetchJson<WalletSnapshotListApiResponse>(url, "Wallet snapshots");
  return data.wallet_ids;
}

export async function saveWalletSnapshot(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<WalletSnapshotMutationApiResponse> {
  const url = new URL(`/wallets/${config.walletId}/snapshot`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletSnapshotMutationApiResponse>(url, "Wallet snapshot save", {});
}

export async function verifyWalletSnapshot(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<WalletSnapshotVerification> {
  const url = new URL(`/wallets/${config.walletId}/snapshot`, normalizedBaseUrl(config.apiBaseUrl));
  return fetchJson<WalletSnapshotVerification>(url, "Wallet snapshot verification");
}

export async function loadWalletSnapshot(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">
): Promise<WalletSnapshotMutationApiResponse> {
  const url = new URL(`/wallets/${config.walletId}/snapshot/load`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletSnapshotMutationApiResponse>(url, "Wallet snapshot load", {});
}

export async function loadOpsHealth(
  config: Pick<WalletApiConfig, "apiBaseUrl">,
  verifyStorage = false
): Promise<OpsHealthReport> {
  const url = new URL("/ops/health", normalizedBaseUrl(config.apiBaseUrl));
  if (verifyStorage) {
    url.searchParams.set("verify_storage", "true");
  }
  return fetchJson<OpsHealthReport>(url, "Ops health");
}

export async function analyzeRecordWithGrant(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    invocationToken,
    maxChars = 200
  }: {
    recordId: string;
    grantId: string;
    invocationToken?: string;
    maxChars?: number;
  }
): Promise<DerivedArtifactView> {
  const url = new URL(`/wallets/${config.walletId}/records/${recordId}/analyze`, normalizedBaseUrl(config.apiBaseUrl));
  const artifact = await postJson<DerivedArtifactApiResponse>(url, "Record analysis", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex,
    grant_id: grantId,
    invocation_token: invocationToken || undefined,
    max_chars: maxChars
  });
  return toDerivedArtifactView(artifact);
}

export async function issueRecordAnalysisInvocation(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    outputTypes,
    userPresent = false
  }: {
    recordId: string;
    grantId: string;
    outputTypes?: string[];
    userPresent?: boolean;
  }
): Promise<string> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/analysis-invocations`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const response = await postJson<RecordInvocationApiResponse>(url, "Record analysis invocation", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId,
    output_types: outputTypes?.length ? outputTypes : undefined,
    user_present: userPresent
  });
  return response.token;
}

export async function analyzeRecordRedactedWithGrant(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    invocationToken,
    maxChars = 500
  }: {
    recordId: string;
    grantId?: string;
    invocationToken?: string;
    maxChars?: number;
  }
): Promise<DerivedAnalysisResultView> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/analyze/redacted`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const result = await postJson<DerivedAnalysisResultApiResponse>(url, "Redacted record analysis", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId || undefined,
    invocation_token: invocationToken || undefined,
    max_chars: maxChars
  });
  return toDerivedAnalysisResultView(result);
}

export async function createRecordVectorProfileWithGrant(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    invocationToken,
    chunkSizeWords = 80
  }: {
    recordId: string;
    grantId?: string;
    invocationToken?: string;
    chunkSizeWords?: number;
  }
): Promise<DerivedAnalysisResultView> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/vector-profile`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const result = await postJson<DerivedAnalysisResultApiResponse>(url, "Record vector profile", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId || undefined,
    invocation_token: invocationToken || undefined,
    chunk_size_words: chunkSizeWords
  });
  return toDerivedAnalysisResultView(result);
}

export async function extractRecordTextRedactedWithGrant(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    invocationToken,
    maxChars = 20_000,
    maxBytes = 200_000,
    useOcr = true
  }: {
    recordId: string;
    grantId?: string;
    invocationToken?: string;
    maxChars?: number;
    maxBytes?: number;
    useOcr?: boolean;
  }
): Promise<DerivedAnalysisResultView> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/extract-text/redacted`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const result = await postJson<DerivedAnalysisResultApiResponse>(url, "Redacted text extraction", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId || undefined,
    invocation_token: invocationToken || undefined,
    max_chars: maxChars,
    max_bytes: maxBytes,
    use_ocr: useOcr
  });
  return toDerivedAnalysisResultView(result);
}

export async function analyzeRecordFormRedactedWithGrant(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    invocationToken,
    maxFields = 100,
    useOcr = false
  }: {
    recordId: string;
    grantId?: string;
    invocationToken?: string;
    maxFields?: number;
    useOcr?: boolean;
  }
): Promise<DerivedAnalysisResultView> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/forms/analyze/redacted`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const result = await postJson<DerivedAnalysisResultApiResponse>(url, "Redacted form analysis", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId || undefined,
    invocation_token: invocationToken || undefined,
    max_fields: maxFields,
    use_ocr: useOcr
  });
  return toDerivedAnalysisResultView(result);
}

export async function createRedactedGraphRAG(
  config: WalletApiConfig,
  {
    recordIds,
    grantId,
    invocationToken,
    maxCharsPerRecord = 20_000,
    maxBytesPerRecord = 200_000,
    useOcr = true
  }: {
    recordIds: string[];
    grantId?: string;
    invocationToken?: string;
    maxCharsPerRecord?: number;
    maxBytesPerRecord?: number;
    useOcr?: boolean;
  }
): Promise<DerivedAnalysisResultView> {
  const url = new URL(
    `/wallets/${config.walletId}/records/graphrag/redacted`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const result = await postJson<DerivedAnalysisResultApiResponse>(url, "Redacted GraphRAG", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId || undefined,
    invocation_token: invocationToken || undefined,
    record_ids: recordIds,
    max_chars_per_record: maxCharsPerRecord,
    max_bytes_per_record: maxBytesPerRecord,
    use_ocr: useOcr
  });
  return toDerivedAnalysisResultView(result);
}

export async function decryptRecordWithGrant(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    invocationToken
  }: {
    recordId: string;
    grantId?: string;
    invocationToken?: string;
  }
): Promise<DecryptedRecordView> {
  const url = new URL(`/wallets/${config.walletId}/records/${recordId}/decrypt`, normalizedBaseUrl(config.apiBaseUrl));
  const decrypted = await postJson<DecryptedRecordApiResponse>(url, "Record decrypt", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId || undefined,
    invocation_token: invocationToken || undefined
  });
  return {
    recordId: decrypted.record_id ?? recordId,
    text: decrypted.text,
    sizeBytes: decrypted.size_bytes
  };
}

export async function issueRecordDecryptInvocation(
  config: WalletApiConfig,
  {
    recordId,
    grantId,
    userPresent = false
  }: {
    recordId: string;
    grantId: string;
    userPresent?: boolean;
  }
): Promise<string> {
  const url = new URL(
    `/wallets/${config.walletId}/records/${recordId}/decrypt-invocations`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  const response = await postJson<RecordInvocationApiResponse>(url, "Record decrypt invocation", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    grant_id: grantId,
    user_present: userPresent
  });
  return response.token;
}

export async function createRecordGrant(
  config: WalletApiConfig,
  {
    recordId,
    audienceDid,
    audienceKeyHex,
    abilities,
    purpose,
    expiresAt,
    approvalId,
    maxDelegationDepth,
    userPresenceRequired,
    outputTypes,
    caveats
  }: {
    recordId: string;
    audienceDid: string;
    audienceKeyHex?: string;
    abilities: string[];
    purpose?: string;
    expiresAt?: string;
    approvalId?: string;
    maxDelegationDepth?: number;
    userPresenceRequired?: boolean;
    outputTypes?: string[];
    caveats?: Record<string, unknown>;
  }
): Promise<RecordGrantResponse> {
  const url = new URL(`/wallets/${config.walletId}/records/${recordId}/grants`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<RecordGrantResponse>(url, "Record grant", {
    abilities,
    approval_id: approvalId || undefined,
    audience_did: audienceDid,
    audience_key_hex: audienceKeyHex || undefined,
    expires_at: expiresAt || undefined,
    issuer_did: requiredActorDid(config),
    issuer_key_hex: config.issuerKeyHex,
    max_delegation_depth: maxDelegationDepth,
    output_types: outputTypes?.length ? outputTypes : undefined,
    purpose: purpose || "service_matching",
    user_presence_required: userPresenceRequired || undefined,
    caveats: caveats || undefined
  });
}

export async function requestRecordGrantApproval(
  config: WalletApiConfig,
  {
    recordId,
    abilities,
    requestedBy = requiredActorDid(config),
    expiresAt
  }: {
    recordId: string;
    abilities: string[];
    requestedBy?: string;
    expiresAt?: string;
  }
): Promise<ThresholdApprovalResponse> {
  const url = new URL(`/wallets/${config.walletId}/approvals`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<ThresholdApprovalResponse>(url, "Record grant approval", {
    abilities,
    expires_at: expiresAt || undefined,
    operation: "grant/create",
    requested_by: requestedBy,
    resources: [`wallet://${config.walletId}/records/${recordId}`]
  });
}

export async function listAccessRequests({
  apiBaseUrl,
  walletId,
  requesterDid,
  audienceDid,
  status = "all"
}: {
  apiBaseUrl: string;
  walletId: string;
  requesterDid?: string;
  audienceDid?: string;
  status?: "pending" | "approved" | "rejected" | "revoked" | "all";
}): Promise<WalletAccessRequest[]> {
  const url = new URL(`/wallets/${walletId}/access-requests`, normalizedBaseUrl(apiBaseUrl));
  url.searchParams.set("status", status);
  if (requesterDid) {
    url.searchParams.set("requester_did", requesterDid);
  }
  if (audienceDid) {
    url.searchParams.set("audience_did", audienceDid);
  }
  const data = await fetchJson<AccessRequestApiResponse>(url, "Access request");
  return data.requests.map(toAccessRequestView);
}

export async function approveAccessRequest(
  config: WalletApiConfig,
  requestId: string
): Promise<WalletAccessRequest> {
  const data = await postAccessRequestDecision(config, requestId, "approve", {
    actor_did: requiredActorDid(config),
    issuer_key_hex: config.issuerKeyHex,
    audience_key_hex: config.audienceKeyHex,
    issue_invocation: false
  });
  return toAccessRequestView(data);
}

export async function rejectAccessRequest(
  config: WalletApiConfig,
  requestId: string,
  reason = "Rejected in wallet UI"
): Promise<WalletAccessRequest> {
  const data = await postAccessRequestDecision(config, requestId, "reject", {
    actor_did: requiredActorDid(config),
    reason
  });
  return toAccessRequestView(data);
}

export async function revokeAccessRequest(
  config: WalletApiConfig,
  requestId: string,
  reason = "Revoked in wallet UI"
): Promise<WalletAccessRequest> {
  const data = await postAccessRequestDecision(config, requestId, "revoke", {
    actor_did: requiredActorDid(config),
    reason
  });
  return toAccessRequestView(data);
}

export async function approveThresholdApproval(
  config: WalletApiConfig,
  approvalId: string
): Promise<ThresholdApprovalResponse> {
  const url = new URL(
    `/wallets/${config.walletId}/approvals/${approvalId}/approve`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  return postJson<ThresholdApprovalResponse>(url, "Threshold approval", {
    approver_did: requiredActorDid(config)
  });
}

export async function listThresholdApprovals(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">,
  status = "all"
): Promise<ThresholdApprovalResponse[]> {
  const url = new URL(`/wallets/${config.walletId}/approvals`, normalizedBaseUrl(config.apiBaseUrl));
  url.searchParams.set("status", status);
  const data = await fetchJson<ThresholdApprovalListResponse>(url, "Threshold approvals");
  return data.approvals;
}

export async function requestWalletAdminApproval(
  config: WalletApiConfig,
  operation: WalletAdminOperation,
  requestedBy = requiredActorDid(config)
): Promise<ThresholdApprovalResponse> {
  const url = new URL(`/wallets/${config.walletId}/approvals`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<ThresholdApprovalResponse>(url, "Wallet admin approval", {
    abilities: ["wallet/admin"],
    operation,
    requested_by: requestedBy,
    resources: [`wallet://${config.walletId}`]
  });
}

export async function setWalletRecoveryPolicy(
  config: WalletApiConfig,
  {
    contactDids,
    threshold,
    approvalId
  }: {
    contactDids: string[];
    threshold: number;
    approvalId?: string;
  }
): Promise<WalletDetails> {
  const url = new URL(`/wallets/${config.walletId}/recovery-policy`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletDetails>(url, "Wallet recovery policy", {
    actor_did: requiredActorDid(config),
    approval_id: approvalId || undefined,
    contact_dids: contactDids,
    threshold
  });
}

export async function recoverWalletController(
  config: WalletApiConfig,
  {
    actorDid,
    controllerDid,
    approvalId
  }: {
    actorDid: string;
    controllerDid: string;
    approvalId?: string;
  }
): Promise<WalletDetails> {
  const url = new URL(`/wallets/${config.walletId}/controllers/recover`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletDetails>(url, "Wallet controller recovery", {
    actor_did: actorDid,
    approval_id: approvalId || undefined,
    controller_did: controllerDid
  });
}

export async function emergencyRevoke(
  config: WalletApiConfig,
  {
    approvalId,
    rotateKeys = true,
    reason
  }: {
    approvalId?: string;
    rotateKeys?: boolean;
    reason?: string;
  }
): Promise<EmergencyRevokeReport> {
  const url = new URL(`/wallets/${config.walletId}/emergency-revoke`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<EmergencyRevokeReport>(url, "Emergency revoke", {
    actor_did: requiredActorDid(config),
    actor_key_hex: config.issuerKeyHex,
    approval_id: approvalId || undefined,
    reason: reason || undefined,
    rotate_keys: rotateKeys
  });
}

export async function delegateGrant(
  config: WalletApiConfig,
  {
    parentGrantId,
    audienceDid,
    resources,
    abilities,
    purpose,
    expiresAt,
    audienceKeyHex
  }: {
    parentGrantId: string;
    audienceDid: string;
    resources: string[];
    abilities: string[];
    purpose?: string;
    expiresAt?: string;
    audienceKeyHex?: string;
  }
): Promise<DelegatedGrantResponse> {
  const url = new URL(
    `/wallets/${config.walletId}/grants/${parentGrantId}/delegate`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  return postJson<DelegatedGrantResponse>(url, "Grant delegation", {
    abilities,
    audience_did: audienceDid,
    audience_key_hex: audienceKeyHex || undefined,
    caveats: purpose ? { purpose } : {},
    expires_at: expiresAt || undefined,
    issuer_did: requiredActorDid(config),
    issuer_key_hex: config.audienceKeyHex || config.issuerKeyHex,
    resources
  });
}

export async function addWalletController(
  config: WalletApiConfig,
  controllerDid: string,
  approvalId?: string
): Promise<WalletDetails> {
  const url = new URL(`/wallets/${config.walletId}/controllers`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletDetails>(url, "Wallet controller add", {
    actor_did: requiredActorDid(config),
    approval_id: approvalId || undefined,
    controller_did: controllerDid
  });
}

export async function removeWalletController(
  config: WalletApiConfig,
  controllerDid: string,
  approvalId?: string
): Promise<WalletDetails> {
  const url = new URL(`/wallets/${config.walletId}/controllers/remove`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletDetails>(url, "Wallet controller remove", {
    actor_did: requiredActorDid(config),
    approval_id: approvalId || undefined,
    controller_did: controllerDid
  });
}

export async function addWalletDevice(
  config: WalletApiConfig,
  deviceDid: string,
  approvalId?: string
): Promise<WalletDetails> {
  const url = new URL(`/wallets/${config.walletId}/devices`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletDetails>(url, "Wallet device add", {
    actor_did: requiredActorDid(config),
    approval_id: approvalId || undefined,
    device_did: deviceDid
  });
}

export async function revokeWalletDevice(
  config: WalletApiConfig,
  deviceDid: string,
  approvalId?: string
): Promise<WalletDetails> {
  const url = new URL(`/wallets/${config.walletId}/devices/revoke`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<WalletDetails>(url, "Wallet device revoke", {
    actor_did: requiredActorDid(config),
    approval_id: approvalId || undefined,
    device_did: deviceDid
  });
}

export async function listGrantReceipts({
  apiBaseUrl,
  walletId,
  audienceDid,
  status = "all"
}: {
  apiBaseUrl: string;
  walletId: string;
  audienceDid?: string;
  status?: "active" | "revoked" | "all";
}): Promise<WalletGrantReceipt[]> {
  const url = new URL(`/wallets/${walletId}/grant-receipts`, normalizedBaseUrl(apiBaseUrl));
  url.searchParams.set("status", status);
  if (audienceDid) {
    url.searchParams.set("audience_did", audienceDid);
  }
  const data = await fetchJson<GrantReceiptApiResponse>(url, "Grant receipt");
  return data.receipts.map(toGrantReceiptView);
}

export async function verifyExportBundle({
  apiBaseUrl,
  bundle
}: {
  apiBaseUrl: string;
  bundle: ExportBundleApi;
}): Promise<ExportBundleVerifyResponse> {
  const url = new URL("/exports/verify", normalizedBaseUrl(apiBaseUrl));
  return postJson<ExportBundleVerifyResponse>(url, "Export bundle verification", { bundle });
}

export async function importExportBundle({
  apiBaseUrl,
  bundle
}: {
  apiBaseUrl: string;
  bundle: ExportBundleApi;
}): Promise<ExportBundleImportResponse> {
  const url = new URL("/exports/import", normalizedBaseUrl(apiBaseUrl));
  return postJson<ExportBundleImportResponse>(url, "Export bundle import", { bundle });
}

export async function importExportBundleView({
  apiBaseUrl,
  bundleView
}: {
  apiBaseUrl: string;
  bundleView: ExportBundleView;
}): Promise<ExportBundleView> {
  if (!bundleView.bundle) {
    throw new Error("A complete export bundle is required for import");
  }
  await importExportBundle({ apiBaseUrl, bundle: bundleView.bundle });
  return { ...bundleView, imported: true };
}

export async function verifyExportBundleStorage({
  apiBaseUrl,
  bundle
}: {
  apiBaseUrl: string;
  bundle: ExportBundleApi;
}): Promise<ExportBundleStorageResponse> {
  const url = new URL("/exports/storage", normalizedBaseUrl(apiBaseUrl));
  return postJson<ExportBundleStorageResponse>(url, "Export bundle storage", { bundle });
}

export async function createExportGrant(
  config: WalletApiConfig,
  {
    audienceDid,
    recordIds,
    purpose = "user_export",
    expiresAt
  }: {
    audienceDid: string;
    recordIds: string[];
    purpose?: string;
    expiresAt?: string;
  }
): Promise<ExportGrantResponse> {
  const url = new URL(`/wallets/${config.walletId}/exports/grants`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<ExportGrantResponse>(url, "Export grant", {
    audience_did: audienceDid,
    audience_key_hex: config.audienceKeyHex,
    expires_at: expiresAt,
    issuer_did: requiredActorDid(config),
    issuer_key_hex: config.issuerKeyHex,
    purpose,
    record_ids: recordIds
  });
}

export async function issueExportInvocation(
  config: WalletApiConfig,
  {
    actorDid,
    grantId,
    recordIds,
    expiresAt
  }: {
    actorDid: string;
    grantId: string;
    recordIds?: string[];
    expiresAt?: string;
  }
): Promise<ExportInvocationResponse> {
  const url = new URL(`/wallets/${config.walletId}/exports/invocations`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<ExportInvocationResponse>(url, "Export invocation", {
    actor_did: actorDid,
    actor_key_hex: config.audienceKeyHex,
    expires_at: expiresAt,
    grant_id: grantId,
    record_ids: recordIds
  });
}

export async function createExportBundle(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId" | "audienceKeyHex">,
  {
    actorDid,
    grantId,
    invocationToken,
    recordIds,
    includeDerivedArtifacts = true,
    includeProofs = true
  }: {
    actorDid: string;
    grantId?: string;
    invocationToken?: string;
    recordIds?: string[];
    includeDerivedArtifacts?: boolean;
    includeProofs?: boolean;
  }
): Promise<ExportBundleApi> {
  const url = new URL(`/wallets/${config.walletId}/exports`, normalizedBaseUrl(config.apiBaseUrl));
  return postJson<ExportBundleApi>(url, "Export bundle", {
    actor_did: actorDid,
    actor_key_hex: config.audienceKeyHex,
    grant_id: grantId,
    include_derived_artifacts: includeDerivedArtifacts,
    include_proofs: includeProofs,
    invocation_token: invocationToken,
    record_ids: recordIds
  });
}

export async function createVerifiedExportBundleView(
  config: WalletApiConfig,
  {
    audienceDid,
    audienceName,
    recordIds,
    purpose = "user_export"
  }: {
    audienceDid: string;
    audienceName?: string;
    recordIds: string[];
    purpose?: string;
  }
): Promise<ExportBundleView> {
  const grant = await createExportGrant(config, { audienceDid, recordIds, purpose });
  const invocation = await issueExportInvocation(config, {
    actorDid: audienceDid,
    grantId: grant.grant_id,
    recordIds
  });
  const bundle = await createExportBundle(config, {
    actorDid: audienceDid,
    invocationToken: invocation.invocation_token,
    recordIds
  });
  return loadExportBundleView({
    apiBaseUrl: config.apiBaseUrl,
    audienceName: audienceName || labelFromDid(audienceDid),
    bundle
  });
}

export async function loadExportBundleView({
  apiBaseUrl,
  bundle,
  audienceName,
  imported = false
}: {
  apiBaseUrl: string;
  bundle: ExportBundleApi;
  audienceName?: string;
  imported?: boolean;
}): Promise<ExportBundleView> {
  const [verification, storage] = await Promise.all([
    verifyExportBundle({ apiBaseUrl, bundle }),
    verifyExportBundleStorage({ apiBaseUrl, bundle })
  ]);
  const bundleId = verification.bundle_id ?? bundle.bundle_id ?? "export-bundle";
  const bundleHash = verification.bundle_hash ?? bundle.bundle_hash ?? verification.computed_hash;
  const hashOk = verification.hash_valid ?? verification.valid;
  const schemaOk = verification.schema_valid ?? verification.valid;
  return {
    id: bundleId,
    bundleId,
    bundleHash,
    audienceName: audienceName ?? labelFromDid(bundle.actor_did ?? bundle.wallet?.owner_did ?? "did:unknown:recipient"),
    bundle,
    recordCount: storage.record_count || bundle.records?.length || 0,
    proofCount: bundle.proofs?.length ?? 0,
    verificationOk: verification.valid,
    hashOk,
    schemaOk,
    schemaError: verification.schema_error,
    storageOk: verification.valid && storage.ok,
    imported,
    createdAt: formatTimestamp(bundle.created_at ?? new Date().toISOString())
  };
}

function toAccessRequestView(request: AccessRequestApiRecord): WalletAccessRequest {
  const grantStatus = request.status === "revoked" ? "revoked" : request.grant_status ?? undefined;
  const view: WalletAccessRequest & ConsensusBearingView = {
    id: request.request_id,
    requesterName: labelFromDid(request.requester_did),
    requesterDid: request.requester_did,
    audienceDid: request.audience_did,
    resourceLabel: labelFromResource(request.resources[0] ?? "wallet resource"),
    abilities: request.abilities,
    purpose: request.purpose,
    status: request.status === "revoked" ? "approved" : request.status,
    createdAt: formatTimestamp(request.created_at),
    approvalRequired: request.approval_required,
    approvalId: request.approval_id ?? undefined,
    approvalStatus: request.approval_status ?? undefined,
    approvalThreshold: request.approval_threshold ?? undefined,
    approvalCount: request.approval_count,
    grantStatus
  };
  const consensus = consensusFromApiRecord(request);
  if (consensus) view.consensus = consensus;
  return view;
}

function toGrantReceiptView(receipt: GrantReceiptApiRecord): WalletGrantReceipt {
  const resource = receipt.resources[0] ?? "wallet resource";
  const view: WalletGrantReceipt & ConsensusBearingView = {
    id: receipt.receipt_id,
    grantId: receipt.grant_id,
    audienceName: labelFromDid(receipt.audience_did),
    audienceDid: receipt.audience_did,
    resources: receipt.resources,
    recordId: recordIdFromResource(resource),
    resourceLabel: labelFromResource(resource),
    abilities: receipt.abilities,
    purpose: receipt.purpose ?? "Shared wallet access",
    caveats: receipt.caveats,
    receiptHash: receipt.receipt_hash,
    status: receipt.status,
    createdAt: formatTimestamp(receipt.created_at),
    expiresAt: receipt.expires_at ? formatTimestamp(receipt.expires_at) : undefined
  };
  const consensus = consensusFromApiRecord(receipt);
  if (consensus) view.consensus = consensus;
  return view;
}

function toDerivedArtifactView(artifact: DerivedArtifactApiResponse): DerivedArtifactView {
  const view: DerivedArtifactView & ConsensusBearingView = {
    id: artifact.artifact_id,
    sourceRecordIds: artifact.source_record_ids,
    artifactType: artifact.artifact_type,
    outputPolicy: artifact.output_policy,
    encryptedPayloadRef:
      artifact.encrypted_payload_ref?.uri ??
      artifact.encrypted_payload_ref?.digest ??
      artifact.encrypted_payload_ref?.storage_type ??
      "encrypted derived artifact",
    createdAt: formatTimestamp(artifact.created_at)
  };
  const consensus = consensusFromApiRecord(artifact);
  if (consensus) view.consensus = consensus;
  return view;
}

function toDerivedAnalysisResultView(result: DerivedAnalysisResultApiResponse): DerivedAnalysisResultView {
  const consensus = sanitizeConsensusMetadata(
    result.consensus ?? result.output?.consensus ?? result.artifact.consensus ?? result.artifact.metadata?.consensus
  );
  const artifact = toDerivedArtifactView(result.artifact) as DerivedArtifactView & ConsensusBearingView;
  if (consensus) artifact.consensus = consensus;
  const output = sanitizeConsensusBearingOutput(result.output, consensus);
  const view: DerivedAnalysisResultView & ConsensusBearingView = {
    artifact,
    output
  };
  if (consensus) view.consensus = consensus;
  return view;
}

export function toProofReceiptView(proof: ProofReceiptApiRecord): ProofReceiptView {
  const publicInputs = sanitizeProofPublicInputs(proof.public_inputs);
  const claim = sanitizeProofDisplayValue(publicInputs.claim ?? proof.statement?.claim ?? proof.proof_type) || proof.proof_type;
  const system = proofSystemDetails(proof.proof_system, proof.is_simulated);
  const witnessLabel = proof.witness_record_ids.length
    ? proof.witness_record_ids
        .map(labelFromResource)
        .filter((label) => !containsPrivateProofToken(label))
        .join(", ")
    : "";
  const view: ProofReceiptView & ConsensusBearingView = {
    id: proof.proof_id,
    proofType: proof.proof_type,
    claim,
    verifier: proof.verifier_id,
    proofSystem: system.label,
    verificationStatus: proof.verification_status ?? "unknown",
    circuitId: proof.circuit_id ?? undefined,
    verifierDigest: proof.verifier_digest ?? undefined,
    proofArtifactRef: proof.proof_artifact_ref ?? undefined,
    publicInputs,
    witnessLabel: witnessLabel || "Wallet commitment reference",
    simulated: proof.is_simulated,
    createdAt: formatTimestamp(proof.created_at)
  };
  const consensus = sanitizeConsensusMetadata(proof.consensus ?? proof.metadata?.consensus);
  if (consensus) view.consensus = consensus;
  return view;
}

export function mapProofReceiptRecordForUi(record: Record<string, unknown>): ProofReceiptView {
  const publicInputs = isRecord(record.public_inputs) ? record.public_inputs : {};
  const statement = isRecord(record.statement) ? record.statement : undefined;
  return toProofReceiptView({
    proof_id: stringValue(record.proof_id) || "proof-receipt",
    proof_type: stringValue(record.proof_type) || "proof",
    statement,
    verifier_id: stringValue(record.verifier_id) || "unknown verifier",
    public_inputs: publicInputs,
    proof_hash: stringValue(record.proof_hash),
    witness_record_ids: stringArray(record.witness_record_ids),
    is_simulated: Boolean(record.is_simulated),
    proof_system: stringValue(record.proof_system) || undefined,
    circuit_id: stringValue(record.circuit_id) || null,
    verifier_digest: stringValue(record.verifier_digest) || null,
    proof_artifact_ref: stringValue(record.proof_artifact_ref) || null,
    verification_status: stringValue(record.verification_status) || "unknown",
    created_at: stringValue(record.created_at) || new Date(0).toISOString(),
    metadata: isRecord(record.metadata) ? record.metadata : undefined,
    wallet_id: stringValue(record.wallet_id) || undefined,
    witness_label: stringValue(record.witness_label) || undefined,
    consensus: record.consensus
  });
}

export function getProofReceiptUiState(proof: ProofReceiptView): ProofReceiptDisplayState {
  const consensus = getConsensusMetadataFromView(proof);
  if (consensus) {
    const consensusState = getConsensusDisplayState(consensus);
    const accepted = !consensusState.failClosed && consensus.quorum_reached;
    const productionEvidence =
      accepted &&
      (consensus.mode === "chainlink_cre" ||
        consensus.proof_mode === "zkml_required" ||
        consensus.proof_mode === "tee_or_zkml");

    return {
      proofSystemFamily:
        consensusState.family === "chainlink-cre"
          ? "chainlink_cre"
          : consensusState.family === "zkml"
            ? "zkml"
            : consensusState.family === "tee"
              ? "tee"
              : "consensus_receipt",
      proofSystemLabel: consensusState.statusLabel,
      statusLabel: consensusState.statusLabel,
      statusTone: consensusState.tone,
      accepted,
      productionEvidence,
      failClosed: consensusState.failClosed,
      manualFallback: consensusState.manualReview,
      onChainLabel: consensusState.onChainLabel,
      providerLabel: consensusState.providerLabel,
      dashboardLabel: consensusState.dashboardLabel,
      exportLabel: consensusState.exportLabel,
      qrReviewLabel: consensusState.qrReviewLabel,
      inputBoundaryLabel: consensusState.inputBoundaryLabel,
      evidenceLabel: consensusState.evidenceLabel,
      consensus,
      mathematicalZkProof: consensusState.mathematicalZkProof
    };
  }

  const system = proofSystemDetails(proof.proofSystem, proof.simulated);
  const status = verificationStatusDetails(proof.verificationStatus, system.family, proof.simulated);
  const productionEvidence = status.accepted && system.family !== "simulated" && system.family !== "unknown";
  const onChainReady = status.accepted && system.family === "provekit_recursive_groth16";

  return {
    proofSystemFamily: system.family,
    proofSystemLabel: system.label,
    statusLabel: status.label,
    statusTone: status.tone,
    accepted: status.accepted,
    productionEvidence,
    failClosed: status.failClosed,
    manualFallback: status.failClosed || system.family === "unknown",
    onChainLabel: onChainReady
      ? "Recursive Groth16 wrapper evidence only"
      : system.family === "provekit"
        ? "Not on-chain ready without recursive wrapper"
        : system.family === "simulated"
          ? "No on-chain claim"
          : "No contract submission claimed here",
    providerLabel: productionEvidence
      ? "Provider may review public proof metadata"
      : "Provider must use manual review",
    dashboardLabel: productionEvidence
      ? "Counts as proof coverage"
      : "Not counted as production proof coverage",
    exportLabel: status.failClosed
      ? "Export blocked until verifier state is accepted"
      : "Export carries public proof metadata only",
    qrReviewLabel: "QR review shows proof system, verifier, and public inputs only",
    inputBoundaryLabel: "Private witness and private axioms hidden",
    evidenceLabel: status.accepted ? "verified proof" : "not accepted",
    mathematicalZkProof: status.accepted && (system.family === "groth16" || system.family === "provekit_recursive_groth16")
  };
}

function toAuditEventView(event: AuditEventApiRecord): AuditEvent {
  const view: AuditEvent & ConsensusBearingView = {
    id: event.event_id ?? `${event.action}-${event.created_at}`,
    actor: labelFromDid(event.actor_did),
    action: event.action,
    timestamp: formatTimestamp(event.created_at),
    resource: event.resource,
    decision: event.decision,
    grantId: event.grant_id ?? undefined
  };
  const consensus = consensusFromApiRecord(event);
  if (consensus) view.consensus = consensus;
  return view;
}

function toAnalyticsStudyView(template: AnalyticsTemplateApiRecord): AnalyticsStudy {
  return {
    id: template.template_id,
    title: template.title,
    purpose: template.purpose,
    fields: template.allowed_derived_fields,
    minCohortSize: numberFromPolicy(template.aggregation_policy.min_cohort_size, 10),
    epsilonBudget: numberFromPolicy(template.aggregation_policy.epsilon_budget, 1),
    spentBudget: 0,
    status: template.status === "active" ? "approved" : template.status
  };
}

function toWalletAnalyticsConsentView(consent: AnalyticsConsentApiRecord): WalletAnalyticsConsent {
  return {
    id: consent.consent_id,
    templateId: consent.template_id,
    fields: consent.allowed_derived_fields,
    status: consent.status,
    createdAt: formatTimestamp(consent.created_at),
    expiresAt: consent.expires_at ? formatTimestamp(consent.expires_at) : undefined,
    expiresAtRaw: consent.expires_at ?? undefined
  };
}

export function sanitizeConsensusMetadata(value: unknown): WalletConsensusMetadata | undefined {
  if (!isRecord(value)) return undefined;

  const mode = consensusModeValue(value.mode);
  if (!mode || mode === "direct") return undefined;

  const proofMode = consensusProofModeValue(value.proof_mode) ?? "receipt_only";
  const comparison = consensusComparisonValue(value.comparison) ?? "canonical_json";
  const quorumReached = booleanValue(value.quorum_reached, !consensusFailClosedErrorValue(value.fail_closed_error));
  const operatorCount = nonNegativeInteger(value.operator_count);
  const selectedOperatorCount = nonNegativeInteger(value.selected_operator_count);
  const failClosedError = consensusFailClosedErrorValue(value.fail_closed_error);
  const createdAt =
    sanitizeConsensusString(value.created_at) ||
    sanitizeConsensusString(value.timestamp) ||
    new Date(0).toISOString();
  const metadata: WalletConsensusMetadata = {
    schema_version: "llm-router-consensus-receipt-v1",
    mode,
    comparison,
    quorum_reached: quorumReached,
    operator_count: operatorCount,
    selected_operator_count: selectedOperatorCount,
    proof_mode: proofMode,
    verification_label: consensusVerificationLabel({
      failClosedError,
      mode,
      proofMode,
      quorumReached,
      teeAttestationHash: sanitizeConsensusString(value.tee_attestation_hash)
    }),
    created_at: createdAt
  };

  setConsensusString(metadata, "receipt_hash", value.receipt_hash);
  setConsensusString(metadata, "receipt_cid", value.receipt_cid);
  setConsensusString(metadata, "failure_reason", value.failure_reason);
  setConsensusString(metadata, "proof_cid", value.proof_cid);
  setConsensusString(metadata, "public_inputs_hash", value.public_inputs_hash);
  setConsensusString(metadata, "tee_attestation_hash", value.tee_attestation_hash);
  setConsensusString(metadata, "cre_workflow_id", value.cre_workflow_id);
  setConsensusString(metadata, "cre_report_id", value.cre_report_id);
  setConsensusString(metadata, "chain_id", value.chain_id);
  setConsensusString(metadata, "tx_hash", value.tx_hash);

  if (failClosedError) {
    metadata.fail_closed_error = failClosedError;
    metadata.verification_label = "Manual review required";
  }

  if (!metadata.quorum_reached) {
    metadata.verification_label = "Manual review required";
  }

  return metadata;
}

export function getConsensusMetadataFromView(value: unknown): WalletConsensusMetadata | undefined {
  if (!isRecord(value)) return undefined;
  return sanitizeConsensusMetadata(value.consensus);
}

export function getConsensusDisplayState(consensus?: WalletConsensusMetadata): WalletConsensusDisplayState {
  if (!consensus) {
    return {
      family: "direct",
      statusLabel: "Direct AI response",
      badgeLabel: "direct",
      tone: "neutral",
      detailLabel: "No consensus receipt is attached.",
      evidenceLabel: "Direct output only",
      providerLabel: "Advisory only; provider must review high-impact claims",
      dashboardLabel: "Direct output, not proof evidence",
      exportLabel: "No receipt metadata to export",
      qrReviewLabel: "QR review has no consensus receipt metadata",
      inputBoundaryLabel: "No consensus metadata attached",
      onChainLabel: "No on-chain claim",
      failClosed: false,
      manualReview: false,
      mathematicalZkProof: false,
      receiptOnly: false
    };
  }

  const failClosed = Boolean(consensus.fail_closed_error || !consensus.quorum_reached);
  const teeEvidence = Boolean(consensus.tee_attestation_hash || consensus.proof_mode === "tee_or_zkml");
  const zkmlEvidence = consensus.proof_mode === "zkml_required" || consensus.mode === "zkml_required";
  const family: WalletConsensusSurfaceFamily = failClosed
    ? "manual-review"
    : teeEvidence
      ? "tee"
      : zkmlEvidence
        ? "zkml"
        : consensus.mode === "chainlink_cre"
          ? "chainlink-cre"
          : "consensus";
  const mathematicalZkProof = !failClosed && zkmlEvidence && !teeEvidence;
  const receiptOnly = consensus.proof_mode === "receipt_only";
  const quorum =
    consensus.operator_count > 0
      ? `${consensus.selected_operator_count} of ${consensus.operator_count} operators`
      : "operator quorum not reported";
  const receiptLabel = consensus.receipt_hash ? shortConsensusHash(consensus.receipt_hash) : "receipt hash unavailable";
  const proofLabel = consensus.proof_cid
    ? `proof ${shortConsensusHash(consensus.proof_cid)}`
    : consensus.public_inputs_hash
      ? `public inputs ${shortConsensusHash(consensus.public_inputs_hash)}`
      : "no proof artifact claimed";
  const onChainLabel =
    consensus.chain_id || consensus.tx_hash
      ? `Chain ${consensus.chain_id || "unknown"}${consensus.tx_hash ? ` · ${shortConsensusHash(consensus.tx_hash)}` : ""}`
      : "No on-chain claim";

  if (failClosed) {
    return {
      family,
      statusLabel: "Manual review required",
      badgeLabel: consensus.fail_closed_error ? consensus.fail_closed_error.replace(/_/g, " ") : "manual-review",
      tone: "danger",
      detailLabel: consensus.failure_reason || "Consensus failed closed before this claim could be accepted.",
      evidenceLabel: "Manual review required",
      providerLabel: "Provider must use manual review",
      dashboardLabel: "Not counted until manual review resolves",
      exportLabel: "Export blocked until fail-closed state is resolved",
      qrReviewLabel: "QR review shows fail-closed receipt metadata only",
      inputBoundaryLabel: "Sanitized failure metadata only",
      onChainLabel,
      failClosed: true,
      manualReview: true,
      mathematicalZkProof: false,
      receiptOnly
    };
  }

  if (teeEvidence) {
    return {
      family,
      statusLabel: "TEE attested",
      badgeLabel: "TEE",
      tone: "success",
      detailLabel: `${quorum} · ${proofLabel}`,
      evidenceLabel: "TEE attestation accepted",
      providerLabel: "Provider may review TEE attestation metadata",
      dashboardLabel: "TEE evidence, not ZK proof",
      exportLabel: "Exports TEE hash and public inputs only",
      qrReviewLabel: "QR review shows TEE attestation hash only",
      inputBoundaryLabel: "TEE quote bytes hidden",
      onChainLabel,
      failClosed: false,
      manualReview: false,
      mathematicalZkProof: false,
      receiptOnly: false
    };
  }

  if (zkmlEvidence) {
    return {
      family,
      statusLabel: "ZKML checker verified",
      badgeLabel: "ZKML",
      tone: "success",
      detailLabel: `${quorum} · ${proofLabel}`,
      evidenceLabel: "ZKML checker proof verified",
      providerLabel: "Provider may review ZKML checker public inputs",
      dashboardLabel: "ZKML proof coverage",
      exportLabel: "Exports proof CID and public input hash only",
      qrReviewLabel: "QR review shows ZKML proof metadata only",
      inputBoundaryLabel: "Proof witness and raw proof payload hidden",
      onChainLabel,
      failClosed: false,
      manualReview: false,
      mathematicalZkProof,
      receiptOnly: false
    };
  }

  if (consensus.mode === "chainlink_cre") {
    return {
      family,
      statusLabel: "Chainlink CRE verified",
      badgeLabel: "CRE",
      tone: "success",
      detailLabel: `${quorum} · ${receiptLabel}`,
      evidenceLabel: "Chainlink CRE report accepted",
      providerLabel: "Provider may review CRE receipt metadata",
      dashboardLabel: "CRE verification, not ZK proof",
      exportLabel: "Exports CRE report identifiers only",
      qrReviewLabel: "QR review shows CRE workflow and report IDs only",
      inputBoundaryLabel: "CRE private report hidden",
      onChainLabel,
      failClosed: false,
      manualReview: false,
      mathematicalZkProof: false,
      receiptOnly
    };
  }

  if (consensus.mode === "libp2p_quorum") {
    return {
      family,
      statusLabel: "libp2p quorum receipt",
      badgeLabel: consensus.operator_count ? `${consensus.selected_operator_count} of ${consensus.operator_count}` : "quorum",
      tone: "success",
      detailLabel: `${quorum} · ${receiptLabel}`,
      evidenceLabel: "Operator quorum receipt accepted",
      providerLabel: "Provider may review quorum receipt metadata",
      dashboardLabel: "Consensus receipt, not ZK proof",
      exportLabel: "Exports receipt hash and CID only",
      qrReviewLabel: "QR review shows quorum receipt metadata only",
      inputBoundaryLabel: "Raw operator outputs hidden",
      onChainLabel,
      failClosed: false,
      manualReview: false,
      mathematicalZkProof: false,
      receiptOnly
    };
  }

  return {
    family,
    statusLabel: "Consensus receipt",
    badgeLabel: "receipt-only",
    tone: "success",
    detailLabel: `${quorum} · ${receiptLabel}`,
    evidenceLabel: "Receipt metadata accepted",
    providerLabel: "Provider may review receipt metadata only",
    dashboardLabel: "Consensus receipt, not ZK proof",
    exportLabel: "Exports receipt hash and CID only",
    qrReviewLabel: "QR review shows receipt metadata only",
    inputBoundaryLabel: "Raw prompt and operator outputs hidden",
    onChainLabel,
    failClosed: false,
    manualReview: false,
    mathematicalZkProof: false,
    receiptOnly
  };
}

function toWalletRouterTextResult(payload: Record<string, unknown>, config: WalletApiConfig): WalletRouterTextResult {
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
  return {
    router: sanitizeConsensusString(payload.router) || "llm_router",
    walletId: sanitizeConsensusString(payload.wallet_id) || config.walletId,
    walletCid: sanitizeConsensusString(payload.wallet_cid) || "",
    provider: sanitizeConsensusString(payload.provider) || "",
    modelName: sanitizeConsensusString(payload.model_name) || "",
    text: sanitizeConsensusString(payload.text),
    rateLimit: rateLimit
      ? {
          limit: nonNegativeInteger(rateLimit.limit),
          remaining: nonNegativeInteger(rateLimit.remaining),
          resetAt: nonNegativeInteger(rateLimit.reset_at)
        }
      : undefined,
    consensus: sanitizeConsensusMetadata(payload.consensus)
  };
}

function toWalletHmisOperationResult(payload: Record<string, unknown>): WalletHmisOperationResult {
  return {
    status: sanitizeConsensusString(payload.status) || undefined,
    summary: sanitizeConsensusString(payload.summary) || undefined,
    clients: arrayOfRecords(payload.clients),
    programs: arrayOfRecords(payload.programs ?? payload.program_links),
    referralDraft: isRecord(payload.referral_draft) ? sanitizePublicRecord(payload.referral_draft) : undefined,
    eligibility: isRecord(payload.eligibility) ? sanitizePublicRecord(payload.eligibility) : undefined,
    raw: sanitizePublicRecord(payload),
    consensus: sanitizeConsensusMetadata(payload.consensus)
  };
}

function toWalletAnalyticsContributionResult(payload: Record<string, unknown>): WalletAnalyticsContributionResult {
  return {
    contributionId: sanitizeConsensusString(payload.contribution_id) || sanitizeConsensusString(payload.id) || undefined,
    templateId: sanitizeConsensusString(payload.template_id) || undefined,
    status: sanitizeConsensusString(payload.status) || undefined,
    raw: sanitizePublicRecord(payload),
    consensus: sanitizeConsensusMetadata(payload.consensus)
  };
}

function toWalletAnalyticsAggregateResult(payload: Record<string, unknown>): WalletAnalyticsAggregateResult {
  const countValue = nullableNumber(payload.count);
  const noisyCountValue = nullableNumber(payload.noisy_count);
  return {
    templateId: sanitizeConsensusString(payload.template_id) || undefined,
    metric: sanitizeConsensusString(payload.metric) || undefined,
    released: typeof payload.released === "boolean" ? payload.released : undefined,
    suppressed: typeof payload.suppressed === "boolean" ? payload.suppressed : undefined,
    count: countValue,
    noisyCount: noisyCountValue,
    groupBy: stringArray(payload.group_by),
    groups: arrayOfRecords(payload.groups),
    privacyBudgetSpent: nullableNumber(payload.privacy_budget_spent) ?? undefined,
    raw: sanitizePublicRecord(payload),
    consensus: sanitizeConsensusMetadata(payload.consensus)
  };
}

function toDerivedServiceMatchResult(payload: Record<string, unknown>): DerivedServiceMatchResult {
  return {
    matches: arrayOfRecords(payload.matches),
    raw: sanitizePublicRecord(payload),
    consensus: sanitizeConsensusMetadata(payload.consensus)
  };
}

function toUploadItemView(record: WalletRecordApiRecord): UploadItem {
  const view: UploadItem & ConsensusBearingView = {
    id: record.record_id,
    recordId: record.record_id,
    fileName: labelFromResource(record.record_id),
    machineSummary: `${record.data_type} record stored ${formatTimestamp(record.created_at)}`,
    category: record.public_descriptor || record.data_type,
    sensitivity: record.sensitivity,
    status: record.status === "active" ? "stored" : "failed",
    shared: false
  };
  const consensus = consensusFromApiRecord(record);
  if (consensus) view.consensus = consensus;
  return view;
}

async function toUploadItemViewWithStorage(
  config: Pick<WalletApiConfig, "apiBaseUrl" | "walletId">,
  record: WalletRecordApiRecord
): Promise<UploadItem> {
  const item = toUploadItemView(record);
  try {
    return { ...item, storageOk: await verifyRecordStorage(config, record.record_id) };
  } catch {
    return { ...item, storageOk: false };
  }
}

async function fetchJson<T>(url: URL, label: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw await toWalletApiRequestError(response, label);
  }
  return (await response.json()) as T;
}

async function postJson<T>(url: URL, label: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  if (!response.ok) {
    throw await toWalletApiRequestError(response, label);
  }
  return (await response.json()) as T;
}

async function fetchWorldIdJson<T>(url: URL, label: string): Promise<T> {
  const response = await fetch(url);
  return readWorldIdResponse<T>(response, label);
}

async function postWorldIdJson<T>(url: URL, label: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  return readWorldIdResponse<T>(response, label);
}

async function readWorldIdResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw await toWorldIdWalletApiError(response, label);
  }
  return (await response.json()) as T;
}

async function toWorldIdWalletApiError(response: Response, label: string): Promise<WorldIdWalletApiError> {
  const detail = await readErrorResponseDetail(response);
  const message = detailMessage(detail) || `${label} request failed with status ${response.status}`;
  return new WorldIdWalletApiError({
    code: classifyWorldIdError(response.status, message, detail),
    detail,
    message,
    status: response.status
  });
}

async function readErrorResponseDetail(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function detailMessage(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (isRecord(detail)) {
    const nested = detail.detail;
    if (typeof nested === "string") return nested;
    if (Array.isArray(nested)) return nested.map(detailMessage).filter(Boolean).join("; ");
    if (typeof detail.message === "string") return detail.message;
    if (typeof detail.error === "string") return detail.error;
  }
  return "";
}

function classifyWorldIdError(status: number, message: string, detail: unknown): WorldIdWalletApiErrorCode {
  const rendered = `${message} ${typeof detail === "string" ? detail : JSON.stringify(detail ?? "")}`.toLowerCase();
  if (rendered.includes("disabled")) return "disabled";
  if (rendered.includes("expired") || rendered.includes("expires_at") || rendered.includes("expires at")) return "expired";
  if (
    rendered.includes("verification failed") ||
    rendered.includes("verification_failed") ||
    rendered.includes("verification-failed") ||
    rendered.includes("verification was not successful") ||
    rendered.includes("not successful") ||
    rendered.includes("verify failed")
  ) {
    return "verification_failed";
  }
  if (rendered.includes("replay") || rendered.includes("replayed") || rendered.includes("nullifier_replayed")) return "replayed";
  if (rendered.includes("already bound") || rendered.includes("conflict") || status === 409) return "conflict";
  return "request_failed";
}

async function patchJson<T>(url: URL, label: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH"
  });
  if (!response.ok) {
    throw await toWalletApiRequestError(response, label);
  }
  return (await response.json()) as T;
}

async function toWalletApiRequestError(response: Response, label: string): Promise<WalletApiRequestError> {
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const detailRecord = isRecord(payload.detail) ? payload.detail : payload;
    const detail = sanitizeConsensusString(detailRecord.message ?? payload.message ?? payload.error ?? payload.detail);
    const consensus = sanitizeConsensusMetadata(detailRecord.consensus ?? payload.consensus);
    const failClosedCode = consensusFailClosedErrorValue(detailRecord.code ?? payload.code);
    const mode = consensusModeValue(detailRecord.mode ?? consensus?.mode);
    if (failClosedCode) {
      return new WalletApiConsensusFailClosedError({
        code: failClosedCode,
        consensus,
        detail: detail || undefined,
        label,
        mode: mode && mode !== "direct" ? mode : consensus?.mode,
        retryable: Boolean(detailRecord.retryable),
        status: response.status
      });
    }
    const code = sanitizeConsensusString(payload.code);
    return new WalletApiRequestError(label, response.status, detail || undefined, code || undefined, consensus);
  } catch {
    return new WalletApiRequestError(label, response.status);
  }
}

async function postAccessRequestDecision(
  config: WalletApiConfig,
  requestId: string,
  action: "approve" | "reject" | "revoke",
  body: Record<string, unknown>
): Promise<AccessRequestApiRecord> {
  const url = new URL(
    `/wallets/${config.walletId}/access-requests/${requestId}/${action}`,
    normalizedBaseUrl(config.apiBaseUrl)
  );
  return postJson<AccessRequestApiRecord>(url, `Access request ${action}`, body);
}

function toServicePlanShareGrantResponse(
  payload: Record<string, unknown>,
  input: { audienceDid: string; expiresAt?: string; scopes?: string[] }
): ServicePlanShareGrantResponse {
  const receipt = isRecord(payload.receipt) ? payload.receipt as unknown as WalletGrantReceipt : undefined;
  const resources = stringArray(payload.resources);
  const abilities = stringArray(payload.abilities);
  return {
    grantId: stringValue(payload.grantId ?? payload.grant_id ?? receipt?.grantId ?? ""),
    receiptId: stringValue(payload.receiptId ?? payload.receipt_id ?? receipt?.id ?? ""),
    audienceDid: stringValue(payload.audienceDid ?? payload.audience_did ?? input.audienceDid),
    resources,
    abilities,
    scopes: stringArray(payload.scopes).length ? stringArray(payload.scopes) : input.scopes || [],
    expiresAt: stringValue(payload.expiresAt ?? payload.expires_at ?? input.expiresAt),
    plan: isRecord(payload.plan) ? payload.plan as unknown as ServicePlan : undefined,
    receipt
  };
}

function toConsensusRequestPayload(consensus?: WalletConsensusRequestPolicy): Record<string, unknown> {
  if (!consensus) return {};
  return {
    consensus: {
      comparison: consensus.comparison,
      fail_closed: consensus.failClosed,
      min_operators: consensus.minOperators,
      mode: consensus.mode,
      quorum: consensus.quorum,
      timeout_s: consensus.timeoutSeconds
    }
  };
}

function toProofPolicyPayload(proofPolicy?: WalletProofPolicy): Record<string, unknown> | undefined {
  return proofPolicy ? { mode: proofPolicy.mode } : undefined;
}

function consensusFromApiRecord(record: { consensus?: unknown; metadata?: Record<string, unknown> }): WalletConsensusMetadata | undefined {
  return sanitizeConsensusMetadata(record.consensus ?? record.metadata?.consensus);
}

function sanitizeConsensusBearingOutput(
  output: Record<string, unknown>,
  consensus?: WalletConsensusMetadata
): Record<string, unknown> {
  const sanitized = sanitizePublicRecord(output);
  if (consensus) {
    sanitized.consensus = consensus;
  } else {
    delete sanitized.consensus;
  }
  return sanitized;
}

function sanitizePublicRecord(record: Record<string, unknown>): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (privateRecordKey(key)) continue;
    if (key === "consensus") {
      const consensus = sanitizeConsensusMetadata(value);
      if (consensus) entries.push([key, consensus]);
      continue;
    }
    if (isRecord(value)) {
      entries.push([key, sanitizePublicRecord(value)]);
      continue;
    }
    if (Array.isArray(value)) {
      entries.push([
        key,
        value
          .map((item) => {
            if (isRecord(item)) return sanitizePublicRecord(item);
            const safeItem = sanitizeConsensusString(item);
            return safeItem || undefined;
          })
          .filter((item) => item !== undefined)
      ]);
      continue;
    }
    const safeValue = sanitizeConsensusString(value);
    if (safeValue || typeof value === "number" || typeof value === "boolean" || value === null) {
      entries.push([key, typeof value === "number" || typeof value === "boolean" || value === null ? value : safeValue]);
    }
  }
  return Object.fromEntries(entries);
}

function privateRecordKey(key: string): boolean {
  return /(^|_)(raw_prompt|prompt|plaintext|operator_secret|secret|private|witness|raw_zk|raw_proof|tee_quote|cre_private|bearer|token|key_hex|credential)(_|$)/i.test(
    key
  );
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(sanitizePublicRecord);
}

function consensusModeValue(value: unknown): WalletConsensusMode | undefined {
  const mode = stringValue(value);
  if (
    mode === "direct" ||
    mode === "receipt_only" ||
    mode === "libp2p_quorum" ||
    mode === "chainlink_cre" ||
    mode === "zkml_required" ||
    mode === "tee_or_zkml" ||
    mode === "hybrid"
  ) {
    return mode;
  }
  return undefined;
}

function consensusProofModeValue(value: unknown): WalletConsensusProofMode | undefined {
  const mode = stringValue(value);
  if (mode === "receipt_only" || mode === "zkml_required" || mode === "tee_or_zkml") {
    return mode;
  }
  return undefined;
}

function consensusComparisonValue(value: unknown): WalletConsensusComparison | undefined {
  const comparison = stringValue(value);
  if (comparison === "exact" || comparison === "normalized_text" || comparison === "canonical_json" || comparison === "semantic") {
    return comparison;
  }
  return undefined;
}

function consensusFailClosedErrorValue(value: unknown): WalletConsensusFailClosedError | undefined {
  const code = stringValue(value);
  if (
    code === "consensus_unavailable" ||
    code === "quorum_not_reached" ||
    code === "proof_verification_failed" ||
    code === "cre_workflow_mismatch" ||
    code === "receipt_replay_or_mismatch" ||
    code === "policy_requires_manual_review"
  ) {
    return code;
  }
  return undefined;
}

function consensusVerificationLabel({
  failClosedError,
  mode,
  proofMode,
  quorumReached,
  teeAttestationHash
}: {
  failClosedError?: WalletConsensusFailClosedError;
  mode: Exclude<WalletConsensusMode, "direct">;
  proofMode: WalletConsensusProofMode;
  quorumReached: boolean;
  teeAttestationHash?: string;
}): string {
  if (failClosedError || !quorumReached) return "Manual review required";
  if (proofMode === "tee_or_zkml" && teeAttestationHash) return "TEE attested";
  if (mode === "tee_or_zkml" && proofMode === "tee_or_zkml") return "TEE attested";
  if (proofMode === "zkml_required" || mode === "zkml_required") return "ZKML checker verified";
  if (mode === "chainlink_cre") return "Chainlink CRE verified";
  if (mode === "libp2p_quorum") return "libp2p quorum receipt";
  return "Consensus receipt";
}

function setConsensusString<K extends keyof WalletConsensusMetadata>(
  metadata: WalletConsensusMetadata,
  key: K,
  value: unknown
) {
  const safeValue = sanitizeConsensusString(value);
  if (safeValue) {
    (metadata as unknown as Record<string, unknown>)[key] = safeValue;
  }
}

function sanitizeConsensusString(value: unknown): string {
  const text = stringValue(value);
  if (!text) return "";
  if (PRIVATE_CONSENSUS_VALUE_PATTERNS.some((pattern) => pattern.test(text))) return "";
  if (containsPrivateProofToken(text)) return "";
  return text;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function nonNegativeInteger(value: unknown): number {
  const number = nullableNumber(value);
  return number === null ? 0 : Math.max(0, Math.trunc(number));
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function shortConsensusHash(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
}

function requiredActorDid(config: Pick<WalletApiConfig, "actorDid">): string {
  if (!config.actorDid) {
    throw new Error("VITE_DEMO_ACTOR_DID is required for access-request mutations");
  }
  return config.actorDid;
}

function normalizedBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function sanitizeProofPublicInputs(publicInputs: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(publicInputs).flatMap(([key, value]) => {
      if (PRIVATE_PUBLIC_INPUT_KEY_PATTERN.test(key) || containsPrivateProofToken(value)) {
        return [];
      }
      const safeValue = sanitizeProofDisplayValue(value);
      return safeValue ? [[key, safeValue]] : [];
    })
  );
}

function sanitizeProofDisplayValue(value: unknown): string {
  const text = stringValue(value);
  return containsPrivateProofToken(text) ? "" : text;
}

function containsPrivateProofToken(value: unknown): boolean {
  const serialized = stringValue(value);
  return PRIVATE_PUBLIC_INPUT_VALUE_PATTERNS.some((pattern) => pattern.test(serialized));
}

function proofSystemDetails(
  proofSystem: string | undefined,
  isSimulated: boolean
): { family: ProofSystemFamily; label: string } {
  const raw = (proofSystem ?? "").trim();
  const normalized = raw.toLowerCase().replace(/[\s_/-]+/g, "");

  if (isSimulated || normalized.includes("simulated")) {
    return { family: "simulated", label: "Simulated proof, demo-only" };
  }
  if (normalized.includes("provekit") && normalized.includes("recursive") && normalized.includes("groth16")) {
    return { family: "provekit_recursive_groth16", label: "ProveKit recursive Groth16 wrapper" };
  }
  if (normalized.includes("provekit") && normalized.includes("groth16") && normalized.includes("wrapper")) {
    return { family: "provekit_recursive_groth16", label: "ProveKit recursive Groth16 wrapper" };
  }
  if (normalized.includes("provekit") || normalized.includes("whir")) {
    return { family: "provekit", label: "ProveKit WHIR" };
  }
  if (normalized.includes("groth16") || normalized.includes("bn254")) {
    return { family: "groth16", label: "Groth16 BN254" };
  }
  if (normalized.includes("zkml")) {
    return { family: "zkml", label: "ZKML checker verified" };
  }
  if (normalized.includes("tee")) {
    return { family: "tee", label: "TEE attested" };
  }
  if (normalized.includes("chainlinkcre") || normalized.includes("cre")) {
    return { family: "chainlink_cre", label: "Chainlink CRE verified" };
  }
  if (normalized.includes("consensus") || normalized.includes("receipt")) {
    return { family: "consensus_receipt", label: "Consensus receipt" };
  }
  return { family: "unknown", label: raw || "Unknown proof system" };
}

function verificationStatusDetails(
  verificationStatus: string | undefined,
  family: ProofSystemFamily,
  isSimulated: boolean
): {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  accepted: boolean;
  failClosed: boolean;
} {
  const normalized = (verificationStatus ?? "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (isSimulated || family === "simulated" || normalized === "demo_only") {
    return { accepted: false, failClosed: false, label: "Demo only", tone: "warning" };
  }
  if (["verified", "verification_success", "success", "ok"].includes(normalized)) {
    return { accepted: true, failClosed: false, label: "verified", tone: "success" };
  }
  if (["pending", "proof_pending", "queued"].includes(normalized)) {
    return { accepted: false, failClosed: false, label: "Pending verification", tone: "neutral" };
  }
  if (normalized.includes("artifact_hash_mismatch")) {
    return { accepted: false, failClosed: true, label: "ProveKit artifact hash mismatch", tone: "danger" };
  }
  if (normalized.includes("stale_verifier_key")) {
    return { accepted: false, failClosed: true, label: "Stale ProveKit verifier key", tone: "warning" };
  }
  if (normalized.includes("verification_failed") || normalized.includes("verification_failure")) {
    return { accepted: false, failClosed: true, label: "ProveKit verification failed", tone: "danger" };
  }
  if (normalized.includes("disabled")) {
    return { accepted: false, failClosed: true, label: "ProveKit backend disabled", tone: "warning" };
  }
  if (normalized.includes("unavailable")) {
    return { accepted: false, failClosed: true, label: "ProveKit backend unavailable", tone: "warning" };
  }
  if (normalized.includes("error") || normalized.includes("failed") || normalized.includes("mismatch")) {
    return { accepted: false, failClosed: true, label: verificationStatus || "Verification failed", tone: "danger" };
  }
  return { accepted: false, failClosed: true, label: verificationStatus || "Unknown verifier state", tone: "warning" };
}

function numberFromPolicy(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function labelFromResource(resource: string): string {
  const parts = resource.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? resource;
  return last.replace(/^rec-/, "Record ");
}

function recordIdFromResource(resource: string): string | undefined {
  const parts = resource.split("/").filter(Boolean);
  const recordsIndex = parts.lastIndexOf("records");
  return recordsIndex >= 0 ? parts[recordsIndex + 1] : undefined;
}

function labelFromDid(did: string): string {
  const last = did.split(":").pop() ?? did;
  return last
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
