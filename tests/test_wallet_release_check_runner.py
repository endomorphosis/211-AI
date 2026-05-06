from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "run_wallet_release_checks.py"
MODULE_SPEC = importlib.util.spec_from_file_location("wallet_release_check_runner", MODULE_PATH)
assert MODULE_SPEC is not None
assert MODULE_SPEC.loader is not None
release_checks = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = release_checks
MODULE_SPEC.loader.exec_module(release_checks)

BACKEND_PYTEST_TARGETS = release_checks.BACKEND_PYTEST_TARGETS
build_release_check_steps = release_checks.build_release_check_steps
main = release_checks.main
release_pythonpath = release_checks.release_pythonpath
run_release_check_steps = release_checks.run_release_check_steps


def test_build_release_check_steps_matches_documented_wallet_release_gate() -> None:
    steps = build_release_check_steps(playwright_port="5199")

    assert [step.name for step in steps] == [
        "backend-wallet-pytest",
        "wallet-compileall",
        "wallet-ui-build",
        "wallet-ui-fullstack",
    ]
    backend = steps[0]
    assert backend.command[:3] == (sys.executable, "-m", "pytest")
    for target in BACKEND_PYTEST_TARGETS:
        assert target in backend.command
    pythonpath = backend.env["PYTHONPATH"].split(os.pathsep)
    assert pythonpath[0].endswith("211-AI")
    assert pythonpath[1].endswith("ipfs_datasets_py")
    assert backend.env["IPFS_DATASETS_PY_MINIMAL_IMPORTS"] == "1"

    compile_step = steps[1]
    assert compile_step.command == (
        sys.executable,
        "-m",
        "compileall",
        "-q",
        "wallet_interface",
        "ipfs_datasets_py/ipfs_datasets_py/wallet",
    )

    assert steps[2].command == ("npm", "run", "build")
    assert steps[3].command == ("npm", "run", "test:fullstack")
    assert steps[3].env["PLAYWRIGHT_PORT"] == "5199"


def test_build_release_check_steps_can_include_smoke_before_fullstack() -> None:
    steps = build_release_check_steps(include_smoke=True, playwright_port="5201")

    assert [step.name for step in steps][-2:] == ["wallet-ui-smoke", "wallet-ui-fullstack"]
    assert steps[-2].env["PLAYWRIGHT_PORT"] == "5201"
    assert steps[-1].env["PLAYWRIGHT_PORT"] == "5201"


def test_run_release_check_steps_stops_on_first_failure(tmp_path: Path) -> None:
    steps = build_release_check_steps(
        repo_root=tmp_path,
        skip_compile=True,
        skip_ui_build=True,
        skip_fullstack=True,
    )
    calls: list[list[str]] = []

    def fake_runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, returncode=7)

    result = run_release_check_steps(steps, runner=fake_runner)

    assert result.exit_code == 7
    assert result.completed == ()
    assert result.failed == "backend-wallet-pytest"
    assert len(calls) == 1


def test_run_release_check_steps_can_keep_going_after_failure(tmp_path: Path) -> None:
    steps = build_release_check_steps(
        repo_root=tmp_path,
        skip_ui_build=True,
        skip_fullstack=True,
    )
    calls: list[list[str]] = []

    def fake_runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, returncode=5 if len(calls) == 1 else 0)

    result = run_release_check_steps(steps, keep_going=True, runner=fake_runner)

    assert result.exit_code == 5
    assert result.completed == ("wallet-compileall",)
    assert result.failed == "backend-wallet-pytest"
    assert len(calls) == 2


def test_release_check_runner_dry_run_prints_command_manifest(capsys) -> None:
    exit_code = main(["--dry-run", "--skip-fullstack", "--playwright-port", "5203"])

    output = capsys.readouterr().out
    manifest = json.loads(output)
    assert exit_code == 0
    assert [step["name"] for step in manifest] == [
        "backend-wallet-pytest",
        "wallet-compileall",
        "wallet-ui-build",
    ]
    assert manifest[0]["env"]["IPFS_AUTO_INSTALL"] == "false"
    assert manifest[0]["env"]["PYTHONPATH"] == release_pythonpath(Path(__file__).parents[1])
