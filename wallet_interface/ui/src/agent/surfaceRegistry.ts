import type { RouteId } from "../models/abby";
import type { AgentPermissionLevel, AgentToolDefinition } from "./types";
import {
  hasPermissionLevel,
  isAgentPermissionLevel,
  isAgentToolDefinition,
  isOneOf,
  isRecord,
  isRouteId,
  isString
} from "./types";
import type { AgentCommandName } from "./commandSchemas";
import { commandSchemas, isAgentCommandName } from "./commandSchemas";
import { getAgentToolPermissionPolicy, permissionLevelForGate } from "./permissionPolicy";

export const SURFACE_CONTEXT_SCOPES = ["public", "app_state", "wallet_metadata", "wallet_private"] as const;
export type SurfaceContextScope = (typeof SURFACE_CONTEXT_SCOPES)[number];

export interface SurfaceContextProviderDefinition {
  id: string;
  label: string;
  scope: SurfaceContextScope;
  permissionLevel: AgentPermissionLevel;
}

export interface AgentSurfaceDefinition {
  route: RouteId;
  label: string;
  contextProviders: SurfaceContextProviderDefinition[];
  tools: AgentCommandName[];
}

type ToolPolicy = Pick<
  AgentToolDefinition,
  | "title"
  | "permissionLevel"
  | "surfaces"
  | "requiresConfirmation"
  | "requiresWalletUnlock"
  | "requiresUserPresence"
  | "requiresPrivateContextOptIn"
  | "auditEventType"
>;

const allRoutes = [
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
] as const satisfies readonly RouteId[];

const routeLabels: Record<RouteId, string> = {
  home: "Home",
  register: "Register",
  "check-in": "Check in",
  calendar: "Calendar",
  messages: "Messages",
  contacts: "Contacts",
  "sharing-rules": "Sharing",
  uploads: "Wallet",
  settings: "Settings",
  "social-services": "Services",
  interactions: "Interactions",
  shelter: "Provider overview",
  "provider-clients": "Clients served",
  "provider-cases": "Case management",
  "provider-messages": "Client messages",
  "provider-analytics": "Staff analytics",
  "provider-proofs": "ZK certificates",
  "provider-operations": "Staff operations",
  "recipient-access": "Who can see info",
  "benefits-protection": "Benefits",
  analytics: "Analytics",
  "proof-center": "Proofs",
  exports: "Exports",
  security: "Security",
  audit: "Audit"
};

const publicContext: SurfaceContextProviderDefinition = {
  id: "route_summary",
  label: "Route summary",
  scope: "public",
  permissionLevel: "public"
};

const appStateContext: SurfaceContextProviderDefinition = {
  id: "visible_app_state",
  label: "Visible app state",
  scope: "app_state",
  permissionLevel: "app_context"
};

const walletMetadataContext: SurfaceContextProviderDefinition = {
  id: "wallet_metadata",
  label: "Wallet record metadata",
  scope: "wallet_metadata",
  permissionLevel: "wallet_metadata"
};

const walletPrivateContext: SurfaceContextProviderDefinition = {
  id: "wallet_private_context",
  label: "Private wallet context",
  scope: "wallet_private",
  permissionLevel: "wallet_private"
};

const commonReadTools: AgentCommandName[] = ["navigate", "read_surface_context", "search_211_services", "answer_211_question"];

