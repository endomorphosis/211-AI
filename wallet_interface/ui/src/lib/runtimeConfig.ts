export type RuntimeWalletApiConfig = {
  apiBaseUrl?: string;
  walletId?: string;
  actorDid?: string;
  issuerKeyHex?: string;
  audienceKeyHex?: string;
};

export type ResolvedRuntimeWalletApiConfig = {
  apiBaseUrl: string;
  walletId: string;
  actorDid?: string;
  issuerKeyHex?: string;
  audienceKeyHex?: string;
};

export type RuntimeFilecoinStorageConfig = {
  uploadUrl?: string;
  clientToken?: string;
};

export type ResolvedRuntimeFilecoinStorageConfig = {
  uploadUrl: string;
  clientToken?: string;
};

export type RuntimeVoiceProxyConfig = {
  enabled?: boolean | string;
  model?: string;
  baseUrl?: string;
  inferUrl?: string;
  ttsUrl?: string;
  sttUrl?: string;
  fallbackInferUrl?: string;
  fallbackTtsUrl?: string;
  fallbackSttUrl?: string;
  fallbackModel?: string;
};

export type RuntimePrecomputedAudioConfig = {
  manifestUrl?: string;
};

export type RuntimeAgentConfig = {
  graphRagPrerenderMatchThreshold?: number | string;
};

export type ResolvedRuntimeVoiceProxyConfig = {
  enabled?: boolean;
  model?: string;
  baseUrl?: string;
  inferUrl?: string;
  ttsUrl?: string;
  sttUrl?: string;
  fallbackInferUrl?: string;
  fallbackTtsUrl?: string;
  fallbackSttUrl?: string;
  fallbackModel?: string;
};

export type ResolvedRuntimePrecomputedAudioConfig = {
  manifestUrl: string;
};

export type ResolvedRuntimeAgentConfig = {
  graphRagPrerenderMatchThreshold?: number;
};

export type AbbyRuntimeConfig = {
  walletApi?: RuntimeWalletApiConfig;
  filecoinStorage?: RuntimeFilecoinStorageConfig;
  voiceProxy?: RuntimeVoiceProxyConfig;
  precomputedAudio?: RuntimePrecomputedAudioConfig;
  agent?: RuntimeAgentConfig;
};

type RuntimeConfigGlobal = typeof globalThis & {
  __ABBY_RUNTIME_CONFIG__?: AbbyRuntimeConfig;
};

export async function loadRuntimeConfig(): Promise<void> {
  if (typeof window === "undefined") return;
  const runtimeGlobal = globalThis as RuntimeConfigGlobal;
  if (runtimeGlobal.__ABBY_RUNTIME_CONFIG__) return;

  try {
    const response = await fetch(new URL("runtime-config.json", window.location.href), { cache: "no-store" });
    if (!response.ok) {
      runtimeGlobal.__ABBY_RUNTIME_CONFIG__ = {};
      return;
    }
    const payload = (await response.json()) as AbbyRuntimeConfig;
    runtimeGlobal.__ABBY_RUNTIME_CONFIG__ = normalizeRuntimeConfig(payload);
  } catch {
    runtimeGlobal.__ABBY_RUNTIME_CONFIG__ = {};
  }
}

export function readRuntimeWalletApiConfig(): ResolvedRuntimeWalletApiConfig | undefined {
  const config = readRuntimeConfig().walletApi;
  const apiBaseUrl = resolveWalletApiBaseUrl(config?.apiBaseUrl);
  if (!apiBaseUrl || !config?.walletId) return undefined;
  return {
    apiBaseUrl,
    walletId: config.walletId,
    actorDid: config.actorDid,
    issuerKeyHex: config.issuerKeyHex,
    audienceKeyHex: config.audienceKeyHex
  };
}

export function readRuntimeWalletApiBaseUrl(): string | undefined {
  return resolveWalletApiBaseUrl(readRuntimeConfig().walletApi?.apiBaseUrl);
}

export function readRuntimeFilecoinStorageConfig(): ResolvedRuntimeFilecoinStorageConfig | undefined {
  const config = readRuntimeConfig().filecoinStorage;
  if (!config?.uploadUrl) return undefined;
  return {
    uploadUrl: config.uploadUrl,
    clientToken: config.clientToken
  };
}

export function readRuntimeVoiceProxyConfig(): ResolvedRuntimeVoiceProxyConfig | undefined {
  return normalizeVoiceProxyConfig(readRuntimeConfig().voiceProxy);
}

export function readRuntimePrecomputedAudioConfig(): ResolvedRuntimePrecomputedAudioConfig | undefined {
  return normalizePrecomputedAudioConfig(readRuntimeConfig().precomputedAudio);
}

export function readRuntimePrecomputedAudioManifestUrl(): string | undefined {
  return readRuntimePrecomputedAudioConfig()?.manifestUrl;
}

export function readRuntimeAgentConfig(): ResolvedRuntimeAgentConfig | undefined {
  return normalizeAgentConfig(readRuntimeConfig().agent);
}

function readRuntimeConfig(): AbbyRuntimeConfig {
  const runtimeGlobal = globalThis as RuntimeConfigGlobal;
  return runtimeGlobal.__ABBY_RUNTIME_CONFIG__ ?? {};
}

