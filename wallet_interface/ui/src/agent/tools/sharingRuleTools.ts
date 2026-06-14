import type { DisclosureDataScope } from "../../models/abby";
import {
  abilitiesForDisclosureScopes,
  plainCapabilitySummary,
  plainNonGrantedCapabilities
} from "../../services/capabilities";
import type { AppActionOptions, AppActionResult, AppActionRuntime } from "../../app/appActions";
import type {
  PreviewSharingCapabilitiesCommandInput,
  SetDisclosureScopesCommandInput,
  UpdateRecipientScopesCommandInput
} from "../commandSchemas";
import type { AgentCommandName } from "../commandSchemas";
import type { AgentConfirmationRisk, AgentPermissionLevel } from "../types";
import { confirmationRiskForGate, getAgentToolPermissionPolicy } from "../permissionPolicy";
import { getToolDefinition } from "../surfaceRegistry";

const disclosureScopeLabels: Record<DisclosureDataScope, string> = {
  benefits_information: "Benefits information",
  current_location: "Current location",
  custom: "Custom note",
  found_permanent_housing: "Found permanent housing",
  identity_minimum: "Minimum identity",
  medical_notes: "Medical notes",
  missed_check_in: "Missed check-in",
  photo: "Photo or ID file",
  profile: "Profile",
  shelter_history: "Shelter history",
  uploaded_documents: "Wallet files"
};

export async function previewSharingCapabilitiesAction(
  runtime: AppActionRuntime,
  input: PreviewSharingCapabilitiesCommandInput
): Promise<AppActionResult> {
  const state = runtime.getState();
  const recipient = input.recipientId
    ? state.recipients.find((item) => item.id === input.recipientId)
    : undefined;
  if (input.recipientId && !recipient) {
    return failure(
      "preview_sharing_capabilities",
      "recipient_not_found",
      `Recipient ${input.recipientId} was not found.`
    );
  }

  const scopes = uniqueScopes(input.allowedScopes ?? recipient?.allowedScopes ?? []);
  const preview = buildSharingCapabilityPreview(scopes);
  const recipientName = recipient?.displayName ?? "this recipient";
  return success(
    "preview_sharing_capabilities",
    `${recipientName} would be allowed to ${preview.capabilitySummary || "access nothing"}.`,
    {
      artifactId: input.recipientId,
      metadata: {
        recipientId: input.recipientId,
        recipientName: recipient?.displayName,
        preview
      }
    }
  );
}

export async function updateRecipientScopesAction(
  runtime: AppActionRuntime,
  input: UpdateRecipientScopesCommandInput,
  options: AppActionOptions
): Promise<AppActionResult> {
  const blocked = requiresConfirmation("update_recipient_scopes", input, options);
  if (blocked) return blocked;
  const setRecipients = requireSetter("update_recipient_scopes", runtime.setRecipients, "Recipients");
  if (typeof setRecipients !== "function") return setRecipients;

  const state = runtime.getState();
  const recipient = state.recipients.find((item) => item.id === input.recipientId);
  if (!recipient) {
    return failure("update_recipient_scopes", "recipient_not_found", `Recipient ${input.recipientId} was not found.`);
  }

  const nextScopes = uniqueScopes(input.allowedScopes);
  const change = buildScopeChange(recipient.allowedScopes, nextScopes);
  const preview = buildSharingCapabilityPreview(nextScopes);
  if (!input.stageOnly) {
    setRecipients(
      state.recipients.map((item) =>
        item.id === input.recipientId ? { ...item, allowedScopes: [...nextScopes] } : item
      )
    );
  }

  return success(
    "update_recipient_scopes",
    `${input.stageOnly ? "Staged" : "Updated"} sharing scopes for ${recipient.displayName}.`,
    {
      artifactId: input.recipientId,
      confirmation: confirmationFor("update_recipient_scopes", input),
      metadata: {
        recipientId: input.recipientId,
        recipientName: recipient.displayName,
        change,
        preview,
        stagedOnly: input.stageOnly === true
      }
    }
  );
}

