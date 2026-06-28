"""Repo-root compatibility surface for optional ``ipfs_accelerate_py`` imports."""

from __future__ import annotations

import importlib
from typing import Any

_HF_SPACE_EXPORTS = {
    "HFSpaceClient",
    "OutputBackend",
    "LocalFileSystemBackend",
    "HFBucketBackend",
    "BatchProcessor",
    "BatchState",
    "EndpointContract",
    "SpaceRuntimeInfo",
}

_LAZY_MODULES = {"hf_space_inference", "llm_router"}

__all__ = [
    # Modules
    "llm_router",
    "hf_space_inference",
    # Generic HF Space inference provider
    "HFSpaceClient",
    "OutputBackend",
    "LocalFileSystemBackend",
    "HFBucketBackend",
    "BatchProcessor",
    "BatchState",
    "EndpointContract",
    "SpaceRuntimeInfo",
]


def _load_hf_space_inference() -> Any:
    module = importlib.import_module(f"{__name__}.hf_space_inference")
    globals()["hf_space_inference"] = module
    for export in _HF_SPACE_EXPORTS:
        globals()[export] = getattr(module, export)
    return module


def __getattr__(name: str) -> Any:
    if name == "hf_space_inference":
        return _load_hf_space_inference()
    if name == "llm_router":
        module = importlib.import_module(f"{__name__}.llm_router")
        globals()[name] = module
        return module
    if name in _HF_SPACE_EXPORTS:
        _load_hf_space_inference()
        return globals()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__) | _LAZY_MODULES | _HF_SPACE_EXPORTS)
