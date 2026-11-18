"""Thresholds shared by automatic catalogue review decisions."""
import math

MATCH_DURATION_SECONDS = 3
MUSICBRAINZ_MIN_SCORE = 90
DEFAULT_AUTO_RESOLUTIONS_PER_HOUR = 30


def close_duration(expected, actual):
    return (all(type(value) in (int, float) and math.isfinite(value) and value > 0
                for value in (expected, actual))
            and abs(expected - actual) <= MATCH_DURATION_SECONDS)
