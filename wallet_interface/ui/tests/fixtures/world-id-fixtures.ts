import type { ProofReceiptView } from "../../src/models/abby";
import type {
  WorldIdBinding,
  WorldIdIdkitPayload,
  WorldIdRpSignatureResponse,
  WorldIdVerificationResponse,
  WorldIdWalletConfig,
  WorldIdWalletStatus
} from "../../src/services/walletApi";

export type WorldIdFixtureKey =
  | "disabled"
  | "missing-config"
  | "unverified"
  | "verified"
  | "conflict"
  | "revoked"
  | "sanitizer-sentinel";

export type WorldIdWorkflowSurface =
  | "proof-center"
  | "wallet-uploads"
  | "register-intake"
  | "security"
  | "qr-proof-review"
  | "export-import";

export interface WorldIdFixtureScenario {
  key: WorldIdFixtureKey;
  coverageSurfaces: WorldIdWorkflowSurface[];
  config: WorldIdWalletConfig;
  status: WorldIdWalletStatus;
  rpSignature?: WorldIdRpSignatureResponse;
  idkitPayload?: WorldIdIdkitPayload;
  verificationResponse?: WorldIdVerificationResponse;
  proofReceipt?: ProofReceiptView;
  apiError?: {
    status: 400 | 401 | 409 | 422 | 503;
    detail: string;
    code: "disabled" | "missing_config" | "unauthorized" | "nullifier_conflict" | "verification_failed";
  };
  expectedLabel: string;
  privacyAssertion: string;
}

export const WORLD_ID_WALLET_ID = "wallet-world-id-ui";
export const WORLD_ID_ACTOR_DID = "did:key:world-id-ui-owner";
export const WORLD_ID_OTHER_WALLET_ID = "wallet-world-id-conflict";
export const WORLD_ID_ACTION = "wallet-attach-world-id-v1";
export const WORLD_ID_RP_ID = "rp_world_id_ui";
export const WORLD_ID_APP_ID = "app_staging_world_id_ui";
export const WORLD_ID_VERIFIED_AT = "2026-06-14T16:00:00.000Z";

export const WORLD_ID_PRIVATE_SENTINELS = {
  rawNullifier: "WORLD_ID_RAW_NULLIFIER_DO_NOT_RENDER_7f3c",
  legacyNullifierHash: "0xWORLD_ID_LEGACY_NULLIFIER_HASH_DO_NOT_RENDER",
  idkitProof: "WORLD_ID_IDKIT_PROOF_DO_NOT_RENDER_9d2a",
  merkleRoot: "WORLD_ID_MERKLE_ROOT_DO_NOT_RENDER_4c11",
  rpSignature: "WORLD_ID_RP_SIGNATURE_DO_NOT_RENDER_83be",
  developerPortalResponse: "WORLD_ID_DEVELOPER_PORTAL_RESPONSE_DO_NOT_RENDER",
  legalName: "World Id Private Test User",
  phone: "+1-503-555-0199",
  email: "worldid-private-test@example.invalid",
  preciseAddress: "211 Private Nullifier Ave Apt 4"
} as const;

export const worldIdForbiddenPrivateTokens = Object.values(WORLD_ID_PRIVATE_SENTINELS);

export function buildWorldIdConfig(overrides: Partial<WorldIdWalletConfig> = {}): WorldIdWalletConfig {
  return {
    enabled: true,
    environment: "staging",
    app_id: WORLD_ID_APP_ID,
    rp_id: WORLD_ID_RP_ID,
    allowed_actions: [WORLD_ID_ACTION, "provider-staff-world-id-v1"],
    default_action: WORLD_ID_ACTION,
    credential_policy: "proof_of_human",
    allow_legacy_proofs: false,
    require_user_presence: true,
    rp_signature_ttl_seconds: 300,
    verify_base_url: "https://developer.world.org",
    http_timeout_seconds: 5,
    ...overrides
  };
}

