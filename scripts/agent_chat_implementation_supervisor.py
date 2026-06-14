from __future__ import annotations

import argparse
import logging
import os
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

from ipfs_datasets_py.optimizers.todo_daemon.implementation_supervisor import (
    TodoImplementationSupervisor,
    TodoSupervisorConfig,
)
from ipfs_datasets_py.optimizers.todo_daemon.implementation_daemon import (
    TodoTaskState,
    process_command_line,
    process_is_running,
    write_text_atomic,
)
from scraper.utils import setup_logging
from scripts.agent_chat_implementation_daemon import (
    AGENT_STATE_PREFIX,
    AGENT_TASK_PREFIX,
    DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS,
    DEFAULT_STATE_DIR,
    DEFAULT_TODO_PATH,
)

logger = logging.getLogger("scraper.agent_chat.implementation.supervisor")


def _supervisor_pid_path(state_dir: Path) -> Path:
    return state_dir / f"{AGENT_STATE_PREFIX}_supervisor.pid"


def _matching_live_supervisor_pid(pid_path: Path, *, state_dir: Path) -> int | None:
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
    return pid


def _claim_supervisor_pid_file(*, state_dir: Path) -> tuple[Path, bool]:
    pid_path = _supervisor_pid_path(state_dir)
    existing_pid = _matching_live_supervisor_pid(pid_path, state_dir=state_dir)
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


class AgentChatImplementationSupervisor(TodoImplementationSupervisor):
    """211-AI compatibility wrapper around the shared todo supervisor."""

    def is_stuck(
        self,
        state: TodoTaskState,
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
    parser = argparse.ArgumentParser(description="Supervise the AI agent chat implementation backlog daemon")
    parser.add_argument("--once", action="store_true", help="Run one supervisor check and exit")
    parser.add_argument(
        "--todo-path",
        type=Path,
        default=DEFAULT_TODO_PATH,
        help="Machine-readable markdown backlog",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=DEFAULT_STATE_DIR,
        help="Agent chat daemon state directory",
    )
    parser.add_argument("--stale-seconds", type=float, default=1800.0)
    parser.add_argument("--check-interval", type=float, default=60.0)
    parser.add_argument("--max-restarts", type=int, default=0)
    parser.add_argument("--daemon-interval", type=float, default=300.0)
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
        help="Only supervise backlog state; do not invoke the implementation agent",
    )
    parser.set_defaults(implement=True)
    parser.add_argument(
        "--implementation-command",
        default="",
        help="Command used for implementation. Defaults to codex exec with local Copilot CLI fallback when available.",
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


def build_supervisor(args: argparse.Namespace) -> TodoImplementationSupervisor:
    return AgentChatImplementationSupervisor(
        TodoSupervisorConfig(
            todo_path=args.todo_path,
            state_path=args.state_dir / f"{AGENT_STATE_PREFIX}_task_state.json",
            strategy_path=args.state_dir / f"{AGENT_STATE_PREFIX}_strategy.json",
            events_path=args.state_dir / f"{AGENT_STATE_PREFIX}_supervisor_events.jsonl",
            state_dir=args.state_dir,
            stale_seconds=args.stale_seconds,
            check_interval=args.check_interval,
            max_restarts=args.max_restarts,
            daemon_interval=args.daemon_interval,
            task_prefix=AGENT_TASK_PREFIX,
            state_prefix=AGENT_STATE_PREFIX,
            repo_root=REPO_ROOT,
            daemon_script_path=Path(__file__).resolve().parent / "agent_chat_implementation_daemon.py",
            implement=args.implement,
            implementation_command=args.implementation_command,
            implementation_timeout=args.implementation_timeout,
            use_ephemeral_worktree=args.implement and not args.no_ephemeral_worktree,
            worktree_root=args.worktree_root,
        )
    )


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    setup_logging(getattr(logging, args.log_level))
    supervisor = build_supervisor(args)
    if args.once:
        result = supervisor.run_once()
        logger.info("Agent chat implementation supervisor check complete: %s", result)
        return
    pid_path, claimed = _claim_supervisor_pid_file(state_dir=args.state_dir)
    if not claimed:
        logger.info("Agent chat implementation supervisor already running: pid file %s", pid_path)
        return
    try:
        supervisor.run_forever()
    finally:
        _release_supervisor_pid_file(pid_path)


if __name__ == "__main__":
    main()
