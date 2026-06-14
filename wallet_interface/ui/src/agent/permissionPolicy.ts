import type { RouteId } from "../models/abby";
import type { AgentCommandName } from "./commandSchemas";
import type { AgentConfirmationRisk, AgentPermissionLevel } from "./types";
import { hasPermissionLevel } from "./types";

export const AGENT_PERMISSION_GATES = [
  "read_public",
  "read_wallet_summary",
  "write_wallet",
  "share_or_disclose"
] as const;

export type AgentPermissionGate = (typeof AGENT_PERMISSION_GATES)[number];

export type AgentPermissionPolicyFailureCode =
  | "surface_not_allowed"
  | "permission_denied"
  | "wallet_locked"
  | "user_presence_required"
  | "private_context_required";

export interface AgentToolPermissionPolicy {
  gate: AgentPermissionGate;
  requiresConfirmation: boolean;
  requiresWalletUnlock: boolean;
  requiresUserPresence: boolean;
  requiresPrivateContextOptIn: boolean;
  requiresAudit: boolean;
  auditEventType?: string;
}

export interface AgentPermissionPolicyEnvironment {
  route: RouteId;
  allowedSurfaces: readonly RouteId[];
  grantedPermissionLevel: AgentPermissionLevel;
  walletUnlocked: boolean;
  privateContextAllowed: boolean;
  userPresent: boolean;
  toolTitle?: string;
}

export interface AgentPermissionPolicyAllowed {
  ok: true;
  policy: AgentToolPermissionPolicy;
}

export interface AgentPermissionPolicyDenied {
  ok: false;
  policy: AgentToolPermissionPolicy;
  code: AgentPermissionPolicyFailureCode;
  message: string;
}

export type AgentPermissionPolicyDecision = AgentPermissionPolicyAllowed | AgentPermissionPolicyDenied;

export const agentToolPermissionPolicies: Record<AgentCommandName, AgentToolPermissionPolicy> = {
  navigate: readPublicPolicy(),
  read_surface_context: readPublicPolicy(),
  search_211_services: readPublicPolicy(),
  answer_211_question: readPublicPolicy(),
  open_service_detail: readPublicPolicy(),
  save_service: writeWalletPolicy("agent.service.save"),
  create_service_plan: writeWalletPolicy("agent.service_plan.create", { requiresPrivateContextOptIn: true }),
  add_service_plan_checklist_item: writeWalletPolicy("agent.service_plan.checklist.add", { requiresPrivateContextOptIn: true }),
  set_service_plan_reminder: writeWalletPolicy("agent.service_plan.reminder.set", { requiresPrivateContextOptIn: true }),
  record_service_interaction: writeWalletPolicy("agent.service_interaction.record", { requiresPrivateContextOptIn: true }),
  update_registration_draft: writeWalletPolicy("agent.registration.update", { requiresPrivateContextOptIn: true }),
  update_check_in_policy: writeWalletPolicy("agent.check_in_policy.update"),
  add_recipient: shareOrDisclosePolicy("agent.recipient.add"),
  edit_recipient: shareOrDisclosePolicy("agent.recipient.edit"),
  remove_recipient: shareOrDisclosePolicy("agent.recipient.remove"),
  update_recipient_scopes: shareOrDisclosePolicy("agent.recipient_scopes.update"),
  preview_sharing_capabilities: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  request_shelter_contact: shareOrDisclosePolicy("agent.shelter_contact.request"),
  approve_shelter_contact_request: shareOrDisclosePolicy("agent.shelter_contact.approve"),
  deny_shelter_contact_request: shareOrDisclosePolicy("agent.shelter_contact.deny"),
  create_managed_user_account: shareOrDisclosePolicy("agent.shelter_user.create"),
  create_shelter_staff_account: shareOrDisclosePolicy("agent.shelter_staff.create"),
  send_shelter_nudge: shareOrDisclosePolicy("agent.shelter_nudge.send"),
  approve_user_shelter_request: shareOrDisclosePolicy("agent.user_shelter_request.approve"),
  deny_user_shelter_request: shareOrDisclosePolicy("agent.user_shelter_request.deny"),
  add_shelter_as_recipient: shareOrDisclosePolicy("agent.shelter_recipient.add"),
  summarize_upload_requirements: readPublicPolicy(),
  classify_uploaded_document: {
    gate: "write_wallet",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  repair_upload_storage: writeWalletPolicy("agent.upload.storage.repair"),
  toggle_upload_shared: shareOrDisclosePolicy("agent.upload.shared.toggle"),
  set_disclosure_scopes: shareOrDisclosePolicy("agent.disclosure_scopes.set"),
  record_controller_approval: writeWalletPolicy("agent.access_request.controller_approval"),
  approve_access_request: writeWalletPolicy("agent.access_request.approve"),
  reject_access_request: writeWalletPolicy("agent.access_request.reject"),
  revoke_access_request: writeWalletPolicy("agent.access_request.revoke"),
  analyze_granted_record: shareOrDisclosePolicy("agent.grant_record.analyze"),
  view_granted_record: shareOrDisclosePolicy("agent.grant_record.view"),
  delegate_grant: shareOrDisclosePolicy("agent.grant.delegate"),
  create_proof: writeWalletPolicy("agent.proof.create", {
    requiresPrivateContextOptIn: true
  }),
  create_location_region_proof: writeWalletPolicy("agent.proof.location_region.create", {
    requiresPrivateContextOptIn: true
  }),
  explain_proof_receipt: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  verify_proof_status: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  create_verified_export_bundle: shareOrDisclosePolicy("agent.export_bundle.create"),
  import_export_bundle: writeWalletPolicy("agent.export_bundle.import"),
  select_analytics_study: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  unselect_analytics_study: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  explain_analytics_privacy_budget: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  submit_analytics_consent: writeWalletPolicy("agent.analytics_consent.submit"),
  save_wallet_snapshot: writeWalletPolicy("agent.wallet_snapshot.save"),
  restore_wallet_snapshot: writeWalletPolicy("agent.wallet_snapshot.restore"),
  refresh_wallet_audit: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  search_audit_events: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  summarize_audit_events: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  },
  explain_audit_event: {
    gate: "read_wallet_summary",
    requiresConfirmation: false,
    requiresWalletUnlock: true,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  }
};

