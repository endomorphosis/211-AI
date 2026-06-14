# libp2p Multi-Peer Client Design

**Task:** CLZKML-160  
**Track:** p2p  
**Priority:** P1  
**Depends on:** CLZKML-010 (Router Surface Audit), CLZKML-090 (Local Multi-Provider Consensus Runner)  
**Date:** 2026-06-13

---

## Purpose

This document specifies how the consensus runner fans out LLM inference tasks to
multiple `RemoteQueue` peers over libp2p, how task payloads are structured, how
timeouts and partial failures surface in the caller, and why the design avoids
mutating the global routing environment.

---

## Background

The router surface audit (CLZKML-010) identified that
`ipfs_datasets_py.ml.accelerate_integration.p2p_task_client` exposes a
`RemoteQueue` dataclass and the following async functions for interacting with a
remote libp2p task queue node:

| Function | Description |
|---|---|
| `submit_task(remote, task_type, model_name, payload)` | Enqueue a task; returns a task ID string. |
| `submit_task_with_info(remote, task_type, model_name, payload)` | Same as above, returns `{task_id, …}` dict. |
| `get_task(remote, task_id)` | Poll result by ID; returns `None` if not ready. |
| `wait_task(remote, task_id, timeout_s)` | Block (async) until result or timeout. |
| `get_capabilities(remote, timeout_s, detail)` | Introspect which task types a peer supports. |
| `call_tool(remote, tool_name, args, timeout_s)` | Invoke a named tool on the peer directly. |
| `cache_get/cache_has/cache_set` | Shared KV cache operations on the peer. |

The canonical implementations live in `ipfs_accelerate_py.p2p_tasks.client`;
the `p2p_task_client` module is a thin compatibility shim that delegates to the
canonical module at import time.

`RemoteQueue` carries exactly two fields:

```python
@dataclass
class RemoteQueue:
    peer_id: str   # libp2p peer identity (base58 or CIDv1)
    multiaddr: str # e.g. "/ip4/10.0.0.5/tcp/4001/p2p/<peer_id>"
```

The local multi-provider consensus runner (CLZKML-090) already executes
multiple configured operators concurrently using `asyncio` tasks, collects
`OperatorResponse` records, and selects an output by M-of-N quorum—all without
touching shared router state.  The p2p layer described here is the _remote_
counterpart: operators that run on separate libp2p nodes instead of in-process.

---

## Fan-Out Design

### Peer list injection

The consensus configuration accepts an optional `peers` list alongside the
existing `min_operators`/`quorum` settings:

```python
consensus = {
    "mode": "libp2p_quorum",
    "min_operators": 3,
    "quorum": 2,
    "comparison": "canonical_json",
    "timeout_s": 90,
    "fail_closed": True,
    "peers": [
        {"peer_id": "12D3Koo…A", "multiaddr": "/ip4/10.0.0.5/tcp/4001/p2p/12D3Koo…A"},
        {"peer_id": "12D3Koo…B", "multiaddr": "/ip4/10.0.0.6/tcp/4001/p2p/12D3Koo…B"},
        {"peer_id": "12D3Koo…C", "multiaddr": "/ip4/10.0.0.7/tcp/4001/p2p/12D3Koo…C"},
    ],
}
```

Peers are **not** read from environment variables or module-level globals.
They are passed explicitly at call-site so that concurrent requests to different
peer sets do not interfere.

### Fan-out execution

The `libp2p_quorum` path converts each peer entry into a `RemoteQueue` and
dispatches tasks concurrently using `asyncio.gather` with individual timeouts:

```python
import asyncio
from ipfs_datasets_py.ml.accelerate_integration.p2p_task_client import (
    RemoteQueue,
    submit_task,
    wait_task,
)

async def _query_peer(
    remote: RemoteQueue,
    payload: dict,
    per_peer_timeout_s: float,
) -> OperatorResponse:
    try:
        task_id = await asyncio.wait_for(
            submit_task(
                remote=remote,
                task_type="llm_inference",
                model_name=payload["model_name"],
                payload=payload,
            ),
            timeout=per_peer_timeout_s,
        )
        result = await asyncio.wait_for(
            wait_task(remote=remote, task_id=task_id, timeout_s=per_peer_timeout_s),
            timeout=per_peer_timeout_s,
        )
        return OperatorResponse.from_p2p_result(remote.peer_id, result)
    except asyncio.TimeoutError:
        return OperatorResponse.timeout(operator_id=remote.peer_id)
    except Exception as exc:
        return OperatorResponse.error(operator_id=remote.peer_id, error=str(exc))


async def fan_out(
    peers: list[RemoteQueue],
    payload: dict,
    per_peer_timeout_s: float,
) -> list[OperatorResponse]:
    return list(
        await asyncio.gather(
            *(_query_peer(p, payload, per_peer_timeout_s) for p in peers),
            return_exceptions=False,   # exceptions caught inside _query_peer
        )
    )
```

