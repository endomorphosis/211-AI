import { buildClientLlmChatMessages, getClientLlmGenerationParameters, type ClientLlmPromptInput } from "./clientLlmPrompting";
import { LLM_CONFIG } from "./llmConfig";
import { readRuntimeWalletApiConfig } from "./runtimeConfig";

const WALLET_API_CONFIG_KEY = "abby-wallet-api-config";

interface WalletApiConfig {
  apiBaseUrl: string;
  walletId: string;
  actorDid?: string;
  issuerKeyHex?: string;
  audienceKeyHex?: string;
}

export interface HuggingFaceWalletRouterStatus {
  enabled: boolean;
  configured: boolean;
  endpoint: string;
  model: string;
  lastError?: string;
  lastUsedAt?: string;
}

export interface HuggingFaceWalletRouterGenerationResult {
  model: string;
  text: string;
}

export function getHuggingFaceWalletRouterStatus(
  options: {
    lastError?: string;
    lastUsedAt?: string;
  } = {},
): HuggingFaceWalletRouterStatus {
  const config = readWalletRouterConfig();
  return {
    enabled: getHuggingFaceWalletRouterEnabled(),
    configured: Boolean(config),
    endpoint: config ? new URL(`/wallets/${config.walletId}/ai-router/llm`, normalizeBaseUrl(config.apiBaseUrl)).toString() : "",
    model: getHuggingFaceWalletRouterModel(),
    lastError: options.lastError,
    lastUsedAt: options.lastUsedAt,
  };
}

export async function generateHuggingFaceWalletRouterText(options: {
  prompt: ClientLlmPromptInput;
  maxTokens: number;
  fallbackReason: string;
}): Promise<HuggingFaceWalletRouterGenerationResult> {
  if (!getHuggingFaceWalletRouterEnabled()) {
    throw new Error("Hugging Face wallet router is disabled.");
  }
  const config = readWalletRouterConfig();
  if (!config) {
    throw new Error("Hugging Face wallet router needs a connected wallet.");
  }
  if (!config.actorDid) {
    throw new Error("Hugging Face wallet router needs an actor DID.");
  }

  const model = getHuggingFaceWalletRouterModel();
  const { do_sample: _doSample, ...generationParameters } = getClientLlmGenerationParameters(model);
  const response = await fetchWithTimeout(new URL(`/wallets/${config.walletId}/ai-router/llm`, normalizeBaseUrl(config.apiBaseUrl)).toString(), {
    body: JSON.stringify({
      actor_did: config.actorDid,
      actor_key_hex: config.issuerKeyHex || config.audienceKeyHex,
      wallet_cid: config.walletId,
      provider: getHuggingFaceWalletRouterProvider(),
      model_name: model,
      prompt: buildWalletRouterPrompt(options.prompt),
      max_new_tokens: Math.max(16, options.maxTokens),
      kwargs: {
        ...generationParameters,
        hf_provider: getHuggingFaceProvider(),
        bill_to: getHuggingFaceBillTo(),
        app: "abby-211",
        fallback_reason: options.fallbackReason.slice(0, 128),
      },
    }),
    headers: {
      "Content-Type": "application/json",
      "X-Title": "Abby 211",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Hugging Face wallet router request failed with ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new Error("Hugging Face wallet router returned an empty response.");
  }
  return {
    model: typeof payload?.model_name === "string" ? payload.model_name : model,
    text,
  };
}

function buildWalletRouterPrompt(prompt: ClientLlmPromptInput): string {
  return buildClientLlmChatMessages(prompt)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");
}

function readWalletRouterConfig(): WalletApiConfig | undefined {
  return readUrlWalletApiConfig() ?? readRuntimeWalletApiConfig() ?? readStoredWalletApiConfig();
}

function readUrlWalletApiConfig(): WalletApiConfig | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URL(window.location.href).searchParams;
  const apiBaseUrl = params.get("walletApiBaseUrl") ?? undefined;
  const walletId = params.get("walletId") ?? undefined;
  if (!apiBaseUrl || !walletId) return undefined;
  return {
    apiBaseUrl,
    walletId,
    actorDid: params.get("actorDid") ?? undefined,
    issuerKeyHex: params.get("issuerKeyHex") ?? undefined,
    audienceKeyHex: params.get("audienceKeyHex") ?? undefined,
  };
}

function readStoredWalletApiConfig(): WalletApiConfig | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const storedConfig = JSON.parse(window.localStorage.getItem(WALLET_API_CONFIG_KEY) ?? "null") as Partial<WalletApiConfig> | null;
    if (!storedConfig?.apiBaseUrl || !storedConfig.walletId) return undefined;
    return {
      apiBaseUrl: storedConfig.apiBaseUrl,
      walletId: storedConfig.walletId,
      actorDid: storedConfig.actorDid,
      issuerKeyHex: storedConfig.issuerKeyHex,
      audienceKeyHex: storedConfig.audienceKeyHex,
    };
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(value: string): string {
  if (value === "same-origin" && typeof window !== "undefined") return window.location.origin;
  return value;
}

function getHuggingFaceWalletRouterEnabled(): boolean {
  return import.meta.env?.VITE_HF_WALLET_ROUTER_ENABLED !== "false";
}

function getHuggingFaceWalletRouterModel(): string {
  return (import.meta.env?.VITE_HF_WALLET_ROUTER_MODEL as string | undefined) || "Qwen/Qwen3.5-2B";
}

function getHuggingFaceWalletRouterProvider(): string {
  return (import.meta.env?.VITE_HF_WALLET_ROUTER_PROVIDER as string | undefined) || "hf_inference_api";
}

function getHuggingFaceProvider(): string {
  return (import.meta.env?.VITE_HF_WALLET_ROUTER_HF_PROVIDER as string | undefined) || "auto";
}

function getHuggingFaceBillTo(): string {
  return (import.meta.env?.VITE_HF_WALLET_ROUTER_BILL_TO as string | undefined) || "publicus";
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
