import type { RouteId } from "../models/abby";

export const AGENT_MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

export const AGENT_MESSAGE_STATUSES = ["queued", "streaming", "complete", "failed", "canceled"] as const;
export type AgentMessageStatus = (typeof AGENT_MESSAGE_STATUSES)[number];

export const AGENT_SESSION_STATUSES = ["active", "archived", "failed"] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export const AGENT_INTENT_KINDS = [
  "service_navigation",
  "app_navigation",
  "wallet_action",
  "proof_request",
  "export_request",
  "privacy_question",
  "general_question",
  "unknown"
] as const;
export type AgentIntentKind = (typeof AGENT_INTENT_KINDS)[number];

export const AGENT_PLAN_STATUSES = ["draft", "ready", "waiting_for_confirmation", "running", "complete", "failed"] as const;
export type AgentPlanStatus = (typeof AGENT_PLAN_STATUSES)[number];

export const AGENT_PLAN_STEP_STATUSES = ["pending", "running", "complete", "failed", "skipped"] as const;
export type AgentPlanStepStatus = (typeof AGENT_PLAN_STEP_STATUSES)[number];

export const AGENT_TOOL_CALL_STATUSES = ["pending", "waiting_for_confirmation", "running", "succeeded", "failed", "canceled"] as const;
export type AgentToolCallStatus = (typeof AGENT_TOOL_CALL_STATUSES)[number];

export const AGENT_PERMISSION_LEVELS = [
  "read_public",
  "public",
  "app_context",
  "read_wallet_summary",
  "wallet_metadata",
  "wallet_private",
  "write_wallet",
  "wallet_write",
  "share_or_disclose",
  "admin"
] as const;
export type AgentPermissionLevel = (typeof AGENT_PERMISSION_LEVELS)[number];

const AGENT_PERMISSION_LEVEL_RANKS: Record<AgentPermissionLevel, number> = {
  read_public: 0,
  public: 0,
  app_context: 1,
  read_wallet_summary: 2,
  wallet_metadata: 2,
  wallet_private: 2,
  write_wallet: 3,
  wallet_write: 3,
  share_or_disclose: 4,
  admin: 5
};

export const AGENT_CONFIRMATION_STATUSES = ["pending", "approved", "denied", "expired", "canceled"] as const;
export type AgentConfirmationStatus = (typeof AGENT_CONFIRMATION_STATUSES)[number];

export const AGENT_CONFIRMATION_RISKS = ["low", "moderate", "high", "restricted"] as const;
export type AgentConfirmationRisk = (typeof AGENT_CONFIRMATION_RISKS)[number];

export const AGENT_SCHEMA_TYPES = ["string", "number", "boolean", "object", "array", "null"] as const;
export type AgentSchemaType = (typeof AGENT_SCHEMA_TYPES)[number];

export interface AgentSchemaProperty {
  type: AgentSchemaType | AgentSchemaType[];
  description?: string;
  enum?: readonly string[];
  items?: AgentSchemaProperty;
  properties?: Record<string, AgentSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface AgentCommandSchema<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: AgentSchemaProperty;
  outputSchema: AgentSchemaProperty;
  isInput: (value: unknown) => value is TInput;
  isOutput: (value: unknown) => value is TOutput;
}

export interface EvidenceCitation {
  label: string;
  url?: string;
  contentCid?: string;
  pageCid?: string;
  docId?: string;
}

export interface EvidenceItem {
  id: string;
  title: string;
  source: string;
  snippet: string;
  score?: number;
  citation: EvidenceCitation;
}

