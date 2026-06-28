"""Consensus receipt models for verified LLM router outputs."""

from __future__ import annotations

import asyncio
import inspect
import json
import hashlib
import hmac
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, ClassVar


CONSENSUS_RECEIPT_SCHEMA_VERSION = "llm-router-consensus-receipt-v1"
P2P_REQUEST_SCHEMA_VERSION = "llm-consensus-generate-v1"
P2P_RESPONSE_SCHEMA_VERSION = "llm-consensus-generate-v1-response"
DEFAULT_DOMAIN_SEPARATOR = "ipfs-accelerate-llm-consensus-v1"
SECRET_KEY_MARKERS = (
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "password",
    "private_key",
    "secret",
    "token",
)
NONDETERMINISTIC_KEYS = (
    "created_at",
    "duration_ms",
    "elapsed_ms",
    "latency_ms",
    "request_time",
    "span_id",
    "timestamp",
    "trace_id",
    "updated_at",
)
ADVISORY_COMPARISON_MODES = {"semantic"}
SUPPORTED_COMPARISON_MODES = {"exact", "canonical_json", "normalized_text", "semantic"}
P2P_COMPLETED_STATUSES = {"completed", "done", "success", "succeeded"}
P2P_FAILED_STATUSES = {"cancelled", "error", "failed"}
P2P_PENDING_STATUSES = {"pending", "queued", "running"}


class LLMConsensusError(RuntimeError):
    """Raised when LLM consensus receipt handling fails."""


def utc_now_iso() -> str:
    """Return a compact UTC timestamp suitable for receipts."""

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, set):
        items = [_jsonable(item) for item in value]
        return sorted(items, key=lambda item: _stable_json({"value": item}))
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return _jsonable(to_dict())
    return str(value)


