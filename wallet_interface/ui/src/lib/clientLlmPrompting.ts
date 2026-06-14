import { LLM_CONFIG } from "./llmConfig";

export interface ClientLlmChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ClientLlmPromptParts {
  prompt: string;
  systemPrompt?: string;
  userPrompt?: string;
}

export type ClientLlmPromptInput = string | ClientLlmPromptParts;

export interface ClientLlmGenerationParameters {
  do_sample?: boolean;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  repetition_penalty?: number;
}

export function buildClientLlmChatMessages(prompt: ClientLlmPromptInput): ClientLlmChatMessage[] {
  if (typeof prompt !== "string") {
    const structuredMessages = buildStructuredPromptMessages(prompt);
    if (structuredMessages) {
      return structuredMessages;
    }
  }

  const promptText = flattenClientLlmPrompt(prompt);
  const assistantPrompt = parseAbbyAssistantResponsePrompt(promptText);
  if (assistantPrompt) {
    return [
      {
        role: "system",
        content: [
          "You are Abby, a concise assistant inside a 211 service navigation and wallet app.",
          "If the user asks what you can do, mention screen help, app navigation, public 211 service search, evidence summaries, and confirmation before wallet changes.",
          "Use the safe app context and conversation history. Do not invent service facts or completed app actions.",
          "Return only the assistant message text.",
          "",
          assistantPrompt.systemContext,
        ].join("\n"),
      },
      {
        role: "user",
        content: assistantPrompt.userMessage,
      },
    ];
  }

  const jsonMode = /\bReturn only one JSON object\b/i.test(promptText);
  return [
    {
      role: "system",
      content: jsonMode
        ? "You are Abby's app tool router. Follow the prompt exactly and return only the requested JSON object."
        : "You are Abby, a concise assistant inside a 211 service navigation and wallet app. Follow the user's prompt exactly and return only the assistant message text.",
    },
    {
      role: "user",
      content: promptText,
    },
  ];
}

export function buildClientLlmGenerationOptions(modelName: string, maxTokens: number): Record<string, unknown> {
  return {
    max_new_tokens: maxTokens,
    return_full_text: false,
    ...getClientLlmGenerationParameters(modelName),
  };
}

export function getClientLlmGenerationParameters(modelName: string): ClientLlmGenerationParameters {
  if (isLiquidThinkingModel(modelName)) {
    return {
      do_sample: true,
      temperature: 0.1,
      top_k: 50,
      top_p: 0.1,
      repetition_penalty: 1.05,
    };
  }

  if (isLiquidLfmModel(modelName)) {
    return {
      do_sample: true,
      temperature: 0.1,
      top_k: 50,
      repetition_penalty: 1.05,
    };
  }

  return {
    do_sample: false,
  };
}

export function isPromptEligibleForRemoteLlm(prompt: ClientLlmPromptInput): boolean {
  const promptText = flattenClientLlmPrompt(prompt);
  if (LLM_CONFIG.openRouterAllowPrivateContext) {
    return true;
  }
  return !/"privateContext(?:Included|Allowed)"\s*:\s*true/i.test(promptText) &&
    !/"permissionLevel"\s*:\s*"wallet_private"/i.test(promptText);
}

export function resolveClientLlmPromptText(prompt: ClientLlmPromptInput): string {
  return typeof prompt === "string" ? prompt : prompt.prompt;
}

function isLiquidLfmModel(modelName: string): boolean {
  return /(?:LiquidAI\/LFM2\.5|liquid\/lfm-2\.5)/i.test(modelName);
}

function isLiquidThinkingModel(modelName: string): boolean {
  return isLiquidLfmModel(modelName) && /thinking/i.test(modelName);
}

function parseAbbyAssistantResponsePrompt(prompt: string): { systemContext: string; userMessage: string } | undefined {
  if (!/^Answer as Abby\b/i.test(prompt.trim())) {
    return undefined;
  }

  const marker = "\nUser message:\n";
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const systemContext = prompt.slice(0, markerIndex).trim();
  const userMessage = prompt
    .slice(markerIndex + marker.length)
    .replace(/\n\s*Abby\s*:\s*$/i, "")
    .trim();
  if (!systemContext || !userMessage) {
    return undefined;
  }

  return { systemContext, userMessage };
}

function buildStructuredPromptMessages(prompt: ClientLlmPromptParts): ClientLlmChatMessage[] | undefined {
  const systemPrompt = prompt.systemPrompt?.trim();
  const userPrompt = prompt.userPrompt?.trim();
  if (!systemPrompt || !userPrompt) {
    return undefined;
  }
  return [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];
}

function flattenClientLlmPrompt(prompt: ClientLlmPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return [prompt.prompt, prompt.systemPrompt?.trim(), prompt.userPrompt?.trim()].filter(Boolean).join("\n");
}
