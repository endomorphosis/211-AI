# Generic Hugging Face Space Inference Provider

A reusable, generic Python library for batch processing through Hugging Face Spaces with pluggable output backends and automatic retry/resumability.

## What's New

Extracted from the working IndexTTS Abby TTS implementation, this new `ipfs_accelerate_py` module provides generic abstractions that work with **any** Hugging Face Space, not just IndexTTS.

## Quick Example

```python
from ipfs_accelerate_py import (
    HFSpaceClient,
    BatchProcessor, 
    HFBucketBackend,
)
from pathlib import Path

# Connect to any Hugging Face Space
client = HFSpaceClient("https://my-space.hf.space")

# Verify it's ready
contract = client.probe_contract()
assert contract["available"]

# Output to local or HF bucket (pluggable!)
backend = HFBucketBackend("hf://buckets/my-org/outputs")

# Batch process with automatic retry and checkpointing
processor = BatchProcessor(
    client=client,
    output_backend=backend,
    state_file=Path("state.json"),
    batch_size=8,
    retry_attempts=3,
)

# Process items
items = [{"text": "hello"}, {"text": "world"}]
success, results = processor.process_batch(
    items=items,
    endpoint_fn_index=0,
    output_batch_id="batch-001",
)
```

## Architecture

**Three core abstractions:**

1. **HFSpaceClient**: Interacts with Gradio Spaces
   - Endpoint discovery from Space config
   - Synchronous API calls
   - Contract probing for health checks

2. **OutputBackend**: Pluggable output (interface)
   - `LocalFileSystemBackend`: Write to disk
   - `HFBucketBackend`: Write to HF buckets
   - Implement custom backends for S3, GCS, etc.

3. **BatchProcessor**: Orchestrates batch processing
   - Automatic retry with exponential backoff
   - State checkpointing for resumability
   - Pluggable output backend

**Key design principle:** Generic ≠ specific to IndexTTS. The user (you) provides:
- Space URL
- Endpoint index
- Input/output transformations
- Output destination

The library handles:
- Endpoint calls with retry logic
- State checkpointing for resumability
- Output syncing to any backend
- Exponential backoff

## Files

- `ipfs_accelerate_py/hf_space_inference.py` - Core module (350 lines, fully tested)
- `ipfs_accelerate_py/space_inference_example.py` - Usage examples
- `ipfs_accelerate_py/HF_SPACE_INFERENCE.md` - API documentation
- `ipfs_accelerate_py/MIGRATION_GUIDE.md` - How to refactor existing code
- `tests/test_hf_space_inference.py` - 19 unit tests (all passing)

## Why This Matters

### Before (IndexTTS-specific)
```
scripts/precompute_indextts_responses.py: 600+ lines
├─ Gradio/Space interaction (50 lines)
├─ IndexTTS batch call logic (100 lines, hardcoded)
├─ Retry/backoff (80 lines, generic)
├─ Split salvage (100 lines, generic)
├─ Output syncing (150 lines, generic)
└─ Manifest handling (120 lines, IndexTTS-specific)
```

### After (Generic + adapters)
```
ipfs_accelerate_py/hf_space_inference.py: 350 lines (REUSABLE)
├─ HFSpaceClient (80 lines)
├─ OutputBackend + implementations (120 lines)
├─ BatchProcessor + retry (90 lines)
└─ BatchState + utilities (60 lines)

+ Workflow adapters: 100-200 lines per Space (ONLY Space-specific code)
```

**Result:** 400+ lines of generic code → 350 lines (reusable for ANY Space) + minimal adapters per Space

## Use Cases

- **Audio synthesis** (IndexTTS, TTS models)
- **Image embeddings** (CLIP, ViT)
- **Text generation** (LLMs)
- **Document processing** (OCR, parsing)
- **Any Gradio Space** with batch endpoints

## Supported Output Backends

- **Local filesystem**: `LocalFileSystemBackend`
- **HF buckets**: `HFBucketBackend` (using hf-cli)
- **Custom**: Implement `OutputBackend` interface

## Key Features

✅ **Generic**: Works with any Space, any endpoint, any data format  
✅ **Resumable**: State checkpointing enables crash recovery  
✅ **Retryable**: Exponential backoff for transient failures  
✅ **Pluggable**: Swap output backends without code changes  
✅ **Tested**: 19 unit tests, all passing  
✅ **Production-ready**: Extracted from working Abby TTS pipeline  

## Integration Points

- **For new Spaces**: Use this module directly
- **For existing Abby TTS**: Gradual migration path available (see `MIGRATION_GUIDE.md`)
- **For other projects**: Copy `ipfs_accelerate_py.hf_space_inference` into your repo

## Documentation

See:
- `HF_SPACE_INFERENCE.md` - Full API reference and design philosophy
- `MIGRATION_GUIDE.md` - How to refactor IndexTTS scripts
- `space_inference_example.py` - Working code examples
- `tests/test_hf_space_inference.py` - Test suite showing usage patterns
- `../docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_PLAN.md` - Plan for
  Chainlink CRE/ZKML-backed LLM router consensus
- `../docs/CHAINLINK_ZKML_LLM_ROUTER_CONSENSUS_TODO.md` - Daemon-consumable
  implementation backlog for the consensus feature

## LLM Router Consensus Mode

`ipfs_accelerate_py.llm_router` supports a verified inference mode that requires
independent operators to agree on the same answer before returning a result.
This is built on `ipfs_accelerate_py.llm_consensus`.

