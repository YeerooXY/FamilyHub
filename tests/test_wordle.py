from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from unittest import TestCase
from unittest.mock import patch

from music_web import ApiError, wordle
from tests.test_music_web import Base


DAY = date(2026, 11, 21)
TODAY = "/api/wordle/today"
GUESS = "/api/wordle/guess"
STATS = "/api/wordle/stats"


class DailyWordTests(Base):
    extra = {"FAMILY_PROFILES": True, "WORDLE_DAILY_ANSWER": lambda day: "apple"}

    def setUp(self):
        super().setUp()
        self.day = self.enterContext(patch.object(wordle, "current_day", return_value=DAY))

    def selected(self, name):
        client = self.app.test_client()
        token = self.go(client, "GET", "/api/connect").json["csrf_token"]
        response = self.post(client, token, "/api/profile/select", json={"profile_id": name})
        self.assertEqual(response.status_code, 200)
        return client, response.json["csrf_token"]

    def guess(self, client, token, word, day=DAY, count=None):
        if count is None:
            count = len(self.go(client, "GET", TODAY).json["guesses"])
        return self.post(client, token, GUESS, json={"date": day.isoformat(), "word": word,
                                                   "guess_count": count})

    def test_private_progress_and_family_results(self):
        a, token = self.selected("sample-a")
        b, _ = self.selected("sample-b")
        self.assertEqual(self.go(self.app.test_client(), "GET", TODAY).status_code, 401)
        self.assertNotIn("answer", self.go(a, "GET", TODAY).json)
        first = self.guess(a, token, "ALLEY").json
        self.assertEqual(first["guesses"], [
            {"word": "alley", "marks": ["correct", "present", "absent", "present", "absent"]},
        ])
        self.assertNotIn("answer", first)
        self.assertEqual(self.guess(a, token, "alley", count=0).json, first)
        self.assertEqual(self.go(b, "GET", TODAY).json["guesses"], [])
        self.assertEqual(self.go(a, "GET", STATS).json["personal"]["played"], 0)
        reconnect, _ = self.selected("sample-a")
        self.assertEqual(self.go(reconnect, "GET", TODAY).json, first)
        self.assertEqual(self.guess(a, token, "Apple").json["status"], "won")
        self.assertEqual(self.go(a, "GET", TODAY).json["answer"], "apple")
        self.assertNotIn("answer", self.go(b, "GET", TODAY).json)
        stats = self.go(b, "GET", STATS).json
        player = next(row for row in stats["family"] if row["profile_id"] == "sample-a")
        self.assertEqual(player["distribution"], [0, 1, 0, 0, 0, 0])
        self.assertEqual(stats["family_totals"], {
            "played": 1, "won": 1, "distribution": [0, 1, 0, 0, 0, 0],
            "today": {"completed": 1, "won": 1, "members": 2},
        })
        self.assertEqual(stats["history"], [])
        self.assertNotIn("apple", str(stats))

    def test_local_scoring_requires_profile_and_explicit_request(self):
        url = TODAY + "?local=1"
        self.assertEqual(self.go(self.app.test_client(), "GET", url).status_code, 401)
        client, _ = self.selected("sample-a")
        self.assertNotIn("local_solution", self.go(client, "GET", TODAY).json)
        response = self.go(client, "GET", url)
        self.assertEqual(response.json["local_solution"], "apple")
        self.assertTrue(response.cache_control.no_store)

    def test_family_board_shares_only_marks_for_current_day(self):
        family = "/api/wordle/family"
        self.assertEqual(self.go(self.app.test_client(), "GET", family).status_code, 401)
        a, token = self.selected("sample-a")
        b, _ = self.selected("sample-b")
        guess = self.guess(a, token, "alley").json["guesses"][0]
        snapshot = self.go(b, "GET", family).json
        self.assertEqual(snapshot["date"], DAY.isoformat())
        boards = {p["id"]: p for p in snapshot["family"]}
        self.assertEqual(boards["sample-a"]["rows"], [guess["marks"]])
        self.assertEqual(boards["sample-b"]["rows"], [])
        self.assertNotIn("alley", str(snapshot))
        self.assertNotIn("apple", str(snapshot))
        self.assertEqual(self.go(b, "GET", TODAY + "?local=1").json["family"], snapshot["family"])

    def test_family_word_lines_require_viewer_to_finish(self):
        family = "/api/wordle/family"
        a, token = self.selected("sample-a")
        b, other_token = self.selected("sample-b")
        first = self.guess(a, token, "alley").json["guesses"][0]
        last = self.guess(a, token, "apple").json["guesses"][-1]
        before = self.go(b, "GET", family).json["family"]
        self.assertNotIn("guesses", next(row for row in before if row["id"] == "sample-a"))
        self.guess(b, other_token, "apple")
        after = self.go(b, "GET", family).json["family"]
        self.assertEqual(next(row for row in after if row["id"] == "sample-a")["guesses"], [first, last])

    def test_family_activity_tracks_edits_and_honors_spoiler_setting(self):
        a, token = self.selected("sample-a")
        b, other_token = self.selected("sample-b")
        activity = "/api/wordle/activity"
        view = "a" * 32

        def publish(count, row=0, view_id=view):
            return self.go(a, "PUT", activity, headers={"X-CSRFToken": token},
                           json={"date": DAY.isoformat(), "view": view_id, "row": row, "draft_count": count})

        def remote():
            boards = self.go(b, "GET", "/api/wordle/family").json["family"]
            return next((board for board in boards if board["id"] == "sample-a"), None)

        self.assertEqual(self.go(a, "PUT", activity, json={}).status_code, 400)
        self.assertEqual(publish(True).status_code, 400)
        with patch.object(wordle, "monotonic", return_value=10) as clock:
            for count in (0, 1, 2, 1, 0, 5):
                self.assertEqual(publish(count).status_code, 200)
                self.assertEqual(remote()["rows"], [])
                self.assertTrue(remote()["playing"])
                self.assertEqual(remote()["draft_count"], count)
                self.assertNotIn("guesses", remote())
            marks = self.guess(a, token, "alley").json["guesses"][0]["marks"]
            self.assertEqual(remote()["rows"], [marks])
            self.assertEqual(remote()["draft_count"], 0)
            self.assertEqual(publish(3, row=1, view_id="b" * 32).status_code, 200)
            self.assertEqual(publish(0, row=None).status_code, 200)
            self.assertEqual(remote()["draft_count"], 3)
            clock.return_value = 22
            self.assertNotIn("playing", remote())
            self.assertEqual(publish(1, row=1).status_code, 200)
            self.assertEqual(publish(0, row=None).status_code, 200)
            self.assertNotIn("playing", remote())
            self.assertEqual(publish(1, row=1).status_code, 200)
            self.assertEqual(self.go(b, "PUT", "/api/wordle/settings", headers={"X-CSRFToken": other_token},
                                     json={"hide_family_until_finished": True}).status_code, 200)
            self.assertIsNone(remote())

    def test_settings_profile_scope_and_favorite_guess_spoilers(self):
        settings = "/api/wordle/settings"
        family = "/api/wordle/family"
        a, token = self.selected("sample-a")
        b, other_token = self.selected("sample-b")
        self.assertEqual(self.go(self.app.test_client(), "GET", settings).status_code, 401)
        self.assertEqual(self.go(b, "GET", settings).json, {"hide_family_until_finished": False})
        self.assertEqual(self.go(b, "PUT", settings, json={"hide_family_until_finished": True}).status_code, 400)
        self.assertEqual(self.go(b, "PUT", settings, headers={"X-CSRFToken": other_token},
                                 json={"hide_family_until_finished": "yes"}).status_code, 400)
        self.assertEqual(self.go(b, "PUT", settings, headers={"X-CSRFToken": other_token},
                                 json={"hide_family_until_finished": True}).status_code, 200)
        self.assertEqual(self.go(a, "GET", settings).json, {"hide_family_until_finished": False})
        reconnect, _ = self.selected("sample-b")
        self.assertEqual(self.go(reconnect, "GET", settings).json, {"hide_family_until_finished": True})
        self.guess(a, token, "alley")
        self.guess(a, token, "apple")
        self.assertEqual([item["id"] for item in self.go(b, "GET", family).json["family"]], ["sample-b"])
        self.assertIsNone(self.go(b, "GET", STATS).json["family_totals"]["today"])
        self.day.return_value = DAY + timedelta(days=1)
        self.guess(a, token, "alley", day=self.day.return_value)
        self.guess(a, token, "crane", day=self.day.return_value)
        stats = self.go(b, "GET", STATS).json
        favorite_words = lambda result: next(row for row in result["family"] if row["profile_id"] == "sample-a")["favorite_guesses"]
        self.assertEqual(favorite_words(stats), [{"word": "alley", "count": 1}, {"word": "apple", "count": 1}])
        self.guess(b, other_token, "apple", day=self.day.return_value)
        stats = self.go(b, "GET", STATS).json
        self.assertEqual(favorite_words(stats), [{"word": "alley", "count": 2}, {"word": "apple", "count": 1},
                                                 {"word": "crane", "count": 1}])
        self.assertEqual(len(self.go(b, "GET", family).json["family"]), 2)

    def test_loss_and_daily_rollover(self):
        client, token = self.selected("sample-a")
        self.assertEqual(self.guess(client, token, "zzzzz").status_code, 400)
        for word in ("about", "above", "acorn", "actor", "acute", "adapt"):
            result = self.guess(client, token, word).json
        self.assertEqual(result["status"], "lost")
        self.assertEqual(result["answer"], "apple")
        self.assertEqual(self.guess(client, token, "apple").status_code, 409)
        self.day.return_value = date(2026, 11, 22)
        self.assertEqual(self.guess(client, token, "apple").status_code, 409)
        self.assertEqual(self.go(client, "GET", TODAY).json["guesses"], [])
        self.assertEqual(self.go(client, "GET", STATS).json["history"],
                         [{"date": DAY.isoformat(), "status": "lost", "guesses": 6}])

    def test_repeated_daily_lookup_persists_answer(self):
        client, token = self.selected("sample-a")
        self.go(client, "GET", TODAY)
        replacement = wordle.WordPuzzles(self.ws, lambda day: "other", ValueError)
        self.assertEqual(replacement.answer(DAY, DAY.isoformat()), "apple")
        self.assertEqual(self.guess(client, token, "apple").json["status"], "won")

    def test_unavailable_provider_never_uses_household_answer(self):
        missing = wordle.WordPuzzles(self.ws, lambda day: None, RuntimeError)
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            missing.answer(DAY, DAY.isoformat())

    def test_concurrent_guesses_preserve_each_update(self):
        puzzles = wordle.WordPuzzles(self.ws, lambda day: "apple", ApiError)

        def submit(guess):
            try:
                return puzzles.play("sample-a", DAY, guess, 0)
            except ApiError as error:
                self.assertEqual(error.code, 409)
                return None

        with ThreadPoolExecutor(max_workers=4) as pool:
            submitted = list(pool.map(submit, ("about", "above", "acorn", "actor")))
        self.assertEqual(sum(result is not None for result in submitted), 1)
        result = puzzles.play("sample-a", DAY)
        self.assertEqual(len(result["guesses"]), 1)
        self.assertEqual(puzzles.play("sample-a", DAY, result["guesses"][0]["word"], 0), result)
        with self.assertRaisesRegex(ApiError, "Already guessed"):
            puzzles.play("sample-a", DAY, result["guesses"][0]["word"], 1)
        self.assertEqual(puzzles.play("sample-a", DAY), result)

    def test_repairs_repeated_rows_in_current_unfinished_round(self):
        puzzles = wordle.WordPuzzles(self.ws, lambda day: "apple", ApiError)
        puzzles.play("sample-a", DAY, "about", 0)
        with closing(puzzles.connect()) as db, db:
            db.execute("UPDATE progress SET guesses = ?, guess_count = 3", ('["about","about","above"]',))
        reopened = wordle.WordPuzzles(self.ws, lambda day: "apple", ApiError)
        state = reopened.play("sample-a", DAY, "alley", 2)
        self.assertEqual([row["word"] for row in state["guesses"]], ["about", "above", "alley"])


class CalendarTests(TestCase):
    def test_budapest_day(self):
        with patch.object(wordle, "datetime", wraps=datetime) as clock:
            clock.now.side_effect = lambda zone: datetime(2026, 7, 1, 22, tzinfo=timezone.utc).astimezone(zone)
            self.assertEqual(wordle.current_day(), date(2026, 7, 2))
        self.assertEqual(wordle.next_reset(date(2026, 7, 1)), "2026-07-01T22:00:00+00:00")
        self.assertEqual(wordle.next_reset(date(2026, 11, 21)), "2026-11-21T23:00:00+00:00")

    def test_streak_resets_on_loss_and_preserves_best(self):
        dates = [("2026-11-19", "won", 2), ("2026-11-20", "won", 3)]
        self.assertEqual(wordle.summarize(dates, DAY)["current_streak"], 2)
        summary = wordle.summarize([*dates, ("2026-11-21", "lost", 6)], DAY)
        self.assertEqual(summary, {"played": 3, "won": 2, "current_streak": 0, "best_streak": 2,
                                   "distribution": [0, 1, 1, 0, 0, 0]})
