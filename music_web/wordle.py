"""Daily Our Word puzzles and profile-scoped results."""
from collections import Counter, defaultdict
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
import hashlib
import json
from math import log2
from pathlib import Path
import re
from threading import Lock, RLock
from time import monotonic
import sqlite3
from zoneinfo import ZoneInfo

from flask import g, jsonify, request

from .state import StateWriter, state_path, wait_for_write


WORD_LENGTH = 5
MAX_GUESSES = 6
ACTIVITY_TIMEOUT = 12
TIME_CHECKPOINT = 4
DATA = Path(__file__).with_name("wordle_data")
ONE_DAY = timedelta(days=1)
BUDAPEST = "Europe/Budapest"


@lru_cache(maxsize=2)
def words(name):
    return tuple((DATA / f"{name}.txt").read_text(encoding="ascii").split())


@lru_cache(maxsize=1)
def accepted_guesses():
    return frozenset(words("guesses"))


def current_day():
    return datetime.now(ZoneInfo(BUDAPEST)).date()


def next_reset(day):
    return datetime.combine(day + ONE_DAY, time.min, ZoneInfo(BUDAPEST)).astimezone(timezone.utc).isoformat()


def choose_answer(day, seed):
    # Match Our Word's deterministic household deck and daily indexing.
    deck = list(words("answers"))
    state = int.from_bytes(hashlib.sha256(f"{seed}:en:5".encode()).digest()[:4], "little") or 1
    for index in range(len(deck) - 1, 0, -1):
        state ^= (state << 13) & 0xffffffff
        state ^= state >> 17
        state ^= (state << 5) & 0xffffffff
        slot = state % (index + 1)
        deck[index], deck[slot] = deck[slot], deck[index]
    return deck[(day - date(1970, 1, 1)).days % len(deck)]


def marks_for(word, answer):
    remaining = list(answer)
    marks = ["absent"] * WORD_LENGTH
    for index, letter in enumerate(word):
        if letter == remaining[index]:
            marks[index] = "correct"
            remaining[index] = None
    for index, letter in enumerate(word):
        if marks[index] == "absent" and letter in remaining:
            marks[index] = "present"
            remaining[remaining.index(letter)] = None
    return marks


EMPTY_CLUES = ("." * WORD_LENGTH, ())


def keep_clues(word, clues):
    greens, required = clues
    return all(green == "." or word[i] == green for i, green in enumerate(greens)) and all(
        word.count(letter) >= count for letter, count in required)


def add_clues(clues, guess, marks):
    greens, required = clues
    found = Counter(letter for letter, mark in zip(guess, marks) if mark != "absent")
    greens = "".join(letter if mark == "correct" else green
                     for green, letter, mark in zip(greens, guess, marks))
    return greens, tuple(sorted((Counter(dict(required)) | found).items()))


def hard_clue_history(guesses, answer):
    clues = EMPTY_CLUES
    history = []
    for guess in guesses:
        if not keep_clues(guess, clues):
            return None
        history.append(clues)
        clues = add_clues(clues, guess, marks_for(guess, answer))
    return tuple(history) if any(clues != EMPTY_CLUES for clues in history) else None


def legal_guesses(clues):
    pool = accepted_guesses()
    return frozenset(word for word in pool if keep_clues(word, clues)) if clues else pool


@lru_cache(maxsize=128)
def analyze_guesses(guesses, answer):
    candidates = accepted_guesses() | {answer}
    remaining = []
    grades = []
    verdict = None
    hard_history = hard_clue_history(guesses, answer)
    for index, guess in enumerate(guesses):
        before = len(candidates)
        clues = hard_history[index] if hard_history else None
        grades.append(grade_guess(tuple(sorted(candidates)), guess, MAX_GUESSES - index, clues))
        if guess == answer:
            if before >= 10:
                verdict = ("lucky", before)
            remaining.append(0)
            break
        if index == MAX_GUESSES - 1 and before > 1 and guess in candidates:
            verdict = ("unlucky", before)
        marks = marks_for(guess, answer)
        candidates = {candidate for candidate in candidates if marks_for(guess, candidate) == marks}
        remaining.append(len(candidates))
    return tuple(remaining), verdict, tuple(grades), hard_history is not None