export function buildWorldIdBinding(overrides: Partial<WorldIdBinding> = {}): WorldIdBinding {
  return {
    binding_id: "world-id-binding-ui",
    wallet_id: WORLD_ID_WALLET_ID,
    actor_did: WORLD_ID_ACTOR_DID,
    rp_id: WORLD_ID_RP_ID,
    action: WORLD_ID_ACTION,
    protocol_version: "v4",
    environment: "staging",
    nullifier_ref: "worldid-nullifier-ref:v1:hmac-sha256-public-commitment",
    app_id: WORLD_ID_APP_ID,
    credential_identifiers: ["orb"],
    issuer_schema_ids: [1],
    proof_receipt_id: "proof-world-id-human-ui",
    session_id: "world-id-session-ui",
    signal_hash_ref: "sha256:world-id-signal-public-commitment",
    verification_status: "verified",
    status: "active",
    verified_at: WORLD_ID_VERIFIED_AT,
    created_at: WORLD_ID_VERIFIED_AT,
    updated_at: WORLD_ID_VERIFIED_AT,
    metadata: {
      credential_policy: "proof_of_human",
      privacy: "public commitments only"
    },
    ...overrides
  };
}

export function buildWorldIdStatus({
  verified = false,
  bindings = verified ? [buildWorldIdBinding()] : [],
  overrides = {}
}: {
  verified?: boolean;
  bindings?: WorldIdBinding[];
  overrides?: Partial<WorldIdWalletStatus>;
} = {}): WorldIdWalletStatus {
  const config = buildWorldIdConfig();
  return {
    enabled: config.enabled,
    environment: config.environment,
    app_id: config.app_id,
    rp_id: config.rp_id,
    allowed_actions: config.allowed_actions,
    default_action: config.default_action,
    credential_policy: config.credential_policy,
    configured: {
      nullifier_hmac_key: true,
      rp_signing_key: true
    },
    wallet: {
      active_binding_count: bindings.filter((binding) => binding.status === "active").length,
      binding_count: bindings.length,
      bindings,
      wallet_id: WORLD_ID_WALLET_ID
    },
    ...overrides
  };
}

export function buildWorldIdRpSignature(
  overrides: Partial<WorldIdRpSignatureResponse> = {}
): WorldIdRpSignatureResponse {
  return {
    rp_id: WORLD_ID_RP_ID,
    sig: WORLD_ID_PRIVATE_SENTINELS.rpSignature,
    signature: WORLD_ID_PRIVATE_SENTINELS.rpSignature,
    nonce: "nonce-world-id-ui",
    created_at: 1_781_435_200,
    expires_at: 1_781_435_500,
    action: WORLD_ID_ACTION,
    ...overrides
  };
}

export function buildWorldIdIdkitPayload(overrides: WorldIdIdkitPayload = {}): WorldIdIdkitPayload {
  return {
    merkle_root: WORLD_ID_PRIVATE_SENTINELS.merkleRoot,
    nullifier_hash: WORLD_ID_PRIVATE_SENTINELS.rawNullifier,
    proof: WORLD_ID_PRIVATE_SENTINELS.idkitProof,
    verification_level: "orb",
    action: WORLD_ID_ACTION,
    signal: `211-ai:wallet-world-id:v1:${WORLD_ID_WALLET_ID}:${WORLD_ID_ACTOR_DID}`,
    ...overrides
  };
}

export const worldIdApiProofReceipt = {
  proof_id: "proof-world-id-human-ui",
  wallet_id: WORLD_ID_WALLET_ID,
  proof_type: "world_id_proof_of_human",
  statement: {
    claim: "wallet_actor_has_world_id_proof_of_human",
    wallet_id: WORLD_ID_WALLET_ID,
    action: WORLD_ID_ACTION,
    credential_policy: "proof_of_human"
  },
  verifier_id: `world-developer-portal-v4:${WORLD_ID_RP_ID}`,
  public_inputs: {
    claim: "World ID proof of human is bound to this wallet",
    rp_id: WORLD_ID_RP_ID,
    app_id: WORLD_ID_APP_ID,
    action: WORLD_ID_ACTION,
    signal_hash: "sha256:world-id-signal-public-commitment",
    credential_policy: "proof_of_human",
    nullifier_commitment: "hmac-sha256:nullifier-public-commitment",
    verification_result_hash: "sha256:developer-portal-result-public-commitment"
  },
  proof_hash: "sha256:world-id-proof-public-commitment",
  witness_record_ids: [`wallet://${WORLD_ID_WALLET_ID}/world-id-binding/world-id-binding-ui`],
  is_simulated: false,
  proof_system: "world_id_idkit_v4",
  circuit_id: "world-id-proof-of-human-v4",
  verifier_digest: "sha256:world-id-verifier-digest",
  proof_artifact_ref: "world-id-proof://proof-world-id-human-ui",
  verification_status: "verified",
  created_at: WORLD_ID_VERIFIED_AT
};

