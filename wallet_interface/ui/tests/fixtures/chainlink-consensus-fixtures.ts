export type ChainlinkConsensusMode =
  | "direct"
  | "receipt_only"
  | "libp2p_quorum"
  | "chainlink_cre"
  | "zkml_required"
  | "tee_or_zkml"
  | "hybrid";

export type ChainlinkProofMode = "receipt_only" | "zkml_required" | "tee_or_zkml";

export type ChainlinkConsensusComparison = "exact" | "normalized_text" | "canonical_json" | "semantic";

export type ChainlinkConsensusFailClosedError =
  | "consensus_unavailable"
  | "quorum_not_reached"
  | "proof_verification_failed"
  | "cre_workflow_mismatch"
  | "receipt_replay_or_mismatch"
  | "policy_requires_manual_review";

export type ChainlinkWorkflowTag =
  | "recipient-access"
  | "wallet-uploads"
  | "proof-center"
  | "qr-proof-review"
  | "security-audit"
  | "provider-eligibility"
  | "public-analytics";

export type ChainlinkConsensusFixtureId =
  | "direct"
  | "receipt-only"
  | "libp2p"
  | "cre"
  | "zkml"
  | "tee"
  | "quorum-failure"
  | "proof-failure"
  | "sanitizer-sentinel";

export type ChainlinkConsensusReceiptMetadataField =
  | "schema_version"
  | "mode"
  | "comparison"
  | "quorum_reached"
  | "operator_count"
  | "selected_operator_count"
  | "proof_mode"
  | "verification_label"
  | "receipt_hash"
  | "receipt_cid"
  | "created_at"
  | "failure_reason"
  | "fail_closed_error"
  | "proof_cid"
  | "public_inputs_hash"
  | "tee_attestation_hash"
  | "cre_workflow_id"
  | "cre_report_id"
  | "chain_id"
  | "tx_hash";

export interface ChainlinkConsensusMetadata {
  schema_version: "llm-router-consensus-receipt-v1";
  mode: Exclude<ChainlinkConsensusMode, "direct">;
  comparison: ChainlinkConsensusComparison;
  quorum_reached: boolean;
  operator_count: number;
  selected_operator_count: number;
  proof_mode: ChainlinkProofMode;
  verification_label: string;
  receipt_hash?: string;
  receipt_cid?: string;
  created_at: string;
  failure_reason?: string;
  fail_closed_error?: ChainlinkConsensusFailClosedError;
  proof_cid?: string;
  public_inputs_hash?: string;
  tee_attestation_hash?: string;
  cre_workflow_id?: string;
  cre_report_id?: string;
  chain_id?: string;
  tx_hash?: string;
}

export interface ChainlinkWalletLlmRequestPayload {
  actor_did: string;
  actor_key_hex?: string;
  wallet_cid?: string;
  provider?: string;
  model_name?: string;
  prompt: string;
  system_prompt?: string;
  max_new_tokens?: number;
  kwargs?: Record<string, unknown>;
  consensus?: {
    mode: Exclude<ChainlinkConsensusMode, "direct">;
    comparison?: ChainlinkConsensusComparison;
    quorum?: number;
    min_operators?: number;
    fail_closed?: boolean;
    timeout_s?: number;
  };
  proof_policy?: {
    mode: ChainlinkProofMode;
  };
}

export interface ChainlinkWalletLlmResponsePayload {
  router: "llm_router";
  wallet_id: string;
  wallet_cid: string;
  provider: string;
  model_name: string;
  rate_limit: {
    limit: number;
    remaining: number;
    reset_at: number;
  };
  text: string;
  consensus?: ChainlinkConsensusMetadata;
}

export interface ChainlinkConsensusReceiptPayload {
  schema_version: "llm-router-consensus-receipt-v1";
  request: {
    request_id: string;
    prompt_hash: string;
    prompt_cid?: string;
    prompt_redaction_policy: "hash_only" | "redacted_summary";
    model_name: string;
    model_commitment: string;
    generation_params_hash: string;
    metadata: {
      mode: Exclude<ChainlinkConsensusMode, "direct">;
      workflow: ChainlinkWorkflowTag;
    };
  };
  responses: Array<{
    operator_id: string;
    transport: "local" | "libp2p" | "chainlink_cre";
    provider: string;
    model_name: string;
    output_hash: string;
    normalized_output_hash: string;
    latency_ms: number;
    signature?: string;
    redacted: true;
  }>;
  consensus: {
    accepted: boolean;
    quorum_reached: boolean;
    selected_output_hash?: string;
    selected_normalized_hash?: string;
    selected_operator_ids: string[];
    rejected_operator_ids: string[];
    quorum: number;
    total_successful: number;
    comparison: ChainlinkConsensusComparison;
    reason: string;
  };
  proof: {
    mode: ChainlinkProofMode;
    verifier?: string;
    proof_cid?: string;
    public_inputs_hash?: string;
    tee_attestation_hash?: string;
    cre_workflow_id?: string;
    cre_report_id?: string;
    chain_id?: string;
    tx_hash?: string;
    verified: boolean;
  };
  text: string;
  created_at: string;
}

