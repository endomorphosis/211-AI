from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IPFS_DATASETS_ROOT = REPO_ROOT / "ipfs_datasets_py"
for import_root in (IPFS_DATASETS_ROOT, REPO_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))
os.environ.setdefault("IPFS_DATASETS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_DATASETS_PY_MINIMAL_IMPORTS", "1")

from ipfs_datasets_py.optimizers.todo_daemon.implementation_daemon import (
    DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS,
    DEFAULT_TRACKS,
    TASK_HEADER_PREFIX,
    TodoTaskState as PortalTaskState,
    load_json_dict,
    process_command_line,
    process_is_running,
    utc_now,
    write_json_atomic,
    write_text_atomic,
)
from ipfs_datasets_py.optimizers.todo_daemon.implementation_supervisor import (
    AdoptedManagedDaemonProcess,
    TodoImplementationSupervisor,
    TodoSupervisorConfig as PortalSupervisorConfig,
)
from scraper.utils import setup_logging

logger = logging.getLogger("scraper.portal.implementation.supervisor")


def _supervisor_pid_path(state_dir: Path, state_prefix: str) -> Path:
    return state_dir / f"{state_prefix}_supervisor.pid"


def _matching_live_supervisor_pid(
    pid_path: Path,
    *,
    state_dir: Path,
    state_prefix: str,
) -> int | None:
    if not pid_path.exists():
        return None
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        pid_path.unlink(missing_ok=True)
        return None
    if not process_is_running(pid):
        pid_path.unlink(missing_ok=True)
        return None
    command_line = process_command_line(pid)
    required_fragments = (
        Path(__file__).name,
        "--state-dir",
        str(state_dir),
    )
    if not all(fragment in command_line for fragment in required_fragments):
        pid_path.unlink(missing_ok=True)
        return None
    if state_prefix and f"{state_prefix}_supervisor.pid" not in pid_path.name:
        return None
    return pid


def _claim_supervisor_pid_file(*, state_dir: Path, state_prefix: str) -> tuple[Path, bool]:
    pid_path = _supervisor_pid_path(state_dir, state_prefix)
    existing_pid = _matching_live_supervisor_pid(pid_path, state_dir=state_dir, state_prefix=state_prefix)
    current_pid = os.getpid()
    if existing_pid is not None and existing_pid != current_pid:
        return pid_path, False
    write_text_atomic(pid_path, f"{current_pid}\n")
    return pid_path, True


def _release_supervisor_pid_file(pid_path: Path) -> None:
    try:
        current = pid_path.read_text(encoding="utf-8").strip()
    except OSError:
        return
    if current == str(os.getpid()):
        pid_path.unlink(missing_ok=True)


