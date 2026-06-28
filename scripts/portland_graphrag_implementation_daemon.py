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

from scraper.utils import setup_logging
from scripts.portal_implementation_daemon import (
    DEFAULT_IMPLEMENTATION_TIMEOUT_SECONDS,
    PortalImplementationDaemon,
)

logger = logging.getLogger("scraper.portland_graphrag.implementation.daemon")

GRAPHRAG_TASK_PREFIX = "## GRAPHRAG-"
GRAPHRAG_STATE_PREFIX = "portland_graphrag"
DEFAULT_TODO_PATH = Path("docs/PORTLAND_LAWS_WEBGPU_GRAPHRAG_PORT_TODO.md")
DEFAULT_STATE_DIR = Path("data/portland_graphrag_implementation/state")


class PortlandGraphRagImplementationDaemon(PortalImplementationDaemon):
    """Thin repo-local wrapper for the shared todo implementation daemon."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Portland GraphRAG implementation backlog daemon")
    parser.add_argument("--once", action="store_true", help="Run one backlog pass and exit")
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
        help="Portland GraphRAG daemon state directory",
    )
    parser.add_argument(
        "--task-prefix",
        default=GRAPHRAG_TASK_PREFIX,
        help="Markdown heading prefix for tasks, for example '## GRAPHRAG-'",
    )
    parser.add_argument(
        "--state-prefix",
        default=GRAPHRAG_STATE_PREFIX,
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
    daemon = PortlandGraphRagImplementationDaemon(
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
    while True:
        result = daemon.run_once()
        logger.info("Portland GraphRAG implementation daemon pass complete: %s", result)
        if args.once:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
