from __future__ import annotations

import json
from pathlib import Path

from scripts import geocode_address_daemon as daemon
from scripts import manage_geocode_service as manager


def test_choose_geocode_mode_prefers_uncached_then_retry():
    assert daemon.choose_geocode_mode({"uncached_remaining": 12, "cached_non_ok_remaining": 5}) == "new"
    assert daemon.choose_geocode_mode({"uncached_remaining": 0, "cached_non_ok_remaining": 5}) == "retry"
    assert daemon.choose_geocode_mode({"uncached_remaining": 0, "cached_non_ok_remaining": 0}) == "idle"
    assert (
        daemon.choose_geocode_mode_with_state(
            {"uncached_remaining": 0, "cached_non_ok_remaining": 5},
            {},
            retry_zero_hit_threshold=8,
            search_repair_enabled=True,
            search_repair_zero_hit_threshold=6,
        )
        == "retry"
    )
    assert (
        daemon.choose_geocode_mode_with_state(
            {"uncached_remaining": 0, "cached_non_ok_remaining": 5},
            {"zero_hit_retry_streak": 8},
            retry_zero_hit_threshold=8,
            search_repair_enabled=True,
            search_repair_zero_hit_threshold=6,
        )
        == "search_handoff"
    )
    assert (
        daemon.choose_geocode_mode_with_state(
            {"uncached_remaining": 0, "cached_non_ok_remaining": 5},
            {"nominatim_complete": True},
            retry_zero_hit_threshold=8,
            search_repair_enabled=True,
            search_repair_zero_hit_threshold=6,
        )
        == "search_repair"
    )
    assert (
        daemon.choose_geocode_mode_with_state(
            {"uncached_remaining": 0, "cached_non_ok_remaining": 5},
            {"nominatim_complete": True},
            retry_zero_hit_threshold=8,
            search_repair_enabled=False,
            search_repair_zero_hit_threshold=6,
        )
        == "idle"
    )


def test_geocode_daemon_once_writes_state_and_refreshes_on_hits(tmp_path: Path, monkeypatch, capsys) -> None:
    summaries = iter(
        [
            {"uncached_remaining": 10, "cached_non_ok_remaining": 0, "service_geo_count": 100, "location_geo_count": 200},
            {"uncached_remaining": 10, "cached_non_ok_remaining": 0, "service_geo_count": 100, "location_geo_count": 200},
            {"uncached_remaining": 4, "cached_non_ok_remaining": 0, "service_geo_count": 106, "location_geo_count": 212},
        ]
    )

    monkeypatch.setattr(daemon, "summarize_geocode_progress", lambda **_: next(summaries))
    monkeypatch.setattr(
        daemon,
        "enrich_service_addresses",
        lambda **_: {
            "fetched_queries": 6,
            "geocode_hits": 6,
            "geocode_misses": 0,
            "geocode_errors": 0,
            "service_geo_count": 106,
            "location_geo_count": 212,
        },
    )
    monkeypatch.setattr(daemon, "refresh_browser_corpus", lambda _path: {"returncode": 0, "result": {"artifact_count": 1}})

    state_dir = tmp_path / "state"
    exit_code = daemon.main(
        [
            "--once",
            "--state-dir",
            str(state_dir),
            "--state-prefix",
            "geo",
            "--source-dir",
            str(tmp_path / "portal"),
            "--cache-path",
            str(tmp_path / "cache.json"),
            "--browser-output-dir",
            str(tmp_path / "browser"),
        ]
    )

    assert exit_code == 0
    state = json.loads((state_dir / "geo_state.json").read_text(encoding="utf-8"))
    assert state["last_run_mode"] == "new"
    assert state["last_run_result"]["geocode_hits"] == 6
    assert state["last_browser_refresh"]["returncode"] == 0
    assert not (state_dir / "geo_daemon.pid").exists()
    printed = json.loads(capsys.readouterr().out)
    assert printed["mode"] == "new"


