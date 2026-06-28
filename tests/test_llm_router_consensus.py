"""Tests for ipfs_accelerate_py.llm_router consensus wrapper."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import textwrap
from typing import Any

from ipfs_accelerate_py import llm_router
from ipfs_accelerate_py.llm_consensus import (
    ConsensusReceipt,
    LocalConsensusOperator,
    load_consensus_config,
)
from ipfs_accelerate_py.llm_router import (
    ChatCompletionResponse,
    _canonicalize_messages,
    chat_completions_create_consensus,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_import_probe(script: str) -> None:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("IPFS_DATASETS_AUTO_INSTALL", None)
    env.pop("IPFS_KIT_AUTO_INSTALL_DEPS", None)
    completed = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_import_ipfs_accelerate_py_has_no_optional_side_effects() -> None:
    _run_import_probe(
        """
        import builtins
        import os
        import pathlib
        import socket
        import subprocess
        import sys
        import urllib.request

        events = []

        def guarded(name):
            def _guard(*args, **kwargs):
                events.append(name)
                raise AssertionError(name)
            return _guard

        socket.create_connection = guarded("socket.create_connection")
        socket.socket = guarded("socket.socket")
        urllib.request.urlopen = guarded("urllib.request.urlopen")
        subprocess.Popen = guarded("subprocess.Popen")
        subprocess.run = guarded("subprocess.run")
        os.makedirs = guarded("os.makedirs")
        os.mkdir = guarded("os.mkdir")
        pathlib.Path.mkdir = guarded("Path.mkdir")
        pathlib.Path.write_text = guarded("Path.write_text")
        pathlib.Path.write_bytes = guarded("Path.write_bytes")

        original_open = builtins.open

        def guarded_open(file, mode="r", *args, **kwargs):
            if any(flag in str(mode) for flag in ("w", "a", "x", "+")):
                events.append(f"open:{mode}")
                raise AssertionError(f"write open: {mode}")
            return original_open(file, mode, *args, **kwargs)

        builtins.open = guarded_open

        import ipfs_accelerate_py

        blocked = [
            name
            for name in sys.modules
            if name == "ipfs_datasets_py"
            or name.startswith("ipfs_datasets_py.")
            or name in {"requests", "huggingface_hub", "libp2p"}
            or name.startswith("ipfs_accelerate_py.chainlink")
            or name.startswith("ipfs_accelerate_py.proof_verifiers")
            or name.startswith("ipfs_accelerate_py.p2p")
        ]
        assert blocked == [], blocked
        assert events == [], events
        assert "IPFS_DATASETS_AUTO_INSTALL" not in os.environ
        assert "IPFS_KIT_AUTO_INSTALL_DEPS" not in os.environ
        assert "llm_router" in ipfs_accelerate_py.__all__
        """
    )


def test_import_ipfs_accelerate_llm_router_defers_upstream_router_side_effects() -> None:
    _run_import_probe(
        """
        import builtins
        import os
        import pathlib
        import socket
        import subprocess
        import sys
        import urllib.request

        events = []

        def guarded(name):
            def _guard(*args, **kwargs):
                events.append(name)
                raise AssertionError(name)
            return _guard

        socket.create_connection = guarded("socket.create_connection")
        socket.socket = guarded("socket.socket")
        urllib.request.urlopen = guarded("urllib.request.urlopen")
        subprocess.Popen = guarded("subprocess.Popen")
        subprocess.run = guarded("subprocess.run")
        os.makedirs = guarded("os.makedirs")
        os.mkdir = guarded("os.mkdir")
        pathlib.Path.mkdir = guarded("Path.mkdir")
        pathlib.Path.write_text = guarded("Path.write_text")
        pathlib.Path.write_bytes = guarded("Path.write_bytes")

        original_open = builtins.open

        def guarded_open(file, mode="r", *args, **kwargs):
            if any(flag in str(mode) for flag in ("w", "a", "x", "+")):
                events.append(f"open:{mode}")
                raise AssertionError(f"write open: {mode}")
            return original_open(file, mode, *args, **kwargs)

        builtins.open = guarded_open

        import ipfs_accelerate_py.llm_router as router

        blocked = [
            name
            for name in sys.modules
            if name == "ipfs_datasets_py"
            or name.startswith("ipfs_datasets_py.")
            or name in {"requests", "huggingface_hub", "libp2p"}
            or name.startswith("ipfs_accelerate_py.chainlink")
            or name.startswith("ipfs_accelerate_py.proof_verifiers")
            or name.startswith("ipfs_accelerate_py.p2p")
        ]
        assert blocked == [], blocked
        assert events == [], events
        assert "IPFS_DATASETS_AUTO_INSTALL" not in os.environ
        assert "IPFS_KIT_AUTO_INSTALL_DEPS" not in os.environ
        assert router._datasets_llm_router._module is None
        assert router._normalize_provider("hf") == "hf_inference_api"
        """
    )


def test_generate_text_consensus_returns_receipt_with_explicit_operators() -> None:
    operators = [
        LocalConsensusOperator("op-a", lambda _: "{\"answer\":\"yes\"}", provider="mock"),
        LocalConsensusOperator("op-b", lambda _: "{\n  \"answer\": \"yes\"\n}", provider="mock"),
    ]

    receipt = llm_router.generate_text_consensus(
        "return json",
        model_name="mock-model",
        provider="mock",
        consensus={
            "comparison": "canonical_json",
            "quorum": 2,
            "min_operators": 2,
            "nonce": "nonce-1",
        },
        operators=operators,
    )

    assert isinstance(receipt, ConsensusReceipt)
    assert receipt.consensus.accepted is True
    assert receipt.request.provider == "mock"
    assert receipt.request.model_name == "mock-model"
    assert receipt.text.replace(" ", "").replace("\n", "") in {
        "{\"answer\":\"yes\"}",
        "{\"answer\":\"yes\"}",
    }


def test_generate_text_consensus_can_return_text_only() -> None:
    text = llm_router.generate_text_consensus(
        "return json",
        consensus={"comparison": "canonical_json", "quorum": 1, "nonce": "nonce-1"},
        operators=[LocalConsensusOperator("op-a", lambda _: "{\"answer\":\"yes\"}")],
        return_receipt=False,
    )

    assert text == "{\"answer\":\"yes\"}"


def test_generate_text_consensus_normalizes_provider_alias_for_request() -> None:
    seen: dict[str, Any] = {}

    def _operator(request: ConsensusRequest) -> str:
        seen["provider"] = request.provider
        return "{\"answer\":\"yes\"}"

    receipt = llm_router.generate_text_consensus(
        "return json",
        provider="hf",
        consensus={"comparison": "canonical_json", "quorum": 1, "nonce": "nonce-1"},
        operators=[LocalConsensusOperator("op-a", _operator)],
    )

    assert isinstance(receipt, ConsensusReceipt)
    assert seen["provider"] == "hf_inference_api"
    assert receipt.request.provider == "hf_inference_api"


def test_generate_text_consensus_default_operator_uses_datasets_router(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def _fake_generate_text(prompt: str, **kwargs: Any) -> str:
        calls.append({"prompt": prompt, **kwargs})
        return "{\"answer\":\"yes\"}"

    monkeypatch.setattr(llm_router._datasets_llm_router, "generate_text", _fake_generate_text)

    receipt = llm_router.generate_text_consensus(
        "return json",
        provider="huggingface",
        model_name="mock-model",
        consensus={"comparison": "canonical_json", "quorum": 1, "nonce": "nonce-1"},
        temperature=0,
    )

    assert isinstance(receipt, ConsensusReceipt)
    assert receipt.consensus.accepted is True
    assert calls == [
        {
            "prompt": "return json",
            "model_name": "mock-model",
            "provider": "hf_inference_api",
            "temperature": 0,
        }
    ]


def test_generate_text_existing_behavior_still_delegates(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def _fake_generate_text(prompt: str, **kwargs: Any) -> str:
        calls.append({"prompt": prompt, **kwargs})
        return "plain text"

    monkeypatch.setattr(llm_router._datasets_llm_router, "generate_text", _fake_generate_text)

    text = llm_router.generate_text("hello", provider="hf", temperature=0)

    assert text == "plain text"
    assert calls == [
        {
            "prompt": "hello",
            "provider": "hf_inference_api",
            "temperature": 0,
        }
    ]


def test_load_consensus_config_reads_env_with_type_coercion() -> None:
    config = load_consensus_config(
        env={
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_MODE": "libp2p_quorum",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_COMPARISON": "canonical_json",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_QUORUM": "2",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_MIN_OPERATORS": "3",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_TIMEOUT_S": "12.5",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_OPERATOR_TIMEOUT_S": "4.5",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_FAIL_CLOSED": "false",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_CONTEXT_CIDS": "bafy-a,bafy-b",
        }
    )

    assert config["mode"] == "libp2p_quorum"
    assert config["comparison"] == "canonical_json"
    assert config["quorum"] == 2
    assert config["min_operators"] == 3
    assert config["timeout_s"] == 12.5
    assert config["operator_timeout_s"] == 4.5
    assert config["fail_closed"] is False
    assert config["context_cids"] == ["bafy-a", "bafy-b"]


def test_load_consensus_config_explicit_values_override_env() -> None:
    config = load_consensus_config(
        {
            "comparison": "exact",
            "quorum": 1,
            "minOperators": 1,
            "failClosed": True,
        },
        env={
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_COMPARISON": "canonical_json",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_QUORUM": "3",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_MIN_OPERATORS": "5",
            "IPFS_ACCELERATE_PY_LLM_CONSENSUS_FAIL_CLOSED": "false",
        },
    )

    assert config["comparison"] == "exact"
    assert config["quorum"] == 1
    assert config["min_operators"] == 1
    assert config["fail_closed"] is True


def test_load_consensus_config_rejects_impossible_quorum() -> None:
    try:
        load_consensus_config({"quorum": 3, "min_operators": 2}, env={})
    except Exception as exc:
        assert "quorum cannot exceed min_operators" in str(exc)
    else:
        raise AssertionError("expected impossible quorum to fail")


def test_generate_text_consensus_uses_env_config_when_explicit_config_missing(monkeypatch) -> None:
    monkeypatch.setenv("IPFS_ACCELERATE_PY_LLM_CONSENSUS_COMPARISON", "canonical_json")
    monkeypatch.setenv("IPFS_ACCELERATE_PY_LLM_CONSENSUS_QUORUM", "1")
    monkeypatch.setenv("IPFS_ACCELERATE_PY_LLM_CONSENSUS_MIN_OPERATORS", "1")
    monkeypatch.setenv("IPFS_ACCELERATE_PY_LLM_CONSENSUS_NONCE", "env-nonce")

    receipt = llm_router.generate_text_consensus(
        "return json",
        operators=[LocalConsensusOperator("op-a", lambda _: "{\"answer\":\"yes\"}")],
    )

    assert isinstance(receipt, ConsensusReceipt)
    assert receipt.request.comparison == "canonical_json"
    assert receipt.request.request_id == "env-nonce"


# ---------------------------------------------------------------------------
# chat_completions_create_consensus tests
# ---------------------------------------------------------------------------

def test_canonicalize_messages_produces_deterministic_string() -> None:
    messages = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "What is 2+2?"},
    ]
    result = _canonicalize_messages(messages)
    assert result == "system: You are helpful.\nuser: What is 2+2?"


def test_canonicalize_messages_stable_across_calls() -> None:
    messages = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there"},
        {"role": "user", "content": "Bye"},
    ]
    assert _canonicalize_messages(messages) == _canonicalize_messages(messages)


def test_chat_completions_create_consensus_returns_response_object() -> None:
    operators = [
        LocalConsensusOperator("op-a", lambda _: "Paris", provider="mock"),
        LocalConsensusOperator("op-b", lambda _: "Paris", provider="mock"),
    ]
    messages = [
        {"role": "user", "content": "What is the capital of France?"},
    ]
    response = chat_completions_create_consensus(
        messages,
        consensus={"comparison": "exact", "quorum": 2, "min_operators": 2, "nonce": "chat-nonce"},
        operators=operators,
    )
    assert isinstance(response, ChatCompletionResponse)
    assert len(response.choices) == 1
    assert response.choices[0].message.content == "Paris"
    assert response.choices[0].message.role == "assistant"
    assert isinstance(response.receipt, ConsensusReceipt)
    assert response.receipt.consensus.accepted is True


def test_chat_completions_create_consensus_choices_message_content_access() -> None:
    """Verify choices[0].message.content access pattern works."""
    operators = [LocalConsensusOperator("op-a", lambda _: "42", provider="mock")]
    messages = [{"role": "user", "content": "What is the answer?"}]
    response = chat_completions_create_consensus(
        messages,
        consensus={"comparison": "exact", "quorum": 1, "min_operators": 1, "nonce": "n1"},
        operators=operators,
    )
    assert response.choices[0].message.content == "42"


def test_chat_completions_create_consensus_multi_turn_messages() -> None:
    """Multi-turn messages are canonicalized deterministically."""
    messages = [
        {"role": "system", "content": "Be concise."},
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi"},
        {"role": "user", "content": "Thanks"},
    ]
    # Verify canonicalization is stable across calls
    expected_prompt = (
        "system: Be concise.\n"
        "user: Hello\n"
        "assistant: Hi\n"
        "user: Thanks"
    )
    assert _canonicalize_messages(messages) == expected_prompt

    response = chat_completions_create_consensus(
        messages,
        consensus={"comparison": "exact", "quorum": 1, "min_operators": 1, "nonce": "n2"},
        operators=[LocalConsensusOperator("op-a", lambda _: "Sure", provider="mock")],
    )
    assert response.choices[0].message.content == "Sure"


def test_chat_completions_create_consensus_without_receipt() -> None:
    """return_receipt=False still produces a valid response."""
    operators = [LocalConsensusOperator("op-a", lambda _: "result text", provider="mock")]
    messages = [{"role": "user", "content": "Say something"}]
    response = chat_completions_create_consensus(
        messages,
        consensus={"comparison": "exact", "quorum": 1, "min_operators": 1, "nonce": "n3"},
        operators=operators,
        return_receipt=False,
    )
    assert isinstance(response, ChatCompletionResponse)
    assert response.choices[0].message.content == "result text"
    assert response.receipt is None


def test_chat_completions_create_consensus_normalizes_provider() -> None:
    """Provider alias normalization is applied when delegating."""
    seen: dict[str, Any] = {}

    def _op(request: ConsensusRequest) -> str:
        seen["provider"] = request.provider
        return "ok"

    messages = [{"role": "user", "content": "test"}]
    response = chat_completions_create_consensus(
        messages,
        provider="hf",
        consensus={"comparison": "exact", "quorum": 1, "min_operators": 1, "nonce": "n4"},
        operators=[LocalConsensusOperator("op-a", _op)],
    )
    assert seen["provider"] == "hf_inference_api"
    assert response.choices[0].message.content == "ok"


def test_chat_completions_create_consensus_consensus_failure_propagates() -> None:
    """When operators disagree and quorum is 2, consensus is not accepted."""
    operators = [
        LocalConsensusOperator("op-a", lambda _: "answer A", provider="mock"),
        LocalConsensusOperator("op-b", lambda _: "answer B", provider="mock"),
    ]
    messages = [{"role": "user", "content": "Pick one"}]
    response = chat_completions_create_consensus(
        messages,
        consensus={"comparison": "exact", "quorum": 2, "min_operators": 2, "nonce": "n5", "fail_closed": False},
        operators=operators,
    )
    assert isinstance(response, ChatCompletionResponse)
    assert response.receipt is not None
    assert response.receipt.consensus.accepted is False
