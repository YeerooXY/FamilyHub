"""Profiles for an explicitly enabled private family server."""
from copy import deepcopy
import json
import hashlib
import re
import secrets
import math
import time
from pathlib import Path
from datetime import datetime, timezone


class ProfileError(ValueError):
    pass


def file_version(path):
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size, stat.st_ino


class ProfileStore:
    COLORS = ("#bba8ff", "#7fc8f8", "#96d6ab", "#f5b98d", "#eea9ca", "#e6d279")

    def __init__(self, workspace, seeds, clock=time.time):
        self.clock = clock
        self.path = Path(workspace) / ".family-profiles.json"
        self._cache = None
        if not self.path.exists():
            profiles = []
            for name in sorted(set(seeds)):
                if len(profiles) >= 12:
                    raise ProfileError("Family mode supports up to 12 profiles.")
                profiles.append(self.profile(name, name, len(profiles)))
            self.write({"profiles": profiles, "preferences": {}})

    def profile(self, profile_id, name, index):
        return {"id": profile_id, "name": name, "color": self.COLORS[index % len(self.COLORS)]}

    def _load(self):
        version = file_version(self.path)
        cached = self._cache
        if cached is None or cached[0] != version:
            cached = version, json.loads(self.path.read_text(encoding="utf-8"))
            self._cache = cached
        return cached[1]

    def read(self):
        return deepcopy(self._load())

    def write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.path)
        self._cache = None

    def list(self):
        return [self._public_profile(profile) for profile in self._load()["profiles"]]

    @staticmethod
    def _public_profile(profile):
        profile = deepcopy(profile)
        digest = profile.get("image_sha256", "")
        if isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest):
            owner = hashlib.sha256(profile["id"].encode()).hexdigest()
            profile["image_url"] = f"/api/profile-images/{owner}/{digest}.jpg"
        return profile

    def set_image(self, profile_id, digest):
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ProfileError("Invalid profile image.")
        self.get(profile_id)
        data = self.read()
        profile = next(p for p in data["profiles"] if p["id"] == profile_id)
        profile["image_sha256"] = digest
        self.write(data)
        return self.get(profile_id)

    def get(self, profile_id):
        return self._public_profile(self._find(profile_id, self._load()))

    @staticmethod
    def _find(profile_id, data):
        if not isinstance(profile_id, str):
            raise ProfileError("Choose a family profile.")
        profile = next((p for p in data["profiles"] if p["id"] == profile_id), None)
        if profile is None:
            raise ProfileError("This profile was not found. Choose a family profile.")
        return profile

    @staticmethod
    def _validated_name(name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ProfileError("Enter a profile name of 1 to 64 characters.")
        return name.strip()

    def create(self, name):
        name = self._validated_name(name)
        data = self.read()
        if len(data["profiles"]) >= 12:
            raise ProfileError("You can create up to 12 family profiles.")
        if any(p["name"].casefold() == name.casefold() for p in data["profiles"]):
            raise ProfileError("A profile with this name already exists.")
        profile = self.profile(secrets.token_urlsafe(16), name, len(data["profiles"]))
        data["profiles"].append(profile)
        self.write(data)
        return profile

    def set_name(self, profile_id, name):
        name = self._validated_name(name)
        data = self.read()
        profile = self._find(profile_id, data)
        if any(p["id"] != profile_id and p["name"].casefold() == name.casefold() for p in data["profiles"]):
            raise ProfileError("A profile with this name already exists.")
        if profile["name"] != name:
            profile["name"] = name
            self.write(data)
        return self._public_profile(profile)

    def preferences(self, profile_id, changes=None):
        data = self._load() if changes is None else self.read()
        self._find(profile_id, data)
        preferences = {"listening_history_paused": False, "volume": 1, "shuffle": False, "auto_dj": True, "crossfade_seconds": 6, "volume_level": "normal", "spotify_subscribed": None, "repeat_mode": "off",
                       **deepcopy(data["preferences"].get(profile_id, {}))}
        if changes is not None:
            if not changes or set(changes) - {"listening_history_paused", "volume", "shuffle", "auto_dj", "crossfade_seconds", "volume_level", "spotify_subscribed", "repeat_mode"}:
                raise ProfileError("Choose a supported profile preference.")
            if "volume" in changes and (type(changes["volume"]) not in (float, int) or not 0 <= changes["volume"] <= 1):
                raise ProfileError("Volume must be between 0 and 1.")
            if "listening_history_paused" in changes and type(changes["listening_history_paused"]) is not bool:
                raise ProfileError("Pause history must be true or false.")
            if changes.get('listening_history_paused') is False and preferences['listening_history_paused']:
                preferences['listening_history_resumed_at'] = datetime.fromtimestamp(self.clock(), timezone.utc).isoformat()
            if "shuffle" in changes and type(changes["shuffle"]) is not bool:
                raise ProfileError("Shuffle must be true or false.")
            if "auto_dj" in changes and type(changes["auto_dj"]) is not bool:
                raise ProfileError("Auto DJ must be true or false.")
            if "crossfade_seconds" in changes and (type(changes["crossfade_seconds"]) is not int or not 0 <= changes["crossfade_seconds"] <= 12):
                raise ProfileError("Crossfade must be 0 to 12 seconds.")
            if "volume_level" in changes and changes["volume_level"] not in ("loud", "normal", "quiet"):
                raise ProfileError("Choose Loud, Normal or Quiet volume level.")
            if "repeat_mode" in changes and changes["repeat_mode"] not in ("off", "all", "one"):
                raise ProfileError("Choose repeat off, all or one.")
            if "spotify_subscribed" in changes and type(changes["spotify_subscribed"]) is not bool:
                raise ProfileError("Spotify subscription must be true or false.")
            if "spotify_subscribed" in changes and changes["spotify_subscribed"] != preferences["spotify_subscribed"]:
                # The answer and its history change in one write; repeated answers add no event.
                events = data.setdefault("subscription_history", {}).setdefault(profile_id, [])
                events.append({"at": int(self.clock() * 1000), "subscribed": changes["spotify_subscribed"]})
                del events[:-500]  # shortcut: keeps the latest 500 answers, raise the cap if ever needed
            preferences.update(changes)
            data["preferences"][profile_id] = preferences
            self.write(data)
        return preferences

    def subscription_history(self):
        return {user: [dict(event) for event in events]
                for user, events in self.read().get("subscription_history", {}).items()}

    def playback(self, profile_id, value=None):
        self.get(profile_id)
        directory = self.path.parent / '.playback-state'
        path = directory / (hashlib.sha256(profile_id.encode()).hexdigest() + '.json')
        if value is not None:
            ids = value.get("track_ids") if isinstance(value, dict) else None
            index = value.get("index") if isinstance(value, dict) else None
            position = value.get("position") if isinstance(value, dict) else None
            if (not isinstance(ids, list) or not 1 <= len(ids) <= 1000
                    or any(not isinstance(i, str) or not re.fullmatch(r"(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})", i) for i in ids)
                    or type(index) is not int or not 0 <= index < len(ids)
                    or type(position) not in (int, float) or not math.isfinite(position) or not 0 <= position <= 86400):
                raise ProfileError("Invalid saved playback position.")
            value = {"track_ids": ids, "index": index, "position": position, "updated_at": int(time.time() * 1000)}
            directory.mkdir(exist_ok=True)
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(value), encoding='utf-8')
            temporary.replace(path)
            return value
        if path.exists():
            return json.loads(path.read_text(encoding='utf-8'))
        return self._load().get('playback', {}).get(profile_id)
