import type { UploadItem } from "../models/abby";
import { readRuntimeFilecoinStorageConfig } from "../lib/runtimeConfig";
import type { WalletApiConfig } from "./walletApi";

const FILECOIN_STORAGE_CONFIG_KEY = "abby-filecoin-storage-config";

type StoredFilecoinStorageConfig = {
  uploadUrl?: string;
  clientToken?: string;
};

export type FilecoinStorageClientConfig = {
  uploadUrl: string;
  clientToken?: string;
};

export type FilecoinUploadRequestMetadata = {
  actorDid?: string;
  allowedRecipientIds?: string[];
  fileName?: string;
  mimeType?: string;
  recordId?: string;
  sha256?: string;
  sharingMode?: UploadItem["sharingMode"];
  sizeBytes?: number;
  walletId?: string;
};

export type FilecoinUploadResponse = {
  cid?: string;
  dealId?: string;
  encryptedMetadataCid?: string | null;
  encryptedPayloadCid?: string;
  filecoinDealId?: string;
  info?: Record<string, unknown>;
  filecoinPinInfo?: Record<string, unknown>;
  filecoinPinRequestId?: string;
  filecoinPinStatus?: "queued" | "pinning" | "pinned" | "failed";
  filecoinPieceCid?: string;
  gatewayUrl?: string;
  ipfsCid?: string;
  ipldLinks?: Array<{ "/"?: string; cid?: string; mediaType?: string; name: string }>;
  metadataCid?: string;
  metadataGatewayUrl?: string;
  metadataIpldCid?: string;
  metadataIpldLink?: { "/"?: string; cid?: string; mediaType?: string; name: string };
  message?: string;
  pieceCid?: string;
  provider?: UploadItem["decentralizedStorageProvider"] | string;
  recordId?: string;
  requestId?: string;
  root?: { "/": string };
  statusUrl?: string;
  status?: string;
  url?: string;
  versionId?: string;
};

export type FilecoinStatusPollOptions = {
  clientConfig?: FilecoinStorageClientConfig;
  maxAttempts?: number;
  onUpdate?: (result: FilecoinUploadResponse) => void;
  pollIntervalMs?: number;
};

export function getFilecoinStorageConfig(): FilecoinStorageClientConfig | undefined {
  const uploadUrl =
    readStoredFilecoinStorageConfig().uploadUrl ||
    readRuntimeFilecoinStorageConfig()?.uploadUrl ||
    readEnv("VITE_FILECOIN_STORAGE_UPLOAD_URL") ||
    readEnv("VITE_IPFS_FILECOIN_UPLOAD_URL");
  if (!uploadUrl) return undefined;
  return {
    uploadUrl,
    clientToken:
      readStoredFilecoinStorageConfig().clientToken ||
      readRuntimeFilecoinStorageConfig()?.clientToken ||
      readEnv("VITE_FILECOIN_STORAGE_CLIENT_TOKEN") ||
      readEnv("VITE_IPFS_FILECOIN_CLIENT_TOKEN")
  };
}

export function filecoinStorageConfigured(): boolean {
  return Boolean(getFilecoinStorageConfig()?.uploadUrl);
}

export async function uploadFileToFilecoinStorage(
  file: File,
  {
    allowedRecipientIds = [],
    clientConfig = getFilecoinStorageConfig(),
    upload,
    walletConfig
  }: {
    allowedRecipientIds?: string[];
    clientConfig?: FilecoinStorageClientConfig;
    upload: UploadItem;
    walletConfig?: WalletApiConfig;
  }
): Promise<FilecoinUploadResponse> {
  if (!clientConfig) throw new Error("Filecoin storage backend is not configured.");
  const metadata: FilecoinUploadRequestMetadata = {
    actorDid: walletConfig?.actorDid,
    allowedRecipientIds,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    recordId: upload.recordId,
    sha256: await sha256Hex(file),
    sharingMode: upload.sharingMode ?? "private",
    sizeBytes: file.size,
    walletId: walletConfig?.walletId
  };
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("metadata", JSON.stringify(metadata));
  return postToFilecoinStorage(clientConfig, form);
}

export async function uploadWalletRecordToFilecoinStorage(
  upload: UploadItem,
  {
    allowedRecipientIds = upload.allowedRecipientIds ?? [],
    clientConfig = getFilecoinStorageConfig(),
    walletConfig
  }: {
    allowedRecipientIds?: string[];
    clientConfig?: FilecoinStorageClientConfig;
    walletConfig?: WalletApiConfig;
  }
): Promise<FilecoinUploadResponse> {
  if (!clientConfig) throw new Error("Filecoin storage backend is not configured.");
  if (!upload.recordId) throw new Error("A wallet record ID is required for backend Filecoin storage.");
  const body = JSON.stringify({
    actorDid: walletConfig?.actorDid,
    allowedRecipientIds,
    fileName: upload.fileName,
    recordId: upload.recordId,
    sharingMode: upload.sharingMode ?? "private",
    walletApiBaseUrl: walletConfig?.apiBaseUrl,
    walletId: walletConfig?.walletId
  });
  return postToFilecoinStorage(clientConfig, body, "application/json");
}

