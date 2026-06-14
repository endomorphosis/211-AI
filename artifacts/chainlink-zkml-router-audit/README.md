# Chainlink ZKML Router Surface Audit

Generated: 2026-06-13

Task: `CLZKML-010 Router Surface Audit`

## Scope

This audit records the current LLM router surface that the Chainlink/ZKML
consensus feature should extend. It is intentionally artifact-only and makes no
runtime code changes.

The audit covers:

- `ipfs_accelerate_py.llm_router` compatibility wrapper.
- Delegated `ipfs_datasets_py.llm_router` public API and provider model.
- Existing `p2p_task_queue` provider behavior.
- Cache and trace hooks relevant to consensus receipts.
- Exact extension points for the planned consensus layer.

## Current Public Wrapper

File: `ipfs_accelerate_py/llm_router.py`

The accelerate package currently exposes a very small compatibility surface:

- `_normalize_provider(provider)` maps `hf` and `huggingface` to
  `hf_inference_api`.
- `generate_text(prompt, *args, provider=None, **kwargs)` delegates to
  `ipfs_datasets_py.llm_router.generate_text`.
- `get_llm_provider(provider=None, *args, **kwargs)` delegates to
  `ipfs_datasets_py.llm_router.get_llm_provider`.
- `clear_llm_router_caches()` delegates to the datasets router.
- `__getattr__(name)` forwards unknown attributes to the datasets router.
- `__all__` currently exports only `generate_text`, `get_llm_provider`, and
  `clear_llm_router_caches`.

Implication for consensus:

- Add `generate_text_consensus` in `ipfs_accelerate_py.llm_router` as the public
  package entrypoint.
- Keep existing `generate_text` behavior unchanged.
- Reuse `_normalize_provider` so consensus calls accept the same provider aliases
  as the existing wrapper.
- Avoid adding heavy imports at wrapper import time; import the consensus module
  lazily inside new consensus functions if later dependencies grow.

## Delegated Router API

File: `ipfs_datasets_py/ipfs_datasets_py/llm_router.py`

Relevant public functions and types:

- `LLMRouterError`: runtime error base for lightweight router failures.
- `LLMProvider`: protocol with `generate(prompt, model_name=None, **kwargs)`.
- `NativeMultimodalProvider`: protocol for multimodal generation.
- `OpenAIChatCompletionsProvider`: protocol for OpenAI-style chat providers.
- `register_llm_provider(name, factory)`: process-local provider registry.
- `get_llm_provider(provider=None, deps=None, use_cache=None)`: provider
  resolver with process-global or dependency-container cache behavior.
- `generate_text(prompt, model_name=None, provider=None, provider_instance=None,
  deps=None, allow_local_fallback=True, **kwargs)`: main text generation entry.
- `chat_completions_create(messages, model=None, provider=None,
  provider_instance=None, deps=None, **kwargs)`: OpenAI-compatible wrapper.
- `submit_task`, `get_task`, `wait_task`: local task queue or libp2p remote
  task helpers.
- `get_remote_capabilities`, `call_remote_tool`,
  `get_remote_cache_value`, `set_remote_cache_value`: remote libp2p helpers.
- `get_last_generation_trace()`: returns `effective_provider_name` and
  `effective_model_name` for the last generation in the current thread.

Provider resolution currently supports:

- `mock`, `dry_run`, `dry-run`.
- `p2p`, `p2p_task`, `p2p_task_queue`, `remote_queue`, `task_queue`.
- `openai`, `openai_api`.
- `openrouter`.
- `hf_api`, `hf_inference`, `hf_inference_api`, `huggingface_inference`.
- `codex`, `codex_cli`.
- `copilot_cli`, `copilot_sdk`.
- `gemini_cli`, `gemini_py`.
- `claude_code`, `claude`, `claude_py`.
- `hf`, `huggingface`, `local_hf`.
- `accelerate`, `ipfs_accelerate_py` through `_get_accelerate_provider`.

