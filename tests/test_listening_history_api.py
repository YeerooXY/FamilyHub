"""Authenticated API tests use the existing offline Flask fixture."""
import test_family_profiles as family
from test_music_web import Base
from test_listening_history import HistoryStoreTests


class HistoryApiTests(Base):
    extra = {'FAMILY_PROFILES': True, 'ADMIN_USERS': ['sample-a']}
    bootstrap = family.FamilyProfiles.bootstrap
    select = family.FamilyProfiles.select

    def test_identity_access_pause_clear_and_csrf(self):
        admin, token = self.select()
        other, other_token = self.select('sample-b')
        fixture = HistoryStoreTests(); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        from datetime import datetime, timezone
        fixture.now = datetime.now(timezone.utc)
        event = fixture.event()
        response = self.post(other, other_token, '/api/listening/events', json={'events': [event]})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['added'], 1)
        self.assertEqual(self.post(other, other_token, '/api/listening/events', json={'events': [event]}).json['added'], 0)
        self.assertEqual(self.go(admin, 'GET', '/api/listening/summary').json['recent_history'], [])
        self.assertEqual(self.go(admin, 'GET', '/api/listening/summary?profile=sample-b').json['recent_history'], ['abcdefghijk'])
        self.assertEqual(len(self.go(admin, 'GET', '/api/listening/events?profile=sample-b').json['events']), 1)
        self.assertEqual(self.go(other, 'GET', '/api/listening/summary?profile=sample-a').status_code, 403)
        self.assertEqual(self.go(other, 'GET', '/api/listening/events?profile=sample-a').status_code, 403)
        self.assertEqual(self.go(other, 'GET', '/api/listening/events').status_code, 403)
        self.assertEqual(self.go(other, 'POST', '/api/listening/events', json={'events': [event]}).status_code, 400)
        self.assertEqual(self.post(other, other_token, '/api/listening/events', json={'events': [event], 'profile': 'sample-a'}).status_code, 400)
        paused = self.go(other, 'PATCH', '/api/profile/preferences', json={'listening_history_paused': True}, headers={'X-CSRFToken': other_token})
        self.assertEqual(paused.status_code, 200)
        result = self.post(other, other_token, '/api/listening/events', json={'events': [fixture.event()]}).json
        self.assertTrue(result['paused']); self.assertEqual(result['added'], 0)
        self.assertEqual(self.go(other, 'PATCH', '/api/profile/preferences', json={'listening_history_paused': 1}, headers={'X-CSRFToken': other_token}).status_code, 400)
        self.assertEqual(self.go(other, 'DELETE', '/api/listening/history?profile=sample-a', headers={'X-CSRFToken': other_token}).status_code, 200)
        self.assertEqual(self.go(other, 'GET', '/api/listening/summary').json['recent_history'], [])
        self.assertEqual(self.go(self.app.test_client(), 'GET', '/api/listening/summary').status_code, 401)
