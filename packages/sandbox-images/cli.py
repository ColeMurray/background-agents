#!/usr/bin/env python3
"""Repository-local entrypoint; planning/packing requires only Python 3.12."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from sandbox_images.cli import main

if __name__ == "__main__":
    main()