export interface EvidenceBundle {
  id: string;
  query: string;
  generatedAt: string;
  items: EvidenceItem[];
  graphNodeIds?: string[];
  graphEdgeIds?: string[];
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  status: AgentMessageStatus;
  intentId?: string;
  planId?: string;
  toolCallIds?: string[];
  toolResultIds?: string[];
  evidenceBundleIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentIntent {
  id: string;
  kind: AgentIntentKind;
  summary: string;
  confidence: number;
  createdAt: string;
  route?: RouteId;
  entities?: Record<string, string>;
  requiresPrivateContext?: boolean;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  status: AgentPlanStepStatus;
  toolName?: string;
  dependsOn?: string[];
  confirmationId?: string;
}

export interface AgentPlan {
  id: string;
  sessionId: string;
  intentId: string;
  status: AgentPlanStatus;
  steps: AgentPlanStep[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

export interface AgentToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: AgentSchemaProperty;
  outputSchema: AgentSchemaProperty;
  permissionLevel: AgentPermissionLevel;
  surfaces: RouteId[];
  requiresConfirmation: boolean;
  requiresAudit: boolean;
  requiresWalletUnlock: boolean;
  requiresUserPresence: boolean;
  requiresPrivateContextOptIn: boolean;
  auditEventType?: string;
}

export interface AgentToolCall {
  id: string;
  sessionId: string;
  name: string;
  input: unknown;
  status: AgentToolCallStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  confirmationId?: string;
}

export interface AgentToolResult {
  id: string;
  toolCallId: string;
  name: string;
  success: boolean;
  completedAt: string;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  evidenceBundleIds?: string[];
  auditEventId?: string;
}

export interface AgentConfirmationRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  summary: string;
  risk: AgentConfirmationRisk;
  permissionLevel: AgentPermissionLevel;
  status: AgentConfirmationStatus;
  requestedAt: string;
  resolvedAt?: string;
  expiresAt?: string;
  details?: Record<string, unknown>;
}

export interface SurfaceContext {
  route: RouteId;
  routeLabel: string;
  capturedAt: string;
  selectedServiceDocId?: string;
  selectedRecordId?: string;
  selectedRecipientId?: string;
  selectedAccessRequestId?: string;
  selectedProofId?: string;
  visibleRecordIds?: string[];
  visibleServiceDocIds?: string[];
  walletUnlocked: boolean;
  privateContextAllowed: boolean;
  permissionLevel: AgentPermissionLevel;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  title: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  activeRoute: RouteId;
  messages: AgentMessage[];
  intents: AgentIntent[];
  plans: AgentPlan[];
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  confirmations: AgentConfirmationRequest[];
  evidenceBundles: EvidenceBundle[];
  permissionLevel: AgentPermissionLevel;
  privateContextAllowed: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isOptional<T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T | undefined {
  return value === undefined || guard(value);
}

export function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return isString(value) && values.includes(value);
}

export function isRouteId(value: unknown): value is RouteId {
  return isOneOf(
    [
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
    ] as const,
    value
  );
}

export function isAgentPermissionLevel(value: unknown): value is AgentPermissionLevel {
  return isOneOf(AGENT_PERMISSION_LEVELS, value);
}

export function hasPermissionLevel(granted: AgentPermissionLevel, required: AgentPermissionLevel): boolean {
  return AGENT_PERMISSION_LEVEL_RANKS[granted] >= AGENT_PERMISSION_LEVEL_RANKS[required];
}

export function isAgentSchemaProperty(value: unknown): value is AgentSchemaProperty {
  if (!isRecord(value)) {
    return false;
  }
  const type = value.type;
  const hasValidType = Array.isArray(type)
    ? type.every((item) => isOneOf(AGENT_SCHEMA_TYPES, item))
    : isOneOf(AGENT_SCHEMA_TYPES, type);
  return (
    hasValidType &&
    isOptional(value.description, isString) &&
    isOptional(value.enum, isStringArray) &&
    isOptional(value.required, isStringArray) &&
    isOptional(value.additionalProperties, isBoolean) &&
    isOptional(value.items, isAgentSchemaProperty) &&
    isOptional(value.properties, (candidate): candidate is Record<string, AgentSchemaProperty> =>
      isRecord(candidate) && Object.values(candidate).every(isAgentSchemaProperty)
    )
  );
}

export function isAgentCommandSchema(value: unknown): value is AgentCommandSchema {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isString(value.description) &&
    isAgentSchemaProperty(value.inputSchema) &&
    isAgentSchemaProperty(value.outputSchema) &&
    typeof value.isInput === "function" &&
    typeof value.isOutput === "function"
  );
}

export function isEvidenceCitation(value: unknown): value is EvidenceCitation {
  return (
    isRecord(value) &&
    isString(value.label) &&
    isOptional(value.url, isString) &&
    isOptional(value.contentCid, isString) &&
    isOptional(value.pageCid, isString) &&
    isOptional(value.docId, isString)
  );
}

export function isEvidenceItem(value: unknown): value is EvidenceItem {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.source) &&
    isString(value.snippet) &&
    isOptional(value.score, isNumber) &&
    isEvidenceCitation(value.citation)
  );
}

export function isEvidenceBundle(value: unknown): value is EvidenceBundle {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.query) &&
    isString(value.generatedAt) &&
    Array.isArray(value.items) &&
    value.items.every(isEvidenceItem) &&
    isOptional(value.graphNodeIds, isStringArray) &&
    isOptional(value.graphEdgeIds, isStringArray)
  );
}

export function isAgentMessage(value: unknown): value is AgentMessage {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.sessionId) &&
    isOneOf(AGENT_MESSAGE_ROLES, value.role) &&
    isString(value.content) &&
    isString(value.createdAt) &&
    isOneOf(AGENT_MESSAGE_STATUSES, value.status) &&
    isOptional(value.intentId, isString) &&
    isOptional(value.planId, isString) &&
    isOptional(value.toolCallIds, isStringArray) &&
    isOptional(value.toolResultIds, isStringArray) &&
    isOptional(value.evidenceBundleIds, isStringArray) &&
    isOptional(value.metadata, isUnknownRecord)
  );
}

export function isAgentIntent(value: unknown): value is AgentIntent {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isOneOf(AGENT_INTENT_KINDS, value.kind) &&
    isString(value.summary) &&
    isNumber(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    isString(value.createdAt) &&
    isOptional(value.route, isRouteId) &&
    isOptional(value.entities, (candidate): candidate is Record<string, string> =>
      isRecord(candidate) && Object.values(candidate).every(isString)
    ) &&
    isOptional(value.requiresPrivateContext, isBoolean)
  );
}

