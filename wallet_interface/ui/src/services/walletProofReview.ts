import type { ProofReceiptView } from "../models/abby";

const qrImageAcceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const cidPattern = /\b(?:bafy[a-z0-9]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})\b/;
const walletProofBundleParam = "walletProofBundle";
const worldIdProofType = "world_id_proof_of_human";
const worldIdNullifierRefPrefix = "worldid-nullifier-ref:v1:";
const privateProofMetadataKeyPattern =
  /(^|_)(bearer|developer_portal_response|developer_response|email|full_name|idkit|key_hex|nonce|phone|pii|private|raw_nullifier|raw_proof|responses|root|rp_context|rp_signature|secret|session_id|session_nullifier|signature|ssn|token|witness)(_|$)/i;
const piiValuePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court)\b/i
];
const privateProofValuePatterns = [
  /0xraw/i,
  /developer_portal_response/i,
  /idkit_payload/i,
  /idkit_proof/i,
  /raw[-_\s]?world[-_\s]?id[-_\s]?nullifier/i,
  /raw_nullifier/i,
  /rp_signature/i,
  /0xmocksig/i
];

type BarcodeDetectorLike = {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
};

type BarcodeDetectorLikeConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

type ReviewLocator =
  | { kind: "inline"; payload: unknown; sourceLabel: string }
  | { kind: "url"; sourceLabel: string; url: string }
  | { kind: "cid"; cid: string; sourceLabel: string };

type ProofArtifactLocator = { cid: string } | { url: string };
type LinkedProofReference = ProofArtifactLocator & {
  claim: string;
  id: string;
  proofType: string;
};

export type WalletIpldLink = {
  "/"?: string;
  cid?: string;
  mediaType?: string;
  name: string;
};

export type WalletEncryptedRecordLink = {
  cid: string;
  fileName?: string;
  links?: WalletIpldLink[];
  recordId?: string;
  root?: { "/": string };
  versionId?: string;
};

export type WalletProofQrReview = {
  bundleTitle?: string;
  encryptedRecords: WalletEncryptedRecordLink[];
  proofs: ProofReceiptView[];
  qrValue: string;
  sourceLabel: string;
  sourceUrl?: string;
  wallet?: {
    actorDid?: string;
    id?: string;
    label?: string;
  };
};

export function buildWalletProofBundlePayload({
  actorDid,
  encryptedRecordLinks = [],
  proofs,
  walletId
}: {
  actorDid?: string;
  encryptedRecordLinks?: WalletEncryptedRecordLink[];
  proofs: ProofReceiptView[];
  walletId?: string;
}): string {
  const linkedProofs = proofs
    .map((proof) => {
      const locator = parseProofArtifactLocator(proof.proofArtifactRef);
      if (!locator) return undefined;
      return {
        ...locator,
        claim: proof.claim,
        id: proof.id,
        proofType: proof.proofType
      };
    })
    .filter((proof): proof is LinkedProofReference => Boolean(proof));
  const inlineProofs = proofs
    .filter((proof) => !parseProofArtifactLocator(proof.proofArtifactRef))
    .map(sanitizeProofViewForBundle);
  return JSON.stringify({
    "@context": {
      ipld: "https://ipld.io/",
      wallet: "https://211-ai.com/ns/wallet#"
    },
    linkedProofs,
    schemaVersion: "211-ai-wallet-root-ipld-v1",
    title: "Client encrypted wallet root",
    generatedAt: new Date().toISOString(),
    encryptedRecords: encryptedRecordLinks.map((record) => ({
      "/": record.root?.["/"] || record.cid,
      cid: record.root?.["/"] || record.cid,
      fileName: record.fileName,
      links: record.links ?? [],
      recordId: record.recordId,
      versionId: record.versionId
    })),
    proofs: inlineProofs,
    wallet: {
      actorDid,
      id: walletId,
      label: walletId ? `Wallet ${walletId}` : "Client wallet"
    }
  });
}

export function buildWalletProofReviewUrl(bundlePayload: string, baseUrl = currentBaseUrl()): string {
  const url = new URL(baseUrl);
  url.searchParams.set(walletProofBundleParam, bundlePayload);
  url.hash = "/proof-center";
  return url.toString();
}

