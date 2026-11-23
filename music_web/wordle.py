"""Daily Our Word puzzles and profile-scoped results."""
from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
import hashlib
import json
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


@lru_cache(maxsize=128)
def analyze_guesses(guesses, answer):
    candidates = accepted_guesses() | {answer}
    remaining = []
    verdict = None
    for index, guess in enumerate(guesses):
        before = len(candidates)
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
    return tuple(remaining), verdict


def review(guesses, answer):
    remaining, verdict = analyze_guesses(tuple(guesses), answer)
    result = dict(remaining=remaining)
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
                    PRIMARY KEY (profile, day)
                );
                CREATE TABLE IF NOT EXISTS wordle_settings (
                    profile TEXT PRIMARY KEY,
                    hide_family_until_finished INTEGER NOT NULL
                );
            """)

            db.execute("BEGIN IMMEDIATE")
            if not any(column[1] == "active_ms" for column in db.execute("PRAGMA table_info(progress)")):
                db.execute("ALTER TABLE progress ADD COLUMN active_ms INTEGER")
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

    def play(self, profile, day, word=None, expected_guesses=None):
        key = day.isoformat()
        answer = self.answer(day, key, wait=word is None)
        if word is not None and word != answer and word not in accepted_guesses():
            raise self.error("That word is outside the guess list.")
        done = None
        with self.activity_lock:
            record = self.memory.execute("SELECT guesses, status, active_ms FROM progress WHERE profile = ? AND day = ?",
                                (profile, key)).fetchone()
            guesses, status, active_ms = (json.loads(record[0]), record[1], record[2]) if record else ([], "playing", None)
            if word is not None and expected_guesses != len(guesses):
                if type(expected_guesses) is not int or not 0 <= expected_guesses < len(guesses) or guesses[expected_guesses] != word:
                    raise self.error("This puzzle changed on another device. Refresh and try again.", 409)
            elif word is not None:
                if status != "playing":
                    raise self.error("You've finished today's puzzle.", 409)
                if word in guesses:
                    raise self.error("Already guessed.")
                guesses.append(word)
                status = "won" if word == answer else "lost" if len(guesses) == MAX_GUESSES else "playing"
                activity = self.activity.get(profile)
                if status != "playing" and activity and activity.day == key:
                    elapsed = self.elapsed(activity, monotonic())
                    if elapsed:
                        active_ms = (active_ms or 0) + elapsed
                done = self._write("""
                    INSERT INTO progress (profile, day, guesses, guess_count, status, active_ms) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(profile, day) DO UPDATE SET
                        guesses=excluded.guesses, guess_count=excluded.guess_count, status=excluded.status,
                        active_ms=excluded.active_ms
                    """, (profile, key, json.dumps(guesses), len(guesses), status, active_ms))
                if status != "playing" and activity and activity.day == key:
                    del self.activity[profile]
        wait_for_write(done)
        result = dict(date=key, next_reset=next_reset(day), status=status,
                      max_guesses=MAX_GUESSES, word_length=WORD_LENGTH,
                      guesses=[dict(word=guess, marks=marks_for(guess, answer)) for guess in guesses])
        if status != "playing":
            result["answer"] = answer
            result["active_ms"] = active_ms
            result["review"] = review(guesses, answer)
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
                SELECT profile, guesses, answer, status, active_ms FROM progress
                JOIN puzzle USING(day) WHERE day = ?
                """, (key,))
            boards = {owner: (json.loads(guesses), answer, status, active_ms)
                      for owner, guesses, answer, status, active_ms in records if not hide or owner == profile}
            now = monotonic()
            active = {owner: view for owner, view in self.activity.items()
                      if view.day == key and now - view.seen < ACTIVITY_TIMEOUT}
        family = []
        for person in profiles:
            owner = person["id"]
            if hide and owner != profile:
                continue
            guesses, answer, status, active_ms = boards.get(owner, ([], None, "playing", None))
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
                    entry["review"] = review(guesses, answer)
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
                if row is None or expired or now - before.checkpoint >= TIME_CHECKPOINT:
                    elapsed = self.elapsed(before, now)
                    if elapsed:
                        done = self._write("""
                            INSERT INTO progress (profile, day, guesses, guess_count, status, active_ms)
                            SELECT ?, day, '[]', 0, 'playing', ? FROM puzzle WHERE day = ?
                            ON CONFLICT(profile, day) DO UPDATE SET
                                active_ms=COALESCE(progress.active_ms, 0) + excluded.active_ms
                            WHERE progress.status = 'playing'
                            """, (profile, elapsed, day))
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
        favorites = defaultdict(list)
        with self.activity_lock:
            db = self.memory
            reveal = self.finished(db, profile, key)
            hide = not reveal and self.hides_family(db, profile)
            for owner, result_day, status, guesses in db.execute("""
                SELECT profile, day, status, guess_count FROM progress
                WHERE status != 'playing' AND day <= ? ORDER BY day
                """, (key,)):
                if not hide or owner == profile or result_day != key:
                    results[owner].append((result_day, status, guesses))
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
                    family_totals=family_totals, history=history)


def register(app, workspace, require_family, profiles, body, api_error, daily_answer=None, *, writer=None):
    answer_for = daily_answer if daily_answer is not None else lambda day: choose_answer(day, app.secret_key)
    puzzles = WordPuzzles(workspace, answer_for, api_error, writer)

    @app.get("/api/wordle/today")
    def wordle_today():
        require_family()
        day = current_day()
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
        return jsonify(puzzles.play(g.user, day, word.strip().lower(), expected))

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
