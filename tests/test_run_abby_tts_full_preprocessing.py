from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from scripts import run_abby_tts_full_preprocessing as full_preprocess


def _build_args(tmp_path: Path, **overrides: object) -> SimpleNamespace:
    payload = {
        "space_url": "https://publicus-indextts-2-demo.hf.space",
        "bucket_root": "hf://buckets/Publicus/abby-voice/runs",
        "run_label": "",
        "run_root": tmp_path / "tmp_assets" / "abby-tts-runs",
        "refresh_input_manifests": True,
        "rerender_phase2": False,
        "restart_all": False,
        "phase1_start_offset": None,
        "batch_size": 32,
        "remote_batch_size": 8,
        "parallel_workers": 1,
        "batch_retry_attempts": 4,
        "batch_retry_backoff_seconds": 10.0,
        "batch_retry_backoff_multiplier": 2.0,
        "batch_retry_max_backoff_seconds": 120.0,
        "max_runtime_seconds": 43200.0,
        "force": False,
        "stop_on_error": False,
        "validate_transcripts": False,
        "transcript_validation_limit": 2,
        "transcript_validation_model": "tiny.en",
        "transcript_validation_language": "en",
        "transcript_validation_device": "auto",
        "transcript_validation_threshold": 0.72,
        "transcript_validation_soft_fail": False,
        "upload": False,
        "upload_repo_id": "Publicus/211-abby-tts",
        "upload_remote_prefix": "",
        "upload_stage_dir": tmp_path / "tmp_assets" / "hf-abby-tts-dataset",
        "force_upload": False,
        "private": False,
        "skip_parquet": False,
        "dry_run": True,
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


def test_build_preprocessing_plan_uses_all_phases_and_bucket_run_label(tmp_path: Path) -> None:
    args = _build_args(tmp_path, run_label="gpu-rental-test")

    plan = full_preprocess.build_preprocessing_plan(args)

    assert plan.run_label == "gpu-rental-test"
    assert plan.bucket_uri == "hf://buckets/Publicus/abby-voice/runs/gpu-rental-test"
    command = list(plan.pipeline_command)
    phase_values = [command[index + 1] for index, part in enumerate(command[:-1]) if part == "--phase"]
    assert phase_values == ["phase1", "phase2", "phase3", "phase4"]
    assert command[command.index("--space-url") + 1] == "https://publicus-indextts-2-demo.hf.space"
    assert command[command.index("--remote-batch-size") + 1] == "8"
    assert command[command.index("--batch-retry-attempts") + 1] == "4"
    assert "--refresh-input-manifests" in command
    assert "--dry-run" in command


def test_build_preprocessing_plan_supports_restart_and_rerender_phase2(tmp_path: Path) -> None:
    args = _build_args(
        tmp_path,
        run_label="restart-test",
        rerender_phase2=True,
        restart_all=True,
        phase1_start_offset=64,
        upload=True,
        upload_remote_prefix="audio/abby-tts/runs/restart-test",
    )

    plan = full_preprocess.build_preprocessing_plan(args)

    command = list(plan.pipeline_command)
    restart_values = [command[index + 1] for index, part in enumerate(command[:-1]) if part == "--restart-phase"]
    assert restart_values == ["phase1", "phase2", "phase3", "phase4"]
    assert "--rerender-phase2" in command
    assert command[command.index("--phase1-start-offset") + 1] == "64"
    assert "--upload" in command
    assert command[command.index("--upload-remote-prefix") + 1] == "audio/abby-tts/runs/restart-test"


def test_write_plan_persists_reproducible_run_spec(tmp_path: Path) -> None:
    args = _build_args(tmp_path, run_label="plan-write-test")
    plan = full_preprocess.build_preprocessing_plan(args)

    full_preprocess.write_plan(plan, args)

    payload = json.loads(plan.plan_path.read_text(encoding="utf-8"))
    assert payload["runLabel"] == "plan-write-test"
    assert payload["bucketUri"] == "hf://buckets/Publicus/abby-voice/runs/plan-write-test"
    assert payload["phases"] == ["phase1", "phase2", "phase3", "phase4"]
    assert payload["pipelineCommand"][0] == "python3"


def test_build_preprocessing_plan_propagates_unbounded_runtime(tmp_path: Path) -> None:
    args = _build_args(tmp_path, run_label="indefinite-run", max_runtime_seconds=0.0)

    plan = full_preprocess.build_preprocessing_plan(args)

    command = list(plan.pipeline_command)
    assert command[command.index("--max-runtime-seconds") + 1] == "0.0"