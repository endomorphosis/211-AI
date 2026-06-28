import type { RouteId } from "../models/abby";
import type { AgentCommandName } from "./commandSchemas";
import { getRouteLabel, getToolDefinition } from "./surfaceRegistry";
import { resolveNavigationRoute } from "./tools/navigationTools";
import type { AgentConfirmationRequest, AgentIntentKind, SurfaceContext } from "./types";

export interface AgentPlannedTool {
  name: AgentCommandName;
  input: unknown;
  title: string;
}

export interface AgentConfirmationDecision {
  confirmationId: string;
  approved: boolean;
}

export interface AgentPlannedTurn {
  intentKind: AgentIntentKind;
  summary: string;
  tools: AgentPlannedTool[];
  response?: string;
  confirmationDecision?: AgentConfirmationDecision;
}

export interface AgentPlannerInput {
  content: string;
  context: SurfaceContext;
  pendingConfirmations?: AgentConfirmationRequest[];
}

const serviceQuestionPattern =
  /\b(211|service|services|shelter|housing|rent|eviction|food|pantry|meal|benefits|snap|medicaid|legal|clinic|health|transport|bus|crisis|mental health|domestic violence|utility|utilities|near me|nearby)\b/i;

const serviceSearchPattern =
  /\b(search|find|look for|lookup|nearby|near me|closest|open now|available|resources?|programs?)\b/i;

const navigationPattern =
  /\b(go|open|navigate|show|take me|switch|view|visit|jump|move)\b/i;

const confirmationApprovePattern =
  /\b(yes|yep|yeah|approve|approved|confirm|confirmed|ok|okay|sure|do it|go ahead|proceed|continue|sounds good)\b/i;