export interface ChainlinkConsensusErrorPayload {
  status: 409 | 422 | 502;
  detail: {
    code: ChainlinkConsensusFailClosedError;
    message: string;
    mode: Exclude<ChainlinkConsensusMode, "direct">;
    retryable: boolean;
    consensus?: ChainlinkConsensusMetadata;
  };
}

export interface ChainlinkProofReviewPayload {
  schemaVersion: "211-ai-wallet-root-ipld-v1";
  title: string;
  proofs: Array<{
    id: string;
    claim: string;
    proofType: string;
    proofSystem: string;
    verificationStatus: string;
    verifier: string;
    proofArtifactRef?: string;
    publicInputs: Record<string, string>;
    consensus?: ChainlinkConsensusMetadata;
    simulated: boolean;
    witnessLabel: string;
    createdAt: string;
  }>;
  encryptedRecords: Array<{
    cid: string;
    fileName: string;
    recordId: string;
  }>;
  wallet: {
    id: string;
    actorDid: string;
    label: string;
  };
}

export interface ChainlinkConsensusUiExpectations {
  statusLabel: string;
  badgeLabel: string;
  shouldBlockAction: boolean;
  receiptMetadataFields: readonly ChainlinkConsensusReceiptMetadataField[];
  noLeakStrings: readonly string[];
}

export interface ChainlinkConsensusFixture {
  id: ChainlinkConsensusFixtureId;
  label: string;
  route: string;
  method: "GET" | "POST" | "PATCH";
  workflowTags: readonly ChainlinkWorkflowTag[];
  request?: ChainlinkWalletLlmRequestPayload | Record<string, unknown>;
  response?: ChainlinkWalletLlmResponsePayload | ChainlinkProofReviewPayload | Record<string, unknown>;
  receipt?: ChainlinkConsensusReceiptPayload;
  apiError?: ChainlinkConsensusErrorPayload;
  expectedUi: ChainlinkConsensusUiExpectations;
  playwright: {
    desktop: readonly string[];
    mobile: readonly string[];
  };
}

export const CHAINLINK_CONSENSUS_RECEIPT_METADATA_FIELDS: readonly ChainlinkConsensusReceiptMetadataField[] = [
  "schema_version",
  "mode",
  "comparison",
  "quorum_reached",
  "operator_count",
  "selected_operator_count",
  "proof_mode",
  "verification_label",
  "receipt_hash",
  "receipt_cid",
  "created_at",
  "failure_reason",
  "fail_closed_error",
  "proof_cid",
  "public_inputs_hash",
  "tee_attestation_hash",
  "cre_workflow_id",
  "cre_report_id",
  "chain_id",
  "tx_hash"
];

export const CHAINLINK_CONSENSUS_FAIL_CLOSED_ERRORS: readonly ChainlinkConsensusFailClosedError[] = [
  "consensus_unavailable",
  "quorum_not_reached",
  "proof_verification_failed",
  "cre_workflow_mismatch",
  "receipt_replay_or_mismatch",
  "policy_requires_manual_review"
];

export const SANITIZER_SENTINEL_STRINGS = [
  "RAW_PROMPT_SHOULD_NOT_RENDER_FIND_SHELTER_FOR_MAYA",
  "WALLET_PLAINTEXT_SHOULD_NOT_RENDER_MAYA_DOB_1989_04_12",
  "OPERATOR_SECRET_SHOULD_NOT_RENDER_sk_live_chainlink_fixture",
  "PROOF_WITNESS_SHOULD_NOT_RENDER_lat45_515_lon122_678",
  "RAW_ZK_PROOF_PAYLOAD_SHOULD_NOT_RENDER_0xabcdef123456",
  "TEE_QUOTE_BYTES_SHOULD_NOT_RENDER_quote_base64_fixture",
  "CRE_PRIVATE_REPORT_SHOULD_NOT_RENDER_private_don_report",
  "BEARER_TOKEN_SHOULD_NOT_RENDER_fixture_token"
] as const;

export const sanitizerSentinelPayload = {
  rawPrompt: SANITIZER_SENTINEL_STRINGS[0],
  walletPlaintext: SANITIZER_SENTINEL_STRINGS[1],
  operatorSecret: SANITIZER_SENTINEL_STRINGS[2],
  proofWitness: SANITIZER_SENTINEL_STRINGS[3],
  rawProofPayload: SANITIZER_SENTINEL_STRINGS[4],
  teeQuoteBytes: SANITIZER_SENTINEL_STRINGS[5],
  crePrivateReport: SANITIZER_SENTINEL_STRINGS[6],
  bearerToken: SANITIZER_SENTINEL_STRINGS[7]
} as const;

const walletId = "wallet-consensus-fixture";
const walletCid = "bafywalletconsensusfixture0000000000000000000000000000";
const actorDid = "did:key:z6MkConsensusFixture";
const modelName = "Qwen/Qwen2.5-1.5B-Instruct";
const provider = "hf_inference_api";
const createdAt = "2026-06-14T12:00:00Z";

const baseRateLimit = {
  limit: 500,
  remaining: 499,
  reset_at: 1_781_438_400
};

