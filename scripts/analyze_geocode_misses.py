from __future__ import annotations

import argparse
import json
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

from scraper.enrich_service_addresses import (  # noqa: E402
    DEFAULT_CACHE_PATH,
    DEFAULT_PORTAL_DIR,
    build_geocode_miss_diagnostics_report,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Classify cached geocode misses into malformed, normalization-damage, and likely provider-miss buckets")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_PORTAL_DIR)
    parser.add_argument("--cache-path", type=Path, default=DEFAULT_CACHE_PATH)
    parser.add_argument("--output-json", type=Path, default=None)
    parser.add_argument("--output-parquet", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output_json = args.output_json or (args.source_dir / "geocode_miss_diagnostics.json")
    output_parquet = args.output_parquet or (args.source_dir / "geocode_miss_diagnostics.parquet")
    report = build_geocode_miss_diagnostics_report(
        cache_path=args.cache_path,
        output_json_path=output_json,
        output_parquet_path=output_parquet,
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
