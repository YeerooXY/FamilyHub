import base64
import time
from pathlib import Path

from tests.test_music_web import Base


API = "/api/feedback"
REPORT = "1" * 32
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR8kAAAAASUVORK5CYII="


class FeedbackTests(Base):
    extra = {"FAMILY_PROFILES": True, "ALLOWED_USERS": ["sample-a", "sample-b", "sample-c"],
             "ADMIN_USERS": ["sample-c"], "WORDLE_DAILY_ANSWER": lambda day: "apple"}

    def selected(self, name):
        client = self.app.test_client()
        token = self.go(client, "GET", "/api/connect").json["csrf_token"]
        response = self.post(client, token, "/api/profile/select", json={"profile_id": name})
        self.assertEqual(response.status_code, 200)
        return client, response.json["csrf_token"]

    def test_private_report_with_attachment_and_developer_reply(self):
        owner, token = self.selected("sample-a")
        other, other_token = self.selected("sample-b")
        developer, dev_token = self.selected("sample-c")
        trace = "a" * 32
        self.go(owner, "GET", "/api/library?q=PRIVATE-SEARCH", headers={"X-FamilyHub-Trace-Id": trace})
        self.go(other, "GET", "/api/wordle/today")
        payload = {"id": REPORT, "kind": "problem", "description": "  Seek bar vanished.\nIt showed NaN.  ",
                   "images": [{"name": "seek.png", "data": PNG}],
                   "events": [{"at": int(time.time()), "event": "key", "screen": "music", "control": "seek-bar",
                               "key": "Enter", "value": "PRIVATE-TEXT"},
                              {"at": int(time.time()), "event": "key", "key": "a"}],
                   "device": {"culture": "hu-HU", "decimal": ",", "password": "PRIVATE-DEVICE"}, "request_ids": [trace]}
        self.assertEqual(self.post(owner, token, API, json=payload).status_code, 201)
        self.assertEqual(self.post(owner, token, API, json=payload).status_code, 200)
        self.assertEqual(len(self.go(owner, "GET", API).json["reports"]), 1)
        self.assertEqual(self.post(other, other_token, API, json=payload).status_code, 404)
        self.assertEqual(self.go(other, "GET", API).json["reports"], [])
        self.assertEqual(self.go(other, "GET", API + "?inbox=1").status_code, 403)
        thread = API + "/" + REPORT
        self.assertEqual(self.go(other, "GET", thread).status_code, 404)
        self.assertEqual(self.go(other, "GET", thread + "/images/0").status_code, 404)
        own = self.go(owner, "GET", thread).json
        self.assertEqual(own["description"], "Seek bar vanished.\nIt showed NaN.")
        self.assertNotIn("events", own)
        self.assertEqual(self.go(owner, "GET", thread + "/images/0").json["data"], PNG)

        self.assertTrue(self.go(developer, "GET", API + "?inbox=1").json["can_manage"])
        detail = self.go(developer, "GET", thread).json
        self.assertEqual(detail["events"][0]["key"], "Enter")
        self.assertNotIn("key", detail["events"][1])
        self.assertEqual(detail["device"], {"culture": "hu-HU", "decimal": ","})
        self.assertNotIn("PRIVATE", str(detail))
        self.assertTrue(any(event.get("endpoint") == "library" and event["from_device"] for event in detail["server_events"]))
        self.assertTrue(all(event["owner"] == "sample-a" for event in detail["server_events"]))
        self.assertNotIn("PRIVATE-SEARCH", (Path(self.ws) / ".feedback-server.log").read_text())
        self.assertEqual(self.post(developer, dev_token, thread + "/replies", json={"message": "Can you confirm the app version?"}).status_code, 200)
        own = self.go(owner, "GET", thread).json
        self.assertEqual((own["replies"][0]["author"], own["status"]), ("Developer", "waiting"))
        self.assertEqual(self.post(owner, token, thread + "/replies", json={"message": "0.1.84"}).status_code, 200)
        self.assertEqual(self.go(owner, "GET", thread).json["status"], "new")
        self.assertEqual(self.go(developer, "PATCH", thread, headers={"X-CSRFToken": dev_token}, json={"status": "closed"}).status_code, 200)
        self.assertEqual(self.post(owner, token, thread + "/replies", json={"message": "A late reply"}).status_code, 409)

    def test_rejects_non_images_and_requires_description(self):
        owner, token = self.selected("sample-a")
        payload = {"id": REPORT, "kind": "feature", "description": "  "}
        self.assertEqual(self.post(owner, token, API, json=payload).status_code, 400)
        payload.update(description="Make tracks searchable", images=[{"name": "test.png", "data": base64.b64encode(b"<svg/>").decode()}])
        self.assertEqual(self.post(owner, token, API, json=payload).status_code, 400)
        self.assertEqual(self.go(owner, "GET", API).json["reports"], [])
