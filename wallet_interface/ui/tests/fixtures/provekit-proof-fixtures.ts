import type { ProofReceiptView } from "../../src/models/abby";

export type ProveKitProofFixtureKey =
  | "simulated"
  | "groth16"
  | "provekitWhir"
  | "recursive"
  | "disabled"
  | "unavailable"
  | "artifactHashMismatch"
  | "staleVerifierKey"
  | "verificationFailure"
  | "witnessSentinel";

export type ProveKitProofFixtureCoverageSurface =
  | "proof-center"
  | "wallet-uploads"
  | "qr-review"
  | "security-audit"
  | "provider-proofs"
  | "public-analytics"
  | "export-import";

export interface ProveKitProofFixtureApiReceipt {
  proof_id: string;
  proof_type: string;
  statement?: Record<string, unknown>;
  verifier_id: string;
  public_inputs: Record<string, unknown>;
  proof_hash: string;
  witness_record_ids: string[];
  is_simulated: boolean;
  proof_system?: string;
  circuit_id?: string | null;
  verifier_digest?: string | null;
  proof_artifact_ref?: string | null;
  verification_status?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
  wallet_id?: string;
  witness_label?: string;
}

export interface ProveKitProofFixtureApiError {
  code:
    | "provekit_backend_disabled"
    | "provekit_backend_unavailable"
    | "artifact_hash_mismatch"
    | "stale_verifier_key"
    | "verification_failure";
  detail: string;
  status: number;
}

export interface ProveKitProofFixtureScenario {
  apiError?: ProveKitProofFixtureApiError;
  apiReceipt?: ProveKitProofFixtureApiReceipt;
  coverageSurfaces: ProveKitProofFixtureCoverageSurface[];
  expectedLabel: string;
  key: ProveKitProofFixtureKey;
  manualFallback: boolean;
  onChainReady: boolean;
  privacyAssertion: string;
  proofSystem: string;
  uiReceipt?: ProofReceiptView;
}

const walletId = "wallet-provekit-ui";
const actorDid = "did:key:provekit-ui-owner";
const verifiedAt = "2026-06-14T09:00:00.000Z";

const theoremHash = "1".repeat(64);
const axiomsCommitment = "2".repeat(64);
const attestationRef = "3".repeat(64);
const verifierDigest = "4".repeat(64);
const recursiveVerifierDigest = "5".repeat(64);
const artifactManifestDigest = "6".repeat(64);
const staleVerifierDigest = "7".repeat(64);
const currentVerifierDigest = "8".repeat(64);
const proofHash = "9".repeat(64);

export const PROVEKIT_PRIVATE_WITNESS_SENTINEL = "PRIVATE_WITNESS_SENTINEL_TDFOL_AXIOM_DO_NOT_RENDER";

export const provekitForbiddenWitnessTokens = [
  PROVEKIT_PRIVATE_WITNESS_SENTINEL,
  "Prover.toml",
  "witness_theorem_hash_field",
  "private_axiom_text",
  "prover_key_path",
  "pkp_path"
];

const commonProveKitPublicInputs = {
  theorem: "eligible_for_housing_support(abby)",
  theorem_hash: theoremHash,
  axioms_commitment: axiomsCommitment,
  circuit_ref: "provekit_knowledge_of_axioms@v1",
  circuit_version: 1,
  ruleset_id: "TDFOL_v1",
  compiler_guidance_ref: "a".repeat(64),
  compiler_guidance_version: 1,
  attestation_ref: attestationRef,
  attestation_view_version: 1
};

const commonProveKitMetadata = {
  backend: "provekit",
  proof_system: "ProveKit-WHIR",
  provekit_branch: "v1",
  provekit_commit: "provekit-v1-fixture-commit",
  hash_backend: "sha256",
  pkv_sha256: verifierDigest,
  noir_package_hash: artifactManifestDigest,
  artifact_manifest_sha256: artifactManifestDigest,
  cache_status: "miss",
  public_artifact_refs: {
    proof: "ipfs://bafyprovekitwhirfixture/proof.np",
    verifier_key: "ipfs://bafyprovekitwhirfixture/verification-key.pkv",
    manifest: "ipfs://bafyprovekitwhirfixture/provekit-artifacts.json"
  }
};