export function isAgentPlanStep(value: unknown): value is AgentPlanStep {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isOneOf(AGENT_PLAN_STEP_STATUSES, value.status) &&
    isOptional(value.toolName, isString) &&
    isOptional(value.dependsOn, isStringArray) &&
    isOptional(value.confirmationId, isString)
  );
}

export function isAgentPlan(value: unknown): value is AgentPlan {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.sessionId) &&
    isString(value.intentId) &&
    isOneOf(AGENT_PLAN_STATUSES, value.status) &&
    Array.isArray(value.steps) &&
    value.steps.every(isAgentPlanStep) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptional(value.summary, isString)
  );
}

export function isAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isString(value.title) &&
    isString(value.description) &&
    isAgentSchemaProperty(value.inputSchema) &&
    isAgentSchemaProperty(value.outputSchema) &&
    isAgentPermissionLevel(value.permissionLevel) &&
    Array.isArray(value.surfaces) &&
    value.surfaces.every(isRouteId) &&
    isBoolean(value.requiresConfirmation) &&
    isBoolean(value.requiresAudit) &&
    isBoolean(value.requiresWalletUnlock) &&
    isBoolean(value.requiresUserPresence) &&
    isBoolean(value.requiresPrivateContextOptIn) &&
    isOptional(value.auditEventType, isString)
  );
}

export function isAgentToolCall(value: unknown): value is AgentToolCall {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.sessionId) &&
    isString(value.name) &&
    hasOwn(value, "input") &&
    isOneOf(AGENT_TOOL_CALL_STATUSES, value.status) &&
    isString(value.requestedAt) &&
    isOptional(value.startedAt, isString) &&
    isOptional(value.completedAt, isString) &&
    isOptional(value.confirmationId, isString)
  );
}

export function isAgentToolResult(value: unknown): value is AgentToolResult {
  const error = value && isRecord(value) ? value.error : undefined;
  const hasValidError =
    error === undefined ||
    (isRecord(error) &&
      isString(error.code) &&
      isString(error.message) &&
      isOptional(error.retryable, isBoolean));
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.toolCallId) &&
    isString(value.name) &&
    isBoolean(value.success) &&
    isString(value.completedAt) &&
    isOptional(value.evidenceBundleIds, isStringArray) &&
    isOptional(value.auditEventId, isString) &&
    hasValidError &&
    (value.success || error !== undefined)
  );
}

export function isAgentConfirmationRequest(value: unknown): value is AgentConfirmationRequest {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.sessionId) &&
    isString(value.toolCallId) &&
    isString(value.title) &&
    isString(value.summary) &&
    isOneOf(AGENT_CONFIRMATION_RISKS, value.risk) &&
    isAgentPermissionLevel(value.permissionLevel) &&
    isOneOf(AGENT_CONFIRMATION_STATUSES, value.status) &&
    isString(value.requestedAt) &&
    isOptional(value.resolvedAt, isString) &&
    isOptional(value.expiresAt, isString) &&
    isOptional(value.details, isUnknownRecord)
  );
}

export function isSurfaceContext(value: unknown): value is SurfaceContext {
  return (
    isRecord(value) &&
    isRouteId(value.route) &&
    isString(value.routeLabel) &&
    isString(value.capturedAt) &&
    isOptional(value.selectedServiceDocId, isString) &&
    isOptional(value.selectedRecordId, isString) &&
    isOptional(value.selectedRecipientId, isString) &&
    isOptional(value.selectedAccessRequestId, isString) &&
    isOptional(value.selectedProofId, isString) &&
    isOptional(value.visibleRecordIds, isStringArray) &&
    isOptional(value.visibleServiceDocIds, isStringArray) &&
    isBoolean(value.walletUnlocked) &&
    isBoolean(value.privateContextAllowed) &&
    isAgentPermissionLevel(value.permissionLevel) &&
    isOptional(value.summary, isString) &&
    isOptional(value.metadata, isUnknownRecord)
  );
}

export function isAgentSession(value: unknown): value is AgentSession {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isOneOf(AGENT_SESSION_STATUSES, value.status) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isRouteId(value.activeRoute) &&
    Array.isArray(value.messages) &&
    value.messages.every(isAgentMessage) &&
    Array.isArray(value.intents) &&
    value.intents.every(isAgentIntent) &&
    Array.isArray(value.plans) &&
    value.plans.every(isAgentPlan) &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(isAgentToolCall) &&
    Array.isArray(value.toolResults) &&
    value.toolResults.every(isAgentToolResult) &&
    Array.isArray(value.confirmations) &&
    value.confirmations.every(isAgentConfirmationRequest) &&
    Array.isArray(value.evidenceBundles) &&
    value.evidenceBundles.every(isEvidenceBundle) &&
    isAgentPermissionLevel(value.permissionLevel) &&
    isBoolean(value.privateContextAllowed)
  );
}
