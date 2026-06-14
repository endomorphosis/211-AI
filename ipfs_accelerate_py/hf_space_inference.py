"""Generic Hugging Face Space inference provider for resumable batch workflows.

This module is intentionally API-shape agnostic:
- Callers provide endpoint names / fn indexes and payload shapes.
- The provider handles config discovery, queue orchestration, retries, and output backends.
"""

from __future__ import annotations

import json
import mimetypes
import os
import subprocess
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib import parse as urllib_parse

import requests


HeadersFactory = Callable[[], dict[str, str]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_api_name(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return raw if raw.startswith("/") else f"/{raw}"


@dataclass(frozen=True)
class SpaceRuntimeInfo:
    """Snapshot of Hugging Face Space runtime state."""

    stage: str
    hardware_current: str | None = None
    hardware_requested: str | None = None
    replicas: int = 0
    dev_mode: bool = False
    sleep_timeout: int | None = None
    domains: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EndpointContract:
    """Metadata about one dependency endpoint from Gradio config."""

    fn_index: int
    dependency_id: int
    label: str
    api_name: str
    component_name: str
    input_count: int | None = None


class OutputBackend(ABC):
    """Abstract interface for output storage backends."""

    @abstractmethod
    def put_file(self, local_path: Path, remote_path: str) -> bool:
        """Upload/copy local file to backend."""

    @abstractmethod
    def exists(self, remote_path: str) -> bool:
        """Return whether a backend path exists."""

    @abstractmethod
    def list_files(self, prefix: str) -> list[str]:
        """List backend files under a prefix."""

    def sync_directory(self, local_dir: Path, remote_prefix: str) -> int:
        """Sync all files under local_dir into remote_prefix."""

        count = 0
        if not local_dir.is_dir():
            return 0
        for local_file in local_dir.rglob("*"):
            if not local_file.is_file():
                continue
            rel_path = local_file.relative_to(local_dir)
            remote_path = f"{remote_prefix}/{rel_path.as_posix()}".rstrip("/")
            if self.put_file(local_file, remote_path):
                count += 1
        return count


class LocalFileSystemBackend(OutputBackend):
    """Output backend for local filesystem targets."""

    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir)

    def put_file(self, local_path: Path, remote_path: str) -> bool:
        remote = self.base_dir / remote_path
        remote.parent.mkdir(parents=True, exist_ok=True)
        try:
            remote.write_bytes(local_path.read_bytes())
            return True
        except Exception:
            return False

    def exists(self, remote_path: str) -> bool:
        return (self.base_dir / remote_path).exists()

    def list_files(self, prefix: str) -> list[str]:
        dir_path = self.base_dir / prefix
        if not dir_path.is_dir():
            return []
        return [str(path.relative_to(self.base_dir)) for path in dir_path.rglob("*") if path.is_file()]


class HFBucketBackend(OutputBackend):
    """Output backend for Hugging Face buckets via hf-cli."""

    def __init__(self, bucket_uri: str, hf_token: str | None = None):
        self.bucket_uri = str(bucket_uri or "").rstrip("/")
        self.hf_token = hf_token or os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.hf_token:
            env["HF_TOKEN"] = self.hf_token
        return env

    def put_file(self, local_path: Path, remote_path: str) -> bool:
        try:
            completed = subprocess.run(
                ["hf", "upload", self.bucket_uri, str(local_path), remote_path],
                env=self._env(),
                capture_output=True,
                timeout=180,
            )
            return completed.returncode == 0
        except Exception:
            return False

    def exists(self, remote_path: str) -> bool:
        try:
            target_uri = f"{self.bucket_uri}/{remote_path}".rstrip("/")
            completed = subprocess.run(
                ["hf", "ls-lh", target_uri],
                env=self._env(),
                capture_output=True,
                timeout=60,
            )
            return completed.returncode == 0
        except Exception:
            return False

    def list_files(self, prefix: str) -> list[str]:
        try:
            target_uri = f"{self.bucket_uri}/{prefix}".rstrip("/")
            completed = subprocess.run(
                ["hf", "ls-lh", target_uri],
                env=self._env(),
                capture_output=True,
                text=True,
                timeout=60,
            )
            if completed.returncode != 0:
                return []
            files: list[str] = []
            for line in completed.stdout.splitlines():
                text = line.strip()
                if not text or text.startswith("--"):
                    continue
                parts = text.split(None, 1)
                if len(parts) == 2:
                    files.append(parts[1])
            return files
        except Exception:
            return []


class HFSpaceClient:
    """Client for generic Hugging Face Space contract discovery and inference."""

    def __init__(
        self,
        space_url: str,
        timeout_seconds: float = 120.0,
        headers_factory: HeadersFactory | None = None,
    ):
        self.space_url = str(space_url or "").strip().rstrip("/")
        self.timeout_seconds = float(timeout_seconds)
        self.headers_factory = headers_factory
        self._config_cache: dict[str, Any] | None = None
        self._session = requests.Session()

    def _headers(self, *, accept: str = "application/json") -> dict[str, str]:
        headers = {"Accept": accept}
        if self.headers_factory is not None:
            try:
                headers.update(self.headers_factory() or {})
            except Exception:
                pass
        return headers

    def request_json(self, method: str, path: str, payload: Any | None = None) -> Any:
        url = f"{self.space_url}/{str(path).lstrip('/')}"
        resolved_method = method.upper()
        if resolved_method == "GET":
            response = self._session.get(
                url,
                headers=self._headers(),
                timeout=self.timeout_seconds,
            )
        elif resolved_method == "POST":
            response = self._session.post(
                url,
                json=payload,
                headers=self._headers(),
                timeout=self.timeout_seconds,
            )
        else:
            response = self._session.request(
                resolved_method,
                url,
                json=payload,
                headers=self._headers(),
                timeout=self.timeout_seconds,
            )
        response.raise_for_status()
        return response.json()

    # Backward-compatible alias used by existing tests and callers.
    def _get_config(self) -> dict[str, Any]:
        return self.get_config()

    def upload_file(self, file_name: str, data: bytes, mime_type: str = "application/octet-stream") -> Any:
        url = f"{self.space_url}/gradio_api/upload"
        files = {
            "files": (str(file_name or "upload.bin"), data, str(mime_type or "application/octet-stream")),
        }
        response = self._session.post(
            url,
            files=files,
            headers=self._headers(accept="application/json"),
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        return response.json()

    def get_config(self, *, use_cache: bool = True) -> dict[str, Any]:
        if use_cache and self._config_cache is not None:
            return self._config_cache
        config = self.request_json("GET", "config")
        if not isinstance(config, dict):
            raise ValueError("Space config response is not a JSON object")
        self._config_cache = config
        return config

    def get_endpoints(self, config: Mapping[str, Any] | None = None) -> list[EndpointContract]:
        resolved_config = dict(config or self.get_config())
        dependencies = resolved_config.get("dependencies")
        if not isinstance(dependencies, list):
            return []
        endpoints: list[EndpointContract] = []
        for idx, dependency in enumerate(dependencies):
            if not isinstance(dependency, Mapping):
                continue
            dep_id = dependency.get("id")
            if isinstance(dep_id, int):
                dependency_id = dep_id
            elif isinstance(dep_id, str) and dep_id.isdigit():
                dependency_id = int(dep_id)
            else:
                dependency_id = idx
            inputs = dependency.get("inputs")
            input_count = len(inputs) if isinstance(inputs, list) else None
            endpoints.append(
                EndpointContract(
                    fn_index=dependency_id,
                    dependency_id=dependency_id,
                    label=str(dependency.get("label") or f"fn_{dependency_id}"),
                    api_name=normalize_api_name(str(dependency.get("api_name") or "")),
                    component_name=str(dependency.get("component_name") or "unknown"),
                    input_count=input_count,
                )
            )
        return endpoints

    def dependency_api_names(self, config: Mapping[str, Any] | None = None) -> list[str]:
        names = [endpoint.api_name for endpoint in self.get_endpoints(config) if endpoint.api_name]
        deduped: dict[str, bool] = {}
        for name in names:
            deduped[name] = True
        return sorted(deduped.keys())

    def resolve_fn_index(
        self,
        api_name: str,
        config: Mapping[str, Any] | None = None,
        *,
        fallback_markers: Sequence[str] | None = None,
    ) -> int:
        target = normalize_api_name(api_name)
        endpoints = self.get_endpoints(config)
        if target:
            aliases = {target, target.lstrip("/")}
            for endpoint in endpoints:
                if endpoint.api_name in aliases or endpoint.api_name.lstrip("/") in aliases:
                    return endpoint.fn_index
        markers = [str(marker).strip().lower() for marker in (fallback_markers or ()) if str(marker).strip()]
        if markers:
            for endpoint in endpoints:
                name = f"{endpoint.api_name} {endpoint.label}".lower()
                if any(marker in name for marker in markers):
                    return endpoint.fn_index
        raise ValueError(f"Space api_name {api_name!r} was not found")

    def lookup_dependency_input_count(self, fn_index: int, config: Mapping[str, Any] | None = None) -> int | None:
        for endpoint in self.get_endpoints(config):
            if int(endpoint.fn_index) == int(fn_index):
                return endpoint.input_count
        return None

    def call_endpoint(self, fn_index: int, data: Sequence[Any]) -> list[Any]:
        payload = {"data": list(data), "fn_index": int(fn_index)}
        response = self._session.post(
            f"{self.space_url}/api/predict",
            json=payload,
            headers=self._headers(),
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        parsed = response.json()
        result = parsed.get("data") if isinstance(parsed, Mapping) else []
        return result if isinstance(result, list) else []

    def call_api_name(
        self,
        api_name: str,
        data: Sequence[Any],
        *,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float = 0.5,
    ) -> dict[str, Any]:
        normalized_api_name = normalize_api_name(api_name).lstrip("/")
        if not normalized_api_name:
            raise ValueError("api_name is required for Gradio call fallback")
        timeout = self.timeout_seconds if timeout_seconds is None else float(timeout_seconds)

        submit_response = self._session.post(
            f"{self.space_url}/gradio_api/call/{urllib_parse.quote(normalized_api_name)}",
            json={"data": list(data)},
            headers=self._headers(),
            timeout=timeout,
        )
        submit_response.raise_for_status()
        submitted = submit_response.json()
        if not isinstance(submitted, Mapping):
            raise ValueError("Gradio call submit response is not a JSON object")
        event_id = str(submitted.get("event_id") or submitted.get("eventId") or "").strip()
        if not event_id:
            # Some Gradio revisions may return immediate output.
            if isinstance(submitted.get("data"), list):
                return dict(submitted)
            raise ValueError("Gradio call submit response did not include event_id")

        deadline = time.time() + max(1.0, timeout)
        stream_url = (
            f"{self.space_url}/gradio_api/call/{urllib_parse.quote(normalized_api_name)}/"
            f"{urllib_parse.quote(event_id)}"
        )
        while time.time() < deadline:
            response = self._session.get(
                stream_url,
                headers=self._headers(),
                timeout=min(30.0, max(5.0, timeout)),
                stream=True,
            )
            response.raise_for_status()
            for raw_line in response.iter_lines(decode_unicode=True):
                line = str(raw_line or "").strip()
                if not line.startswith("data:"):
                    continue
                payload_text = line.removeprefix("data:").strip()
                if not payload_text:
                    continue
                event = json.loads(payload_text)
                if not isinstance(event, Mapping):
                    continue
                message = str(event.get("msg") or "")
                if message == "process_completed":
                    if event.get("success") is False:
                        output = event.get("output") or event
                        raise RuntimeError(f"Space Gradio call failed: {output}")
                    output = event.get("output")
                    return dict(output) if isinstance(output, Mapping) else dict(event)
                if message in {"process_failed", "queue_full"}:
                    raise RuntimeError(f"Space Gradio call failed: {event}")
            time.sleep(max(0.05, float(poll_interval_seconds)))
        raise TimeoutError("Space Gradio call timed out")

    def queue_join(self, fn_index: int, data: Sequence[Any], *, session_hash: str | None = None) -> str:
        resolved_session_hash = str(session_hash or uuid.uuid4().hex)
        payload = {
            "data": list(data),
            "fn_index": int(fn_index),
            "session_hash": resolved_session_hash,
        }
        self.request_json("POST", "gradio_api/queue/join", payload)
        return resolved_session_hash

    def wait_for_queue_result(
        self,
        session_hash: str,
        *,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float = 0.5,
    ) -> dict[str, Any]:
        timeout = self.timeout_seconds if timeout_seconds is None else float(timeout_seconds)
        deadline = time.time() + max(1.0, timeout)
        stream_url = (
            f"{self.space_url}/gradio_api/queue/data?session_hash={urllib_parse.quote(str(session_hash))}"
        )
        while time.time() < deadline:
            response = self._session.get(
                stream_url,
                headers=self._headers(),
                timeout=min(30.0, max(5.0, timeout)),
                stream=True,
            )
            response.raise_for_status()
            for raw_line in response.iter_lines(decode_unicode=True):
                line = str(raw_line or "").strip()
                if not line.startswith("data:"):
                    continue
                payload_text = line.removeprefix("data:").strip()
                if not payload_text:
                    continue
                event = json.loads(payload_text)
                if not isinstance(event, Mapping):
                    continue
                message = str(event.get("msg") or "")
                if message == "process_completed":
                    if event.get("success") is False:
                        output = event.get("output") or event
                        raise RuntimeError(f"Space queue failed: {output}")
                    output = event.get("output")
                    return dict(output) if isinstance(output, Mapping) else dict(event)
                if message in {"process_failed", "queue_full"}:
                    raise RuntimeError(f"Space queue failed: {event}")
            time.sleep(max(0.05, float(poll_interval_seconds)))
        raise TimeoutError("Space queue timed out")

    def file_url(self, reference: Any) -> str:
        if isinstance(reference, Mapping):
            direct_url = str(reference.get("url") or "").strip()
            if direct_url.startswith(("http://", "https://")):
                return direct_url
            path = str(reference.get("path") or reference.get("name") or "").strip()
        else:
            candidate = str(reference or "").strip()
            if candidate.startswith(("http://", "https://")):
                return candidate
            path = candidate
        encoded_path = urllib_parse.quote(path, safe="/:")
        return f"{self.space_url}/gradio_api/file={encoded_path}"

    def fetch_file(self, reference: Any, *, accept: str = "audio/*, application/octet-stream") -> tuple[bytes, str]:
        if isinstance(reference, Mapping):
            inline_bytes = reference.get("_inline_bytes")
            if isinstance(inline_bytes, (bytes, bytearray)):
                name = str(reference.get("name") or reference.get("path") or "")
                return bytes(inline_bytes), (mimetypes.guess_type(name)[0] or "application/octet-stream")
        response = self._session.get(
            self.file_url(reference),
            headers=self._headers(accept=accept),
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        mime_type = response.headers.get("Content-Type") or "application/octet-stream"
        return response.content, mime_type

    def probe_contract(self, expected_endpoints: Sequence[str] | None = None) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "available": False,
            "endpoints": [],
            "errors": [],
        }
        try:
            endpoints = self.get_endpoints()
            summary["available"] = True
            summary["endpoints"] = [
                {
                    "fn_index": endpoint.fn_index,
                    "label": endpoint.label,
                    "api_name": endpoint.api_name,
                    "component_name": endpoint.component_name,
                    "input_count": endpoint.input_count,
                }
                for endpoint in endpoints
            ]
            if expected_endpoints:
                available_names: set[str] = set()
                for endpoint in endpoints:
                    available_names.add(endpoint.api_name)
                    available_names.add(endpoint.api_name.lstrip("/"))
                    available_names.add(endpoint.label)
                for expected in expected_endpoints:
                    normalized = normalize_api_name(str(expected or ""))
                    if expected not in available_names and normalized not in available_names and normalized.lstrip("/") not in available_names:
                        summary["errors"].append(f"Expected endpoint {expected!r} not found")
                        summary["available"] = False
        except Exception as exc:
            summary["available"] = False
            summary["errors"].append(f"{type(exc).__name__}: {exc}")
        return summary


@dataclass(frozen=True)
class BatchState:
    """Persistent batch state for resumable processing."""

    schema_version: int = 1
    updated_at: str = ""
    total_items: int = 0
    next_offset: int = 0
    batch_size: int = 32
    batches_completed: int = 0
    failures: int = 0
    last_batch_id: str = ""
    stop_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "updatedAt": self.updated_at,
            "totalItems": self.total_items,
            "nextOffset": self.next_offset,
            "batchSize": self.batch_size,
            "batchesCompleted": self.batches_completed,
            "failures": self.failures,
            "lastBatchId": self.last_batch_id,
            **({"stopReason": self.stop_reason} if self.stop_reason else {}),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "BatchState":
        return cls(
            schema_version=int(data.get("schemaVersion", 1)),
            updated_at=str(data.get("updatedAt", "")),
            total_items=int(data.get("totalItems", 0)),
            next_offset=int(data.get("nextOffset", 0)),
            batch_size=int(data.get("batchSize", 32)),
            batches_completed=int(data.get("batchesCompleted", 0)),
            failures=int(data.get("failures", 0)),
            last_batch_id=str(data.get("lastBatchId", "")),
            stop_reason=str(data.get("stopReason", "")),
        )


class BatchProcessor:
    """Generic retrying batch processor that delegates payload shape to caller."""

    def __init__(
        self,
        client: HFSpaceClient,
        output_backend: OutputBackend,
        state_file: Path,
        batch_size: int = 32,
        retry_attempts: int = 3,
        retry_backoff_seconds: float = 10.0,
        retry_backoff_multiplier: float = 2.0,
        retry_backoff_max_seconds: float = 120.0,
    ):
        self.client = client
        self.output_backend = output_backend
        self.state_file = Path(state_file)
        self.batch_size = int(batch_size)
        self.retry_attempts = max(1, int(retry_attempts))
        self.retry_backoff_seconds = float(retry_backoff_seconds)
        self.retry_backoff_multiplier = float(retry_backoff_multiplier)
        self.retry_backoff_max_seconds = float(retry_backoff_max_seconds)

    def load_state(self) -> BatchState:
        if not self.state_file.exists():
            return BatchState(batch_size=self.batch_size)
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            if isinstance(data, Mapping):
                state = BatchState.from_dict(data)
                if state.batch_size <= 0:
                    return BatchState(batch_size=self.batch_size)
                return state
        except Exception:
            pass
        return BatchState(batch_size=self.batch_size)

    def save_state(self, state: BatchState) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        payload = BatchState(
            schema_version=state.schema_version,
            updated_at=_utc_now(),
            total_items=state.total_items,
            next_offset=state.next_offset,
            batch_size=state.batch_size,
            batches_completed=state.batches_completed,
            failures=state.failures,
            last_batch_id=state.last_batch_id,
            stop_reason=state.stop_reason,
        )
        self.state_file.write_text(json.dumps(payload.to_dict(), indent=2), encoding="utf-8")

    def calculate_retry_backoff(self, attempt: int) -> float:
        base = max(0.0, float(self.retry_backoff_seconds))
        factor = max(1.0, float(self.retry_backoff_multiplier))
        capped_max = max(base, float(self.retry_backoff_max_seconds))
        return min(capped_max, base * (factor ** max(0, int(attempt))))

    def process_batch(
        self,
        items: Sequence[Any],
        endpoint_fn_index: int,
        output_batch_id: str,
        output_dir: Path | None = None,
        *,
        payload_builder: Callable[[Sequence[Any]], Sequence[Any]] | None = None,
        use_queue: bool = False,
        queue_timeout_seconds: float | None = None,
    ) -> tuple[bool, list[Any]]:
        attempt = 0
        while attempt < self.retry_attempts:
            try:
                payload = list(payload_builder(items) if payload_builder is not None else items)
                if use_queue:
                    session_hash = self.client.queue_join(endpoint_fn_index, payload)
                    result = self.client.wait_for_queue_result(session_hash, timeout_seconds=queue_timeout_seconds)
                    results = result.get("data") if isinstance(result, Mapping) else []
                    if not isinstance(results, list):
                        results = []
                else:
                    results = self.client.call_endpoint(endpoint_fn_index, payload)
                if output_dir is not None:
                    output_dir.mkdir(parents=True, exist_ok=True)
                return True, list(results)
            except Exception:
                attempt += 1
                if attempt >= self.retry_attempts:
                    return False, []
                time.sleep(self.calculate_retry_backoff(attempt - 1))
        return False, []


__all__ = [
    "SpaceRuntimeInfo",
    "EndpointContract",
    "OutputBackend",
    "LocalFileSystemBackend",
    "HFBucketBackend",
    "HFSpaceClient",
    "BatchState",
    "BatchProcessor",
    "normalize_api_name",
]