def test_geocode_daemon_once_idles_when_queue_empty(tmp_path: Path, monkeypatch, capsys) -> None:
    summaries = iter(
        [
            {"uncached_remaining": 0, "cached_non_ok_remaining": 0, "service_geo_count": 1, "location_geo_count": 2},
            {"uncached_remaining": 0, "cached_non_ok_remaining": 0, "service_geo_count": 1, "location_geo_count": 2},
        ]
    )
    monkeypatch.setattr(daemon, "summarize_geocode_progress", lambda **_: next(summaries))

    called = {"enrich": False, "refresh": False}

    def fake_enrich(**_: object) -> dict[str, object]:
        called["enrich"] = True
        return {}

    def fake_refresh(_path: Path) -> dict[str, object]:
        called["refresh"] = True
        return {}

    monkeypatch.setattr(daemon, "enrich_service_addresses", fake_enrich)
    monkeypatch.setattr(daemon, "refresh_browser_corpus", fake_refresh)

    state_dir = tmp_path / "state"
    exit_code = daemon.main(
        [
            "--once",
            "--state-dir",
            str(state_dir),
            "--state-prefix",
            "geo",
            "--source-dir",
            str(tmp_path / "portal"),
            "--cache-path",
            str(tmp_path / "cache.json"),
            "--browser-output-dir",
            str(tmp_path / "browser"),
        ]
    )

    assert exit_code == 0
    assert called["enrich"] is False
    assert called["refresh"] is False
    state = json.loads((state_dir / "geo_state.json").read_text(encoding="utf-8"))
    assert state["last_run_mode"] == "idle"
    printed = json.loads(capsys.readouterr().out)
    assert printed["mode"] == "idle"


def test_geocode_daemon_once_emits_search_handoff_after_zero_hit_plateau(tmp_path: Path, monkeypatch, capsys) -> None:
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "geo_state.json").write_text(json.dumps({"pass_count": 4, "zero_hit_retry_streak": 8}), encoding="utf-8")

    monkeypatch.setattr(
        daemon,
        "summarize_geocode_progress",
        lambda **_: {"uncached_remaining": 0, "cached_non_ok_remaining": 12, "service_geo_count": 100, "location_geo_count": 200},
    )
    called = {"enrich": False}

    def fake_enrich(**_: object) -> dict[str, object]:
        called["enrich"] = True
        return {}

    monkeypatch.setattr(daemon, "enrich_service_addresses", fake_enrich)
    monkeypatch.setattr(
        daemon,
        "build_search_handoff",
        lambda source_dir, cache_path: {
            "miss_count": 12,
            "classification_counts": {"likely_provider_or_coverage_miss": 5, "likely_malformed_input": 7},
            "search_handoff_json": str(source_dir / "geocode_search_handoff.json"),
            "search_handoff_parquet": str(source_dir / "geocode_search_handoff.parquet"),
        },
    )

    exit_code = daemon.main(
        [
            "--once",
            "--state-dir",
            str(state_dir),
            "--state-prefix",
            "geo",
            "--source-dir",
            str(tmp_path / "portal"),
            "--cache-path",
            str(tmp_path / "cache.json"),
            "--browser-output-dir",
            str(tmp_path / "browser"),
            "--retry-zero-hit-threshold",
            "8",
        ]
    )

    assert exit_code == 0
    assert called["enrich"] is False
    state = json.loads((state_dir / "geo_state.json").read_text(encoding="utf-8"))
    assert state["last_run_mode"] == "search_handoff"
    assert state["nominatim_complete"] is True
    assert state["phase"] == "search_ready"
    printed = json.loads(capsys.readouterr().out)
    assert printed["mode"] == "search_handoff"
    assert printed["result"]["reason"] == "zero_hit_retry_plateau"