const confirmationDenyPattern =
  /\b(no|nope|deny|denied|reject|rejected|cancel|stop|do not|don't|dont|never mind|nevermind|abort)\b/i;

export function planAgentTurn(input: AgentPlannerInput): AgentPlannedTurn {
  const content = input.content.trim();
  const lower = content.toLowerCase();
  const pendingConfirmations = input.pendingConfirmations ?? [];

  const confirmationDecision = planConfirmationDecision(lower, pendingConfirmations);
  if (confirmationDecision) {
    return {
      intentKind: "wallet_action",
      summary: confirmationDecision.approved ? "Approve pending confirmation." : "Deny pending confirmation.",
      tools: [],
      confirmationDecision
    };
  }

  if (isConfirmationReply(lower) && pendingConfirmations.length > 1) {
    return {
      intentKind: "wallet_action",
      summary: "Clarify pending confirmation.",
      tools: [],
      response: "I need to know which pending action you mean before I approve or cancel it."
    };
  }

  const saveServiceId = parseServiceId(lower, content, input.context, "save");
  if (saveServiceId) {
    return {
      intentKind: "wallet_action",
      summary: `Save service ${saveServiceId}.`,
      tools: withToolSurface(input.context, [
        { name: "save_service", input: { serviceId: saveServiceId }, title: getToolDefinition("save_service").title }
      ])
    };
  }

  const servicePlanId = parseServiceId(lower, content, input.context, "plan");
  if (servicePlanId) {
    return {
      intentKind: "wallet_action",
      summary: `Create a service plan for ${servicePlanId}.`,
      tools: withToolSurface(input.context, [
        {
          name: "create_service_plan",
          input: { serviceId: servicePlanId, goal: content },
          title: getToolDefinition("create_service_plan").title
        }
      ])
    };
  }

  if (isSaveOrPlanRequest(lower) && !saveServiceId && !servicePlanId) {
    return {
      intentKind: "wallet_action",
      summary: "Clarify service selection.",
      tools: [],
      response: "Which service should I use? Send the service ID, or open a service record first."
    };
  }

  const servicePlanUpdateTool = planServicePlanUpdateTool(lower, content);
  if (servicePlanUpdateTool) {
    return {
      intentKind: "wallet_action",
      summary: servicePlanUpdateTool.title,
      tools: withToolSurface(input.context, [servicePlanUpdateTool])
    };
  }

  const serviceInteractionTool = planServiceInteractionTool(lower, content, input.context);
  if (serviceInteractionTool) {
    return {
      intentKind: "wallet_action",
      summary: serviceInteractionTool.title,
      tools: withToolSurface(input.context, [serviceInteractionTool])
    };
  }

  const accessRequestTool = planRecipientAccessRequestTool(lower, content);
  if (accessRequestTool) {
    return {
      intentKind: "wallet_action",
      summary: accessRequestTool.title,
      tools: withToolSurface(input.context, [accessRequestTool])
    };
  }

  const contactTool = planContactTool(lower, content);
  if (contactTool) {
    return {
      intentKind: "wallet_action",
      summary: contactTool.title,
      tools: withToolSurface(input.context, [contactTool])
    };
  }

  const grantTool = planRecipientGrantTool(lower, content);
  if (grantTool) {
    return {
      intentKind: "wallet_action",
      summary: grantTool.title,
      tools: withToolSurface(input.context, [grantTool])
    };
  }

  const uploadTool = planUploadTool(lower, content);
  if (uploadTool) {
    return {
      intentKind: "wallet_action",
      summary: uploadTool.title,
      tools: withToolSurface(input.context, [uploadTool])
    };
  }

  const exportTurn = planExportTurn(input.context, lower, content);
  if (exportTurn) return exportTurn;

  const securityTurn = planSecurityTurn(input.context, lower, content);
  if (securityTurn) return securityTurn;

  const analyticsTurn = planAnalyticsTurn(input.context, lower, content);
  if (analyticsTurn) return analyticsTurn;

  const auditTurn = planAuditTurn(input.context, lower, content);
  if (auditTurn) return auditTurn;

  const serviceDetailId = parseServiceId(lower, content, input.context, "open");
  if (serviceDetailId) {
    return {
      intentKind: "service_navigation",
      summary: `Open service ${serviceDetailId}.`,
      tools: withToolSurface(input.context, [
        { name: "open_service_detail", input: { docId: serviceDetailId }, title: getToolDefinition("open_service_detail").title }
      ])
    };
  }

  if (isCurrentSurfaceQuestion(lower)) {
    return {
      intentKind: "app_navigation",
      summary: "Read current surface context.",
      tools: [{ name: "read_surface_context", input: {}, title: getToolDefinition("read_surface_context").title }]
    };
  }

  const routeTarget = parseRouteTarget(lower);
  if (routeTarget && shouldNavigate(lower, routeTarget)) {
    const tools: AgentPlannedTool[] = [
      { name: "navigate", input: { route: routeTarget }, title: getToolDefinition("navigate").title }
    ];
    if (routeTarget === "audit" && /\b(refresh|reload|update|latest|audit|history|activity)\b/.test(lower)) {
      tools.push({
        name: "refresh_wallet_audit",
        input: { limit: 25 },
        title: getToolDefinition("refresh_wallet_audit").title
      });
    }
    return {
      intentKind: routeTarget === "proof-center" ? "proof_request" : routeTarget === "exports" ? "export_request" : "app_navigation",
      summary: `Navigate to ${getRouteLabel(routeTarget)}.`,
      tools
    };
  }

  if (serviceQuestionPattern.test(content)) {
    const toolName: AgentCommandName = serviceSearchPattern.test(lower) ? "search_211_services" : "answer_211_question";
    return {
      intentKind: "service_navigation",
      summary: toolName === "search_211_services" ? "Search 211 service records." : "Answer 211 service question.",
      tools: withToolSurface(input.context, [
        {
          name: toolName,
          input: toolName === "search_211_services" ? { query: content, limit: 8 } : { question: content, useLocalModel: true },
          title: getToolDefinition(toolName).title
        }
      ])
    };
  }

  if (/\b(audit|history|activity log)\b/.test(lower)) {
    return navigationTurn("audit");
  }

  const proofTurn = planProofTurn(input.context, lower, content);
  if (proofTurn) return proofTurn;

  if (/\b(proof|proofs|verify|verification)\b/.test(lower)) {
    return navigationTurn("proof-center", "proof_request");
  }

  if (/\b(export|exports|download|bundle|share bundle)\b/.test(lower)) {
    return navigationTurn("security", "export_request");
  }

  return {
    intentKind: "general_question",
    summary: "Respond from current app context.",
    tools: [],
    response: fallbackResponse(input.context)
  };
}

function planConfirmationDecision(
  lower: string,
  pendingConfirmations: AgentConfirmationRequest[]
): AgentConfirmationDecision | undefined {
  if (!pendingConfirmations.length || !isConfirmationReply(lower)) return undefined;
  const matchingConfirmation = parseConfirmationTarget(lower, pendingConfirmations);
  if (!matchingConfirmation) return undefined;

  const approved = confirmationApprovePattern.test(lower) && !confirmationDenyPattern.test(lower);
  const denied = confirmationDenyPattern.test(lower);
  if (!approved && !denied) return undefined;

  return {
    confirmationId: matchingConfirmation.id,
    approved: approved && !denied
  };
}

function parseConfirmationTarget(
  lower: string,
  pendingConfirmations: AgentConfirmationRequest[]
): AgentConfirmationRequest | undefined {
  if (pendingConfirmations.length === 1) return pendingConfirmations[0];
  return pendingConfirmations.find(
    (confirmation) =>
      lower.includes(confirmation.id.toLowerCase()) ||
      lower.includes(confirmation.toolCallId.toLowerCase()) ||
      lower.includes(confirmation.title.toLowerCase())
  );
}

function isConfirmationReply(lower: string): boolean {
  return confirmationApprovePattern.test(lower) || confirmationDenyPattern.test(lower);
}

function isSaveOrPlanRequest(lower: string): boolean {
  return /\b(save|bookmark|keep|remember)\b/.test(lower) || /\b(plan|follow-up|follow up|next steps?)\b/.test(lower);
}

function isCurrentSurfaceQuestion(lower: string): boolean {
  return /\b(where am i|what screen|what page|this screen|this page|what can i do here|what can i do on this|help here|explain this screen)\b/.test(
    lower
  );
}

function shouldNavigate(lower: string, route: RouteId): boolean {
  if (navigationPattern.test(lower)) return true;
  if (route === "audit" || route === "proof-center" || route === "security") {
    return /\b(audit|history|proof|proofs|verify|verification|export|exports|bundle|download)\b/.test(lower);
  }
  return false;
}

function navigationTurn(route: RouteId, intentKind: AgentIntentKind = "app_navigation"): AgentPlannedTurn {
  return {
    intentKind,
    summary: `Navigate to ${getRouteLabel(route)}.`,
    tools: [{ name: "navigate", input: { route }, title: getToolDefinition("navigate").title }]
  };
}

function withToolSurface(context: SurfaceContext, tools: AgentPlannedTool[]): AgentPlannedTool[] {
  const firstTool = tools[0];
  if (!firstTool || getToolDefinition(firstTool.name).surfaces.includes(context.route)) {
    return tools;
  }
  const route = firstTool.name === "refresh_wallet_audit" ? "audit" : getToolDefinition(firstTool.name).surfaces[0];
  return [{ name: "navigate", input: { route }, title: getToolDefinition("navigate").title }, ...tools];
}

function planProofTurn(context: SurfaceContext, lower: string, original: string): AgentPlannedTurn | undefined {
  if (!/\b(proof|receipt|verification|verify)\b/.test(lower)) return undefined;

  const proofReference = parseProofReference(original);
  if (proofReference && /\b(explain|what|details?|receipt|mean|show)\b/.test(lower)) {
    return {
      intentKind: "proof_request",
      summary: "Explain proof receipt.",
      tools: withToolSurface(context, [tool("explain_proof_receipt", proofReference)])
    };
  }
  if (proofReference && /\b(verify|status|check)\b/.test(lower)) {
    return {
      intentKind: "proof_request",
      summary: "Verify proof status.",
      tools: withToolSurface(context, [tool("verify_proof_status", proofReference)])
    };
  }
  if (!/\b(create|stage|generate|prepare)\b/.test(lower)) return undefined;

  const claim = parseNamedValue(original, "claim");
  const verifier = parseNamedValue(original, "verifier");
  const witnessLabel = parseNamedValue(original, "witness label") ?? parseNamedValue(original, "witness");
  if (!claim || !verifier || !witnessLabel) {
    return {
      intentKind: "proof_request",
      summary: "Clarify proof creation request.",
      tools: withToolSurface(context, [{ name: "navigate", input: { route: "proof-center" }, title: getToolDefinition("navigate").title }]),
      response: "To stage a proof, I need an explicit claim, verifier, and witness label."
    };
  }

  return {
    intentKind: "proof_request",
    summary: "Stage proof creation.",
    tools: withToolSurface(context, [
      tool("create_proof", {
        claim,
        verifier,
        witnessLabel,
        proofType: parseNamedValue(original, "proof type") ?? undefined,
        regionLabel: parseNamedValue(original, "region") ?? undefined,
        recordId: parseRecordId(original) ?? undefined,
        grantId: parseGrantReference(original)?.grantId
      })
    ])
  };
}

function planExportTurn(context: SurfaceContext, lower: string, original: string): AgentPlannedTurn | undefined {
  if (!/\b(export|exports|bundle|download)\b/.test(lower)) return undefined;

  if (/\b(import|load|ingest)\b/.test(lower)) {
    const bundleId = parseBundleId(original);
    if (!bundleId) {
      return {
        intentKind: "export_request",
        summary: "Clarify export import request.",
        tools: withToolSurface(context, [{ name: "navigate", input: { route: "security" }, title: getToolDefinition("navigate").title }]),
        response: "To import an export bundle, I need the export bundle ID or provided bundle data."
      };
    }
    return {
      intentKind: "export_request",
      summary: "Import export bundle.",
      tools: withToolSurface(context, [tool("import_export_bundle", { bundleId })])
    };
  }

  if (!/\b(create|stage|generate|prepare|make)\b/.test(lower)) return undefined;
  const recordIds = parseRecordIds(original);
  const audienceDid = parseDid(original);
  const audienceName =
    parseNamedValue(original, "audience") ??
    parseNamedValue(original, "recipient") ??
    parseNamedValue(original, "for") ??
    audienceDid;
  if (!audienceName || recordIds.length === 0) {
    return {
      intentKind: "export_request",
      summary: "Clarify export bundle request.",
        tools: withToolSurface(context, [{ name: "navigate", input: { route: "security" }, title: getToolDefinition("navigate").title }]),
      response: "To stage an export bundle, I need a recipient or audience label and at least one record ID."
    };
  }

  return {
    intentKind: "export_request",
    summary: "Stage export bundle creation.",
    tools: withToolSurface(context, [
      tool("create_verified_export_bundle", {
        audienceName,
        ...(audienceDid ? { audienceDid } : {}),
        recordIds,
        proofIds: parseProofIds(original),
        purpose: parseNamedValue(original, "purpose") ?? undefined,
        stageOnly: /\bstage|prepare\b/.test(lower)
      })
    ])
  };
}

function planSecurityTurn(context: SurfaceContext, lower: string, original: string): AgentPlannedTurn | undefined {
  if (!/\b(snapshot|backup|restore|security)\b/.test(lower)) return undefined;

  if (/\b(save|create|make|backup)\b/.test(lower) && /\b(snapshot|backup)\b/.test(lower)) {
    return {
      intentKind: "wallet_action",
      summary: "Save wallet snapshot.",
      tools: withToolSurface(context, [
        tool("save_wallet_snapshot", { reason: parseNamedValue(original, "reason") ?? undefined })
      ])
    };
  }

  if (/\b(restore|load)\b/.test(lower) && /\b(snapshot|backup)\b/.test(lower)) {
    return {
      intentKind: "wallet_action",
      summary: "Restore wallet snapshot.",
      tools: withToolSurface(context, [
        tool("restore_wallet_snapshot", {
          walletId: parseNamedValue(original, "wallet") ?? undefined,
          snapshotHash: parseNamedValue(original, "snapshot hash") ?? parseNamedValue(original, "hash") ?? undefined,
          reason: parseNamedValue(original, "reason") ?? undefined
        })
      ])
    };
  }

  return undefined;
}

function planAnalyticsTurn(context: SurfaceContext, lower: string, original: string): AgentPlannedTurn | undefined {
  if (!/\b(analytics|group facts|privacy budget|epsilon|cohort|study|consent)\b/.test(lower)) return undefined;

  const studyId = parseStudyId(original);
  if (/\b(privacy budget|epsilon|cohort|explain|what|how)\b/.test(lower)) {
    return {
      intentKind: "privacy_question",
      summary: "Explain analytics privacy budget.",
      tools: withToolSurface(context, [tool("explain_analytics_privacy_budget", studyId ? { studyId } : {})])
    };
  }

  if (/\b(turn off|unselect|remove|disable|opt out)\b/.test(lower)) {
    if (!studyId) {
      return {
        intentKind: "privacy_question",
        summary: "Clarify analytics study selection.",
        tools: withToolSurface(context, [{ name: "navigate", input: { route: "analytics" }, title: getToolDefinition("navigate").title }]),
        response: "Which analytics study should I turn off? Send the study ID or title."
      };
    }
    return {
      intentKind: "privacy_question",
      summary: "Unselect analytics study.",
      tools: withToolSurface(context, [tool("unselect_analytics_study", { studyId })])
    };
  }

  if (/\b(select|stage|turn on|enable|opt in|allow)\b/.test(lower) && !/\b(submit|confirm|final)\b/.test(lower)) {
    if (!studyId) {
      return {
        intentKind: "privacy_question",
        summary: "Clarify analytics study selection.",
        tools: withToolSurface(context, [{ name: "navigate", input: { route: "analytics" }, title: getToolDefinition("navigate").title }]),
        response: "Which analytics study should I stage for consent? Send the study ID or title."
      };
    }
    return {
      intentKind: "privacy_question",
      summary: "Select analytics study.",
      tools: withToolSurface(context, [tool("select_analytics_study", { studyId })])
    };
  }

  if (/\b(submit|consent|confirm|final)\b/.test(lower)) {
    if (!studyId) {
      return {
        intentKind: "privacy_question",
        summary: "Clarify analytics consent.",
        tools: withToolSurface(context, [{ name: "navigate", input: { route: "analytics" }, title: getToolDefinition("navigate").title }]),
        response: "Which analytics study should I submit consent for? Send the study ID or title."
      };
    }
    return {
      intentKind: "privacy_question",
      summary: "Submit analytics consent.",
      tools: withToolSurface(context, [
        tool("submit_analytics_consent", {
          studyId,
          expiresAt: parseNamedValue(original, "expires") ?? parseNamedValue(original, "expires at") ?? undefined,
          stageOnly: /\bstage|prepare\b/.test(lower)
        })
      ])
    };
  }

  return navigationTurn("analytics", "privacy_question");
}

function planAuditTurn(context: SurfaceContext, lower: string, original: string): AgentPlannedTurn | undefined {
  if (!/\b(audit|history|activity log|event)\b/.test(lower)) return undefined;

  const eventId = parseAuditEventId(original);
  if (eventId && /\b(explain|what|show|details?|event)\b/.test(lower)) {
    return {
      intentKind: "wallet_action",
      summary: "Explain audit event.",
      tools: withToolSurface(context, [tool("explain_audit_event", { eventId })])
    };
  }

  if (/\b(summarize|summary|overview|history)\b/.test(lower)) {
    return {
      intentKind: "wallet_action",
      summary: "Summarize audit history.",
      tools: withToolSurface(context, [tool("summarize_audit_events", buildAuditFilterInput(original))])
    };
  }

  if (/\b(search|find|filter|look for|lookup)\b/.test(lower)) {
    const input = buildAuditFilterInput(original, lower);
    if (!hasAuditFilter(input)) {
      return {
        intentKind: "wallet_action",
        summary: "Clarify audit search.",
        tools: withToolSurface(context, [{ name: "navigate", input: { route: "audit" }, title: getToolDefinition("navigate").title }]),
        response: "What audit event text, actor, action, resource, decision, or grant should I search for?"
      };
    }
    return {
      intentKind: "wallet_action",
      summary: "Search audit events.",
      tools: withToolSurface(context, [tool("search_audit_events", input)])
    };
  }

  return undefined;
}

function planRecipientAccessRequestTool(lower: string, original: string): AgentPlannedTool | undefined {
  const requestId = parseAccessRequestId(original);
  if (!requestId || !/\b(access|request|approval|approve|reject|revoke)\b/.test(lower)) return undefined;

  if (/\b(record|add|log)\b.*\b(controller\s+)?approval\b|\b(controller\s+)?approval\b.*\b(record|add|log)\b/.test(lower)) {
    return tool("record_controller_approval", { requestId });
  }
  if (/\bapprove\b/.test(lower)) {
    return tool("approve_access_request", { requestId });
  }
  if (/\b(reject|deny)\b/.test(lower)) {
    return tool("reject_access_request", { requestId });
  }
  if (/\b(revoke|turn off|remove access)\b/.test(lower)) {
    return tool("revoke_access_request", { requestId });
  }
  return undefined;
}

function planRecipientGrantTool(lower: string, original: string): AgentPlannedTool | undefined {
  const grantReference = parseGrantReference(original);
  if (!grantReference || !/\b(grant|receipt|record|document|file|delegate|analy[sz]e|view|open)\b/.test(lower)) {
    return undefined;
  }

  if (/\bdelegate\b/.test(lower)) {
    const audienceDid = parseDid(original);
    if (!audienceDid) return undefined;
    const ability = /\bdecrypt|view|open\b/.test(lower) ? "record/decrypt" : "record/analyze";
    return tool("delegate_grant", { ...grantReference, audienceDid, ability });
  }
  if (/\b(analy[sz]e|summary|summarize|redact|vector|extract|form)\b/.test(lower)) {
    return tool("analyze_granted_record", { ...grantReference, mode: parseAnalysisMode(lower) });
  }
  if (/\b(view|open|decrypt|read)\b/.test(lower)) {
    return tool("view_granted_record", grantReference);
  }
  return undefined;
}

function planContactTool(lower: string, original: string): AgentPlannedTool | undefined {
  if (/\b(preview|what.*allow|capabilities|scope preview)\b/.test(lower) && /\b(shar|scope|disclos)/.test(lower)) {
    const recipientId = parseRecipientId(original);
    const allowedScopes = parseDisclosureScopes(original);
    if (recipientId || allowedScopes.length) {
      return tool("preview_sharing_capabilities", {
        ...(recipientId ? { recipientId } : {}),
        ...(allowedScopes.length ? { allowedScopes } : {})
      });
    }
  }

  const recipientId = parseRecipientId(original);
  if (recipientId && /\b(remove|delete)\b.*\b(recipient|contact)\b|\b(recipient|contact)\b.*\b(remove|delete)\b/.test(lower)) {
    return tool("remove_recipient", { recipientId });
  }

  if (recipientId && /\b(update|set|change|stage)\b.*\b(shar|scope|disclos)/.test(lower)) {
    const allowedScopes = parseDisclosureScopes(original);
    if (allowedScopes.length) {
      return tool("update_recipient_scopes", { recipientId, allowedScopes });
    }
  }

  if (/\b(request|ask)\b.*\b(shelter contact|contact.*shelter)\b/.test(lower)) {
    const shelterName = parseNamedValue(original, "shelter") ?? parseAfterPhrase(original, /(?:request|ask).*?(?:contact|shelter)\s+(?:with|at|for)?/i);
    if (shelterName) return tool("request_shelter_contact", { shelterName });
  }

  const shelterRequestId = parseShelterRequestId(original);
  if (shelterRequestId && /\b(approve|accept)\b.*\b(user.*shelter|shelter.*user)\b/.test(lower)) {
    return tool("approve_user_shelter_request", { requestId: shelterRequestId });
  }
  if (shelterRequestId && /\b(deny|reject)\b.*\b(user.*shelter|shelter.*user)\b/.test(lower)) {
    return tool("deny_user_shelter_request", { requestId: shelterRequestId });
  }
  if (shelterRequestId && /\b(approve|accept)\b.*\b(shelter|contact|request)\b/.test(lower)) {
    return tool("approve_shelter_contact_request", { requestId: shelterRequestId });
  }
  if (shelterRequestId && /\b(deny|reject)\b.*\b(shelter|contact|request)\b/.test(lower)) {
    return tool("deny_shelter_contact_request", { requestId: shelterRequestId });
  }

  if (/\badd\b.*\bshelter\b.*\b(recipient|contact)\b/.test(lower)) {
    const shelterName = parseNamedValue(original, "shelter") ?? parseAfterPhrase(original, /\badd\b.*?\bshelter\s+(?:recipient|contact)?\s*(?:for|as|named|called)?/i);
    if (shelterName) return tool("add_shelter_as_recipient", { shelterName });
  }

  if (/\b(send|create|stage)\b.*\b(shelter nudge|shelter-to-user|contact request)\b/.test(lower)) {
    const shelter = parseNamedValue(original, "shelter");
    const staffId = parseNamedValue(original, "staff") ?? parseNamedValue(original, "staffId");
    const userName = parseNamedValue(original, "user") ?? parseNamedValue(original, "name");
    const userContact = parseNamedValue(original, "contact") ?? parseNamedValue(original, "email") ?? parseNamedValue(original, "phone");
    if (shelter && staffId && userName && userContact) {
      return tool("send_shelter_nudge", { shelter, staffId, userName, userContact });
    }
  }

  if (/\bcreate\b.*\bshelter staff\b.*\b(account|login|staff)\b/.test(lower)) {
    const shelter = parseNamedValue(original, "shelter");
    const operatorStaffId = parseNamedValue(original, "operator") ?? parseNamedValue(original, "staffId");
    const displayName = parseNamedValue(original, "name") ?? parseNamedValue(original, "displayName");
    const email = parseNamedValue(original, "email");
    if (shelter && operatorStaffId && displayName) {
      return tool("create_shelter_staff_account", { shelter, operatorStaffId, displayName, ...(email ? { email } : {}) });
    }
  }

  if (/\bcreate\b.*\b(managed user|shelter user)\b.*\baccount\b/.test(lower)) {
    const shelter = parseNamedValue(original, "shelter");
    const staffId = parseNamedValue(original, "staff") ?? parseNamedValue(original, "staffId");
    const legalName = parseNamedValue(original, "legalName") ?? parseNamedValue(original, "name");
    const photoAssetId = parseNamedValue(original, "photo") ?? parseNamedValue(original, "photoAssetId");
    if (shelter && staffId && legalName && photoAssetId) {
      return tool("create_managed_user_account", { shelter, staffId, legalName, photoAssetId });
    }
  }

  const addName = parseAddRecipientName(original, lower);
  if (addName) {
    const allowedScopes = parseDisclosureScopes(original);
    return tool("add_recipient", {
      displayName: addName,
      ...(allowedScopes.length ? { allowedScopes } : {})
    });
  }

  return undefined;
}

function planUploadTool(lower: string, original: string): AgentPlannedTool | undefined {
  if (!/\b(upload|uploads|file|files|document|documents|storage|save)\b/.test(lower)) return undefined;

  const uploadId = parseUploadId(original);
  const recordId = parseRecordId(original);

  if (/\b(repair|fix|restore)\b.*\b(storage|save|upload|file|document)\b|\b(storage|save)\b.*\b(repair|fix|restore)\b/.test(lower)) {
    if (uploadId || recordId) {
      return tool("repair_upload_storage", {
        ...(uploadId ? { uploadId } : {}),
        ...(recordId ? { recordId } : {})
      });
    }
  }

  if (/\b(classify|categorize|label|identify)\b/.test(lower)) {
    const fileName = parseNamedValue(original, "file") ?? parseNamedValue(original, "filename");
    if (uploadId || recordId || fileName) {
      return tool("classify_uploaded_document", {
        ...(uploadId ? { uploadId } : {}),
        ...(recordId ? { recordId } : {}),
        ...(fileName ? { fileName } : {}),
        userSelected: true
      });
    }
  }

  if (uploadId && /\b(share|allow sharing|make shareable|private|make private|stop sharing)\b/.test(lower)) {
    return tool("toggle_upload_shared", {
      uploadId,
      shared: !/\b(private|stop sharing|do not share|don't share|dont share)\b/.test(lower)
    });
  }

  if (/\b(what|which|help|guide|need|requirements?|should)\b/.test(lower)) {
    return tool("summarize_upload_requirements", { goal: original });
  }

  return undefined;
}

function tool(name: AgentCommandName, input: unknown): AgentPlannedTool {
  return {
    name,
    input,
    title: getToolDefinition(name).title
  };
}

function parseAccessRequestId(original: string): string | undefined {
  return original.match(/\baccess[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0].replace(/^access(?![-_:])/i, "access-");
}

function parseRecipientId(original: string): string | undefined {
  return original.match(/\brec[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0].replace(/^rec(?![-_:])/i, "rec-");
}

function parseUploadId(original: string): string | undefined {
  return original.match(/\bup[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0].replace(/^up(?![-_:])/i, "up-");
}

function parseShelterRequestId(original: string): string | undefined {
  return original.match(/\bshelter-request[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0];
}

function parseDisclosureScopes(original: string): string[] {
  const normalized = original.toLowerCase().replace(/[\s-]+/g, "_");
  return [
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
  ].filter((scope) => normalized.includes(scope));
}

function parseAddRecipientName(original: string, lower: string): string | undefined {
  if (!/\b(add|create)\b.*\b(recipient|contact|person)\b/.test(lower)) return undefined;
  const match = original.match(/\b(?:add|create)\s+(?:a\s+|an\s+)?(?:recipient|contact|person)\s+(?:named\s+|called\s+)?(.+?)\s*$/i);
  const name = match?.[1]?.replace(/\bwith\s+(?:scope|scopes|sharing)\b.*$/i, "").trim();
  return name && name.length <= 80 ? name : undefined;
}

function parseNamedValue(original: string, label: string): string | undefined {
  const match = original.match(new RegExp(`\\b${label}\\s*[:#-]\\s*([^,;]+)`, "i"));
  return match?.[1]?.trim();
}

function parseAfterPhrase(original: string, prefix: RegExp): string | undefined {
  const match = original.match(prefix);
  if (match?.index === undefined) return undefined;
  const value = original.slice(match.index + match[0].length).replace(/[.;]\s*$/, "").trim();
  return value && value.length <= 100 ? value : undefined;
}

function parseGrantReference(original: string): { grantId?: string; receiptId?: string } | undefined {
  const receiptId = original.match(/\breceipt[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0];
  if (receiptId) return { receiptId: receiptId.replace(/^receipt(?![-_:])/i, "receipt-") };
  const grantId = original.match(/\bgrant[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0];
  return grantId ? { grantId: grantId.replace(/^grant(?![-_:])/i, "grant-") } : undefined;
}

function parseProofReference(original: string): { proofId?: string; receiptId?: string } | undefined {
  const proofId = original.match(/\bproof[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0];
  if (proofId) return { proofId: proofId.replace(/^proof(?![-_:])/i, "proof-") };
  const receiptId = original.match(/\breceipt[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0];
  return receiptId ? { receiptId: receiptId.replace(/^receipt(?![-_:])/i, "receipt-") } : undefined;
}

function parseBundleId(original: string): string | undefined {
  return original.match(/\bexport[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0].replace(/^export(?![-_:])/i, "export-");
}

function parseStudyId(original: string): string | undefined {
  const explicit = original.match(/\bstudy[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0];
  if (explicit) return explicit.replace(/^study(?![-_:])/i, "study-");
  return parseNamedValue(original, "study") ?? parseNamedValue(original, "analytics study");
}

function parseAuditEventId(original: string): string | undefined {
  const explicit = original.match(/\b(?:aud|audit-event|audit)[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0];
  if (!explicit) return undefined;
  if (/^aud[-_:]/i.test(explicit)) return explicit;
  return explicit.replace(/^audit(?:-event)?(?![-_:])/i, "aud-");
}

function buildAuditFilterInput(original: string, lower?: string): Record<string, unknown> {
  const query =
    parseNamedValue(original, "query") ??
    parseNamedValue(original, "for") ??
    (lower ? lower.replace(/\b(search|find|filter|look for|lookup|audit|events?|history|activity log)\b/g, " ").trim() : undefined);
  return {
    ...(query ? { query } : {}),
    ...(parseNamedValue(original, "actor") ? { actor: parseNamedValue(original, "actor") } : {}),
    ...(parseNamedValue(original, "action") ? { action: parseNamedValue(original, "action") } : {}),
    ...(parseNamedValue(original, "resource") ? { resource: parseNamedValue(original, "resource") } : {}),
    ...(parseNamedValue(original, "decision") ? { decision: parseNamedValue(original, "decision") } : {}),
    ...(parseGrantReference(original)?.grantId ? { grantId: parseGrantReference(original)?.grantId } : {}),
    limit: 25
  };
}

function hasAuditFilter(input: Record<string, unknown>): boolean {
  return ["query", "actor", "action", "resource", "decision", "grantId"].some(
    (key) => typeof input[key] === "string" && String(input[key]).trim().length > 0
  );
}

function parseRecordId(original: string): string | undefined {
  return original.match(/\brec[-_:]?[a-zA-Z0-9._:-]+\b/i)?.[0].replace(/^rec(?![-_:])/i, "rec-");
}

function parseRecordIds(original: string): string[] {
  const matches = original.match(/\brec[-_:]?[a-zA-Z0-9._:-]+\b/gi) ?? [];
  return Array.from(new Set(matches.map((match) => match.replace(/^rec(?![-_:])/i, "rec-"))));
}

function parseProofIds(original: string): string[] {
  const matches = original.match(/\bproof[-_:]?[a-zA-Z0-9._:-]+\b/gi) ?? [];
  return Array.from(new Set(matches.map((match) => match.replace(/^proof(?![-_:])/i, "proof-"))));
}

function parseDid(original: string): string | undefined {
  return original.match(/\bdid:[a-zA-Z0-9._:%-]+:[^\s,;]+/i)?.[0];
}

function parseAnalysisMode(lower: string) {
  if (/\bform\b/.test(lower)) return "form";
  if (/\bextract|text\b/.test(lower)) return "extract-text";
  if (/\bvector|profile\b/.test(lower)) return "vector";
  if (/\bredact|redacted\b/.test(lower)) return "redacted";
  return "summary";
}

function parseRouteTarget(lower: string): RouteId | undefined {
  return resolveNavigationRoute(lower);
}

function parseServiceId(
  lower: string,
  original: string,
  context: SurfaceContext,
  mode: "save" | "plan" | "open"
): string | undefined {
  const verbPattern =
    mode === "save"
      ? /\b(save|bookmark|keep|remember)\b/
      : mode === "plan"
        ? /\b(plan|follow-up|follow up|next steps?)\b/
        : /\b(open|show|view|details?|detail)\b/;
  if (!verbPattern.test(lower) || !/\b(service|211|program|record|this)\b/.test(lower)) return undefined;

  const explicitWithMarker = original.match(
    /\b(?:service|211|program|record|doc(?:ument)?)(?:\s+(?:id|#))?\s*[:#-]\s*([a-zA-Z0-9][a-zA-Z0-9._:-]{2,})\b/i
  );
  if (isServiceIdCandidate(explicitWithMarker?.[1])) return explicitWithMarker[1];

  const servicePlanFor = original.match(/\bservice\s+plan\s+(?:for|on|with)\s+([a-zA-Z0-9][a-zA-Z0-9._:-]{2,})\b/i);
  if (mode === "plan" && isServiceIdCandidate(servicePlanFor?.[1])) return servicePlanFor[1];

  const afterFor = original.match(
    /\b(?:for|on|with)\s+(?:service|211|program|record|doc(?:ument)?)\s+([a-zA-Z0-9][a-zA-Z0-9._:-]{2,})\b/i
  );
  if (isServiceIdCandidate(afterFor?.[1])) return afterFor[1];

  const afterVerbObject = original.match(
    /\b(?:save|bookmark|keep|remember|plan|open|show|view)\s+(?:service|211|program|record|doc(?:ument)?)\s+([a-zA-Z0-9][a-zA-Z0-9._:-]{2,})\b/i
  );
  if (isServiceIdCandidate(afterVerbObject?.[1])) return afterVerbObject[1];

  const afterVerb = original.match(/\b(?:save|bookmark|keep|remember|plan|open|show|view)\s+([a-zA-Z0-9][a-zA-Z0-9._:-]{2,})\b/i);
  if (isServiceIdCandidate(afterVerb?.[1])) {
    return afterVerb[1];
  }

  if (/\b(this|selected|current)\b/.test(lower)) {
    return context.selectedServiceDocId || singleVisibleServiceId(context);
  }

  return undefined;
}

function planServicePlanUpdateTool(lower: string, original: string): AgentPlannedTool | undefined {
  const planId = parsePlanId(original);
  if (!planId) return undefined;

  if (/\b(remind|reminder|follow.?up|appointment)\b/.test(lower)) {
    const reminderAt = parseDateLikeText(original) || original;
    return {
      name: "set_service_plan_reminder",
      input: { planId, reminderAt },
      title: getToolDefinition("set_service_plan_reminder").title
    };
  }

  if (/\b(checklist|step|document|question|ask|bring|need)\b/.test(lower)) {
    const checklist = /\b(document|bring|need)\b/.test(lower)
      ? "documents_needed"
      : /\b(question|ask)\b/.test(lower)
        ? "questions_to_ask"
        : "steps";
    return {
      name: "add_service_plan_checklist_item",
      input: { planId, checklist, item: parseChecklistItem(original) || original },
      title: getToolDefinition("add_service_plan_checklist_item").title
    };
  }

  return undefined;
}

function planServiceInteractionTool(
  lower: string,
  original: string,
  context: SurfaceContext
): AgentPlannedTool | undefined {
  if (!/\b(record|log|note|save)\b/.test(lower) || !/\b(call|called|text|email|visit|appointment|interaction|contact)\b/.test(lower)) {
    return undefined;
  }
  const serviceId = parseServiceId(lower, original, context, "save") || context.selectedServiceDocId || singleVisibleServiceId(context);
  if (!serviceId) return undefined;
  const interactionType = /\b(appointment|visit)\b/.test(lower)
    ? "appointment"
    : /\b(text|sms)\b/.test(lower)
      ? "message"
      : /\b(email)\b/.test(lower)
        ? "email"
        : "call";
  return {
    name: "record_service_interaction",
    input: {
      serviceId,
      interactionType,
      channel: interactionType === "message" ? "sms" : interactionType,
      outcome: original
    },
    title: getToolDefinition("record_service_interaction").title
  };
}

function parsePlanId(original: string): string | undefined {
  const explicit = original.match(/\bplan(?:\s+(?:id|#))?\s*[:#-]?\s*([a-zA-Z0-9][a-zA-Z0-9._:-]{2,})\b/i);
  return isServiceIdCandidate(explicit?.[1]) ? explicit[1] : undefined;
}

function parseChecklistItem(original: string): string | undefined {
  const quoted = original.match(/"([^"]+)"/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const afterAdd = original.match(/\b(?:add|include|remember)\s+(.+?)(?:\s+(?:to|on|for)\s+plan\b|$)/i);
  return afterAdd?.[1]?.trim();
}

function parseDateLikeText(original: string): string | undefined {
  const quoted = original.match(/"([^"]+)"/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const after = original.match(/\b(?:for|at|on)\s+([A-Za-z0-9,:/\-\s]+)$/i);
  return after?.[1]?.trim();
}

function isServiceIdCandidate(value: string | undefined): value is string {
  if (!value) return false;
  return ![
    "service",
    "services",
    "program",
    "record",
    "records",
    "this",
    "that",
    "plan",
    "plans",
    "detail",
    "details",
    "question",
    "questions"
  ].includes(value.toLowerCase());
}

function singleVisibleServiceId(context: SurfaceContext): string | undefined {
  return context.visibleServiceDocIds?.length === 1 ? context.visibleServiceDocIds[0] : undefined;
}

function fallbackResponse(context: SurfaceContext): string {
  return `I can help on the ${context.routeLabel} screen: explain what is visible, navigate the app, answer public 211 service questions, and ask before changing wallet data.`;
}
