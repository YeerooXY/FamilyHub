"""Bound status reads independently of worker locks and slow disks."""
from collections import OrderedDict
from functools import wraps
import json
import threading
import time

from flask import copy_current_request_context, current_app, g, jsonify, make_response, request


def bounded_snapshot(view):
    entries = OrderedDict()
    lock = threading.Lock()
    slots = threading.BoundedSemaphore(2)

    def response(snapshot, at):
        body, status, headers = snapshot
        if status == 200:
            data = json.loads(body)
            data['snapshot_age_seconds'] = int(time.monotonic() - at)
            return jsonify(data)
        return body, status, headers

    @wraps(view)
    def read(*args, **kwargs):
        key = (g.user, request.full_path)
        with lock:
            entry = entries.get(key)
            if entry is None:
                if len(entries) >= 64:
                    victim = next((k for k, v in entries.items() if v['ready'].is_set()), None)
                    if victim is None:
                        return jsonify(error="Server work is busy. Retry shortly."), 503
                    del entries[victim]
                entry = entries[key] = dict(response=None, at=0, checked_at=0, ready=threading.Event())
                start = True
            else:
                start = entry['ready'].is_set() and time.monotonic() - entry['checked_at'] >= 1
            if start and slots.acquire(blocking=False):
                entry['ready'].clear()
                user = g.user

                @copy_current_request_context
                def refresh():
                    g.user = user
                    try:
                        response = view(*args, **kwargs)
                    except Exception as error:
                        try:
                            response = current_app.handle_user_exception(error)
                        except Exception:
                            current_app.logger.exception("Server work snapshot failed")
                            response = (jsonify(error="Could not load server work. Retry shortly."), 503)
                    try:
                        response = make_response(response)
                        # A response object acquires session headers after this function returns.
                        snapshot = (response.get_data(), response.status_code, list(response.headers))
                        with lock:
                            entry['checked_at'] = time.monotonic()
                            cached = entry['response']
                            if cached is None or cached[1] != 200 or not 500 <= snapshot[1] < 600:
                                entry.update(response=snapshot, at=entry['checked_at'])
                    finally:
                        entry['ready'].set()
                        slots.release()

                threading.Thread(target=refresh, name="server-work-snapshot", daemon=True).start()
            elif start:
                entry['ready'].set()
            cached = entry['response']
            at = entry['at']
        if cached is not None:
            return response(cached, at)
        if entry['ready'].wait(.2):
            with lock:
                if entry['response'] is not None:
                    return response(entry['response'], entry['at'])
        return jsonify(error="Server work did not respond in time. Retry shortly."), 503, {'Retry-After': '1'}

    return read