export async function reviewWalletProofBundleReference(
  value: string,
  qrValue = value,
  sourceLabel?: string,
  sourceUrl?: string
): Promise<WalletProofQrReview> {
  const locator = parseReviewLocator(value);
  const resolved = await resolveReviewLocator(locator);
  return reviewWalletProofBundlePayload(
    resolved.payload,
    qrValue,
    sourceLabel || resolved.sourceLabel,
    sourceUrl || resolved.sourceUrl
  );
}

export function reviewWalletProofBundlePayload(
  payload: string | unknown,
  qrValue = "wallet-proof-bundle",
  sourceLabel = "Wallet proof bundle from QR",
  sourceUrl?: string
): WalletProofQrReview {
  const parsedPayload = typeof payload === "string" ? parseJson(payload) : payload;
  if (typeof payload === "string" && parsedPayload === undefined) {
    throw new Error("The wallet proof bundle link is invalid.");
  }
  const bundle = unwrapProofPayload(parsedPayload);
  const proofs = normalizeProofs(bundle);

  return {
    bundleTitle: readBundleTitle(bundle),
    encryptedRecords: normalizeEncryptedRecords(bundle),
    proofs,
    qrValue,
    sourceLabel,
    sourceUrl,
    wallet: readWalletSummary(bundle)
  };
}