const defaultNoLeakStrings = SANITIZER_SENTINEL_STRINGS;

const commonReceiptFields: readonly ChainlinkConsensusReceiptMetadataField[] = [
  "schema_version",
  "mode",
  "comparison",
  "quorum_reached",
  "operator_count",
  "selected_operator_count",
  "proof_mode",
  "verification_label",
  "receipt_hash",
  "receipt_cid",
  "created_at"
];

function consensusMetadata(
  metadata: Omit<ChainlinkConsensusMetadata, "schema_version" | "created_at"> & { created_at?: string }
): ChainlinkConsensusMetadata {
  const { created_at: metadataCreatedAt = createdAt, ...rest } = metadata;
  return {
    schema_version: "llm-router-consensus-receipt-v1",
    created_at: metadataCreatedAt,
    ...rest
  };
}

function requestPayload(
  prompt: string,
  consensus?: ChainlinkWalletLlmRequestPayload["consensus"],
  proofPolicy?: ChainlinkWalletLlmRequestPayload["proof_policy"]
): ChainlinkWalletLlmRequestPayload {
  return {
    actor_did: actorDid,
    wallet_cid: walletCid,
    provider,
    model_name: modelName,
    prompt,
    max_new_tokens: 350,
    kwargs: {
      response_format: "json_object",
      seed: 211
    },
    ...(consensus ? { consensus } : {}),
    ...(proofPolicy ? { proof_policy: proofPolicy } : {})
  };
}

function llmResponse(text: string, consensus?: ChainlinkConsensusMetadata): ChainlinkWalletLlmResponsePayload {
  return {
    router: "llm_router",
    wallet_id: walletId,
    wallet_cid: walletCid,
    provider,
    model_name: modelName,
    rate_limit: baseRateLimit,
    text,
    ...(consensus ? { consensus } : {})
  };
}

function receiptResponses({
  consensus,
  mode,
  requestId
}: {
  consensus: ChainlinkConsensusReceiptPayload["consensus"];
  mode: Exclude<ChainlinkConsensusMode, "direct">;
  requestId: string;
}): ChainlinkConsensusReceiptPayload["responses"] {
  const selectedOperators = new Set(consensus.selected_operator_ids);
  const operatorIds = [...consensus.selected_operator_ids, ...consensus.rejected_operator_ids];
  return operatorIds.map((operatorId, index) => ({
    operator_id: operatorId,
    transport:
      mode === "chainlink_cre" || operatorId.startsWith("don-node")
        ? "chainlink_cre"
        : operatorId.startsWith("local")
          ? "local"
          : "libp2p",
    provider,
    model_name: modelName,
    output_hash: `sha256:${requestId}-${operatorId}-output`,
    normalized_output_hash: selectedOperators.has(operatorId)
      ? consensus.selected_normalized_hash ?? `sha256:${requestId}-normalized`
      : `sha256:${requestId}-${operatorId}-rejected-normalized`,
    latency_ms: 141 + index * 37,
    signature: `sig:${requestId}:${operatorId}`,
    redacted: true as const
  }));
}

function receiptPayload({
  comparison,
  consensus,
  mode,
  proof,
  requestId,
  responses,
  text,
  workflow
}: {
  comparison: ChainlinkConsensusComparison;
  consensus: ChainlinkConsensusReceiptPayload["consensus"];
  mode: Exclude<ChainlinkConsensusMode, "direct">;
  proof: ChainlinkConsensusReceiptPayload["proof"];
  requestId: string;
  responses?: ChainlinkConsensusReceiptPayload["responses"];
  text: string;
  workflow: ChainlinkWorkflowTag;
}): ChainlinkConsensusReceiptPayload {
  return {
    schema_version: "llm-router-consensus-receipt-v1",
    request: {
      request_id: requestId,
      prompt_hash: `sha256:${requestId}-prompt`,
      prompt_cid: `bafy${requestId.replace(/[^a-z0-9]/g, "")}promptcid000000000000000000`,
      prompt_redaction_policy: "hash_only",
      model_name: modelName,
      model_commitment: "sha256:model-qwen-consensus-fixture",
      generation_params_hash: "sha256:generation-params-temperature0-seed211",
      metadata: {
        mode,
        workflow
      }
    },
    responses: responses ?? receiptResponses({ consensus, mode, requestId }),
    consensus: {
      ...consensus,
      comparison
    },
    proof,
    text,
    created_at: createdAt
  };
}

export const directConsensusFixture: ChainlinkConsensusFixture = {
  id: "direct",
  label: "Direct AI response without consensus metadata",
  route: "**/wallets/*/ai-router/llm",
  method: "POST",
  workflowTags: ["recipient-access", "wallet-uploads"],
  request: requestPayload("Return safe public service categories for this wallet record."),
  response: llmResponse('{"category":"housing","confidence":"advisory"}'),
  expectedUi: {
    statusLabel: "Direct AI response",
    badgeLabel: "direct",
    shouldBlockAction: false,
    receiptMetadataFields: [],
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["recipient access direct fast path", "uploads advisory profile direct fast path"],
    mobile: ["recipient access direct fast path mobile", "uploads advisory profile direct fast path mobile"]
  }
};