const simulatedApiReceipt: ProveKitProofFixtureApiReceipt = {
  proof_id: "proof-fixture-simulated",
  proof_type: "location_region",
  statement: {
    claim: "location_in_region",
    region_id: "multnomah_county"
  },
  verifier_id: "simulated-location-region-verifier",
  public_inputs: {
    claim: "location_in_region",
    region_id: "multnomah_county",
    region_policy_hash: "c".repeat(64)
  },
  proof_hash: "simulated-proof-hash",
  witness_record_ids: [`wallet://${walletId}/records/rec-location-current`],
  is_simulated: true,
  proof_system: "simulated",
  circuit_id: "simulated_location_region@v1",
  verifier_digest: null,
  proof_artifact_ref: null,
  verification_status: "demo_only",
  created_at: verifiedAt,
  metadata: {
    production_evidence: false,
    warning: "Simulated proof fixture; never count as production ProveKit evidence."
  },
  wallet_id: walletId
};

const groth16ApiReceipt: ProveKitProofFixtureApiReceipt = {
  proof_id: "proof-fixture-groth16",
  proof_type: "income_eligibility",
  statement: {
    claim: "income_eligible",
    program: "rapid_rehousing"
  },
  verifier_id: "groth16-income-eligibility-v1",
  public_inputs: {
    claim: "income_eligible",
    program: "rapid_rehousing",
    threshold_commitment: "d".repeat(64)
  },
  proof_hash: "groth16-proof-hash",
  witness_record_ids: [`wallet://${walletId}/records/rec-income-commitment`],
  is_simulated: false,
  proof_system: "Groth16/BN254",
  circuit_id: "income_eligibility_groth16@v1",
  verifier_digest: "e".repeat(64),
  proof_artifact_ref: "ipfs://bafygroth16fixture/proof.g16",
  verification_status: "verified",
  created_at: verifiedAt,
  metadata: {
    backend: "groth16",
    curve_id: "bn254",
    production_evidence: true,
    trusted_setup_ref: "ipfs://bafygroth16fixture/setup-digest-only"
  },
  wallet_id: walletId
};

const provekitWhirApiReceipt: ProveKitProofFixtureApiReceipt = {
  proof_id: "proof-fixture-provekit-whir",
  proof_type: "provider_eligibility",
  statement: {
    claim: "eligible_for_housing_support",
    circuit_ref: "provekit_knowledge_of_axioms@v1"
  },
  verifier_id: "provekit-whir-eligibility-v1",
  public_inputs: commonProveKitPublicInputs,
  proof_hash: proofHash,
  witness_record_ids: [`wallet://${walletId}/records/rec-eligibility-commitment`],
  is_simulated: false,
  proof_system: "ProveKit-WHIR",
  circuit_id: "provekit_knowledge_of_axioms@v1",
  verifier_digest: verifierDigest,
  proof_artifact_ref: "ipfs://bafyprovekitwhirfixture/proof.np",
  verification_status: "verified",
  created_at: verifiedAt,
  metadata: commonProveKitMetadata,
  wallet_id: walletId
};

const recursiveApiReceipt: ProveKitProofFixtureApiReceipt = {
  proof_id: "proof-fixture-recursive",
  proof_type: "on_chain_provider_certificate",
  statement: {
    claim: "inner_provekit_whir_verified",
    wrapper: "groth16"
  },
  verifier_id: "provekit-recursive-groth16-wrapper-v1",
  public_inputs: {
    ...commonProveKitPublicInputs,
    circuit_ref: "provekit_recursive_groth16_wrapper@v1",
    recursive_wrapper: "groth16_bn254",
    inner_proof_system: "ProveKit-WHIR",
    on_chain_verifier_ref: "eip155:1:0x0000000000000000000000000000000000002300"
  },
  proof_hash: "recursive-proof-hash",
  witness_record_ids: [`wallet://${walletId}/records/rec-provider-certificate`],
  is_simulated: false,
  proof_system: "ProveKit-recursive-Groth16",
  circuit_id: "provekit_recursive_groth16_wrapper@v1",
  verifier_digest: recursiveVerifierDigest,
  proof_artifact_ref: "ipfs://bafyprovekitrecursivefixture/proof.g16",
  verification_status: "verified",
  created_at: verifiedAt,
  metadata: {
    backend: "provekit_recursive_groth16",
    inner_backend: "provekit",
    inner_proof_system: "ProveKit-WHIR",
    outer_proof_system: "Groth16/BN254",
    on_chain_ready: true,
    wrapper_verifier_digest: recursiveVerifierDigest
  },
  wallet_id: walletId
};

