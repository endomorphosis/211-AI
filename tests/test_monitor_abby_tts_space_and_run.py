from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from scripts import monitor_abby_tts_space_and_run as monitor


def _build_args(tmp_path: Path, **overrides: object) -> SimpleNamespace:
    payload = {
        "space_repo_id": "Publicus/IndexTTS-2-Demo",
        "space_url": "https://publicus-indextts-2-demo.hf.space",
        "expected_hardware": "l40sx1",
        "bucket_root": "hf://buckets/Publicus/abby-voice/runs",
        "monitor_label": "",
        "run_label": "gpu-run",
        "monitor_root": tmp_path / "tmp_assets" / "abby-tts-runs",
        "poll_interval_seconds": 60.0,
        "stall_seconds_before_repair": 1800.0,
        "max_monitor_seconds": 21600.0,
        "max_restarts": 2,
        "factory_reboot_on_final_restart": True,
        "contract_probe_timeout_seconds": 120.0,
        "batch_size": 32,
        "remote_batch_size": 8,
        "parallel_workers": 1,
        "batch_retry_attempts": 4,
        "batch_retry_backoff_seconds": 10.0,
        "batch_retry_backoff_multiplier": 2.0,
        "batch_retry_max_backoff_seconds": 120.0,
        "max_runtime_seconds": 43200.0,
        "space_sleep_time_seconds": None,
        "wrapper_relaunch_delay_seconds": 30.0,
        "refresh_input_manifests": True,
        "rerender_phase2": False,
        "restart_all": False,
        "phase1_start_offset": None,
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
        "dry_run": False,
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


def test_runtime_ready_requires_running_and_current_expected_hardware() -> None:
    runtime = SimpleNamespace(raw={"stage": "RUNNING", "hardware": {"current": "l40sx1", "requested": "l40sx1"}})
    building = SimpleNamespace(raw={"stage": "BUILDING", "hardware": {"current": None, "requested": "l40sx1"}})
    wrong_hardware = SimpleNamespace(raw={"stage": "RUNNING", "hardware": {"current": "a10g-small", "requested": "l40sx1"}})

    assert monitor.runtime_ready(runtime, expected_hardware="l40sx1") is True
    assert monitor.runtime_ready(building, expected_hardware="l40sx1") is False
    assert monitor.runtime_ready(wrong_hardware, expected_hardware="l40sx1") is False


def test_build_wrapper_command_targets_full_preprocessing_entrypoint(tmp_path: Path) -> None:
    args = _build_args(tmp_path, rerender_phase2=True, restart_all=True, validate_transcripts=True, dry_run=True)

    command = list(monitor.build_wrapper_command(args))

    assert command[0:2] == ["python3", str(Path(monitor.REPO_ROOT) / "scripts" / "run_abby_tts_full_preprocessing.py")]
    assert command[command.index("--space-url") + 1] == "https://publicus-indextts-2-demo.hf.space"
    assert command[command.index("--remote-batch-size") + 1] == "8"
    assert command[command.index("--max-runtime-seconds") + 1] == "43200.0"
    assert "--rerender-phase2" in command
    assert "--restart-all" in command
    assert "--validate-transcripts" in command
    assert "--dry-run" in command


def test_write_monitor_plan_persists_wrapper_command(tmp_path: Path) -> None:
    args = _build_args(tmp_path, monitor_label="l40s-monitor", dry_run=True, space_sleep_time_seconds=-1)
    plan = monitor.build_monitor_plan(args)

    monitor.write_monitor_plan(plan, args)

    payload = json.loads(plan.monitor_plan_path.read_text(encoding="utf-8"))
    assert payload["monitorLabel"] == "l40s-monitor"
    assert payload["spaceRepoId"] == "Publicus/IndexTTS-2-Demo"
    assert payload["spaceSleepTimeSeconds"] == -1
    assert payload["wrapperCommand"][0] == "python3"


def test_log_tail_signature_changes_with_content() -> None:
    first = monitor.log_tail_signature(["line one", "line two"])
    second = monitor.log_tail_signature(["line one", "line three"])

    assert first != second


def test_maybe_restart_space_uses_factory_reboot_on_final_attempt() -> None:
    calls: list[tuple[str, bool]] = []

    class FakeApi:
        def restart_space(self, repo_id: str, *, factory_reboot: bool = False):
            calls.append((repo_id, factory_reboot))
            return {"repo_id": repo_id, "factory_reboot": factory_reboot}

    args = _build_args(Path('/tmp'), max_restarts=2, factory_reboot_on_final_restart=True)

    monitor.maybe_restart_space(FakeApi(), args, restart_count=0)
    monitor.maybe_restart_space(FakeApi(), args, restart_count=1)

    assert calls == [
        ("Publicus/IndexTTS-2-Demo", False),
        ("Publicus/IndexTTS-2-Demo", True),
    ]


def test_restart_budget_helpers_treat_zero_as_unbounded(tmp_path: Path) -> None:
    args = _build_args(tmp_path, max_restarts=0, factory_reboot_on_final_restart=True)
    calls: list[tuple[str, bool]] = []

    class FakeApi:
        def restart_space(self, repo_id: str, *, factory_reboot: bool = False):
            calls.append((repo_id, factory_reboot))
            return {"repo_id": repo_id, "factory_reboot": factory_reboot}

    assert monitor.has_duration_limit(0.0) is False
    assert monitor.restart_budget_exhausted(999, 0) is False
    assert monitor.restart_budget_label(0) == "unbounded"

    monitor.maybe_restart_space(FakeApi(), args, restart_count=999)

    assert calls == [("Publicus/IndexTTS-2-Demo", False)]


def test_phase_progress_statuses_report_pending_state(tmp_path: Path) -> None:
    manifest_path = tmp_path / "phase4-manifest.json"
    state_path = tmp_path / "phase4-state.json"
    manifest_path.write_text(json.dumps({"responses": [{}, {}, {}]}), encoding="utf-8")
    state_path.write_text(json.dumps({"nextOffset": 2, "stopReason": "batch failed", "retryAfter": "30"}), encoding="utf-8")
    spec = SimpleNamespace(
        key="phase4-residual",
        label="Residual full responses",
        response_manifest=manifest_path,
        state=state_path,
    )

    statuses = monitor.phase_progress_statuses(_build_args(tmp_path), specs=[spec])

    assert len(statuses) == 1
    assert statuses[0].complete is False
    assert statuses[0].next_offset == 2
    assert statuses[0].total_responses == 3
    assert statuses[0].stop_reason == "batch failed"
    assert statuses[0].retry_after == "30"
    assert monitor.backlog_complete(statuses) is False


def test_maybe_set_space_sleep_time_calls_api(tmp_path: Path) -> None:
    calls: list[tuple[str, int]] = []

    class FakeApi:
        def set_space_sleep_time(self, repo_id: str, sleep_time: int):
            calls.append((repo_id, sleep_time))
            return SimpleNamespace(raw={"stage": "RUNNING", "hardware": {"current": "l40sx1", "requested": "l40sx1"}})

    monitor.maybe_set_space_sleep_time(FakeApi(), _build_args(tmp_path, space_sleep_time_seconds=-1))

    assert calls == [("Publicus/IndexTTS-2-Demo", -1)]