Implication for consensus:

- Local multi-provider consensus can use `get_llm_provider` or
  `generate_text(..., provider_instance=...)` without inventing provider
  adapters.
- Tests can use the existing `mock` provider and later deterministic consensus
  mock operators.
- `provider_instance` is the clean injection point for unit tests.
- `allow_local_fallback` must be controlled carefully. In fail-closed consensus
  modes, silent fallback to a different provider can invalidate operator
  agreement unless the fallback is recorded as the operator's actual provider.

## Existing p2p Task Queue Behavior

The datasets router has a single-remote task queue path:

- `submit_task(...)` builds a payload, reads remote peer settings from
  `IPFS_DATASETS_PY_TASK_P2P_REMOTE_*` or
  `IPFS_ACCELERATE_PY_TASK_P2P_REMOTE_*`, optionally uses an announce file, and
  submits through `ipfs_datasets_py.ml.accelerate_integration.p2p_task_client`.
- If explicit remote multiaddr is configured and p2p submission fails, it raises
  `LLMRouterError`.
- If discovery is best-effort and no explicit remote is configured, it can fall
  back to the local task queue.
- `get_task(...)` and `wait_task(...)` decode `p2p://peer_id/task_id` IDs and
  route status/wait calls to the remote peer when possible.
- `_get_p2p_task_queue_provider()` exposes this path as an `LLMProvider`.
- `_P2PTaskQueueProvider.generate(...)` submits `text-generation` by default
  and waits for a completed task.
- `_P2PTaskQueueProvider.generate_multimodal(...)` submits
  `multimodal-generation` with JSON-safe image and prompt payload fields.

The compatibility client lives at:

- `ipfs_datasets_py/ipfs_datasets_py/ml/accelerate_integration/p2p_task_client.py`

That module imports the canonical implementation from
`ipfs_accelerate_py.p2p_tasks.client` at call time and exposes:

- `RemoteQueue`.
- `submit_task`, `submit_task_with_info`.
- `get_task`, `wait_task`.
- `get_capabilities`, `get_capabilities_sync`.
- `call_tool`, `call_tool_sync`.
- `cache_get`, `cache_has`, `cache_set` and sync variants.

Implication for consensus:

- The current p2p provider is not enough for consensus by itself because it
  targets one effective remote peer at a time and relies on process environment
  for remote peer selection.
- Consensus fan-out should use explicit `RemoteQueue(peer_id, multiaddr)`
  objects for each operator and call the client helpers directly.
- Do not mutate `IPFS_DATASETS_PY_TASK_P2P_REMOTE_*` or
  `IPFS_ACCELERATE_PY_TASK_P2P_REMOTE_*` while running concurrent fan-out.
- Add a new payload contract such as `llm-consensus-generate-v1`; keep legacy
  `text-generation` unchanged.
- Remote results should be converted to `OperatorResponse` records before
  quorum selection.

## Cache Hooks

The delegated router has two relevant cache layers:

- Provider instance caching through `get_llm_provider(..., use_cache=...)`,
  process-global `_resolve_provider_cached`, and `RouterDeps` cache keys.
- Optional response caching in `generate_text` when
  `IPFS_DATASETS_PY_ROUTER_RESPONSE_CACHE` is enabled or benchmark mode is on.

Response cache key inputs include:

- Provider key.
- Effective model key.
- Prompt digest.
- Stable kwargs digest.
- Optional CID-style key strategy via `IPFS_DATASETS_PY_ROUTER_CACHE_KEY=cid`.

Implication for consensus:

- Consensus request hashing should be independent from the delegated router's
  response cache key. It must include proof policy, quorum policy, nonce,
  deadline, redaction policy, and operator configuration.
- For consensus tests, disable response cache or include deterministic kwargs to
  avoid accidentally accepting a cached value as fresh operator execution.