const artifactHashMismatchApiReceipt: ProveKitProofFixtureApiReceipt = {
  ...provekitWhirApiReceipt,
  proof_id: "proof-fixture-artifact-hash-mismatch",
  proof_hash: "artifact-mismatch-proof-hash",
  verifier_id: "provekit-whir-artifact-integrity-v1",
  verification_status: "artifact_hash_mismatch",
  metadata: {
    ...commonProveKitMetadata,
    cache_status: "invalidated",
    expected_artifact_manifest_sha256: artifactManifestDigest,
    observed_artifact_manifest_sha256: "b".repeat(64)
  }
};

const staleVerifierKeyApiReceipt: ProveKitProofFixtureApiReceipt = {
  ...provekitWhirApiReceipt,
  proof_id: "proof-fixture-stale-verifier-key",
  proof_hash: "stale-verifier-key-proof-hash",
  verifier_id: "provekit-whir-stale-verifier-v1",
  verifier_digest: staleVerifierDigest,
  verification_status: "stale_verifier_key",
  metadata: {
    ...commonProveKitMetadata,
    cache_status: "stale",
    receipt_pkv_sha256: staleVerifierDigest,
    current_pkv_sha256: currentVerifierDigest,
    rotation_required: true
  }
};

const unavailableApiReceipt: ProveKitProofFixtureApiReceipt = {
  ...provekitWhirApiReceipt,
  proof_id: "proof-fixture-backend-unavailable",
  proof_hash: "backend-unavailable-proof-hash",
  verifier_id: "provekit-whir-unavailable-v1",
  verification_status: "provekit_backend_unavailable",
  metadata: {
    ...commonProveKitMetadata,
    cache_status: "unavailable",
    sanitized_error: "ProveKit verifier is unavailable; no private witness material was exported."
  }
};

const verificationFailureApiReceipt: ProveKitProofFixtureApiReceipt = {
  ...provekitWhirApiReceipt,
  proof_id: "proof-fixture-verification-failure",
  proof_hash: "verification-failure-proof-hash",
  verifier_id: "provekit-whir-failure-v1",
  verification_status: "verification_failed",
  metadata: {
    ...commonProveKitMetadata,
    cache_status: "miss",
    sanitized_error: "ProveKit proof verification failed"
  }
};

const witnessSentinelApiReceipt: ProveKitProofFixtureApiReceipt = {
  ...provekitWhirApiReceipt,
  proof_id: "proof-fixture-witness-sentinel",
  proof_type: "witness_boundary",
  proof_hash: "witness-sentinel-proof-hash",
  verifier_id: "provekit-whir-witness-boundary-v1",
  witness_record_ids: [`wallet://${walletId}/records/rec-witness-sentinel`],
  public_inputs: {
    ...commonProveKitPublicInputs,
    theorem: "witness_boundary_holds(abby)",
    theorem_hash: "f".repeat(64),
    no_leak_policy: "commitments_only"
  },
  metadata: {
    ...commonProveKitMetadata,
    witness_boundary: "sentinel private input was consumed before public receipt construction",
    redaction: "<redacted:provekit-private-witness>"
  }
};

function toUiReceipt(receipt: ProveKitProofFixtureApiReceipt, expectedLabel?: string): ProofReceiptView {
  return {
    id: receipt.proof_id,
    proofType: receipt.proof_type,
    claim: String(receipt.public_inputs.claim ?? receipt.statement?.claim ?? receipt.proof_type),
    verifier: receipt.verifier_id,
    proofSystem: expectedLabel ?? receipt.proof_system ?? (receipt.is_simulated ? "simulated" : "unknown"),
    verificationStatus: receipt.verification_status ?? "unknown",
    circuitId: receipt.circuit_id ?? undefined,
    verifierDigest: receipt.verifier_digest ?? undefined,
    proofArtifactRef: receipt.proof_artifact_ref ?? undefined,
    publicInputs: stringifyPublicInputs(receipt.public_inputs),
    witnessLabel: receipt.witness_label ?? publicWitnessLabel(receipt.witness_record_ids),
    simulated: receipt.is_simulated,
    createdAt: receipt.created_at
  };
}

