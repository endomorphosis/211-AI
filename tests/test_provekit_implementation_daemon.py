from __future__ import annotations

import os
import sys
from pathlib import Path

from ipfs_datasets_py.optimizers.todo_daemon.implementation_daemon import TodoImplementationDaemon, TodoTaskState
from ipfs_datasets_py.optimizers.todo_daemon.implementation_supervisor import TodoImplementationSupervisor
from scripts.portal_implementation_daemon import PortalImplementationDaemon
from scripts.portal_implementation_supervisor import PortalImplementationSupervisor
from scripts.provekit_implementation_daemon import (
    DEFAULT_STATE_DIR,
    DEFAULT_TODO_PATH,
    PROVEKIT_STATE_PREFIX,
    PROVEKIT_TASK_PREFIX,
    ProveKitImplementationDaemon,
    main as daemon_main,
    parse_args as parse_daemon_args,
)
from scripts.provekit_implementation_supervisor import (
    ProveKitImplementationSupervisor,
    build_supervisor,
    parse_args as parse_supervisor_args,
)


def write_todo(path: Path) -> None:
    path.write_text(
        """
# Test ProveKit Todo

## PROVEKIT-000 Control Plane
- Status: todo
- Completion: artifact
- Priority: P0
- Track: ops
- Depends on: none
- Outputs: docs/control.md
- Validation: python -c "print('control-ok')"
- Acceptance: control plane exists

## PROVEKIT-010 Trace Schema
- Status: todo
- Completion: artifact
- Priority: P1
- Track: platform
- Depends on: PROVEKIT-000
- Outputs: src/trace.py
- Validation: python -c "print('trace-ok')"
- Acceptance: trace schema exists
""".strip()
        + "\n",
        encoding="utf-8",
    )


def test_provekit_wrappers_use_shared_todo_stack() -> None:
    assert issubclass(ProveKitImplementationDaemon, PortalImplementationDaemon)
    assert issubclass(ProveKitImplementationDaemon, TodoImplementationDaemon)
    assert issubclass(ProveKitImplementationSupervisor, PortalImplementationSupervisor)
    assert issubclass(ProveKitImplementationSupervisor, TodoImplementationSupervisor)


def test_provekit_default_paths_and_prefixes_are_stable() -> None:
    daemon_args = parse_daemon_args([])
    supervisor_args = parse_supervisor_args([])

    assert daemon_args.todo_path == DEFAULT_TODO_PATH
    assert daemon_args.state_dir == DEFAULT_STATE_DIR
    assert daemon_args.task_prefix == PROVEKIT_TASK_PREFIX
    assert daemon_args.state_prefix == PROVEKIT_STATE_PREFIX
    assert supervisor_args.todo_path == DEFAULT_TODO_PATH
    assert supervisor_args.state_dir == DEFAULT_STATE_DIR
    assert supervisor_args.task_prefix == PROVEKIT_TASK_PREFIX
    assert supervisor_args.state_prefix == PROVEKIT_STATE_PREFIX
    assert supervisor_args.implement is True


def test_provekit_supervisor_builds_autonomous_loop_config(tmp_path: Path) -> None:
    todo_path = tmp_path / "todo.md"
    state_dir = tmp_path / "state"
    write_todo(todo_path)

    supervisor = build_supervisor(
        parse_supervisor_args(
            [
                "--todo-path",
                str(todo_path),
                "--state-dir",
                str(state_dir),
                "--until-complete",
                "--implement",
                "--implementation-command",
                f"{sys.executable} fake_worker.py",
                "--no-ephemeral-worktree",
            ]
        )
    )
    loop_config = supervisor.build_supervisor_loop_config()

    assert loop_config.spec.task_board_path == todo_path
    assert loop_config.spec.child_pid_path == state_dir / f"{PROVEKIT_STATE_PREFIX}_managed_daemon.pid"
    assert Path(loop_config.command[1]).name == "provekit_implementation_daemon.py"
    assert "--implement" in loop_config.command
    assert "--no-ephemeral-worktree" in loop_config.command
    assert loop_config.status_static_fields["until_complete"] is True


def test_provekit_daemon_until_complete_drains_ready_backlog(tmp_path: Path, monkeypatch) -> None:
    repo_root = tmp_path / "repo"
    todo_path = repo_root / "todo.md"
    state_dir = tmp_path / "state"
    fake_worker = repo_root / "fake_worker.py"
    repo_root.mkdir(parents=True)
    write_todo(todo_path)
    fake_worker.write_text(
        """
from pathlib import Path
import sys

prompt = sys.stdin.read()
if "- ID: PROVEKIT-010" in prompt:
    Path("src").mkdir(exist_ok=True)
    Path("src/trace.py").write_text("TRACE = True\\n", encoding="utf-8")
elif "- ID: PROVEKIT-000" in prompt:
    Path("docs").mkdir(exist_ok=True)
    Path("docs/control.md").write_text("control\\n", encoding="utf-8")
else:
    raise SystemExit(f"unexpected task prompt: {prompt}")
""".strip()
        + "\n",
        encoding="utf-8",
    )
    pythonpath = os.pathsep.join(
        [
            str(Path.cwd() / "ipfs_datasets_py"),
            str(Path.cwd()),
            os.environ.get("PYTHONPATH", ""),
        ]
    )
    monkeypatch.setenv("PYTHONPATH", pythonpath)
    monkeypatch.setattr("scripts.provekit_implementation_daemon.REPO_ROOT", repo_root)

    daemon_main(
        [
            "--todo-path",
            str(todo_path),
            "--state-dir",
            str(state_dir),
            "--implement",
            "--implementation-command",
            f"{sys.executable} {fake_worker}",
            "--no-ephemeral-worktree",
            "--until-complete",
            "--interval",
            "0",
            "--max-passes",
            "5",
        ]
    )

    state = TodoTaskState.load(state_dir / f"{PROVEKIT_STATE_PREFIX}_task_state.json")
    todo_text = todo_path.read_text(encoding="utf-8")

    assert state.completed_count == 2
    assert state.completed_task_ids == ["PROVEKIT-000", "PROVEKIT-010"]
    assert "## PROVEKIT-000 Control Plane\n- Status: completed" in todo_text
    assert "## PROVEKIT-010 Trace Schema\n- Status: completed" in todo_text
    assert (repo_root / "docs" / "control.md").read_text(encoding="utf-8") == "control\n"
    assert (repo_root / "src" / "trace.py").read_text(encoding="utf-8") == "TRACE = True\n"