def _stable_json(data: dict[str, Any]) -> str:
    return json.dumps(_jsonable(data), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _dict_value(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def _list_value(data: dict[str, Any], key: str) -> list[Any]:
    value = data.get(key)
    return list(value) if isinstance(value, list) else []


def _safe_key(key: object) -> str:
    return str(key or "").strip()


def _is_sensitive_or_transient_key(key: object) -> bool:
    lowered = _safe_key(key).lower()
    if not lowered:
        return False
    if lowered in NONDETERMINISTIC_KEYS:
        return True
    parts = [part for part in re.split(r"[^a-z0-9]+", lowered) if part]
    normalized = "_".join(parts)
    for marker in SECRET_KEY_MARKERS:
        if marker == "token":
            if marker in parts:
                return True
            continue
        if marker in normalized:
            return True
    return False


def _sanitize_canonical_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            safe_key = _safe_key(key)
            if not safe_key or _is_sensitive_or_transient_key(safe_key):
                continue
            sanitized[safe_key] = _sanitize_canonical_value(item)
        return sanitized
    if isinstance(value, set):
        items = [_sanitize_canonical_value(item) for item in value]
        return sorted(items, key=lambda item: _stable_json({"value": item}))
    if isinstance(value, (list, tuple)):
        return [_sanitize_canonical_value(item) for item in value]
    return str(value)


def sha256_digest(value: bytes | str) -> str:
    raw = value.encode("utf-8") if isinstance(value, str) else bytes(value)
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def receipt_content_hash(receipt: "ConsensusReceipt") -> str:
    return sha256_digest(receipt.to_json())


def operator_signature_payload(request: "ConsensusRequest", response: "OperatorResponse") -> dict[str, Any]:
    return {
        "domain_separator": str(request.metadata.get("domain_separator") or DEFAULT_DOMAIN_SEPARATOR),
        "nonce": str(request.metadata.get("nonce") or ""),
        "request_hash": request.request_hash or "",
        "operator_id": response.operator_id,
        "output_hash": response.output_hash,
        "normalized_output_hash": response.normalized_output_hash,
    }


def _signature_digest(payload: dict[str, Any], signing_key: str | bytes) -> str:
    key = signing_key.encode("utf-8") if isinstance(signing_key, str) else bytes(signing_key)
    return hmac.new(key, _stable_json(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def sign_operator_response(
    request: "ConsensusRequest",
    response: "OperatorResponse",
    *,
    signing_key: str | bytes,
    key_id: str = "dev-key",
) -> "OperatorResponse":
    signature = f"hmac-sha256:{key_id}:{_signature_digest(operator_signature_payload(request, response), signing_key)}"
    metadata = dict(response.metadata)
    metadata["signature_key_id"] = key_id
    metadata["signature_algorithm"] = "hmac-sha256"
    return replace(response, signature=signature, metadata=metadata)


def verify_operator_response_signature(
    request: "ConsensusRequest",
    response: "OperatorResponse",
    *,
    key_lookup: dict[str, str | bytes] | None = None,
    allow_unsigned_receipt_only: bool = True,
) -> bool:
    signature = str(response.signature or "")
    if not signature:
        policy_mode = str(request.proof_policy.get("mode") or "receipt_only")
        return bool(allow_unsigned_receipt_only and policy_mode == "receipt_only")

    parts = signature.split(":", 2)
    if len(parts) != 3 or parts[0] != "hmac-sha256":
        return False
    _, key_id, provided = parts
    key = (key_lookup or {}).get(key_id)
    if key is None:
        return False
    expected = _signature_digest(operator_signature_payload(request, response), key)
    return hmac.compare_digest(provided, expected)


def canonical_request_payload(
    *,
    prompt: str,
    provider: str | None = None,
    model_name: str | None = None,
    model_commitment: str | None = None,
    tokenizer_commitment: str | None = None,
    generation_params: dict[str, Any] | None = None,
    response_schema: dict[str, Any] | None = None,
    proof_policy: dict[str, Any] | None = None,
    nonce: str | None = None,
    deadline_unix_ms: int = 0,
    prompt_cid: str | None = None,
    context_cids: list[str] | tuple[str, ...] | None = None,
    prompt_redaction_policy: str = "hash_only",
    comparison: str = "exact",
    quorum: int = 1,
    min_operators: int = 1,
    metadata: dict[str, Any] | None = None,
    domain_separator: str = DEFAULT_DOMAIN_SEPARATOR,
) -> dict[str, Any]:
    """Return the deterministic request payload used for request hashing."""

    safe_context_cids = [str(item) for item in context_cids or () if str(item or "").strip()]
    return {
        "domain_separator": str(domain_separator or DEFAULT_DOMAIN_SEPARATOR),
        "prompt_hash": sha256_digest(prompt or ""),
        "prompt_cid": str(prompt_cid) if prompt_cid is not None else None,
        "prompt_redaction_policy": str(prompt_redaction_policy or "hash_only"),
        "provider": str(provider) if provider is not None else None,
        "model_name": str(model_name) if model_name is not None else None,
        "model_commitment": str(model_commitment) if model_commitment is not None else None,
        "tokenizer_commitment": str(tokenizer_commitment) if tokenizer_commitment is not None else None,
        "generation_params": _sanitize_canonical_value(generation_params or {}),
        "response_schema": _sanitize_canonical_value(response_schema or {}),
        "proof_policy": _sanitize_canonical_value(proof_policy or {}),
        "nonce": str(nonce or ""),
        "deadline_unix_ms": int(deadline_unix_ms or 0),
        "context_cids": safe_context_cids,
        "comparison": str(comparison or "exact"),
        "quorum": int(quorum),
        "min_operators": int(min_operators),
        "metadata": _sanitize_canonical_value(metadata or {}),
    }


def canonical_request_hash(**kwargs: Any) -> str:
    return sha256_digest(_stable_json(canonical_request_payload(**kwargs)))


def normalize_output_text(text: str, *, comparison: str = "exact") -> str:
    """Normalize model output for consensus comparison."""

    mode = str(comparison or "exact").strip().lower()
    if mode not in SUPPORTED_COMPARISON_MODES:
        raise LLMConsensusError(f"Unsupported consensus comparison mode: {comparison}")

    raw = str(text or "")
    if mode == "exact":
        return raw.strip()
    if mode == "canonical_json":
        try:
            parsed = json.loads(raw)
        except Exception as exc:
            raise LLMConsensusError("canonical_json comparison requires valid JSON output") from exc
        return json.dumps(_jsonable(parsed), sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    normalized = " ".join(raw.split()).lower()
    if mode == "normalized_text":
        return normalized
    return "semantic-advisory:" + normalized


def normalized_output_hash(text: str, *, comparison: str = "exact") -> str:
    return sha256_digest(normalize_output_text(text, comparison=comparison))


def is_advisory_comparison(comparison: str) -> bool:
    return str(comparison or "").strip().lower() in ADVISORY_COMPARISON_MODES


def _coerce_bool(value: Any, *, default: bool) -> bool:
    if value is None:
        return bool(default)
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _first_config_value(options: dict[str, Any], env: dict[str, str], aliases: tuple[str, ...], env_name: str, default: Any) -> Any:
    for alias in aliases:
        if alias in options and options[alias] is not None:
            return options[alias]
    if env_name in env and str(env[env_name]).strip():
        return env[env_name]
    return default


def _first_config_value_any_env(
    options: dict[str, Any],
    env: dict[str, str],
    aliases: tuple[str, ...],
    env_names: tuple[str, ...],
    default: Any,
) -> Any:
    for alias in aliases:
        if alias in options and options[alias] is not None:
            return options[alias]
    for env_name in env_names:
        if env_name in env and str(env[env_name]).strip():
            return env[env_name]
    return default


def _split_csv(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item or "").strip()]
    return [part.strip() for part in str(value).split(",") if part.strip()]


def load_consensus_config(
    options: dict[str, Any] | None = None,
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Load normalized consensus options from explicit values and environment."""

    explicit = dict(options or {})
    resolved_env = dict(os.environ if env is None else env)
    prefix = "IPFS_ACCELERATE_PY_LLM_CONSENSUS_"

    mode = str(
        _first_config_value(explicit, resolved_env, ("mode",), prefix + "MODE", "local_quorum")
        or "local_quorum"
    )
    comparison = str(
        _first_config_value(explicit, resolved_env, ("comparison",), prefix + "COMPARISON", "exact")
        or "exact"
    ).strip().lower()
    if comparison not in SUPPORTED_COMPARISON_MODES:
        raise LLMConsensusError(f"Unsupported consensus comparison mode: {comparison}")

    quorum = int(_first_config_value(explicit, resolved_env, ("quorum",), prefix + "QUORUM", 1))
    min_operators = int(
        _first_config_value(
            explicit,
            resolved_env,
            ("min_operators", "minOperators"),
            prefix + "MIN_OPERATORS",
            quorum,
        )
    )
    if quorum < 1:
        raise LLMConsensusError("Consensus quorum must be at least 1")
    if min_operators < 1:
        raise LLMConsensusError("Consensus min_operators must be at least 1")
    if quorum > min_operators:
        raise LLMConsensusError("Consensus quorum cannot exceed min_operators")

    timeout_s = float(
        _first_config_value(
            explicit,
            resolved_env,
            ("timeout_s", "timeout"),
            prefix + "TIMEOUT_S",
            60.0,
        )
    )
    if timeout_s < 0:
        raise LLMConsensusError("Consensus timeout_s cannot be negative")

    operator_timeout_value = _first_config_value(
        explicit,
        resolved_env,
        ("operator_timeout_s", "operatorTimeout"),
        prefix + "OPERATOR_TIMEOUT_S",
        None,
    )
    operator_timeout_s = float(operator_timeout_value) if operator_timeout_value not in (None, "") else None
    if operator_timeout_s is not None and operator_timeout_s < 0:
        raise LLMConsensusError("Consensus operator_timeout_s cannot be negative")

    fail_closed = _coerce_bool(
        _first_config_value(
            explicit,
            resolved_env,
            ("fail_closed", "failClosed"),
            prefix + "FAIL_CLOSED",
            True,
        ),
        default=True,
    )
    enabled = _coerce_bool(
        _first_config_value(explicit, resolved_env, ("enabled",), prefix + "ENABLED", True),
        default=True,
    )

    return {
        "enabled": enabled,
        "mode": mode,
        "comparison": comparison,
        "quorum": quorum,
        "min_operators": min_operators,
        "timeout_s": timeout_s,
        "operator_timeout_s": operator_timeout_s,
        "fail_closed": fail_closed,
        "nonce": _first_config_value(explicit, resolved_env, ("nonce",), prefix + "NONCE", None),
        "deadline_unix_ms": int(
            _first_config_value(
                explicit,
                resolved_env,
                ("deadline_unix_ms", "deadlineUnixMs"),
                prefix + "DEADLINE_UNIX_MS",
                0,
            )
            or 0
        ),
        "prompt_cid": _first_config_value(
            explicit,
            resolved_env,
            ("prompt_cid", "promptCid"),
            prefix + "PROMPT_CID",
            None,
        ),
        "context_cids": _split_csv(
            _first_config_value(
                explicit,
                resolved_env,
                ("context_cids", "contextCids"),
                prefix + "CONTEXT_CIDS",
                None,
            )
        ),
        "prompt_redaction_policy": str(
            _first_config_value(
                explicit,
                resolved_env,
                ("prompt_redaction_policy", "promptRedactionPolicy"),
                prefix + "PROMPT_REDACTION_POLICY",
                "hash_only",
            )
            or "hash_only"
        ),
        "request_id": _first_config_value(
            explicit,
            resolved_env,
            ("request_id", "requestId"),
            prefix + "REQUEST_ID",
            None,
        ),
        "operator_id": _first_config_value(
            explicit,
            resolved_env,
            ("operator_id", "operatorId"),
            prefix + "OPERATOR_ID",
            "local-router",
        ),
        "model_commitment": _first_config_value(
            explicit,
            resolved_env,
            ("model_commitment", "modelCommitment"),
            prefix + "MODEL_COMMITMENT",
            None,
        ),
        "tokenizer_commitment": _first_config_value(
            explicit,
            resolved_env,
            ("tokenizer_commitment", "tokenizerCommitment"),
            prefix + "TOKENIZER_COMMITMENT",
            None,
        ),
        "receipt_path": _first_config_value(
            explicit,
            resolved_env,
            ("receipt_path", "receiptPath"),
            prefix + "RECEIPT_PATH",
            None,
        ),
        "receipt_jsonl_path": _first_config_value(
            explicit,
            resolved_env,
            ("receipt_jsonl_path", "receiptJsonlPath"),
            prefix + "RECEIPT_JSONL_PATH",
            None,
        ),
        "peers": _split_csv(
            _first_config_value(
                explicit,
                resolved_env,
                ("peers",),
                prefix + "PEERS",
                None,
            )
        ),
        "operator_count": _first_config_value(
            explicit,
            resolved_env,
            ("operator_count", "operatorCount"),
            prefix + "OPERATOR_COUNT",
            None,
        ),
        "cre_workflow_id": _first_config_value_any_env(
            explicit,
            resolved_env,
            ("cre_workflow_id", "creWorkflowId"),
            (
                "IPFS_ACCELERATE_PY_CHAINLINK_CRE_WORKFLOW_ID",
                prefix + "CRE_WORKFLOW_ID",
            ),
            None,
        ),
        "proof_verifier": _first_config_value_any_env(
            explicit,
            resolved_env,
            ("proof_verifier", "proofVerifier", "verifier"),
            (
                "IPFS_ACCELERATE_PY_LLM_PROOF_VERIFIER",
                prefix + "PROOF_VERIFIER",
            ),
            None,
        ),
        "verifier_contract": _first_config_value_any_env(
            explicit,
            resolved_env,
            ("verifier_contract", "verifierContract", "verifier_contract_address", "verifierContractAddress"),
            (
                "IPFS_ACCELERATE_PY_CHAINLINK_VERIFIER_CONTRACT",
                prefix + "VERIFIER_CONTRACT",
            ),
            None,
        ),
    }


def select_consensus_result(
    responses: list["OperatorResponse"] | tuple["OperatorResponse", ...],
    *,
    quorum: int,
    comparison: str,
    fail_closed: bool = True,
) -> ConsensusResult:
    """Select a deterministic quorum result from operator responses."""

    response_list = list(responses or ())
    if quorum < 1:
        message = "Consensus quorum must be at least 1"
        if fail_closed:
            raise LLMConsensusError(message)
        return ConsensusResult(
            accepted=False,
            selected_output_hash="",
            selected_normalized_hash="",
            quorum=int(quorum),
            total_successful=0,
            comparison=str(comparison or "exact"),
            reason="invalid_quorum",
        )

    successful = [
        response
        for response in response_list
        if not response.error and response.normalized_output_hash and response.output_hash
    ]
    if not successful:
        message = "Consensus quorum not met: no successful operator responses"
        if fail_closed:
            raise LLMConsensusError(message)
        return ConsensusResult(
            accepted=False,
            selected_output_hash="",
            selected_normalized_hash="",
            selected_operator_ids=[],
            rejected_operator_ids=sorted({response.operator_id for response in response_list}),
            quorum=int(quorum),
            total_successful=0,
            comparison=str(comparison or "exact"),
            reason="no_successful_responses",
        )

    responses_by_operator: dict[str, list[OperatorResponse]] = {}
    for response in successful:
        responses_by_operator.setdefault(response.operator_id, []).append(response)
    duplicate_groups = {
        operator_id: operator_responses
        for operator_id, operator_responses in responses_by_operator.items()
        if len(operator_responses) > 1
    }
    if duplicate_groups:
        equivocated = any(
            len(
                {
                    (response.output_hash, response.normalized_output_hash)
                    for response in operator_responses
                }
            )
            > 1
            for operator_responses in duplicate_groups.values()
        )
        reason = "operator_equivocation" if equivocated else "duplicate_operator_id"
        message = (
            "Consensus quorum not met: operator equivocation detected"
            if equivocated
            else "Consensus quorum not met: duplicate operator IDs"
        )
        if fail_closed:
            raise LLMConsensusError(message)
        return ConsensusResult(
            accepted=False,
            selected_output_hash="",
            selected_normalized_hash="",
            selected_operator_ids=[],
            rejected_operator_ids=sorted({response.operator_id for response in response_list}),
            quorum=int(quorum),
            total_successful=len(successful),
            comparison=str(comparison or "exact"),
            reason=reason,
        )

    groups: dict[str, list[OperatorResponse]] = {}
    for response in successful:
        groups.setdefault(response.normalized_output_hash, []).append(response)

    ordered_groups = sorted(
        groups.items(),
        key=lambda item: (-len(item[1]), item[0]),
    )
    selected_normalized_hash, selected_group = ordered_groups[0]
    selected_count = len(selected_group)
    tied_hashes = [
        normalized_hash
        for normalized_hash, group in ordered_groups
        if len(group) == selected_count
    ]

    if len(tied_hashes) > 1:
        message = "Consensus quorum not met: tied normalized outputs"
        if fail_closed:
            raise LLMConsensusError(message)
        return ConsensusResult(
            accepted=False,
            selected_output_hash="",
            selected_normalized_hash="",
            selected_operator_ids=[],
            rejected_operator_ids=sorted({response.operator_id for response in response_list}),
            quorum=int(quorum),
            total_successful=len(successful),
            comparison=str(comparison or "exact"),
            reason="tie",
        )

    if selected_count < quorum:
        message = f"Consensus quorum not met: {selected_count} of {quorum}"
        if fail_closed:
            raise LLMConsensusError(message)
        return ConsensusResult(
            accepted=False,
            selected_output_hash="",
            selected_normalized_hash=selected_normalized_hash,
            selected_operator_ids=[],
            rejected_operator_ids=sorted({response.operator_id for response in response_list}),
            quorum=int(quorum),
            total_successful=len(successful),
            comparison=str(comparison or "exact"),
            reason="quorum_not_met",
        )

    selected_group_sorted = sorted(selected_group, key=lambda response: response.operator_id)
    selected_operator_ids = [response.operator_id for response in selected_group_sorted]
    selected_operator_set = set(selected_operator_ids)
    rejected_operator_ids = sorted(
        {
            response.operator_id
            for response in response_list
            if response.operator_id not in selected_operator_set
        }
    )

    return ConsensusResult(
        accepted=True,
        selected_output_hash=selected_group_sorted[0].output_hash,
        selected_normalized_hash=selected_normalized_hash,
        selected_operator_ids=selected_operator_ids,
        rejected_operator_ids=rejected_operator_ids,
        quorum=int(quorum),
        total_successful=len(successful),
        comparison=str(comparison or "exact"),
        reason="quorum_met",
    )


def build_consensus_request(
    *,
    prompt: str,
    request_id: str | None = None,
    provider: str | None = None,
    model_name: str | None = None,
    model_commitment: str | None = None,
    tokenizer_commitment: str | None = None,
    generation_params: dict[str, Any] | None = None,
    response_schema: dict[str, Any] | None = None,
    proof_policy: dict[str, Any] | None = None,
    nonce: str | None = None,
    deadline_unix_ms: int = 0,
    prompt_cid: str | None = None,
    context_cids: list[str] | tuple[str, ...] | None = None,
    prompt_redaction_policy: str = "hash_only",
    comparison: str = "exact",
    quorum: int = 1,
    min_operators: int = 1,
    metadata: dict[str, Any] | None = None,
    domain_separator: str = DEFAULT_DOMAIN_SEPARATOR,
) -> "ConsensusRequest":
    """Build a sanitized consensus request and bind it to a stable hash."""

    payload = canonical_request_payload(
        prompt=prompt,
        provider=provider,
        model_name=model_name,
        model_commitment=model_commitment,
        tokenizer_commitment=tokenizer_commitment,
        generation_params=generation_params,
        response_schema=response_schema,
        proof_policy=proof_policy,
        nonce=nonce,
        deadline_unix_ms=deadline_unix_ms,
        prompt_cid=prompt_cid,
        context_cids=context_cids,
        prompt_redaction_policy=prompt_redaction_policy,
        comparison=comparison,
        quorum=quorum,
        min_operators=min_operators,
        metadata=metadata,
        domain_separator=domain_separator,
    )
    request_hash = sha256_digest(_stable_json(payload))
    resolved_request_id = str(request_id or nonce or request_hash)
    request_metadata = {
        "context_cids": payload["context_cids"],
        "domain_separator": payload["domain_separator"],
        "nonce": payload["nonce"],
        "request_hash_payload": {
            "response_schema": payload["response_schema"],
            "metadata": payload["metadata"],
        },
    }
    return ConsensusRequest(
        request_id=resolved_request_id,
        request_hash=request_hash,
        prompt_hash=str(payload["prompt_hash"]),
        prompt_cid=payload["prompt_cid"],
        prompt_redaction_policy=str(payload["prompt_redaction_policy"]),
        provider=payload["provider"],
        model_name=payload["model_name"],
        model_commitment=payload["model_commitment"],
        tokenizer_commitment=payload["tokenizer_commitment"],
        generation_params=payload["generation_params"],
        comparison=str(payload["comparison"]),
        quorum=int(payload["quorum"]),
        min_operators=int(payload["min_operators"]),
        deadline_unix_ms=int(payload["deadline_unix_ms"]),
        proof_policy=payload["proof_policy"],
        metadata=request_metadata,
    )


@dataclass(frozen=True)
class ConsensusRequest:
    """Canonical request metadata that all operators must answer."""

    request_id: str
    prompt_hash: str
    request_hash: str | None = None
    prompt_cid: str | None = None
    prompt_redaction_policy: str = "raw"
    provider: str | None = None
    model_name: str | None = None
    model_commitment: str | None = None
    tokenizer_commitment: str | None = None
    generation_params: dict[str, Any] = field(default_factory=dict)
    comparison: str = "exact"
    quorum: int = 1
    min_operators: int = 1
    deadline_unix_ms: int = 0
    proof_policy: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "request_hash": self.request_hash,
            "prompt_hash": self.prompt_hash,
            "prompt_cid": self.prompt_cid,
            "prompt_redaction_policy": self.prompt_redaction_policy,
            "provider": self.provider,
            "model_name": self.model_name,
            "model_commitment": self.model_commitment,
            "tokenizer_commitment": self.tokenizer_commitment,
            "generation_params": _jsonable(self.generation_params),
            "comparison": self.comparison,
            "quorum": int(self.quorum),
            "min_operators": int(self.min_operators),
            "deadline_unix_ms": int(self.deadline_unix_ms),
            "proof_policy": _jsonable(self.proof_policy),
            "metadata": _jsonable(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConsensusRequest":
        return cls(
            request_id=str(data.get("request_id") or ""),
            request_hash=str(data["request_hash"]) if data.get("request_hash") is not None else None,
            prompt_hash=str(data.get("prompt_hash") or ""),
            prompt_cid=str(data["prompt_cid"]) if data.get("prompt_cid") is not None else None,
            prompt_redaction_policy=str(data.get("prompt_redaction_policy") or "raw"),
            provider=str(data["provider"]) if data.get("provider") is not None else None,
            model_name=str(data["model_name"]) if data.get("model_name") is not None else None,
            model_commitment=str(data["model_commitment"]) if data.get("model_commitment") is not None else None,
            tokenizer_commitment=str(data["tokenizer_commitment"]) if data.get("tokenizer_commitment") is not None else None,
            generation_params=_dict_value(data, "generation_params"),
            comparison=str(data.get("comparison") or "exact"),
            quorum=int(data.get("quorum") or 1),
            min_operators=int(data.get("min_operators") or 1),
            deadline_unix_ms=int(data.get("deadline_unix_ms") or 0),
            proof_policy=_dict_value(data, "proof_policy"),
            metadata=_dict_value(data, "metadata"),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "ConsensusRequest":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("ConsensusRequest JSON must decode to an object")
        return cls.from_dict(data)


@dataclass(frozen=True)
class OperatorResponse:
    """One operator's response to a consensus request."""

    operator_id: str
    transport: str
    provider: str
    output_text: str
    output_hash: str
    normalized_output_hash: str
    peer_id: str | None = None
    model_name: str | None = None
    latency_ms: int = 0
    error: str | None = None
    signature: str | None = None
    attestation: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "operator_id": self.operator_id,
            "transport": self.transport,
            "peer_id": self.peer_id,
            "provider": self.provider,
            "model_name": self.model_name,
            "output_text": self.output_text,
            "output_hash": self.output_hash,
            "normalized_output_hash": self.normalized_output_hash,
            "latency_ms": int(self.latency_ms),
            "error": self.error,
            "signature": self.signature,
            "attestation": _jsonable(self.attestation) if self.attestation is not None else None,
            "metadata": _jsonable(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "OperatorResponse":
        attestation = data.get("attestation")
        return cls(
            operator_id=str(data.get("operator_id") or ""),
            transport=str(data.get("transport") or ""),
            peer_id=str(data["peer_id"]) if data.get("peer_id") is not None else None,
            provider=str(data.get("provider") or ""),
            model_name=str(data["model_name"]) if data.get("model_name") is not None else None,
            output_text=str(data.get("output_text") or ""),
            output_hash=str(data.get("output_hash") or ""),
            normalized_output_hash=str(data.get("normalized_output_hash") or ""),
            latency_ms=int(data.get("latency_ms") or 0),
            error=str(data["error"]) if data.get("error") is not None else None,
            signature=str(data["signature"]) if data.get("signature") is not None else None,
            attestation=attestation if isinstance(attestation, dict) else None,
            metadata=_dict_value(data, "metadata"),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "OperatorResponse":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("OperatorResponse JSON must decode to an object")
        return cls.from_dict(data)


@dataclass(frozen=True)
class ConsensusResult:
    """Quorum outcome for a set of operator responses."""

    accepted: bool
    selected_output_hash: str = ""
    selected_normalized_hash: str = ""
    selected_operator_ids: list[str] = field(default_factory=list)
    rejected_operator_ids: list[str] = field(default_factory=list)
    quorum: int = 1
    total_successful: int = 0
    comparison: str = "exact"
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "accepted": bool(self.accepted),
            "selected_output_hash": self.selected_output_hash,
            "selected_normalized_hash": self.selected_normalized_hash,
            "selected_operator_ids": list(self.selected_operator_ids),
            "rejected_operator_ids": list(self.rejected_operator_ids),
            "quorum": int(self.quorum),
            "total_successful": int(self.total_successful),
            "comparison": self.comparison,
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConsensusResult":
        return cls(
            accepted=bool(data.get("accepted")),
            selected_output_hash=str(data.get("selected_output_hash") or ""),
            selected_normalized_hash=str(data.get("selected_normalized_hash") or ""),
            selected_operator_ids=[str(item) for item in _list_value(data, "selected_operator_ids")],
            rejected_operator_ids=[str(item) for item in _list_value(data, "rejected_operator_ids")],
            quorum=int(data.get("quorum") or 1),
            total_successful=int(data.get("total_successful") or 0),
            comparison=str(data.get("comparison") or "exact"),
            reason=str(data.get("reason") or ""),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "ConsensusResult":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("ConsensusResult JSON must decode to an object")
        return cls.from_dict(data)


@dataclass(frozen=True)
class ProofReceipt:
    """Verification evidence attached to a consensus receipt."""

    policy: str
    verified: bool = False
    verifier: str | None = None
    proof_cid: str | None = None
    public_inputs_hash: str | None = None
    tee_attestation_hash: str | None = None
    cre_workflow_id: str | None = None
    cre_report_id: str | None = None
    chain_id: str | None = None
    tx_hash: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy,
            "verifier": self.verifier,
            "proof_cid": self.proof_cid,
            "public_inputs_hash": self.public_inputs_hash,
            "tee_attestation_hash": self.tee_attestation_hash,
            "cre_workflow_id": self.cre_workflow_id,
            "cre_report_id": self.cre_report_id,
            "chain_id": self.chain_id,
            "tx_hash": self.tx_hash,
            "verified": bool(self.verified),
            "metadata": _jsonable(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProofReceipt":
        return cls(
            policy=str(data.get("policy") or ""),
            verifier=str(data["verifier"]) if data.get("verifier") is not None else None,
            proof_cid=str(data["proof_cid"]) if data.get("proof_cid") is not None else None,
            public_inputs_hash=str(data["public_inputs_hash"]) if data.get("public_inputs_hash") is not None else None,
            tee_attestation_hash=str(data["tee_attestation_hash"]) if data.get("tee_attestation_hash") is not None else None,
            cre_workflow_id=str(data["cre_workflow_id"]) if data.get("cre_workflow_id") is not None else None,
            cre_report_id=str(data["cre_report_id"]) if data.get("cre_report_id") is not None else None,
            chain_id=str(data["chain_id"]) if data.get("chain_id") is not None else None,
            tx_hash=str(data["tx_hash"]) if data.get("tx_hash") is not None else None,
            verified=bool(data.get("verified")),
            metadata=_dict_value(data, "metadata"),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "ProofReceipt":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("ProofReceipt JSON must decode to an object")
        return cls.from_dict(data)


@dataclass(frozen=True)
class ConsensusReceipt:
    """Portable receipt for one consensus-verified LLM output."""

    request: ConsensusRequest
    responses: list[OperatorResponse]
    consensus: ConsensusResult
    proof: ProofReceipt
    text: str
    created_at: str = field(default_factory=utc_now_iso)
    schema_version: str = CONSENSUS_RECEIPT_SCHEMA_VERSION

    EXPECTED_SCHEMA_VERSION: ClassVar[str] = CONSENSUS_RECEIPT_SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "request": self.request.to_dict(),
            "responses": [response.to_dict() for response in self.responses],
            "consensus": self.consensus.to_dict(),
            "proof": self.proof.to_dict(),
            "text": self.text,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConsensusReceipt":
        schema_version = str(data.get("schema_version") or "")
        if schema_version != cls.EXPECTED_SCHEMA_VERSION:
            raise ValueError(f"Unsupported consensus receipt schema_version: {schema_version}")

        request_data = data.get("request")
        consensus_data = data.get("consensus")
        proof_data = data.get("proof")
        if not isinstance(request_data, dict):
            raise ValueError("ConsensusReceipt request must be an object")
        if not isinstance(consensus_data, dict):
            raise ValueError("ConsensusReceipt consensus must be an object")
        if not isinstance(proof_data, dict):
            raise ValueError("ConsensusReceipt proof must be an object")

        responses: list[OperatorResponse] = []
        for item in _list_value(data, "responses"):
            if not isinstance(item, dict):
                raise ValueError("ConsensusReceipt responses must contain objects")
            responses.append(OperatorResponse.from_dict(item))

        return cls(
            schema_version=schema_version,
            request=ConsensusRequest.from_dict(request_data),
            responses=responses,
            consensus=ConsensusResult.from_dict(consensus_data),
            proof=ProofReceipt.from_dict(proof_data),
            text=str(data.get("text") or ""),
            created_at=str(data.get("created_at") or utc_now_iso()),
        )

    def to_json(self) -> str:
        return _stable_json(self.to_dict())

    @classmethod
    def from_json(cls, text: str) -> "ConsensusReceipt":
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("ConsensusReceipt JSON must decode to an object")
        return cls.from_dict(data)


def receipt_persistence_record(receipt: ConsensusReceipt) -> dict[str, Any]:
    return {
        "schema_version": "llm-router-consensus-persistence-record-v1",
        "receipt_hash": receipt_content_hash(receipt),
        "receipt": receipt.to_dict(),
        "persisted_at": utc_now_iso(),
    }


def persist_consensus_receipt(
    receipt: ConsensusReceipt,
    *,
    path: str | os.PathLike[str],
    append_jsonl: bool | None = None,
) -> dict[str, Any]:
    """Persist a receipt to a local JSON or JSONL path and return the record."""

    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    append = output_path.suffix.lower() == ".jsonl" if append_jsonl is None else bool(append_jsonl)
    record = receipt_persistence_record(receipt)
    rendered = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if append:
        with output_path.open("a", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.write("\n")
    else:
        output_path.write_text(rendered + "\n", encoding="utf-8")
    return record


def _present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (dict, list, tuple, set)):
        return bool(value)
    return bool(value)


def _coerce_health_receipt(value: Any) -> ConsensusReceipt:
    if isinstance(value, ConsensusReceipt):
        return value
    if isinstance(value, str):
        return ConsensusReceipt.from_json(value)
    if isinstance(value, dict):
        receipt_data = value.get("receipt")
        if isinstance(receipt_data, dict):
            return ConsensusReceipt.from_dict(receipt_data)
        return ConsensusReceipt.from_dict(value)
    raise TypeError(f"Unsupported consensus receipt value for health summary: {type(value).__name__}")


def _coerce_health_receipts(receipts: Any) -> list[ConsensusReceipt]:
    if receipts is None:
        return []
    if isinstance(receipts, (ConsensusReceipt, str, dict)):
        return [_coerce_health_receipt(receipts)]
    return [_coerce_health_receipt(item) for item in list(receipts)]


def _safe_observability_reason(value: Any) -> str | None:
    text = " ".join(str(value or "").strip().split())
    if not text:
        return None
    if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", text):
        return text
    return "redacted_failure"


def _last_failure_reason_from_receipts(receipts: list[ConsensusReceipt]) -> str | None:
    for receipt in reversed(receipts):
        if receipt.consensus.accepted:
            continue
        safe_reason = _safe_observability_reason(receipt.consensus.reason)
        if safe_reason:
            return safe_reason
        if any(response.error for response in receipt.responses):
            return "operator_error"
        return "consensus_failure"
    return None


def _receipt_cre_workflow_present(receipt: ConsensusReceipt) -> bool:
    if _present(receipt.proof.cre_workflow_id):
        return True
    if _present(receipt.proof.metadata.get("cre_workflow_id")):
        return True
    if _present(receipt.request.proof_policy.get("cre_workflow_id")):
        return True
    request_hash_payload = receipt.request.metadata.get("request_hash_payload")
    if isinstance(request_hash_payload, dict):
        metadata = request_hash_payload.get("metadata")
        if isinstance(metadata, dict) and _present(metadata.get("cre_workflow_id")):
            return True
    return _present(receipt.request.metadata.get("cre_workflow_id"))


def _proof_policy_from_inputs(
    *,
    proof_policy: Any,
    options: dict[str, Any],
    receipts: list[ConsensusReceipt],
) -> dict[str, Any]:
    latest_receipt = receipts[-1] if receipts else None
    policy: dict[str, Any] = {}
    if latest_receipt is not None:
        policy.update(_sanitize_canonical_value(latest_receipt.request.proof_policy))
        policy.setdefault("mode", latest_receipt.proof.policy)
        if latest_receipt.proof.verifier:
            policy.setdefault("verifier", latest_receipt.proof.verifier)
        if latest_receipt.proof.cre_workflow_id:
            policy.setdefault("cre_workflow_id", latest_receipt.proof.cre_workflow_id)
    if isinstance(options.get("proof_policy"), dict):
        policy.update(_sanitize_canonical_value(options["proof_policy"]))
    if isinstance(proof_policy, ProofReceipt):
        policy.update(
            {
                "mode": proof_policy.policy,
                "verifier": proof_policy.verifier,
                "cre_workflow_id": proof_policy.cre_workflow_id,
                "verified": proof_policy.verified,
            }
        )
    elif isinstance(proof_policy, dict):
        policy.update(_sanitize_canonical_value(proof_policy))
    return policy


def _proof_mode_from_policy(policy: dict[str, Any]) -> str:
    return str(policy.get("mode") or policy.get("policy") or "receipt_only").strip() or "receipt_only"


def _policy_bool(policy: dict[str, Any], *keys: str) -> bool:
    for key in keys:
        if key in policy:
            return _coerce_bool(policy.get(key), default=False)
    return False


def _operator_count_for_health(
    *,
    options: dict[str, Any],
    config: dict[str, Any],
    operators: Any,
    receipts: list[ConsensusReceipt],
) -> int:
    if operators is not None:
        return len(list(operators))
    for source in (options, config):
        for key in ("operator_count", "operatorCount"):
            value = source.get(key)
            if value not in (None, ""):
                return max(0, int(value))
    peers = config.get("peers")
    if isinstance(peers, list) and peers:
        return len(peers)
    if receipts:
        return len(receipts[-1].responses)
    return int(config.get("min_operators") or 0)


def consensus_receipt_counts(receipts: Any) -> dict[str, int]:
    """Return count-only receipt metrics safe for health and readiness output."""

    receipt_list = _coerce_health_receipts(receipts)
    counts = {
        "receipt_count": 0,
        "accepted_receipt_count": 0,
        "failed_receipt_count": 0,
        "quorum_met_receipt_count": 0,
        "quorum_not_met_receipt_count": 0,
        "operator_response_count": 0,
        "successful_operator_response_count": 0,
        "failed_operator_response_count": 0,
        "verified_proof_receipt_count": 0,
        "unverified_proof_receipt_count": 0,
        "cre_receipt_count": 0,
    }
    for receipt in receipt_list:
        counts["receipt_count"] += 1
        if receipt.consensus.accepted:
            counts["accepted_receipt_count"] += 1
        else:
            counts["failed_receipt_count"] += 1
        if receipt.consensus.reason == "quorum_met":
            counts["quorum_met_receipt_count"] += 1
        elif receipt.consensus.reason == "quorum_not_met":
            counts["quorum_not_met_receipt_count"] += 1

        counts["operator_response_count"] += len(receipt.responses)
        for response in receipt.responses:
            if not response.error and response.output_hash and response.normalized_output_hash:
                counts["successful_operator_response_count"] += 1
            else:
                counts["failed_operator_response_count"] += 1

        if receipt.proof.verified:
            counts["verified_proof_receipt_count"] += 1
        else:
            counts["unverified_proof_receipt_count"] += 1
        if _receipt_cre_workflow_present(receipt):
            counts["cre_receipt_count"] += 1
    return counts


def consensus_health_summary(
    options: dict[str, Any] | None = None,
    *,
    env: dict[str, str] | None = None,
    operators: Any = None,
    receipts: Any = None,
    proof_policy: dict[str, Any] | ProofReceipt | None = None,
    last_failure_reason: str | None = None,
) -> dict[str, Any]:
    """Build a redacted consensus health summary for readiness reporting."""

    explicit_options = dict(options or {})
    config = load_consensus_config(explicit_options, env=env)
    receipt_list = _coerce_health_receipts(receipts)
    policy = _proof_policy_from_inputs(
        proof_policy=proof_policy,
        options=explicit_options,
        receipts=receipt_list,
    )
    proof_mode = _proof_mode_from_policy(policy)
    operator_count = _operator_count_for_health(
        options=explicit_options,
        config=config,
        operators=operators,
        receipts=receipt_list,
    )
    cre_workflow_id_present = any(
        (
            _present(config.get("cre_workflow_id")),
            _present(policy.get("cre_workflow_id")),
            any(_receipt_cre_workflow_present(receipt) for receipt in receipt_list),
        )
    )

    normalized_mode = str(config["mode"]).strip().lower()
    normalized_proof_mode = proof_mode.lower()
    cre_workflow_required = (
        normalized_mode in {"chainlink_cre", "hybrid"}
        or normalized_proof_mode == "chainlink_cre"
        or _policy_bool(policy, "cre_verified", "creVerified")
    )
    verifier_present = any(
        _present(value)
        for value in (
            config.get("proof_verifier"),
            policy.get("verifier"),
            policy.get("verifier_id"),
            policy.get("verifierId"),
            policy.get("verifier_key_hash"),
            policy.get("verifierKeyHash"),
            policy.get("circuit_id"),
            policy.get("circuitId"),
        )
    )
    verifier_contract_present = any(
        _present(value)
        for value in (
            config.get("verifier_contract"),
            policy.get("verifier_contract"),
            policy.get("verifierContract"),
            policy.get("verifier_contract_address"),
            policy.get("verifierContractAddress"),
        )
    )
    verifier_required = normalized_proof_mode in {"zkml_required", "tee_or_zkml"}
    operator_ready = operator_count >= max(int(config["quorum"]), int(config["min_operators"]))
    proof_ready = not verifier_required or verifier_present or verifier_contract_present
    cre_ready = not cre_workflow_required or cre_workflow_id_present
    enabled = bool(config["enabled"])
    ready = bool(enabled and operator_ready and proof_ready and cre_ready)
    status = "ready" if ready else ("disabled" if not enabled else "not_ready")
    resolved_last_failure_reason = (
        _safe_observability_reason(last_failure_reason)
        if last_failure_reason is not None
        else _last_failure_reason_from_receipts(receipt_list)
    )

    return {
        "schema_version": "llm-consensus-health-summary-v1",
        "status": status,
        "ready": ready,
        "enabled": enabled,
        "configured_mode": str(config["mode"]),
        "comparison": str(config["comparison"]),
        "quorum": int(config["quorum"]),
        "min_operators": int(config["min_operators"]),
        "operator_count": int(operator_count),
        "fail_closed": bool(config["fail_closed"]),
        "cre_workflow_id_present": bool(cre_workflow_id_present),
        "proof_verifier_policy": {
            "mode": proof_mode,
            "requires_verifier": bool(verifier_required),
            "verifier_present": bool(verifier_present),
            "verifier_contract_present": bool(verifier_contract_present),
            "cre_workflow_required": bool(cre_workflow_required),
            "require_signatures": _policy_bool(policy, "require_signatures", "requireSignatures"),
        },
        "last_failure_reason": resolved_last_failure_reason,
        "redacted_receipt_counts": consensus_receipt_counts(receipt_list),
    }


def build_p2p_request_payload(
    request: ConsensusRequest,
    prompt: str,
    *,
    redact_prompt_in_receipt: bool = True,
    operator_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the libp2p request payload for remote consensus operators."""

    payload: dict[str, Any] = {
        "schema_version": P2P_REQUEST_SCHEMA_VERSION,
        "request_id": request.request_id,
        "request_hash": request.request_hash or "",
        "model_name": request.model_name or "",
        "provider": request.provider or "",
        "prompt": str(prompt or ""),
        "generation_params": _sanitize_canonical_value(request.generation_params),
        "proof_policy": _sanitize_canonical_value(request.proof_policy),
        "comparison": request.comparison or "exact",
        "quorum": int(request.quorum),
        "min_operators": int(request.min_operators),
        "nonce": str(request.metadata.get("nonce") or ""),
        "deadline_unix_ms": int(request.deadline_unix_ms or 0),
        "redact_prompt_in_receipt": bool(redact_prompt_in_receipt),
    }
    if operator_metadata:
        payload["operator_metadata"] = _sanitize_canonical_value(operator_metadata)
    return _jsonable(payload)


def parse_p2p_response_payload(
    data: dict[str, Any],
    *,
    peer_id: str | None = None,
    operator_id: str | None = None,
    latency_ms: int = 0,
    comparison: str = "exact",
) -> OperatorResponse:
    """Parse a libp2p consensus response into an :class:`OperatorResponse`."""

    schema_version = str(data.get("schema_version") or "")
    if schema_version and schema_version != P2P_RESPONSE_SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported p2p response schema_version: {schema_version!r}. "
            f"Expected: {P2P_RESPONSE_SCHEMA_VERSION!r}"
        )

    resolved_peer_id = peer_id or data.get("peer_id")
    resolved_peer_id = str(resolved_peer_id) if resolved_peer_id is not None else None
    resolved_operator_id = operator_id or data.get("operator_id") or resolved_peer_id or "unknown"
    output_text = str(data.get("output_text") or "")
    output_hash = str(data.get("output_hash") or "")
    if not output_hash and output_text:
        output_hash = sha256_digest(output_text)
    resolved_error = str(data["error"]) if data.get("error") is not None else None

    normalized_hash = str(data.get("normalized_output_hash") or "")
    if not normalized_hash and output_text and not resolved_error:
        try:
            normalized_hash = normalized_output_hash(output_text, comparison=comparison)
        except Exception as exc:
            resolved_error = f"{type(exc).__name__}: {exc}"
            output_hash = ""

    parsed_latency = data.get("latency_ms")
    try:
        resolved_latency_ms = int(parsed_latency) if parsed_latency is not None else int(latency_ms)
    except (TypeError, ValueError):
        resolved_latency_ms = int(latency_ms)

    attestation = data.get("attestation")
    return OperatorResponse(
        operator_id=str(resolved_operator_id),
        transport="libp2p",
        peer_id=resolved_peer_id,
        provider=str(data.get("provider") or ""),
        model_name=str(data["model_name"]) if data.get("model_name") is not None else None,
        output_text=output_text,
        output_hash=output_hash,
        normalized_output_hash=normalized_hash,
        latency_ms=resolved_latency_ms,
        error=resolved_error,
        signature=str(data["signature"]) if data.get("signature") is not None else None,
        attestation=attestation if isinstance(attestation, dict) else None,
        metadata=_dict_value(data, "metadata"),
    )


@dataclass(frozen=True)
class P2PConsensusPeer:
    """Explicit libp2p peer configuration for consensus fan-out."""

    peer_id: str
    multiaddr: str
    operator_id: str | None = None
    provider: str | None = None
    model_name: str | None = None


@dataclass(frozen=True)
class LocalConsensusOperator:
    """Synchronous local operator adapter for deterministic consensus tests."""

    operator_id: str
    handler: Callable[[ConsensusRequest], str | OperatorResponse]
    provider: str = "local"
    transport: str = "local"
    model_name: str | None = None

    def respond(self, request: ConsensusRequest) -> str | OperatorResponse:
        return self.handler(request)


def _operator_id(operator: Any, index: int) -> str:
    value = getattr(operator, "operator_id", None)
    text = str(value or "").strip()
    return text or f"operator-{index}"


def _operator_provider(operator: Any) -> str:
    value = getattr(operator, "provider", None)
    text = str(value or "").strip()
    return text or "local"


def _operator_transport(operator: Any) -> str:
    value = getattr(operator, "transport", None)
    text = str(value or "").strip()
    return text or "local"


def _operator_model_name(operator: Any, request: ConsensusRequest) -> str | None:
    value = getattr(operator, "model_name", None)
    if value is not None and str(value).strip():
        return str(value)
    return request.model_name


def _timeout_response(operator: Any, index: int, request: ConsensusRequest, *, timeout_s: float) -> OperatorResponse:
    return OperatorResponse(
        operator_id=_operator_id(operator, index),
        transport=_operator_transport(operator),
        provider=_operator_provider(operator),
        model_name=_operator_model_name(operator, request),
        output_text="",
        output_hash="",
        normalized_output_hash="",
        latency_ms=int(max(0.0, timeout_s) * 1000),
        error="timeout",
    )


def _error_response(operator: Any, index: int, request: ConsensusRequest, *, error: BaseException, latency_ms: int) -> OperatorResponse:
    return OperatorResponse(
        operator_id=_operator_id(operator, index),
        transport=_operator_transport(operator),
        provider=_operator_provider(operator),
        model_name=_operator_model_name(operator, request),
        output_text="",
        output_hash="",
        normalized_output_hash="",
        latency_ms=latency_ms,
        error=f"{type(error).__name__}: {error}",
    )


def _coerce_operator_response(
    result: str | OperatorResponse,
    *,
    operator: Any,
    index: int,
    request: ConsensusRequest,
    latency_ms: int,
) -> OperatorResponse:
    if isinstance(result, OperatorResponse):
        return replace(result, latency_ms=result.latency_ms or latency_ms)

    output_text = str(result or "")
    return OperatorResponse(
        operator_id=_operator_id(operator, index),
        transport=_operator_transport(operator),
        provider=_operator_provider(operator),
        model_name=_operator_model_name(operator, request),
        output_text=output_text,
        output_hash=sha256_digest(output_text),
        normalized_output_hash=normalized_output_hash(output_text, comparison=request.comparison),
        latency_ms=latency_ms,
    )


def _invoke_local_operator(operator: Any, index: int, request: ConsensusRequest) -> OperatorResponse:
    started = time.monotonic()
    try:
        responder = getattr(operator, "respond", None)
        if callable(responder):
            result = responder(request)
        elif callable(operator):
            result = operator(request)
        else:
            raise TypeError("operator must be callable or expose respond(request)")
        latency_ms = int((time.monotonic() - started) * 1000)
        return _coerce_operator_response(
            result,
            operator=operator,
            index=index,
            request=request,
            latency_ms=latency_ms,
        )
    except BaseException as exc:
        latency_ms = int((time.monotonic() - started) * 1000)
        return _error_response(operator, index, request, error=exc, latency_ms=latency_ms)


@dataclass(frozen=True)
class _ResolvedP2PPeer:
    remote: Any
    peer_id: str
    multiaddr: str
    operator_id: str
    provider: str
    model_name: str | None


def _load_p2p_task_client() -> tuple[Any, Callable[..., Any], Callable[..., Any]]:
    try:
        from ipfs_datasets_py.ml.accelerate_integration import p2p_task_client
    except Exception as exc:
        raise LLMConsensusError("libp2p task client is not available") from exc
    return p2p_task_client.RemoteQueue, p2p_task_client.submit_task, p2p_task_client.wait_task


def _peer_config_value(peer: Any, key: str, default: Any = None) -> Any:
    if isinstance(peer, dict):
        return peer.get(key, default)
    return getattr(peer, key, default)


def _extract_peer_id_from_multiaddr(multiaddr: str) -> str:
    text = str(multiaddr or "").strip()
    if not text:
        return ""
    match = re.search(r"/p2p/([^/]+)(?:/)?$", text)
    return (match.group(1) if match else "").strip()


def _resolve_p2p_peers(
    peers: list[Any] | tuple[Any, ...],
    *,
    remote_queue_factory: Any | None = None,
) -> list[_ResolvedP2PPeer]:
    resolved: list[_ResolvedP2PPeer] = []
    for index, peer in enumerate(peers or ()):
        multiaddr = str(_peer_config_value(peer, "multiaddr", "") or "").strip()
        peer_id = str(_peer_config_value(peer, "peer_id", "") or "").strip()
        if not peer_id:
            peer_id = _extract_peer_id_from_multiaddr(multiaddr)
        if not peer_id:
            peer_id = f"peer-{index}"
        operator_id = str(_peer_config_value(peer, "operator_id", None) or peer_id)
        provider = str(_peer_config_value(peer, "provider", "") or "")
        model_name_value = _peer_config_value(peer, "model_name", None)
        model_name = str(model_name_value) if model_name_value is not None else None

        if remote_queue_factory is None:
            remote = peer if hasattr(peer, "peer_id") and hasattr(peer, "multiaddr") else P2PConsensusPeer(peer_id, multiaddr)
        elif isinstance(remote_queue_factory, type) and isinstance(peer, remote_queue_factory):
            remote = peer
        else:
            remote = remote_queue_factory(peer_id=peer_id, multiaddr=multiaddr)

        resolved.append(
            _ResolvedP2PPeer(
                remote=remote,
                peer_id=peer_id,
                multiaddr=multiaddr,
                operator_id=operator_id,
                provider=provider,
                model_name=model_name,
            )
        )
    return resolved


def _p2p_empty_response(
    peer: _ResolvedP2PPeer,
    request: ConsensusRequest,
    *,
    error: str,
    latency_ms: int,
) -> OperatorResponse:
    metadata = {"peer_id": peer.peer_id}
    if peer.multiaddr:
        metadata["multiaddr"] = peer.multiaddr
    return OperatorResponse(
        operator_id=peer.operator_id,
        transport="libp2p",
        peer_id=peer.peer_id,
        provider=peer.provider or str(request.provider or ""),
        model_name=peer.model_name or request.model_name,
        output_text="",
        output_hash="",
        normalized_output_hash="",
        latency_ms=max(0, int(latency_ms)),
        error=error,
        metadata=metadata,
    )


def _p2p_timeout_response(peer: _ResolvedP2PPeer, request: ConsensusRequest, *, timeout_s: float) -> OperatorResponse:
    return _p2p_empty_response(
        peer,
        request,
        error="timeout",
        latency_ms=int(max(0.0, float(timeout_s)) * 1000),
    )


def _p2p_error_response(
    peer: _ResolvedP2PPeer,
    request: ConsensusRequest,
    *,
    error: BaseException | str,
    latency_ms: int,
) -> OperatorResponse:
    message = str(error) if isinstance(error, str) else f"{type(error).__name__}: {error}"
    return _p2p_empty_response(peer, request, error=message, latency_ms=latency_ms)


async def _maybe_await_call(fn: Callable[..., Any], **kwargs: Any) -> Any:
    value = fn(**kwargs)
    if inspect.isawaitable(value):
        return await value
    return value


def _p2p_task_id(submission: Any) -> str:
    if isinstance(submission, str):
        return submission.strip()
    if isinstance(submission, dict):
        for key in ("task_id", "id"):
            value = submission.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
    return ""


def _has_p2p_response_fields(data: dict[str, Any]) -> bool:
    response_keys = {
        "attestation",
        "error",
        "normalized_output_hash",
        "operator_id",
        "output_hash",
        "output_text",
        "signature",
    }
    if str(data.get("schema_version") or "") == P2P_RESPONSE_SCHEMA_VERSION:
        return True
    return any(key in data and data.get(key) not in (None, "") for key in response_keys)


def _extract_text_from_p2p_result(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("text", "generated_text", "output_text", "completion", "content", "response"):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                return item.strip()
        for key in ("result", "data", "output", "payload"):
            nested = _extract_text_from_p2p_result(value.get(key))
            if nested:
                return nested
        choices = value.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                message = first.get("message")
                if isinstance(message, dict) and isinstance(message.get("content"), str):
                    return str(message["content"]).strip()
                if isinstance(first.get("text"), str):
                    return str(first["text"]).strip()
    return ""


def _p2p_payload_from_task_result(result: Any, *, status: str = "") -> tuple[dict[str, Any], str]:
    if isinstance(result, OperatorResponse):
        return result.to_dict(), status
    if isinstance(result, str):
        return {"output_text": result}, status
    if not isinstance(result, dict):
        return {"output_text": str(result or "")}, status

    current_status = str(result.get("status") or status or "").strip().lower()
    if current_status in P2P_FAILED_STATUSES:
        return {
            "output_text": "",
            "output_hash": "",
            "normalized_output_hash": "",
            "error": str(result.get("error") or current_status),
            "metadata": {"task_status": current_status},
        }, current_status
    if current_status in P2P_PENDING_STATUSES:
        return {
            "output_text": "",
            "output_hash": "",
            "normalized_output_hash": "",
            "error": "timeout",
            "metadata": {"task_status": current_status},
        }, current_status
    if current_status in P2P_COMPLETED_STATUSES and result.get("result") is not None:
        return _p2p_payload_from_task_result(result.get("result"), status=current_status)
    if _has_p2p_response_fields(result):
        return dict(result), current_status

    for key in ("result", "output", "data", "payload"):
        nested = result.get(key)
        if nested is not None:
            return _p2p_payload_from_task_result(nested, status=current_status)

    return {"output_text": _extract_text_from_p2p_result(result)}, current_status


def _operator_response_from_p2p_result(
    result: Any,
    *,
    peer: _ResolvedP2PPeer,
    request: ConsensusRequest,
    latency_ms: int,
) -> OperatorResponse:
    if result is None:
        return _p2p_empty_response(peer, request, error="timeout", latency_ms=latency_ms)

    payload, status = _p2p_payload_from_task_result(result)
    payload = dict(payload)
    payload.setdefault("operator_id", peer.operator_id)
    payload.setdefault("peer_id", peer.peer_id)
    payload.setdefault("provider", peer.provider or str(request.provider or ""))
    payload.setdefault("model_name", peer.model_name or request.model_name)

    metadata = dict(payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {})
    if status:
        metadata.setdefault("task_status", status)
    if peer.multiaddr:
        metadata.setdefault("multiaddr", peer.multiaddr)
    payload["metadata"] = metadata

    return parse_p2p_response_payload(
        payload,
        peer_id=peer.peer_id,
        operator_id=peer.operator_id,
        latency_ms=latency_ms,
        comparison=request.comparison,
    )


async def _query_p2p_peer(
    peer: _ResolvedP2PPeer,
    *,
    request: ConsensusRequest,
    payload: dict[str, Any],
    submit_task_fn: Callable[..., Any],
    wait_task_fn: Callable[..., Any],
    task_type: str,
    per_peer_timeout_s: float,
) -> OperatorResponse:
    started = time.monotonic()
    try:
        submission = await asyncio.wait_for(
            _maybe_await_call(
                submit_task_fn,
                remote=peer.remote,
                task_type=task_type,
                model_name=str(request.model_name or ""),
                payload=dict(payload),
            ),
            timeout=max(0.0, float(per_peer_timeout_s)),
        )
        task_id = _p2p_task_id(submission)
        if not task_id:
            raise LLMConsensusError(f"p2p submit_task did not return a task_id: {submission!r}")

        result = await asyncio.wait_for(
            _maybe_await_call(
                wait_task_fn,
                remote=peer.remote,
                task_id=task_id,
                timeout_s=max(0.0, float(per_peer_timeout_s)),
            ),
            timeout=max(0.0, float(per_peer_timeout_s)),
        )
        latency_ms = int((time.monotonic() - started) * 1000)
        return _operator_response_from_p2p_result(
            result,
            peer=peer,
            request=request,
            latency_ms=latency_ms,
        )
    except asyncio.TimeoutError:
        return _p2p_timeout_response(peer, request, timeout_s=per_peer_timeout_s)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        latency_ms = int((time.monotonic() - started) * 1000)
        return _p2p_error_response(peer, request, error=exc, latency_ms=latency_ms)


async def fan_out_p2p_consensus(
    *,
    request: ConsensusRequest,
    prompt: str,
    peers: list[Any] | tuple[Any, ...],
    timeout_s: float = 60.0,
    per_peer_timeout_s: float | None = None,
    submit_task_fn: Callable[..., Any] | None = None,
    wait_task_fn: Callable[..., Any] | None = None,
    remote_queue_factory: Any | None = None,
    task_type: str = P2P_REQUEST_SCHEMA_VERSION,
    redact_prompt_in_receipt: bool = True,
    operator_metadata: dict[str, Any] | None = None,
) -> list[OperatorResponse]:
    """Submit one consensus request payload to explicit libp2p peers concurrently."""

    if not peers:
        raise LLMConsensusError("At least one p2p consensus peer is required")

    if submit_task_fn is None or wait_task_fn is None:
        default_remote_queue, default_submit_task, default_wait_task = _load_p2p_task_client()
        remote_queue_factory = remote_queue_factory or default_remote_queue
        submit_task_fn = submit_task_fn or default_submit_task
        wait_task_fn = wait_task_fn or default_wait_task

    resolved_peers = _resolve_p2p_peers(list(peers), remote_queue_factory=remote_queue_factory)
    payload = build_p2p_request_payload(
        request,
        prompt,
        redact_prompt_in_receipt=redact_prompt_in_receipt,
        operator_metadata=operator_metadata,
    )
    effective_timeout_s = max(0.0, float(timeout_s))
    effective_per_peer_timeout_s = (
        max(0.0, float(per_peer_timeout_s))
        if per_peer_timeout_s is not None
        else effective_timeout_s
    )

    task_map = {
        asyncio.create_task(
            _query_p2p_peer(
                peer,
                request=request,
                payload=payload,
                submit_task_fn=submit_task_fn,
                wait_task_fn=wait_task_fn,
                task_type=task_type,
                per_peer_timeout_s=effective_per_peer_timeout_s,
            )
        ): peer
        for peer in resolved_peers
    }
    done, pending = await asyncio.wait(task_map, timeout=effective_timeout_s)

    responses: list[OperatorResponse] = []
    for task in done:
        peer = task_map[task]
        try:
            responses.append(task.result())
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            responses.append(_p2p_error_response(peer, request, error=exc, latency_ms=0))

    for task in pending:
        peer = task_map[task]
        task.cancel()
        responses.append(_p2p_timeout_response(peer, request, timeout_s=effective_timeout_s))
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    return sorted(responses, key=lambda response: response.operator_id)


def _selected_text_from_responses(responses: list[OperatorResponse], consensus: ConsensusResult) -> str:
    if not consensus.accepted:
        return ""
    for response in responses:
        if (
            response.operator_id in consensus.selected_operator_ids
            and response.output_hash == consensus.selected_output_hash
            and response.normalized_output_hash == consensus.selected_normalized_hash
        ):
            return response.output_text
    return ""


async def run_p2p_consensus_async(
    *,
    request: ConsensusRequest,
    prompt: str,
    peers: list[Any] | tuple[Any, ...],
    timeout_s: float = 60.0,
    per_peer_timeout_s: float | None = None,
    fail_closed: bool = True,
    proof: ProofReceipt | None = None,
    created_at: str | None = None,
    receipt_path: str | os.PathLike[str] | None = None,
    receipt_jsonl_path: str | os.PathLike[str] | None = None,
    submit_task_fn: Callable[..., Any] | None = None,
    wait_task_fn: Callable[..., Any] | None = None,
    remote_queue_factory: Any | None = None,
    task_type: str = P2P_REQUEST_SCHEMA_VERSION,
    redact_prompt_in_receipt: bool = True,
    operator_metadata: dict[str, Any] | None = None,
) -> ConsensusReceipt:
    """Run libp2p fan-out consensus and return a receipt."""

    responses = await fan_out_p2p_consensus(
        request=request,
        prompt=prompt,
        peers=peers,
        timeout_s=timeout_s,
        per_peer_timeout_s=per_peer_timeout_s,
        submit_task_fn=submit_task_fn,
        wait_task_fn=wait_task_fn,
        remote_queue_factory=remote_queue_factory,
        task_type=task_type,
        redact_prompt_in_receipt=redact_prompt_in_receipt,
        operator_metadata=operator_metadata,
    )
    consensus = select_consensus_result(
        responses,
        quorum=request.quorum,
        comparison=request.comparison,
        fail_closed=fail_closed,
    )
    resolved_proof = proof or ProofReceipt(
        policy=str(request.proof_policy.get("mode") or "receipt_only"),
        verified=False,
    )
    receipt = ConsensusReceipt(
        request=request,
        responses=responses,
        consensus=consensus,
        proof=resolved_proof,
        text=_selected_text_from_responses(responses, consensus),
        created_at=created_at or utc_now_iso(),
    )
    if receipt_path:
        persist_consensus_receipt(receipt, path=receipt_path, append_jsonl=False)
    if receipt_jsonl_path:
        persist_consensus_receipt(receipt, path=receipt_jsonl_path, append_jsonl=True)
    return receipt


def run_p2p_consensus(
    *,
    request: ConsensusRequest,
    prompt: str,
    peers: list[Any] | tuple[Any, ...],
    timeout_s: float = 60.0,
    per_peer_timeout_s: float | None = None,
    fail_closed: bool = True,
    proof: ProofReceipt | None = None,
    created_at: str | None = None,
    receipt_path: str | os.PathLike[str] | None = None,
    receipt_jsonl_path: str | os.PathLike[str] | None = None,
    submit_task_fn: Callable[..., Any] | None = None,
    wait_task_fn: Callable[..., Any] | None = None,
    remote_queue_factory: Any | None = None,
    task_type: str = P2P_REQUEST_SCHEMA_VERSION,
    redact_prompt_in_receipt: bool = True,
    operator_metadata: dict[str, Any] | None = None,
) -> ConsensusReceipt:
    """Synchronous wrapper for :func:`run_p2p_consensus_async`."""

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(
            run_p2p_consensus_async(
                request=request,
                prompt=prompt,
                peers=peers,
                timeout_s=timeout_s,
                per_peer_timeout_s=per_peer_timeout_s,
                fail_closed=fail_closed,
                proof=proof,
                created_at=created_at,
                receipt_path=receipt_path,
                receipt_jsonl_path=receipt_jsonl_path,
                submit_task_fn=submit_task_fn,
                wait_task_fn=wait_task_fn,
                remote_queue_factory=remote_queue_factory,
                task_type=task_type,
                redact_prompt_in_receipt=redact_prompt_in_receipt,
                operator_metadata=operator_metadata,
            )
        )
    raise LLMConsensusError("run_p2p_consensus_async must be used from a running event loop")


def run_local_consensus(
    *,
    request: ConsensusRequest,
    operators: list[Any] | tuple[Any, ...],
    timeout_s: float = 60.0,
    operator_timeout_s: float | None = None,
    fail_closed: bool = True,
    proof: ProofReceipt | None = None,
    created_at: str | None = None,
    receipt_path: str | os.PathLike[str] | None = None,
    receipt_jsonl_path: str | os.PathLike[str] | None = None,
) -> ConsensusReceipt:
    """Run consensus against explicit local operators and return a receipt."""

    operator_list = list(operators or ())
    if not operator_list:
        raise LLMConsensusError("At least one consensus operator is required")

    max_workers = max(1, len(operator_list))
    executor = ThreadPoolExecutor(max_workers=max_workers)
    future_map = {
        executor.submit(_invoke_local_operator, operator, index, request): (operator, index)
        for index, operator in enumerate(operator_list)
    }

    effective_timeout_s = max(0.0, float(timeout_s))
    done, pending = wait(future_map, timeout=effective_timeout_s)
    responses: list[OperatorResponse] = []

    for future in done:
        operator, index = future_map[future]
        try:
            response = future.result()
        except BaseException as exc:
            response = _error_response(operator, index, request, error=exc, latency_ms=0)
        if operator_timeout_s is not None and response.latency_ms > int(max(0.0, float(operator_timeout_s)) * 1000):
            response = replace(
                response,
                output_text="",
                output_hash="",
                normalized_output_hash="",
                error="timeout",
            )
        responses.append(response)

    for future in pending:
        operator, index = future_map[future]
        future.cancel()
        responses.append(_timeout_response(operator, index, request, timeout_s=effective_timeout_s))

    executor.shutdown(wait=False, cancel_futures=True)
    responses = sorted(responses, key=lambda response: response.operator_id)

    consensus = select_consensus_result(
        responses,
        quorum=request.quorum,
        comparison=request.comparison,
        fail_closed=fail_closed,
    )
    selected_text = ""
    if consensus.accepted:
        for response in responses:
            if (
                response.operator_id in consensus.selected_operator_ids
                and response.output_hash == consensus.selected_output_hash
                and response.normalized_output_hash == consensus.selected_normalized_hash
            ):
                selected_text = response.output_text
                break

    resolved_proof = proof or ProofReceipt(
        policy=str(request.proof_policy.get("mode") or "receipt_only"),
        verified=False,
    )
    receipt = ConsensusReceipt(
        request=request,
        responses=responses,
        consensus=consensus,
        proof=resolved_proof,
        text=selected_text,
        created_at=created_at or utc_now_iso(),
    )
    if receipt_path:
        persist_consensus_receipt(receipt, path=receipt_path, append_jsonl=False)
    if receipt_jsonl_path:
        persist_consensus_receipt(receipt, path=receipt_jsonl_path, append_jsonl=True)
    return receipt


__all__ = [
    "CONSENSUS_RECEIPT_SCHEMA_VERSION",
    "P2P_REQUEST_SCHEMA_VERSION",
    "P2P_RESPONSE_SCHEMA_VERSION",
    "DEFAULT_DOMAIN_SEPARATOR",
    "LLMConsensusError",
    "ConsensusRequest",
    "OperatorResponse",
    "ConsensusResult",
    "ProofReceipt",
    "ConsensusReceipt",
    "LocalConsensusOperator",
    "P2PConsensusPeer",
    "build_p2p_request_payload",
    "build_consensus_request",
    "canonical_request_hash",
    "canonical_request_payload",
    "consensus_health_summary",
    "consensus_receipt_counts",
    "fan_out_p2p_consensus",
    "is_advisory_comparison",
    "load_consensus_config",
    "normalize_output_text",
    "normalized_output_hash",
    "operator_signature_payload",
    "parse_p2p_response_payload",
    "persist_consensus_receipt",
    "receipt_content_hash",
    "receipt_persistence_record",
    "run_local_consensus",
    "run_p2p_consensus",
    "run_p2p_consensus_async",
    "select_consensus_result",
    "sha256_digest",
    "sign_operator_response",
    "utc_now_iso",
    "verify_operator_response_signature",
]