const receiptOnlyMetadata = consensusMetadata({
  mode: "receipt_only",
  comparison: "normalized_text",
  quorum_reached: true,
  operator_count: 1,
  selected_operator_count: 1,
  proof_mode: "receipt_only",
  verification_label: "Consensus receipt",
  receipt_hash: "sha256:receipt-only-consensus-fixture",
  receipt_cid: "bafyreceiptonlyconsensusfixture000000000000000000000",
});

export const receiptOnlyConsensusFixture: ChainlinkConsensusFixture = {
  id: "receipt-only",
  label: "Receipt-only consensus metadata",
  route: "**/wallets/*/ai-router/llm",
  method: "POST",
  workflowTags: ["recipient-access", "wallet-uploads", "security-audit"],
  request: requestPayload(
    "Summarize a redacted benefits letter for wallet metadata.",
    { mode: "receipt_only", comparison: "normalized_text", quorum: 1, min_operators: 1, fail_closed: false },
    { mode: "receipt_only" }
  ),
  response: llmResponse('{"summary":"Benefits letter indexed for private wallet use."}', receiptOnlyMetadata),
  receipt: receiptPayload({
    comparison: "normalized_text",
    consensus: {
      accepted: true,
      quorum_reached: true,
      selected_output_hash: "sha256:receipt-only-selected-output",
      selected_normalized_hash: "sha256:receipt-only-normalized",
      selected_operator_ids: ["local-router-01"],
      rejected_operator_ids: [],
      quorum: 1,
      total_successful: 1,
      comparison: "normalized_text",
      reason: "single signed receipt accepted for advisory workflow"
    },
    mode: "receipt_only",
    proof: {
      mode: "receipt_only",
      verifier: "receipt-only-verifier-v1",
      verified: true
    },
    requestId: "receipt-only",
    text: '{"summary":"Benefits letter indexed for private wallet use."}',
    workflow: "wallet-uploads"
  }),
  expectedUi: {
    statusLabel: "Consensus receipt",
    badgeLabel: "receipt-only",
    shouldBlockAction: false,
    receiptMetadataFields: commonReceiptFields,
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["uploads receipt-only profile", "audit receipt-only event"],
    mobile: ["uploads receipt-only profile mobile", "audit receipt-only event mobile"]
  }
};

const libp2pMetadata = consensusMetadata({
  mode: "libp2p_quorum",
  comparison: "canonical_json",
  quorum_reached: true,
  operator_count: 3,
  selected_operator_count: 2,
  proof_mode: "receipt_only",
  verification_label: "libp2p quorum receipt",
  receipt_hash: "sha256:libp2p-quorum-consensus-fixture",
  receipt_cid: "bafylibp2pquorumconsensusfixture00000000000000000"
});

export const libp2pConsensusFixture: ChainlinkConsensusFixture = {
  id: "libp2p",
  label: "libp2p quorum consensus metadata",
  route: "**/wallets/*/records/*/analyze/redacted",
  method: "POST",
  workflowTags: ["recipient-access", "provider-eligibility", "security-audit"],
  request: {
    actor_did: actorDid,
    grant_id: "grant-redacted-analysis-fixture",
    invocation_token: "invocation-token-redacted-fixture",
    max_chars: 500,
    consensus: { mode: "libp2p_quorum", comparison: "canonical_json", quorum: 2, min_operators: 3, fail_closed: true }
  },
  response: {
    artifact: {
      artifact_id: "artifact-libp2p-redacted-analysis",
      source_record_ids: ["rec-benefits-letter"],
      artifact_type: "redacted_document_analysis",
      output_policy: "redacted_derived_only",
      encrypted_payload_ref: {
        uri: "mem://artifact-libp2p-redacted-analysis",
        storage_type: "memory",
        digest: "sha256:artifact-libp2p-redacted-analysis"
      },
      created_at: createdAt
    },
    output: {
      category: "housing",
      labels: ["benefits", "housing"],
      consensus: libp2pMetadata
    }
  },
  receipt: receiptPayload({
    comparison: "canonical_json",
    consensus: {
      accepted: true,
      quorum_reached: true,
      selected_output_hash: "sha256:libp2p-selected-output",
      selected_normalized_hash: "sha256:libp2p-normalized",
      selected_operator_ids: ["local-router-01", "operator-libp2p-02"],
      rejected_operator_ids: ["operator-libp2p-03"],
      quorum: 2,
      total_successful: 3,
      comparison: "canonical_json",
      reason: "2 of 3 operators matched canonical JSON"
    },
    mode: "libp2p_quorum",
    proof: {
      mode: "receipt_only",
      verifier: "receipt-only-verifier-v1",
      verified: true
    },
    requestId: "libp2p-quorum",
    text: '{"category":"housing","labels":["benefits","housing"]}',
    workflow: "recipient-access"
  }),
  expectedUi: {
    statusLabel: "libp2p quorum receipt",
    badgeLabel: "2 of 3",
    shouldBlockAction: false,
    receiptMetadataFields: commonReceiptFields,
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["recipient access libp2p quorum", "provider eligibility libp2p quorum"],
    mobile: ["recipient access libp2p quorum mobile", "provider eligibility libp2p quorum mobile"]
  }
};

