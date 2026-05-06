from __future__ import annotations

from pathlib import Path

from scripts import agent_chat_implementation_daemon as agent_daemon
from scripts import agent_chat_implementation_supervisor as agent_supervisor
from scripts import manage_implementation_services as manager
from scripts import portal_implementation_supervisor as portal_supervisor
from scripts import portland_graphrag_implementation_supervisor as graphrag_supervisor
from scripts import wallet_implementation_supervisor as wallet_supervisor


def test_service_command_can_run_monitor_only_mode():
    spec = manager.SERVICES["portal"]

    command = spec.command(
        log_level="INFO",
        check_interval=60.0,
        daemon_interval=300.0,
        implement=False,
        implementation_command="",
        implementation_timeout=1800.0,
        use_ephemeral_worktree=True,
    )

    assert "--no-implement" in command
    assert "--implementation-command" not in command


def test_service_command_requires_explicit_implementation_mode():
    spec = manager.SERVICES["agent"]

    command = spec.command(
        log_level="DEBUG",
        check_interval=5.0,
        daemon_interval=10.0,
        implement=True,
        implementation_command="python fake_worker.py",
        implementation_timeout=12.5,
        use_ephemeral_worktree=False,
    )

    assert "--no-implement" not in command
    assert "--implement" in command
    assert command[command.index("--implementation-command") + 1] == "python fake_worker.py"
    assert command[command.index("--implementation-timeout") + 1] == "12.5"
    assert "--no-ephemeral-worktree" in command


def test_parser_defaults_to_implementation_mode():
    args = manager.parse_args(["start", "agent"])

    assert args.implement is True


def test_restart_parser_defaults_to_implementation_mode():
    args = manager.parse_args(["restart", "all"])

    assert args.implement is True


def test_parser_accepts_explicit_implementation_mode():
    args = manager.parse_args(["start", "agent", "--implement"])

    assert args.implement is True


def test_parser_accepts_explicit_monitor_only_mode():
    args = manager.parse_args(["start", "agent", "--no-implement"])

    assert args.implement is False


def test_parser_accepts_graphrag_service():
    args = manager.parse_args(["status", "graphrag"])

    assert args.service == "graphrag"


def test_parser_accepts_wallet_service():
    args = manager.parse_args(["status", "wallet"])

    assert args.service == "wallet"


def test_all_service_selection_includes_graphrag_and_wallet():
    services = manager._selected_services("all")

    assert [service.name for service in services] == ["portal", "agent", "graphrag", "wallet"]


def test_status_mode_detects_requested_implementation_mode():
    implementation_status = {
        "wrapper_command": "python supervisor.py --implement --implementation-timeout 1800.0",
        "daemon_command": "python daemon.py --implement --implementation-timeout 1800.0",
    }
    missing_wrapper_flag_status = {
        "wrapper_command": "python supervisor.py --implementation-timeout 1800.0",
        "daemon_command": "python daemon.py --implement --implementation-timeout 1800.0",
    }
    monitor_only_status = {
        "wrapper_command": "python supervisor.py --no-implement",
        "daemon_command": "python daemon.py",
    }

    assert manager._status_matches_requested_mode(
        implementation_status,
        implement=True,
        use_ephemeral_worktree=True,
    )
    assert not manager._status_matches_requested_mode(
        missing_wrapper_flag_status,
        implement=True,
        use_ephemeral_worktree=True,
    )
    assert not manager._status_matches_requested_mode(
        monitor_only_status,
        implement=True,
        use_ephemeral_worktree=True,
    )
    assert manager._status_matches_requested_mode(
        monitor_only_status,
        implement=False,
        use_ephemeral_worktree=True,
    )


def test_supervisor_entrypoints_default_to_monitor_only_mode():
    for module in (
        portal_supervisor,
        agent_supervisor,
        graphrag_supervisor,
        wallet_supervisor,
    ):
        assert module.parse_args(["--once"]).implement is False
        assert module.parse_args(["--once", "--implement"]).implement is True


