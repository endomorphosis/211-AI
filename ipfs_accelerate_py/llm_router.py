"""Compatibility wrapper around :mod:`ipfs_datasets_py.llm_router`."""

from __future__ import annotations

import json
import importlib
from dataclasses import dataclass
from types import ModuleType
from typing import Any

from .llm_consensus import (
    ConsensusReceipt,
    LocalConsensusOperator,
    build_consensus_request,
    load_consensus_config,
    run_local_consensus,
)


class _LazyDatasetsLLMRouter:
    """Load the upstream datasets router only when a delegated API is used."""

    _module: ModuleType | None

    def __init__(self) -> None:
        object.__setattr__(self, "_module", None)

    def _load(self) -> ModuleType:
        module = object.__getattribute__(self, "_module")
        if module is None:
            module = importlib.import_module("ipfs_datasets_py.llm_router")
            object.__setattr__(self, "_module", module)
        return module

    def __getattr__(self, name: str) -> Any:
        return getattr(self._load(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "_module":
            object.__setattr__(self, name, value)
            return
        setattr(self._load(), name, value)

    def __delattr__(self, name: str) -> None:
        if name == "_module":
            object.__delattr__(self, name)
            return
        delattr(self._load(), name)


_datasets_llm_router = _LazyDatasetsLLMRouter()


def _normalize_provider(provider: str | None) -> str | None:
    raw = (provider or "").strip()
    if not raw:
        return None
    if raw.lower() in {"hf", "huggingface"}:
        return "hf_inference_api"
    return raw


def generate_text(prompt: str, *args: Any, provider: str | None = None, **kwargs: Any) -> str:
    return str(
        _datasets_llm_router.generate_text(
            prompt,
            *args,
            provider=_normalize_provider(provider),
            **kwargs,
        )
    )


def get_llm_provider(provider: str | None = None, *args: Any, **kwargs: Any) -> Any:
    return _datasets_llm_router.get_llm_provider(_normalize_provider(provider), *args, **kwargs)


def clear_llm_router_caches() -> None:
    _datasets_llm_router.clear_llm_router_caches()


def generate_text_consensus(
    prompt: str,
    *,
    model_name: str | None = None,
    provider: str | None = None,
    consensus: dict[str, Any] | None = None,
    proof_policy: dict[str, Any] | None = None,
    operators: list[Any] | tuple[Any, ...] | None = None,
    return_receipt: bool = True,
    **kwargs: Any,
) -> ConsensusReceipt | str:
    options = load_consensus_config(dict(consensus or {}))
    if not options["enabled"]:
        text = generate_text(prompt, provider=provider, model_name=model_name, **kwargs)
        return text if not return_receipt else run_local_consensus(
            request=build_consensus_request(
                prompt=prompt,
                provider=_normalize_provider(provider),
                model_name=model_name,
                generation_params=dict(kwargs),
                proof_policy=dict(proof_policy or {"mode": "receipt_only"}),
                comparison=options["comparison"],
                quorum=1,
                min_operators=1,
                metadata={"mode": "disabled"},
            ),
            operators=[LocalConsensusOperator("disabled-local-router", lambda _: text, provider=_normalize_provider(provider) or "auto")],
            fail_closed=False,
        )
    normalized_provider = _normalize_provider(provider)

    response_schema = kwargs.get("response_schema")
    if response_schema is None:
        response_schema = kwargs.get("response_format")

    request = build_consensus_request(
        prompt=prompt,
        request_id=str(options["request_id"] or "") or None,
        provider=normalized_provider,
        model_name=model_name,
        model_commitment=str(options["model_commitment"] or "") or None,
        tokenizer_commitment=str(options["tokenizer_commitment"] or "") or None,
        generation_params=dict(kwargs),
        response_schema=response_schema if isinstance(response_schema, dict) else {},
        proof_policy=dict(proof_policy or {"mode": "receipt_only"}),
        nonce=str(options["nonce"]) if options["nonce"] is not None else None,
        deadline_unix_ms=int(options["deadline_unix_ms"]),
        prompt_cid=str(options["prompt_cid"]) if options["prompt_cid"] is not None else None,
        context_cids=list(options["context_cids"]),
        prompt_redaction_policy=str(options["prompt_redaction_policy"]),
        comparison=str(options["comparison"]),
        quorum=int(options["quorum"]),
        min_operators=int(options["min_operators"]),
        metadata={"mode": str(options["mode"])},
    )

    resolved_operators: list[Any]
    if operators:
        resolved_operators = list(operators)
    else:
        operator_kwargs = dict(kwargs)

        def _generate(_: Any) -> str:
            return str(
                _datasets_llm_router.generate_text(
                    prompt,
                    model_name=model_name,
                    provider=normalized_provider,
                    **operator_kwargs,
                )
            )

        resolved_operators = [
            LocalConsensusOperator(
                operator_id=str(options["operator_id"] or "local-router"),
                handler=_generate,
                provider=normalized_provider or "auto",
                model_name=model_name,
            )
        ]

    receipt = run_local_consensus(
        request=request,
        operators=resolved_operators,
        timeout_s=float(options["timeout_s"]),
        operator_timeout_s=options["operator_timeout_s"],
        fail_closed=bool(options["fail_closed"]),
        receipt_path=options["receipt_path"],
        receipt_jsonl_path=options["receipt_jsonl_path"],
    )
    return receipt if return_receipt else receipt.text


def __getattr__(name: str) -> Any:
    return getattr(_datasets_llm_router, name)


@dataclass
class ChatMessage:
    """Minimal OpenAI-compatible chat message."""

    role: str
    content: str


@dataclass
class ChatChoice:
    """Minimal OpenAI-compatible chat choice."""

    message: ChatMessage
    index: int = 0
    finish_reason: str = "stop"


@dataclass
class ChatCompletionResponse:
    """Minimal OpenAI-compatible chat completion response."""

    choices: list[ChatChoice]
    receipt: ConsensusReceipt | None = None

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


def _canonicalize_messages(messages: list[dict[str, Any]]) -> str:
    """Convert OpenAI-style messages to a canonical prompt string for consensus."""
    parts: list[str] = []
    for msg in messages:
        role = str(msg.get("role") or "user").strip()
        content = str(msg.get("content") or "").strip()
        parts.append(f"{role}: {content}")
    return "\n".join(parts)


def chat_completions_create_consensus(
    messages: list[dict[str, Any]],
    *,
    model_name: str | None = None,
    provider: str | None = None,
    consensus: dict[str, Any] | None = None,
    proof_policy: dict[str, Any] | None = None,
    operators: list[Any] | tuple[Any, ...] | None = None,
    return_receipt: bool = True,
    **kwargs: Any,
) -> ChatCompletionResponse:
    """Accept OpenAI-style messages and return a chat-completion-compatible response via consensus.

    The messages list is deterministically canonicalized into a prompt string
    and delegated to :func:`generate_text_consensus`.  The returned object
    exposes ``choices[0].message.content`` compatible access.
    """
    prompt = _canonicalize_messages(messages)
    result = generate_text_consensus(
        prompt,
        model_name=model_name,
        provider=provider,
        consensus=consensus,
        proof_policy=proof_policy,
        operators=operators,
        return_receipt=return_receipt,
        **kwargs,
    )
    if isinstance(result, ConsensusReceipt):
        content = result.text
        receipt = result
    else:
        content = str(result)
        receipt = None
    choice = ChatChoice(message=ChatMessage(role="assistant", content=content))
    return ChatCompletionResponse(choices=[choice], receipt=receipt)


__all__ = [
    "generate_text",
    "generate_text_consensus",
    "chat_completions_create_consensus",
    "get_llm_provider",
    "clear_llm_router_caches",
    "ChatCompletionResponse",
    "ChatChoice",
    "ChatMessage",
]