export function readWalletProofBundlePayloadFromUrl(urlValue: string): string | undefined {
  try {
    return new URL(urlValue, currentBaseUrl()).searchParams.get(walletProofBundleParam) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function reviewWalletProofQrScreenshot(file: File): Promise<WalletProofQrReview> {
  if (!qrImageAcceptedTypes.has(file.type)) {
    throw new Error("Upload a PNG, JPEG, or WebP screenshot of the wallet QR code.");
  }

  const qrValue = (await readQrValue(file)).trim();
  return reviewWalletProofBundleReference(qrValue);
}

export async function readQrValue(file: File): Promise<string> {
  const detectorValue = await readQrValueWithBarcodeDetector(file).catch(() => "");
  if (detectorValue) return detectorValue;

  const ocrValue = await readQrValueWithOcr(file).catch(() => "");
  if (ocrValue) return ocrValue;

  throw new Error("We could not read a QR code or proof bundle link from that screenshot.");
}

async function readQrValueWithBarcodeDetector(file: File): Promise<string> {
  if (typeof window === "undefined") return "";
  const detectorCtor = (window as Window & { BarcodeDetector?: BarcodeDetectorLikeConstructor }).BarcodeDetector;
  if (!detectorCtor) return "";

  const detector = new detectorCtor({ formats: ["qr_code"] });
  const bitmap = await createImageBitmap(file);
  try {
    const matches = await detector.detect(bitmap);
    return matches.find((match) => typeof match.rawValue === "string" && match.rawValue.trim())?.rawValue?.trim() || "";
  } finally {
    bitmap.close();
  }
}

async function readQrValueWithOcr(file: File): Promise<string> {
  const { recognize } = await import("tesseract.js");
  const result = await recognize(file, "eng");
  const text = result.data.text || "";
  return extractLocatorToken(text);
}

function extractLocatorToken(text: string): string {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const jsonCandidate = text.slice(jsonStart, jsonEnd + 1).trim();
    try {
      JSON.parse(jsonCandidate);
      return jsonCandidate;
    } catch {
      // Ignore and continue with URL/CID detection.
    }
  }

  const urlMatch = text.match(/https?:\/\/[^\s<>"']+|ipfs:\/\/[^\s<>"']+/i);
  if (urlMatch) return urlMatch[0];

  const cidMatch = text.match(cidPattern);
  return cidMatch?.[0] ?? "";
}

function parseReviewLocator(qrValue: string): ReviewLocator {
  const jsonPayload = parseJson(qrValue);
  if (jsonPayload && hasInlineProofs(jsonPayload)) {
    return { kind: "inline", payload: jsonPayload, sourceLabel: "Wallet proof bundle from QR" };
  }

  const locatorFromPayload = jsonPayload ? locatorFromObject(jsonPayload) : undefined;
  if (locatorFromPayload) return locatorFromPayload;

  if (qrValue.startsWith("ipfs://")) {
    return { kind: "cid", cid: qrValue.slice("ipfs://".length).replace(/^ipfs\//, ""), sourceLabel: "IPFS/Filecoin proof bundle" };
  }

  if (/^https?:\/\//i.test(qrValue)) {
    const cidFromGateway = cidFromUrl(qrValue);
    if (cidFromGateway) {
      return { kind: "cid", cid: cidFromGateway, sourceLabel: "IPFS/Filecoin proof bundle" };
    }
    const inlinePayload = readWalletProofBundlePayloadFromUrl(qrValue);
    if (inlinePayload) {
      return {
        kind: "inline",
        payload: inlinePayload,
        sourceLabel: "Wallet proof bundle link"
      };
    }
    return { kind: "url", url: qrValue, sourceLabel: labelForUrl(qrValue) };
  }

  const cidMatch = qrValue.match(cidPattern);
  if (cidMatch) {
    return { kind: "cid", cid: cidMatch[0], sourceLabel: "IPFS/Filecoin proof bundle" };
  }

  throw new Error("The QR code does not point to a supported proof bundle.");
}

function locatorFromObject(payload: unknown): ReviewLocator | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const urlValue = firstString(
    record.proofsUrl,
    record.proofBundleUrl,
    record.proof_manifest_url,
    record.gatewayUrl,
    record.url
  );
  if (urlValue) {
    const cidFromGateway = /^https?:\/\//i.test(urlValue) ? cidFromUrl(urlValue) : undefined;
    if (cidFromGateway) {
      return { kind: "cid", cid: cidFromGateway, sourceLabel: "IPFS/Filecoin proof bundle" };
    }
    return /^https?:\/\//i.test(urlValue)
      ? { kind: "url", url: urlValue, sourceLabel: labelForUrl(urlValue) }
      : { kind: "cid", cid: normalizeCid(urlValue), sourceLabel: "IPFS/Filecoin proof bundle" };
  }

  const cidValue = firstString(record.proofsCid, record.proofBundleCid, record.ipfsCid, record.cid);
  if (cidValue) {
    return { kind: "cid", cid: normalizeCid(cidValue), sourceLabel: "IPFS/Filecoin proof bundle" };
  }

  return undefined;
}

async function resolveReviewLocator(locator: ReviewLocator): Promise<{
  payload: unknown;
  sourceLabel: string;
  sourceUrl?: string;
}> {
  if (locator.kind === "inline") {
    return {
      payload: await hydrateProofBundle(locator.payload),
      sourceLabel: locator.sourceLabel
    };
  }

  if (locator.kind === "url") {
    return {
      payload: await hydrateProofBundle(await fetchJson(locator.url)),
      sourceLabel: locator.sourceLabel,
      sourceUrl: locator.url
    };
  }

  let lastError: Error | undefined;
  for (const gateway of defaultIpfsGateways()) {
    const url = `${gateway}${locator.cid}`;
    try {
      return {
        payload: await hydrateProofBundle(await fetchJson(url)),
        sourceLabel: locator.sourceLabel,
        sourceUrl: url
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unable to load the proof bundle from IPFS/Filecoin.");
    }
  }
  throw lastError ?? new Error("Unable to load the proof bundle from IPFS/Filecoin.");
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(preferSameOriginIpfsGatewayUrl(url));
  if (!response.ok) {
    throw new Error(`Unable to load the proof bundle (${response.status}).`);
  }
  return response.json();
}

function unwrapProofPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  return record.proofBundle ?? record.walletProofBundle ?? record;
}

async function hydrateProofBundle(payload: unknown): Promise<Record<string, unknown> | unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = unwrapProofPayload(payload) as Record<string, unknown>;
  const linkedProofs = readLinkedProofs(record);
  if (!linkedProofs.length) return record;

  const resolvedProofEntries = (
    await Promise.all(
      linkedProofs.map(async (entry) => {
        const locator = locatorFromObject(entry);
        if (!locator) return [];
        const resolved = await resolveReviewLocator(locator);
        return readProofArray(resolved.payload) ?? [unwrapProofPayload(resolved.payload)];
      })
    )
  ).flat();

  return {
    ...record,
    proofs: [...(readProofArray(record) ?? []), ...resolvedProofEntries]
  };
}

function hasInlineProofs(payload: unknown): boolean {
  return Array.isArray(readProofArray(payload));
}

function readProofArray(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const proofArrays = [record.proofs, record.proofCertificates, record.certificates, record.claims, record.p];
  return proofArrays.find(Array.isArray);
}

function readLinkedProofs(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const linkedProofArrays = [payload.linkedProofs, payload.proofLinks];
  const firstArray = linkedProofArrays.find(Array.isArray);
  if (!firstArray) return [];
  return firstArray.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
}

function readBundleTitle(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const wallet =
    record.wallet && typeof record.wallet === "object" ? (record.wallet as Record<string, unknown>) : undefined;
  const compactWallet = record.w && typeof record.w === "object" ? (record.w as Record<string, unknown>) : undefined;
  return firstString(record.title, record.name, record.t, wallet?.title, wallet?.name, wallet?.label, compactWallet?.l);
}

function readWalletSummary(payload: unknown): WalletProofQrReview["wallet"] {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const wallet =
    record.wallet && typeof record.wallet === "object" ? (record.wallet as Record<string, unknown>) : undefined;
  const compactWallet = record.w && typeof record.w === "object" ? (record.w as Record<string, unknown>) : undefined;
  const id = firstString(wallet?.id, wallet?.walletId, compactWallet?.i, record.walletId);
  const actorDid = firstString(wallet?.actorDid, wallet?.actor_did, compactWallet?.a, record.actorDid);
  const label = firstString(wallet?.label, wallet?.name, compactWallet?.l);
  if (!id && !actorDid && !label) return undefined;
  return { actorDid, id, label };
}

function normalizeEncryptedRecords(payload: unknown): WalletEncryptedRecordLink[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = [record.encryptedRecords, record.encrypted_records, record.records, record.r].find(Array.isArray);
  if (!candidates) return [];
  return candidates.map(normalizeEncryptedRecord).filter((item): item is WalletEncryptedRecordLink => Boolean(item));
}

function normalizeEncryptedRecord(value: unknown): WalletEncryptedRecordLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const root = normalizeIpldRoot(record.root);
  const cid = firstString(record.cid, record.ipfsCid, record["/"], root?.["/"]);
  if (!cid) return undefined;
  const links = Array.isArray(record.links)
    ? record.links.map(normalizeIpldLink).filter((link): link is WalletIpldLink => Boolean(link))
    : [];
  return {
    cid,
    fileName: firstString(record.fileName, record.file_name, record.name),
    links,
    recordId: firstString(record.recordId, record.record_id, record.id),
    root,
    versionId: firstString(record.versionId, record.version_id)
  };
}

function normalizeIpldRoot(value: unknown): { "/": string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cid = firstString((value as Record<string, unknown>)["/"], (value as Record<string, unknown>).cid);
  return cid ? { "/": cid } : undefined;
}

function normalizeIpldLink(value: unknown): WalletIpldLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const cid = firstString(record["/"], record.cid, record.ipfsCid);
  const name = firstString(record.name, record.rel, record.type) || (cid ? "linked_cid" : "");
  if (!cid || !name) return undefined;
  return {
    "/": cid,
    cid,
    mediaType: firstString(record.mediaType, record.media_type, record.contentType),
    name
  };
}

function normalizeProofs(payload: unknown): ProofReceiptView[] {
  const proofArray = readProofArray(payload);
  if (!proofArray) return [];
  return proofArray.map(normalizeProof).filter((proof): proof is ProofReceiptView => Boolean(proof));
}

function normalizeProof(proof: unknown): ProofReceiptView | undefined {
  if (!proof || typeof proof !== "object") return undefined;
  const record = proof as Record<string, unknown>;
  const proofType = sanitizeProofDisplayString(
    firstString(record.proofType, record.proof_type, record.certificateType, record.type, record.pt) || "wallet_proof"
  ) || "wallet_proof";
  const publicInputs = normalizePublicInputs(
    proofType,
    record.publicInputs,
    record.public_inputs,
    record.disclosedClaims,
    record.disclosed_claims,
    record.statement,
    record.u
  );
  const claim =
    sanitizeProofDisplayString(
      firstString(record.claim, record.c, publicInputs.claim, objectString(record.statement, "claim"), record.title, record.name)
    ) ||
    proofType ||
    "Verified claim";
  const witnessRecordIds = Array.isArray(record.witness_record_ids)
    ? record.witness_record_ids
        .filter((value): value is string => typeof value === "string")
        .map(sanitizeProofDisplayString)
        .filter(Boolean)
    : [];

  return {
    id:
      sanitizeProofDisplayString(
        firstString(record.id, record.proofId, record.proof_id, record.certificateId, record.certificate_id, record.i)
      ) || claim,
    proofType,
    claim,
    verifier:
      sanitizeProofDisplayString(
        firstString(record.verifier, record.verifierId, record.verifier_id, record.issuer, record.issuedBy, record.issuerDid, record.v)
      ) ||
      "Wallet verifier",
    proofSystem: sanitizeProofDisplayString(firstString(record.proofSystem, record.proof_system, record.system, record.ps)) || "linked bundle",
    verificationStatus: sanitizeProofDisplayString(firstString(record.verificationStatus, record.verification_status, record.status, record.vs)) || "verified",
    circuitId: sanitizeProofDisplayString(firstString(record.circuitId, record.circuit_id)),
    verifierDigest: sanitizeProofDisplayString(firstString(record.verifierDigest, record.verifier_digest)),
    proofArtifactRef: sanitizeProofDisplayString(
      firstString(record.proofArtifactRef, record.proof_artifact_ref, record.artifactRef, record.ipfsCid, record.cid)
    ),
    publicInputs,
    witnessLabel:
      sanitizeProofDisplayString(firstString(record.witnessLabel, record.witness_label, record.sourceLabel, record.source_label, record.w)) ||
      witnessRecordIds.join(", ") ||
      "Wallet witness",
    simulated: Boolean(record.simulated ?? record.is_simulated),
    createdAt:
      sanitizeProofDisplayString(firstString(record.createdAt, record.created_at, record.issuedAt, record.issued_at)) ||
      "Reviewed from QR"
  };
}

function normalizePublicInputs(proofType: string, ...values: Array<unknown>): Record<string, string> {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    return sanitizePublicProofInputs(proofType, record);
  }
  return {};
}

