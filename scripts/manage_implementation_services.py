from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
IPFS_DATASETS_ROOT = REPO_ROOT / "ipfs_datasets_py"
for import_root in (IPFS_DATASETS_ROOT, REPO_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))
os.environ.setdefault("IPFS_DATASETS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_DATASETS_PY_MINIMAL_IMPORTS", "1")

from ipfs_datasets_py.optimizers.todo_daemon.core import iter_processes, pid_alive, process_args, read_json, read_pid_file, terminate_pid_tree
from ipfs_datasets_py.optimizers.todo_daemon.wrapper import launch_restarting_wrapper


@dataclass(frozen=True)
class ServiceSpec:
    name: str
    supervisor_script: Path
    daemon_script: Path
    state_dir: Path
    state_prefix: str
    supervisor_args: tuple[str, ...] = ()

    @property
    def wrapper_pid_path(self) -> Path:
        return self.state_dir / f"{self.state_prefix}_service_wrapper.pid"

    @property
    def wrapper_out_path(self) -> Path:
        return self.state_dir / f"{self.state_prefix}_service_wrapper.out"

    @property
    def supervisor_pid_path(self) -> Path:
        return self.state_dir / f"{self.state_prefix}_supervisor.pid"

    @property
    def supervisor_status_path(self) -> Path:
        return self.state_dir / f"{self.state_prefix}_supervisor_status.json"

    @property
    def managed_daemon_pid_path(self) -> Path:
        return self.state_dir / f"{self.state_prefix}_managed_daemon.pid"

    @property
    def task_state_path(self) -> Path:
        return self.state_dir / f"{self.state_prefix}_task_state.json"

    @property
    def state_dir_arg(self) -> str:
        for index, value in enumerate(self.supervisor_args):
            if value == "--state-dir" and index + 1 < len(self.supervisor_args):
                return self.supervisor_args[index + 1]
        return str(self.state_dir)

    def command(
        self,
        *,
        log_level: str,
        check_interval: float,
        daemon_interval: float,
        implement: bool,
        implementation_command: str,
        implementation_timeout: float,
        use_ephemeral_worktree: bool,
    ) -> tuple[str, ...]:
        command = [
            sys.executable,
            str(self.supervisor_script),
            *self.supervisor_args,
            "--log-level",
            log_level,
            "--max-restarts",
            "0",
            "--check-interval",
            str(check_interval),
            "--daemon-interval",
            str(daemon_interval),
        ]
        if implement:
            command.append("--implement")
            if implementation_command:
                command.extend(["--implementation-command", implementation_command])
            command.extend(["--implementation-timeout", str(implementation_timeout)])
            if not use_ephemeral_worktree:
                command.append("--no-ephemeral-worktree")
        else:
            command.append("--no-implement")
        return tuple(command)