export async function setDisclosureScopesAction(
  runtime: AppActionRuntime,
  input: SetDisclosureScopesCommandInput,
  options: AppActionOptions
): Promise<AppActionResult> {
  const result = await updateRecipientScopesAction(
    runtime,
    { recipientId: input.recipientId, allowedScopes: input.allowedScopes },
    options
  );
  return result.ok
    ? {
        ...result,
        action: "set_disclosure_scopes",
        summary: result.summary.replace(/^Updated sharing scopes/, "Updated sharing scopes"),
        confirmation: confirmationFor("set_disclosure_scopes", input)
      }
    : {
        ...result,
        action: "set_disclosure_scopes",
        confirmation: result.confirmation ? confirmationFor("set_disclosure_scopes", input) : result.confirmation
      };
}

export function buildSharingCapabilityPreview(scopes: DisclosureDataScope[]) {
  const allowedScopes = uniqueScopes(scopes);
  const abilities = abilitiesForDisclosureScopes(allowedScopes);
  return {
    allowedScopes,
    scopeLabels: allowedScopes.map((scope) => disclosureScopeLabels[scope] ?? scope),
    abilities,
    capabilitySummary: plainCapabilitySummary(abilities),
    notAllowed: plainNonGrantedCapabilities(abilities)
  };
}

function buildScopeChange(currentScopes: DisclosureDataScope[], nextScopes: DisclosureDataScope[]) {
  const current = new Set(currentScopes);
  const next = new Set(nextScopes);
  const added = nextScopes.filter((scope) => !current.has(scope));
  const removed = currentScopes.filter((scope) => !next.has(scope));
  return {
    added,
    removed,
    expanded: added.length > 0,
    reduced: removed.length > 0
  };
}

function uniqueScopes(scopes: string[]): DisclosureDataScope[] {
  return Array.from(new Set(scopes)) as DisclosureDataScope[];
}

function success(
  action: AgentCommandName,
  summary: string,
  extra: Omit<Extract<AppActionResult, { ok: true }>, "ok" | "action" | "summary"> = {}
): AppActionResult {
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
  extra: Omit<Extract<AppActionResult, { ok: false }>, "ok" | "action" | "errorCode" | "message"> = {}
): AppActionResult {
  return {
    ok: false,
    action,
    errorCode,
    message,
    ...extra
  };
}

function confirmationFor(action: AgentCommandName, input: unknown) {
  const tool = getToolDefinition(action);
  const policy = getAgentToolPermissionPolicy(action);
  return {
    required: tool.requiresConfirmation,
    title: tool.title,
    summary: summarizeConfirmation(action, input),
    risk: confirmationRiskForGate(policy.gate) as AgentConfirmationRisk,
    permissionLevel: tool.permissionLevel as AgentPermissionLevel,
    auditEventType: tool.auditEventType,
    details: input && typeof input === "object" ? { input, permissionGate: policy.gate, requiresAudit: policy.requiresAudit } : undefined
  };
}

function summarizeConfirmation(action: AgentCommandName, input: unknown): string {
  if ((action === "update_recipient_scopes" || action === "set_disclosure_scopes") && isRecord(input)) {
    return `Update sharing scopes for recipient ${String(input.recipientId ?? "")}.`;
  }
  return getToolDefinition(action).title;
}

function requiresConfirmation(action: AgentCommandName, input: unknown, options: AppActionOptions): AppActionResult | undefined {
  const confirmation = confirmationFor(action, input);
  if (!confirmation.required || options.confirmed) return undefined;
  return failure(action, "confirmation_required", confirmation.summary, { confirmation });
}

function requireSetter<T>(
  action: AgentCommandName,
  setter: ((value: T) => void) | undefined,
  label: string
): ((value: T) => void) | AppActionResult {
  if (setter) return setter;
  return failure(action, "missing_app_setter", `${label} is not writable in this app action runtime.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