export function getAgentToolPermissionPolicy(name: AgentCommandName): AgentToolPermissionPolicy {
  return agentToolPermissionPolicies[name];
}

export function evaluateAgentToolPermissionPolicy(
  name: AgentCommandName,
  environment: AgentPermissionPolicyEnvironment
): AgentPermissionPolicyDecision {
  const policy = getAgentToolPermissionPolicy(name);
  const title = environment.toolTitle ?? name;

  if (!environment.allowedSurfaces.includes(environment.route)) {
    return denied(policy, "surface_not_allowed", `${title} cannot run from this surface.`);
  }

  if (!hasAgentPermissionGate(environment.grantedPermissionLevel, policy.gate)) {
    return denied(policy, "permission_denied", `${title} requires ${policy.gate} permission.`);
  }

  if (policy.requiresWalletUnlock && !environment.walletUnlocked) {
    return denied(policy, "wallet_locked", `${title} requires an unlocked wallet.`);
  }

  if (policy.requiresUserPresence && !environment.userPresent) {
    return denied(policy, "user_presence_required", `${title} requires user presence.`);
  }

  if (policy.requiresPrivateContextOptIn && !environment.privateContextAllowed) {
    return denied(policy, "private_context_required", `${title} requires private context permission.`);
  }

  return {
    ok: true,
    policy
  };
}

export function hasAgentPermissionGate(granted: AgentPermissionLevel, required: AgentPermissionGate): boolean {
  return hasPermissionLevel(granted, required);
}

export function permissionLevelForGate(gate: AgentPermissionGate): AgentPermissionLevel {
  return gate;
}

export function confirmationRiskForGate(gate: AgentPermissionGate): AgentConfirmationRisk {
  if (gate === "share_or_disclose") return "restricted";
  if (gate === "write_wallet") return "high";
  if (gate === "read_wallet_summary") return "moderate";
  return "low";
}

export function isAgentPermissionGate(value: unknown): value is AgentPermissionGate {
  return typeof value === "string" && AGENT_PERMISSION_GATES.includes(value as AgentPermissionGate);
}

function readPublicPolicy(): AgentToolPermissionPolicy {
  return {
    gate: "read_public",
    requiresConfirmation: false,
    requiresWalletUnlock: false,
    requiresUserPresence: false,
    requiresPrivateContextOptIn: false,
    requiresAudit: false
  };
}

function writeWalletPolicy(
  auditEventType: string,
  options: Partial<Pick<AgentToolPermissionPolicy, "requiresPrivateContextOptIn">> = {}
): AgentToolPermissionPolicy {
  return {
    gate: "write_wallet",
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: options.requiresPrivateContextOptIn ?? false,
    requiresAudit: true,
    auditEventType
  };
}

function shareOrDisclosePolicy(
  auditEventType: string,
  options: Partial<Pick<AgentToolPermissionPolicy, "requiresPrivateContextOptIn">> = {}
): AgentToolPermissionPolicy {
  return {
    gate: "share_or_disclose",
    requiresConfirmation: true,
    requiresWalletUnlock: true,
    requiresUserPresence: true,
    requiresPrivateContextOptIn: options.requiresPrivateContextOptIn ?? false,
    requiresAudit: true,
    auditEventType
  };
}

function denied(
  policy: AgentToolPermissionPolicy,
  code: AgentPermissionPolicyFailureCode,
  message: string
): AgentPermissionPolicyDenied {
  return {
    ok: false,
    policy,
    code,
    message
  };
}