function stringifyPublicInputs(publicInputs: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(publicInputs).map(([key, value]) => [key, String(value)]));
}

function publicWitnessLabel(witnessRecordIds: string[]): string {
  if (!witnessRecordIds.length) return "Wallet witness";
  return witnessRecordIds
    .map((id) => id.split("/").filter(Boolean).at(-1) ?? "wallet-witness")
    .join(", ");
}

export const provekitProofFixtureApiReceipts = {
  simulated: simulatedApiReceipt,
  groth16: groth16ApiReceipt,
  provekitWhir: provekitWhirApiReceipt,
  recursive: recursiveApiReceipt,
  artifactHashMismatch: artifactHashMismatchApiReceipt,
  staleVerifierKey: staleVerifierKeyApiReceipt,
  unavailable: unavailableApiReceipt,
  verificationFailure: verificationFailureApiReceipt,
  witnessSentinel: witnessSentinelApiReceipt
};

export const provekitProofFixtureUiReceipts = {
  simulated: toUiReceipt(simulatedApiReceipt, "Simulated proof, demo-only"),
  groth16: toUiReceipt(groth16ApiReceipt, "Groth16 BN254"),
  provekitWhir: toUiReceipt(provekitWhirApiReceipt, "ProveKit WHIR"),
  recursive: toUiReceipt(recursiveApiReceipt, "ProveKit recursive Groth16 wrapper"),
  artifactHashMismatch: toUiReceipt(artifactHashMismatchApiReceipt, "ProveKit WHIR"),
  staleVerifierKey: toUiReceipt(staleVerifierKeyApiReceipt, "ProveKit WHIR"),
  unavailable: toUiReceipt(unavailableApiReceipt, "ProveKit WHIR"),
  verificationFailure: toUiReceipt(verificationFailureApiReceipt, "ProveKit WHIR"),
  witnessSentinel: toUiReceipt(witnessSentinelApiReceipt, "ProveKit WHIR")
};