function normalizeRuntimeConfig(payload: AbbyRuntimeConfig | null | undefined): AbbyRuntimeConfig {
  const walletApi = normalizeWalletApiConfig(payload?.walletApi) ?? normalizeWalletApiBaseConfig(payload?.walletApi);
  const filecoinStorage = normalizeFilecoinStorageConfig(payload?.filecoinStorage);
  const voiceProxy = normalizeVoiceProxyConfig(payload?.voiceProxy);
  const precomputedAudio = normalizePrecomputedAudioConfig(payload?.precomputedAudio);
  const agent = normalizeAgentConfig(payload?.agent);
  return {
    ...(walletApi ? { walletApi } : {}),
    ...(filecoinStorage ? { filecoinStorage } : {}),
    ...(voiceProxy ? { voiceProxy } : {}),
    ...(precomputedAudio ? { precomputedAudio } : {}),
    ...(agent ? { agent } : {}),
  };
}

function normalizeWalletApiBaseConfig(
  config: RuntimeWalletApiConfig | null | undefined
): RuntimeWalletApiConfig | undefined {
  if (!config) return undefined;
  const apiBaseUrl = normalizeOptionalString(config.apiBaseUrl);
  if (!apiBaseUrl) return undefined;
  return { apiBaseUrl };
}

function normalizeWalletApiConfig(
  config: RuntimeWalletApiConfig | null | undefined
): ResolvedRuntimeWalletApiConfig | undefined {
  if (!config) return undefined;
  const apiBaseUrl = resolveWalletApiBaseUrl(config.apiBaseUrl);
  const walletId = normalizeOptionalString(config.walletId);
  if (!apiBaseUrl || !walletId) return undefined;
  return {
    apiBaseUrl,
    walletId,
    actorDid: normalizeOptionalString(config.actorDid),
    issuerKeyHex: normalizeOptionalString(config.issuerKeyHex),
    audienceKeyHex: normalizeOptionalString(config.audienceKeyHex)
  };
}

function normalizeFilecoinStorageConfig(
  config: RuntimeFilecoinStorageConfig | null | undefined
): ResolvedRuntimeFilecoinStorageConfig | undefined {
  if (!config) return undefined;
  const uploadUrl = normalizeOptionalString(config.uploadUrl);
  if (!uploadUrl) return undefined;
  return {
    uploadUrl,
    clientToken: normalizeOptionalString(config.clientToken)
  };
}

function normalizeVoiceProxyConfig(
  config: RuntimeVoiceProxyConfig | null | undefined
): ResolvedRuntimeVoiceProxyConfig | undefined {
  if (!config) return undefined;
  const enabled = normalizeOptionalBoolean(config.enabled);
  const model = normalizeOptionalString(config.model);
  const baseUrl = normalizeOptionalString(config.baseUrl);
  const inferUrl = normalizeOptionalString(config.inferUrl);
  const ttsUrl = normalizeOptionalString(config.ttsUrl);
  const sttUrl = normalizeOptionalString(config.sttUrl);
  const fallbackInferUrl = normalizeOptionalString(config.fallbackInferUrl);
  const fallbackTtsUrl = normalizeOptionalString(config.fallbackTtsUrl);
  const fallbackSttUrl = normalizeOptionalString(config.fallbackSttUrl);
  const fallbackModel = normalizeOptionalString(config.fallbackModel);
  if (
    enabled === undefined &&
    !model &&
    !baseUrl &&
    !inferUrl &&
    !ttsUrl &&
    !sttUrl &&
    !fallbackInferUrl &&
    !fallbackTtsUrl &&
    !fallbackSttUrl &&
    !fallbackModel
  ) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(inferUrl ? { inferUrl } : {}),
    ...(ttsUrl ? { ttsUrl } : {}),
    ...(sttUrl ? { sttUrl } : {}),
    ...(fallbackInferUrl ? { fallbackInferUrl } : {}),
    ...(fallbackTtsUrl ? { fallbackTtsUrl } : {}),
    ...(fallbackSttUrl ? { fallbackSttUrl } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
  };
}

function normalizePrecomputedAudioConfig(
  config: RuntimePrecomputedAudioConfig | null | undefined
): ResolvedRuntimePrecomputedAudioConfig | undefined {
  if (!config) return undefined;
  const manifestUrl = normalizeOptionalString(config.manifestUrl);
  if (!manifestUrl) return undefined;
  return { manifestUrl };
}

function normalizeAgentConfig(
  config: RuntimeAgentConfig | null | undefined
): ResolvedRuntimeAgentConfig | undefined {
  if (!config) return undefined;
  const graphRagPrerenderMatchThreshold = normalizeOptionalNumber(config.graphRagPrerenderMatchThreshold);
  if (graphRagPrerenderMatchThreshold === undefined) return undefined;
  return { graphRagPrerenderMatchThreshold };
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalBoolean(value: boolean | string | null | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(normalized.toLowerCase())) return false;
  return undefined;
}

function normalizeOptionalNumber(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveWalletApiBaseUrl(value: string | null | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if (normalized !== "same-origin") return normalized;
  if (typeof window === "undefined") return undefined;
  return window.location.origin;
}
