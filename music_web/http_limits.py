"""Enforce endpoint body limits before Waitress buffers requests."""
from copy import copy

from waitress.channel import HTTPChannel
from waitress.parser import HTTPRequestParser
from waitress.server import create_server
from .feedback import FEEDBACK_BODY_LIMIT


SMALL_BODY_LIMIT = 1 << 20


def body_limit(method, path):
    if (method, path) == ('POST', '/api/server/restart-notice'):
        return 256
    if (method, path) in (('POST', '/api/uploads'), ('PUT', '/api/files/upload')):
        return None
    return FEEDBACK_BODY_LIMIT if (method, path) == ('POST', '/api/feedback') else SMALL_BODY_LIMIT


class BodyLimitedParser(HTTPRequestParser):
    def parse_header(self, header_plus):
        super().parse_header(header_plus)
        limit = body_limit(self.command, self.path)
        if limit is None and (not self.content_length or self.chunked):
            limit = SMALL_BODY_LIMIT
        if limit is not None:
            self.adj = copy(self.adj)
            self.adj.max_request_body_size = min(self.adj.max_request_body_size, limit + 1)


class BodyLimitedChannel(HTTPChannel):
    parser_class = BodyLimitedParser


def body_limited_server(app, **options):
    server = create_server(app, **options)
    server.channel_class = BodyLimitedChannel
    return server
