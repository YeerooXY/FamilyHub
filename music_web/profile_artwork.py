"""Profile pictures for the explicitly enabled private family server."""
import hashlib
import re
from pathlib import Path
from flask import abort, g, jsonify, request, send_file
from .playlist_artwork import PlaylistArtwork, ArtworkError


class ProfileArtwork(PlaylistArtwork):
    def __init__(self, workspace, governor=None):
        super().__init__(workspace, governor)
        self.root = Path(workspace) / ".profile-artwork"


def register(app, workspace, profiles, require_family, lock, governor=None):
    artwork = ProfileArtwork(workspace, governor)

    @app.post("/api/profile/image")
    def save_profile_image():
        require_family()
        if (request.content_length or 0) > 751024:
            abort(413)
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or set(data) != {"image"}:
            return jsonify(error="Choose an image for the current profile."), 400
        try:
            # Only the current authenticated profile is writable; no caller-provided owner.
            with lock:
                profiles.get(g.user)
            digest = artwork.save(g.user, "profile", data["image"])
            with lock:
                profile = profiles.set_image(g.user, digest)
        except ArtworkError as error:
            return jsonify(error=str(error)), 400
        return jsonify(profile=profile)

    @app.get("/api/profile-images/<owner_key>/<digest>.jpg", endpoint="profile_image")
    def profile_image(owner_key, digest):
        require_family()
        if not re.fullmatch(r"[a-f0-9]{64}", owner_key) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            abort(404)
        # Profile images have the same visibility as the family profile chooser.
        with lock:
            profile = next((p for p in profiles.list() if p.get("image_sha256") == digest
                            and hashlib.sha256(p["id"].encode()).hexdigest() == owner_key), None)
        if profile is None:
            abort(404)
        path = artwork.path(profile["id"], "profile", digest)
        if not path.is_file():
            abort(404)
        return send_file(path, mimetype="image/jpeg", conditional=True, etag=digest)