function sanitizeProofViewForBundle(proof: ProofReceiptView): Record<string, unknown> {
  const proofType = sanitizeProofDisplayString(proof.proofType) || "wallet_proof";
  return omitUndefinedValues({
    claim: sanitizeProofDisplayString(proof.claim),
    createdAt: sanitizeProofDisplayString(proof.createdAt),
    id: sanitizeProofDisplayString(proof.id),
    proofArtifactRef: sanitizeProofDisplayString(proof.proofArtifactRef),
    proofSystem: sanitizeProofDisplayString(proof.proofSystem),
    proofType,
    publicInputs: sanitizePublicProofInputs(proofType, proof.publicInputs),
    simulated: proof.simulated,
    verificationStatus: sanitizeProofDisplayString(proof.verificationStatus),
    verifier: sanitizeProofDisplayString(proof.verifier),
    verifierDigest: sanitizeProofDisplayString(proof.verifierDigest),
    witnessLabel: sanitizeProofDisplayString(proof.witnessLabel)
  });
}

function sanitizePublicProofInputs(proofType: string, record: Record<string, unknown>): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(record)) {
    if (key.toLowerCase() === "nullifier_ref" && "nullifier_commitment" in record) continue;
    const normalizedKey = normalizePublicInputKey(proofType, key);
    if (!normalizedKey) continue;
    const value = stringifyPublicProofValue(entry);
    if (value) entries.push([normalizedKey, value]);
  }
  return Object.fromEntries(entries);
}

