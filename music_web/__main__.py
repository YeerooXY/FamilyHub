"""Run the app with waitress on loopback only: python -m music_web."""
import logging
import signal

from waitress import serve

from . import logs

from . import create_app
from .http_dispatch import RequestDispatcher
from .http_limits import body_limited_server

logs.configure()
logging.getLogger("music_web.resources").setLevel(logging.INFO)

# A TLS reverse proxy (Tailscale Serve) publishes this loopback port; the app itself never listens publicly.
app = create_app()
state = app.extensions["music"]
dispatcher = RequestDispatcher(app.config["WAITRESS_THREADS"])
state.resources.interactive_queued = dispatcher.interactive_queued


def terminate(_signum, _frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, terminate)
logging.getLogger("music_web").ok("server listening on 127.0.0.1:8765")
try:
    serve(app, host="127.0.0.1", port=8765, _dispatcher=dispatcher, _server=body_limited_server,
          connection_limit=200, max_request_body_size=app.config["MAX_CONTENT_LENGTH"] + (1 << 20))
finally:
    dispatcher.shutdown()
    state.close_state()
