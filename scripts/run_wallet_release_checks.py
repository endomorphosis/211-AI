#!/usr/bin/env python3
"""Run the local wallet release-check suite.

This script is intentionally a thin command orchestrator. It keeps the backend,
compile, UI build, and live full-stack browser checks in one repeatable entry
point without hiding the exact commands being run.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
UI_ROOT = REPO_ROOT / "wallet_interface" / "ui"

BACKEND_PYTEST_TARGETS = (
    "ipfs_datasets_py/tests/unit/test_data_wallet.py",
    "ipfs_datasets_py/tests/mcp/test_wallet_tools.py",
    "ipfs_datasets_py/tests/mcp/unit/test_hierarchical_tool_manager.py",
    "tests/test_wallet_interface_api.py",
    "tests/test_wallet_interface_ops.py",
    "tests/test_wallet_interface_deploy.py",
    "tests/test_wallet_implementation_plan_docs.py",
    "tests/test_wallet_release_check_runner.py",
    "tests/test_wallet_production_handoff_blackbox.py",
)


def release_pythonpath(repo_root: Path) -> str:
    """Return the PYTHONPATH needed for root tests plus the submodule package."""

    return os.pathsep.join([str(repo_root), str(repo_root / "ipfs_datasets_py")])


@dataclass(frozen=True)
class ReleaseCheckStep:
    """A single command in the wallet release-check suite."""

    name: str
    command: tuple[str, ...]
    cwd: Path = REPO_ROOT
    env: Mapping[str, str] = field(default_factory=dict)

    def manifest(self) -> dict[str, object]:
        return {
            "name": self.name,
            "cwd": str(self.cwd),
            "command": list(self.command),
            "env": dict(self.env),
        }


@dataclass(frozen=True)
class ReleaseCheckResult:
    """Aggregated result from a release-check run."""

    exit_code: int
    completed: tuple[str, ...]
    failed: str | None = None


Runner = Callable[..., subprocess.CompletedProcess[str]]


def build_release_check_steps(
    *,
    repo_root: Path = REPO_ROOT,
    playwright_port: str = "5185",
    skip_backend: bool = False,
    skip_compile: bool = False,
    skip_ui_build: bool = False,
    skip_fullstack: bool = False,
    include_smoke: bool = False,
) -> list[ReleaseCheckStep]:
    """Build the ordered local wallet release-check commands."""

    ui_root = repo_root / "wallet_interface" / "ui"
    steps: list[ReleaseCheckStep] = []
    minimal_import_env = {
        "PYTHONPATH": release_pythonpath(repo_root),
        "IPFS_DATASETS_AUTO_INSTALL": "false",
        "IPFS_AUTO_INSTALL": "false",
        "IPFS_DATASETS_PY_MINIMAL_IMPORTS": "1",
    }

    if not skip_backend:
        steps.append(
            ReleaseCheckStep(
                name="backend-wallet-pytest",
                command=(
                    sys.executable,
                    "-m",
                    "pytest",
                    *BACKEND_PYTEST_TARGETS,
                    "-q",
                ),
                cwd=repo_root,
                env=minimal_import_env,
            )
        )

    if not skip_compile:
        steps.append(
            ReleaseCheckStep(
                name="wallet-compileall",
                command=(
                    sys.executable,
                    "-m",
                    "compileall",
                    "-q",
                    "wallet_interface",
                    "ipfs_datasets_py/ipfs_datasets_py/wallet",
                ),
                cwd=repo_root,
            )
        )

    if not skip_ui_build:
        steps.append(
            ReleaseCheckStep(
                name="wallet-ui-build",
                command=("npm", "run", "build"),
                cwd=ui_root,
            )
        )

    if include_smoke:
        steps.append(
            ReleaseCheckStep(
                name="wallet-ui-smoke",
                command=("npm", "run", "test:smoke"),
                cwd=ui_root,
                env={"PLAYWRIGHT_PORT": playwright_port},
            )
        )

    if not skip_fullstack:
        steps.append(
            ReleaseCheckStep(
                name="wallet-ui-fullstack",
                command=("npm", "run", "test:fullstack"),
                cwd=ui_root,
                env={"PLAYWRIGHT_PORT": playwright_port},
            )
        )

    return steps


def run_release_check_steps(
    steps: Sequence[ReleaseCheckStep],
    *,
    keep_going: bool = False,
    runner: Runner = subprocess.run,
) -> ReleaseCheckResult:
    """Run release-check commands sequentially and stop on first failure by default."""

    completed: list[str] = []
    exit_code = 0
    failed: str | None = None

    for step in steps:
        print(f"==> {step.name}", flush=True)
        env = os.environ.copy()
        env.update(step.env)
        result = runner(
            list(step.command),
            cwd=str(step.cwd),
            env=env,
            text=True,
        )
        if result.returncode != 0:
            exit_code = result.returncode
            failed = step.name
            if not keep_going:
                break
        else:
            completed.append(step.name)

    return ReleaseCheckResult(
        exit_code=exit_code,
        completed=tuple(completed),
        failed=failed,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run local 211-AI wallet release checks.")
    parser.add_argument(
        "--playwright-port",
        default="5185",
        help="Port passed to wallet UI Playwright tests. Default: 5185.",
    )
    parser.add_argument("--skip-backend", action="store_true", help="Skip backend pytest checks.")
    parser.add_argument("--skip-compile", action="store_true", help="Skip compileall check.")
    parser.add_argument("--skip-ui-build", action="store_true", help="Skip wallet UI build.")
    parser.add_argument("--skip-fullstack", action="store_true", help="Skip live full-stack Playwright checks.")
    parser.add_argument(
        "--include-smoke",
        action="store_true",
        help="Also run the UI smoke suite before the full-stack browser checks.",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="Continue running later checks after a failure.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the command manifest without running checks.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    steps = build_release_check_steps(
        playwright_port=args.playwright_port,
        skip_backend=args.skip_backend,
        skip_compile=args.skip_compile,
        skip_ui_build=args.skip_ui_build,
        skip_fullstack=args.skip_fullstack,
        include_smoke=args.include_smoke,
    )
    if args.dry_run:
        print(json.dumps([step.manifest() for step in steps], indent=2, sort_keys=True))
        return 0
    return run_release_check_steps(steps, keep_going=args.keep_going).exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
