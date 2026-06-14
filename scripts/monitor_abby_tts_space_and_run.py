#!/usr/bin/env python3
"""Monitor a rented HF Space, repair startup stalls, and start Abby TTS preprocessing when ready."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_SPACE_REPO_ID = os.getenv("ABBY_TTS_SPACE_REPO_ID", "Publicus/IndexTTS-2-Demo")
DEFAULT_BUCKET_ROOT = os.getenv("ABBY_TTS_BUCKET_ROOT", "hf://buckets/Publicus/abby-voice/runs")
DEFAULT_MONITOR_ROOT = REPO_ROOT / "tmp_assets" / "abby-tts-runs"


@dataclass(frozen=True)
class MonitorPlan:
    monitor_label: str
    monitor_dir: Path
    monitor_plan_path: Path
    wrapper_command: tuple[str, ...]


@dataclass(frozen=True)
class PhaseProgress:
    key: str
    label: str
    response_manifest: Path
    state: Path
    next_offset: int
    total_responses: int
    complete: bool
    stop_reason: str
    retry_after: str


def timestamp_label() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def format_command(command: Sequence[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--space-repo-id", default=DEFAULT_SPACE_REPO_ID)
    parser.add_argument(
        "--space-url",
        default=os.getenv("WALLET_INDEXTTS_SPACE_URL", "").strip(),
        help="Dedicated HF Space runtime URL that should become ready before preprocessing starts.",
    )
    parser.add_argument("--expected-hardware", default="l40sx1")
    parser.add_argument("--bucket-root", default=DEFAULT_BUCKET_ROOT)
    parser.add_argument("--monitor-label", default="")
    parser.add_argument("--run-label", default="")
    parser.add_argument("--monitor-root", type=Path, default=DEFAULT_MONITOR_ROOT)
    parser.add_argument("--poll-interval-seconds", type=float, default=60.0)
    parser.add_argument("--log-poll-interval-seconds", type=float, default=300.0)
    parser.add_argument("--stall-seconds-before-repair", type=float, default=1800.0)
    parser.add_argument(
        "--max-monitor-seconds",
        type=float,
        default=0.0,
        help="Maximum monitor runtime in seconds. Use 0 to disable the monitor timeout and keep watching until completion.",
    )
    parser.add_argument(
        "--max-restarts",
        type=int,
        default=0,
        help="Maximum automatic restarts before the monitor exits. Use 0 to disable the restart limit.",
    )
    parser.add_argument("--factory-reboot-on-final-restart", action="store_true")
    parser.add_argument("--contract-probe-timeout-seconds", type=float, default=120.0)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--remote-batch-size", type=int, default=int(os.getenv("WALLET_INDEXTTS_REMOTE_BATCH_SIZE", "8") or "8"))
    parser.add_argument("--parallel-workers", type=int, default=int(os.getenv("WALLET_INDEXTTS_PARALLEL_WORKERS", "1") or "1"))
    parser.add_argument("--batch-retry-attempts", type=int, default=int(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_ATTEMPTS", "4") or "4"))
    parser.add_argument("--batch-retry-backoff-seconds", type=float, default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_BACKOFF_SECONDS", "10") or "10"))
    parser.add_argument("--batch-retry-backoff-multiplier", type=float, default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_BACKOFF_MULTIPLIER", "2") or "2"))
    parser.add_argument("--batch-retry-max-backoff-seconds", type=float, default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_MAX_BACKOFF_SECONDS", "120") or "120"))
    parser.add_argument(
        "--max-runtime-seconds",
        type=float,
        default=0.0,
        help="Maximum per-phase runtime passed to the Abby preprocessing pipeline. Use 0 to disable the deadline.",
    )
    parser.add_argument(
        "--space-sleep-time-seconds",
        type=int,
        default=None,
        help="Optional Hugging Face Space sleep timeout in seconds. Set to -1 to disable sleep on upgraded hardware.",
    )
    parser.add_argument(
        "--wrapper-relaunch-delay-seconds",
        type=float,
        default=30.0,
        help="Seconds to wait before relaunching the wrapper when the backlog is still incomplete.",
    )
    parser.add_argument("--refresh-input-manifests", dest="refresh_input_manifests", action="store_true", default=True)
    parser.add_argument("--no-refresh-input-manifests", dest="refresh_input_manifests", action="store_false")
    parser.add_argument("--rerender-phase2", action="store_true")
    parser.add_argument("--restart-all", action="store_true")
    parser.add_argument("--phase1-start-offset", type=int, default=None)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--stop-on-error", action="store_true")
    parser.add_argument("--validate-transcripts", action="store_true")
    parser.add_argument("--transcript-validation-limit", type=int, default=2)
    parser.add_argument("--transcript-validation-model", default="tiny.en")
    parser.add_argument("--transcript-validation-language", default="en")
    parser.add_argument("--transcript-validation-device", default="auto")
    parser.add_argument("--transcript-validation-threshold", type=float, default=0.72)
    parser.add_argument("--transcript-validation-soft-fail", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--upload-repo-id", default=os.getenv("ABBY_TTS_HF_REPO_ID", "Publicus/211-abby-tts"))
    parser.add_argument("--upload-remote-prefix", default="")
    parser.add_argument("--upload-stage-dir", type=Path, default=REPO_ROOT / "tmp_assets" / "hf-abby-tts-dataset")
    parser.add_argument("--force-upload", action="store_true")
    parser.add_argument("--private", action="store_true")
    parser.add_argument("--skip-parquet", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def require_space_url(args: argparse.Namespace) -> str:
    space_url = str(args.space_url or "").strip()
    if not space_url:
        raise ValueError("--space-url is required so the monitor can probe the rented Space contract.")
    return space_url


def resolved_monitor_label(args: argparse.Namespace) -> str:
    label = str(args.monitor_label or "").strip()
    if label:
        return label
    return f"abby-space-monitor-{timestamp_label()}"


def runtime_signature(runtime: Any) -> str:
    raw = getattr(runtime, "raw", {}) or {}
    return json.dumps(raw, sort_keys=True, default=str)


def runtime_state_summary(runtime: Any) -> str:
    raw = getattr(runtime, "raw", {}) or {}
    hardware = raw.get("hardware") or {}
    return (
        f"stage={raw.get('stage')!r} current={hardware.get('current')!r} "
        f"requested={hardware.get('requested')!r} replicas={raw.get('replicas')!r} devMode={raw.get('devMode')!r}"
    )


def runtime_ready(runtime: Any, *, expected_hardware: str) -> bool:
    raw = getattr(runtime, "raw", {}) or {}
    hardware = raw.get("hardware") or {}
    stage = str(raw.get("stage") or "").upper()
    current = str(hardware.get("current") or "").strip().lower()
    expected = str(expected_hardware or "").strip().lower()
    if stage != "RUNNING":
        return False
    if expected and current and current != expected:
        return False
    return bool(current)


def build_wrapper_command(args: argparse.Namespace) -> tuple[str, ...]:
    command: list[str] = [
        "python3",
        str(REPO_ROOT / "scripts" / "run_abby_tts_full_preprocessing.py"),
        "--space-url",
        require_space_url(args),
        "--bucket-root",
        args.bucket_root,
        "--batch-size",
        str(args.batch_size),
        "--remote-batch-size",
        str(args.remote_batch_size),
        "--parallel-workers",
        str(args.parallel_workers),
        "--batch-retry-attempts",
        str(args.batch_retry_attempts),
        "--batch-retry-backoff-seconds",
        str(args.batch_retry_backoff_seconds),
        "--batch-retry-backoff-multiplier",
        str(args.batch_retry_backoff_multiplier),
        "--batch-retry-max-backoff-seconds",
        str(args.batch_retry_max_backoff_seconds),
        "--max-runtime-seconds",
        str(args.max_runtime_seconds),
    ]
    if args.run_label:
        command.extend(["--run-label", args.run_label])
    if args.refresh_input_manifests:
        command.append("--refresh-input-manifests")
    else:
        command.append("--no-refresh-input-manifests")
    if args.rerender_phase2:
        command.append("--rerender-phase2")
    if args.restart_all:
        command.append("--restart-all")
    if args.phase1_start_offset is not None:
        command.extend(["--phase1-start-offset", str(max(0, int(args.phase1_start_offset)))])
    if args.force:
        command.append("--force")
    if args.stop_on_error:
        command.append("--stop-on-error")
    if args.validate_transcripts:
        command.extend(
            [
                "--validate-transcripts",
                "--transcript-validation-limit",
                str(args.transcript_validation_limit),
                "--transcript-validation-model",
                args.transcript_validation_model,
                "--transcript-validation-language",
                args.transcript_validation_language,
                "--transcript-validation-device",
                args.transcript_validation_device,
                "--transcript-validation-threshold",
                str(args.transcript_validation_threshold),
            ]
        )
    if args.transcript_validation_soft_fail:
        command.append("--transcript-validation-soft-fail")
    if args.upload:
        command.append("--upload")
        command.extend(["--upload-repo-id", args.upload_repo_id])
        if args.upload_remote_prefix:
            command.extend(["--upload-remote-prefix", args.upload_remote_prefix])
        command.extend(["--upload-stage-dir", str(args.upload_stage_dir)])
        if args.force_upload:
            command.append("--force-upload")
        if args.private:
            command.append("--private")
        if args.skip_parquet:
            command.append("--skip-parquet")
    if args.dry_run:
        command.append("--dry-run")
    return tuple(command)


def build_monitor_plan(args: argparse.Namespace) -> MonitorPlan:
    monitor_label = resolved_monitor_label(args)
    monitor_dir = args.monitor_root / monitor_label
    return MonitorPlan(
        monitor_label=monitor_label,
        monitor_dir=monitor_dir,
        monitor_plan_path=monitor_dir / "monitor-plan.json",
        wrapper_command=build_wrapper_command(args),
    )


def write_monitor_plan(plan: MonitorPlan, args: argparse.Namespace) -> None:
    plan.monitor_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "monitorLabel": plan.monitor_label,
        "spaceRepoId": args.space_repo_id,
        "spaceUrl": require_space_url(args),
        "expectedHardware": args.expected_hardware,
        "pollIntervalSeconds": args.poll_interval_seconds,
        "stallSecondsBeforeRepair": args.stall_seconds_before_repair,
        "maxMonitorSeconds": args.max_monitor_seconds,
        "maxRestarts": args.max_restarts,
        "spaceSleepTimeSeconds": args.space_sleep_time_seconds,
        "wrapperRelaunchDelaySeconds": args.wrapper_relaunch_delay_seconds,
        "wrapperCommand": list(plan.wrapper_command),
    }
    plan.monitor_plan_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_state_payload(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def response_manifest_count(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return 0
    responses = payload.get("responses") if isinstance(payload, dict) else []
    if not isinstance(responses, list):
        return 0
    return len(responses)


def phase_progress_statuses(args: argparse.Namespace, *, specs: Sequence[Any] | None = None) -> tuple[PhaseProgress, ...]:
    from scripts import run_abby_tts_precompute_pipeline as pipeline

    resolved_specs = list(specs or ())
    if not resolved_specs:
        catalog = pipeline.build_phase_catalog(REPO_ROOT, REPO_ROOT / "tmp_assets" / "abby-tts", default_batch_size=args.batch_size)
        for group in pipeline.PHASE_ORDER:
            resolved_specs.extend(catalog.get(group, ()))

    statuses: list[PhaseProgress] = []
    for spec in resolved_specs:
        state_payload = read_state_payload(spec.state)
        try:
            next_offset = max(0, int(state_payload.get("nextOffset") or 0))
        except (TypeError, ValueError):
            next_offset = 0
        total_responses = response_manifest_count(spec.response_manifest)
        manifest_exists = spec.response_manifest.exists()
        complete = bool(manifest_exists and next_offset >= total_responses)
        statuses.append(
            PhaseProgress(
                key=str(spec.key),
                label=str(spec.label),
                response_manifest=Path(spec.response_manifest),
                state=Path(spec.state),
                next_offset=next_offset,
                total_responses=total_responses,
                complete=complete,
                stop_reason=str(state_payload.get("stopReason") or "").strip(),
                retry_after=str(state_payload.get("retryAfter") or "").strip(),
            )
        )
    return tuple(statuses)


def backlog_complete(statuses: Sequence[PhaseProgress]) -> bool:
    return bool(statuses) and all(status.complete for status in statuses)


def format_phase_progress(status: PhaseProgress) -> str:
    summary = f"{status.key}: {status.next_offset}/{status.total_responses}"
    if status.stop_reason:
        summary = f"{summary}; stopReason={status.stop_reason}"
    if status.retry_after:
        summary = f"{summary}; retryAfter={status.retry_after}"
    return summary


def build_log_tail(api: Any, repo_id: str, *, build: bool, line_limit: int = 40) -> list[str]:
    tail: deque[str] = deque(maxlen=max(1, line_limit))
    try:
        for line in api.fetch_space_logs(repo_id, build=build):
            tail.append(str(line).rstrip())
    except Exception as exc:
        return [f"{type(exc).__name__}: {exc}"]
    return list(tail)


def log_tail_signature(lines: Sequence[str]) -> str:
    return json.dumps(list(lines), ensure_ascii=True)


def probe_space_contract(space_url: str, *, timeout_seconds: float) -> dict[str, Any]:
    from scripts import precompute_indextts_responses as precompute

    previous_url = os.environ.get("WALLET_INDEXTTS_SPACE_URL")
    previous_timeout = os.environ.get("WALLET_INDEXTTS_TIMEOUT_SECONDS")
    os.environ["WALLET_INDEXTTS_SPACE_URL"] = space_url
    os.environ["WALLET_INDEXTTS_TIMEOUT_SECONDS"] = str(max(1.0, float(timeout_seconds)))
    try:
        precompute.load_secret_env()
        config = precompute.indextts_config()
        fn_index = precompute.indextts_fn_index(config)
        return precompute.indextts_contract_summary(config, fn_index)
    finally:
        if previous_url is None:
            os.environ.pop("WALLET_INDEXTTS_SPACE_URL", None)
        else:
            os.environ["WALLET_INDEXTTS_SPACE_URL"] = previous_url
        if previous_timeout is None:
            os.environ.pop("WALLET_INDEXTTS_TIMEOUT_SECONDS", None)
        else:
            os.environ["WALLET_INDEXTTS_TIMEOUT_SECONDS"] = previous_timeout


def has_duration_limit(seconds: float | None) -> bool:
    return seconds is not None and float(seconds) > 0.0


def restart_budget_exhausted(restart_count: int, max_restarts: int) -> bool:
    return int(max_restarts) > 0 and restart_count >= int(max_restarts)


def restart_budget_label(max_restarts: int) -> str:
    return "unbounded" if int(max_restarts) <= 0 else str(int(max_restarts))


def should_factory_reboot(args: argparse.Namespace, *, restart_count: int) -> bool:
    return bool(
        args.factory_reboot_on_final_restart
        and int(args.max_restarts) > 0
        and restart_count + 1 >= int(args.max_restarts)
    )


def maybe_restart_space(api: Any, args: argparse.Namespace, *, restart_count: int) -> Any:
    use_factory_reboot = should_factory_reboot(args, restart_count=restart_count)
    print(
        f"Repair attempt {restart_count + 1}/{restart_budget_label(args.max_restarts)}: restarting {args.space_repo_id} "
        f"(factory_reboot={use_factory_reboot})"
    )
    return api.restart_space(args.space_repo_id, factory_reboot=use_factory_reboot)


def maybe_set_space_sleep_time(api: Any, args: argparse.Namespace) -> Any | None:
    if args.space_sleep_time_seconds is None:
        return None
    print(
        f"Setting sleep timeout for {args.space_repo_id} to {int(args.space_sleep_time_seconds)} seconds"
    )
    runtime = api.set_space_sleep_time(args.space_repo_id, int(args.space_sleep_time_seconds))
    print(f"Sleep timeout updated: {runtime_state_summary(runtime)}")
    return runtime


def wake_sleeping_space(api: Any, args: argparse.Namespace) -> Any:
    print(f"Space {args.space_repo_id} is sleeping while backlog remains; waking it now")
    return api.restart_space(args.space_repo_id, factory_reboot=False)


def run_wrapper(plan: MonitorPlan) -> int:
    print("Starting full preprocessing run:")
    print(format_command(plan.wrapper_command))
    completed = subprocess.run(plan.wrapper_command, cwd=REPO_ROOT, check=False)
    print(f"Full preprocessing exited with code {completed.returncode}")
    return int(completed.returncode)


def main() -> None:
    args = parse_args()
    require_space_url(args)
    if args.max_restarts < 0:
        raise ValueError("--max-restarts must be at least 0")
    if args.poll_interval_seconds <= 0:
        raise ValueError("--poll-interval-seconds must be > 0")
    if args.log_poll_interval_seconds <= 0:
        raise ValueError("--log-poll-interval-seconds must be > 0")
    if args.stall_seconds_before_repair <= 0:
        raise ValueError("--stall-seconds-before-repair must be > 0")
    if args.max_monitor_seconds < 0:
        raise ValueError("--max-monitor-seconds must be at least 0")
    if args.wrapper_relaunch_delay_seconds < 0:
        raise ValueError("--wrapper-relaunch-delay-seconds must be at least 0")

    from scripts.upload_hf_abby_tts_dataset import hf_token
    from huggingface_hub import HfApi

    api = HfApi(token=hf_token())
    plan = build_monitor_plan(args)
    write_monitor_plan(plan, args)
    print(f"Monitor plan: {plan.monitor_plan_path}")
    print(f"Wrapper command: {format_command(plan.wrapper_command)}")
    if args.dry_run:
        return

    try:
        maybe_set_space_sleep_time(api, args)
    except Exception as exc:
        print(f"Could not update Space sleep timeout: {type(exc).__name__}: {exc}")

    started_at = time.time()
    last_signature = ""
    last_progress_at = started_at
    last_log_poll_at = 0.0
    last_log_signature = ""
    restart_count = 0
    last_wake_request_at = 0.0

    while True:
        phase_statuses = phase_progress_statuses(args)
        if backlog_complete(phase_statuses):
            print("All Abby TTS phases are complete.")
            return

        runtime = api.get_space_runtime(args.space_repo_id)
        signature = runtime_signature(runtime)
        ready = runtime_ready(runtime, expected_hardware=args.expected_hardware)
        now = time.time()
        if signature != last_signature:
            last_signature = signature
            last_progress_at = now
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime())}] {runtime_state_summary(runtime)}")

        raw = getattr(runtime, "raw", {}) or {}
        stage = str(raw.get("stage") or "").upper()
        if stage == "SLEEPING" and now - last_wake_request_at >= args.poll_interval_seconds:
            wake_sleeping_space(api, args)
            last_wake_request_at = now
            last_progress_at = now
            last_log_poll_at = 0.0
            last_log_signature = ""
            time.sleep(args.poll_interval_seconds)
            continue

        log_build_mode = stage != "RUNNING"
        if now - last_log_poll_at >= args.log_poll_interval_seconds:
            log_tail = build_log_tail(api, args.space_repo_id, build=log_build_mode)
            log_signature = log_tail_signature(log_tail)
            last_log_poll_at = now
            if log_signature != last_log_signature:
                last_log_signature = log_signature
                last_progress_at = now
                if log_tail:
                    print(f"[{time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime())}] log progress: {log_tail[-1]}")

        if ready:
            try:
                contract = probe_space_contract(require_space_url(args), timeout_seconds=args.contract_probe_timeout_seconds)
            except Exception as exc:
                print(f"Contract probe not ready yet: {type(exc).__name__}: {exc}")
            else:
                print("Space contract is ready:")
                print(json.dumps(contract, indent=2))
                wrapper_returncode = run_wrapper(plan)
                phase_statuses = phase_progress_statuses(args)
                if backlog_complete(phase_statuses):
                    print("All Abby TTS phases are complete.")
                    return
                print(
                    f"Wrapper exited before backlog completion (exit code {wrapper_returncode}). Pending phases:"
                )
                for status in phase_statuses:
                    if not status.complete:
                        print(f"- {format_phase_progress(status)}")
                last_progress_at = time.time()
                last_signature = ""
                last_log_poll_at = 0.0
                last_log_signature = ""
                if args.wrapper_relaunch_delay_seconds > 0:
                    time.sleep(args.wrapper_relaunch_delay_seconds)
                continue

        elapsed = time.time() - started_at
        stalled_for = time.time() - last_progress_at
        if has_duration_limit(args.max_monitor_seconds) and elapsed >= args.max_monitor_seconds:
            build_tail = build_log_tail(api, args.space_repo_id, build=True)
            raise RuntimeError(
                f"Timed out waiting for {args.space_repo_id} to become ready after {elapsed:.1f}s. "
                f"Recent build log tail: {build_tail}"
            )

        if stalled_for >= args.stall_seconds_before_repair:
            if restart_budget_exhausted(restart_count, args.max_restarts):
                build_tail = build_log_tail(api, args.space_repo_id, build=log_build_mode)
                raise RuntimeError(
                    f"Space {args.space_repo_id} appears stalled after {stalled_for:.1f}s with no runtime or log changes, "
                    f"and the restart budget is exhausted. Recent build log tail: {build_tail}"
                )
            build_tail = build_log_tail(api, args.space_repo_id, build=log_build_mode)
            print("Recent build log tail before repair:")
            for line in build_tail:
                print(line)
            maybe_restart_space(api, args, restart_count=restart_count)
            restart_count += 1
            last_progress_at = time.time()
            last_log_poll_at = 0.0
            last_log_signature = ""
            continue

        time.sleep(args.poll_interval_seconds)


if __name__ == "__main__":
    main()