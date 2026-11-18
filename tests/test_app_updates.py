import hashlib
import json
from pathlib import Path

from test_music_web import Base


class AppUpdates(Base):
    extra = {'FAMILY_PROFILES': True}

    def publish(self, **changes):
        directory = Path(self.ws) / '.app-updates' / 'windows-x64'
        directory.mkdir(parents=True, exist_ok=True)
        package = b'private application package'
        data = {'version': '0.1.1', 'sha256': hashlib.sha256(package).hexdigest(),
                'size': len(package), 'file': 'FamilyHub-Music-Windows-0.1.1.zip', **changes}
        (directory / 'FamilyHub-Music-Windows-0.1.1.zip').write_bytes(package)
        (directory / 'latest.json').write_text(json.dumps(data), encoding='utf-8')
        return data, package

    def test_profile_free_metadata_download_head_and_range(self):
        data, package = self.publish()
        client = self.app.test_client()
        manifest = self.go(client, 'GET', '/api/app-updates/windows-x64')
        self.assertEqual(manifest.status_code, 200)
        self.assertEqual(manifest.json['sha256'], data['sha256'])
        self.assertNotIn('file', manifest.json)
        url = manifest.json['download_url']
        with self.go(client, 'GET', url) as response:
            self.assertEqual(response.data, package)
        with self.go(client, 'GET', url, headers={'Range': 'bytes=2-5'}) as response:
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.data, package[2:6])
        with self.go(client, 'HEAD', url) as response:
            self.assertEqual(response.content_length, len(package))
            self.assertEqual(response.data, b'')
        self.assertEqual(self.go(client, 'GET', '/api/library').status_code, 401)

    def test_missing_stale_and_unknown_platform(self):
        client = self.app.test_client()
        self.assertEqual(self.go(client, 'GET', '/api/app-updates/windows-x64').status_code, 404)
        self.publish()
        self.assertEqual(self.go(client, 'GET', '/api/app-updates/windows-x64/' + '0' * 64).status_code, 404)
        self.assertEqual(self.go(client, 'GET', '/api/app-updates/other').status_code, 404)

    def test_rejects_paths_invalid_digest_version_and_size(self):
        client = self.app.test_client()
        for change in ({'file': '../secret'}, {'sha256': 'x'}, {'version': 'next'}, {'size': 1}):
            with self.subTest(change=change):
                self.publish(**change)
                self.assertEqual(self.go(client, 'GET', '/api/app-updates/windows-x64').status_code, 503)


    def test_iphone_release_is_announced_and_requires_an_ipa_name(self):
        directory = Path(self.ws) / '.app-updates' / 'ios'
        directory.mkdir(parents=True)
        package = b'iphone build'
        data = {'version': '0.1.55', 'sha256': hashlib.sha256(package).hexdigest(), 'size': len(package),
                'file': 'FamilyHub-Music-iOS-0.1.55-unsigned.ipa'}
        (directory / data['file']).write_bytes(package)
        (directory / 'latest.json').write_text(json.dumps(data), encoding='utf-8')
        client = self.app.test_client()
        manifest = self.go(client, 'GET', '/api/app-updates/ios')
        self.assertEqual((manifest.status_code, manifest.json['version']), (200, '0.1.55'))
        (directory / 'latest.json').write_text(json.dumps({**data, 'file': 'FamilyHub-Music-iOS.apk'}), encoding='utf-8')
        self.assertEqual(self.go(client, 'GET', '/api/app-updates/ios').status_code, 503)

class DisabledAppUpdates(Base):
    def test_requires_family_mode(self):
        response = self.go(self.app.test_client(), 'GET', '/api/app-updates/windows-x64')
        self.assertEqual(response.status_code, 409)