class PortalImplementationSupervisor(TodoImplementationSupervisor):
    """211-AI compatibility wrapper around the shared todo supervisor."""

    def __init__(self, config: PortalSupervisorConfig) -> None:
        if config.repo_root == Path.cwd():
            config.repo_root = REPO_ROOT
        if config.daemon_script_path is None:
            config.daemon_script_path = Path(__file__).resolve().parent / "portal_implementation_daemon.py"
        super().__init__(config)

    def _adopt_existing_daemon(self) -> AdoptedManagedDaemonProcess | None:
        pid_path = self._managed_daemon_pid_path()
        if not pid_path.exists():
            return None
        try:
            pid = int(pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            try:
                pid_path.unlink()
            except OSError:
                pass
            return None
        if not process_is_running(pid):
            try:
                pid_path.unlink()
            except OSError:
                pass
            return None
        command_line = process_command_line(pid)
        if not self._managed_daemon_matches_command_line(command_line):
            try:
                pid_path.unlink()
            except OSError:
                pass
            return None
        return AdoptedManagedDaemonProcess(pid)

    def is_stuck(
        self,
        state: PortalTaskState,
        *,
        now_ts: float,
        ignore_progress_until_ts: float | None = None,
    ) -> tuple[bool, str]:
        if self._implementation_attempt_is_active(state, now_ts=now_ts):
            return False, ""
        heartbeat_age = self._age_seconds(state.heartbeat_at, now_ts)
        progress_age = self._age_seconds(state.last_progress_at, now_ts)
        stale = self.config.stale_seconds
        if state.active_task_id and heartbeat_age > stale:
            return True, f"heartbeat stale for active task {state.active_task_id}"
        startup_grace_seconds = max(5.0, float(self.config.check_interval) * 2.0)
        if state.active_task_id and heartbeat_age <= startup_grace_seconds:
            return False, ""
        if ignore_progress_until_ts is not None and now_ts < ignore_progress_until_ts:
            return False, ""
        if state.active_task_id and state.ready_count > 0 and progress_age > stale:
            return True, f"no progress on active task {state.active_task_id}"
        return False, ""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Supervise the portal implementation backlog daemon")
    parser.add_argument("--once", action="store_true", help="Run one supervisor check and exit")
    parser.add_argument(
        "--todo-path",
        type=Path,
        default=Path("docs/211_SERVICE_NAVIGATION_PORTAL_TODO.md"),
        help="Machine-readable markdown backlog",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path("data/portal_implementation/state"),
        help="Portal daemon state directory",
    )
    parser.add_argument("--stale-seconds", type=float, default=1800.0)
    parser.add_argument("--check-interval", type=float, default=60.0)
    parser.add_argument("--max-restarts", type=int, default=0)
    parser.add_argument("--daemon-interval", type=float, default=300.0)
    parser.add_argument(
        "--task-prefix",
        default=TASK_HEADER_PREFIX,
        help="Markdown heading prefix for tasks, for example '## PORTAL-' or '## AGENT-'",
    )
    parser.add_argument(
        "--state-prefix",
        default="portal",
        help="State file prefix inside --state-dir",
    )
    parser.add_argument(
        "--allowed-tracks",
        action="append",
        default=[],
        help="Comma-separated task tracks this supervisor may select; repeatable. Defaults to all tracks.",
    )
    parser.add_argument(
        "--allowed-task-ids",
        action="append",
        default=[],
        help="Comma-separated task IDs this supervisor may select; repeatable. Defaults to all task IDs.",
    )
    implement_group = parser.add_mutually_exclusive_group()
    implement_group.add_argument(
        "--implement",
        dest="implement",
        action="store_true",
        help="Allow the managed daemon to invoke the implementation agent",
    )
    implement_group.add_argument(
        "--no-implement",
        dest="implement",
        action="store_false",
        help="Only supervise backlog state; do not let the managed daemon invoke the implementation agent",
    )
    parser.set_defaults(implement=True)
    parser.add_argument(
        "--implementation-command",
        default="",
        help="Command used by the daemon for implementation. Defaults to codex exec with local Copilot CLI fallback when available.",
    )
    parser.add_argument("--implementation-timeout", type=float, default=DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS)
    parser.add_argument(
        "--no-ephemeral-worktree",
        action="store_true",
        help="Run implementation commands in the main checkout instead of isolated temporary git worktrees",
    )
    parser.add_argument(
        "--worktree-root",
        type=Path,
        default=None,
        help="Directory for temporary implementation worktrees",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity",
    )
    return parser.parse_args(argv)


def build_supervisor(args: argparse.Namespace) -> PortalImplementationSupervisor:
    return PortalImplementationSupervisor(
        PortalSupervisorConfig(
            todo_path=args.todo_path,
            state_path=args.state_dir / f"{args.state_prefix}_task_state.json",
            strategy_path=args.state_dir / f"{args.state_prefix}_strategy.json",
            events_path=args.state_dir / f"{args.state_prefix}_supervisor_events.jsonl",
            state_dir=args.state_dir,
            stale_seconds=args.stale_seconds,
            check_interval=args.check_interval,
            max_restarts=args.max_restarts,
            daemon_interval=args.daemon_interval,
            task_prefix=args.task_prefix,
            state_prefix=args.state_prefix,
            repo_root=REPO_ROOT,
            daemon_script_path=Path(__file__).resolve().parent / "portal_implementation_daemon.py",
            implement=args.implement,
            implementation_command=args.implementation_command,
            implementation_timeout=args.implementation_timeout,
            use_ephemeral_worktree=args.implement and not args.no_ephemeral_worktree,
            worktree_root=args.worktree_root,
            allowed_tracks=tuple(
                item.strip().lower()
                for value in args.allowed_tracks
                for item in value.split(",")
                if item.strip()
            ),
            allowed_task_ids=tuple(
                item.strip().lower()
                for value in args.allowed_task_ids
                for item in value.split(",")
                if item.strip()
            ),
        )
    )


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    setup_logging(getattr(logging, args.log_level))
    supervisor = build_supervisor(args)
    if args.once:
        result = supervisor.run_once()
        logger.info("Portal implementation supervisor check complete: %s", result)
        return
    pid_path, claimed = _claim_supervisor_pid_file(state_dir=args.state_dir, state_prefix=args.state_prefix)
    if not claimed:
        logger.info("Portal implementation supervisor already running: pid file %s", pid_path)
        return
    try:
        supervisor.run_forever()
    finally:
        _release_supervisor_pid_file(pid_path)


if __name__ == "__main__":
    main()
