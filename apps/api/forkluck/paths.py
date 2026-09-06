"""Filesystem anchors that hold in a checkout and in a deployed release.

In the repository this package lives at ``apps/api/forkluck``; in a release it
lives at ``backend/forkluck``. Both trees carry ``data/`` at their root, so the
root is found by walking up rather than by counting parents.
"""

from pathlib import Path


def _find_root() -> Path:
    for ancestor in Path(__file__).resolve().parents:
        if (ancestor / "data" / "parser-vocabulary.json").is_file():
            return ancestor
    raise RuntimeError("data/parser-vocabulary.json not found above forkluck/paths.py")


ROOT = _find_root()
DATA_DIR = ROOT / "data"
API_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = ROOT / "apps" / "web"
