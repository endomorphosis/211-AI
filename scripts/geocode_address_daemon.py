from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
IPFS_DATASETS_ROOT = REPO_ROOT / "ipfs_datasets_py"
for import_root in (IPFS_DATASETS_ROOT, REPO_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))
os.environ.setdefault("IPFS_DATASETS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_DATASETS_PY_MINIMAL_IMPORTS", "1")

from scraper.enrich_service_addresses import (  # noqa: E402
    DEFAULT_CACHE_PATH,
    DEFAULT_PORTAL_DIR,
    build_geocode_miss_diagnostics_report,
    build_query_from_location_row,
    enrich_service_addresses,
    load_cache,
    parse_json_value,
    write_json_atomic,
)
from scraper.utils import setup_logging  # noqa: E402


logger = setup_logging()

DEFAULT_STATE_DIR = REPO_ROOT / "data" / "portal_geocoding" / "state"
DEFAULT_STATE_PREFIX = "portal_geocode"
DEFAULT_BROWSER_OUTPUT_DIR = REPO_ROOT / "wallet_interface" / "ui" / "public" / "corpus" / "211-info" / "current"
DEFAULT_BATCH_SIZE_NEW = 180
DEFAULT_BATCH_SIZE_RETRY = 60
DEFAULT_LOOP_SLEEP_SECONDS = 30.0
DEFAULT_IDLE_SLEEP_SECONDS = 600.0
DEFAULT_RETRY_ZERO_HIT_THRESHOLD = 8
DEFAULT_SEARCH_REPAIR_BATCH_SIZE = 40
DEFAULT_SEARCH_REPAIR_ZERO_HIT_THRESHOLD = 6
DEFAULT_SEARCH_REPAIR_RESULTS_PER_QUERY = 5
DEFAULT_SEARCH_REPAIR_MAX_CANDIDATE_GEOCODE_ATTEMPTS = 6
DEFAULT_SEARCH_REPAIR_TIMEOUT_SECONDS = 180.0


def daemon_pid_path(state_dir: Path, state_prefix: str) -> Path:
    return state_dir / f"{state_prefix}_daemon.pid"


def daemon_state_path(state_dir: Path, state_prefix: str) -> Path:
    return state_dir / f"{state_prefix}_state.json"


def search_handoff_json_path(source_dir: Path) -> Path:
    return source_dir / "geocode_search_handoff.json"


def search_handoff_parquet_path(source_dir: Path) -> Path:
    return source_dir / "geocode_search_handoff.parquet"


def search_repair_report_path(source_dir: Path) -> Path:
    return source_dir / "geocode_search_repair_report.json"


def search_repair_progress_path(state_dir: Path, state_prefix: str) -> Path:
    return state_dir / f"{state_prefix}_search_repair_progress.json"


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(text, encoding="utf-8")
    temp_path.replace(path)


def safe_read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def summarize_geocode_progress(
    *,
    source_dir: Path,
    cache_path: Path,
) -> dict[str, Any]:
    cache = load_cache(cache_path)
    locations_path = source_dir / "service_locations.parquet"
    locations_frame = pd.read_parquet(locations_path).fillna("")
    total_unique_queries: dict[str, str] = {}
    unresolved_query_keys: set[str] = set()

    for row in locations_frame.to_dict(orient="records"):
        query = build_query_from_location_row(row)
        if not query:
            continue
        total_unique_queries.setdefault(query.key, query.display)
        existing_geo = parse_json_value(row.get("geo_json"), {"lat": None, "lon": None})
        if isinstance(existing_geo, dict) and existing_geo.get("lat") is not None and existing_geo.get("lon") is not None:
            continue
        unresolved_query_keys.add(query.key)

    cache_status_counts: dict[str, int] = {}
    for record in cache.values():
        status = str(record.get("status") or "unknown")
        cache_status_counts[status] = cache_status_counts.get(status, 0) + 1

    uncached_remaining = 0
    cached_non_ok_remaining = 0
    cached_ok_remaining = 0
    for key in unresolved_query_keys:
        record = cache.get(key)
        if record is None:
            uncached_remaining += 1
            continue
        if record.get("status") == "ok":
            cached_ok_remaining += 1
        else:
            cached_non_ok_remaining += 1

    manifest = safe_read_json(source_dir / "service_portal_manifest.json")
    coverage = manifest.get("coverage") if isinstance(manifest.get("coverage"), dict) else {}
    service_geo = coverage.get("geo") if isinstance(coverage.get("geo"), dict) else {}
    location_geo = coverage.get("location_geo") if isinstance(coverage.get("location_geo"), dict) else {}

    return {
        "cache_entries": len(cache),
        "cache_status_counts": cache_status_counts,
        "total_unique_queries": len(total_unique_queries),
        "unresolved_query_count": len(unresolved_query_keys),
        "uncached_remaining": uncached_remaining,
        "cached_non_ok_remaining": cached_non_ok_remaining,
        "cached_ok_remaining": cached_ok_remaining,
        "remaining_query_count": uncached_remaining + cached_non_ok_remaining + cached_ok_remaining,
        "service_geo_count": int(service_geo.get("count") or 0),
        "service_geo_pct": float(service_geo.get("pct") or 0.0),
        "location_geo_count": int(location_geo.get("count") or 0),
        "location_geo_pct": float(location_geo.get("pct") or 0.0),
    }


