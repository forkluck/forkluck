#!/usr/bin/env python3
"""Run one shard of the Django suite.

Usage: backend-test-shard.py SHARD TOTAL [manage.py test options]

Test modules are dealt to shards by size, largest first, so two runners finish
at about the same time. Run from the repository root; the venv under apps/api
must exist.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "apps" / "api"


def main() -> None:
    shard, total = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= shard <= total:
        raise SystemExit("SHARD must be between 1 and TOTAL")
    modules = sorted(
        (API / "forkluck").glob("test_*.py"),
        key=lambda path: (-path.stat().st_size, path.name),
    )
    buckets: list[list[str]] = [[] for _ in range(total)]
    sizes = [0] * total
    for module in modules:
        index = sizes.index(min(sizes))
        buckets[index].append(f"forkluck.{module.stem}")
        sizes[index] += module.stat().st_size
    labels = buckets[shard - 1]
    print(f"shard {shard}/{total}: {len(labels)} modules", flush=True)
    os.chdir(API)
    python = str(API / ".venv" / "bin" / "python")
    os.execv(python, [python, "manage.py", "test", "--parallel=auto", *sys.argv[3:], *labels])


if __name__ == "__main__":
    main()