const surfaceTools: Record<RouteId, AgentCommandName[]> = {
  home: commonReadTools,
  register: [...commonReadTools, "update_registration_draft"],
  "check-in": [...commonReadTools, "update_check_in_policy"],
  calendar: commonReadTools,
  messages: commonReadTools,
  contacts: [
    ...commonReadTools,
    "add_recipient",
    "edit_recipient",
    "remove_recipient",
    "preview_sharing_capabilities",
    "request_shelter_contact",
    "approve_shelter_contact_request",
    "deny_shelter_contact_request"
  ],
  "sharing-rules": [
    ...commonReadTools,
    "add_recipient",
    "edit_recipient",
    "remove_recipient",
    "update_recipient_scopes",
    "preview_sharing_capabilities",
    "set_disclosure_scopes"
  ],
  uploads: [
    ...commonReadTools,
    "summarize_upload_requirements",
    "classify_uploaded_document",
    "repair_upload_storage",
    "toggle_upload_shared"
  ],
  settings: [...commonReadTools, "update_registration_draft", "update_check_in_policy"],
  "social-services": [
    ...commonReadTools,
    "search_211_services",
    "answer_211_question",
    "open_service_detail",
    "save_service",
    "create_service_plan",
    "add_service_plan_checklist_item",
    "set_service_plan_reminder",
    "record_service_interaction"
  ],
  interactions: [...commonReadTools],
  shelter: [
    ...commonReadTools,
    "search_211_services",
    "answer_211_question"
  ],
  "provider-clients": [...commonReadTools, "search_211_services", "answer_211_question"],
  "provider-cases": [...commonReadTools, "search_211_services", "answer_211_question", "create_proof"],
  "provider-messages": [...commonReadTools],
  "provider-analytics": [...commonReadTools],
  "provider-proofs": [...commonReadTools, "create_proof", "explain_proof_receipt", "verify_proof_status"],
  "provider-operations": [
    ...commonReadTools,
    "search_211_services",
    "answer_211_question",
    "request_shelter_contact",
    "approve_shelter_contact_request",
    "deny_shelter_contact_request",
    "create_managed_user_account",
    "create_shelter_staff_account",
    "send_shelter_nudge",
    "approve_user_shelter_request",
    "deny_user_shelter_request",
    "add_shelter_as_recipient"
  ],
  "recipient-access": [
    ...commonReadTools,
    "record_controller_approval",
    "approve_access_request",
    "reject_access_request",
    "revoke_access_request",
    "analyze_granted_record",
    "view_granted_record",
    "delegate_grant"
  ],
  "benefits-protection": [...commonReadTools, "search_211_services", "answer_211_question"],
  analytics: [
    ...commonReadTools,
    "select_analytics_study",
    "unselect_analytics_study",
    "explain_analytics_privacy_budget",
    "submit_analytics_consent"
  ],
  "proof-center": [
    ...commonReadTools,
    "create_proof",
    "create_location_region_proof",
    "explain_proof_receipt",
    "verify_proof_status"
  ],
  exports: [...commonReadTools, "create_verified_export_bundle", "import_export_bundle"],
  security: [...commonReadTools, "create_verified_export_bundle", "import_export_bundle", "save_wallet_snapshot", "restore_wallet_snapshot"],
  audit: [
    ...commonReadTools,
    "refresh_wallet_audit",
    "search_audit_events",
    "summarize_audit_events",
    "explain_audit_event"
  ]
};

const contextProvidersByRoute: Record<RouteId, SurfaceContextProviderDefinition[]> = {
  home: [publicContext, appStateContext],
  register: [publicContext, appStateContext, walletPrivateContext],
  "check-in": [publicContext, appStateContext, walletPrivateContext],
  calendar: [publicContext, appStateContext],
  messages: [publicContext, appStateContext],
  contacts: [publicContext, appStateContext, walletMetadataContext],
  "sharing-rules": [publicContext, appStateContext, walletMetadataContext],
  uploads: [publicContext, appStateContext, walletMetadataContext],
  settings: [publicContext, appStateContext, walletPrivateContext],
  "social-services": [publicContext, appStateContext],
  interactions: [publicContext, appStateContext],
  shelter: [publicContext, appStateContext],
  "provider-clients": [publicContext, appStateContext],
  "provider-cases": [publicContext, appStateContext, walletMetadataContext],
  "provider-messages": [publicContext, appStateContext],
  "provider-analytics": [publicContext, appStateContext],
  "provider-proofs": [publicContext, appStateContext, walletMetadataContext],
  "provider-operations": [publicContext, appStateContext],
  "recipient-access": [publicContext, appStateContext, walletMetadataContext],
  "benefits-protection": [publicContext, appStateContext, walletMetadataContext],
  analytics: [publicContext, appStateContext, walletMetadataContext],
  "proof-center": [publicContext, appStateContext, walletMetadataContext, walletPrivateContext],
  exports: [publicContext, appStateContext, walletMetadataContext],
  security: [publicContext, appStateContext, walletMetadataContext],
  audit: [publicContext, appStateContext, walletMetadataContext]
};