def test_agent_daemon_requires_explicit_implementation_flag(tmp_path, monkeypatch):
    captured: list[dict[str, object]] = []

    class FakeDaemon:
        def __init__(self, **kwargs: object) -> None:
            captured.append(kwargs)

        def run_once(self) -> dict[str, object]:
            return {"ok": True}

    monkeypatch.setattr(agent_daemon, "TodoImplementationDaemon", FakeDaemon)

    agent_daemon.main(["--once", "--todo-path", str(tmp_path / "todo.md"), "--state-dir", str(tmp_path)])

    assert captured[-1]["implement"] is False
    assert captured[-1]["use_ephemeral_worktree"] is False

    agent_daemon.main(
        [
            "--once",
            "--todo-path",
            str(tmp_path / "todo.md"),
            "--state-dir",
            str(tmp_path),
            "--implement",
        ]
    )

    assert captured[-1]["implement"] is True
    assert captured[-1]["use_ephemeral_worktree"] is True


def test_stop_service_discovers_and_stops_matching_process_families(tmp_path, monkeypatch):
    spec = manager.ServiceSpec(
        name="test",
        supervisor_script=Path("/repo/scripts/portal_implementation_supervisor.py"),
        daemon_script=Path("/repo/scripts/portal_implementation_daemon.py"),
        state_dir=tmp_path / "state",
        state_prefix="portal",
        supervisor_args=("--state-dir", "data/test/state", "--state-prefix", "portal"),
    )
    spec.state_dir.mkdir(parents=True)
    processes = {
        101: "bash -lc while true; do /repo/scripts/portal_implementation_supervisor.py --state-dir data/test/state; done",
        102: "python /repo/scripts/portal_implementation_supervisor.py --state-dir data/test/state --state-prefix portal",
        103: "python /repo/scripts/portal_implementation_daemon.py --interval 300 --state-dir data/test/state",
    }
    live_pids = set(processes)
    stopped: list[int] = []

    def fake_iter_processes():
        for pid in sorted(live_pids):
            yield pid, processes[pid]

    def fake_terminate(pid: int, *, grace_seconds: float) -> bool:
        stopped.append(pid)
        live_pids.discard(pid)
        return True

    monkeypatch.setattr(manager, "iter_processes", fake_iter_processes)
    monkeypatch.setattr(manager, "pid_alive", lambda pid: int(pid) in live_pids)
    monkeypatch.setattr(manager, "process_args", lambda pid: processes.get(int(pid), ""))
    monkeypatch.setattr(manager, "terminate_pid_tree", fake_terminate)

    result = manager.stop_service(spec)

    assert stopped == [101, 102, 103]
    assert result["status"]["wrapper_pid_alive"] is False
    assert result["status"]["supervisor_pid_alive"] is False
    assert result["status"]["daemon_pid_alive"] is False


def test_stop_service_rechecks_for_restarting_wrapper(tmp_path, monkeypatch):
    spec = manager.ServiceSpec(
        name="test",
        supervisor_script=Path("/repo/scripts/portal_implementation_supervisor.py"),
        daemon_script=Path("/repo/scripts/portal_implementation_daemon.py"),
        state_dir=tmp_path / "state",
        state_prefix="portal",
        supervisor_args=("--state-dir", "data/test/state", "--state-prefix", "portal"),
    )
    spec.state_dir.mkdir(parents=True)
    live_pids = {101, 201}
    stopped: list[int] = []
    wrapper_checks = {"count": 0}

    def fake_matching_wrapper_pids(_spec: manager.ServiceSpec) -> list[int]:
        wrapper_checks["count"] += 1
        if wrapper_checks["count"] == 1:
            return [101]
        if wrapper_checks["count"] == 2:
            return [201]
        return []

    def fake_terminate(pid: int, *, grace_seconds: float) -> bool:
        stopped.append(pid)
        live_pids.discard(pid)
        return True

    monkeypatch.setattr(manager, "_matching_wrapper_pids", fake_matching_wrapper_pids)
    monkeypatch.setattr(manager, "_matching_supervisor_pids", lambda _spec: [])
    monkeypatch.setattr(manager, "_matching_daemon_pids", lambda _spec: [])
    monkeypatch.setattr(manager, "pid_alive", lambda pid: int(pid) in live_pids)
    monkeypatch.setattr(manager, "process_args", lambda pid: "")
    monkeypatch.setattr(manager, "terminate_pid_tree", fake_terminate)

    result = manager.stop_service(spec, restart_wait_seconds=0.05, poll_seconds=0.01)

    assert stopped == [101, 201]
    assert result["status"]["wrapper_pid_alive"] is False
