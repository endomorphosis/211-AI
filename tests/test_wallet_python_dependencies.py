from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).parent.parent


def test_wallet_python_dependency_installer_references_wallet_runtime() -> None:
    requirements = (REPO_ROOT / "requirements.txt").read_text(encoding="utf-8")
    installer = (REPO_ROOT / "scripts" / "install_wallet_python_dependencies.sh").read_text(encoding="utf-8")
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

    assert "fastapi>=0.110,<1.0" in requirements
    assert "uvicorn[standard]>=0.29,<1.0" in requirements
    assert "pydantic>=2.7,<3.0" in requirements
    assert "python-multipart>=0.0.9" in requirements

    assert "git submodule update --init --recursive ipfs_datasets_py" in installer
    assert 'python3 -m pip install -e "$SUBMODULE_PATH"' in installer
    assert "proofs and IPFS/Filecoin storage integrations" in installer

    assert "./scripts/install_wallet_python_dependencies.sh" in readme
    assert "zero-knowledge proof flows" in readme