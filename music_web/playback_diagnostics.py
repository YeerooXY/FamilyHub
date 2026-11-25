"""Short-lived playback timings keyed by random client action IDs."""
import logging
import re
import threading
import time
from collections import OrderedDict

log = logging.getLogger("music_web.playback")

CLIENT_STAGES = frozenset({
    "kept_download", "cache_hit", "cache_miss",
    "play", "ready", "playing", "position_advanced", "stream_failed", "fallback", "failed", "cancelled",
    "fallback_ready", "fallback_playing", "fallback_position_advanced", "next_stream_failed",
})

NATIVE_STAGES = frozenset({
    "background", "foreground", "early_end", "native_ended", "buffering", "native_buffering",
    "buffer_recovered", "native_ready", "unexpected_pause", "native_paused", "native_suppressed",
    "player_error", "native_error", "interrupted", "resume_seek", "resume_applied", "resume_failed",
    "screen_off", "screen_on", "next_warmup_start", "next_warmup_finish", "next_warmup_failed",
})

# AndroidX Media3 1.8 PlaybackException names. Never retain free-form player or network errors.
MEDIA3_ERRORS = frozenset("ERROR_CODE_" + name for name in """
    INVALID_STATE BAD_VALUE PERMISSION_DENIED NOT_SUPPORTED DISCONNECTED AUTHENTICATION_EXPIRED
    PREMIUM_ACCOUNT_REQUIRED CONCURRENT_STREAM_LIMIT PARENTAL_CONTROL_RESTRICTED NOT_AVAILABLE_IN_REGION
    SKIP_LIMIT_REACHED SETUP_REQUIRED END_OF_PLAYLIST CONTENT_ALREADY_PLAYING UNSPECIFIED REMOTE_ERROR
    BEHIND_LIVE_WINDOW TIMEOUT FAILED_RUNTIME_CHECK IO_UNSPECIFIED IO_NETWORK_CONNECTION_FAILED
    IO_NETWORK_CONNECTION_TIMEOUT IO_INVALID_HTTP_CONTENT_TYPE IO_BAD_HTTP_STATUS IO_FILE_NOT_FOUND
    IO_NO_PERMISSION IO_CLEARTEXT_NOT_PERMITTED IO_READ_POSITION_OUT_OF_RANGE PARSING_CONTAINER_MALFORMED
    PARSING_MANIFEST_MALFORMED PARSING_CONTAINER_UNSUPPORTED PARSING_MANIFEST_UNSUPPORTED
    DECODER_INIT_FAILED DECODER_QUERY_FAILED DECODING_FAILED DECODING_FORMAT_EXCEEDS_CAPABILITIES
    DECODING_FORMAT_UNSUPPORTED DECODING_RESOURCES_RECLAIMED AUDIO_TRACK_INIT_FAILED
    AUDIO_TRACK_WRITE_FAILED AUDIO_TRACK_OFFLOAD_INIT_FAILED AUDIO_TRACK_OFFLOAD_WRITE_FAILED
    DRM_UNSPECIFIED DRM_SCHEME_UNSUPPORTED DRM_PROVISIONING_FAILED DRM_CONTENT_ERROR
    DRM_LICENSE_ACQUISITION_FAILED DRM_DISALLOWED_OPERATION DRM_SYSTEM_ERROR DRM_DEVICE_REVOKED
    DRM_LICENSE_EXPIRED
""".split())

NATIVE_REASONS = {
    "native_error": MEDIA3_ERRORS,
    "native_paused": frozenset({
        "audio_focus_loss", "audio_output_disconnected", "remote_control", "user_request",
        "end_of_item", "suppressed_too_long", "other",
    }),
    "native_suppressed": frozenset({"transient_audio_focus_loss", "unsuitable_audio_output", "other"}),
}


class PlaybackDiagnostics:
    def __init__(self):
        self.actions = OrderedDict()
        self.lock = threading.Lock()

    @staticmethod
    def valid(action):
        return isinstance(action, str) and re.fullmatch(r"[0-9a-f]{32}", action) is not None

    def expire(self, now):
        while self.actions and next(iter(self.actions.values()))[1] <= now - 1800:
            self.actions.popitem(last=False)

    def record(self, owner, action, stage, *, client_ms=None, begin=False, observation=None, once=False):
        if not self.valid(action):
            return
        with self.lock:
            now = time.monotonic()
            self.expire(now)
            key = owner, action
            if key not in self.actions:
                if not begin:
                    return
                self.actions[key] = (action, now, {})
                owned = [key for key in self.actions if key[0] == owner]
                if len(owned) > 32:
                    del self.actions[owned[0]]
                if len(self.actions) > 256:
                    self.actions.popitem(last=False)
            _, started, events = self.actions[key]
            if once and stage in events:
                return
            event = {"stage": stage}
            if client_ms is None:
                event["server_ms"] = round((now - started) * 1000)
            else:
                event["client_ms"] = client_ms
            # One line per stage in the server log, so slow starts can be read without the phone's screenshots.
            # Only the random action id (first 8 characters), the stage and the timing: no profile or song names.
            log.info("playback action=%s stage=%s %s", action[:8], stage,
                     f"server_ms={event['server_ms']}" if "server_ms" in event else f"client_ms={client_ms}")
            if observation is not None:
                recent_observations = [key for key in events if isinstance(key, tuple)]
                event.update(observation)
                observation_key = tuple(event.items())
                if observation_key not in events:
                    if len(recent_observations) >= 32:
                        del events[recent_observations[0]]
                    events[observation_key] = event
            elif len(events) - sum(isinstance(key, tuple) for key in events) < 32:
                events.setdefault(stage, event)

    def recent(self, owner):
        with self.lock:
            self.expire(time.monotonic())
            return [{"action": action, "events": [dict(event) for event in events.values()]}
                    for (profile, _), (action, _, events) in reversed(self.actions.items()) if profile == owner]