- Receipt persistence should not be implemented through the response cache.
  Receipts need their own JSON/JSONL persistence adapter with prompt redaction
  controls.

## Trace Hooks

The delegated router stores a thread-local last generation trace:

- `_set_last_generation_trace(provider_name, model_name)`.
- `_clear_last_generation_trace()`.
- `get_last_generation_trace()`.

The trace currently contains:

- `effective_provider_name`.
- `effective_model_name`.

Implication for consensus:

- Each local operator call should capture `get_last_generation_trace()` after
  generation and copy the effective provider/model into `OperatorResponse`.
- For remote libp2p operators, the worker-side trace should be included in the
  remote task result when available.
- The trace is not a proof. It is useful provenance metadata for receipts but
  must not be treated as a cryptographic attestation.

## Recommended Extension Points

### New module

Create `ipfs_accelerate_py/llm_consensus.py`.

Initial responsibilities:

- Consensus dataclasses or Pydantic models.
- Request canonicalization and hashing.
- Output normalization.
- Quorum selection.
- Local operator runner.
- Optional receipt persistence.
- Error type `LLMConsensusError`.

This keeps consensus logic outside the compatibility wrapper and avoids
modifying the large delegated router until there is a concrete compatibility
need.

### Wrapper additions

Extend `ipfs_accelerate_py/llm_router.py` with:

- `generate_text_consensus(...)`.
- Later: `chat_completions_create_consensus(...)`.
- Updated `__all__`.

The wrapper should delegate to `llm_consensus.generate_text_consensus`, passing:

- Normalized provider.
- Existing `generate_text` function or delegated router reference as the local
  execution backend.
- Existing kwargs unchanged unless consensus config consumes them explicitly.

### p2p additions

Add p2p fan-out inside `llm_consensus.py` first. If canonical
`ipfs_accelerate_py.p2p_tasks.client` is unavailable in this repo checkout, keep
unit tests on mock remotes and gate live p2p tests behind
`IPFS_ACCELERATE_PY_RUN_LLM_CONSENSUS_P2P_TESTS=1`.

Future worker integration should add support for:

- `task_type="llm-consensus-generate-v1"`.
- Canonical request payload.
- Operator identity metadata.
- Optional signature and proof metadata.
- Worker-side last generation trace.

### Chainlink additions

Create `ipfs_accelerate_py/chainlink_cre.py` only after the local consensus
receipt schema is stable.

The CRE bridge should consume and produce the same `ConsensusRequest` and
`ConsensusReceipt` schema used by local and p2p consensus.

### Proof additions

Create `ipfs_accelerate_py/proof_verifiers.py` after the proof policy matrix is
written.

The proof verifier layer should be independent from provider execution so local,
p2p, and CRE receipts can all use the same proof binding checks.

## Risks And Constraints

- The current p2p path is single-remote and environment-driven. Directly using
  it as the consensus transport would serialize operator selection through
  global process state.
- Existing provider fallback can change the effective provider for a call. That
  is useful for availability, but consensus mode must record it or disable it
  for deterministic policies.
- Response caching is useful for benchmarks but can hide real operator
  execution. Consensus mode should make cache behavior explicit.
- Thread-local generation trace is provenance only, not security evidence.
- Full ZKML proof of large LLM generation is not assumed viable for the first
  release. Receipt and bounded-checker policies must label their guarantees
  precisely.

## First Implementation Order

The next implementation tasks should proceed in this order:

1. `CLZKML-040`: define receipt and request models.
2. `CLZKML-050`: canonical request hashing.
3. `CLZKML-060`: output normalization.
4. `CLZKML-070`: quorum selection.
5. `CLZKML-080`: deterministic mock operators.
6. `CLZKML-090`: local multi-provider runner.
7. `CLZKML-100`: public wrapper function.

This order keeps the first executable slice local, deterministic, and testable
before any Chainlink, libp2p, ZKML, or TEE dependency is introduced.