export const worldIdProofReceiptView: ProofReceiptView = {
  id: worldIdApiProofReceipt.proof_id,
  proofType: worldIdApiProofReceipt.proof_type,
  claim: worldIdApiProofReceipt.public_inputs.claim,
  verifier: worldIdApiProofReceipt.verifier_id,
  proofSystem: worldIdApiProofReceipt.proof_system,
  verificationStatus: worldIdApiProofReceipt.verification_status,
  circuitId: worldIdApiProofReceipt.circuit_id,
  verifierDigest: worldIdApiProofReceipt.verifier_digest,
  proofArtifactRef: worldIdApiProofReceipt.proof_artifact_ref,
  publicInputs: worldIdApiProofReceipt.public_inputs,
  witnessLabel: "World ID proof-of-human binding",
  simulated: worldIdApiProofReceipt.is_simulated,
  createdAt: worldIdApiProofReceipt.created_at
};

export function buildWorldIdVerificationResponse(
  overrides: Partial<WorldIdVerificationResponse> = {}
): WorldIdVerificationResponse {
  return {
    binding: buildWorldIdBinding(),
    proof: worldIdProofReceiptView,
    verification: {
      success: true,
      action: WORLD_ID_ACTION,
      nullifier: "[redacted]",
      created_at: WORLD_ID_VERIFIED_AT,
      environment: "staging",
      session_id: "world-id-session-ui",
      message: "verified"
    },
    ...overrides
  };
}

export const worldIdSanitizedQrProofBundle = {
  schema_version: "211-ai-wallet-proof-qr-v1",
  wallet_id: WORLD_ID_WALLET_ID,
  proof: worldIdApiProofReceipt,
  binding: {
    binding_id: "world-id-binding-ui",
    nullifier_ref: "worldid-nullifier-ref:v1:hmac-sha256-public-commitment",
    action: WORLD_ID_ACTION,
    credential_policy: "proof_of_human",
    status: "active"
  },
  privacy: {
    raw_nullifier: "[redacted]",
    idkit_proof: "[redacted]",
    developer_portal_response: "[redacted]"
  }
};

export const worldIdSanitizedExportReview = {
  bundle_id: "export-world-id-ui",
  wallet_id: WORLD_ID_WALLET_ID,
  proof_count: 1,
  proofs: [worldIdApiProofReceipt],
  world_id: {
    binding_count: 1,
    active_binding_count: 1,
    nullifier_refs: ["worldid-nullifier-ref:v1:hmac-sha256-public-commitment"]
  },
  verification: {
    hash_ok: true,
    schema_ok: true,
    storage_ok: true
  }
};