const toolPolicies: Record<AgentCommandName, ToolPolicy> = {
  navigate: {
    title: "Navigate",
    permissionLevel: "public",
    surfaces: [...allRoutes],
    requiresConfirmation: false,
    requiresWalletUnlock: false,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  read_surface_context: {
    title: "Read surface context",
    permissionLevel: "app_context",
    surfaces: [...allRoutes],
    requiresConfirmation: false,
    requiresWalletUnlock: false,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  search_211_services: {
    title: "Search the 211 service index",
    permissionLevel: "public",
    surfaces: [...allRoutes],
    requiresConfirmation: false,
    requiresWalletUnlock: false,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  answer_211_question: {
    title: "Answer 211 question",
    permissionLevel: "public",
    surfaces: [...allRoutes],
    requiresConfirmation: false,
    requiresWalletUnlock: false,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  open_service_detail: {
    title: "Open service detail",
    permissionLevel: "public",
    surfaces: ["social-services"],
    requiresConfirmation: false,
    requiresWalletUnlock: false,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  save_service: {
    title: "Save service",
    permissionLevel: "wallet_write",
    surfaces: ["social-services"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.service.save"
  },
  create_service_plan: {
    title: "Create service plan",
    permissionLevel: "wallet_write",
    surfaces: ["social-services"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: true,
    auditEventType: "agent.service_plan.create"
  },
  add_service_plan_checklist_item: {
    title: "Add service plan checklist item",
    permissionLevel: "wallet_write",
    surfaces: ["social-services"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: true,
    auditEventType: "agent.service_plan.checklist.add"
  },
  set_service_plan_reminder: {
    title: "Set service plan reminder",
    permissionLevel: "wallet_write",
    surfaces: ["social-services"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: true,
    auditEventType: "agent.service_plan.reminder.set"
  },
  record_service_interaction: {
    title: "Record service interaction",
    permissionLevel: "wallet_write",
    surfaces: ["social-services"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: true,
    auditEventType: "agent.service_interaction.record"
  },
  update_registration_draft: {
    title: "Update registration draft",
    permissionLevel: "wallet_private",
    surfaces: ["register", "settings"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: true,
    auditEventType: "agent.registration.update"
  },
  update_check_in_policy: {
    title: "Update check-in policy",
    permissionLevel: "wallet_write",
    surfaces: ["check-in", "settings"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.check_in_policy.update"
  },
  add_recipient: {
    title: "Add recipient",
    permissionLevel: "wallet_write",
    surfaces: ["contacts", "sharing-rules"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.recipient.add"
  },
  edit_recipient: {
    title: "Edit recipient",
    permissionLevel: "wallet_write",
    surfaces: ["contacts", "sharing-rules"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.recipient.edit"
  },
  remove_recipient: {
    title: "Remove recipient",
    permissionLevel: "wallet_write",
    surfaces: ["contacts", "sharing-rules"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.recipient.remove"
  },
  update_recipient_scopes: {
    title: "Update recipient scopes",
    permissionLevel: "wallet_write",
    surfaces: ["sharing-rules"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.recipient_scopes.update"
  },
  preview_sharing_capabilities: {
    title: "Preview sharing capabilities",
    permissionLevel: "wallet_metadata",
    surfaces: ["contacts", "sharing-rules"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  request_shelter_contact: {
    title: "Request shelter contact",
    permissionLevel: "wallet_write",
    surfaces: ["contacts", "provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.shelter_contact.request"
  },
  approve_shelter_contact_request: {
    title: "Approve shelter contact request",
    permissionLevel: "wallet_write",
    surfaces: ["contacts", "provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.shelter_contact.approve"
  },
  deny_shelter_contact_request: {
    title: "Deny shelter contact request",
    permissionLevel: "wallet_write",
    surfaces: ["contacts", "provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.shelter_contact.deny"
  },
  create_managed_user_account: {
    title: "Create managed user account",
    permissionLevel: "wallet_write",
    surfaces: ["provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.shelter_user.create"
  },
  create_shelter_staff_account: {
    title: "Create shelter staff account",
    permissionLevel: "wallet_write",
    surfaces: ["provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.shelter_staff.create"
  },
  send_shelter_nudge: {
    title: "Send shelter nudge",
    permissionLevel: "wallet_write",
    surfaces: ["provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.shelter_nudge.send"
  },
  approve_user_shelter_request: {
    title: "Approve user shelter request",
    permissionLevel: "wallet_write",
    surfaces: ["provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.user_shelter_request.approve"
  },
  deny_user_shelter_request: {
    title: "Deny user shelter request",
    permissionLevel: "wallet_write",
    surfaces: ["provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.user_shelter_request.deny"
  },
  add_shelter_as_recipient: {
    title: "Add shelter as recipient",
    permissionLevel: "wallet_write",
    surfaces: ["provider-operations"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.shelter_recipient.add"
  },
  summarize_upload_requirements: {
    title: "Summarize upload requirements",
    permissionLevel: "public",
    surfaces: ["uploads"],
    requiresConfirmation: false,
    requiresWalletUnlock: false,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  classify_uploaded_document: {
    title: "Classify uploaded document",
    permissionLevel: "wallet_write",
    surfaces: ["uploads"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false
  },
  repair_upload_storage: {
    title: "Repair upload storage",
    permissionLevel: "wallet_write",
    surfaces: ["uploads"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.upload.storage.repair"
  },
  toggle_upload_shared: {
    title: "Toggle upload sharing",
    permissionLevel: "share_or_disclose",
    surfaces: ["uploads"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.upload.shared.toggle"
  },
  set_disclosure_scopes: {
    title: "Set disclosure scopes",
    permissionLevel: "wallet_write",
    surfaces: ["sharing-rules"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.disclosure_scopes.set"
  },
  record_controller_approval: {
    title: "Record controller approval",
    permissionLevel: "wallet_write",
    surfaces: ["recipient-access"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.access_request.controller_approval"
  },
  approve_access_request: {
    title: "Approve access request",
    permissionLevel: "wallet_write",
    surfaces: ["recipient-access"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.access_request.approve"
  },
  reject_access_request: {
    title: "Reject access request",
    permissionLevel: "wallet_write",
    surfaces: ["recipient-access"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.access_request.reject"
  },
  revoke_access_request: {
    title: "Revoke access request",
    permissionLevel: "wallet_write",
    surfaces: ["recipient-access"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.access_request.revoke"
  },
  analyze_granted_record: {
    title: "Analyze granted record",
    permissionLevel: "wallet_write",
    surfaces: ["recipient-access"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.grant_record.analyze"
  },
  view_granted_record: {
    title: "View granted record",
    permissionLevel: "wallet_write",
    surfaces: ["recipient-access"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.grant_record.view"
  },
  delegate_grant: {
    title: "Delegate grant",
    permissionLevel: "wallet_write",
    surfaces: ["recipient-access"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.grant.delegate"
  },
  create_location_region_proof: {
    title: "Create location proof",
    permissionLevel: "wallet_write",
    surfaces: ["proof-center"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: true,
    auditEventType: "agent.proof.location_region.create"
  },
  create_proof: {
    title: "Create proof",
    permissionLevel: "wallet_write",
    surfaces: ["proof-center", "provider-cases", "provider-proofs"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: true,
    auditEventType: "agent.proof.create"
  },
  explain_proof_receipt: {
    title: "Explain proof receipt",
    permissionLevel: "wallet_metadata",
    surfaces: ["proof-center", "provider-proofs"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  verify_proof_status: {
    title: "Verify proof status",
    permissionLevel: "wallet_metadata",
    surfaces: ["proof-center", "provider-proofs"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  create_verified_export_bundle: {
    title: "Create verified export bundle",
    permissionLevel: "wallet_write",
    surfaces: ["exports", "security"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.export_bundle.create"
  },
  import_export_bundle: {
    title: "Import export bundle",
    permissionLevel: "wallet_write",
    surfaces: ["exports", "security"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.export_bundle.import"
  },
  select_analytics_study: {
    title: "Select analytics study",
    permissionLevel: "wallet_metadata",
    surfaces: ["analytics"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  unselect_analytics_study: {
    title: "Unselect analytics study",
    permissionLevel: "wallet_metadata",
    surfaces: ["analytics"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  explain_analytics_privacy_budget: {
    title: "Explain analytics privacy budget",
    permissionLevel: "wallet_metadata",
    surfaces: ["analytics"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  submit_analytics_consent: {
    title: "Submit analytics consent",
    permissionLevel: "wallet_write",
    surfaces: ["analytics"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.analytics_consent.submit"
  },
  save_wallet_snapshot: {
    title: "Save wallet snapshot",
    permissionLevel: "wallet_write",
    surfaces: ["security"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.wallet_snapshot.save"
  },
  restore_wallet_snapshot: {
    title: "Restore wallet snapshot",
    permissionLevel: "wallet_write",
    surfaces: ["security"],
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    auditEventType: "agent.wallet_snapshot.restore"
  },
  refresh_wallet_audit: {
    title: "Refresh wallet audit",
    permissionLevel: "wallet_metadata",
    surfaces: ["audit"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  search_audit_events: {
    title: "Search audit events",
    permissionLevel: "wallet_metadata",
    surfaces: ["audit"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  summarize_audit_events: {
    title: "Summarize audit events",
    permissionLevel: "wallet_metadata",
    surfaces: ["audit"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  },
  explain_audit_event: {
    title: "Explain audit event",
    permissionLevel: "wallet_metadata",
    surfaces: ["audit"],
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false
  }
};

export const agentSurfaces: AgentSurfaceDefinition[] = allRoutes.map((route) => ({
  route,
  label: routeLabels[route],
  contextProviders: contextProvidersByRoute[route],
  tools: surfaceTools[route]
}));

export const agentToolDefinitions: AgentToolDefinition[] = Object.entries(toolPolicies).map(([name, policy]) => {
  const commandName = name as AgentCommandName;
  const schema = commandSchemas[commandName];
  const permissionPolicy = getAgentToolPermissionPolicy(commandName);
  return {
    name: commandName,
    title: policy.title,
    description: schema.description,
    inputSchema: schema.inputSchema,
    outputSchema: schema.outputSchema,
    permissionLevel: permissionLevelForGate(permissionPolicy.gate),
    surfaces: policy.surfaces,
    requiresConfirmation: permissionPolicy.requiresConfirmation,
    requiresAudit: permissionPolicy.requiresAudit,
    requiresWalletUnlock: permissionPolicy.requiresWalletUnlock,
    requiresUserPresence: permissionPolicy.requiresUserPresence,
    requiresPrivateContextOptIn: permissionPolicy.requiresPrivateContextOptIn,
    auditEventType: permissionPolicy.auditEventType
  };
});

export function isSurfaceContextScope(value: unknown): value is SurfaceContextScope {
  return isOneOf(SURFACE_CONTEXT_SCOPES, value);
}

export function isSurfaceContextProviderDefinition(value: unknown): value is SurfaceContextProviderDefinition {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.label) &&
    isSurfaceContextScope(value.scope) &&
    isAgentPermissionLevel(value.permissionLevel)
  );
}

export function isAgentSurfaceDefinition(value: unknown): value is AgentSurfaceDefinition {
  return (
    isRecord(value) &&
    isRouteId(value.route) &&
    isString(value.label) &&
    Array.isArray(value.contextProviders) &&
    value.contextProviders.every(isSurfaceContextProviderDefinition) &&
    Array.isArray(value.tools) &&
    value.tools.every(isAgentCommandName)
  );
}

export function isRegisteredAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  return isAgentToolDefinition(value) && isAgentCommandName(value.name);
}

export function validateSurfaceRegistry(): string[] {
  const errors: string[] = [];
  const seenRoutes = new Set<RouteId>();
  const seenTools = new Set<AgentCommandName>();

  for (const surface of agentSurfaces) {
    if (!isAgentSurfaceDefinition(surface)) {
      errors.push("Invalid agent surface definition.");
      continue;
    }
    if (seenRoutes.has(surface.route)) {
      errors.push(`Duplicate agent surface route: ${surface.route}`);
    }
    seenRoutes.add(surface.route);

    for (const toolName of surface.tools) {
      const tool = commandSchemas[toolName];
      if (!tool) {
        errors.push(`Surface ${surface.route} references unknown tool: ${toolName}`);
      }
      const definition = agentToolDefinitions.find((candidate) => candidate.name === toolName);
      if (!definition) {
        errors.push(`Surface ${surface.route} references tool without a definition: ${toolName}`);
      } else if (!definition.surfaces.includes(surface.route)) {
        errors.push(`Surface ${surface.route} registers tool ${toolName} but the tool does not allow that route.`);
      }
    }
  }

  for (const route of allRoutes) {
    if (!seenRoutes.has(route)) {
      errors.push(`Missing agent surface route: ${route}`);
    }
  }

  for (const tool of agentToolDefinitions) {
    if (!isRegisteredAgentToolDefinition(tool)) {
      errors.push("Invalid agent tool definition.");
      continue;
    }
    const commandName = tool.name as AgentCommandName;
    seenTools.add(commandName);

    for (const route of tool.surfaces) {
      const surface = getSurfaceDefinition(route);
      if (!surface.tools.includes(commandName)) {
        errors.push(`Tool ${commandName} allows ${route} but is not registered on that surface.`);
      }
    }
  }

  for (const commandName of Object.keys(commandSchemas) as AgentCommandName[]) {
    if (!seenTools.has(commandName)) {
      errors.push(`Missing agent tool definition for command: ${commandName}`);
    }
  }

  return errors;
}

export function getSurfaceDefinition(route: RouteId): AgentSurfaceDefinition {
  return agentSurfaces.find((surface) => surface.route === route) || agentSurfaces[0];
}

export function getRouteLabel(route: RouteId): string {
  return routeLabels[route];
}

export function getToolDefinition(name: AgentCommandName): AgentToolDefinition {
  const definition = agentToolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Unknown agent tool: ${name}`);
  }
  return definition;
}

export function listToolsForSurface(route: RouteId, permissionLevel: AgentPermissionLevel = "public"): AgentToolDefinition[] {
  const surface = getSurfaceDefinition(route);
  return surface.tools
    .map(getToolDefinition)
    .filter((tool) => hasPermissionLevel(permissionLevel, tool.permissionLevel));
}

export function canUseToolOnSurface(name: AgentCommandName, route: RouteId, permissionLevel: AgentPermissionLevel): boolean {
  const tool = getToolDefinition(name);
  return tool.surfaces.includes(route) && hasPermissionLevel(permissionLevel, tool.permissionLevel);
}

export function listContextProvidersForSurface(
  route: RouteId,
  permissionLevel: AgentPermissionLevel = "public"
): SurfaceContextProviderDefinition[] {
  return getSurfaceDefinition(route).contextProviders.filter((provider) =>
    hasPermissionLevel(permissionLevel, provider.permissionLevel)
  );
}
