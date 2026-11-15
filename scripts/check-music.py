#!/usr/bin/env python3
"""Run music checks with this interpreter and mandatory media tools."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
env = os.environ.copy()
local_bin = root / ".local/tools/ffmpeg/ffmpeg-9.0.2-essentials_build/bin"
if local_bin.is_dir():
    env["PATH"] = str(local_bin) + os.pathsep + env.get("PATH", "")
missing = [name for name in ("ffmpeg", "ffprobe") if not shutil.which(name, path=env.get("PATH"))]
if missing:
    sys.exit("Required media tools missing: " + ", ".join(missing))
sys.exit(subprocess.call([sys.executable, "-m", "unittest", "discover", "-s", "tests",
                          "-p", "test_music*.py", "-q"], cwd=root, env=env))
