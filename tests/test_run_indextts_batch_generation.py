from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from scripts import run_indextts_batch_generation as batch_runner


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _build_args(tmp_path: Path, **overrides: object) -> SimpleNamespace:
    payload = {
        "batch_size": 2,
        "remote_batch_size": 2,
        "parallel_workers": 1,
        "space_url": "https://publicus-indextts-2-demo.hf.space",
        "bucket_uri": "hf://buckets/Publicus/abby-voice/test-phase",
        "batch_retry_attempts": 1,
        "batch_retry_backoff_seconds": 0.1,
        "batch_retry_backoff_multiplier": 2.0,
        "batch_retry_max_backoff_seconds": 1.0,
        "max_runtime_seconds": 60.0,
        "start_offset": 0,
        "state": tmp_path / "state.json",
        "batch_manifest_dir": tmp_path / "batch-manifests",
        "progress_dir": tmp_path / "progress",
        "output_dir": tmp_path / "audio",
        "public_manifest": tmp_path / "public-manifest.json",
        "response_manifest": tmp_path / "responses.json",
        "dag": tmp_path / "dag.json",
        "results": tmp_path / "results.json",
        "stop_on_error": False,
        "force": False,
        "validate_transcripts": False,
        "transcript_validation_limit": 1,
        "transcript_validation_model": "tiny.en",
        "transcript_validation_language": "en",
        "transcript_validation_device": "auto",
        "transcript_validation_threshold": 0.72,
        "transcript_validation_soft_fail": False,
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


def test_build_precompute_command_passes_space_and_bucket_args(tmp_path: Path) -> None:
    args = _build_args(tmp_path)

    command = batch_runner.build_precompute_command(
        args,
        manifest=tmp_path / "batch-manifests" / "batch.json",
        progress=tmp_path / "progress" / "batch.progress.json",
        offset=4,
        remaining_seconds=30,
    )

    assert command[command.index("--space-url") + 1] == "https://publicus-indextts-2-demo.hf.space"
    assert command[command.index("--bucket-uri") + 1] == "hf://buckets/Publicus/abby-voice/test-phase"
    assert command[command.index("--offset") + 1] == "4"


def test_build_precompute_command_omits_runtime_limit_when_unbounded(tmp_path: Path) -> None:
    args = _build_args(tmp_path, max_runtime_seconds=0.0)

    command = batch_runner.build_precompute_command(
        args,
        manifest=tmp_path / "batch-manifests" / "batch.json",
        progress=tmp_path / "progress" / "batch.progress.json",
        offset=4,
        remaining_seconds=None,
    )

    assert "--max-runtime-seconds" not in command


def test_runtime_deadline_is_unbounded_for_non_positive_values() -> None:
    assert batch_runner.runtime_deadline(100.0, 0.0) is None
    assert batch_runner.runtime_deadline(100.0, -1.0) is None
    assert batch_runner.runtime_deadline(100.0, None) is None
    assert batch_runner.runtime_deadline(100.0, 30.0) == 130.0


def test_main_retries_transient_manifest_failures_before_advancing_offset(monkeypatch, tmp_path: Path) -> None:
    args = _build_args(tmp_path)
    manifest_path = args.batch_manifest_dir / "batch-00000-offset-000000.json"
    progress_path = args.progress_dir / "batch-00000-offset-000000.progress.json"
    calls: list[list[str]] = []
    sleeps: list[float] = []

    monkeypatch.setattr(batch_runner, "parse_args", lambda: args)
    monkeypatch.setattr(batch_runner, "total_response_count", lambda response_manifest, dag, results: 2)
    monkeypatch.setattr(batch_runner.time, "sleep", lambda seconds: sleeps.append(seconds))

    def fake_run(command: list[str], cwd: Path) -> SimpleNamespace:
        calls.append(command)
        if len(calls) == 1:
            _write_json(
                manifest_path,
                {
                    "responses": [
                        {
                            "status": "failed",
                            "error": "RuntimeError: IndexTTS queue failed: {'title': 'ZeroGPU worker error'}",
                        },
                        {
                            "status": "failed",
                            "error": "RuntimeError: IndexTTS queue failed: {'title': 'ZeroGPU worker error'}",
                        },
                    ]
                },
            )
        else:
            _write_json(
                manifest_path,
                {
                    "responses": [
                        {"status": "generated"},
                        {"status": "generated"},
                    ]
                },
            )
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        progress_path.write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(batch_runner.subprocess, "run", fake_run)

    exit_code = batch_runner.main()

    state = json.loads(args.state.read_text(encoding="utf-8"))
    assert exit_code == batch_runner.EXIT_SUCCESS
    assert len(calls) == 2
    assert sleeps == [0.1]
    assert state["nextOffset"] == 2
    assert state["batchesCompleted"] == 1


def test_main_stops_without_advancing_offset_when_failures_persist(monkeypatch, tmp_path: Path) -> None:
    args = _build_args(tmp_path)
    manifest_path = args.batch_manifest_dir / "batch-00000-offset-000000.json"
    progress_path = args.progress_dir / "batch-00000-offset-000000.progress.json"
    calls: list[list[str]] = []

    monkeypatch.setattr(batch_runner, "parse_args", lambda: args)
    monkeypatch.setattr(batch_runner, "total_response_count", lambda response_manifest, dag, results: 2)
    monkeypatch.setattr(batch_runner.time, "sleep", lambda seconds: None)

    def fake_run(command: list[str], cwd: Path) -> SimpleNamespace:
        calls.append(command)
        _write_json(
            manifest_path,
            {
                "responses": [
                    {
                        "status": "failed",
                        "error": "RuntimeError: IndexTTS queue failed: {'title': 'ZeroGPU worker error'}",
                    },
                    {
                        "status": "failed",
                        "error": "RuntimeError: IndexTTS queue failed: {'title': 'ZeroGPU worker error'}",
                    },
                ]
            },
        )
        progress_path.parent.mkdir(parents=True, exist_ok=True)
        progress_path.write_text("{}", encoding="utf-8")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(batch_runner.subprocess, "run", fake_run)

    exit_code = batch_runner.main()

    state = json.loads(args.state.read_text(encoding="utf-8"))
    assert exit_code == batch_runner.EXIT_BATCH_FAILED
    assert len(calls) == 2
    assert state["nextOffset"] == 0
    assert state["batchesCompleted"] == 0
    assert "ZeroGPU worker error" in state["stopReason"]


def test_main_returns_runtime_limit_when_deadline_expires(monkeypatch, tmp_path: Path) -> None:
    args = _build_args(tmp_path, max_runtime_seconds=1.0)
    time_values = iter([100.0, 101.5, 101.5, 101.5])

    monkeypatch.setattr(batch_runner, "parse_args", lambda: args)
    monkeypatch.setattr(batch_runner, "total_response_count", lambda response_manifest, dag, results: 2)
    monkeypatch.setattr(batch_runner.time, "time", lambda: next(time_values))

    exit_code = batch_runner.main()

    state = json.loads(args.state.read_text(encoding="utf-8"))
    assert exit_code == batch_runner.EXIT_RUNTIME_LIMIT
    assert state["nextOffset"] == 0
    assert "Reached runtime deadline" in state["stopReason"]