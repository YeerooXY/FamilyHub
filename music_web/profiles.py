"""Profiles for an explicitly enabled private family server."""
import json
import hashlib
import re
import secrets
import math
import time
from pathlib import Path


class ProfileError(ValueError):
    pass


class ProfileStore:
    COLORS = ("#bba8ff", "#7fc8f8", "#96d6ab", "#f5b98d", "#eea9ca", "#e6d279")

    def __init__(self, workspace, seeds, clock=time.time):
        self.clock = clock
        self.path = Path(workspace) / ".family-profiles.json"
        if not self.path.exists():
            profiles = []
            for name in sorted(set(seeds)):
                if len(profiles) >= 12:
                    raise ProfileError("Family mode supports up to 12 profiles.")
                profiles.append(self.profile(name, name, len(profiles)))
            self.write({"profiles": profiles, "preferences": {}})

    def profile(self, profile_id, name, index):
        return {"id": profile_id, "name": name, "color": self.COLORS[index % len(self.COLORS)]}

    def read(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.path)

    def list(self):
        profiles = self.read()["profiles"]
        for profile in profiles:
            digest = profile.get("image_sha256", "")
            if isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest):
                owner = hashlib.sha256(profile["id"].encode()).hexdigest()
                profile["image_url"] = f"/api/profile-images/{owner}/{digest}.jpg"
        return profiles

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
        if not isinstance(profile_id, str):
            raise ProfileError("Choose a family profile.")
        profile = next((p for p in self.list() if p["id"] == profile_id), None)
        if profile is None:
            raise ProfileError("This profile was not found. Choose a family profile.")
        return profile

    def create(self, name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ProfileError("Enter a profile name of 1 to 64 characters.")
        name = name.strip()
        data = self.read()
        if len(data["profiles"]) >= 12:
            raise ProfileError("You can create up to 12 family profiles.")
        if any(p["name"].casefold() == name.casefold() for p in data["profiles"]):
            raise ProfileError("A profile with this name already exists.")
        profile = self.profile(secrets.token_urlsafe(16), name, len(data["profiles"]))
        data["profiles"].append(profile)
        self.write(data)
        return profile

    def preferences(self, profile_id, changes=None):
        self.get(profile_id)
        data = self.read()
        preferences = {"volume": 1, "shuffle": False, "auto_dj": True, "crossfade_seconds": 6, "volume_level": "normal", "spotify_subscribed": None, "repeat_mode": "off",
                       **data["preferences"].get(profile_id, {})}
        if changes is not None:
            if not changes or set(changes) - {"volume", "shuffle", "auto_dj", "crossfade_seconds", "volume_level", "spotify_subscribed", "repeat_mode"}:
                raise ProfileError("Choose volume, shuffle or Auto DJ preferences.")
            if "volume" in changes and (type(changes["volume"]) not in (float, int) or not 0 <= changes["volume"] <= 1):
                raise ProfileError("Volume must be between 0 and 1.")
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
        data = self.read()
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
            data.setdefault("playback", {})[profile_id] = value
            self.write(data)
        return data.get("playback", {}).get(profile_id)
