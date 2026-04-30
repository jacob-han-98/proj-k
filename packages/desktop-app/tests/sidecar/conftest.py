"""pytest fixtures for sidecar tests.

Adds packages/desktop-app/src/sidecar to sys.path so `from server import app`
works without installing the package.
"""

import sys
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parents[2] / "src" / "sidecar"
sys.path.insert(0, str(SIDECAR_DIR))