function normalizePublicInputKey(proofType: string, key: string): string | undefined {
  const normalizedKey = key.trim();
  const lowered = normalizedKey.toLowerCase();
  if (lowered === "nullifier_ref") {
    return proofType === worldIdProofType ? "nullifier_commitment" : undefined;
  }
  if (lowered === "nullifier_commitment") return normalizedKey;
  if (privateProofMetadataKey(normalizedKey)) return undefined;
  return normalizedKey;
}

function stringifyPublicProofValue(value: unknown): string {
  if (typeof value === "string") {
    const commitment = value.startsWith(worldIdNullifierRefPrefix)
      ? `hmac-sha256:${value.slice(worldIdNullifierRefPrefix.length)}`
      : value;
    return sanitizeProofDisplayString(commitment) || "";
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(stringifyPublicProofValue).filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") {
    const nested = sanitizePublicProofRecord(value as Record<string, unknown>);
    const nestedClaim = objectString(nested, "claim");
    if (nestedClaim) return sanitizeProofDisplayString(nestedClaim) || "";
    if (!Object.keys(nested).length) return "";
    try {
      return sanitizeProofDisplayString(JSON.stringify(nested)) || "";
    } catch {
      return "";
    }
  }
  return "";
}

function sanitizePublicProofRecord(record: Record<string, unknown>): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (privateProofMetadataKey(key)) continue;
    if (typeof value === "string") {
      const safeValue = sanitizeProofDisplayString(value);
      if (safeValue) entries.push([key, safeValue]);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      entries.push([key, value]);
      continue;
    }
    if (Array.isArray(value)) {
      const safeItems = value
        .map((item) => {
          if (item && typeof item === "object") return sanitizePublicProofRecord(item as Record<string, unknown>);
          return sanitizeProofDisplayString(item);
        })
        .filter((item) => (typeof item === "object" ? Object.keys(item).length > 0 : Boolean(item)));
      if (safeItems.length) entries.push([key, safeItems]);
      continue;
    }
    if (value && typeof value === "object") {
      const safeRecord = sanitizePublicProofRecord(value as Record<string, unknown>);
      if (Object.keys(safeRecord).length) entries.push([key, safeRecord]);
    }
  }
  return Object.fromEntries(entries);
}

