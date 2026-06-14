from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from scripts import run_abby_tts_precompute_pipeline as pipeline


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _build_args(tmp_path: Path, **overrides: object) -> SimpleNamespace:
    payload = {
        "phases": [],
        "restart_phases": [],
        "rerender_phase2": False,
        "refresh_input_manifests": False,
        "output_root": tmp_path / "tmp_assets" / "abby-tts",
        "phase1_start_offset": None,
        "batch_size": 32,
        "remote_batch_size": 16,
        "space_url": "",
        "bucket_uri": "",
        "parallel_workers": 4,
        "batch_retry_attempts": 2,
        "batch_retry_backoff_seconds": 15.0,
        "batch_retry_backoff_multiplier": 2.0,
        "batch_retry_max_backoff_seconds": 120.0,
        "max_runtime_seconds": 7200.0,
        "force": False,
        "stop_on_error": False,
        "validate_transcripts": True,
        "transcript_validation_limit": 2,
        "transcript_validation_model": "tiny.en",
        "transcript_validation_language": "en",
        "transcript_validation_device": "cuda",
        "transcript_validation_threshold": 0.72,
        "transcript_validation_soft_fail": False,
        "upload": False,
        "upload_repo_id": "Publicus/211-abby-tts",
        "upload_remote_prefix": "",
        "upload_stage_dir": tmp_path / "tmp_assets" / "hf-abby-tts-dataset",
        "upload_audio_roots": [],
        "force_upload": False,
        "private": False,
        "skip_parquet": False,
        "dry_run": True,
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


def test_build_steps_default_sequence_reads_resume_offset(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _write_json(docs / "pregenerated_text_audio_bm25_batch_state.json", {"nextOffset": 288})
    catalog = pipeline.build_phase_catalog(tmp_path, tmp_path / "tmp_assets" / "abby-tts")
    args = _build_args(tmp_path)

    steps = pipeline.build_steps(args, repo_root=tmp_path, catalog=catalog)

    assert [step.name for step in steps] == [
        "build-phase-response-manifests",
        "phase1-bm25",
        "phase3-duplicate",
        "phase4-residual",
    ]
    phase1_command = list(steps[1].command)
    assert phase1_command[phase1_command.index("--start-offset") + 1] == "288"
    assert str(tmp_path / "scripts" / "build_pregenerated_audio_response_phase_manifests.py") in steps[0].command


def test_build_steps_rerender_phase2_and_upload_include_expected_roots(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _write_json(docs / "pregenerated_text_audio_bm25_batch_state.json", {"nextOffset": 288})
    _write_json(docs / "pregenerated_text_audio_slot_number_batch_state.json", {"nextOffset": 87})
    catalog = pipeline.build_phase_catalog(tmp_path, tmp_path / "tmp_assets" / "abby-tts")
    args = _build_args(tmp_path, rerender_phase2=True, upload=True)

    steps = pipeline.build_steps(args, repo_root=tmp_path, catalog=catalog)

    names = [step.name for step in steps]
    assert "phase2-shell" in names
    assert "phase2-slot-number" in names
    assert names[-1] == "upload-abby-tts-dataset"

    phase2_shell = next(step for step in steps if step.name == "phase2-shell")
    shell_command = list(phase2_shell.command)
    assert shell_command[shell_command.index("--start-offset") + 1] == "0"

    upload_step = steps[-1]
    upload_command = list(upload_step.command)
    assert "--audio-root" in upload_command
    assert str(tmp_path / "wallet_interface" / "ui" / "public" / "assets" / "audio" / "precomputed") in upload_command
    assert str(tmp_path / "tmp_assets" / "abby-tts" / "slot-number") in upload_command
    assert str(tmp_path / "tmp_assets" / "abby-tts" / "duplicate-responses") in upload_command


def test_phase1_start_offset_override_wins_over_state(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    _write_json(docs / "pregenerated_text_audio_bm25_batch_state.json", {"nextOffset": 288})
    catalog = pipeline.build_phase_catalog(tmp_path, tmp_path / "tmp_assets" / "abby-tts")
    args = _build_args(tmp_path, phases=["phase1"], phase1_start_offset=64)

    steps = pipeline.build_steps(args, repo_root=tmp_path, catalog=catalog)

    assert [step.name for step in steps] == ["phase1-bm25"]
    phase1_command = list(steps[0].command)
    assert phase1_command[phase1_command.index("--start-offset") + 1] == "64"


def test_build_steps_passes_space_and_phase_bucket_uri(tmp_path: Path) -> None:
    catalog = pipeline.build_phase_catalog(tmp_path, tmp_path / "tmp_assets" / "abby-tts")
    args = _build_args(
        tmp_path,
        phases=["phase1"],
        space_url="https://publicus-indextts-2-demo.hf.space",
        bucket_uri="hf://buckets/Publicus/abby-voice/runs/test-run",
        batch_retry_attempts=3,
        batch_retry_backoff_seconds=5.0,
    )

    steps = pipeline.build_steps(args, repo_root=tmp_path, catalog=catalog)

    phase1_command = list(steps[0].command)
    assert phase1_command[phase1_command.index("--space-url") + 1] == "https://publicus-indextts-2-demo.hf.space"
    assert phase1_command[phase1_command.index("--bucket-uri") + 1] == "hf://buckets/Publicus/abby-voice/runs/test-run/phase1-bm25"
    assert phase1_command[phase1_command.index("--batch-retry-attempts") + 1] == "3"
    assert phase1_command[phase1_command.index("--batch-retry-backoff-seconds") + 1] == "5.0"


def test_build_steps_propagates_unbounded_runtime_to_batch_runner(tmp_path: Path) -> None:
    catalog = pipeline.build_phase_catalog(tmp_path, tmp_path / "tmp_assets" / "abby-tts")
    args = _build_args(tmp_path, phases=["phase4"], max_runtime_seconds=0.0)

    steps = pipeline.build_steps(args, repo_root=tmp_path, catalog=catalog)

    phase4_command = list(next(step for step in steps if step.name == "phase4-residual").command)
    assert phase4_command[phase4_command.index("--max-runtime-seconds") + 1] == "0.0"