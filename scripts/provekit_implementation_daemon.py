from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IPFS_DATASETS_ROOT = REPO_ROOT / "ipfs_datasets_py"
for import_root in (IPFS_DATASETS_ROOT, REPO_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))
os.environ.setdefault("IPFS_DATASETS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_AUTO_INSTALL", "false")
os.environ.setdefault("IPFS_DATASETS_PY_MINIMAL_IMPORTS", "1")

from ipfs_datasets_py.optimizers.todo_daemon.implementation_daemon import (  # noqa: E402
    DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS,
    TodoTask,
)
from scraper.utils import setup_logging  # noqa: E402
from scripts.portal_implementation_daemon import PortalImplementationDaemon  # noqa: E402

logger = logging.getLogger("scraper.provekit.implementation.daemon")

PROVEKIT_TASK_PREFIX = "## PROVEKIT-"
PROVEKIT_STATE_PREFIX = "provekit"
DEFAULT_TODO_PATH = Path("docs/PROVEKIT_ZKP_LOGIC_TODO.md")
DEFAULT_STATE_DIR = Path("data/provekit_implementation/state")
DEFAULT_PLAN_PATH = Path("docs/PROVEKIT_ZKP_LOGIC_IMPLEMENTATION_PLAN.md")


class ProveKitImplementationDaemon(PortalImplementationDaemon):
    """ProveKit-specific wrapper for the shared todo implementation daemon."""

    def _build_implementation_prompt(self, task: TodoTask, attempt: int) -> str:
        return f"""You are an autonomous implementation agent working in this repository.

Implement exactly this ProveKit ZKP backlog task and keep changes scoped.

Task:
- ID: {task.task_id}
- Title: {task.title}
- Priority: {task.priority}
- Track: {task.track}
- Attempt: {attempt}
- Todo file: {self.todo_path}
- Source line: {task.source_line}
- Depends on: {", ".join(task.depends_on) or "none"}
- Expected outputs: {", ".join(task.outputs) or "none listed"}
- Validation commands: {"; ".join(task.validation) or "none listed"}
- Acceptance: {task.acceptance or "none listed"}

Primary plan document:
- {DEFAULT_PLAN_PATH}

Rules:
- Read the ProveKit plan, this task, and nearby logic/zkp code before editing.
- Do not revert unrelated local changes.
- Prefer existing ipfs_datasets_py logic, zkp, deontic, and todo-daemon patterns.
- Preserve fail-closed ZKP behavior, deterministic public inputs, and no-leak witness boundaries.
- Implement the expected outputs for this task.
- Run the listed validation commands when practical.
- The daemon will run the listed validation commands and will only commit and merge the worktree if they pass.
- Do not mark the backlog task completed manually unless the task explicitly asks for TODO metadata changes.
- Final response should list changed files and validation results.
"""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the ProveKit ZKP implementation backlog daemon")
    parser.add_argument("--once", action="store_true", help="Run one backlog pass and exit")
    parser.add_argument(
        "--until-complete",
        action="store_true",
        help="Run backlog passes until every parsed task is completed, then exit",
    )
    parser.add_argument(
        "--max-passes",
        type=int,
        default=0,
        help="Maximum backlog passes before exiting; 0 disables the limit",
    )
    parser.add_argument("--interval", type=float, default=300.0, help="Seconds between backlog passes")
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
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity",
    )
    parser.add_argument(
        "--no-implement",
        action="store_true",
        help="Only update backlog state; do not invoke the implementation agent",
    )
    parser.add_argument(
        "--implement",
        action="store_true",
        help="Invoke the configured implementation agent for the selected ready task",
    )
    parser.add_argument(
        "--implementation-command",
        default="",
        help="Command used for implementation. Defaults to codex exec --full-auto.",
    )
    parser.add_argument("--implementation-timeout", type=float, default=DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS)
    parser.add_argument(
        "--no-ephemeral-worktree",
        action="store_true",
        help="Run the implementation agent in the main checkout instead of an isolated temporary git worktree",
    )
    parser.add_argument(
        "--worktree-root",
        type=Path,
        default=None,
        help="Directory for temporary implementation worktrees",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    setup_logging(getattr(logging, args.log_level))
    implement = bool(args.implement and not args.no_implement)
    daemon = ProveKitImplementationDaemon(
        todo_path=args.todo_path,
        state_path=args.state_dir / f"{args.state_prefix}_task_state.json",
        strategy_path=args.state_dir / f"{args.state_prefix}_strategy.json",
        events_path=args.state_dir / f"{args.state_prefix}_events.jsonl",
        repo_root=REPO_ROOT,
        task_header_prefix=args.task_prefix,
        implement=implement,
        implementation_command=args.implementation_command or None,
        implementation_timeout=args.implementation_timeout,
        use_ephemeral_worktree=implement and not args.no_ephemeral_worktree,
        worktree_root=args.worktree_root,
    )
    passes = 0
    while True:
        result = daemon.run_once()
        passes += 1
        logger.info("ProveKit implementation daemon pass complete: %s", result)
        if args.until_complete and int(result.get("completed_count") or 0) >= int(result.get("task_count") or 0):
            logger.info("ProveKit implementation daemon backlog complete after %s pass(es)", passes)
            break
        if args.once:
            break
        if args.max_passes > 0 and passes >= args.max_passes:
            logger.info("ProveKit implementation daemon reached max passes: %s", args.max_passes)
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
