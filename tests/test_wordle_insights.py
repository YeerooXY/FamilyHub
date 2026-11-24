from collections import defaultdict
from datetime import date
from unittest import TestCase

from music_web import wordle

PEOPLE = [{"id": "a", "name": "Ana"}, {"id": "b", "name": "Bela"}, {"id": "c", "name": "Csilla"}]
HARD = ["alley", "ample", "apple"]    # every guess keeps the clues found so far
SOFT = ["alley", "stone", "apple"]    # "stone" drops the green A and the yellow L and E


def game(day, words, status="won", ms=60000, times=()):
    return wordle.Finished(day, status, tuple(words), "apple", ms, tuple(times),
                           wordle.followed_hard_rules(tuple(words), "apple"))


def table(**by_person):
    finished = defaultdict(list)
    for person, games in by_person.items():
        finished[person].extend(games)
    return finished


class HardRuleTests(TestCase):
    def test_detects_hard_rule_breaks_only_before_the_last_guess(self):
        self.assertTrue(wordle.followed_hard_rules(tuple(HARD), "apple"))
        self.assertFalse(wordle.followed_hard_rules(tuple(SOFT), "apple"))
        self.assertTrue(wordle.followed_hard_rules(("apple",), "apple"))


class RoundTests(TestCase):
    def test_fewer_guesses_win_then_hard_rules_then_time(self):
        quick = game("2026-11-20", ["alley", "apple"], ms=90000)
        hard = game("2026-11-20", HARD, ms=90000)
        soft = game("2026-11-20", SOFT, ms=30000)
        lost = game("2026-11-20", ["alley"] * 6, status="lost", ms=1000)
        ranks = wordle.rank_round({"quick": quick, "hard": hard, "soft": soft, "lost": lost})
        self.assertEqual(ranks, {"quick": 1, "hard": 2, "soft": 3, "lost": 4})

    def test_equal_games_share_a_rank_and_breaking_hard_rules_is_not_an_extra_guess(self):
        a = game("2026-11-20", HARD, ms=50000)
        b = game("2026-11-20", HARD, ms=50000)
        self.assertEqual(wordle.rank_round({"a": a, "b": b}), {"a": 1, "b": 1})
        four_hard = game("2026-11-20", ["alley", "ample", "ample", "apple"])
        three_soft = game("2026-11-20", SOFT)
        self.assertEqual(wordle.rank_round({"hard": four_hard, "soft": three_soft}), {"hard": 2, "soft": 1})


class InsightTests(TestCase):
    today = date(2026, 11, 24)

    def test_rounds_streak_recap_and_personal_averages(self):
        finished = table(
            a=[game("2026-11-22", HARD, ms=90000, times=(20000, 30000, 40000)),
               game("2026-11-23", ["alley", "apple"], ms=40000, times=(15000, 25000)),
               game("2026-11-24", ["apple"], ms=5000)],
            b=[game("2026-11-22", SOFT, ms=30000),
               game("2026-11-23", ["alley"] * 6, status="lost", ms=120000),
               game("2026-11-24", ["alley", "apple"], ms=9000)],
            c=[game("2026-11-23", ["alley", "ample", "apple"], ms=70000)])
        insight = wordle.WordPuzzles.insights(self.today, PEOPLE, finished)
        a, b, c = (insight["members"][key] for key in "abc")
        # 22 Nov: Ana (hard) beats Bela on the hard-rule tie. 23 Nov: Ana beats Csilla; Bela lost. Today is not a round yet.
        self.assertEqual((a["rounds_won"], a["rounds_played"]), (2, 2))
        self.assertEqual((b["rounds_won"], b["rounds_played"]), (0, 2))
        self.assertEqual((c["rounds_won"], c["rounds_played"]), (0, 1))
        self.assertEqual(insight["family"], {"current_streak": 3, "best_streak": 3, "rounds": 2})
        self.assertEqual(a["win_percent"], 100)
        self.assertEqual(a["average_guesses"], 2.0)
        self.assertEqual(b["win_percent"], 67)
        self.assertEqual(a["average_ms_per_guess"], round((20000 + 30000 + 40000 + 15000 + 25000 + 5000) / 6))
        self.assertEqual(a["slowest_word"], {"word": "apple", "ms": 40000, "date": "2026-11-22"})
        self.assertEqual((a["longest_game"]["ms"], a["shortest_game"]["ms"]), (90000, 5000))
        self.assertEqual((b["hard_played"], b["hard_won"], b["hard_clear_percent"]), (2, 1, 50))
        recap = insight["recap"]
        self.assertEqual((recap["date"], recap["answer"], recap["missed"]), ("2026-11-23", "apple", []))
        self.assertEqual([(row["name"], row["rank"], row["winner"]) for row in recap["results"]],
                         [("Ana", 1, True), ("Csilla", 2, False), ("Bela", 3, False)])

    def test_family_streak_ends_after_a_day_nobody_solves(self):
        finished = table(a=[game("2026-11-21", HARD), game("2026-11-22", ["alley"] * 6, status="lost")],
                         b=[game("2026-11-21", HARD)])
        insight = wordle.WordPuzzles.insights(self.today, PEOPLE, finished)
        self.assertEqual((insight["family"]["current_streak"], insight["family"]["best_streak"]), (0, 1))
        self.assertIsNone(insight["recap"])