const creMetadata = consensusMetadata({
  mode: "chainlink_cre",
  comparison: "canonical_json",
  quorum_reached: true,
  operator_count: 5,
  selected_operator_count: 4,
  proof_mode: "receipt_only",
  verification_label: "Chainlink CRE verified",
  receipt_hash: "sha256:chainlink-cre-consensus-fixture",
  receipt_cid: "bafychainlinkcreconsensusfixture000000000000000000",
  cre_workflow_id: "cre-workflow-211-ai-release-v1",
  cre_report_id: "cre-report-20260614-0001",
  chain_id: "11155111",
  tx_hash: "0xcre000000000000000000000000000000000000000000000000000000000001"
});

export const creConsensusFixture: ChainlinkConsensusFixture = {
  id: "cre",
  label: "Chainlink CRE verified metadata",
  route: "**/analytics/*/count-by-fields",
  method: "POST",
  workflowTags: ["public-analytics", "security-audit"],
  request: {
    actor_did: actorDid,
    group_by: ["county"],
    min_cohort_size: 3,
    epsilon: 1,
    consensus: { mode: "chainlink_cre", comparison: "canonical_json", quorum: 4, min_operators: 5, fail_closed: true }
  },
  response: {
    template_id: "pilot_housing_gap_v1",
    count: 12,
    groups: [{ county: "Multnomah", count: 12 }],
    consensus: creMetadata
  },
  receipt: receiptPayload({
    comparison: "canonical_json",
    consensus: {
      accepted: true,
      quorum_reached: true,
      selected_output_hash: "sha256:cre-selected-output",
      selected_normalized_hash: "sha256:cre-normalized",
      selected_operator_ids: ["don-node-01", "don-node-02", "don-node-03", "don-node-04"],
      rejected_operator_ids: ["don-node-05"],
      quorum: 4,
      total_successful: 5,
      comparison: "canonical_json",
      reason: "CRE DON report matched the local request and output commitments"
    },
    mode: "chainlink_cre",
    proof: {
      mode: "receipt_only",
      verifier: "chainlink-cre-verifier-v1",
      cre_workflow_id: creMetadata.cre_workflow_id,
      cre_report_id: creMetadata.cre_report_id,
      chain_id: creMetadata.chain_id,
      tx_hash: creMetadata.tx_hash,
      verified: true
    },
    requestId: "chainlink-cre",
    text: '{"template_id":"pilot_housing_gap_v1","count":12}',
    workflow: "public-analytics"
  }),
  expectedUi: {
    statusLabel: "Chainlink CRE verified",
    badgeLabel: "CRE",
    shouldBlockAction: false,
    receiptMetadataFields: [...commonReceiptFields, "cre_workflow_id", "cre_report_id", "chain_id", "tx_hash"],
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["public analytics CRE release", "audit CRE receipt"],
    mobile: ["public analytics CRE release mobile", "audit CRE receipt mobile"]
  }
};

const zkmlMetadata = consensusMetadata({
  mode: "zkml_required",
  comparison: "canonical_json",
  quorum_reached: true,
  operator_count: 1,
  selected_operator_count: 1,
  proof_mode: "zkml_required",
  verification_label: "ZKML checker verified",
  receipt_hash: "sha256:zkml-checker-consensus-fixture",
  receipt_cid: "bafyzkmlcheckerconsensusfixture000000000000000000",
  proof_cid: "bafyzkmlproofcidfixture000000000000000000000000000",
  public_inputs_hash: "sha256:zkml-public-inputs-fixture"
});

export const zkmlConsensusFixture: ChainlinkConsensusFixture = {
  id: "zkml",
  label: "ZKML checker verified metadata",
  route: "**/wallets/*/records/*/document-profile-proofs",
  method: "POST",
  workflowTags: ["wallet-uploads", "proof-center", "public-analytics"],
  request: {
    actor_did: actorDid,
    public_inputs: {
      claim: "document_privacy_profile",
      profile_hash: "sha256:privacy-profile-public-inputs"
    },
    consensus: { mode: "zkml_required", comparison: "canonical_json", quorum: 1, min_operators: 1, fail_closed: true },
    proof_policy: { mode: "zkml_required" }
  },
  response: {
    proof_id: "proof-zkml-document-profile",
    proof_type: "document_privacy_profile",
    verifier_id: "zkml-document-profile-verifier-v1",
    public_inputs: {
      claim: "document_privacy_profile",
      profile_hash: "sha256:privacy-profile-public-inputs",
      consensus: "zkml_required"
    },
    proof_hash: "sha256:zkml-proof-hash-fixture",
    witness_record_ids: ["rec-benefits-letter"],
    is_simulated: false,
    proof_system: "zkml-checker",
    circuit_id: "document-profile-checker-v1",
    verifier_digest: "sha256:document-profile-verifier-digest",
    proof_artifact_ref: zkmlMetadata.proof_cid,
    verification_status: "verified",
    created_at: createdAt,
    consensus: zkmlMetadata
  },
  receipt: receiptPayload({
    comparison: "canonical_json",
    consensus: {
      accepted: true,
      quorum_reached: true,
      selected_output_hash: "sha256:zkml-selected-output",
      selected_normalized_hash: "sha256:zkml-normalized",
      selected_operator_ids: ["zkml-checker-01"],
      rejected_operator_ids: [],
      quorum: 1,
      total_successful: 1,
      comparison: "canonical_json",
      reason: "bounded checker proof verified"
    },
    mode: "zkml_required",
    proof: {
      mode: "zkml_required",
      verifier: "zkml-document-profile-verifier-v1",
      proof_cid: zkmlMetadata.proof_cid,
      public_inputs_hash: zkmlMetadata.public_inputs_hash,
      verified: true
    },
    requestId: "zkml-checker",
    text: '{"claim":"document_privacy_profile","verified":true}',
    workflow: "proof-center"
  }),
  expectedUi: {
    statusLabel: "ZKML checker verified",
    badgeLabel: "ZKML",
    shouldBlockAction: false,
    receiptMetadataFields: [...commonReceiptFields, "proof_cid", "public_inputs_hash"],
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["proof center ZKML checker", "uploads ZKML privacy profile"],
    mobile: ["proof center ZKML checker mobile", "uploads ZKML privacy profile mobile"]
  }
};