Every peer is queried concurrently.  A failing or slow peer produces an
`OperatorResponse` with `status="timeout"` or `status="error"` rather than
raising, so the quorum engine in CLZKML-090 can count successes and decide
whether the quorum threshold has been met.

The per-peer timeout (`per_peer_timeout_s`) is derived from the overall
`timeout_s` minus a small scheduling margin (e.g., 5 s), and is applied twice:
once to `submit_task` and once to `wait_task`.  This prevents a single
unresponsive peer from blocking all others.

---

## Task Payload Shape

The payload dict submitted to each peer via `submit_task` carries these fields:

```python
{
    # Routing / versioning
    "schema_version": "1",
    "task_type": "llm_inference",

    # Identity / non-repudiation
    "request_id": "<uuid4>",           # stable across all peers for this request
    "request_hash": "<sha3-256-hex>",  # from ConsensusRequest.canonical_hash()

    # Inference parameters
    "model_name": "Qwen/Qwen2.5-1.5B-Instruct",
    "provider": "hf_inference_api",
    "prompt": "<redacted-or-canonicalized>",
    "generation_params": {             # max_tokens, temperature, top_p, seed, …
        "max_new_tokens": 256,
        "temperature": 0.0,
        "seed": 42,
    },
    "response_format": {"type": "json_object"},

    # Proof / verifier hints
    "proof_policy": "receipt_only",    # or tee_or_zkml, zkml_required, …
    "nonce": "<hex>",
    "deadline_utc": "2026-06-13T14:00:00Z",

    # Optional redaction policy
    "redact_prompt_in_receipt": True,
}
```

`prompt` is always included because the remote node must execute the inference;
`redact_prompt_in_receipt` instructs the service to strip the prompt from any
receipt it stores or logs.  The `request_hash` is computed _before_ fan-out so
every peer receives the same binding token for quorum matching.

`generation_params.seed` is set to a deterministic value when
`response_format.type == "json_object"` or `comparison == "canonical_json"` so
that independent nodes are more likely to produce byte-identical outputs.

No secrets, bearer tokens, or private keys are included in the payload.  Any
provider credentials required by the remote node are configured on that node via
its own environment; the caller never passes them.

---

## Timeout and Partial Failure Representation

### Per-peer timeout

Each `_query_peer` coroutine applies `asyncio.wait_for` at two points:
`submit_task` (connection + enqueue) and `wait_task` (poll until done).
A `TimeoutError` at either point produces:

```python
OperatorResponse(
    operator_id="12D3Koo…A",
    status="timeout",
    raw_output=None,
    normalized_hash=None,
    latency_s=<elapsed>,
    error="asyncio.TimeoutError",
    metadata={"peer_id": "12D3Koo…A"},
)
```

### Per-peer error

Any other exception (connection refused, protocol error, deserialization
failure, etc.) produces:

```python
OperatorResponse(
    operator_id="12D3Koo…A",
    status="error",
    raw_output=None,
    normalized_hash=None,
    latency_s=<elapsed>,
    error="<exc type>: <message>",
    metadata={"peer_id": "12D3Koo…A"},
)
```

### Overall timeout

An outer `asyncio.wait_for` wraps `fan_out` with the caller-specified
`timeout_s`.  If this fires while some peers are still in-flight, the pending
tasks are cancelled and all remaining peers are converted to timeout records by
the cancellation handler before the partial result list is handed to the quorum
engine.

### Quorum engine inputs

After fan-out the quorum engine (CLZKML-090) receives the full list of
`OperatorResponse` objects.  It considers only `status="success"` entries for
quorum matching.  If the number of successes is below `min_operators` or the
winning hash has fewer than `quorum` votes, the engine raises
`LLMConsensusError` (when `fail_closed=True`) or returns a degraded receipt
(when `fail_closed=False`).  The `ConsensusReceipt` always includes the raw
per-peer response list so callers can audit which peers timed out or errored.

### Partial-success receipt example

```python
ConsensusReceipt(
    request_id="…",
    request_hash="…",
    selected_output="…",
    quorum_achieved=True,
    operator_responses=[
        OperatorResponse(operator_id="…A", status="success", …),
        OperatorResponse(operator_id="…B", status="success", …),
        OperatorResponse(operator_id="…C", status="timeout", …),
    ],
    proof_receipt=ProofReceipt(mode="receipt_only", …),
)
```

