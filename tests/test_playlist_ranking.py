import unittest
from music_web.playlists import rank_matches, preferred_match, source_tier
from unittest.mock import Mock


class RepeatedEditionTests(unittest.TestCase):
    def test_repeated_distributor_label_matches_same_edition_only(self):
        track = dict(title='Halo - Radio Edit', artist='Max Melvin', duration=217)
        row = dict(id='ZW8nQ6TWKz4', title='Halo (Radio Edit) (Radio Edit)',
                   channel='Max Melvin - Topic', duration=217, kind='topic')
        self.assertTrue(rank_matches(track, [row])[0]['recommended'])
        self.assertFalse(rank_matches(dict(track, title='Halo'), [row])[0]['recommended'])
        self.assertFalse(rank_matches(dict(track, title='Halo - Sunset Mix'), [row])[0]['recommended'])

class PlaylistRankingTests(unittest.TestCase):
    def test_source_tiers_and_official_sources_beat_reuploads(self):
        track = dict(title='Dynamite', artist='Taio Cruz', duration=203)
        for channel, tier in [('Taio Cruz - Topic', 1), ('TaioCruzVEVO', 2),
                              ('Taio Cruz', 2), ('TaioCruz', 2), ('Taio Cruz Official', 2),
                              ('Island Records', 2), ('Universal Music', 2), ('ArenBLady', 3),
                              ('taiocruzfanmusic', 3), ('Taio Cruz Lyrics', 3), ('Taio Cruz Fans', 3)]:
            self.assertEqual(source_tier(dict(channel=channel), track['artist']), tier)
        fan = dict(id='fan', title='Taio Cruz - Dynamite', channel='ArenBLady', duration=203)
        official = dict(fan, id='official', channel='TaioCruzVEVO')
        topic = dict(fan, id='topic', title='Dynamite', channel='Taio Cruz - Topic')
        ranked = rank_matches(track, [fan, official, topic])
        self.assertEqual([r['source_tier'] for r in ranked], [1, 2, 3])
        self.assertEqual(preferred_match(list(reversed(ranked)))['id'], 'topic')
        self.assertEqual(preferred_match(rank_matches(track, [fan, official]))['id'], 'official')
        self.assertTrue(rank_matches(track, [dict(official, title='Dynamite')])[0]['recommended'])
        self.assertEqual(preferred_match(rank_matches(track, [fan]))['source_tier'], 3)

    def test_topic_fallback_search_is_bounded_and_reuses_matching(self):
        track = dict(title='Song', artist='Artist, Guest', duration=200)
        fan = dict(id='fan', title='Artist - Song', channel='Fan', duration=200)
        topic = dict(fan, id='topic', title='Song', channel='Artist - Topic')
        search = Mock(return_value=dict(results=[topic]))
        self.assertEqual(preferred_match(rank_matches(track, [fan], search))['id'], 'topic')
        self.assertEqual(search.call_count, 1)
        self.assertEqual(search.call_args.args[0].query, 'Artist - Topic Song')
        search.reset_mock()
        rank_matches(track, [topic], search)
        search.assert_not_called()
        search.return_value = dict(results=[dict(topic, duration=20)])
        self.assertEqual(preferred_match(rank_matches(track, [fan], search))['id'], 'fan')

    def row(self, title, **kw):
        return dict(id='abcdefghijk', title=title, channel='Artist', duration=200, **kw)

    def test_topic_wins_over_reposts_and_first_matching_upload_is_automatic(self):
        track=dict(title='Song', artist='Artist', duration=200)
        repost=self.row('Artist - Song', kind='other')
        topic={**self.row('Song', kind='topic'), 'id':'lmnopqrstuv'}
        self.assertEqual(preferred_match(rank_matches(track,[repost,topic]))['id'],topic['id'])
        self.assertEqual(preferred_match(rank_matches(track,[repost,{**repost,'id':'lmnopqrstuv'}]))["id"], repost["id"])
        self.assertEqual(preferred_match(rank_matches(track,[topic,{**topic,'id':'zzzzzzzzzzz'}]))["id"], topic["id"])

    def test_feature_credits_and_named_remix_survive_normalization(self):
        cases=[('Song (feat. Guest)','Artist - Song (feat. Guest)'),
               ('Song - Guest Remix','Artist - Song (Guest Remix)'),
               ('Song - Guest Remix','Artist - Song - Guest Remix')]
        for expected,actual in cases:
            self.assertTrue(rank_matches(dict(title=expected,artist='Artist',duration=200),[self.row(actual)])[0]['recommended'])
        track=dict(title='Song - Guest Remix',artist='Artist',duration=200)
        for wrong in ['Artist - Song (Other Remix)','Artist - Song','Artist - Song (Guest Remix) (Slowed)']:
            self.assertFalse(rank_matches(track,[self.row(wrong)])[0]['recommended'])

    def test_preserves_unknown_qualifiers_and_rejects_wrong_artist_duration(self):
        track=dict(title='Song',artist='Artist',duration=200)
        for wrong in ['Artist - Song (Demo)','Artist - Song (Reversed)','Artist - Song (Karaoke)']:
            self.assertFalse(rank_matches(track,[self.row(wrong)])[0]['recommended'])
        row={**self.row('Song',kind='topic'),'channel':'Other'}
        self.assertIsNone(preferred_match(rank_matches(track,[row])))
        self.assertIsNone(preferred_match(rank_matches(track,[{**self.row('Song'), 'duration':100}])))

    def test_duplicate_source_is_not_ambiguous(self):
        row=self.row('Artist - Song')
        self.assertEqual(len(rank_matches(dict(title='Song',artist='Artist',duration=200),[row,row])),1)
