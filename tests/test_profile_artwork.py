import base64
import hashlib
import subprocess
from unittest.mock import patch
from test_family_profiles import FamilyProfiles
from test_music_web import Base
from music_web.profiles import ProfileStore
from music_web.profile_artwork import ProfileArtwork
from music_web.playlist_artwork import ArtworkError


class ProfileArtworkApi(FamilyProfiles):
    def image(self):
        return "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffinput").decode()

    def save_image(self, client, token, output=b"\xff\xd8\xffnormalized"):
        with patch("music_web.playlist_artwork.subprocess.run", return_value=subprocess.CompletedProcess([], 0, output, b"")) as run:
            response = self.post(client, token, "/api/profile/image", json={"image": self.image()})
        return response, run

    def test_saved_profile_picture_is_visible_in_chooser_and_survives_restart(self):
        owner, token = self.select("sample-a")
        response, run = self.save_image(owner, token)
        self.assertEqual(response.status_code, 200, response.json)
        profile = response.json["profile"]
        digest = hashlib.sha256(b"\xff\xd8\xffnormalized").hexdigest()
        self.assertEqual(profile["id"], "sample-a")
        self.assertEqual(profile["image_sha256"], digest)
        self.assertIn("scale=512:512:force_original_aspect_ratio=increase,crop=512:512", run.call_args.args[0])
        chooser, bootstrap = self.bootstrap()
        self.assertEqual(bootstrap["profiles"][0]["image_url"], profile["image_url"])
        with self.go(chooser, "GET", profile["image_url"]) as image:
            self.assertEqual(image.status_code, 200)
            self.assertEqual(image.mimetype, "image/jpeg")
            self.assertEqual(image.data, b"\xff\xd8\xffnormalized")
        restarted = ProfileStore(self.ws, ["sample-a", "sample-b"])
        self.assertEqual(restarted.get("sample-a")["image_url"], profile["image_url"])
        self.assertNotIn("image_url", restarted.get("sample-b"))

    def test_upload_is_current_profile_only_with_csrf_and_origin_checks(self):
        chooser, bootstrap = self.bootstrap()
        self.assertEqual(self.post(chooser, bootstrap["csrf_token"], "/api/profile/image", json={"image": self.image()}).status_code, 401)
        owner, token = self.select("sample-a")
        self.assertEqual(self.go(owner, "POST", "/api/profile/image", json={"image": self.image()}).status_code, 400)
        self.assertEqual(self.go(owner, "POST", "/api/profile/image", origin=False,
            headers={"Origin": "https://other.test", "X-CSRFToken": token}, json={"image": self.image()}).status_code, 403)
        self.assertEqual(self.post(owner, token, "/api/profile/image", json={"image": self.image(), "profile_id": "sample-b"}).status_code, 400)
        response, _ = self.save_image(owner, token)
        other, other_token = self.select("sample-b")
        other_response, _ = self.save_image(other, other_token, b"\xff\xd8\xffother")
        self.assertEqual(other_response.json["profile"]["id"], "sample-b")
        self.assertNotEqual(response.json["profile"]["image_url"], other_response.json["profile"]["image_url"])
        with self.go(other, "GET", response.json["profile"]["image_url"]) as image:
            self.assertEqual(image.data, b"\xff\xd8\xffnormalized")

    def test_invalid_images_and_paths_are_rejected(self):
        owner, token = self.select()
        for image in ["https://example.test/image.jpg", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/jpeg;base64,invalid", "data:image/png;base64," + "a" * 800000]:
            self.assertIn(self.post(owner, token, "/api/profile/image", json={"image": image}).status_code, (400, 413))
        for path in ["/api/profile-images/bad/" + "a" * 64 + ".jpg", "/api/profile-images/" + "a" * 64 + "/" + "b" * 64 + ".jpg"]:
            self.assertEqual(self.go(owner, "GET", path).status_code, 404)
        with patch("music_web.playlist_artwork.subprocess.run", side_effect=subprocess.TimeoutExpired("ffmpeg", 10)):
            self.assertEqual(self.post(owner, token, "/api/profile/image", json={"image": self.image()}).status_code, 400)
        with self.assertRaises(ArtworkError): ProfileArtwork(self.ws).save("sample-a", "profile", "data:image/jpeg;base64,broken")

    def test_replaced_picture_old_url_is_not_served(self):
        owner, token = self.select()
        first, _ = self.save_image(owner, token)
        second, _ = self.save_image(owner, token, b"\xff\xd8\xffreplacement")
        self.assertNotEqual(first.json["profile"]["image_url"], second.json["profile"]["image_url"])
        self.assertEqual(self.go(owner, "GET", first.json["profile"]["image_url"]).status_code, 404)
        with self.go(owner, "GET", second.json["profile"]["image_url"]) as image:
            self.assertEqual(image.status_code, 200)


class DisabledProfileArtwork(Base):
    def test_family_mode_required(self):
        client, token = self.signed_in()
        self.assertEqual(self.post(client, token, "/api/profile/image", json={"image": "bad"}).status_code, 409)
        self.assertEqual(self.go(client, "GET", "/api/profile-images/" + "a" * 64 + "/" + "b" * 64 + ".jpg").status_code, 409)
