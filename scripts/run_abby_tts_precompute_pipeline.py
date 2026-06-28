#!/usr/bin/env python3
"""Orchestrate Abby TTS precompute phases for rented Hugging Face compute."""
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
from typing import Iterable, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_OUTPUT_ROOT = REPO_ROOT / "tmp_assets" / "abby-tts"
DEFAULT_UPLOAD_STAGE_DIR = REPO_ROOT / "tmp_assets" / "hf-abby-tts-dataset"
DEFAULT_UPLOAD_REPO_ID = os.getenv("ABBY_TTS_HF_REPO_ID", "Publicus/211-abby-tts")
PHASE_ORDER = ("phase1", "phase2", "phase3", "phase4")
DEFAULT_PHASES = ("phase1", "phase3", "phase4")


@dataclass(frozen=True)
class BatchPhaseSpec:
    group: str
    key: str
    label: str
    response_manifest: Path
    state: Path
    batch_manifest_dir: Path
    progress_dir: Path
    public_manifest: Path
    output_dir: Path
    batch_size: int


@dataclass(frozen=True)
class CommandStep:
    name: str
    command: tuple[str, ...]
    output_dirs: tuple[Path, ...] = ()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", action="append", dest="phases", choices=PHASE_ORDER, default=[])
    parser.add_argument("--restart-phase", action="append", dest="restart_phases", choices=PHASE_ORDER, default=[])
    parser.add_argument(
        "--rerender-phase2",
        action="store_true",
        help="Include phase 2 and reset its offsets to zero so shell and slot pieces are rerendered.",
    )
    parser.add_argument(
        "--refresh-input-manifests",
        action="store_true",
        help="Refresh the unified response manifest, slot asset manifests, and vocabulary manifests before batch work.",
    )
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--phase1-start-offset", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=32, help="Default batch size for phases 1, 3, and 4.")
    parser.add_argument(
        "--remote-batch-size",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_REMOTE_BATCH_SIZE", "32") or "32"),
    )
    parser.add_argument(
        "--space-url",
        default="",
        help="Override the IndexTTS Space base URL for all generated precompute commands.",
    )
    parser.add_argument(
        "--bucket-uri",
        default="",
        help="Root HF bucket prefix for precompute syncs. Each phase writes to <bucket-uri>/<phase-key>.",
    )
    parser.add_argument(
        "--parallel-workers",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_PARALLEL_WORKERS", "1") or "1"),
    )
    parser.add_argument(
        "--batch-retry-attempts",
        type=int,
        default=int(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_ATTEMPTS", "2") or "2"),
        help="Retry a failed batch command this many times when all manifest failures look transient.",
    )
    parser.add_argument(
        "--batch-retry-backoff-seconds",
        type=float,
        default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_BACKOFF_SECONDS", "15") or "15"),
        help="Initial retry backoff in seconds for transient batch failures.",
    )
    parser.add_argument(
        "--batch-retry-backoff-multiplier",
        type=float,
        default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_BACKOFF_MULTIPLIER", "2") or "2"),
        help="Exponential backoff multiplier for transient batch retries.",
    )
    parser.add_argument(
        "--batch-retry-max-backoff-seconds",
        type=float,
        default=float(os.getenv("WALLET_INDEXTTS_BATCH_RETRY_MAX_BACKOFF_SECONDS", "120") or "120"),
        help="Maximum sleep between transient batch retries.",
    )
    parser.add_argument(
        "--max-runtime-seconds",
        type=float,
        default=0.0,
        help="Maximum per-phase runtime in seconds. Use 0 to disable the deadline and run until each phase completes.",
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
    parser.add_argument("--upload-repo-id", default=DEFAULT_UPLOAD_REPO_ID)
    parser.add_argument("--upload-remote-prefix", default="")
    parser.add_argument("--upload-stage-dir", type=Path, default=DEFAULT_UPLOAD_STAGE_DIR)
    parser.add_argument("--upload-audio-root", type=Path, action="append", dest="upload_audio_roots", default=[])
    parser.add_argument("--force-upload", action="store_true")
    parser.add_argument("--private", action="store_true")
    parser.add_argument("--skip-parquet", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def build_phase_catalog(repo_root: Path, output_root: Path, *, default_batch_size: int = 32) -> dict[str, tuple[BatchPhaseSpec, ...]]:
    docs = repo_root / "docs"
    slot_dir = docs / "pregenerated_text_audio_slot_value_manifests"
    return {
        "phase1": (
            BatchPhaseSpec(
                group="phase1",
                key="phase1-bm25",
                label="BM25 vocabulary",
                response_manifest=docs / "pregenerated_text_audio_bm25_manifest.json",
                state=docs / "pregenerated_text_audio_bm25_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_bm25_batches",
                progress_dir=docs / "pregenerated_text_audio_bm25_progress",
                public_manifest=docs / "pregenerated_text_audio_bm25_public_manifest.json",
                output_dir=output_root / "bm25",
                batch_size=default_batch_size,
            ),
        ),
        "phase2": (
            BatchPhaseSpec(
                group="phase2",
                key="phase2-shell",
                label="Reusable shell segments",
                response_manifest=docs / "pregenerated_text_audio_shell_manifest.json",
                state=docs / "pregenerated_text_audio_shell_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_shell_batches",
                progress_dir=docs / "pregenerated_text_audio_shell_progress",
                public_manifest=docs / "pregenerated_text_audio_shell_public_manifest.json",
                output_dir=output_root / "shell",
                batch_size=10,
            ),
            BatchPhaseSpec(
                group="phase2",
                key="phase2-slot-number",
                label="Slot numbers",
                response_manifest=slot_dir / "number.json",
                state=docs / "pregenerated_text_audio_slot_number_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_slot_number_batches",
                progress_dir=docs / "pregenerated_text_audio_slot_number_progress",
                public_manifest=docs / "pregenerated_text_audio_slot_number_public_manifest.json",
                output_dir=output_root / "slot-number",
                batch_size=20,
            ),
            BatchPhaseSpec(
                group="phase2",
                key="phase2-slot-phone",
                label="Slot phones",
                response_manifest=slot_dir / "phone.json",
                state=docs / "pregenerated_text_audio_slot_phone_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_slot_phone_batches",
                progress_dir=docs / "pregenerated_text_audio_slot_phone_progress",
                public_manifest=docs / "pregenerated_text_audio_slot_phone_public_manifest.json",
                output_dir=output_root / "slot-phone",
                batch_size=5,
            ),
            BatchPhaseSpec(
                group="phase2",
                key="phase2-slot-entity",
                label="Slot entities",
                response_manifest=slot_dir / "entity.json",
                state=docs / "pregenerated_text_audio_slot_entity_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_slot_entity_batches",
                progress_dir=docs / "pregenerated_text_audio_slot_entity_progress",
                public_manifest=docs / "pregenerated_text_audio_slot_entity_public_manifest.json",
                output_dir=output_root / "slot-entity",
                batch_size=20,
            ),
            BatchPhaseSpec(
                group="phase2",
                key="phase2-slot-location",
                label="Slot locations",
                response_manifest=slot_dir / "location.json",
                state=docs / "pregenerated_text_audio_slot_location_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_slot_location_batches",
                progress_dir=docs / "pregenerated_text_audio_slot_location_progress",
                public_manifest=docs / "pregenerated_text_audio_slot_location_public_manifest.json",
                output_dir=output_root / "slot-location",
                batch_size=20,
            ),
            BatchPhaseSpec(
                group="phase2",
                key="phase2-slot-address-part",
                label="Slot address parts",
                response_manifest=slot_dir / "address-part.json",
                state=docs / "pregenerated_text_audio_slot_address_part_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_slot_address_part_batches",
                progress_dir=docs / "pregenerated_text_audio_slot_address_part_progress",
                public_manifest=docs / "pregenerated_text_audio_slot_address_part_public_manifest.json",
                output_dir=output_root / "slot-address-part",
                batch_size=20,
            ),
            BatchPhaseSpec(
                group="phase2",
                key="phase2-slot-zip",
                label="Slot zip values",
                response_manifest=slot_dir / "zip.json",
                state=docs / "pregenerated_text_audio_slot_zip_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_slot_zip_batches",
                progress_dir=docs / "pregenerated_text_audio_slot_zip_progress",
                public_manifest=docs / "pregenerated_text_audio_slot_zip_public_manifest.json",
                output_dir=output_root / "slot-zip",
                batch_size=8,
            ),
        ),
        "phase3": (
            BatchPhaseSpec(
                group="phase3",
                key="phase3-duplicate",
                label="Duplicate full responses",
                response_manifest=docs / "pregenerated_text_audio_duplicate_response_manifest.json",
                state=docs / "pregenerated_text_audio_duplicate_response_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_duplicate_response_batches",
                progress_dir=docs / "pregenerated_text_audio_duplicate_response_progress",
                public_manifest=docs / "pregenerated_text_audio_duplicate_response_public_manifest.json",
                output_dir=output_root / "duplicate-responses",
                batch_size=default_batch_size,
            ),
        ),
        "phase4": (
            BatchPhaseSpec(
                group="phase4",
                key="phase4-residual",
                label="Residual full responses",
                response_manifest=docs / "pregenerated_text_audio_residual_response_manifest.json",
                state=docs / "pregenerated_text_audio_residual_response_batch_state.json",
                batch_manifest_dir=docs / "pregenerated_text_audio_residual_response_batches",
                progress_dir=docs / "pregenerated_text_audio_residual_response_progress",
                public_manifest=docs / "pregenerated_text_audio_residual_response_public_manifest.json",
                output_dir=output_root / "residual-responses",
                batch_size=default_batch_size,
            ),
        ),
    }


def ordered_unique(items: Iterable[str]) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return tuple(result)


def selected_phase_groups(args: argparse.Namespace) -> tuple[str, ...]:
    requested = list(args.phases or [])
    if not requested:
        requested = list(DEFAULT_PHASES)
    if args.rerender_phase2 and "phase2" not in requested:
        requested.append("phase2")
    requested_set = set(requested)
    return tuple(phase for phase in PHASE_ORDER if phase in requested_set)


def restart_phase_groups(args: argparse.Namespace) -> frozenset[str]:
    phases = set(args.restart_phases or [])
    if args.rerender_phase2:
        phases.add("phase2")
    return frozenset(phases)


def read_resume_offset(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return 0
    try:
        return max(0, int(payload.get("nextOffset") or 0))
    except (TypeError, ValueError):
        return 0


def resolve_start_offset(spec: BatchPhaseSpec, args: argparse.Namespace, restart_groups: frozenset[str]) -> int:
    if spec.group == "phase1" and args.phase1_start_offset is not None:
        return max(0, int(args.phase1_start_offset))
    if spec.group in restart_groups:
        return 0
    return read_resume_offset(spec.state)


def relative_to_repo(path: Path, repo_root: Path) -> Path:
    return path if path.is_absolute() else (repo_root / path)


def append_path_suffix(base: str, suffix: str) -> str:
    normalized_base = str(base or "").strip().rstrip("/")
    normalized_suffix = str(suffix or "").strip().strip("/")
    if not normalized_base:
        return ""
    if not normalized_suffix:
        return normalized_base
    return f"{normalized_base}/{normalized_suffix}"


def precomputed_audio_root(repo_root: Path) -> Path:
    return repo_root / "wallet_interface" / "ui" / "public" / "assets" / "audio" / "precomputed"


def build_refresh_steps(repo_root: Path) -> list[CommandStep]:
    scripts_dir = repo_root / "scripts"
    return [
        CommandStep(
            name="refresh-response-manifest",
            command=("python3", str(scripts_dir / "build_pregenerated_text_response_manifest.py")),
        ),
        CommandStep(
            name="refresh-slot-asset-manifests",
            command=("python3", str(scripts_dir / "build_pregenerated_audio_asset_manifests.py")),
        ),
        CommandStep(
            name="refresh-vocabulary-manifest",
            command=("python3", str(scripts_dir / "build_pregenerated_audio_vocabulary_manifest.py")),
        ),
    ]


def build_response_phase_manifest_step(repo_root: Path) -> CommandStep:
    return CommandStep(
        name="build-phase-response-manifests",
        command=("python3", str(repo_root / "scripts" / "build_pregenerated_audio_response_phase_manifests.py")),
    )


def build_batch_step(spec: BatchPhaseSpec, args: argparse.Namespace, repo_root: Path, restart_groups: frozenset[str]) -> CommandStep:
    start_offset = resolve_start_offset(spec, args, restart_groups)
    cmd = [
        "python3",
        str(repo_root / "scripts" / "run_indextts_batch_generation.py"),
        "--response-manifest",
        str(spec.response_manifest),
        "--state",
        str(spec.state),
        "--batch-manifest-dir",
        str(spec.batch_manifest_dir),
        "--progress-dir",
        str(spec.progress_dir),
        "--public-manifest",
        str(spec.public_manifest),
        "--output-dir",
        str(spec.output_dir),
        "--start-offset",
        str(start_offset),
        "--batch-size",
        str(spec.batch_size),
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
    if args.space_url:
        cmd.extend(["--space-url", args.space_url])
    phase_bucket_uri = append_path_suffix(args.bucket_uri, spec.key)
    if phase_bucket_uri:
        cmd.extend(["--bucket-uri", phase_bucket_uri])
    if args.force:
        cmd.append("--force")
    if args.stop_on_error:
        cmd.append("--stop-on-error")
    if args.validate_transcripts:
        cmd.extend(
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
        cmd.append("--transcript-validation-soft-fail")
    return CommandStep(name=spec.key, command=tuple(cmd), output_dirs=(spec.output_dir,))


def timestamp_label() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def unique_paths(paths: Iterable[Path]) -> tuple[Path, ...]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        normalized = str(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(path)
    return tuple(result)


def build_upload_step(args: argparse.Namespace, repo_root: Path, executed_specs: Sequence[BatchPhaseSpec]) -> CommandStep:
    remote_prefix = str(args.upload_remote_prefix or f"audio/abby-tts/runs/{timestamp_label()}").strip()
    audio_roots = unique_paths(
        [
            precomputed_audio_root(repo_root),
            *(spec.output_dir for spec in executed_specs),
            *(relative_to_repo(Path(path), repo_root) for path in (args.upload_audio_roots or [])),
        ]
    )
    cmd = [
        "python3",
        str(repo_root / "scripts" / "upload_hf_abby_tts_dataset.py"),
        "--repo-id",
        args.upload_repo_id,
        "--remote-prefix",
        remote_prefix,
        "--stage-dir",
        str(relative_to_repo(args.upload_stage_dir, repo_root)),
        "--upload",
    ]
    for root in audio_roots:
        cmd.extend(["--audio-root", str(root)])
    if args.force_upload:
        cmd.append("--force-upload")
    if args.private:
        cmd.append("--private")
    if args.skip_parquet:
        cmd.append("--skip-parquet")
    return CommandStep(name="upload-abby-tts-dataset", command=tuple(cmd), output_dirs=audio_roots)


def build_steps(
    args: argparse.Namespace,
    *,
    repo_root: Path = REPO_ROOT,
    catalog: dict[str, tuple[BatchPhaseSpec, ...]] | None = None,
) -> list[CommandStep]:
    resolved_output_root = relative_to_repo(args.output_root, repo_root)
    resolved_catalog = catalog or build_phase_catalog(repo_root, resolved_output_root, default_batch_size=args.batch_size)
    selected_groups = selected_phase_groups(args)
    restart_groups = restart_phase_groups(args)
    steps: list[CommandStep] = []
    executed_specs: list[BatchPhaseSpec] = []

    if args.refresh_input_manifests:
        steps.extend(build_refresh_steps(repo_root))

    if "phase3" in selected_groups or "phase4" in selected_groups:
        steps.append(build_response_phase_manifest_step(repo_root))

    for group in selected_groups:
        for spec in resolved_catalog.get(group, ()):
            steps.append(build_batch_step(spec, args, repo_root, restart_groups))
            executed_specs.append(spec)

    if args.upload:
        steps.append(build_upload_step(args, repo_root, executed_specs))

    return steps


def format_command(command: Sequence[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def main() -> None:
    args = parse_args()
    repo_root = REPO_ROOT
    steps = build_steps(args, repo_root=repo_root)
    if args.dry_run:
        print(f"Planned {len(steps)} step(s):")
        for index, step in enumerate(steps, start=1):
            print(f"[{index}/{len(steps)}] {step.name}")
            print(format_command(step.command))
        return

    for index, step in enumerate(steps, start=1):
        print(f"[{index}/{len(steps)}] {step.name}")
        print(format_command(step.command))
        subprocess.run(step.command, cwd=repo_root, check=True)


if __name__ == "__main__":
    main()