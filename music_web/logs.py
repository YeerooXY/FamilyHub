"""One logger for the whole server: levelled lines on stderr (the systemd journal on the server).

Levels: DEBUG, INFO, OK (an action finished as intended), WARN, ERROR, CRITICAL. Each line reads
`HH:MM:SS  LEVEL  source  message`. Colour is on for a terminal, or when FAMILYHUB_LOG_COLOR=1 (view the journal with
`journalctl -f`); NO_COLOR turns it off. A bad value never stops the server from logging.
"""
import logging
import os
import sys
import time

OK = 25
logging.addLevelName(OK, "OK")
logging.addLevelName(logging.WARNING, "WARN")

_COLOURS = {
    logging.DEBUG: "90", logging.INFO: "36", OK: "32;1", logging.WARNING: "33;1",
    logging.ERROR: "31;1", logging.CRITICAL: "97;41;1",
}
_WIDTH = 8


def ok(self, message, *args, **kwargs):
    """logger.ok(...): something finished as intended."""
    if self.isEnabledFor(OK):
        self._log(OK, message, args, **kwargs)


logging.Logger.ok = ok


class LevelFormatter(logging.Formatter):
    def __init__(self, colour=False):
        super().__init__()
        self.colour = colour

    def format(self, record):
        stamp = time.strftime("%H:%M:%S", time.localtime(record.created))
        level = record.levelname
        source = record.name.removeprefix("music_web.") if record.name != "music_web" else "app"
        if self.colour:
            level = f"\x1b[{_COLOURS.get(record.levelno, '0')}m{level:<{_WIDTH}}\x1b[0m"
            if record.levelno >= logging.WARNING:
                message = f"\x1b[{_COLOURS[record.levelno].split(';')[0]}m{record.getMessage()}\x1b[0m"
            else:
                message = record.getMessage()
            head = f"\x1b[90m{stamp}\x1b[0m  {level}  \x1b[35m{source}\x1b[0m  "
        else:
            level = f"{level:<{_WIDTH}}"
            message = record.getMessage()
            head = f"{stamp}  {level}  {source}  "
        text = head + message
        if record.exc_info:
            text += "\n" + self.formatException(record.exc_info)
        return text


def wants_colour(stream, environ=None):
    environ = os.environ if environ is None else environ
    if environ.get("NO_COLOR"):
        return False
    if environ.get("FAMILYHUB_LOG_COLOR") == "1":
        return True
    try:
        return bool(stream.isatty())
    except Exception:
        return False


def configure(level=None, stream=None, environ=None):
    """Replace the root handler with the levelled one. Safe to call twice."""
    environ = os.environ if environ is None else environ
    stream = stream or sys.stderr
    name = (level or environ.get("FAMILYHUB_LOG_LEVEL") or "INFO").upper()
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_familyhub", False):
            root.removeHandler(handler)
    handler = logging.StreamHandler(stream)
    handler._familyhub = True
    handler.setFormatter(LevelFormatter(wants_colour(stream, environ)))
    root.addHandler(handler)
    root.setLevel(getattr(logging, name, logging.INFO))
    return handler