const teeMetadata = consensusMetadata({
  mode: "tee_or_zkml",
  comparison: "canonical_json",
  quorum_reached: true,
  operator_count: 1,
  selected_operator_count: 1,
  proof_mode: "tee_or_zkml",
  verification_label: "TEE attested",
  receipt_hash: "sha256:tee-attested-consensus-fixture",
  receipt_cid: "bafyteeattestedconsensusfixture00000000000000000000",
  public_inputs_hash: "sha256:tee-public-inputs-fixture",
  tee_attestation_hash: "sha256:tee-attestation-fixture"
});

export const teeConsensusFixture: ChainlinkConsensusFixture = {
  id: "tee",
  label: "TEE attested metadata",
  route: "**/wallets/*/hmis/referral-drafts/*/validate",
  method: "POST",
  workflowTags: ["provider-eligibility", "security-audit"],
  request: {
    actor_did: actorDid,
    consensus: { mode: "tee_or_zkml", comparison: "canonical_json", quorum: 1, min_operators: 1, fail_closed: true },
    proof_policy: { mode: "tee_or_zkml" }
  },
  response: {
    referral_draft_id: "referral-tee-eligibility",
    status: "validated",
    eligibility: {
      verified: true,
      claim_hash: "sha256:tee-eligibility-claim"
    },
    consensus: teeMetadata
  },
  receipt: receiptPayload({
    comparison: "canonical_json",
    consensus: {
      accepted: true,
      quorum_reached: true,
      selected_output_hash: "sha256:tee-selected-output",
      selected_normalized_hash: "sha256:tee-normalized",
      selected_operator_ids: ["tee-enclave-01"],
      rejected_operator_ids: [],
      quorum: 1,
      total_successful: 1,
      comparison: "canonical_json",
      reason: "TEE measurement, nonce, request hash, and output hash matched policy"
    },
    mode: "tee_or_zkml",
    proof: {
      mode: "tee_or_zkml",
      verifier: "tee-attestation-verifier-v1",
      public_inputs_hash: teeMetadata.public_inputs_hash,
      tee_attestation_hash: teeMetadata.tee_attestation_hash,
      verified: true
    },
    requestId: "tee-attested",
    text: '{"eligibility":{"verified":true}}',
    workflow: "provider-eligibility"
  }),
  expectedUi: {
    statusLabel: "TEE attested",
    badgeLabel: "TEE",
    shouldBlockAction: false,
    receiptMetadataFields: [...commonReceiptFields, "public_inputs_hash", "tee_attestation_hash"],
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["provider eligibility TEE attested", "audit TEE attested"],
    mobile: ["provider eligibility TEE attested mobile", "audit TEE attested mobile"]
  }
};

const quorumFailureMetadata = consensusMetadata({
  mode: "libp2p_quorum",
  comparison: "canonical_json",
  quorum_reached: false,
  operator_count: 3,
  selected_operator_count: 1,
  proof_mode: "receipt_only",
  verification_label: "Manual review required",
  receipt_hash: "sha256:quorum-failure-consensus-fixture",
  created_at: "2026-06-14T12:01:00Z",
  failure_reason: "Only one operator matched the canonical JSON output.",
  fail_closed_error: "quorum_not_reached"
});

