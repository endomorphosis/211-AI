"""Pytest configuration for repo-local wallet tests."""

from __future__ import annotations

import importlib.util
from pathlib import Path


_COMPAT_PATH = Path(__file__).with_name("wallet_testclient_compat.py")
_COMPAT_SPEC = importlib.util.spec_from_file_location("wallet_testclient_compat", _COMPAT_PATH)
assert _COMPAT_SPEC is not None
assert _COMPAT_SPEC.loader is not None
_COMPAT_MODULE = importlib.util.module_from_spec(_COMPAT_SPEC)
_COMPAT_SPEC.loader.exec_module(_COMPAT_MODULE)


def pytest_configure() -> None:
    _COMPAT_MODULE._patch_starlette_testclient()