def test_geocode_daemon_once_runs_search_repair_after_nominatim_completion(tmp_path: Path, monkeypatch, capsys) -> None:
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "geo_state.json").write_text(
        json.dumps({"pass_count": 3, "nominatim_complete": True, "search_zero_hit_streak": 0}),
        encoding="utf-8",
    )
    summaries = iter(
        [
            {"uncached_remaining": 0, "cached_non_ok_remaining": 12, "service_geo_count": 100, "location_geo_count": 200},
            {"uncached_remaining": 0, "cached_non_ok_remaining": 12, "service_geo_count": 100, "location_geo_count": 200},
            {"uncached_remaining": 0, "cached_non_ok_remaining": 7, "service_geo_count": 105, "location_geo_count": 210},
        ]
    )
    monkeypatch.setattr(daemon, "summarize_geocode_progress", lambda **_: next(summaries))
    monkeypatch.setattr(
        daemon,
        "run_search_repair_batch",
        lambda _args: {"attempted_rows": 12, "repaired_rows": 5, "unrepaired_rows": 7},
    )

    exit_code = daemon.main(
        [
            "--once",
            "--state-dir",
            str(state_dir),
            "--state-prefix",
            "geo",
            "--source-dir",
            str(tmp_path / "portal"),
            "--cache-path",
            str(tmp_path / "cache.json"),
            "--browser-output-dir",
            str(tmp_path / "browser"),
        ]
    )

    assert exit_code == 0
    state = json.loads((state_dir / "geo_state.json").read_text(encoding="utf-8"))
    assert state["last_run_mode"] == "search_repair"
    assert state["search_zero_hit_streak"] == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["mode"] == "search_repair"
    assert printed["result"]["repaired_rows"] == 5


def test_geocode_daemon_once_marks_search_exhausted_after_zero_hit_streak(tmp_path: Path, monkeypatch, capsys) -> None:
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "geo_state.json").write_text(
        json.dumps({"pass_count": 7, "nominatim_complete": True, "search_zero_hit_streak": 6}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        daemon,
        "summarize_geocode_progress",
        lambda **_: {"uncached_remaining": 0, "cached_non_ok_remaining": 22, "service_geo_count": 100, "location_geo_count": 200},
    )
    called = {"search_repair": False}

    def fake_search_repair(_args):
        called["search_repair"] = True
        return {}

    monkeypatch.setattr(daemon, "run_search_repair_batch", fake_search_repair)

    exit_code = daemon.main(
        [
            "--once",
            "--state-dir",
            str(state_dir),
            "--state-prefix",
            "geo",
            "--source-dir",
            str(tmp_path / "portal"),
            "--cache-path",
            str(tmp_path / "cache.json"),
            "--browser-output-dir",
            str(tmp_path / "browser"),
            "--search-repair-zero-hit-threshold",
            "6",
        ]
    )

    assert exit_code == 0
    assert called["search_repair"] is False
    state = json.loads((state_dir / "geo_state.json").read_text(encoding="utf-8"))
    assert state["last_run_mode"] == "search_exhausted"
    assert state["phase"] == "search_exhausted"
    printed = json.loads(capsys.readouterr().out)
    assert printed["mode"] == "search_exhausted"


def test_geocode_daemon_once_handles_search_repair_failure(tmp_path: Path, monkeypatch, capsys) -> None:
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "geo_state.json").write_text(
        json.dumps({"pass_count": 2, "nominatim_complete": True, "search_zero_hit_streak": 0}),
        encoding="utf-8",
    )
    summaries = iter(
        [
            {"uncached_remaining": 0, "cached_non_ok_remaining": 8, "service_geo_count": 100, "location_geo_count": 200},
            {"uncached_remaining": 0, "cached_non_ok_remaining": 8, "service_geo_count": 100, "location_geo_count": 200},
            {"uncached_remaining": 0, "cached_non_ok_remaining": 8, "service_geo_count": 100, "location_geo_count": 200},
        ]
    )
    monkeypatch.setattr(daemon, "summarize_geocode_progress", lambda **_: next(summaries))

    def fake_search_repair(_args):
        raise RuntimeError("forced failure")

    monkeypatch.setattr(daemon, "run_search_repair_batch", fake_search_repair)

    exit_code = daemon.main(
        [
            "--once",
            "--state-dir",
            str(state_dir),
            "--state-prefix",
            "geo",
            "--source-dir",
            str(tmp_path / "portal"),
            "--cache-path",
            str(tmp_path / "cache.json"),
            "--browser-output-dir",
            str(tmp_path / "browser"),
        ]
    )

    assert exit_code == 0
    state = json.loads((state_dir / "geo_state.json").read_text(encoding="utf-8"))
    assert state["last_run_mode"] == "search_repair"
    assert state["search_zero_hit_streak"] == 1
    printed = json.loads(capsys.readouterr().out)
    assert printed["mode"] == "search_repair"
    assert "forced failure" in printed["result"]["error"]


