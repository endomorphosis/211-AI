#!/usr/bin/env python3
"""Prepare and run the full Abby TTS preprocessing workflow for a rented HF GPU."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_BUCKET_ROOT = os.getenv("ABBY_TTS_BUCKET_ROOT", "hf://buckets/Publicus/abby-voice/runs")
DEFAULT_RUN_ROOT = REPO_ROOT / "tmp_assets" / "abby-tts-runs"
PHASES = ("phase1", "phase2", "phase3", "phase4")


@dataclass(frozen=True)
class PreprocessingPlan:
    run_label: str
    space_url: str
    bucket_uri: str
    run_dir: Path
    plan_path: Path
    contract_command: tuple[str, ...]
    pipeline_command: tuple[str, ...]


def timestamp_label() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def append_path_suffix(base: str, suffix: str) -> str:
    normalized_base = str(base or "").strip().rstrip("/")
    normalized_suffix = str(suffix or "").strip().strip("/")
    if not normalized_base:
        return ""
    if not normalized_suffix:
        return normalized_base
    return f"{normalized_base}/{normalized_suffix}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--space-url",
        default=os.getenv("WALLET_INDEXTTS_SPACE_URL", "").strip(),
        help="Dedicated HF Space runtime URL that hosts the rented IndexTTS deployment.",
    )
    parser.add_argument(
        "--bucket-root",
        default=DEFAULT_BUCKET_ROOT,
        help="HF bucket prefix under which this run should write phase outputs.",
    )
    parser.add_argument(
        "--run-label",
        default="",
        help="Optional run label used for the bucket prefix and local run-plan path.",
    )
    parser.add_argument(
        "--run-root",
        type=Path,
        default=DEFAULT_RUN_ROOT,
        help="Local directory where the generated run plan should be written.",
    )
    parser.add_argument(
        "--refresh-input-manifests",
        dest="refresh_input_manifests",
        action="store_true",
        default=True,
        help="Refresh manifests before starting the phase pipeline.",
    )
    parser.add_argument(
        "--no-refresh-input-manifests",
        dest="refresh_input_manifests",
        action="store_false",
        help="Reuse the currently checked-in manifests without rebuilding them first.",
    )
    parser.add_argument(
        "--rerender-phase2",
        action="store_true",
        help="Force phase 2 shell and slot pieces to rerender from offset 0.",
    )
    parser.add_argument(
        "--restart-all",
        action="store_true",
        help="Restart all phase states from offset 0 rather than resuming current batch states.",
    )
    parser.add_argument(
        "--phase1-start-offset",
        type=int,
        default=None,
        help="Optional override for the BM25 phase start offset.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Outer manifest chunk size used by the resumable batch runner.",
    )
    parser.add_argument(
        "--remote-batch-size",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_REMOTE_BATCH_SIZE", "8") or "8"),
        help="Remote IndexTTS chunk size for each queue submission.",
    )
    parser.add_argument(
        "--parallel-workers",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_PARALLEL_WORKERS", "1") or "1"),
        help="Parallel single-request workers when remote batch mode is unavailable.",
    )
    parser.add_argument(
        "--batch-retry-attempts",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_ATTEMPTS", "4") or "4"),
        help="Retry attempts for transient all-failed batch manifests.",
    )
    parser.add_argument(
        "--batch-retry-backoff-seconds",
        type=float,
        default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_BACKOFF_SECONDS", "10") or "10"),
        help="Initial retry backoff in seconds for transient batch failures.",
    )
    parser.add_argument(
        "--batch-retry-backoff-multiplier",
        type=float,
        default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_BACKOFF_MULTIPLIER", "2") or "2"),
        help="Exponential backoff multiplier for transient batch failures.",
    )
    parser.add_argument(
        "--batch-retry-max-backoff-seconds",
        type=float,
        default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_MAX_BACKOFF_SECONDS", "120") or "120"),
        help="Maximum backoff between transient batch retries.",
    )
    parser.add_argument(
        "--max-runtime-seconds",
        type=float,
        default=0.0,
        help="Maximum runtime budget passed to each phase runner. Use 0 to disable the deadline and run until backlog completion.",
    )
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
        raise ValueError("--space-url is required for the rented HF preprocessing workflow.")
    return space_url


def resolved_run_label(args: argparse.Namespace) -> str:
    label = str(args.run_label or "").strip()
    if label:
        return label
    return f"abby-full-preprocess-{timestamp_label()}"


def format_command(command: Sequence[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def build_contract_command(space_url: str) -> tuple[str, ...]:
    return (
        "python3",
        str(REPO_ROOT / "scripts" / "precompute_indextts_responses.py"),
        "--space-url",
        space_url,
        "--print-indextts-contract",
    )


def build_pipeline_command(args: argparse.Namespace, *, space_url: str, bucket_uri: str) -> tuple[str, ...]:
    command: list[str] = [
        "python3",
        str(REPO_ROOT / "scripts" / "run_abby_tts_precompute_pipeline.py"),
    ]
    for phase in PHASES:
        command.extend(["--phase", phase])
    if args.refresh_input_manifests:
        command.append("--refresh-input-manifests")
    if args.rerender_phase2:
        command.append("--rerender-phase2")
    if args.restart_all:
        for phase in PHASES:
            command.extend(["--restart-phase", phase])
    if args.phase1_start_offset is not None:
        command.extend(["--phase1-start-offset", str(max(0, int(args.phase1_start_offset)))])
    command.extend(
        [
            "--space-url",
            space_url,
            "--bucket-uri",
            bucket_uri,
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
    )
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


def build_preprocessing_plan(args: argparse.Namespace) -> PreprocessingPlan:
    space_url = require_space_url(args)
    run_label = resolved_run_label(args)
    bucket_uri = append_path_suffix(args.bucket_root, run_label)
    run_dir = args.run_root / run_label
    plan_path = run_dir / "run-plan.json"
    return PreprocessingPlan(
        run_label=run_label,
        space_url=space_url,
        bucket_uri=bucket_uri,
        run_dir=run_dir,
        plan_path=plan_path,
        contract_command=build_contract_command(space_url),
        pipeline_command=build_pipeline_command(args, space_url=space_url, bucket_uri=bucket_uri),
    )


def write_plan(plan: PreprocessingPlan, args: argparse.Namespace) -> None:
    plan.run_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runLabel": plan.run_label,
        "spaceUrl": plan.space_url,
        "bucketUri": plan.bucket_uri,
        "phases": list(PHASES),
        "refreshInputManifests": bool(args.refresh_input_manifests),
        "rerenderPhase2": bool(args.rerender_phase2),
        "restartAll": bool(args.restart_all),
        "phase1StartOffset": args.phase1_start_offset,
        "batchSize": args.batch_size,
        "remoteBatchSize": args.remote_batch_size,
        "parallelWorkers": args.parallel_workers,
        "batchRetryAttempts": args.batch_retry_attempts,
        "batchRetryBackoffSeconds": args.batch_retry_backoff_seconds,
        "batchRetryBackoffMultiplier": args.batch_retry_backoff_multiplier,
        "batchRetryMaxBackoffSeconds": args.batch_retry_max_backoff_seconds,
        "maxRuntimeSeconds": args.max_runtime_seconds,
        "contractCommand": list(plan.contract_command),
        "pipelineCommand": list(plan.pipeline_command),
    }
    plan.plan_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run_command(command: Sequence[str]) -> None:
    subprocess.run(command, cwd=REPO_ROOT, check=True)


def main() -> None:
    args = parse_args()
    plan = build_preprocessing_plan(args)
    write_plan(plan, args)
    print(f"Run plan: {plan.plan_path}")
    print(f"Bucket URI: {plan.bucket_uri}")
    print("Contract probe:")
    print(format_command(plan.contract_command))
    print("Pipeline command:")
    print(format_command(plan.pipeline_command))
    if args.dry_run:
        return
    run_command(plan.contract_command)
    run_command(plan.pipeline_command)


if __name__ == "__main__":
    main()