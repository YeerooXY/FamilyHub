"""Run the app with waitress on loopback only: python -m music_web."""
import logging

from waitress import serve

from . import MAX_UPLOAD, create_app

logging.basicConfig()
logging.getLogger("music_web.resources").setLevel(logging.INFO)

# A TLS reverse proxy (Tailscale Serve) publishes this loopback port; the app itself never listens publicly.
# Several phones load covers, lists and audio at once; 4 threads queued 90+ requests in one burst.
serve(create_app(), host="127.0.0.1", port=8765, threads=12, connection_limit=200, max_request_body_size=MAX_UPLOAD + (2 << 20))
