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

from scraper.utils import setup_logging  # noqa: E402
from scripts.portal_implementation_supervisor import (  # noqa: E402
    PortalImplementationSupervisor,
    PortalSupervisorConfig,
    process_command_line,
    process_is_running,
    write_text_atomic,
)
from scripts.provekit_implementation_daemon import (  # noqa: E402
    DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS,
    DEFAULT_STATE_DIR,
    DEFAULT_TODO_PATH,
    PROVEKIT_STATE_PREFIX,
    PROVEKIT_TASK_PREFIX,
)

logger = logging.getLogger("scraper.provekit.implementation.supervisor")


class ProveKitImplementationSupervisor(PortalImplementationSupervisor):
    """ProveKit-specific supervisor wrapper around the shared todo supervisor."""


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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Supervise the ProveKit ZKP implementation backlog daemon")
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
        help="ProveKit daemon state directory",
    )
    parser.add_argument("--stale-seconds", type=float, default=1800.0)
    parser.add_argument("--check-interval", type=float, default=60.0)
    parser.add_argument("--max-restarts", type=int, default=0)
    parser.add_argument("--daemon-interval", type=float, default=300.0)
    parser.add_argument(
        "--until-complete",
        action="store_true",
        help="Supervise the daemon until every parsed ProveKit todo task is completed, then stop",
    )
    parser.add_argument(
        "--task-prefix",
        default=PROVEKIT_TASK_PREFIX,
        help="Markdown heading prefix for tasks, for example '## PROVEKIT-'",
    )
    parser.add_argument(
        "--state-prefix",
        default=PROVEKIT_STATE_PREFIX,
        help="State file prefix inside --state-dir",
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


def build_supervisor(args: argparse.Namespace) -> ProveKitImplementationSupervisor:
    return ProveKitImplementationSupervisor(
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
            until_complete=args.until_complete,
            task_prefix=args.task_prefix,
            state_prefix=args.state_prefix,
            repo_root=REPO_ROOT,
            daemon_script_path=Path(__file__).resolve().parent / "provekit_implementation_daemon.py",
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
        logger.info("ProveKit implementation supervisor check complete: %s", result)
        return
    pid_path, claimed = _claim_supervisor_pid_file(state_dir=args.state_dir, state_prefix=args.state_prefix)
    if not claimed:
        logger.info("ProveKit implementation supervisor already running: pid file %s", pid_path)
        return
    try:
        supervisor.run_forever()
    finally:
        _release_supervisor_pid_file(pid_path)


if __name__ == "__main__":
    main()
