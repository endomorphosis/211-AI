# Hugging Face Space Inference Provider for ipfs_accelerate_py

Generic, pluggable interface for batch processing through Hugging Face Spaces with support for multiple output backends, retryable processing, and resumable workflows.

## Overview

The `hf_space_inference` module provides reusable abstractions for building batch inference pipelines against any Hugging Face Space:

- **`HFSpaceClient`**: Handles Space interaction (contract probing, endpoint discovery, calls)
- **`OutputBackend`**: Abstract interface for writing results (local filesystem, HF buckets, custom backends)
- **`BatchProcessor`**: Orchestrates batching, retry logic, and state checkpointing
- **Pre-built backends**: `LocalFileSystemBackend`, `HFBucketBackend`

## Quick Start

### 1. Create a Space Client

```python
from ipfs_accelerate_py.hf_space_inference import HFSpaceClient

client = HFSpaceClient("https://my-user-my-space.hf.space")

# Probe the Space to verify it's ready
contract = client.probe_contract()
print(f"Available: {contract['available']}")
print(f"Endpoints: {contract['endpoints']}")
```

### 2. Choose an Output Backend

Local filesystem:
```python
from ipfs_accelerate_py.hf_space_inference import LocalFileSystemBackend

backend = LocalFileSystemBackend("/data/outputs")
```

Or Hugging Face bucket:
```python
from ipfs_accelerate_py.hf_space_inference import HFBucketBackend

backend = HFBucketBackend(
    bucket_uri="hf://buckets/my-org/my-bucket/runs/run-001",
    hf_token=None,  # Uses HF_TOKEN env var
)
```

### 3. Create Batch Processor

```python
from ipfs_accelerate_py.hf_space_inference import BatchProcessor
from pathlib import Path

processor = BatchProcessor(
    client=client,
    output_backend=backend,
    state_file=Path("state.json"),  # For resumability
    batch_size=8,
    retry_attempts=3,
    retry_backoff_seconds=10.0,
)
```

### 4. Process Batches

```python
# Load previous state (or start fresh)
state = processor.load_state()

# Your input items (from manifest, list, database, etc.)
items = [{"text": "hello"}, {"text": "world"}]

# Process a batch
success, results = processor.process_batch(
    items=items,
    endpoint_fn_index=0,  # From Space config
    output_batch_id="batch-001",
)

# Update and save state
if success:
    state = state._replace(next_offset=len(items))
    processor.save_state(state)
```

## Architecture

### HFSpaceClient

Minimal wrapper around Gradio Space HTTP API:

```python
client = HFSpaceClient(space_url)

# Get available endpoints
endpoints = client.get_endpoints()
# → [EndpointContract(fn_index=0, label="process", ...)]

# Call an endpoint
results = client.call_endpoint(fn_index=0, data=[input1, input2])

# Verify Space is ready
contract = client.probe_contract(expected_endpoints=["process"])
```

### OutputBackend (Abstract)

Pluggable interface for any storage:

```python
class OutputBackend(ABC):
    def put_file(self, local_path: Path, remote_path: str) -> bool:
        """Upload file"""
    
    def exists(self, remote_path: str) -> bool:
        """Check existence"""
    
    def list_files(self, prefix: str) -> list[str]:
        """List files at prefix"""
    
    def sync_directory(self, local_dir: Path, remote_prefix: str) -> int:
        """Sync entire directory"""
```

Implement for custom backends (S3, GCS, databases, etc.):

```python
class MyCustomBackend(OutputBackend):
    def put_file(self, local_path: Path, remote_path: str) -> bool:
        # Your implementation
        pass
    
    def exists(self, remote_path: str) -> bool:
        # Your implementation
        pass
    
    def list_files(self, prefix: str) -> list[str]:
        # Your implementation
        pass
```

### BatchProcessor

Stateful batch orchestration with retry logic:

```python
processor = BatchProcessor(
    client=client,
    output_backend=backend,
    state_file=Path("state.json"),
    batch_size=32,
    retry_attempts=3,
    retry_backoff_seconds=10.0,
    retry_backoff_multiplier=2.0,
    retry_backoff_max_seconds=120.0,
)

# Resume from checkpoint
state = processor.load_state()
print(f"Processed: {state.next_offset}/{state.total_items}")

# Process batch with automatic retries
success, results = processor.process_batch(
    items=batch_items,
    endpoint_fn_index=0,
    output_batch_id="batch-001",
    output_dir=Path("tmp/output"),
)

if success:
    # Update and persist state
    state = state._replace(next_offset=new_offset)
    processor.save_state(state)
```

