"""Run the app with waitress on loopback only: python -m music_web."""
from waitress import serve

from . import MAX_UPLOAD, create_app

# A TLS reverse proxy (Tailscale Serve) publishes this loopback port; the app itself never listens publicly.
serve(create_app(), host="127.0.0.1", port=8765, threads=4, max_request_body_size=MAX_UPLOAD + (2 << 20))