export const provekitProofFixtureScenarios: Record<ProveKitProofFixtureKey, ProveKitProofFixtureScenario> = {
  simulated: {
    apiReceipt: simulatedApiReceipt,
    coverageSurfaces: ["proof-center", "wallet-uploads", "qr-review", "public-analytics", "export-import"],
    expectedLabel: "Simulated proof, demo-only",
    key: "simulated",
    manualFallback: false,
    onChainReady: false,
    privacyAssertion: "Demo receipt is visibly non-production and contains no private witness values.",
    proofSystem: "simulated",
    uiReceipt: provekitProofFixtureUiReceipts.simulated
  },
  groth16: {
    apiReceipt: groth16ApiReceipt,
    coverageSurfaces: ["proof-center", "qr-review", "provider-proofs", "public-analytics", "export-import"],
    expectedLabel: "Groth16 BN254",
    key: "groth16",
    manualFallback: false,
    onChainReady: false,
    privacyAssertion: "Groth16 receipt exposes verifier digest and artifact ref without trusted setup paths or witness values.",
    proofSystem: "Groth16/BN254",
    uiReceipt: provekitProofFixtureUiReceipts.groth16
  },
  provekitWhir: {
    apiReceipt: provekitWhirApiReceipt,
    coverageSurfaces: [
      "proof-center",
      "wallet-uploads",
      "qr-review",
      "security-audit",
      "provider-proofs",
      "public-analytics",
      "export-import"
    ],
    expectedLabel: "ProveKit WHIR",
    key: "provekitWhir",
    manualFallback: false,
    onChainReady: false,
    privacyAssertion: "ProveKit WHIR public inputs are deterministic commitments and refs only.",
    proofSystem: "ProveKit-WHIR",
    uiReceipt: provekitProofFixtureUiReceipts.provekitWhir
  },
  recursive: {
    apiReceipt: recursiveApiReceipt,
    coverageSurfaces: ["proof-center", "qr-review", "provider-proofs", "export-import"],
    expectedLabel: "ProveKit recursive Groth16 wrapper",
    key: "recursive",
    manualFallback: false,
    onChainReady: true,
    privacyAssertion: "Recursive receipt exposes inner and outer verifier refs without inner witness data.",
    proofSystem: "ProveKit-recursive-Groth16",
    uiReceipt: provekitProofFixtureUiReceipts.recursive
  },
  disabled: {
    apiError: {
      code: "provekit_backend_disabled",
      detail: "ProveKit backend disabled; no simulated fallback was created.",
      status: 503
    },
    coverageSurfaces: ["proof-center", "wallet-uploads", "security-audit", "provider-proofs", "export-import"],
    expectedLabel: "ProveKit backend disabled",
    key: "disabled",
    manualFallback: true,
    onChainReady: false,
    privacyAssertion: "Disabled backend state returns an error and does not mint a replacement simulated receipt.",
    proofSystem: "ProveKit-WHIR"
  },
  artifactHashMismatch: {
    apiError: {
      code: "artifact_hash_mismatch",
      detail: "Prepared ProveKit artifact digest does not match the pinned manifest.",
      status: 409
    },
    apiReceipt: artifactHashMismatchApiReceipt,
    coverageSurfaces: ["proof-center", "qr-review", "security-audit", "provider-proofs", "export-import"],
    expectedLabel: "ProveKit artifact hash mismatch",
    key: "artifactHashMismatch",
    manualFallback: true,
    onChainReady: false,
    privacyAssertion: "Integrity error exposes expected and observed digests only, not local artifact paths.",
    proofSystem: "ProveKit-WHIR",
    uiReceipt: provekitProofFixtureUiReceipts.artifactHashMismatch
  },
  staleVerifierKey: {
    apiError: {
      code: "stale_verifier_key",
      detail: "Verifier key digest is stale and must be rotated before this proof is accepted.",
      status: 409
    },
    apiReceipt: staleVerifierKeyApiReceipt,
    coverageSurfaces: ["proof-center", "qr-review", "security-audit", "provider-proofs", "public-analytics", "export-import"],
    expectedLabel: "Stale ProveKit verifier key",
    key: "staleVerifierKey",
    manualFallback: true,
    onChainReady: false,
    privacyAssertion: "Stale-key state exposes receipt/current verifier digests only.",
    proofSystem: "ProveKit-WHIR",
    uiReceipt: provekitProofFixtureUiReceipts.staleVerifierKey
  },
  unavailable: {
    apiError: {
      code: "provekit_backend_unavailable",
      detail: "ProveKit backend unavailable; no proof receipt was minted.",
      status: 503
    },
    apiReceipt: unavailableApiReceipt,
    coverageSurfaces: ["proof-center", "wallet-uploads", "security-audit", "provider-proofs", "public-analytics", "export-import"],
    expectedLabel: "ProveKit backend unavailable",
    key: "unavailable",
    manualFallback: true,
    onChainReady: false,
    privacyAssertion: "Unavailable backend state exposes sanitized status text only.",
    proofSystem: "ProveKit-WHIR",
    uiReceipt: provekitProofFixtureUiReceipts.unavailable
  },
  verificationFailure: {
    apiError: {
      code: "verification_failure",
      detail: "ProveKit proof verification failed.",
      status: 422
    },
    apiReceipt: verificationFailureApiReceipt,
    coverageSurfaces: ["proof-center", "qr-review", "security-audit", "provider-proofs", "public-analytics", "export-import"],
    expectedLabel: "ProveKit verification failed",
    key: "verificationFailure",
    manualFallback: true,
    onChainReady: false,
    privacyAssertion: "Verification failure exposes sanitized status text only.",
    proofSystem: "ProveKit-WHIR",
    uiReceipt: provekitProofFixtureUiReceipts.verificationFailure
  },
  witnessSentinel: {
    apiReceipt: witnessSentinelApiReceipt,
    coverageSurfaces: [
      "proof-center",
      "wallet-uploads",
      "qr-review",
      "security-audit",
      "provider-proofs",
      "public-analytics",
      "export-import"
    ],
    expectedLabel: "ProveKit WHIR",
    key: "witnessSentinel",
    manualFallback: false,
    onChainReady: false,
    privacyAssertion: "Public receipt remains valid while the private sentinel is absent from every serialized public field.",
    proofSystem: "ProveKit-WHIR",
    uiReceipt: provekitProofFixtureUiReceipts.witnessSentinel
  }
};

