import type { ClientLlmRuntimeService } from "../lib/clientLLMWorkerService";
import {
  buildSafeSurfaceContext,
  compactAgentConversationHistory,
} from "./agentConversation";
import type { AgentSession, SurfaceContext } from "./types";

export interface LocalLlmAssistantResponseInput {
  content: string;
  context: SurfaceContext;
  session: AgentSession;
  maxTokens?: number;
  llmService?: ClientLlmRuntimeService;
}

export interface LocalLlmAssistantResponseResult {
  ok: boolean;
  text: string;
  rawOutput?: string;
  modelName?: string;
  error?: string;
}

const DEFAULT_MAX_TOKENS = 180;

export async function generateLocalLlmAssistantResponse(
  input: LocalLlmAssistantResponseInput,
): Promise<LocalLlmAssistantResponseResult> {
  let generated;
  try {
    const llmService = input.llmService ?? (await import("../lib/clientLLMWorkerService")).clientLLMWorkerService;
    generated = await llmService.tryGenerateText(
      buildLocalLlmAssistantResponsePrompt(input),
      input.maxTokens ?? DEFAULT_MAX_TOKENS,
    );
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: errorMessage(error) || "local_llm_unavailable",
    };
  }

  if (!generated.ok) {
    return {
      ok: false,
      text: "",
      rawOutput: generated.text,
      modelName: generated.modelName,
      error: generated.error || "local_llm_unavailable",
    };
  }

  const text = cleanLocalLlmAssistantResponse(generated.text);
  if (!isUsableLocalLlmAssistantResponse(text, input.content)) {
    return {
      ok: false,
      text: "",
      rawOutput: generated.text,
      modelName: generated.modelName,
      error: "local_llm_empty_response",
    };
  }

  return {
    ok: true,
    text,
    rawOutput: generated.text,
    modelName: generated.modelName,
  };
}

export function buildLocalLlmAssistantResponsePrompt(input: LocalLlmAssistantResponseInput): string {
  const safeContext = buildSafeSurfaceContext(input.context, {
    includePrivateContext: input.context.privateContextAllowed,
  });
  const history = compactAgentConversationHistory(input.session.messages, {
    includePrivateContext: input.context.privateContextAllowed,
    maxMessages: 6,
    maxCharacters: 2400,
  });

  return [
    "Answer as Abby, the assistant inside a 211 service navigation and wallet app.",
    "Use only the safe app context and conversation below.",
    "Do not invent service facts, wallet contents, phone numbers, hours, addresses, eligibility rules, proof status, grant status, or completed actions.",
    "If the user asks for specific 211 service facts and no evidence is present, say that you can search the local 211 corpus.",
    "If the user asks for a wallet write, sharing change, export, proof, access change, or external contact, say that the app will ask for confirmation before doing it.",
    "Keep the answer under four short sentences. Return only the assistant message text.",
    "",
    "Safe app context:",
    JSON.stringify(
      {
        route: safeContext.route,
        routeLabel: safeContext.routeLabel,
        permissionLevel: safeContext.permissionLevel,
        walletUnlocked: safeContext.walletUnlocked,
        privateContextIncluded: safeContext.privateContextAllowed,
        summary: safeContext.summary,
        selectedServiceDocId: safeContext.selectedServiceDocId,
        selectedRecordId: safeContext.selectedRecordId,
        selectedRecipientId: safeContext.selectedRecipientId,
        selectedAccessRequestId: safeContext.selectedAccessRequestId,
        selectedProofId: safeContext.selectedProofId,
        visibleRecordIds: safeContext.visibleRecordIds,
        visibleServiceDocIds: safeContext.visibleServiceDocIds,
        redactions: safeContext.redactions,
      },
      null,
      2,
    ),
    "",
    "Conversation history:",
    JSON.stringify(
      history.map((message) => ({
        role: message.role,
        status: message.status,
        content: message.content,
      })),
      null,
      2,
    ),
    "",
    "User message:",
    input.content.trim(),
    "",
    "Abby:",
  ].join("\n");
}

export function cleanLocalLlmAssistantResponse(text: string): string {
  const messageMatch = /\bMESSAGE\s*:\s*([\s\S]+)$/i.exec(text);
  const raw = (messageMatch?.[1] ?? text)
    .replace(/^ACTION\s*:\s*answer_user\s*/i, "")
    .replace(/^Abby\s*:\s*/i, "")
    .replace(/^Assistant\s*:\s*/i, "")
    .replace(/<\|[^>]+?\|>/g, "")
    .trim();

  return raw
    .split(/\n(?:User message|User|Conversation history|Safe app context)\s*:/i)[0]
    .replace(/^["']|["']$/g, "")
    .trim();
}

function isUsableLocalLlmAssistantResponse(text: string, userContent: string): boolean {
  if (text.length < 2) return false;
  if (/^no_tool$/i.test(text)) return false;
  if (/^\{[\s\S]*\}$/.test(text)) return false;
  if (/^ACTION\s*:/i.test(text)) return false;
  if (/\b(the assistant message is|the instruction is|use only the safe app context|assistant inside a 211)\b/i.test(text)) {
    return false;
  }
  if (isCapabilityQuestion(userContent) && !mentionsAppCapability(text)) {
    return false;
  }
  return true;
}

function isCapabilityQuestion(userContent: string): boolean {
  return /\b(what can you do|what can you help|how can you help|what do you do)\b/i.test(userContent);
}

function mentionsAppCapability(text: string): boolean {
  return /\b(211|service|screen|navigate|navigation|wallet|confirmation|evidence|search|app)\b/i.test(text);
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
