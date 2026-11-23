"""Slow disk regression tests for the hot state HTTP routes."""
from datetime import date
from pathlib import Path
import sqlite3
from threading import Event
from time import monotonic, sleep
from unittest.mock import Mock, patch

from tests.test_music_web import Base

from music_web import create_app, wordle


class HotStateTests(Base):
    extra = {'FAMILY_PROFILES': True, 'STATUS_SNAPSHOTS': False}
    day = date(2026, 11, 23)

    def setUp(self):
        self.answer = Mock(return_value='apple')
        self.extra = {**self.extra, 'WORDLE_DAILY_ANSWER': self.answer}
        self.enterContext(patch.object(wordle, 'current_day', return_value=self.day))
        super().setUp()

    def select(self):
        client = self.app.test_client()
        bootstrap = self.go(client, 'GET', '/api/connect')
        response = self.post(client, bootstrap.json['csrf_token'], '/api/profile/select',
                             json={'profile_id': 'sample-a'})
        self.assertEqual(response.status_code, 200)
        return client, {'X-CSRFToken': response.json['csrf_token']}

    def read(self, client, path, select, *, fast=False):
        start = monotonic()
        response = self.go(client, 'GET', path)
        if fast:
            self.assertLess(monotonic() - start, .1, path)
        self.assertEqual(response.status_code, 200)
        return select(response.json)

    def exercise(self, path, select, old, new, method, write_path, payload, matches, *, wordle_db=False):
        client, headers = self.select()
        self.assertEqual(self.read(client, path, select), old)
        entered, failed = Event(), Event()
        original_open, original_replace, original_connect = Path.open, Path.replace, sqlite3.connect

        def stall(error):
            if not entered.is_set():
                entered.set()
                sleep(6)
                failed.set()
                raise error('Simulated disk failure after a stalled write')

        def slow_open(file, mode='r', *args, **kwargs):
            if matches(file):
                if mode.startswith('r'):
                    sleep(6)
                else:
                    stall(OSError)
            return original_open(file, mode, *args, **kwargs)

        def slow_replace(file, target):
            if matches(Path(target)):
                stall(OSError)
            return original_replace(file, target)

        def slow_connect(database, *args, **kwargs):
            if wordle_db and matches(Path(database)):
                if entered.is_set() and not failed.is_set():
                    sleep(6)
                else:
                    stall(sqlite3.OperationalError)
            return original_connect(database, *args, **kwargs)

        with (patch.object(Path, 'open', slow_open), patch.object(Path, 'replace', slow_replace),
              patch.object(sqlite3, 'connect', slow_connect),
              self.assertLogs('music_web.state', level='WARNING') as logs):
            try:
                start = monotonic()
                response = self.go(client, method, write_path, headers=headers, json=payload)
                self.assertLess(monotonic() - start, 3.5, write_path)
                self.assertLess(response.status_code, 300, response.json)
                self.assertTrue(entered.is_set())
                self.assertFalse(failed.is_set())
                self.assertEqual(self.read(client, path, select, fast=True), new)
                if wordle_db:
                    self.assertEqual(self.read(client, '/api/wordle/stats',
                                               lambda data: data['personal']['won'], fast=True), 1)
                self.assertFalse(failed.is_set())
            finally:
                self.state.close_state()
        self.assertTrue(any('Retrying' in line for line in logs.output))
        self.app = create_app(self.settings)
        self.addCleanup(self.app.extensions['music'].close_state)
        client, _ = self.select()
        self.assertEqual(self.read(client, path, select), new)

    def test_wordle_today_and_stats_survive_slow_sqlite(self):
        self.exercise('/api/wordle/today', lambda data: data['status'], 'playing', 'won',
                      'POST', '/api/wordle/guess',
                      {'date': self.day.isoformat(), 'word': 'apple', 'guess_count': 0},
                      lambda file: file.name == '.word-puzzles.sqlite3', wordle_db=True)
        client, _ = self.select()
        self.assertEqual(self.read(client, '/api/wordle/stats', lambda data: data['personal']['won']), 1)
        self.answer.assert_called_once_with(self.day)

    def test_profiles_survive_slow_json(self):
        self.exercise('/api/connect', lambda data: data['profiles'][0]['name'], 'sample-a', 'Alex',
                      'PATCH', '/api/profile/name', {'name': 'Alex'},
                      lambda file: file.name == '.family-profiles.json')

    def test_preferences_survive_slow_json(self):
        self.exercise('/api/profile/preferences', lambda data: data['preferences']['shuffle'], False, True,
                      'PATCH', '/api/profile/preferences', {'shuffle': True},
                      lambda file: file.name == '.family-profiles.json')

    def test_playback_survives_slow_json(self):
        self.exercise('/api/profile/playback', lambda data: (data['playback'] or {}).get('position'), None, 25,
                      'PUT', '/api/profile/playback',
                      {'profile_id': 'sample-a', 'playback': {'track_ids': ['abcdefghijk'], 'index': 0, 'position': 25}},
                      lambda file: file.parent.name == '.playback-state' and file.suffix == '.json')

    def test_listening_counters_survive_slow_journal(self):
        day = self.app.extensions['listening_history'].utc().date().isoformat()
        self.exercise('/api/server/stats', lambda data: data['total_seconds'], 0, 60,
                      'POST', '/api/playback/activity',
                      {'device_id': 'a' * 32, 'playing': True,
                       'counters': [{'day': day, 'seconds': 60, 'plays': 1}]},
                      lambda file: file.name in {'.listening-statistics.json', '.listening-statistics.jsonl'})
