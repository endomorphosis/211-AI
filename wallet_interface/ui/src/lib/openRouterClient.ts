import { buildClientLlmChatMessages, getClientLlmGenerationParameters, type ClientLlmPromptInput } from "./clientLlmPrompting";
import { LLM_CONFIG } from "./llmConfig";
import { resolvePublicHttpsUrl } from "./publicEndpointPolicy";

export const OPENROUTER_API_KEY_STORAGE_KEY = "abby-openrouter-api-key";

export interface OpenRouterRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  credentialSource: "browser" | "build" | "proxy" | "none";
  endpoint: string;
  model: string;
  fallbackDelayMs: number;
  lastError?: string;
  lastUsedAt?: string;
}

export interface OpenRouterGenerationResult {
  model: string;
  text: string;
}

export function getOpenRouterRuntimeStatus(
  options: {
    localModelName?: string;
    lastError?: string;
    lastUsedAt?: string;
  } = {},
): OpenRouterRuntimeStatus {
  const credentialSource = getOpenRouterCredentialSource();
  const endpoint = getOpenRouterEndpoint();
  return {
    enabled: LLM_CONFIG.openRouterEnabled,
    configured: LLM_CONFIG.openRouterEnabled && Boolean(endpoint) && credentialSource !== "none",
    credentialSource,
    endpoint,
    model: selectOpenRouterModel(options.localModelName || LLM_CONFIG.defaultModel),
    fallbackDelayMs: LLM_CONFIG.openRouterFallbackDelayMs,
    lastError: options.lastError,
    lastUsedAt: options.lastUsedAt,
  };
}

export function saveOpenRouterApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    clearOpenRouterApiKey();
    return;
  }
  getStorage()?.setItem(OPENROUTER_API_KEY_STORAGE_KEY, trimmed);
}

export function clearOpenRouterApiKey(): void {
  getStorage()?.removeItem(OPENROUTER_API_KEY_STORAGE_KEY);
}

export async function generateOpenRouterText(options: {
  prompt: ClientLlmPromptInput;
  maxTokens: number;
  localModelName: string;
  fallbackReason: string;
}): Promise<OpenRouterGenerationResult> {
  const status = getOpenRouterRuntimeStatus({ localModelName: options.localModelName });
  if (!status.enabled) {
    throw new Error("OpenRouter fallback is disabled.");
  }
  if (!status.configured) {
    throw new Error("OpenRouter proxy endpoint is unavailable. Configure VITE_OPENROUTER_PROXY_URL with a public HTTPS URL.");
  }

  const model = selectOpenRouterModel(options.localModelName);
  const { do_sample: _doSample, ...generationParameters } = getClientLlmGenerationParameters(model);
  const body = {
    model,
    messages: buildClientLlmChatMessages(options.prompt),
    max_tokens: Math.max(16, options.maxTokens),
    ...generationParameters,
    metadata: {
      app: "abby-211",
      fallback_reason: options.fallbackReason.slice(0, 128),
    },
  };

  const response = await fetchWithTimeout(getOpenRouterEndpoint(), {
    body: JSON.stringify(body),
    headers: buildOpenRouterHeaders(),
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  const text = extractOpenRouterText(payload);
  if (!text) {
    throw new Error("OpenRouter returned an empty response.");
  }

  return {
    model: typeof payload?.model === "string" ? payload.model : model,
    text,
  };
}

export async function generateOpenRouterTranslation(options: {
  text: string;
  targetLocale: string;
  sourceLocale?: string;
}): Promise<OpenRouterGenerationResult> {
  const text = options.text.trim();
  if (!text) {
    throw new Error("Translation text cannot be empty.");
  }

  return generateOpenRouterText({
    prompt: {
      prompt: "Translate assistant text for the end user.",
      systemPrompt: [
        "You translate Abby assistant replies for the user.",
        "Preserve meaning, tone, line breaks, phone numbers, URLs, dates, and service names.",
        "Do not add commentary, prefaces, apologies, or explanations.",
        "If the text is already in the target language, return it unchanged.",
        "Return only the translated text.",
      ].join("\n"),
      userPrompt: [
        `Target locale: ${options.targetLocale}`,
        `Source locale: ${options.sourceLocale || "auto"}`,
        "Text:",
        text,
      ].join("\n"),
    },
    maxTokens: Math.max(192, Math.ceil(text.length * 1.6)),
    localModelName: LLM_CONFIG.defaultModel,
    fallbackReason: `translation:${options.targetLocale}`,
  });
}

function selectOpenRouterModel(localModelName: string): string {
  return /thinking/i.test(localModelName)
    ? LLM_CONFIG.openRouterThinkingModel
    : LLM_CONFIG.openRouterInstructModel;
}

function getOpenRouterEndpoint(): string {
  return resolvePublicHttpsUrl(LLM_CONFIG.openRouterProxyUrl);
}

function getOpenRouterCredentialSource(): OpenRouterRuntimeStatus["credentialSource"] {
  if (resolvePublicHttpsUrl(LLM_CONFIG.openRouterProxyUrl)) {
    return "proxy";
  }
  return "none";
}

function buildOpenRouterHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-OpenRouter-Experimental-Metadata": "enabled",
  };
  const origin = getBrowserOrigin();
  if (origin) {
    headers["HTTP-Referer"] = origin;
    headers["X-Title"] = "Abby 211";
  }
  return headers;
}

async function fetchWithTimeout(endpoint: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), LLM_CONFIG.openRouterRequestTimeoutMs);
  try {
    return await fetch(endpoint, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function extractOpenRouterText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return "";
  }
  const content = choice.message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function readStoredOpenRouterApiKey(): string {
  return getStorage()?.getItem(OPENROUTER_API_KEY_STORAGE_KEY)?.trim() || "";
}

function getStorage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function getBrowserOrigin(): string {
  try {
    return typeof window !== "undefined" ? window.location.origin : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