See the full runbook: `docs/CHAINLINK_ZKML_LLM_ROUTER_RUNBOOK.md`

### Receipt-Only Local Consensus

Suitable for development, smoke tests, and low-risk generation.

```python
from ipfs_accelerate_py.llm_router import generate_text_consensus

receipt = generate_text_consensus(
    "Summarize the food assistance options available.",
    provider="hf_inference_api",
    model_name="mistralai/Mistral-7B-Instruct-v0.2",
    consensus={
        "enabled": True,
        "quorum": 1,
        "comparison": "normalized_text",
        "fail_closed": False,
    },
    proof_policy={"mode": "receipt_only"},
    return_receipt=True,
)
print(receipt.text)
print(receipt.quorum_result)  # "quorum_met"
print(receipt.receipt_hash)   # sha256 content binding
```

> **Warning**: Non-deterministic generation parameters (`temperature`, `top_p`,
> `top_k`) will cause systematic quorum failures under `exact` or
> `canonical_json` comparison. Use `temperature=0` and `do_sample=False` for
> deterministic multi-operator consensus, or use `normalized_text` comparison
> for softer agreement.

### libp2p Quorum (Multi-Operator)

Suitable for production deployments with independent peer operators.

```python
from ipfs_accelerate_py.llm_router import generate_text_consensus
from ipfs_accelerate_py.llm_consensus import LocalConsensusOperator

operators = [
    LocalConsensusOperator("peer-a", handler_a, provider="hf_inference_api"),
    LocalConsensusOperator("peer-b", handler_b, provider="hf_inference_api"),
    LocalConsensusOperator("peer-c", handler_c, provider="hf_inference_api"),
]

receipt = generate_text_consensus(
    'Extract service category as JSON: {"category": "..."}',
    consensus={
        "enabled": True,
        "quorum": 2,
        "min_operators": 3,
        "comparison": "canonical_json",
        "fail_closed": True,  # required for production
    },
    proof_policy={"mode": "receipt_only"},
    operators=operators,
    return_receipt=True,
)
```

> **Warning**: Always set `fail_closed: True` for production multi-operator
> quorum. With `fail_closed=False` the router may return a result that did not
> meet the quorum threshold, providing no consensus guarantee.

### CRE-Verified Consensus

Suitable when Chainlink Runtime Environment workflow verification is required.
CRE confirms that the inference capability was executed across DON nodes.

```python
receipt = generate_text_consensus(
    "Is the caller eligible? Output JSON: ...",
    consensus={
        "enabled": True,
        "quorum": 3,
        "min_operators": 5,
        "comparison": "canonical_json",
        "fail_closed": True,
    },
    proof_policy={
        "mode": "receipt_only",
        "cre_verified": True,
        "cre_workflow_id": "wf-eligibility-v1",
        "cre_registry": "mainnet-cre-registry.example.com",
    },
    return_receipt=True,
)
```

> **Warning**: CRE consensus is not a ZKML proof. CRE verifies that the HTTP
> inference capability ran on DON nodes per the workflow — it does not provide
> a zero-knowledge proof of model execution. Do not label a CRE-only receipt as
> ZKML-verified. Use `tee_or_zkml` or `zkml_required` proof policy when a
> cryptographic execution proof is required.

### Proof-Policy Configuration

```python
# Low-risk generation (receipt only)
proof_policy = {"mode": "receipt_only"}

# High-impact structured routing (receipt + signatures)
proof_policy = {
    "mode": "receipt_only",
    "require_signatures": True,
    "signing_key_id": "prod-key-v1",
}

# High-assurance attestation (TEE or ZKML)
proof_policy = {
    "mode": "tee_or_zkml",
    "tee_measurement_allowlist": ["enclave-measurement-sha256:abcdef..."],
}

# Bounded classifier or checker circuit (ZKML required)
proof_policy = {
    "mode": "zkml_required",
    "verifier_key_hash": "sha256:verifier-key-hash-here",
    "circuit_id": "service-category-classifier-v1",
    "circuit_version": "1.0.0",
}
```

> **Warning — fail-closed for high-impact decisions**: Any workflow that affects
> service eligibility, emergency routing, or institutional audit must use
> `fail_closed: True`. A `LLMConsensusError` raised on quorum failure must be
> caught and treated as a routing failure — not as a non-verified fallback.
> Never silently degrade to unverified output on high-impact routes.

> **Warning — zkml_required applies only to bounded models**: Do not apply
> `zkml_required` to full large language model generation. A ZKML proof proves
> only the circuit it covers. Use `zkml_required` only for pinned bounded
> classifiers or checker circuits where a real verifier key and circuit
> commitment exist.

## Next Steps

1. **Try the examples**: `python -m ipfs_accelerate_py.space_inference_example`
2. **Run tests**: `pytest tests/test_hf_space_inference.py -v`
3. **Read the docs**: Start with `HF_SPACE_INFERENCE.md`
4. **Build your adapter**: Create a workflow class for your Space (100-200 lines)
5. **Integrate**: Import from `ipfs_accelerate_py` and use BatchProcessor

## Contributing

To add support for a new Space:

1. Create a workflow class (inherit from nothing, just use the generic APIs)
2. Implement Space-specific transforms (input/output)
3. Use `HFSpaceClient`, `BatchProcessor`, and an `OutputBackend`
4. Test against your Space
5. Share back!

## License

Same as 211-ai.github.io repo