function privateProofMetadataKey(key: string): boolean {
  const lowered = key.toLowerCase();
  if (["proof_hash", "proof_id", "proof_system", "proof_type", "proof_artifact_ref"].includes(lowered)) return false;
  if (["nullifier", "proof"].includes(lowered)) return true;
  return privateProofMetadataKeyPattern.test(lowered);
}

function sanitizeProofDisplayString(value: unknown): string | undefined {
  const text = firstString(value);
  if (!text) return undefined;
  if (privateProofValuePatterns.some((pattern) => pattern.test(text))) return undefined;
  if (piiValuePatterns.some((pattern) => pattern.test(text))) return undefined;
  return text;
}

function omitUndefinedValues(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ""));
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeCid(value: string): string {
  return value.replace(/^ipfs:\/\//, "").replace(/^\/?ipfs\//, "");
}

function cidFromUrl(urlValue: string): string | undefined {
  try {
    const url = new URL(urlValue, currentBaseUrl());
    const hostParts = url.hostname.split(".");
    if (hostParts.length >= 3 && hostParts[1] === "ipfs" && cidPattern.test(hostParts[0])) {
      return normalizeCid(hostParts[0]);
    }
    const pathMatch = url.pathname.match(/^\/ipfs\/([^/?#]+)/i);
    if (pathMatch?.[1] && cidPattern.test(pathMatch[1])) {
      return normalizeCid(pathMatch[1]);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseProofArtifactLocator(value: string | undefined): ProofArtifactLocator | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) {
    const cid = cidFromUrl(value);
    return cid ? { cid } : { url: value };
  }
  if (/^ipfs:\/\//i.test(value) || /^\/?ipfs\//i.test(value) || cidPattern.test(value)) {
    return { cid: normalizeCid(value) };
  }
  return undefined;
}

function defaultIpfsGateways(): string[] {
  return Array.from(
    new Set([
      new URL("/ipfs-proxy/", currentBaseUrl()).toString(),
    ])
  );
}

function preferSameOriginIpfsGatewayUrl(url: string): string {
  const cid = cidFromUrl(url);
  return cid ? new URL(`/ipfs-proxy/${cid}`, currentBaseUrl()).toString() : url;
}

function labelForUrl(url: string): string {
  return /\/ipfs\//i.test(url) || /^ipfs:\/\//i.test(url) ? "IPFS/Filecoin proof bundle" : "Wallet proof bundle link";
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return firstString((value as Record<string, unknown>)[key]);
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function currentBaseUrl(): string {
  if (typeof window === "undefined") {
    return "http://localhost/";
  }
  return `${window.location.origin}${window.location.pathname}`;
}