def test_run_search_repair_batch_passes_progress_path(tmp_path: Path, monkeypatch) -> None:
    source_dir = tmp_path / "portal"
    state_dir = tmp_path / "state"
    source_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)

    captured: dict[str, object] = {}

    class FakeCompleted:
        returncode = 0
        stdout = json.dumps({"attempted_rows": 1, "repaired_rows": 1, "unrepaired_rows": 0})
        stderr = ""

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["kwargs"] = kwargs
        return FakeCompleted()

    monkeypatch.setattr(daemon.subprocess, "run", fake_run)
    args = daemon.parse_args(
        [
            "--state-dir",
            str(state_dir),
            "--state-prefix",
            "geo",
            "--source-dir",
            str(source_dir),
            "--cache-path",
            str(source_dir / "cache.json"),
            "--browser-output-dir",
            str(tmp_path / "browser"),
            "--search-repair-engine",
            "brave",
            "--search-repair-classification",
            "likely_provider_or_coverage_miss",
        ]
    )

    result = daemon.run_search_repair_batch(args)
    command = [str(part) for part in captured.get("command", [])]
    assert "--progress-path" in command
    progress_index = command.index("--progress-path")
    assert command[progress_index + 1] == str((state_dir / "geo_search_repair_progress.json").resolve())
    assert result["attempted_rows"] == 1
    assert result["repaired_rows"] == 1


def test_manage_geocode_service_parser_defaults():
    args = manager.parse_args(["start"])

    assert args.action == "start"
    assert args.refresh_browser_corpus is True
    assert args.search_repair_enabled is True


def test_manage_geocode_service_command_respects_refresh_flag():
    command = manager.SERVICE.command(
        log_level="INFO",
        batch_size_new=180,
        batch_size_retry=60,
        min_delay_seconds=1.1,
        timeout_seconds=12.0,
        max_retries=2,
        sleep_seconds=30.0,
        idle_sleep_seconds=600.0,
        retry_zero_hit_threshold=8,
        search_repair_enabled=True,
        search_repair_max_rows=40,
        search_repair_results_per_query=5,
        search_repair_max_candidate_geocode_attempts=6,
        search_repair_timeout_seconds=180.0,
        search_repair_zero_hit_threshold=6,
        search_repair_engine=("brave", "duckduckgo"),
        search_repair_classification=("likely_provider_or_coverage_miss", "likely_malformed_input"),
        refresh_browser_corpus=False,
    )

    assert "--search-repair-enabled" in command
    assert "--no-refresh-browser-corpus" in command
    assert "--refresh-browser-corpus" not in command


def test_manage_geocode_service_status_mode_detection():
    running = {
        "wrapper_command": "python geocode_address_daemon.py --refresh-browser-corpus",
        "daemon_command": "python geocode_address_daemon.py --refresh-browser-corpus",
    }
    disabled = {
        "wrapper_command": "python geocode_address_daemon.py --no-refresh-browser-corpus",
        "daemon_command": "python geocode_address_daemon.py --no-refresh-browser-corpus",
    }

    assert manager._status_matches_requested_mode(running, refresh_browser_corpus=True)
    assert manager._status_matches_requested_mode(disabled, refresh_browser_corpus=False)
