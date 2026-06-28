import type { UploadItem } from "../models/abby";
import { readRuntimeWalrusStorageConfig } from "../lib/runtimeConfig";
import type { WalletApiConfig } from "./walletApi";

const WALRUS_STORAGE_CONFIG_KEY = "abby-walrus-storage-config";

type StoredWalrusStorageConfig = {
  aggregatorUrl?: string;
  clientToken?: string;
  deleteUrl?: string;
  deletable?: boolean;
  epochs?: number;
  publisherUrl?: string;
};

export type WalrusStorageClientConfig = {
  publisherUrl: string;
  aggregatorUrl?: string;
  clientToken?: string;
  deleteUrl?: string;
  deletable?: boolean;
  epochs?: number;
};

export type WalrusUploadRequestMetadata = {
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

export type WalrusUploadResponse = {
  alreadyCertified?: {
    blob_id?: string;
    blobId?: string;
    end_epoch?: number;
    endEpoch?: number;
    event?: { eventSeq?: string; txDigest?: string };
    object?: string;
  };
  blobId?: string;
  blobObjectId?: string;
  blobUrl?: string;
  cost?: number;
  endEpoch?: number;
  gatewayUrl?: string;
  message?: string;
  newlyCreated?: {
    blob_object?: WalrusBlobObject;
    blobObject?: {
      blob_id?: string;
      blobId?: string;
      certifiedEpoch?: number;
      deletable?: boolean;
      id?: string;
      registeredEpoch?: number;
      size?: number;
      storage?: {
        end_epoch?: number;
        endEpoch?: number;
        id?: string;
        startEpoch?: number;
        storageSize?: number;
      };
    };
    cost?: number;
  };
  provider?: UploadItem["decentralizedStorageProvider"] | string;
  recordId?: string;
  status?: string;
  suiObjectId?: string;
  txDigest?: string;
  url?: string;
  walrusBlobId?: string;
};

type WalrusBlobObject = {
  blob_id?: string;
  blobId?: string;
  certified_epoch?: number;
  certifiedEpoch?: number;
  deletable?: boolean;
  id?: string;
  registered_epoch?: number;
  registeredEpoch?: number;
  size?: number;
  storage?: {
    end_epoch?: number;
    endEpoch?: number;
    id?: string;
    start_epoch?: number;
    startEpoch?: number;
    storage_size?: number;
    storageSize?: number;
  };
};

export function getWalrusStorageConfig(): WalrusStorageClientConfig | undefined {
  const stored = readStoredWalrusStorageConfig();
  const runtime = readRuntimeWalrusStorageConfig();
  const publisherUrl =
    stored.publisherUrl ||
    runtime?.publisherUrl ||
    readEnv("VITE_WALRUS_STORAGE_PUBLISHER_URL") ||
    readEnv("VITE_WALRUS_PUBLISHER_URL");
  if (!publisherUrl) return undefined;
  return {
    publisherUrl,
    aggregatorUrl:
      stored.aggregatorUrl ||
      runtime?.aggregatorUrl ||
      readEnv("VITE_WALRUS_STORAGE_AGGREGATOR_URL") ||
      readEnv("VITE_WALRUS_AGGREGATOR_URL"),
    clientToken:
      stored.clientToken ||
      runtime?.clientToken ||
      readEnv("VITE_WALRUS_STORAGE_CLIENT_TOKEN") ||
      readEnv("VITE_WALRUS_CLIENT_TOKEN"),
    deleteUrl:
      stored.deleteUrl ||
      runtime?.deleteUrl ||
      readEnv("VITE_WALRUS_STORAGE_DELETE_URL") ||
      readEnv("VITE_WALRUS_DELETE_URL"),
    deletable: stored.deletable ?? runtime?.deletable ?? readEnvBoolean("VITE_WALRUS_STORAGE_DELETABLE"),
    epochs: stored.epochs ?? runtime?.epochs ?? readEnvNumber("VITE_WALRUS_STORAGE_EPOCHS")
  };
}

export async function uploadFileToWalrusStorage(
  file: File,
  {
    allowedRecipientIds = [],
    clientConfig = getWalrusStorageConfig(),
    upload,
    walletConfig
  }: {
    allowedRecipientIds?: string[];
    clientConfig?: WalrusStorageClientConfig;
    upload: UploadItem;
    walletConfig?: WalletApiConfig;
  }
): Promise<WalrusUploadResponse> {
  if (!clientConfig) throw new Error("Walrus storage backend is not configured.");
  const metadata: WalrusUploadRequestMetadata = {
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
  return putToWalrusPublisher(clientConfig, file, metadata);
}

export async function uploadWalletRecordToWalrusStorage(
  upload: UploadItem,
  {
    allowedRecipientIds = upload.allowedRecipientIds ?? [],
    clientConfig = getWalrusStorageConfig(),
    walletConfig
  }: {
    allowedRecipientIds?: string[];
    clientConfig?: WalrusStorageClientConfig;
    walletConfig?: WalletApiConfig;
  }
): Promise<WalrusUploadResponse> {
  if (!clientConfig) throw new Error("Walrus storage backend is not configured.");
  if (!upload.recordId) throw new Error("A wallet record ID is required for backend Walrus storage.");
  const body = JSON.stringify({
    actorDid: walletConfig?.actorDid,
    allowedRecipientIds,
    fileName: upload.fileName,
    recordId: upload.recordId,
    sharingMode: upload.sharingMode ?? "private",
    walletApiBaseUrl: walletConfig?.apiBaseUrl,
    walletId: walletConfig?.walletId
  });
  return putToWalrusPublisher(
    clientConfig,
    new Blob([body], { type: "application/vnd.211-ai.wallet-record-ref+json" }),
    {
      actorDid: walletConfig?.actorDid,
      allowedRecipientIds,
      fileName: `${upload.recordId}.wallet-record-ref.json`,
      mimeType: "application/vnd.211-ai.wallet-record-ref+json",
      recordId: upload.recordId,
      sharingMode: upload.sharingMode ?? "private",
      sizeBytes: body.length,
      walletId: walletConfig?.walletId
    }
  );
}

export function toWalrusStoragePatch(result: WalrusUploadResponse, clientConfig = getWalrusStorageConfig()): Partial<UploadItem> {
  const blobId = readWalrusBlobId(result);
  const objectId = readWalrusObjectId(result);
  return {
    decentralizedStorageMessage: buildWalrusStorageMessage(result, blobId),
    decentralizedStorageProvider: "walrus",
    decentralizedStorageStatus: "stored",
    walrusBlobId: blobId,
    walrusEndEpoch: readWalrusEndEpoch(result),
    walrusGatewayUrl: blobId ? buildWalrusBlobUrl(blobId, clientConfig?.aggregatorUrl) : result.blobUrl || result.gatewayUrl || result.url,
    walrusObjectId: objectId,
    walrusStorageCost: result.cost ?? result.newlyCreated?.cost,
    walrusTxDigest: result.txDigest || result.alreadyCertified?.event?.txDigest
  };
}

export async function deleteWalrusBlobFromStorage(
  upload: UploadItem,
  {
    clientConfig = getWalrusStorageConfig(),
    walletConfig
  }: {
    clientConfig?: WalrusStorageClientConfig;
    walletConfig?: WalletApiConfig;
  } = {}
): Promise<WalrusUploadResponse> {
  if (!clientConfig?.deleteUrl) throw new Error("Walrus delete backend is not configured.");
  if (!upload.walrusBlobId) throw new Error("This wallet file does not have a Walrus blob ID.");
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (clientConfig.clientToken) headers.set("authorization", `Bearer ${clientConfig.clientToken}`);
  const response = await fetch(resolveWalrusDeleteUrl(clientConfig, upload), {
    body: JSON.stringify({
      actorDid: walletConfig?.actorDid,
      blobId: upload.walrusBlobId,
      blobObjectId: upload.walrusObjectId,
      fileName: upload.fileName,
      recordId: upload.recordId,
      walletId: walletConfig?.walletId
    }),
    headers,
    method: "DELETE"
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(readErrorMessage(payload) || `Walrus delete request failed with ${response.status}.`);
  }
  return payload as WalrusUploadResponse;
}

export function canDeleteWalrusBlob(clientConfig: WalrusStorageClientConfig | undefined): boolean {
  return Boolean(clientConfig?.deleteUrl);
}

export function buildWalrusBlobUrl(blobId: string | undefined, aggregatorUrl: string | undefined): string | undefined {
  if (!blobId || !aggregatorUrl) return undefined;
  const baseUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  const url = new URL(aggregatorUrl, baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readStoredWalrusStorageConfig(): StoredWalrusStorageConfig {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WALRUS_STORAGE_CONFIG_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return {
      aggregatorUrl: typeof parsed.aggregatorUrl === "string" ? parsed.aggregatorUrl : undefined,
      clientToken: typeof parsed.clientToken === "string" ? parsed.clientToken : undefined,
      deleteUrl: typeof parsed.deleteUrl === "string" ? parsed.deleteUrl : undefined,
      deletable: typeof parsed.deletable === "boolean" ? parsed.deletable : undefined,
      epochs: typeof parsed.epochs === "number" ? parsed.epochs : undefined,
      publisherUrl: typeof parsed.publisherUrl === "string" ? parsed.publisherUrl : undefined
    };
  } catch {
    return {};
  }
}

async function putToWalrusPublisher(
  clientConfig: WalrusStorageClientConfig,
  body: BodyInit,
  metadata: WalrusUploadRequestMetadata
): Promise<WalrusUploadResponse> {
  const headers = new Headers();
  if (metadata.mimeType) headers.set("content-type", metadata.mimeType);
  if (clientConfig.clientToken) headers.set("authorization", `Bearer ${clientConfig.clientToken}`);
  const response = await fetch(resolvePublisherBlobUrl(clientConfig), {
    body,
    headers,
    method: "PUT"
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(readErrorMessage(payload) || `Walrus storage request failed with ${response.status}.`);
  }
  return payload as WalrusUploadResponse;
}

function resolvePublisherBlobUrl(clientConfig: WalrusStorageClientConfig): string {
  const baseUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  const url = new URL(clientConfig.publisherUrl, baseUrl);
  if (!/\/v1\/blobs\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/blobs`;
  }
  if (clientConfig.epochs) url.searchParams.set("epochs", String(clientConfig.epochs));
  if (clientConfig.deletable !== undefined) {
    url.searchParams.set(clientConfig.deletable ? "deletable" : "permanent", "true");
  }
  return url.toString();
}

function resolveWalrusDeleteUrl(clientConfig: WalrusStorageClientConfig, upload: UploadItem): string {
  const baseUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  const blobId = upload.walrusBlobId || "";
  const objectId = upload.walrusObjectId || "";
  const recordId = upload.recordId || "";
  const template = clientConfig.deleteUrl || "";
  const resolvedTemplate = template
    .replace(/\{blobId\}/g, encodeURIComponent(blobId))
    .replace(/\{objectId\}/g, encodeURIComponent(objectId))
    .replace(/\{recordId\}/g, encodeURIComponent(recordId));
  const url = new URL(resolvedTemplate, baseUrl);
  if (resolvedTemplate === template && !/\/v1\/blobs\/[^/]+$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/blobs/${encodeURIComponent(blobId)}`;
  }
  if (objectId && !url.searchParams.has("objectId")) url.searchParams.set("objectId", objectId);
  if (recordId && !url.searchParams.has("recordId")) url.searchParams.set("recordId", recordId);
  return url.toString();
}

async function readJsonResponse(response: Response): Promise<Record<string, string> | WalrusUploadResponse> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function readErrorMessage(payload: Record<string, unknown> | WalrusUploadResponse): string | undefined {
  const payloadRecord = payload as Record<string, unknown>;
  if (typeof payloadRecord.message === "string" && payloadRecord.message.trim()) return payloadRecord.message;
  const error = payloadRecord.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === "string" && errorRecord.message.trim()) return errorRecord.message;
    if (typeof errorRecord.error_msg === "string" && errorRecord.error_msg.trim()) return errorRecord.error_msg;
  }
  return undefined;
}

async function sha256Hex(file: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readWalrusBlobId(result: WalrusUploadResponse): string | undefined {
  return (
    result.walrusBlobId ||
    result.blobId ||
    result.newlyCreated?.blobObject?.blobId ||
    result.newlyCreated?.blobObject?.blob_id ||
    result.newlyCreated?.blob_object?.blobId ||
    result.newlyCreated?.blob_object?.blob_id ||
    result.alreadyCertified?.blobId ||
    result.alreadyCertified?.blob_id ||
    undefined
  );
}

function readWalrusObjectId(result: WalrusUploadResponse): string | undefined {
  return result.suiObjectId || result.blobObjectId || result.newlyCreated?.blobObject?.id || result.newlyCreated?.blob_object?.id || result.alreadyCertified?.object;
}

function readWalrusEndEpoch(result: WalrusUploadResponse): number | undefined {
  return (
    result.endEpoch ||
    result.alreadyCertified?.endEpoch ||
    result.alreadyCertified?.end_epoch ||
    result.newlyCreated?.blobObject?.storage?.endEpoch ||
    result.newlyCreated?.blobObject?.storage?.end_epoch ||
    result.newlyCreated?.blob_object?.storage?.endEpoch ||
    result.newlyCreated?.blob_object?.storage?.end_epoch
  );
}

function buildWalrusStorageMessage(result: WalrusUploadResponse, blobId: string | undefined): string {
  if (result.message?.trim()) return result.message;
  if (result.alreadyCertified) return "Stored on Walrus; blob was already certified.";
  return blobId ? "Stored on Walrus." : "Walrus storage request completed.";
}

function readEnv(key: string): string | undefined {
  const value = (import.meta.env[key] as string | undefined)?.trim();
  return value || undefined;
}

function readEnvBoolean(key: string): boolean | undefined {
  const value = readEnv(key)?.toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function readEnvNumber(key: string): number | undefined {
  const value = readEnv(key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
