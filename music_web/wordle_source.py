"""Fetch only the dated English puzzle requested by the household server."""
import json
import re
from http.client import HTTPException
from urllib.request import build_opener

from .catalog_search import NoRedirect


def published_answer(day):
    key = day.isoformat()
    url = f"https://www.nytimes.com/svc/wordle/v2/{key}.json"
    try:
        with build_opener(NoRedirect).open(url, timeout=4) as response:
            raw = response.read(8193)
        if len(raw) > 8192:
            return None
        payload = json.loads(raw)
    except (OSError, HTTPException, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("print_date") != key:
        return None
    answer = payload.get("solution")
    return answer if isinstance(answer, str) and re.fullmatch(r"[a-z]{5}", answer) else None
