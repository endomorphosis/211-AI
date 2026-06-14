"""Gated libp2p integration smoke test for LLM consensus fan-out."""

from __future__ import annotations

import importlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from ipfs_accelerate_py.llm_consensus import (
    P2P_REQUEST_SCHEMA_VERSION,
    P2P_RESPONSE_SCHEMA_VERSION,
    P2PConsensusPeer,
    build_consensus_request,
    normalized_output_hash,
    run_p2p_consensus,
    sha256_digest,
)


RUN_ENV = "IPFS_ACCELERATE_PY_RUN_LLM_CONSENSUS_P2P_TESTS"
REPO_ROOT = Path(__file__).resolve().parents[2]
VENDORED_IPFS_DATASETS = REPO_ROOT / "ipfs_datasets_py"


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


pytestmark = pytest.mark.skipif(
    not _truthy_env(RUN_ENV),
    reason=f"Set {RUN_ENV}=1 to run gated libp2p LLM consensus integration tests",
)


def _repo_has_p2p_tasks() -> bool:
    return (REPO_ROOT / "ipfs_accelerate_py" / "p2p_tasks").is_dir()


def _extend_ipfs_accelerate_package_path_for_p2p_tasks() -> None:
    """Let this repo's lightweight package see an installed p2p_tasks subpackage."""

    import ipfs_accelerate_py

    package_path = getattr(ipfs_accelerate_py, "__path__", None)
    if package_path is None:
        return

    for entry in sys.path:
        base = Path(entry or ".").resolve()
        candidate = base / "ipfs_accelerate_py"
        if not (candidate / "p2p_tasks").is_dir():
            continue
        candidate_text = str(candidate)
        if candidate_text not in package_path:
            package_path.append(candidate_text)
    importlib.invalidate_caches()


def _require_p2p_stack() -> None:
    _extend_ipfs_accelerate_package_path_for_p2p_tasks()

    for module_name, reason in (
        ("duckdb", "duckdb is required for local TaskQueue workers"),
        ("libp2p", "libp2p is required for p2p TaskQueue smoke tests"),
    ):
        try:
            importlib.import_module(module_name)
        except Exception as exc:
            pytest.skip(f"{reason}: {type(exc).__name__}: {exc}")

    try:
        compat = importlib.import_module("ipfs_accelerate_py.github_cli.libp2p_compat")
    except Exception:
        compat = None
    if compat is not None and not compat.ensure_libp2p_compatible():
        pytest.skip("libp2p compatibility patches are unavailable in this environment")

    missing: list[str] = []
    for module_name in (
        "ipfs_accelerate_py.p2p_tasks.client",
        "ipfs_accelerate_py.p2p_tasks.service",
        "ipfs_datasets_py.ml.accelerate_integration.p2p_task_client",
        "ipfs_datasets_py.ml.accelerate_integration.p2p_task_service",
    ):
        try:
            importlib.import_module(module_name)
        except Exception as exc:
            missing.append(f"{module_name}: {type(exc).__name__}: {exc}")
    if missing:
        pytest.skip("libp2p task queue dependencies unavailable: " + "; ".join(missing))


def _free_tcp_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
    finally:
        sock.close()


def _tail(path: Path, max_chars: int = 4000) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-max_chars:]


def _service_env(port: int, announce_path: Path) -> dict[str, str]:
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH", "")
    pythonpath_parts = [str(VENDORED_IPFS_DATASETS)]
    if _repo_has_p2p_tasks():
        pythonpath_parts.insert(0, str(REPO_ROOT))
    env["PYTHONPATH"] = os.pathsep.join(
        pythonpath_parts + ([existing_pythonpath] if existing_pythonpath else [])
    )

    for prefix in ("IPFS_ACCELERATE_PY", "IPFS_DATASETS_PY"):
        env[f"{prefix}_TASK_P2P_PUBLIC_IP"] = "127.0.0.1"
        env[f"{prefix}_TASK_P2P_LISTEN_HOST"] = "127.0.0.1"
        env[f"{prefix}_TASK_P2P_LISTEN_PORT"] = str(port)
        env[f"{prefix}_TASK_P2P_ANNOUNCE_FILE"] = str(announce_path)
        env[f"{prefix}_TASK_P2P_MDNS"] = "0"
        env[f"{prefix}_TASK_P2P_DHT"] = "0"
        env[f"{prefix}_TASK_P2P_RENDEZVOUS"] = "0"
        env[f"{prefix}_TASK_P2P_AUTONAT"] = "0"
        env[f"{prefix}_TASK_P2P_RELAY"] = "0"
        env[f"{prefix}_TASK_P2P_HOLEPUNCH"] = "0"
        env[f"{prefix}_TASK_P2P_BOOTSTRAP_PEERS"] = "0"
    return env