export const worldIdFixtureScenarios: Record<WorldIdFixtureKey, WorldIdFixtureScenario> = {
  disabled: {
    key: "disabled",
    coverageSurfaces: ["proof-center", "wallet-uploads", "register-intake", "security"],
    config: buildWorldIdConfig({ enabled: false, app_id: "" }),
    status: buildWorldIdStatus({ verified: false, overrides: { enabled: false, app_id: "" } }),
    apiError: {
      status: 503,
      detail: "World ID is not enabled for this wallet API deployment.",
      code: "disabled"
    },
    expectedLabel: "World ID unavailable",
    privacyAssertion: "Disabled state exposes configuration status only."
  },
  "missing-config": {
    key: "missing-config",
    coverageSurfaces: ["proof-center", "register-intake"],
    config: buildWorldIdConfig({ enabled: true, app_id: "", rp_id: "" }),
    status: buildWorldIdStatus({ verified: false, overrides: { app_id: "", rp_id: "" } }),
    apiError: {
      status: 503,
      detail: "World ID app_id or rp_id is missing.",
      code: "missing_config"
    },
    expectedLabel: "World ID configuration needed",
    privacyAssertion: "Missing config errors do not include secrets or IDKit payloads."
  },
  unverified: {
    key: "unverified",
    coverageSurfaces: ["proof-center", "wallet-uploads", "register-intake", "security"],
    config: buildWorldIdConfig(),
    status: buildWorldIdStatus({ verified: false }),
    rpSignature: buildWorldIdRpSignature(),
    idkitPayload: buildWorldIdIdkitPayload(),
    expectedLabel: "World ID unverified",
    privacyAssertion: "Launch state can carry RP signature in memory but must not render it."
  },
  verified: {
    key: "verified",
    coverageSurfaces: ["proof-center", "wallet-uploads", "register-intake", "security", "qr-proof-review", "export-import"],
    config: buildWorldIdConfig(),
    status: buildWorldIdStatus({ verified: true }),
    rpSignature: buildWorldIdRpSignature(),
    idkitPayload: buildWorldIdIdkitPayload(),
    verificationResponse: buildWorldIdVerificationResponse(),
    proofReceipt: worldIdProofReceiptView,
    expectedLabel: "World ID verified",
    privacyAssertion: "Verified UI renders public commitments and proof receipt ids only."
  },
  conflict: {
    key: "conflict",
    coverageSurfaces: ["proof-center", "security"],
    config: buildWorldIdConfig(),
    status: buildWorldIdStatus({ verified: false }),
    rpSignature: buildWorldIdRpSignature(),
    idkitPayload: buildWorldIdIdkitPayload(),
    apiError: {
      status: 409,
      detail: "World ID nullifier is already bound to another wallet.",
      code: "nullifier_conflict"
    },
    expectedLabel: "Already linked to another wallet",
    privacyAssertion: "Conflict state exposes no raw nullifier or other wallet PII."
  },
  revoked: {
    key: "revoked",
    coverageSurfaces: ["security", "proof-center", "export-import"],
    config: buildWorldIdConfig(),
    status: buildWorldIdStatus({
      verified: false,
      bindings: [
        buildWorldIdBinding({
          status: "revoked",
          verification_status: "revoked",
          updated_at: "2026-06-14T17:00:00.000Z",
          metadata: { revoke_reason: "user disconnected" }
        })
      ]
    }),
    expectedLabel: "World ID revoked",
    privacyAssertion: "Revoked state keeps prior public proof metadata but hides private proof material."
  },
  "sanitizer-sentinel": {
    key: "sanitizer-sentinel",
    coverageSurfaces: ["qr-proof-review", "export-import"],
    config: buildWorldIdConfig(),
    status: buildWorldIdStatus({ verified: true }),
    idkitPayload: buildWorldIdIdkitPayload({
      user: {
        name: WORLD_ID_PRIVATE_SENTINELS.legalName,
        phone: WORLD_ID_PRIVATE_SENTINELS.phone,
        email: WORLD_ID_PRIVATE_SENTINELS.email,
        address: WORLD_ID_PRIVATE_SENTINELS.preciseAddress
      },
      developer_portal_response: WORLD_ID_PRIVATE_SENTINELS.developerPortalResponse
    }),
    verificationResponse: buildWorldIdVerificationResponse(),
    proofReceipt: worldIdProofReceiptView,
    expectedLabel: "Sanitized World ID proof",
    privacyAssertion: "Sanitizer sentinel strings are absent from QR proof and export review."
  }
};

export function stringifyWorldIdFixture(value: unknown): string {
  return JSON.stringify(value, Object.keys(flattenObjectKeys(value)).sort(), 2);
}

export function collectForbiddenWorldIdTokens(text: string): string[] {
  return worldIdForbiddenPrivateTokens.filter((token) => text.includes(token));
}

function flattenObjectKeys(value: unknown, keys: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) flattenObjectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      keys[key] = true;
      flattenObjectKeys(item, keys);
    }
  }
  return keys;
}