export const quorumFailureConsensusFixture: ChainlinkConsensusFixture = {
  id: "quorum-failure",
  label: "Fail-closed quorum failure",
  route: "**/wallets/*/ai-router/llm",
  method: "POST",
  workflowTags: ["recipient-access", "provider-eligibility", "security-audit"],
  request: requestPayload(
    "Classify a high-impact housing eligibility claim.",
    { mode: "libp2p_quorum", comparison: "canonical_json", quorum: 2, min_operators: 3, fail_closed: true },
    { mode: "receipt_only" }
  ),
  apiError: {
    status: 502,
    detail: {
      code: "quorum_not_reached",
      message: "Consensus failed closed because quorum was not reached.",
      mode: "libp2p_quorum",
      retryable: true,
      consensus: quorumFailureMetadata
    }
  },
  receipt: receiptPayload({
    comparison: "canonical_json",
    consensus: {
      accepted: false,
      quorum_reached: false,
      selected_output_hash: "sha256:quorum-failure-selected-output",
      selected_normalized_hash: "sha256:quorum-failure-normalized",
      selected_operator_ids: ["local-router-01"],
      rejected_operator_ids: ["operator-libp2p-02", "operator-libp2p-03"],
      quorum: 2,
      total_successful: 3,
      comparison: "canonical_json",
      reason: "quorum_not_reached"
    },
    mode: "libp2p_quorum",
    proof: {
      mode: "receipt_only",
      verifier: "receipt-only-verifier-v1",
      verified: false
    },
    requestId: "quorum-failure",
    text: "",
    workflow: "provider-eligibility"
  }),
  expectedUi: {
    statusLabel: "Manual review required",
    badgeLabel: "quorum failed",
    shouldBlockAction: true,
    receiptMetadataFields: [...commonReceiptFields, "failure_reason", "fail_closed_error"],
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["recipient access quorum failure", "provider eligibility quorum failure", "audit quorum failure"],
    mobile: ["recipient access quorum failure mobile", "provider eligibility quorum failure mobile", "audit quorum failure mobile"]
  }
};

const proofFailureMetadata = consensusMetadata({
  mode: "zkml_required",
  comparison: "canonical_json",
  quorum_reached: true,
  operator_count: 1,
  selected_operator_count: 1,
  proof_mode: "zkml_required",
  verification_label: "Manual review required",
  receipt_hash: "sha256:proof-failure-consensus-fixture",
  receipt_cid: "bafyprooffailureconsensusfixture00000000000000000",
  proof_cid: "bafyinvalidproofcidfixture000000000000000000000000",
  public_inputs_hash: "sha256:proof-failure-public-inputs",
  failure_reason: "ZKML verifier rejected the public input hash.",
  fail_closed_error: "proof_verification_failed"
});

export const proofFailureConsensusFixture: ChainlinkConsensusFixture = {
  id: "proof-failure",
  label: "Fail-closed proof verification failure",
  route: "**/wallets/*/records/*/document-profile-proofs",
  method: "POST",
  workflowTags: ["wallet-uploads", "proof-center", "public-analytics", "security-audit"],
  request: {
    actor_did: actorDid,
    public_inputs: {
      claim: "document_privacy_profile",
      profile_hash: "sha256:proof-failure-profile"
    },
    consensus: { mode: "zkml_required", comparison: "canonical_json", quorum: 1, min_operators: 1, fail_closed: true },
    proof_policy: { mode: "zkml_required" }
  },
  apiError: {
    status: 422,
    detail: {
      code: "proof_verification_failed",
      message: "Consensus failed closed because proof verification failed.",
      mode: "zkml_required",
      retryable: false,
      consensus: proofFailureMetadata
    }
  },
  receipt: receiptPayload({
    comparison: "canonical_json",
    consensus: {
      accepted: false,
      quorum_reached: true,
      selected_output_hash: "sha256:proof-failure-selected-output",
      selected_normalized_hash: "sha256:proof-failure-normalized",
      selected_operator_ids: ["zkml-checker-01"],
      rejected_operator_ids: [],
      quorum: 1,
      total_successful: 1,
      comparison: "canonical_json",
      reason: "proof_verification_failed"
    },
    mode: "zkml_required",
    proof: {
      mode: "zkml_required",
      verifier: "zkml-document-profile-verifier-v1",
      proof_cid: proofFailureMetadata.proof_cid,
      public_inputs_hash: proofFailureMetadata.public_inputs_hash,
      verified: false
    },
    requestId: "proof-failure",
    text: "",
    workflow: "proof-center"
  }),
  expectedUi: {
    statusLabel: "Manual review required",
    badgeLabel: "proof failed",
    shouldBlockAction: true,
    receiptMetadataFields: [...commonReceiptFields, "failure_reason", "fail_closed_error", "proof_cid", "public_inputs_hash"],
    noLeakStrings: defaultNoLeakStrings
  },
  playwright: {
    desktop: ["proof center proof failure", "uploads proof failure", "public analytics proof failure"],
    mobile: ["proof center proof failure mobile", "uploads proof failure mobile", "public analytics proof failure mobile"]
  }
};

const sanitizerMetadata = consensusMetadata({
  mode: "chainlink_cre",
  comparison: "canonical_json",
  quorum_reached: true,
  operator_count: 5,
  selected_operator_count: 4,
  proof_mode: "tee_or_zkml",
  verification_label: "TEE attested",
  receipt_hash: "sha256:sanitized-sentinel-receipt",
  receipt_cid: "bafysanitizedsentinelreceipt000000000000000000000",
  public_inputs_hash: "sha256:sanitized-sentinel-public-inputs",
  tee_attestation_hash: "sha256:sanitized-sentinel-tee-attestation",
  cre_workflow_id: "cre-workflow-sanitizer-fixture-v1",
  cre_report_id: "cre-report-sanitizer-0001",
  chain_id: "11155111",
  tx_hash: "0xsanitizer000000000000000000000000000000000000000000000000001"
});