@dataclass
class _LocalP2PService:
    name: str
    queue_path: Path
    announce_path: Path
    stdout_path: Path
    stderr_path: Path
    process: subprocess.Popen[bytes]
    peer_id: str = ""
    multiaddr: str = ""

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5.0)

    def logs(self) -> str:
        stdout_tail = _tail(self.stdout_path)
        stderr_tail = _tail(self.stderr_path)
        return f"stdout:\n{stdout_tail}\nstderr:\n{stderr_tail}".strip()


def _start_service(tmp_path: Path, name: str) -> _LocalP2PService:
    port = _free_tcp_port()
    queue_path = tmp_path / f"{name}.duckdb"
    announce_path = tmp_path / f"{name}.announce.json"
    stdout_path = tmp_path / f"{name}.stdout.log"
    stderr_path = tmp_path / f"{name}.stderr.log"

    argv = [
        sys.executable,
        "-m",
        "ipfs_datasets_py.ml.accelerate_integration.p2p_task_service",
        "--queue",
        str(queue_path),
        "--listen-port",
        str(port),
        "--no-p2p-dht",
        "--no-p2p-rendezvous",
        "--no-p2p-autonat",
    ]
    stdout_file = stdout_path.open("wb")
    stderr_file = stderr_path.open("wb")
    try:
        process = subprocess.Popen(
            argv,
            cwd=str(tmp_path),
            env=_service_env(port, announce_path),
            stdout=stdout_file,
            stderr=stderr_file,
        )
    finally:
        stdout_file.close()
        stderr_file.close()

    service = _LocalP2PService(
        name=name,
        queue_path=queue_path,
        announce_path=announce_path,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        process=process,
    )

    deadline = time.time() + 20.0
    while time.time() < deadline:
        if process.poll() is not None:
            pytest.skip(
                f"libp2p task service {name!r} exited before announcing "
                f"(rc={process.returncode}); {service.logs()}"
            )
        if announce_path.exists():
            info = json.loads(announce_path.read_text(encoding="utf-8"))
            multiaddr = str(info.get("multiaddr") or info.get("listen_multiaddr") or "")
            peer_id = str(info.get("peer_id") or "")
            if not peer_id and "/p2p/" in multiaddr:
                peer_id = multiaddr.rsplit("/p2p/", 1)[-1].split("/", 1)[0]
            if peer_id and "/p2p/" in multiaddr:
                service.peer_id = peer_id
                service.multiaddr = multiaddr
                return service
        time.sleep(0.05)

    service.stop()
    pytest.skip(f"libp2p task service {name!r} did not announce within 20s; {service.logs()}")


def _worker_response(
    *,
    payload: dict[str, Any],
    worker_id: str,
    peer_id: str,
    output_text: str,
) -> dict[str, Any]:
    comparison = str(payload.get("comparison") or "exact")
    return {
        "schema_version": P2P_RESPONSE_SCHEMA_VERSION,
        "request_id": str(payload.get("request_id") or ""),
        "request_hash": str(payload.get("request_hash") or ""),
        "operator_id": worker_id,
        "peer_id": peer_id,
        "provider": str(payload.get("provider") or "local-fixture"),
        "model_name": str(payload.get("model_name") or "deterministic-json"),
        "output_text": output_text,
        "output_hash": sha256_digest(output_text),
        "normalized_output_hash": normalized_output_hash(output_text, comparison=comparison),
        "metadata": {
            "worker_id": worker_id,
            "source": "clzkml-190-local-worker",
        },
    }


