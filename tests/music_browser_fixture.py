"""Render authenticated markup and synthetic HLS for the browser harness, without a service."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from music_web import create_app

root = Path(__file__).resolve().parents[1]
out = root / ".local" / "music-browser"
out.mkdir(parents=True, exist_ok=True)
app = create_app({"SECRET_KEY": "browser-fixture-" * 4, "CLI_PATH": str(root / "scripts/music-intake.py"),
    "WORKSPACE": str(out), "LIBRARY": str(out), "PUBLIC_ORIGIN": "https://music.test",
    "ALLOWED_USERS": [], "PLAYER_URL": "https://player.test"})
with app.test_request_context("/", base_url="https://music.test"):
    from flask import render_template
    (out / "index.html").write_text(render_template("index.html", player_url="https://player.test",
        user="browser-test", profile_name="Browser test"), encoding="utf-8")
    (out / "login.html").write_text(render_template("login.html", username="yeeroo"), encoding="utf-8")
if not (out / "hls").exists():
    source = out / "tone.flac"
    app.intake.run([app.intake.tool("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=40", str(source)], 30, "fixture")
    item = app.intake.cmd_stage(type("Args", (), {"workspace": str(out), "file": str(source)})())
    app.intake.cmd_preview(type("Args", (), {"item": item["item"], "output": str(out / "hls")})())