def choose_geocode_mode(summary: dict[str, Any]) -> str:
    if int(summary.get("uncached_remaining") or 0) > 0:
        return "new"
    if int(summary.get("cached_non_ok_remaining") or 0) > 0:
        return "retry"
    return "idle"


def choose_geocode_mode_with_state(
    summary: dict[str, Any],
    state: dict[str, Any],
    *,
    retry_zero_hit_threshold: int,
    search_repair_enabled: bool,
    search_repair_zero_hit_threshold: int,
) -> str:
    if int(summary.get("uncached_remaining") or 0) > 0:
        return "new"
    cached_non_ok_remaining = int(summary.get("cached_non_ok_remaining") or 0)
    if cached_non_ok_remaining <= 0:
        return "idle"
    if bool(state.get("nominatim_complete")):
        if not search_repair_enabled:
            return "idle"
        search_zero_hit_streak = int(state.get("search_zero_hit_streak") or 0)
        if search_zero_hit_streak >= max(1, int(search_repair_zero_hit_threshold)):
            return "search_exhausted"
        return "search_repair"
    zero_hit_retry_streak = int(state.get("zero_hit_retry_streak") or 0)
    if zero_hit_retry_streak >= max(1, int(retry_zero_hit_threshold)):
        return "search_handoff"
    return "retry"


def build_search_handoff(source_dir: Path, cache_path: Path) -> dict[str, Any]:
    diagnostics = build_geocode_miss_diagnostics_report(
        cache_path=cache_path,
        output_json_path=source_dir / "geocode_miss_diagnostics.json",
        output_parquet_path=source_dir / "geocode_miss_diagnostics.parquet",
    )
    rows = diagnostics.get("rows") if isinstance(diagnostics.get("rows"), list) else []
    handoff_rows: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        normalized_street = str(row.get("normalized_street_without_unit") or row.get("normalized_street") or row.get("street") or "").strip()
        normalized_city = str(row.get("normalized_city") or row.get("city") or "").strip()
        state = str(row.get("state") or "").strip()
        postal_code = str(row.get("postal_code") or "").strip()
        search_query = " ".join(part for part in [normalized_street, normalized_city, state, postal_code] if part).strip()
        search_query_quoted = " ".join(
            part
            for part in [
                f"\"{normalized_street}\"" if normalized_street else "",
                f"\"{normalized_city}\"" if normalized_city else "",
                state,
                postal_code,
            ]
            if part
        ).strip()
        payload = dict(row)
        payload["search_query"] = search_query
        payload["search_query_quoted"] = search_query_quoted
        handoff_rows.append(payload)

    handoff_rows.sort(
        key=lambda row: (
            0 if row.get("classification") == "likely_provider_or_coverage_miss" else 1,
            str(row.get("city") or ""),
            str(row.get("street") or ""),
            str(row.get("postal_code") or ""),
        )
    )
    handoff = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "nominatim_plateau_handoff",
        "miss_count": len(handoff_rows),
        "classification_counts": diagnostics.get("classification_counts") or {},
        "search_stage_ready": True,
        "rows": handoff_rows,
    }
    write_json_atomic(search_handoff_json_path(source_dir), handoff)
    parquet_rows = []
    for row in handoff_rows:
        payload = dict(row)
        payload["issue_tags_json"] = json.dumps(row.get("issue_tags") or [], separators=(",", ":"))
        payload["search_params_json"] = json.dumps(row.get("search_params") or {}, separators=(",", ":"))
        payload.pop("issue_tags", None)
        payload.pop("search_params", None)
        parquet_rows.append(payload)
    pd.DataFrame(parquet_rows).to_parquet(search_handoff_parquet_path(source_dir), index=False)
    return {
        "miss_count": len(handoff_rows),
        "classification_counts": handoff.get("classification_counts") or {},
        "search_handoff_json": str(search_handoff_json_path(source_dir)),
        "search_handoff_parquet": str(search_handoff_parquet_path(source_dir)),
    }