def _start_consensus_worker(
    *,
    queue_path: Path,
    worker_id: str,
    peer_id: str,
    output_text: str,
    stop_event: threading.Event,
    errors: list[str],
) -> threading.Thread:
    def _run() -> None:
        try:
            from ipfs_datasets_py.ml.accelerate_integration.task_queue import TaskQueue

            queue = TaskQueue(str(queue_path))
            deadline = time.time() + 30.0
            while not stop_event.is_set() and time.time() < deadline:
                task = queue.claim_next(
                    worker_id=worker_id,
                    supported_task_types=[P2P_REQUEST_SCHEMA_VERSION],
                )
                if task is None:
                    time.sleep(0.05)
                    continue

                result = _worker_response(
                    payload=task.payload,
                    worker_id=worker_id,
                    peer_id=peer_id,
                    output_text=output_text,
                )
                queue.complete(task_id=task.task_id, status="completed", result=result)
                return

            errors.append(f"{worker_id} did not process a consensus task before timeout")
        except BaseException as exc:
            errors.append(f"{worker_id} failed: {type(exc).__name__}: {exc}")

    thread = threading.Thread(target=_run, name=f"clzkml-190-worker[{worker_id}]", daemon=True)
    thread.start()
    return thread


def test_three_local_libp2p_workers_reach_two_of_three_consensus(tmp_path: Path) -> None:
    _require_p2p_stack()

    services: list[_LocalP2PService] = []
    worker_threads: list[threading.Thread] = []
    worker_errors: list[str] = []
    stop_event = threading.Event()

    try:
        worker_outputs = {
            "worker-a": '{"answer":"4"}',
            "worker-b": '{\n  "answer": "4"\n}',
            "worker-c": '{"answer":"5"}',
        }
        for worker_id in worker_outputs:
            services.append(_start_service(tmp_path, worker_id))

        for service, (worker_id, output_text) in zip(services, worker_outputs.items()):
            worker_threads.append(
                _start_consensus_worker(
                    queue_path=service.queue_path,
                    worker_id=worker_id,
                    peer_id=service.peer_id,
                    output_text=output_text,
                    stop_event=stop_event,
                    errors=worker_errors,
                )
            )

        request = build_consensus_request(
            prompt="Return JSON with the answer to 2+2.",
            provider="local-fixture",
            model_name="deterministic-json",
            generation_params={"temperature": 0, "max_tokens": 16, "seed": 190},
            proof_policy={"mode": "receipt_only"},
            nonce="clzkml-190-local-p2p",
            comparison="canonical_json",
            quorum=2,
            min_operators=3,
        )
        peers = [
            P2PConsensusPeer(
                peer_id=service.peer_id,
                multiaddr=service.multiaddr,
                operator_id=worker_id,
                provider="local-fixture",
                model_name="deterministic-json",
            )
            for service, worker_id in zip(services, worker_outputs)
        ]

        receipt = run_p2p_consensus(
            request=request,
            prompt="Return JSON with the answer to 2+2.",
            peers=peers,
            timeout_s=20.0,
            per_peer_timeout_s=10.0,
            fail_closed=True,
            created_at="2026-06-13T12:00:00Z",
        )

        for thread in worker_threads:
            thread.join(timeout=5.0)

        assert worker_errors == []
        assert receipt.consensus.accepted is True
        assert receipt.consensus.reason == "quorum_met"
        assert receipt.consensus.quorum == 2
        assert receipt.consensus.total_successful == 3
        assert receipt.consensus.selected_operator_ids == ["worker-a", "worker-b"]
        assert receipt.consensus.rejected_operator_ids == ["worker-c"]
        assert {response.transport for response in receipt.responses} == {"libp2p"}
        assert {response.operator_id for response in receipt.responses} == {
            "worker-a",
            "worker-b",
            "worker-c",
        }
        assert {response.error for response in receipt.responses} == {None}
    finally:
        stop_event.set()
        for thread in worker_threads:
            thread.join(timeout=1.0)
        for service in services:
            service.stop()