BOOK_OPENERS = frozenset(("adieu", "arise", "crate", "raise", "slate", "stare", "trace"))


def feedback_groups(guess, candidates):
    groups = defaultdict(int)
    for index, candidate in enumerate(candidates):
        groups[tuple(marks_for(guess, candidate))] |= 1 << index
    return groups


def information(guess, candidates):
    sizes = (group.bit_count() for group in feedback_groups(guess, candidates).values())
    return log2(len(candidates)) - sum(size * log2(size) for size in sizes) / len(candidates)


@lru_cache(maxsize=256)
def information_baseline(candidates, clues):
    # A deterministic sample keeps opening analysis bounded on the result request.
    sample = candidates[::max(1, (len(candidates) + 255) // 256)]
    letters = Counter(letter for word in candidates for letter in set(word))
    pool = legal_guesses(clues) | set(candidates)
    shortlist = sorted(pool, key=lambda word: (-sum(letters[c] for c in set(word)), word))[:96]
    if len(candidates) <= 256:
        shortlist = set(shortlist) | set(candidates)
    best = max(shortlist, key=lambda word: (information(word, sample), word in candidates, word))
    return best, information(best, sample), sample


@lru_cache(maxsize=16)
def endgame(candidates, turns, clues):
    if turns == 1:
        return dict.fromkeys(candidates, 1)

    # Each bit represents an answer. A final guess can solve one answer per feedback group.
    pool = legal_guesses(clues) | set(candidates)
    partitions = {}
    wins = {}
    for word in sorted(pool):
        groups = feedback_groups(word, candidates)
        solved = groups.pop(("correct",) * WORD_LENGTH, 0)
        if turns == 3:
            partitions[word] = (solved, groups)
        wins[word] = bool(solved) + len(groups)
    if turns == 2:
        return wins

    splits = {word: (solved, tuple(sorted(groups.values()))) for word, (solved, groups) in partitions.items()}
    open_splits = set(splits.values())

    @lru_cache(maxsize=None)
    def best_second(group, next_clues):
        size = group.bit_count()
        if size <= 2:
            return size
        best = 1
        choices = (split for word, split in splits.items() if keep_clues(word, next_clues)) if next_clues else open_splits
        for solved, branches in choices:
            best = max(best, bool(solved & group) + sum(bool(branch & group) for branch in branches))
            if best == size:
                break
        return best

    for word, (solved, branches) in partitions.items():
        wins[word] = bool(solved) + sum(
            best_second(branch, add_clues(clues, word, marks) if clues else None)
            for marks, branch in branches.items())
    return wins


def grade_guess(candidates, guess, turns, clues=None):
    count = len(candidates)
    if count == 1:
        best = candidates[0]
        return ("best", None) if guess == best else ("miss" if turns > 1 else "blunder", best)
    if turns == 1 or (turns == 2 and count <= 256) or (turns == 3 and count <= 12):
        wins = endgame(candidates, turns, clues)
        best = max(wins, key=lambda word: (wins[word], word in candidates, word))
        possible = wins.get(guess, 0)
        if turns == 1 and possible == 0:
            return "blunder", best
        if possible == count and guess not in candidates and not any(wins[word] == count for word in candidates):
            return "brilliant", None
        if possible == count and sum(result == count for result in wins.values()) <= 3:
            return "great", None
        if wins[best] == count and possible / count <= 0.8:
            return "miss", best
        loss = (wins[best] - possible) / count
    else:
        best, benchmark, sample = information_baseline(candidates, clues)
        score = information(guess, sample)
        if turns == MAX_GUESSES and guess in BOOK_OPENERS and score >= benchmark * 0.82:
            return "book", None
        loss = (benchmark - score) / benchmark if benchmark else 0

    if loss <= 0.000001:
        return "best", None
    for limit, grade in ((0.05, "excellent"), (0.15, "good"), (0.30, "inaccuracy"), (0.55, "mistake")):
        if loss <= limit:
            return grade, best
    return "blunder", best


def review(guesses, answer, guess_times=None):
    remaining, verdict, grades, hard_rules = analyze_guesses(tuple(guesses), answer)
    result = dict(remaining=remaining, grades=[dict(kind=kind, better=better) for kind, better in grades])
    if hard_rules:
        result["hard_rules"] = True
    if guess_times:
        result["guess_times_ms"] = guess_times
    if verdict:
        result.update(outcome=verdict[0], final_options=verdict[1])
    return result


@dataclass(frozen=True)
class ActiveView:
    view: str
    day: str
    row: int
    count: int
    checkpoint: float
    seen: float


def summarize(results, today):
    distribution = [0] * MAX_GUESSES
    won_days = set()
    best = run = 0
    prior = None
    for day, status, guesses in results:
        if status != "won":
            continue
        day = date.fromisoformat(day)
        won_days.add(day)
        distribution[guesses - 1] += 1
        run = run + 1 if prior and day - prior == ONE_DAY else 1
        best = max(best, run)
        prior = day
    current = 0
    lost_today = any(day == today.isoformat() and status == "lost" for day, status, _ in results)
    cursor = today if today in won_days or lost_today else today - ONE_DAY
    while cursor in won_days:
        current += 1
        cursor -= ONE_DAY
    return dict(played=len(results), won=len(won_days), current_streak=current,
                best_streak=best, distribution=distribution)


def followed_hard_rules(guesses, answer):
    """True when every guess reused all greens and yellows revealed so far, as Hard Mode requires."""
    clues = EMPTY_CLUES
    for guess in guesses:
        if not keep_clues(guess, clues):
            return False
        clues = add_clues(clues, guess, marks_for(guess, answer))
    return True


@dataclass(frozen=True)
class Finished:
    day: str
    status: str
    guesses: tuple
    answer: str
    active_ms: int | None
    times: tuple
    hard: bool


def round_key(result):
    """Lower wins: fewer guesses, then a game played by Hard Mode rules, then less active time.

    Breaking the Hard Mode rules only loses a tie on guesses. Counting it as an extra guess instead would let a
    five-guess Hard Mode game beat a four-guess game, which the ordinary rules allow.
    """
    return (len(result.guesses), 0 if result.hard else 1,
            result.active_ms if result.active_ms is not None else float("inf"))


def rank_round(results):
    """Rank one day's finished games: solved games by round_key, then unsolved games level at the bottom."""
    keys = {owner: (0, *round_key(result)) if result.status == "won" else (1,) for owner, result in results.items()}
    return {owner: 1 + sum(other < key for other in keys.values()) for owner, key in keys.items()}


def average(values, digits=1):
    return round(sum(values) / len(values), digits) if values else None


def member_insights(games, rounds_won, rounds_played):
    won = [game for game in games if game.status == "won"]
    guess_times = []
    slowest = None
    for game in games:
        known = [(ms, word) for ms, word in zip(game.times, game.guesses) if isinstance(ms, (int, float)) and ms >= 0]
        if known:
            guess_times.extend(ms for ms, _ in known)
            longest_guess = max(known)
            if slowest is None or longest_guess[0] > slowest["ms"]:
                slowest = dict(word=longest_guess[1], ms=int(longest_guess[0]), date=game.day)
        elif game.active_ms and game.guesses:
            guess_times.extend([game.active_ms / len(game.guesses)] * len(game.guesses))
    timed = [game for game in games if game.active_ms]
    hard = [game for game in games if game.hard]
    hard_won = sum(game.status == "won" for game in hard)
    longest = max(timed, key=lambda game: game.active_ms, default=None)
    fastest_win = min((game for game in won if game.active_ms), key=lambda game: game.active_ms, default=None)
    return dict(
        win_percent=round(100 * len(won) / len(games)) if games else None,
        average_guesses=average([len(game.guesses) for game in won]),
        hard_played=len(hard), hard_won=hard_won,
        hard_clear_percent=round(100 * hard_won / len(hard)) if hard else None,
        average_ms_per_guess=round(sum(guess_times) / len(guess_times)) if guess_times else None,
        average_ms_per_game=round(sum(game.active_ms for game in timed) / len(timed)) if timed else None,
        longest_game=dict(ms=longest.active_ms, date=longest.day) if longest else None,
        shortest_game=dict(ms=fastest_win.active_ms, date=fastest_win.day) if fastest_win else None,
        slowest_word=slowest, rounds_won=rounds_won, rounds_played=rounds_played)


class WordPuzzles:
    def __init__(self, workspace, answer_for, error, writer=None):
        self.database = state_path(workspace, ".word-puzzles.sqlite3")
        self.writer = writer or StateWriter()
        self.memory = sqlite3.connect(":memory:", check_same_thread=False)
        self.answer_lock = Lock()
        self.answer_for = answer_for
        self.error = error
        self.activity = {}
        self.activity_lock = RLock()
        with closing(self.connect()) as db, db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS puzzle (
                    day TEXT PRIMARY KEY,
                    answer TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS progress (
                    profile TEXT NOT NULL,
                    day TEXT NOT NULL REFERENCES puzzle(day),
                    guesses TEXT NOT NULL,
                    guess_count INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    active_ms INTEGER,
                    guess_times_ms TEXT,
                    row_active_ms INTEGER,
                    PRIMARY KEY (profile, day)
                );
                CREATE TABLE IF NOT EXISTS wordle_settings (
                    profile TEXT PRIMARY KEY,
                    hide_family_until_finished INTEGER NOT NULL
                );
            """)

            db.execute("BEGIN IMMEDIATE")
            columns = {column[1] for column in db.execute("PRAGMA table_info(progress)")}
            if "active_ms" not in columns:
                db.execute("ALTER TABLE progress ADD COLUMN active_ms INTEGER")
            if "guess_times_ms" not in columns:
                db.execute("ALTER TABLE progress ADD COLUMN guess_times_ms TEXT")
            if "row_active_ms" not in columns:
                db.execute("ALTER TABLE progress ADD COLUMN row_active_ms INTEGER")
            active = db.execute("SELECT profile, day, guesses FROM progress WHERE day = ? AND status = 'playing'",
                                (current_day().isoformat(),)).fetchall()
            for profile, day, raw in active:
                guesses = json.loads(raw)
                unique = list(dict.fromkeys(guesses))
                if len(unique) < len(guesses):
                    db.execute("UPDATE progress SET guesses = ?, guess_count = ? WHERE profile = ? AND day = ?",
                               (json.dumps(unique), len(unique), profile, day))

            db.commit()
            db.backup(self.memory)

    def connect(self):
        return sqlite3.connect(self.database, timeout=5)

    def _write(self, statement, values):
        with self.memory:
            self.memory.execute(statement, values)

        def persist():
            with closing(self.connect()) as db, db:
                db.execute(statement, values)

        return self.writer.submit(self.database.name, persist)

    def answer(self, day, key, *, wait=True):
        statement = "SELECT answer FROM puzzle WHERE day = ?"
        with self.activity_lock:
            known = self.memory.execute(statement, (key,)).fetchone()
        if known:
            return known[0]
        with self.answer_lock:
            with self.activity_lock:
                known = self.memory.execute(statement, (key,)).fetchone()
            if known:
                return known[0]
            candidate = self.answer_for(day)
            if not isinstance(candidate, str) or not re.fullmatch("[a-z]{5}", candidate):
                raise self.error("Today's puzzle is unavailable. Try again later.", 503)
            with self.activity_lock:
                done = self._write("INSERT OR IGNORE INTO puzzle VALUES (?, ?)", (key, candidate))
        if wait:
            wait_for_write(done)
        return candidate

    def play(self, profile, day, word=None, expected_guesses=None, measured_ms=None):
        key = day.isoformat()
        answer = self.answer(day, key, wait=word is None)
        if word is not None and word != answer and word not in accepted_guesses():
            raise self.error("That word is outside the guess list.")
        done = None
        with self.activity_lock:
            record = self.memory.execute("""
                SELECT guesses, status, active_ms, guess_times_ms, row_active_ms
                FROM progress WHERE profile = ? AND day = ?
                """, (profile, key)).fetchone()
            guesses, status, active_ms, raw_times, row_active_ms = (
                (json.loads(record[0]), *record[1:]) if record else ([], "playing", None, None, None))
            guess_times = json.loads(raw_times) if raw_times else []
            if word is not None and expected_guesses != len(guesses):
                if type(expected_guesses) is not int or not 0 <= expected_guesses < len(guesses) or guesses[expected_guesses] != word:
                    raise self.error("This puzzle changed on another device. Refresh and try again.", 409)
            elif word is not None:
                if status != "playing":
                    raise self.error("You've finished today's puzzle.", 409)
                if word in guesses:
                    raise self.error("Already guessed.")
                activity = self.activity.get(profile)
                now = monotonic()
                current_view = activity and activity.day == key and activity.row == len(guesses)
                elapsed = self.elapsed(activity, now) if current_view else None
                if measured_ms is None and (row_active_ms is not None or elapsed is not None):
                    measured_ms = (row_active_ms or 0) + (elapsed or 0)
                if measured_ms is not None:
                    active_ms = (active_ms or 0) - (row_active_ms or 0) + measured_ms
                guess_times.extend([None] * (len(guesses) - len(guess_times)))
                guess_times.append(measured_ms)
                guesses.append(word)
                status = "won" if word == answer else "lost" if len(guesses) == MAX_GUESSES else "playing"
                done = self._write("""
                    INSERT INTO progress (profile, day, guesses, guess_count, status, active_ms, guess_times_ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(profile, day) DO UPDATE SET
                        guesses=excluded.guesses, guess_count=excluded.guess_count, status=excluded.status,
                        active_ms=excluded.active_ms, guess_times_ms=excluded.guess_times_ms, row_active_ms=NULL
                    """, (profile, key, json.dumps(guesses), len(guesses), status, active_ms, json.dumps(guess_times)))
                if activity and activity.day == key:
                    if status != "playing":
                        del self.activity[profile]
                    elif current_view and now - activity.seen < ACTIVITY_TIMEOUT:
                        self.activity[profile] = ActiveView(activity.view, key, len(guesses), 0, now, activity.seen)
        wait_for_write(done)
        result = dict(date=key, next_reset=next_reset(day), status=status,
                      max_guesses=MAX_GUESSES, word_length=WORD_LENGTH,
                      guesses=[dict(word=guess, marks=marks_for(guess, answer)) for guess in guesses])
        if status != "playing":
            result["answer"] = answer
            result["active_ms"] = active_ms
            result["review"] = review(guesses, answer, guess_times)
        return result

    def settings(self, profile, hide=None):
        done = None
        with self.activity_lock:
            if hide is not None:
                done = self._write("""
                    INSERT INTO wordle_settings VALUES (?, ?)
                    ON CONFLICT(profile) DO UPDATE SET hide_family_until_finished=excluded.hide_family_until_finished
                """, (profile, hide))
            else:
                hide = self.hides_family(self.memory, profile)
        wait_for_write(done)
        return dict(hide_family_until_finished=hide)

    @staticmethod
    def hides_family(db, profile):
        row = db.execute("SELECT hide_family_until_finished FROM wordle_settings WHERE profile = ?", (profile,)).fetchone()
        return bool(row and row[0])

    @staticmethod
    def finished(db, profile, day):
        row = db.execute("SELECT status FROM progress WHERE profile = ? AND day = ?", (profile, day)).fetchone()
        return bool(row and row[0] in ("won", "lost"))

    def family_boards(self, profile, day, profiles):
        key = day.isoformat()
        with self.activity_lock:
            db = self.memory
            reveal = self.finished(db, profile, key)
            hide = not reveal and self.hides_family(db, profile)
            records = db.execute("""
                SELECT profile, guesses, answer, status, active_ms, guess_times_ms FROM progress
                JOIN puzzle USING(day) WHERE day = ?
                """, (key,))
            boards = {owner: (json.loads(guesses), answer, status, active_ms, raw_times)
                      for owner, guesses, answer, status, active_ms, raw_times in records if not hide or owner == profile}
            now = monotonic()
            active = {owner: view for owner, view in self.activity.items()
                      if view.day == key and now - view.seen < ACTIVITY_TIMEOUT}
        family = []
        for person in profiles:
            owner = person["id"]
            if hide and owner != profile:
                continue
            guesses, answer, status, active_ms, raw_times = boards.get(owner, ([], None, "playing", None, None))
            rows = [marks_for(word, answer) for word in guesses]
            entry = dict(id=owner, name=person["name"], rows=rows)
            if status == "playing" and owner in active:
                view = active[owner]
                entry.update(playing=True, draft_count=view.count if view.row == len(guesses) else 0)
            if reveal or owner == profile:
                entry["guesses"] = [dict(word=word, marks=marks) for word, marks in zip(guesses, rows)]
            if status != "playing":
                entry["active_ms"] = active_ms
                if reveal:
                    entry["review"] = review(guesses, answer, json.loads(raw_times) if raw_times else None)
            family.append(entry)
        return family

    def set_activity(self, profile, view, day, row, count):
        done = None
        with self.activity_lock:
            before = self.activity.get(profile)
            same_day = before is not None and before.day == day
            if row is None and (not same_day or before.view != view):
                return
            if not same_day and self.finished(self.memory, profile, day):
                return
            now = monotonic()
            checkpoint = now
            if same_day:
                expired = now - before.seen >= ACTIVITY_TIMEOUT
                if row is None or row != before.row or expired or now - before.checkpoint >= TIME_CHECKPOINT:
                    elapsed = self.elapsed(before, now)
                    if elapsed:
                        done = self._write("""
                            INSERT INTO progress (profile, day, guesses, guess_count, status, active_ms, row_active_ms)
                            SELECT ?, day, '[]', 0, 'playing', ?, ? FROM puzzle WHERE day = ?
                            ON CONFLICT(profile, day) DO UPDATE SET
                                active_ms=COALESCE(progress.active_ms, 0) + excluded.active_ms,
                                row_active_ms=COALESCE(progress.row_active_ms, 0) + excluded.row_active_ms
                            WHERE progress.status = 'playing' AND progress.guess_count = ?
                            """, (profile, elapsed, elapsed, day, before.row))
                else:
                    checkpoint = before.checkpoint
            if row is not None:
                self.activity[profile] = ActiveView(view, day, row, count, checkpoint, now)
            else:
                del self.activity[profile]
        wait_for_write(done)

    @staticmethod
    def elapsed(view, now):
        # A stale view stopped sending evidence of play at its last heartbeat.
        through = now if now - view.seen < ACTIVITY_TIMEOUT else view.seen
        return max(0, round((through - view.checkpoint) * 1000))

    def stats(self, profile, day, profiles):
        key = day.isoformat()
        results = defaultdict(list)
        finished = defaultdict(list)
        favorites = defaultdict(list)
        with self.activity_lock:
            db = self.memory
            reveal = self.finished(db, profile, key)
            hide = not reveal and self.hides_family(db, profile)
            for owner, result_day, status, guesses, answer, active_ms, raw_times in db.execute("""
                SELECT progress.profile, progress.day, progress.status, progress.guesses, puzzle.answer,
                       progress.active_ms, progress.guess_times_ms
                FROM progress JOIN puzzle USING(day)
                WHERE progress.status != 'playing' AND progress.day <= ? ORDER BY progress.day
                """, (key,)):
                if hide and owner != profile and result_day == key:
                    continue
                words = tuple(json.loads(guesses))
                results[owner].append((result_day, status, len(words)))
                finished[owner].append(Finished(result_day, status, words, answer, active_ms,
                                                tuple(json.loads(raw_times)) if raw_times else (),
                                                followed_hard_rules(words, answer)))
            for owner, word, count in db.execute("""
                SELECT progress.profile, value, count(*) FROM progress, json_each(progress.guesses)
                WHERE day < ? OR (day = ? AND (progress.profile = ? OR ?))
                GROUP BY progress.profile, value ORDER BY count(*) DESC, value
                """, (key, key, profile, reveal)):
                if len(favorites[owner]) < 10:
                    favorites[owner].append(dict(word=word, count=count))
        history = [dict(date=key, status=status, guesses=guesses)
                   for key, status, guesses in reversed(results[profile])]
        family = [dict(profile_id=p["id"], name=p["name"], favorite_guesses=favorites[p["id"]],
                       **summarize(results[p["id"]], day))
                  for p in profiles]
        today_results = [status for person in profiles for key, status, _ in results[person["id"]]
                         if key == day.isoformat()]
        family_totals = dict(played=sum(person["played"] for person in family),
                             won=sum(person["won"] for person in family),
                             distribution=[sum(person["distribution"][index] for person in family)
                                           for index in range(MAX_GUESSES)],
                             today=None if hide else dict(completed=len(today_results), won=today_results.count("won"),
                                                          members=len(family)))
        return dict(personal=summarize(results[profile], day), family=family,
                    family_totals=family_totals, history=history,
                    insights=self.insights(day, profiles, finished))

    @staticmethod
    def insights(day, profiles, finished):
        """Round results, streaks and averages. A round is a finished day with at least two players. Today is left
        out until the day ends, so nobody wins a round by finishing first."""
        today = day.isoformat()
        by_day = defaultdict(dict)
        for person in profiles:
            for game in finished[person["id"]]:
                by_day[game.day][person["id"]] = game
        rounds_won, rounds_played = Counter(), Counter()
        for round_day, games in by_day.items():
            if round_day >= today or len(games) < 2:
                continue
            ranks = rank_round(games)
            for owner in games:
                rounds_played[owner] += 1
                rounds_won[owner] += ranks[owner] == 1 and games[owner].status == "won"
        members = {person["id"]: member_insights(finished[person["id"]], rounds_won[person["id"]],
                                                 rounds_played[person["id"]]) for person in profiles}
        names = {person["id"]: person["name"] for person in profiles}
        solved_days = sorted(round_day for round_day, games in by_day.items()
                             if any(game.status == "won" for game in games.values()))
        streak = summarize([(round_day, "won", 1) for round_day in solved_days], day)
        recap = None
        yesterday = (day - ONE_DAY).isoformat()
        if yesterday in by_day:
            games = by_day[yesterday]
            ranks = rank_round(games)
            order = sorted(games, key=lambda owner: (ranks[owner], names[owner].casefold()))
            recap = dict(
                date=yesterday, answer=next(iter(games.values())).answer,
                missed=[names[person["id"]] for person in profiles if person["id"] not in games],
                results=[dict(profile_id=owner, name=names[owner], status=games[owner].status,
                              guesses=len(games[owner].guesses), active_ms=games[owner].active_ms,
                              hard=games[owner].hard, rank=ranks[owner],
                              winner=ranks[owner] == 1 and games[owner].status == "won" and len(games) > 1)
                         for owner in order])
        return dict(members=members,
                    family=dict(current_streak=streak["current_streak"], best_streak=streak["best_streak"],
                                rounds=sum(1 for round_day, games in by_day.items()
                                           if round_day < today and len(games) > 1)),
                    recap=recap)


def register(app, workspace, require_family, profiles, body, api_error, daily_answer=None, *, writer=None, playing=lambda user: None):
    answer_for = daily_answer if daily_answer is not None else lambda day: choose_answer(day, app.secret_key)
    puzzles = WordPuzzles(workspace, answer_for, api_error, writer)

    @app.get("/api/wordle/today")
    def wordle_today():
        require_family()
        day = current_day()
        playing(g.user)
        state = puzzles.play(g.user, day)
        if request.args.get("local") == "1":
            state["family"] = puzzles.family_boards(g.user, day, profiles.list())
            state["local_solution"] = puzzles.answer(day, day.isoformat())
        response = jsonify(state)
        response.cache_control.no_store = True
        return response

    @app.get("/api/wordle/family")
    def wordle_family():
        require_family()
        day = current_day()
        response = jsonify(date=day.isoformat(), family=puzzles.family_boards(g.user, day, profiles.list()))
        response.cache_control.no_store = True
        return response

    @app.put("/api/wordle/activity")
    def wordle_activity():
        require_family()
        data = body(limit=256)
        view, day, row, count = (data.get(key) for key in ("view", "date", "row", "draft_count"))
        if not isinstance(view, str) or not re.fullmatch("[a-f0-9]{32}", view):
            raise api_error("Invalid Wordle view.")
        if day != current_day().isoformat():
            raise api_error("The puzzle day changed. Open today's puzzle and try again.", 409)
        if (row is not None and (type(row) is not int or not 0 <= row < MAX_GUESSES)
                or type(count) is not int or not 0 <= count <= WORD_LENGTH):
            raise api_error("Invalid Wordle activity.")
        puzzles.set_activity(g.user, view, day, row, count)
        playing(g.user)
        return jsonify(ok=True)

    @app.post("/api/wordle/guess")
    def wordle_guess():
        require_family()
        day = current_day()
        data = body(limit=256)
        if data.get("date") != day.isoformat():
            raise api_error("The puzzle day changed. Open today's puzzle and try again.", 409)
        word = data.get("word")
        if not isinstance(word, str) or not re.fullmatch("[A-Za-z]{5}", word.strip()):
            raise api_error("Enter a five-letter English word.")
        expected = data.get("guess_count")
        if type(expected) is not int or not 0 <= expected <= MAX_GUESSES:
            raise api_error("Invalid guess count. Open today's puzzle and try again.")
        measured_ms = data.get("guess_active_ms")
        if measured_ms is not None and (type(measured_ms) is not int or not 0 <= measured_ms <= 25 * 60 * 60 * 1000):
            raise api_error("Invalid guess time.")
        playing(g.user)
        return jsonify(puzzles.play(g.user, day, word.strip().lower(), expected, measured_ms))

    @app.get("/api/wordle/stats")
    def wordle_stats():
        require_family()
        response = jsonify(puzzles.stats(g.user, current_day(), profiles.list()))
        response.cache_control.no_store = True
        return response

    @app.route("/api/wordle/settings", methods=["GET", "PUT"])
    def wordle_settings():
        require_family()
        hide = None
        if request.method == "PUT":
            hide = body(limit=256).get("hide_family_until_finished")
            if type(hide) is not bool:
                raise api_error("Choose whether to hide family results.")
        response = jsonify(puzzles.settings(g.user, hide))
        response.cache_control.no_store = True
        return response