---

## Why Global Environment Mutation Is Avoided

The existing `p2p_task_service.py` shim contains a `_set_discovery_env` helper
that writes DHT/rendezvous flags to `os.environ`.  This pattern is explicitly
excluded from the multi-peer client design for the following reasons:

1. **Concurrency safety.**  Python's `os.environ` is process-global.  In an
   async application multiple concurrent consensus requests could be in-flight
   simultaneously (e.g., different callers with different peer sets or different
   discovery policies).  A write to `os.environ` by one request would
   non-deterministically affect all others.

2. **Testability.**  Unit tests for the consensus layer (CLZKML-090) must be
   able to run concurrently in the same process without environmental leakage.
   Passing peer configuration as explicit arguments makes each test case
   self-contained and hermetic.

3. **Composability.**  The `generate_text_consensus` public API is designed to
   compose with the existing `generate_text` fast path.  If the consensus path
   mutated global state, calling both APIs from the same process would
   introduce subtle ordering dependencies that are invisible to callers.

4. **Operator isolation.**  Each `RemoteQueue` peer is independent.  The client
   must not change its own discovery behavior based on which peers it has already
   contacted; peer-specific connection parameters belong in the `RemoteQueue`
   object, not in environment flags.

**Concrete rule:** the multi-peer client layer MUST NOT call `os.environ.__setitem__`,
`os.putenv`, or any function that transitively does so.  Discovery parameters
(DHT, rendezvous, autonat) are configured at service startup time via the
`serve_task_queue` entry point and are not changed at runtime.

---

## Integration with the Consensus Runner

The multi-peer client plugs into the local runner (CLZKML-090) as an additional
operator backend.  The integration point is the `operator_fn` abstraction that
the runner calls for each configured operator:

```
generate_text_consensus(...)
    └── LocalConsensusRunner.run(request)
            ├── operator_fn(local_hf_operator, request)    # in-process
            ├── operator_fn(local_openai_operator, request) # in-process
            └── operator_fn(p2p_peer_operator, request)    # calls fan_out()
                    ├── _query_peer(RemoteQueue(…A), …)
                    ├── _query_peer(RemoteQueue(…B), …)
                    └── _query_peer(RemoteQueue(…C), …)
```

The quorum engine receives `OperatorResponse` objects from both in-process and
remote operators and applies the same M-of-N selection logic regardless of
origin.  Remote peers are not treated as a special quorum tier; they simply
contribute votes alongside local operators.

A `p2p_peer_operator` wrapper looks like:

```python
class P2PPeerOperator:
    def __init__(self, peers: list[RemoteQueue], per_peer_timeout_s: float = 60.0):
        self._peers = peers
        self._timeout = per_peer_timeout_s

    async def __call__(self, request: ConsensusRequest) -> list[OperatorResponse]:
        payload = _build_payload(request)
        return await fan_out(self._peers, payload, self._timeout)
```

The operator receives the `ConsensusRequest` value object and derives the
payload from it without reading environment variables.

---

## Open Questions for CLZKML-170

The following design decisions are deferred to the payload contract task
(CLZKML-170):

1. Schema versioning strategy for the `payload` dict (semver vs. integer bump).
2. How the remote service returns structured error payloads vs. raw HTTP error
   codes when it encounters a model-loading failure or OOM condition.
3. Whether the `normalized_hash` comparison should happen client-side (on the
   collected `raw_output` fields) or whether the remote node should compute and
   return its own hash.
4. Redaction policy enforcement: who strips the prompt from stored receipts, and
   how compliance is verified.

---

## Summary

| Design point | Decision |
|---|---|
| Fan-out mechanism | `asyncio.gather` over per-peer `_query_peer` coroutines |
| Peer configuration | Explicit `peers` list in consensus config; no globals |
| Peer type | `RemoteQueue(peer_id, multiaddr)` from existing p2p_task_client |
| Task submission | `submit_task` → `wait_task` via existing async client APIs |
| Payload shape | Versioned dict: request_id, request_hash, model_name, provider, prompt, generation_params, response_format, proof_policy, nonce, deadline, redact flag |
| Per-peer timeout | `asyncio.wait_for` wrapping both submit and wait steps |
| Partial failure | Non-raising; failed peers → `OperatorResponse(status="timeout"\|"error")` |
| Overall timeout | Outer `asyncio.wait_for`; in-flight tasks cancelled and converted |
| Quorum input | Full `OperatorResponse` list; engine counts `status="success"` votes |
| Global mutation | Explicitly prohibited; all parameters passed as arguments |
| Operator integration | `P2PPeerOperator` callable, same interface as local operators |
