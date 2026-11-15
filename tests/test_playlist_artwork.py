import base64
import io
import json
import subprocess
from pathlib import Path
from unittest.mock import patch

from test_family_profiles import FamilyProfiles
from music_web.playlist_artwork import ArtworkError, PlaylistArtwork


class PlaylistArtworkApi(FamilyProfiles):
    def test_cover_validation_shared_read_and_owner_write(self):
        owner, token = self.select('sample-a')
        playlist = self.post(owner, token, '/api/playlists', json={'name': 'Artwork test'}).json['playlist']
        playlist = self.go(owner, 'PATCH', '/api/playlists/' + playlist['id'], json={'revision': playlist['revision'], 'shared': False}, headers={'X-CSRFToken': token}).json['playlist']
        image = 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8\xff' + bytes(24000)).decode()
        normalized = b'\xff\xd8\xffnormalized'
        with patch('music_web.playlist_artwork.subprocess.run', return_value=subprocess.CompletedProcess([], 0, normalized, b'')):
            response = self.go(owner, 'PATCH', '/api/playlists/' + playlist['id'],
                json={'revision': playlist['revision'], 'cover_image': image}, headers={'X-CSRFToken': token})
        self.assertEqual(response.status_code, 200, response.json)
        updated = response.json['playlist']
        self.assertEqual(updated['revision'], playlist['revision'] + 1)
        self.assertNotIn('cover_image', updated)
        with self.go(owner, 'GET', updated['cover_url']) as cover:
            self.assertEqual(cover.data, normalized)
            self.assertEqual(cover.mimetype, 'image/jpeg')
        other, other_token = self.select('sample-b')
        self.assertEqual(self.go(other, 'GET', updated['cover_url']).status_code, 403)
        self.assertEqual(self.go(other, 'PATCH', '/api/playlists/' + playlist['id'],
            json={'revision': updated['revision'], 'owner_id': 'sample-a', 'cover_image': image},
            headers={'X-CSRFToken': other_token}).status_code, 403)
        shared = self.go(owner, 'PATCH', '/api/playlists/' + playlist['id'], json={'revision': updated['revision'], 'shared': True}, headers={'X-CSRFToken': token})
        self.assertEqual(shared.status_code, 200)
        with self.go(other, 'GET', updated['cover_url']) as cover:
            self.assertEqual(cover.data, normalized)

    def test_rejects_svg_arbitrary_urls_and_broken_images(self):
        artwork = PlaylistArtwork(self.ws)
        for image in ('https://other.test/picture.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,broken'):
            with self.subTest(image=image), self.assertRaises(ArtworkError):
                artwork.save('sample-a', 'a' * 22, image)