export const provekitWalletProofQrBundleFixture = {
  "@context": {
    ipld: "https://ipld.io/",
    wallet: "https://211-ai.com/ns/wallet#"
  },
  schemaVersion: "211-ai-wallet-root-ipld-v1",
  title: "ProveKit wallet proof workflow fixture",
  generatedAt: verifiedAt,
  wallet: {
    actorDid,
    id: walletId,
    label: "ProveKit UI fixture wallet"
  },
  encryptedRecords: [
    {
      "/": "bafywalletprovekitrecordroot",
      cid: "bafywalletprovekitrecordroot",
      fileName: "eligibility-record.enc",
      links: [
        {
          "/": "bafywalletprovekitrecordpayload",
          cid: "bafywalletprovekitrecordpayload",
          mediaType: "application/octet-stream",
          name: "encrypted_payload"
        }
      ],
      recordId: "rec-eligibility-commitment",
      versionId: "version-1"
    }
  ],
  proofs: Object.values(provekitProofFixtureUiReceipts)
};

export function createProveKitLocationRegionApiReceipt({
  createdAt = verifiedAt,
  metadata = {},
  proofHash: receiptProofHash = proofHash,
  proofId = "proof-fullstack-provekit-whir",
  publicInputs = {},
  statement = {},
  verificationStatus = "verified",
  walletId: receiptWalletId = walletId,
  witnessRecordId = "rec-location-current"
}: {
  createdAt?: string;
  metadata?: Record<string, unknown>;
  proofHash?: string;
  proofId?: string;
  publicInputs?: Record<string, unknown>;
  statement?: Record<string, unknown>;
  verificationStatus?: string;
  walletId?: string;
  witnessRecordId?: string;
} = {}): ProveKitProofFixtureApiReceipt {
  return {
    ...provekitWhirApiReceipt,
    proof_id: proofId,
    proof_type: "location_region",
    statement: {
      claim: "location_in_region",
      circuit_ref: "provekit_knowledge_of_axioms@v1",
      region_id: String(publicInputs.region_id ?? "multnomah_county"),
      ...statement
    },
    verifier_id: "provekit-whir-eligibility-v1",
    public_inputs: {
      ...publicInputs,
      ...commonProveKitPublicInputs,
      claim: String(publicInputs.claim ?? "location_in_region")
    },
    proof_hash: receiptProofHash,
    witness_record_ids: [witnessRecordId],
    is_simulated: false,
    proof_system: "ProveKit-WHIR",
    circuit_id: "provekit_knowledge_of_axioms@v1",
    verifier_digest: verifierDigest,
    proof_artifact_ref: "ipfs://bafyprovekitwhirfixture/proof.np",
    verification_status: verificationStatus,
    created_at: createdAt,
    metadata: {
      ...commonProveKitMetadata,
      fixture: "provekit_fullstack_http_backend",
      ...metadata
    },
    wallet_id: receiptWalletId
  };
}

export function buildProveKitWalletProofsApiResponse(
  keys: readonly ProveKitProofFixtureKey[] = [
    "simulated",
    "groth16",
    "provekitWhir",
    "recursive",
    "artifactHashMismatch",
    "staleVerifierKey",
    "unavailable",
    "verificationFailure",
    "witnessSentinel"
  ]
): { proofs: ProveKitProofFixtureApiReceipt[] } {
  return {
    proofs: keys.flatMap((key) => {
      const receipt = provekitProofFixtureScenarios[key].apiReceipt;
      return receipt ? [receipt] : [];
    })
  };
}

export function containsForbiddenWitnessToken(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return provekitForbiddenWitnessTokens.some((token) => serialized.includes(token));
}