export async function uploadProofBundleToFilecoinStorage(
  bundlePayload: string,
  {
    clientConfig = getFilecoinStorageConfig(),
    walletConfig
  }: {
    clientConfig?: FilecoinStorageClientConfig;
    walletConfig?: WalletApiConfig;
  } = {}
): Promise<FilecoinUploadResponse> {
  if (!clientConfig) throw new Error("Filecoin storage backend is not configured.");
  const file = new File([bundlePayload], "wallet-proof-bundle.json", { type: "application/json" });
  const metadata: FilecoinUploadRequestMetadata = {
    actorDid: walletConfig?.actorDid,
    fileName: file.name,
    mimeType: file.type,
    sha256: await sha256Hex(file),
    sizeBytes: file.size,
    walletId: walletConfig?.walletId
  };
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("metadata", JSON.stringify(metadata));
  return postToFilecoinStorage(clientConfig, form);
}

export async function uploadRecoveryBundleToFilecoinStorage(
  bundlePayload: string,
  {
    clientConfig = getFilecoinStorageConfig(),
    walletConfig
  }: {
    clientConfig?: FilecoinStorageClientConfig;
    walletConfig?: WalletApiConfig;
  } = {}
): Promise<FilecoinUploadResponse> {
  if (!clientConfig) throw new Error("Filecoin storage backend is not configured.");
  const file = new File([bundlePayload], "wallet-recovery-bundle.json", {
    type: "application/vnd.211-ai.wallet.recovery+json"
  });
  const metadata: FilecoinUploadRequestMetadata = {
    actorDid: walletConfig?.actorDid,
    fileName: file.name,
    mimeType: file.type,
    sha256: await sha256Hex(file),
    sizeBytes: file.size,
    walletId: walletConfig?.walletId
  };
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("metadata", JSON.stringify(metadata));
  return postToFilecoinStorage(clientConfig, form);
}

export function toFilecoinStoragePatch(result: FilecoinUploadResponse): Partial<UploadItem> {
  const ipfsCid = result.ipfsCid || result.cid;
  const ipfsRootCid = result.root?.["/"] || ipfsCid;
  const filecoinPinInfo =
    (isRecord(result.filecoinPinInfo) ? result.filecoinPinInfo : undefined) ||
    (isRecord(result.info) ? result.info : undefined);
  const filecoinPinStatus = normalizeFilecoinPinStatus(result);
  return {
    decentralizedStorageMessage: buildFilecoinStorageMessage(result, ipfsCid, filecoinPinStatus),
    decentralizedStorageProvider: normalizeStorageProvider(result.provider),
    decentralizedStorageStatus: "stored",
    encryptedMetadataCid: result.encryptedMetadataCid || undefined,
    encryptedPayloadCid: result.encryptedPayloadCid,
    filecoinDealId: result.filecoinDealId || result.dealId,
    filecoinPieceCid: result.filecoinPieceCid || result.pieceCid || readInfoString(filecoinPinInfo, "synapse_piece_cid"),
    filecoinPinRequestId: result.filecoinPinRequestId || result.requestId,
    filecoinPinStatus,
    filecoinPinStatusUrl: result.statusUrl,
    ipfsCid,
    ipfsGatewayUrl: ipfsCid ? sameOriginIpfsGatewayUrl(ipfsCid) : result.gatewayUrl || result.url,
    ipfsRootCid,
    ipldLinks: result.ipldLinks,
    metadataCid: result.metadataCid,
    metadataGatewayUrl: result.metadataCid ? sameOriginIpfsGatewayUrl(result.metadataCid) : result.metadataGatewayUrl,
    metadataIpldCid: result.metadataIpldCid,
    metadataIpldLink: result.metadataIpldLink
  };
}

export function sameOriginIpfsGatewayUrl(cid: string | undefined): string | undefined {
  const normalized = normalizeIpfsCid(cid);
  return normalized ? `/ipfs-proxy/${normalized}` : undefined;
}

export function normalizeIpfsGatewayUrl(urlOrCid: string | undefined): string | undefined {
  const normalized = normalizeIpfsCid(urlOrCid);
  return normalized ? sameOriginIpfsGatewayUrl(normalized) : urlOrCid;
}