def refresh_browser_corpus(browser_output_dir: Path) -> dict[str, Any]:
    command = [
        sys.executable,
        str(REPO_ROOT / "scraper" / "browser_graphrag_corpus.py"),
        "--output-dir",
        str(browser_output_dir),
    ]
    started_at = time.time()
    completed = subprocess.run(
        command,
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
        timeout=max(1.0, float(args.search_repair_timeout_seconds)),
    )
    payload: dict[str, Any] = {
        "command": command,
        "returncode": int(completed.returncode),
        "duration_seconds": round(time.time() - started_at, 3),
    }
    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    if stdout:
        try:
            payload["result"] = json.loads(stdout)
        except Exception:
            payload["stdout_tail"] = stdout[-4000:]
    if stderr:
        payload["stderr_tail"] = stderr[-4000:]
    return payload


def run_search_repair_batch(args: argparse.Namespace) -> dict[str, Any]:
    progress_path = search_repair_progress_path(args.state_dir.resolve(), args.state_prefix)
    command = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "geocode_search_repair.py"),
        "--source-dir",
        str(args.source_dir),
        "--cache-path",
        str(args.cache_path),
        "--handoff-json",
        str(search_handoff_json_path(args.source_dir)),
        "--report-path",
        str(search_repair_report_path(args.source_dir)),
        "--progress-path",
        str(progress_path),
        "--max-rows",
        str(args.search_repair_max_rows),
        "--search-results-per-query",
        str(args.search_repair_results_per_query),
        "--max-candidate-geocode-attempts-per-row",
        str(args.search_repair_max_candidate_geocode_attempts),
    ]
    for engine in args.search_repair_engine:
        command.extend(["--engine", str(engine)])
    for classification in args.search_repair_classification:
        command.extend(["--classification", str(classification)])

    started_at = time.time()
    completed = subprocess.run(
        command,
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    payload: dict[str, Any] = {
        "command": command,
        "returncode": int(completed.returncode),
        "duration_seconds": round(time.time() - started_at, 3),
    }
    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    if stdout:
        try:
            payload["result"] = json.loads(stdout)
        except Exception:
            payload["stdout_tail"] = stdout[-4000:]
    if stderr:
        payload["stderr_tail"] = stderr[-4000:]
    if completed.returncode != 0:
        raise RuntimeError(f"search repair failed: returncode={completed.returncode} stderr={stderr[-400:]}")
    result = payload.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("search repair did not return JSON report payload")
    merged = dict(result)
    merged["subprocess"] = payload
    merged["progress_path"] = str(progress_path)
    return merged


def write_daemon_state(path: Path, payload: dict[str, Any]) -> None:
    payload = dict(payload)
    payload["schema"] = "211-ai.portal_geocode_daemon.v1"
    payload["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json_atomic(path, payload)


def run_geocode_pass(args: argparse.Namespace, *, pass_index: int, prior_state: dict[str, Any] | None = None) -> dict[str, Any]:
    prior_state = prior_state or {}
    before = summarize_geocode_progress(source_dir=args.source_dir, cache_path=args.cache_path)
    mode = choose_geocode_mode_with_state(
        before,
        prior_state,
        retry_zero_hit_threshold=args.retry_zero_hit_threshold,
        search_repair_enabled=args.search_repair_enabled,
        search_repair_zero_hit_threshold=args.search_repair_zero_hit_threshold,
    )
    if mode == "idle":
        return {
            "mode": "idle",
            "pass_index": pass_index,
            "before": before,
            "result": None,
            "after": before,
            "browser_refresh": None,
            "sleep_seconds": args.idle_sleep_seconds,
        }
    if mode == "search_handoff":
        handoff = build_search_handoff(args.source_dir, args.cache_path)
        return {
            "mode": "search_handoff",
            "pass_index": pass_index,
            "before": before,
            "result": {
                "nominatim_complete": True,
                "reason": "zero_hit_retry_plateau",
                "retry_zero_hit_threshold": args.retry_zero_hit_threshold,
                "search_handoff": handoff,
            },
            "after": before,
            "browser_refresh": None,
            "sleep_seconds": args.idle_sleep_seconds,
        }
    if mode == "search_repair":
        logger.info(
            "starting search repair pass %d max_rows=%d unresolved=%d",
            pass_index,
            int(args.search_repair_max_rows),
            int(before.get("cached_non_ok_remaining") or 0),
        )
        try:
            result = run_search_repair_batch(args)
            logger.info(
                "completed search repair pass %d attempted=%d repaired=%d unrepaired=%d",
                pass_index,
                int(result.get("attempted_rows") or 0),
                int(result.get("repaired_rows") or 0),
                int(result.get("unrepaired_rows") or 0),
            )
        except Exception as exc:
            logger.warning("search repair pass %d failed: %s", pass_index, exc)
            result = {
                "attempted_rows": 0,
                "repaired_rows": 0,
                "unrepaired_rows": 0,
                "error": f"{type(exc).__name__}: {exc}",
            }
        after = summarize_geocode_progress(source_dir=args.source_dir, cache_path=args.cache_path)
        return {
            "mode": "search_repair",
            "pass_index": pass_index,
            "before": before,
            "result": result,
            "after": after,
            "browser_refresh": None,
            "sleep_seconds": args.sleep_seconds,
        }
    if mode == "search_exhausted":
        return {
            "mode": "search_exhausted",
            "pass_index": pass_index,
            "before": before,
            "result": {
                "reason": "search_repair_zero_hit_plateau",
                "search_repair_zero_hit_threshold": args.search_repair_zero_hit_threshold,
            },
            "after": before,
            "browser_refresh": None,
            "sleep_seconds": args.idle_sleep_seconds,
        }

    batch_size = args.batch_size_new if mode == "new" else args.batch_size_retry
    logger.info(
        "starting geocode pass %d mode=%s batch_size=%d uncached_remaining=%d cached_non_ok_remaining=%d",
        pass_index,
        mode,
        batch_size,
        int(before.get("uncached_remaining") or 0),
        int(before.get("cached_non_ok_remaining") or 0),
    )
    result = enrich_service_addresses(
        source_dir=args.source_dir,
        cache_path=args.cache_path,
        provider=args.provider,
        min_delay_seconds=args.min_delay_seconds,
        timeout_seconds=args.timeout_seconds,
        max_retries=args.max_retries,
        max_queries=batch_size,
        retry_misses=(mode == "retry"),
        repair_malformed_retries=True,
        refresh_only=False,
        overwrite=False,
    )
    after = summarize_geocode_progress(source_dir=args.source_dir, cache_path=args.cache_path)
    browser_refresh = None
    if args.refresh_browser_corpus and int(result.get("geocode_hits") or 0) > 0:
        browser_refresh = refresh_browser_corpus(args.browser_output_dir)
        logger.info(
            "browser corpus refresh returncode=%s duration_seconds=%s",
            browser_refresh.get("returncode"),
            browser_refresh.get("duration_seconds"),
        )
    return {
        "mode": mode,
        "pass_index": pass_index,
        "before": before,
        "result": result,
        "after": after,
        "browser_refresh": browser_refresh,
        "sleep_seconds": args.sleep_seconds,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Continuously geocode remaining portal service addresses")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_PORTAL_DIR)
    parser.add_argument("--cache-path", type=Path, default=DEFAULT_CACHE_PATH)
    parser.add_argument("--browser-output-dir", type=Path, default=DEFAULT_BROWSER_OUTPUT_DIR)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--state-prefix", default=DEFAULT_STATE_PREFIX)
    parser.add_argument("--provider", default="nominatim")
    parser.add_argument("--batch-size-new", type=int, default=DEFAULT_BATCH_SIZE_NEW)
    parser.add_argument("--batch-size-retry", type=int, default=DEFAULT_BATCH_SIZE_RETRY)
    parser.add_argument("--min-delay-seconds", type=float, default=1.1)
    parser.add_argument("--timeout-seconds", type=float, default=12.0)
    parser.add_argument("--max-retries", type=int, default=2)
    parser.add_argument("--sleep-seconds", type=float, default=DEFAULT_LOOP_SLEEP_SECONDS)
    parser.add_argument("--idle-sleep-seconds", type=float, default=DEFAULT_IDLE_SLEEP_SECONDS)
    parser.add_argument("--retry-zero-hit-threshold", type=int, default=DEFAULT_RETRY_ZERO_HIT_THRESHOLD)
    parser.add_argument("--search-repair-max-rows", type=int, default=DEFAULT_SEARCH_REPAIR_BATCH_SIZE)
    parser.add_argument("--search-repair-results-per-query", type=int, default=DEFAULT_SEARCH_REPAIR_RESULTS_PER_QUERY)
    parser.add_argument(
        "--search-repair-max-candidate-geocode-attempts",
        type=int,
        default=DEFAULT_SEARCH_REPAIR_MAX_CANDIDATE_GEOCODE_ATTEMPTS,
    )
    parser.add_argument("--search-repair-timeout-seconds", type=float, default=DEFAULT_SEARCH_REPAIR_TIMEOUT_SECONDS)
    parser.add_argument("--search-repair-zero-hit-threshold", type=int, default=DEFAULT_SEARCH_REPAIR_ZERO_HIT_THRESHOLD)
    parser.add_argument(
        "--search-repair-engine",
        action="append",
        default=[],
        help="Search engine order for post-Nominatim repair. May be repeated.",
    )
    parser.add_argument(
        "--search-repair-classification",
        action="append",
        default=[],
        help="Classification to include in search repair. May be repeated.",
    )
    parser.add_argument("--search-repair-enabled", dest="search_repair_enabled", action="store_true")
    parser.add_argument("--no-search-repair-enabled", dest="search_repair_enabled", action="store_false")
    parser.add_argument("--log-level", default="INFO", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--refresh-browser-corpus", dest="refresh_browser_corpus", action="store_true")
    parser.add_argument("--no-refresh-browser-corpus", dest="refresh_browser_corpus", action="store_false")
    parser.set_defaults(refresh_browser_corpus=True, search_repair_enabled=True)
    args = parser.parse_args(argv)
    if not args.search_repair_engine:
        args.search_repair_engine = ["brave", "duckduckgo"]
    if not args.search_repair_classification:
        args.search_repair_classification = ["likely_provider_or_coverage_miss", "likely_malformed_input"]
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    state_dir = args.state_dir.resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    pid_path = daemon_pid_path(state_dir, args.state_prefix)
    state_path = daemon_state_path(state_dir, args.state_prefix)
    write_text_atomic(pid_path, f"{os.getpid()}\n")
    logger.setLevel(getattr(logging, args.log_level.upper(), logging.INFO))

    current_state = safe_read_json(state_path)
    pass_index = int(current_state.get("pass_count") or 0)
    try:
        while True:
            pass_index += 1
            started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            progress = summarize_geocode_progress(source_dir=args.source_dir, cache_path=args.cache_path)
            write_daemon_state(
                state_path,
                {
                    "status": "running",
                    "heartbeat_at": started_at,
                    "pid": os.getpid(),
                    "pass_count": pass_index - 1,
                    "phase": "scan",
                    "progress": progress,
                    "search_repair_progress": safe_read_json(search_repair_progress_path(state_dir, args.state_prefix)),
                    "config": {
                        "source_dir": str(args.source_dir),
                        "cache_path": str(args.cache_path),
                        "browser_output_dir": str(args.browser_output_dir),
                        "batch_size_new": args.batch_size_new,
                        "batch_size_retry": args.batch_size_retry,
                        "min_delay_seconds": args.min_delay_seconds,
                        "timeout_seconds": args.timeout_seconds,
                        "max_retries": args.max_retries,
                        "sleep_seconds": args.sleep_seconds,
                        "idle_sleep_seconds": args.idle_sleep_seconds,
                        "retry_zero_hit_threshold": args.retry_zero_hit_threshold,
                        "search_repair_enabled": args.search_repair_enabled,
                        "search_repair_max_rows": args.search_repair_max_rows,
                        "search_repair_results_per_query": args.search_repair_results_per_query,
                        "search_repair_max_candidate_geocode_attempts": args.search_repair_max_candidate_geocode_attempts,
                        "search_repair_timeout_seconds": args.search_repair_timeout_seconds,
                        "search_repair_zero_hit_threshold": args.search_repair_zero_hit_threshold,
                        "search_repair_engine": list(args.search_repair_engine),
                        "search_repair_classification": list(args.search_repair_classification),
                        "search_repair_progress_path": str(search_repair_progress_path(state_dir, args.state_prefix)),
                        "refresh_browser_corpus": args.refresh_browser_corpus,
                    },
                    "zero_hit_retry_streak": int(current_state.get("zero_hit_retry_streak") or 0),
                    "search_zero_hit_streak": int(current_state.get("search_zero_hit_streak") or 0),
                    "nominatim_complete": bool(current_state.get("nominatim_complete")),
                },
            )
            pass_result = run_geocode_pass(args, pass_index=pass_index, prior_state=current_state)
            finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            next_zero_hit_retry_streak = int(current_state.get("zero_hit_retry_streak") or 0)
            next_search_zero_hit_streak = int(current_state.get("search_zero_hit_streak") or 0)
            if pass_result["mode"] == "retry":
                geocode_hits = int((pass_result.get("result") or {}).get("geocode_hits") or 0)
                next_zero_hit_retry_streak = 0 if geocode_hits > 0 else next_zero_hit_retry_streak + 1
                next_search_zero_hit_streak = 0
            elif pass_result["mode"] == "search_repair":
                repaired_rows = int((pass_result.get("result") or {}).get("repaired_rows") or 0)
                next_search_zero_hit_streak = 0 if repaired_rows > 0 else next_search_zero_hit_streak + 1
            elif pass_result["mode"] in {"new", "idle", "search_handoff", "search_exhausted"}:
                next_zero_hit_retry_streak = 0
                if pass_result["mode"] != "search_exhausted":
                    next_search_zero_hit_streak = 0
            next_nominatim_complete = bool(current_state.get("nominatim_complete"))
            if pass_result["mode"] == "search_handoff":
                next_nominatim_complete = True
            write_daemon_state(
                state_path,
                {
                    "status": "idle" if pass_result["mode"] in {"idle", "search_handoff", "search_exhausted"} else "running",
                    "heartbeat_at": finished_at,
                    "pid": os.getpid(),
                    "pass_count": pass_index,
                    "phase": (
                        "search_ready"
                        if pass_result["mode"] == "search_handoff"
                        else (
                            "search_exhausted"
                            if pass_result["mode"] == "search_exhausted"
                            else ("sleep" if not args.once else "done")
                        )
                    ),
                    "last_run_started_at": started_at,
                    "last_run_finished_at": finished_at,
                    "last_run_mode": pass_result["mode"],
                    "last_run_result": pass_result["result"],
                    "last_browser_refresh": pass_result["browser_refresh"],
                    "progress": pass_result["after"],
                    "search_repair_progress": safe_read_json(search_repair_progress_path(state_dir, args.state_prefix)),
                    "next_sleep_seconds": pass_result["sleep_seconds"],
                    "zero_hit_retry_streak": next_zero_hit_retry_streak,
                    "search_zero_hit_streak": next_search_zero_hit_streak,
                    "nominatim_complete": next_nominatim_complete,
                },
            )
            current_state = safe_read_json(state_path)
            if args.once:
                print(json.dumps(pass_result, indent=2))
                return 0
            time.sleep(float(pass_result["sleep_seconds"]))
    finally:
        pid_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