SERVICES = {
    "portal": ServiceSpec(
        name="portal",
        supervisor_script=REPO_ROOT / "scripts" / "portal_implementation_supervisor.py",
        daemon_script=REPO_ROOT / "scripts" / "portal_implementation_daemon.py",
        state_dir=REPO_ROOT / "data" / "portal_implementation" / "state",
        state_prefix="portal",
        supervisor_args=(
            "--state-dir",
            "data/portal_implementation/state",
            "--state-prefix",
            "portal",
        ),
    ),
    "agent": ServiceSpec(
        name="agent",
        supervisor_script=REPO_ROOT / "scripts" / "agent_chat_implementation_supervisor.py",
        daemon_script=REPO_ROOT / "scripts" / "agent_chat_implementation_daemon.py",
        state_dir=REPO_ROOT / "data" / "agent_chat_implementation" / "state",
        state_prefix="agent_chat",
        supervisor_args=(
            "--state-dir",
            "data/agent_chat_implementation/state",
        ),
    ),
    "graphrag": ServiceSpec(
        name="graphrag",
        supervisor_script=REPO_ROOT / "scripts" / "portland_graphrag_implementation_supervisor.py",
        daemon_script=REPO_ROOT / "scripts" / "portland_graphrag_implementation_daemon.py",
        state_dir=REPO_ROOT / "data" / "portland_graphrag_implementation" / "state",
        state_prefix="portland_graphrag",
        supervisor_args=(
            "--state-dir",
            "data/portland_graphrag_implementation/state",
            "--state-prefix",
            "portland_graphrag",
        ),
    ),
    "wallet": ServiceSpec(
        name="wallet",
        supervisor_script=REPO_ROOT / "scripts" / "wallet_implementation_supervisor.py",
        daemon_script=REPO_ROOT / "scripts" / "wallet_implementation_daemon.py",
        state_dir=REPO_ROOT / "data" / "wallet_implementation" / "state",
        state_prefix="wallet",
        supervisor_args=(
            "--state-dir",
            "data/wallet_implementation/state",
            "--state-prefix",
            "wallet",
        ),
    ),
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage long-running implementation supervisor services")
    parser.add_argument("action", choices=("status", "start", "stop", "restart"))
    parser.add_argument("service", choices=("portal", "agent", "graphrag", "wallet", "all"), default="all", nargs="?")
    parser.add_argument("--log-level", default="INFO", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    parser.add_argument("--check-interval", type=float, default=60.0)
    parser.add_argument("--daemon-interval", type=float, default=300.0)
    parser.add_argument("--restart-delay", type=int, default=5)
    parser.add_argument("--startup-wait", type=float, default=2.0)
    implement_group = parser.add_mutually_exclusive_group()
    implement_group.add_argument(
        "--implement",
        dest="implement",
        action="store_true",
        help="Allow managed daemons to invoke implementation commands. This is the default.",
    )
    implement_group.add_argument(
        "--no-implement",
        dest="implement",
        action="store_false",
        help="Only monitor daemon state; do not invoke implementation commands.",
    )
    parser.set_defaults(implement=True)
    parser.add_argument(
        "--implementation-command",
        default="",
        help="Implementation command passed to supervised daemons unless --no-implement is set.",
    )
    parser.add_argument("--implementation-timeout", type=float, default=1800.0)
    parser.add_argument(
        "--no-ephemeral-worktree",
        action="store_true",
        help="Run implementation commands in the main checkout when --implement is set.",
    )
    return parser.parse_args(argv)


def _selected_services(name: str) -> list[ServiceSpec]:
    if name == "all":
        return [SERVICES["portal"], SERVICES["agent"], SERVICES["graphrag"], SERVICES["wallet"]]
    return [SERVICES[name]]


def _unique_pids(items: list[int]) -> list[int]:
    return list(dict.fromkeys(pid for pid in items if pid > 0))


def _process_matches(args: str, fragments: tuple[str, ...]) -> bool:
    return all(fragment and fragment in args for fragment in fragments)


def _command_has_flag(command: str, flag: str) -> bool:
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    return flag in tokens


def _matching_wrapper_pids(spec: ServiceSpec) -> list[int]:
    pids: list[int] = []
    required_fragments = ("bash -lc while true; do", str(spec.supervisor_script), "--state-dir", spec.state_dir_arg)
    for candidate_pid, args in iter_processes():
        if _process_matches(args, required_fragments):
            pids.append(candidate_pid)
    return _unique_pids(pids)


def _matching_supervisor_pids(spec: ServiceSpec) -> list[int]:
    pids: list[int] = []
    required_fragments = (str(spec.supervisor_script), "--state-dir", spec.state_dir_arg)
    for candidate_pid, args in iter_processes():
        if "while true; do" in args:
            continue
        if _process_matches(args, required_fragments):
            pids.append(candidate_pid)
    return _unique_pids(pids)


def _matching_daemon_pids(spec: ServiceSpec) -> list[int]:
    pids: list[int] = []
    required_fragments = (str(spec.daemon_script), "--state-dir", spec.state_dir_arg)
    for candidate_pid, args in iter_processes():
        if _process_matches(args, required_fragments):
            pids.append(candidate_pid)
    return _unique_pids(pids)


def _wrapper_pid(spec: ServiceSpec) -> int | None:
    pid = read_pid_file(spec.wrapper_pid_path)
    if pid and pid_alive(pid):
        return pid
    spec.wrapper_pid_path.unlink(missing_ok=True)
    matches = _matching_wrapper_pids(spec)
    if matches:
        spec.wrapper_pid_path.write_text(f"{matches[0]}\n", encoding="utf-8")
        return matches[0]
    return None


def _supervisor_pid(spec: ServiceSpec) -> int | None:
    pid = read_pid_file(spec.supervisor_pid_path)
    if pid and pid_alive(pid):
        return pid
    payload = read_json(spec.supervisor_status_path)
    candidate = payload.get("supervisor_pid")
    if candidate and pid_alive(candidate):
        return int(candidate)
    matches = _matching_supervisor_pids(spec)
    if matches:
        spec.supervisor_pid_path.write_text(f"{matches[0]}\n", encoding="utf-8")
        return matches[0]
    spec.supervisor_pid_path.unlink(missing_ok=True)
    return None


def _daemon_pid(spec: ServiceSpec) -> int | None:
    pid = read_pid_file(spec.managed_daemon_pid_path)
    if pid and pid_alive(pid):
        return pid
    matches = _matching_daemon_pids(spec)
    if matches:
        spec.managed_daemon_pid_path.write_text(f"{matches[0]}\n", encoding="utf-8")
        return matches[0]
    return None


def _state_summary(spec: ServiceSpec) -> dict[str, Any]:
    payload = read_json(spec.task_state_path)
    return {
        "active_task_id": payload.get("active_task_id"),
        "active_attempt": payload.get("active_attempt"),
        "active_phase": payload.get("active_phase"),
        "active_phase_started_at": payload.get("active_phase_started_at"),
        "active_phase_detail": payload.get("active_phase_detail"),
        "active_log_path": payload.get("active_log_path"),
        "active_worktree_path": payload.get("active_worktree_path"),
        "active_branch": payload.get("active_branch"),
        "completed_count": payload.get("completed_count"),
        "implementation_in_progress": payload.get("implementation_in_progress"),
        "ready_count": payload.get("ready_count"),
        "waiting_count": payload.get("waiting_count"),
        "blocked_count": payload.get("blocked_count"),
        "heartbeat_at": payload.get("heartbeat_at"),
        "last_progress_at": payload.get("last_progress_at"),
    }


def service_status(spec: ServiceSpec) -> dict[str, Any]:
    wrapper_pid = _wrapper_pid(spec)
    supervisor_pid = _supervisor_pid(spec)
    daemon_pid = _daemon_pid(spec)
    wrapper_command = process_args(wrapper_pid) if wrapper_pid else ""
    daemon_command = process_args(daemon_pid) if daemon_pid else ""
    supervisor_status = read_json(spec.supervisor_status_path)
    supervisor_status_value = supervisor_status.get("status") if supervisor_pid else "stopped"
    return {
        "service": spec.name,
        "wrapper_pid": wrapper_pid,
        "wrapper_pid_alive": bool(wrapper_pid),
        "wrapper_command": wrapper_command,
        "supervisor_pid": supervisor_pid,
        "supervisor_pid_alive": bool(supervisor_pid),
        "daemon_pid": daemon_pid,
        "daemon_pid_alive": bool(daemon_pid),
        "daemon_command": daemon_command,
        "implementation_enabled": _command_has_flag(wrapper_command, "--implement")
        and _command_has_flag(daemon_command, "--implement"),
        "ephemeral_worktree_enabled": not _command_has_flag(wrapper_command, "--no-ephemeral-worktree")
        and not _command_has_flag(daemon_command, "--no-ephemeral-worktree"),
        "supervisor_status": supervisor_status_value,
        "wrapper_pid_count": len(_matching_wrapper_pids(spec)),
        "supervisor_pid_count": len(_matching_supervisor_pids(spec)),
        "daemon_pid_count": len(_matching_daemon_pids(spec)),
        "state": _state_summary(spec),
    }


def _status_matches_requested_mode(
    status: dict[str, Any],
    *,
    implement: bool,
    use_ephemeral_worktree: bool,
) -> bool:
    wrapper_command = str(status.get("wrapper_command") or "")
    daemon_command = str(status.get("daemon_command") or "")
    if implement:
        if not _command_has_flag(wrapper_command, "--implement"):
            return False
        if not _command_has_flag(daemon_command, "--implement"):
            return False
        if use_ephemeral_worktree and (
            _command_has_flag(wrapper_command, "--no-ephemeral-worktree")
            or _command_has_flag(daemon_command, "--no-ephemeral-worktree")
        ):
            return False
        return True
    return _command_has_flag(wrapper_command, "--no-implement") and not _command_has_flag(daemon_command, "--implement")


def start_service(
    spec: ServiceSpec,
    *,
    log_level: str,
    check_interval: float,
    daemon_interval: float,
    restart_delay: int,
    startup_wait: float,
    implement: bool,
    implementation_command: str,
    implementation_timeout: float,
    use_ephemeral_worktree: bool,
) -> dict[str, Any]:
    spec.state_dir.mkdir(parents=True, exist_ok=True)
    status = service_status(spec)
    if status["wrapper_pid_alive"]:
        if _status_matches_requested_mode(
            status,
            implement=implement,
            use_ephemeral_worktree=use_ephemeral_worktree,
        ):
            return {"service": spec.name, "action": "start", "result": "already_running", "status": status}
        stop_service(spec, restart_wait_seconds=max(0.0, float(restart_delay) + 1.0))
    if status["supervisor_pid_alive"]:
        if _status_matches_requested_mode(
            status,
            implement=implement,
            use_ephemeral_worktree=use_ephemeral_worktree,
        ):
            return {"service": spec.name, "action": "start", "result": "already_running_unwrapped", "status": status}
        stop_service(spec, restart_wait_seconds=max(0.0, float(restart_delay) + 1.0))
    for stale_path in (
        spec.wrapper_pid_path,
        spec.supervisor_pid_path,
        spec.managed_daemon_pid_path,
    ):
        stale_path.unlink(missing_ok=True)
    launch = launch_restarting_wrapper(
        repo_root=REPO_ROOT,
        command=spec.command(
            log_level=log_level,
            check_interval=check_interval,
            daemon_interval=daemon_interval,
            implement=implement,
            implementation_command=implementation_command,
            implementation_timeout=implementation_timeout,
            use_ephemeral_worktree=use_ephemeral_worktree,
        ),
        out_path=spec.wrapper_out_path,
        pid_path=spec.wrapper_pid_path,
        launch_mode="nohup_loop",
        restart_delay_seconds=restart_delay,
        restart_message=f"{spec.name} implementation supervisor exited with code",
    )
    deadline = time.monotonic() + max(0.0, startup_wait)
    while time.monotonic() < deadline:
        current = service_status(spec)
        if current["wrapper_pid_alive"] or current["supervisor_pid_alive"]:
            break
        time.sleep(0.2)
    return {
        "service": spec.name,
        "action": "start",
        "result": "started",
        "implementation_enabled": implement,
        "launcher_mode": launch.mode,
        "launcher_pid": launch.pid,
        "status": service_status(spec),
    }


def _stop_pid(kind: str, pid: int) -> dict[str, Any]:
    was_alive = pid_alive(pid)
    terminated = terminate_pid_tree(pid, grace_seconds=10.0) if was_alive else False
    return {
        "kind": kind,
        "pid": pid,
        "was_alive": was_alive,
        "terminated": terminated,
        "stopped": not pid_alive(pid),
    }


def _service_pid_groups(spec: ServiceSpec) -> tuple[tuple[str, list[int]], ...]:
    return (
        ("wrapper", [pid for pid in [read_pid_file(spec.wrapper_pid_path)] if pid] + _matching_wrapper_pids(spec)),
        ("supervisor", [pid for pid in [read_pid_file(spec.supervisor_pid_path)] if pid] + _matching_supervisor_pids(spec)),
        ("daemon", [pid for pid in [read_pid_file(spec.managed_daemon_pid_path)] if pid] + _matching_daemon_pids(spec)),
    )


def _clear_pid_files(spec: ServiceSpec) -> None:
    for path in (
        spec.wrapper_pid_path,
        spec.supervisor_pid_path,
        spec.managed_daemon_pid_path,
    ):
        path.unlink(missing_ok=True)


def stop_service(
    spec: ServiceSpec,
    *,
    restart_wait_seconds: float = 0.0,
    poll_seconds: float = 0.5,
) -> dict[str, Any]:
    stopped: list[dict[str, Any]] = []
    deadline = time.monotonic() + max(0.0, float(restart_wait_seconds))
    saw_process = False
    while True:
        found = False
        for kind, pids in _service_pid_groups(spec):
            unique = _unique_pids(pids)
            found = found or bool(unique)
            saw_process = saw_process or bool(unique)
            for pid in unique:
                stopped.append(_stop_pid(kind, pid))
        _clear_pid_files(spec)
        if time.monotonic() >= deadline or not saw_process:
            break
        sleep_for = min(max(0.05, float(poll_seconds)), max(0.0, deadline - time.monotonic()))
        if sleep_for <= 0:
            break
        time.sleep(sleep_for)
    return {"service": spec.name, "action": "stop", "stopped": stopped, "status": service_status(spec)}


def restart_service(
    spec: ServiceSpec,
    *,
    log_level: str,
    check_interval: float,
    daemon_interval: float,
    restart_delay: int,
    startup_wait: float,
    implement: bool,
    implementation_command: str,
    implementation_timeout: float,
    use_ephemeral_worktree: bool,
) -> dict[str, Any]:
    return {
        "service": spec.name,
        "action": "restart",
        "stop": stop_service(spec, restart_wait_seconds=max(0.0, float(restart_delay) + 1.0)),
        "start": start_service(
            spec,
            log_level=log_level,
            check_interval=check_interval,
            daemon_interval=daemon_interval,
            restart_delay=restart_delay,
            startup_wait=startup_wait,
            implement=implement,
            implementation_command=implementation_command,
            implementation_timeout=implementation_timeout,
            use_ephemeral_worktree=use_ephemeral_worktree,
        ),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    results: list[dict[str, Any]] = []
    for spec in _selected_services(args.service):
        if args.action == "status":
            results.append(service_status(spec))
        elif args.action == "start":
            results.append(
                start_service(
                    spec,
                    log_level=args.log_level,
                    check_interval=args.check_interval,
                    daemon_interval=args.daemon_interval,
                    restart_delay=args.restart_delay,
                    startup_wait=args.startup_wait,
                    implement=args.implement,
                    implementation_command=args.implementation_command,
                    implementation_timeout=args.implementation_timeout,
                    use_ephemeral_worktree=not args.no_ephemeral_worktree,
                )
            )
        elif args.action == "stop":
            results.append(stop_service(spec, restart_wait_seconds=max(0.0, float(args.restart_delay) + 1.0)))
        elif args.action == "restart":
            results.append(
                restart_service(
                    spec,
                    log_level=args.log_level,
                    check_interval=args.check_interval,
                    daemon_interval=args.daemon_interval,
                    restart_delay=args.restart_delay,
                    startup_wait=args.startup_wait,
                    implement=args.implement,
                    implementation_command=args.implementation_command,
                    implementation_timeout=args.implementation_timeout,
                    use_ephemeral_worktree=not args.no_ephemeral_worktree,
                )
            )
    print(json.dumps(results, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
