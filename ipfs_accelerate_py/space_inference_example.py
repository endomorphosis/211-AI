"""Example: Using ipfs_accelerate_py.hf_space_inference for custom Hugging Face Space batch processing.

This example demonstrates how to use the generic Space inference API to build a custom
inference workflow for any Hugging Face Space, with pluggable output backends.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ipfs_accelerate_py.hf_space_inference import (
    BatchProcessor,
    HFBucketBackend,
    HFSpaceClient,
    LocalFileSystemBackend,
)


def example_custom_inference():
    """Example: Process items through a custom Space endpoint with batching and resumability."""
    
    # 1. Initialize Space client
    space_url = "https://my-user-my-space.hf.space"
    client = HFSpaceClient(space_url, timeout_seconds=120.0)
    
    # 2. Probe to verify the Space is ready and has expected endpoints
    contract = client.probe_contract(expected_endpoints=["process_batch"])
    print(f"Space contract: {json.dumps(contract, indent=2)}")
    if not contract["available"]:
        raise RuntimeError(f"Space not ready: {contract['errors']}")
    
    # 3. Choose output backend:
    # Option A: Local filesystem
    # output_backend = LocalFileSystemBackend(Path("/tmp/my-space-output"))
    
    # Option B: Hugging Face bucket
    output_backend = HFBucketBackend(
        bucket_uri="hf://buckets/my-user/my-bucket/runs/my-run-20260612",
        hf_token=None,  # Uses HF_TOKEN environment variable
    )
    
    # 4. Create batch processor with state checkpointing
    state_file = Path("tmp_assets/my-space-state.json")
    processor = BatchProcessor(
        client=client,
        output_backend=output_backend,
        state_file=state_file,
        batch_size=8,
        retry_attempts=3,
        retry_backoff_seconds=10.0,
        retry_backoff_multiplier=2.0,
    )
    
    # 5. Load existing state to resume from checkpoint
    state = processor.load_state()
    print(f"Loaded state: offset={state.next_offset}, completed={state.batches_completed}")
    
    # 6. Define your input items (e.g., from a manifest, database, file list, etc.)
    all_items = [
        {"id": "item-001", "text": "hello world"},
        {"id": "item-002", "text": "foo bar"},
        {"id": "item-003", "text": "baz qux"},
        # ... more items
    ]
    
    # 7. Process batches until completion or error
    total_items = len(all_items)
    state = state._replace(total_items=total_items)
    
    while state.next_offset < total_items:
        batch_start = state.next_offset
        batch_end = min(batch_start + state.batch_size, total_items)
        batch_items = all_items[batch_start:batch_end]
        batch_id = f"batch-{batch_start:06d}-{batch_end:06d}"
        
        print(f"Processing {batch_id}: {len(batch_items)} items")
        
        # 8. Call the Space endpoint with your batch
        # The endpoint should return results matching the input structure
        success, results = processor.process_batch(
            items=batch_items,
            endpoint_fn_index=0,  # Index of your endpoint from Space config
            output_batch_id=batch_id,
            output_dir=Path("tmp_assets") / batch_id / "output",
        )
        
        if not success:
            state = state._replace(
                stop_reason=f"Batch {batch_id} failed after retries",
                failures=state.failures + 1,
            )
            processor.save_state(state)
            raise RuntimeError(f"Batch {batch_id} failed")
        
        # 9. Write results to output backend
        results_file = Path("tmp_assets") / batch_id / "results.json"
        results_file.parent.mkdir(parents=True, exist_ok=True)
        results_file.write_text(json.dumps(results, indent=2), encoding="utf-8")
        
        # Optional: sync to output backend (e.g., HF bucket)
        output_backend.put_file(
            results_file,
            f"{batch_id}/results.json",
        )
        
        # 10. Update state and checkpoint
        state = state._replace(
            next_offset=batch_end,
            batches_completed=state.batches_completed + 1,
        )
        processor.save_state(state)
        print(f"  Completed: {batch_end}/{total_items}")
    
    print(f"All batches complete! Total: {state.batches_completed} batches processed")


def example_with_local_filesystem():
    """Example: Simple local processing without HF bucket."""
    
    client = HFSpaceClient("https://example-space.hf.space")
    output_dir = Path("/tmp/space-output")
    output_backend = LocalFileSystemBackend(output_dir)
    
    processor = BatchProcessor(
        client=client,
        output_backend=output_backend,
        state_file=output_dir / "state.json",
        batch_size=16,
    )
    
    # Now use processor.process_batch() as shown above
    pass


def example_with_hf_bucket():
    """Example: Process directly to Hugging Face bucket."""
    
    client = HFSpaceClient("https://example-space.hf.space")
    
    # Output goes directly to HF bucket
    output_backend = HFBucketBackend(
        bucket_uri="hf://buckets/org/my-bucket/runs/exp-001"
    )
    
    processor = BatchProcessor(
        client=client,
        output_backend=output_backend,
        state_file=Path("local_state.json"),  # Local state for resumability
        batch_size=32,
    )
    
    # Now use processor.process_batch() as shown above
    pass


if __name__ == "__main__":
    # Uncomment to run:
    # example_custom_inference()
    print("See docstrings for usage examples.")
