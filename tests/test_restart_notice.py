"""Only a signed, direct deployment request can announce a restart."""
import hashlib
import hmac
import time
from unittest.mock import patch

from test_music_web import Base, ORIGIN


class RestartNotice(Base):
    endpoint = "/api/server/restart-notice"

    def proof(self, seconds=8, nonce="a" * 32, stamp=None):
        stamp = int(time.time()) if stamp is None else stamp
        message = f"restart-notice|{stamp}|{nonce}|{seconds}".encode()
        signature = hmac.new(self.settings["SECRET_KEY"].encode(), message, hashlib.sha256).hexdigest()
        return f"{stamp}:{nonce}:{signature}"

    def announce(self, proof, seconds=8, remote="127.0.0.1", **extra_headers):
        headers = {"X-FamilyHub-Restart-Proof": proof, **extra_headers}
        return self.go(self.app.test_client(), "POST", self.endpoint, json={"seconds": seconds},
                       headers=headers, environ_overrides={"REMOTE_ADDR": remote})

    def test_notice_reaches_signed_in_heartbeats_and_expires(self):
        listener, csrf = self.signed_in()
        activity = {"device_id": "b" * 32, "playing": False}

        def heartbeat():
            response = self.post(listener, csrf, "/api/playback/activity", json=activity)
            self.assertEqual(response.status_code, 200)
            return response.get_json()

        self.assertNotIn("restart_in_seconds", heartbeat())
        self.assertEqual(self.announce(self.proof()).status_code, 200)
        self.assertIn(heartbeat()["restart_in_seconds"], (7, 8))
        self.assertEqual(self.go(self.app.test_client(), "POST", "/api/playback/activity", json=activity).status_code, 401)
        self.assertEqual(self.go(listener, "POST", "/api/playback/activity", json=activity).status_code, 400)
        now = time.monotonic()
        with patch("music_web.time.monotonic", return_value=now + 10):
            self.assertEqual(heartbeat()["restart_in_seconds"], 0)
        with patch("music_web.time.monotonic", return_value=now + 121):
            self.assertNotIn("restart_in_seconds", heartbeat())

    def test_boundary_checks_and_replay(self):
        proof = self.proof()
        self.assertEqual(self.announce(proof, remote="192.0.2.1").status_code, 403)
        self.assertEqual(self.announce(proof, **{"X-Forwarded-For": "192.0.2.1"}).status_code, 403)
        self.assertEqual(self.announce(proof, Origin=ORIGIN + ".invalid").status_code, 403)
        self.assertEqual(self.announce("invalid").status_code, 403)
        self.assertEqual(self.announce(proof, seconds=9).status_code, 403)
        self.assertEqual(self.announce(proof, seconds=True).status_code, 400)
        self.assertEqual(self.announce(self.proof(stamp=int(time.time()) - 31)).status_code, 403)
        self.assertEqual(self.announce(proof).status_code, 200)
        self.assertEqual(self.announce(proof).status_code, 403)
        for _ in range(4):
            self.assertEqual(self.announce(proof).status_code, 403)
        self.assertEqual(self.announce(proof).status_code, 429)