export const sanitizerSentinelConsensusFixture: ChainlinkConsensusFixture = {
  id: "sanitizer-sentinel",
  label: "Sanitizer sentinel payload",
  route: "**/wallets/*/ai-router/llm",
  method: "POST",
  workflowTags: ["recipient-access", "qr-proof-review", "security-audit", "public-analytics"],
  request: {
    ...requestPayload(
      sanitizerSentinelPayload.rawPrompt,
      { mode: "chainlink_cre", comparison: "canonical_json", quorum: 4, min_operators: 5, fail_closed: true },
      { mode: "tee_or_zkml" }
    ),
    private_fixture_payload: sanitizerSentinelPayload
  },
  response: llmResponse(
    '{"status":"sanitized","claim_hash":"sha256:sanitized-sentinel-claim"}',
    sanitizerMetadata
  ),
  receipt: receiptPayload({
    comparison: "canonical_json",
    consensus: {
      accepted: true,
      quorum_reached: true,
      selected_output_hash: "sha256:sanitizer-selected-output",
      selected_normalized_hash: "sha256:sanitizer-normalized",
      selected_operator_ids: ["don-node-01", "don-node-02", "don-node-03", "don-node-04"],
      rejected_operator_ids: ["don-node-05"],
      quorum: 4,
      total_successful: 5,
      comparison: "canonical_json",
      reason: "sanitized metadata only"
    },
    mode: "chainlink_cre",
    proof: {
      mode: "tee_or_zkml",
      verifier: "tee-attestation-verifier-v1",
      public_inputs_hash: sanitizerMetadata.public_inputs_hash,
      tee_attestation_hash: sanitizerMetadata.tee_attestation_hash,
      cre_workflow_id: sanitizerMetadata.cre_workflow_id,
      cre_report_id: sanitizerMetadata.cre_report_id,
      chain_id: sanitizerMetadata.chain_id,
      tx_hash: sanitizerMetadata.tx_hash,
      verified: true
    },
    requestId: "sanitizer-sentinel",
    text: '{"status":"sanitized","claim_hash":"sha256:sanitized-sentinel-claim"}',
    workflow: "public-analytics"
  }),
  expectedUi: {
    statusLabel: "TEE attested",
    badgeLabel: "sanitized",
    shouldBlockAction: false,
    receiptMetadataFields: [
      ...commonReceiptFields,
      "public_inputs_hash",
      "tee_attestation_hash",
      "cre_workflow_id",
      "cre_report_id",
      "chain_id",
      "tx_hash"
    ],
    noLeakStrings: SANITIZER_SENTINEL_STRINGS
  },
  playwright: {
    desktop: ["sanitizer sentinel visible UI", "sanitizer sentinel public export", "sanitizer sentinel audit"],
    mobile: ["sanitizer sentinel visible UI mobile", "sanitizer sentinel QR review mobile"]
  }
};

export const sanitizerProofReviewPayload: ChainlinkProofReviewPayload = {
  schemaVersion: "211-ai-wallet-root-ipld-v1",
  title: "Sanitized wallet proof bundle",
  proofs: [
    {
      id: "proof-sanitized-sentinel",
      claim: "Sanitized consensus claim",
      proofType: "consensus_receipt",
      proofSystem: "tee-attested-cre",
      verificationStatus: "verified",
      verifier: "tee-attestation-verifier-v1",
      proofArtifactRef: sanitizerMetadata.receipt_cid,
      publicInputs: {
        claim_hash: "sha256:sanitized-sentinel-claim",
        public_inputs_hash: sanitizerMetadata.public_inputs_hash ?? "",
        receipt_hash: sanitizerMetadata.receipt_hash ?? ""
      },
      consensus: sanitizerMetadata,
      simulated: false,
      witnessLabel: "Wallet witness",
      createdAt
    }
  ],
  encryptedRecords: [
    {
      cid: "bafyencryptedrecordfixture000000000000000000000000000",
      fileName: "benefits-letter.enc",
      recordId: "rec-benefits-letter"
    }
  ],
  wallet: {
    id: walletId,
    actorDid,
    label: "Consensus fixture wallet"
  }
};

export const chainlinkConsensusFixturesById: Record<ChainlinkConsensusFixtureId, ChainlinkConsensusFixture> = {
  direct: directConsensusFixture,
  "receipt-only": receiptOnlyConsensusFixture,
  libp2p: libp2pConsensusFixture,
  cre: creConsensusFixture,
  zkml: zkmlConsensusFixture,
  tee: teeConsensusFixture,
  "quorum-failure": quorumFailureConsensusFixture,
  "proof-failure": proofFailureConsensusFixture,
  "sanitizer-sentinel": sanitizerSentinelConsensusFixture
};

export const chainlinkConsensusFixtures: readonly ChainlinkConsensusFixture[] = Object.values(chainlinkConsensusFixturesById);

export function cloneConsensusFixture<T>(fixture: T): T {
  return JSON.parse(JSON.stringify(fixture)) as T;
}