### BatchState

Checkpoint format for resumability:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-06-12T12:30:00Z",
  "totalItems": 1000,
  "nextOffset": 320,
  "batchSize": 32,
  "batchesCompleted": 10,
  "failures": 0,
  "lastBatchId": "batch-000320-000352"
}
```

## Design Philosophy

### Generic vs. Specific

The module is **intentionally generic**:

- **Not baked in**: Manifest formats, input/output schemas, endpoint signatures
- **User-provided**: You specify endpoint index, input/output transformation, field names
- **Pluggable backends**: Support any storage destination (local, buckets, databases, etc.)

### Separation of Concerns

- **HFSpaceClient**: Just Space interaction (discovery, calls, health checks)
- **OutputBackend**: Just file/data storage (implementation swappable)
- **BatchProcessor**: Just orchestration (batching, retry, checkpointing)

### Resumability

- **State checkpoint on disk**: Survives process crashes or cancellations
- **State-based continuation**: `next_offset` + `batch_size` = retry-safe resumption
- **Batch ID tracking**: Enables idempotency and manual recovery

## Migration from IndexTTS Scripts

If you're migrating from the existing `scripts/precompute_indextts_responses.py` implementation:

### Before (IndexTTS-specific):

```python
# Hardcoded to IndexTTS Space shape
from scripts import precompute_indextts_responses

manifest = precompute_indextts_responses.load_audio_responses_from_manifest(path)
# ... lots of IndexTTS-specific logic ...
```

### After (Generic, reusable):

```python
from ipfs_accelerate_py.hf_space_inference import (
    HFSpaceClient,
    BatchProcessor,
    HFBucketBackend,
)

# Your Space
client = HFSpaceClient("https://my-space.hf.space")

# Your backend
backend = HFBucketBackend("hf://buckets/my-org/my-bucket")

# Your processor
processor = BatchProcessor(
    client=client,
    output_backend=backend,
    state_file=Path("state.json"),
    batch_size=8,
)

# Your manifest/input format
my_items = load_my_items("manifest.json")

# Your processing loop
for batch in chunks(my_items, size=8):
    success, results = processor.process_batch(
        items=batch,
        endpoint_fn_index=YOUR_ENDPOINT_INDEX,
        output_batch_id=f"batch-{offset}",
    )
```

The key benefit: the same `HFSpaceClient`, `BatchProcessor`, and backend infrastructure works for any Space, any manifest format, any output destination.

## Testing

```bash
# Run unit tests
pytest tests/test_hf_space_inference.py -v

# Example usage
python -m ipfs_accelerate_py.space_inference_example
```

## Error Handling

Batch processing includes automatic retry with exponential backoff:

```python
# Transient failures (network, timeouts) → retry automatically
# Permanent failures (invalid input, auth) → fail immediately
# Retries respects backoff: 10s → 20s → 40s (up to 120s max)

success, results = processor.process_batch(...)
if not success:
    print("Batch failed after all retries")
```

For supervisor-level concerns (Space sleep, offline runtimes), see the monitor module (TBD).

## Advanced: Custom Backend

```python
from ipfs_accelerate_py.hf_space_inference import OutputBackend
import boto3

class S3Backend(OutputBackend):
    def __init__(self, bucket: str, prefix: str = ""):
        self.bucket = bucket
        self.prefix = prefix.rstrip("/")
        self.s3 = boto3.client("s3")
    
    def put_file(self, local_path: Path, remote_path: str) -> bool:
        key = f"{self.prefix}/{remote_path}".lstrip("/")
        try:
            self.s3.upload_file(str(local_path), self.bucket, key)
            return True
        except Exception:
            return False
    
    def exists(self, remote_path: str) -> bool:
        key = f"{self.prefix}/{remote_path}".lstrip("/")
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except:
            return False
    
    def list_files(self, prefix: str) -> list[str]:
        path = f"{self.prefix}/{prefix}".lstrip("/")
        try:
            response = self.s3.list_objects_v2(Bucket=self.bucket, Prefix=path)
            return [obj["Key"] for obj in response.get("Contents", [])]
        except:
            return []

# Use it
backend = S3Backend("my-bucket", "runs/exp-001")
processor = BatchProcessor(client, backend, state_file, ...)
```

## See Also

- `space_inference_example.py`: Full working examples
- `scripts/precompute_indextts_responses.py`: Reference IndexTTS-specific implementation
- [Gradio API Docs](https://www.gradio.app/docs/gradio)
- [Hugging Face Spaces](https://huggingface.co/docs/hub/spaces)
