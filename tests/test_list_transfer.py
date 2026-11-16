"""Library and playlist lists: unchanged lists answer 304, changed ones are gzip-compressed."""
import gzip
import json
import unittest

from tests.test_music_web import Base


class ListTransfer(Base):
    def test_unchanged_lists_answer_not_modified_and_changed_lists_are_compressed(self):
        c, _ = self.signed_in()
        for path in ("/api/library", "/api/playlists"):
            plain = self.go(c, "GET", path)
            self.assertEqual(plain.status_code, 200)
            self.assertNotIn("Content-Encoding", plain.headers)
            tag = plain.headers["ETag"]
            unchanged = self.go(c, "GET", path, headers={"If-None-Match": tag})
            self.assertEqual(unchanged.status_code, 304)
            self.assertEqual(unchanged.get_data(), b"")
            packed = self.go(c, "GET", path, headers={"Accept-Encoding": "gzip"})
            self.assertEqual(packed.headers["Content-Encoding"], "gzip")
            self.assertEqual(packed.headers["ETag"], tag)
            self.assertEqual(json.loads(gzip.decompress(packed.get_data())), plain.get_json())
            stale = self.go(c, "GET", path, headers={"If-None-Match": '"other"'})
            self.assertEqual(stale.status_code, 200)

    def test_other_responses_are_not_compressed(self):
        c, _ = self.signed_in()
        r = self.go(c, "GET", "/api/server/stats", headers={"Accept-Encoding": "gzip"})
        self.assertNotIn("Content-Encoding", r.headers)


if __name__ == "__main__":
    unittest.main()