function normalizeIpfsCid(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const withoutScheme = raw.replace(/^ipfs:\/\//i, "");
  const pathMatch = withoutScheme.match(/(?:^|\/)ipfs\/([^/?#]+)/i);
  const hostMatch = withoutScheme.match(/^([a-z0-9]+)\.ipfs\.(?:dweb\.link|[^/?#]+)/i);
  return (pathMatch?.[1] || hostMatch?.[1] || withoutScheme.split(/[/?#]/, 1)[0]).trim() || undefined;
}

export async function pollFilecoinStorageStatus(
  initialResult: FilecoinUploadResponse,
  {
    clientConfig = getFilecoinStorageConfig(),
    maxAttempts = 12,
    onUpdate,
    pollIntervalMs = 1000
  }: FilecoinStatusPollOptions = {}
): Promise<FilecoinUploadResponse | undefined> {
  const requestId = initialResult.filecoinPinRequestId || initialResult.requestId;
  if (!requestId || !clientConfig) return undefined;

  let latestResult = initialResult;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const currentStatus = normalizeFilecoinPinStatus(latestResult);
    if (currentStatus === "pinned" || currentStatus === "failed") {
      return latestResult;
    }
    await wait(pollIntervalMs);
    const nextResult = await fetchFilecoinStorageStatus(requestId, clientConfig, latestResult.statusUrl);
    const nextFilecoinPinStatus = normalizeFilecoinPinStatus(nextResult);
    latestResult = {
      ...latestResult,
      ...nextResult,
      filecoinPinStatus: nextFilecoinPinStatus ?? latestResult.filecoinPinStatus,
      message: nextResult.message,
      requestId,
      statusUrl: nextResult.statusUrl || latestResult.statusUrl
    };
    onUpdate?.(latestResult);
  }
  return latestResult;
}

function readStoredFilecoinStorageConfig(): StoredFilecoinStorageConfig {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FILECOIN_STORAGE_CONFIG_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return {
      clientToken: typeof parsed.clientToken === "string" ? parsed.clientToken : undefined,
      uploadUrl: typeof parsed.uploadUrl === "string" ? parsed.uploadUrl : undefined
    };
  } catch {
    return {};
  }
}

function readEnv(key: string): string | undefined {
  const value = (import.meta.env[key] as string | undefined)?.trim();
  return value || undefined;
}

async function postToFilecoinStorage(
  clientConfig: FilecoinStorageClientConfig,
  body: BodyInit,
  contentType?: string
): Promise<FilecoinUploadResponse> {
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  if (clientConfig.clientToken) headers.set("authorization", `Bearer ${clientConfig.clientToken}`);
  const response = await fetch(clientConfig.uploadUrl, {
    body,
    headers,
    method: "POST"
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const errorPayload = payload as { error?: string; message?: string };
    throw new Error(errorPayload.message || errorPayload.error || `Filecoin storage request failed with ${response.status}.`);
  }
  return payload as FilecoinUploadResponse;
}

async function fetchFilecoinStorageStatus(
  requestId: string,
  clientConfig: FilecoinStorageClientConfig,
  statusUrl?: string
): Promise<FilecoinUploadResponse> {
  const headers = new Headers();
  if (clientConfig.clientToken) headers.set("authorization", `Bearer ${clientConfig.clientToken}`);
  const response = await fetch(resolveStatusUrl(requestId, clientConfig, statusUrl), {
    headers,
    method: "GET"
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const errorPayload = payload as { error?: string; message?: string };
    throw new Error(errorPayload.message || errorPayload.error || `Filecoin status request failed with ${response.status}.`);
  }
  return payload as FilecoinUploadResponse;
}

async function readJsonResponse(response: Response): Promise<Record<string, string> | FilecoinUploadResponse> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function sha256Hex(file: File): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeStorageProvider(provider: FilecoinUploadResponse["provider"]): UploadItem["decentralizedStorageProvider"] {
  if (provider === "ipfs" || provider === "filecoin" || provider === "wallet-api" || provider === "local") {
    return provider;
  }
  return "ipfs-filecoin";
}

function buildFilecoinStorageMessage(
  result: FilecoinUploadResponse,
  ipfsCid: string | undefined,
  filecoinPinStatus: UploadItem["filecoinPinStatus"]
): string {
  if (result.message?.trim()) return result.message;
  if (filecoinPinStatus === "queued") return "Stored on IPFS. Queued for Filecoin persistence.";
  if (filecoinPinStatus === "pinning") return "Stored on IPFS. Filecoin persistence is in progress.";
  if (filecoinPinStatus === "pinned") return "Stored on IPFS and confirmed by Filecoin persistence.";
  if (filecoinPinStatus === "failed") return "Stored on IPFS, but Filecoin persistence failed.";
  return ipfsCid ? "Stored on IPFS/Filecoin." : "Storage request completed.";
}

function normalizeFilecoinPinStatus(result: FilecoinUploadResponse): UploadItem["filecoinPinStatus"] {
  const rawStatus = (result.filecoinPinStatus || result.status || "").trim().toLowerCase();
  if (rawStatus === "queued" || rawStatus === "pinning" || rawStatus === "pinned" || rawStatus === "failed") {
    return rawStatus;
  }
  return undefined;
}

function readInfoString(info: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = info?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function resolveStatusUrl(requestId: string, clientConfig: FilecoinStorageClientConfig, statusUrl?: string): string {
  const baseUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  if (statusUrl?.trim()) {
    return new URL(statusUrl, baseUrl).toString();
  }
  const uploadUrl = new URL(clientConfig.uploadUrl, baseUrl);
  uploadUrl.pathname = `${uploadUrl.pathname.replace(/\/$/, "")}/status/${encodeURIComponent(requestId)}`;
  uploadUrl.search = "";
  uploadUrl.hash = "";
  return uploadUrl.toString();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
