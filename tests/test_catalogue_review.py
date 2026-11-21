"""Review pools preserve recordings and reject uncertain metadata matches."""
import tempfile
import unittest
from unittest.mock import patch
from music_web.catalogue_review import CatalogueReview, ReviewError, lookup, seed
from music_web.catalog_search import candidates as store_candidates
from music_web.catalogue_review import core_title, normal
from music_web.playlists import PlaylistStore
from test_music_web import Base
import test_native_music_api as native
FIRST=native.FIRST

TRACK=dict(id=FIRST,title='Artist - Song (Official Audio)',channel='Artist',library_album='Unknown album',genre='Unsorted',duration=180)
class ReviewStore(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=CatalogueReview(self.tmp.name)
        search=patch('music_web.catalog_search.candidates',return_value=[]);search.start();self.addCleanup(search.stop)
    def observe(self,**kw):
        track={**TRACK,**kw};self.store.observe(track,{},'a'*64);return track
    def test_trim_deduplicates_users_positions_and_persists(self):
        self.store.flag_trim(TRACK,'a'*64,'one',12.25)
        row=self.store.flag_trim(TRACK,'a'*64,'one',12.3)
        self.assertEqual(row['positions'],[12.25]);self.assertEqual(row['requested_by'],['one'])
        restored=CatalogueReview(self.tmp.name);self.assertEqual(restored.snapshot()['trimming_total'],1)
        restored.resolve_trim(FIRST);self.assertEqual(restored.snapshot()['trimming_total'],0)
        self.assertEqual(restored.flag_trim(TRACK,'a'*64,'two',22)['positions'],[22])
    def test_auto_fills_only_missing_fields_and_binds_original(self):
        self.observe();self.store.process_one(lambda:True,lambda row:dict(values=dict(artist='Wrong artist',album='Album',genre='Drum and bass')))
        self.assertEqual(self.store.overrides(FIRST,'a'*64),dict(album='Album',genre='Drum and bass'))
        self.assertEqual(self.store.overrides(FIRST,'b'*64),{})
        self.assertEqual(self.store.snapshot()['metadata_total'],0)

    def test_review_status_filters_before_pagination_and_handles_disabled_automation(self):
        self.observe()
        self.store.flag_trim(TRACK,'a'*64,'one',12)
        queue = self.store.snapshot(limit=1,work='queue')
        self.assertEqual((queue['metadata_total'], queue['trimming_total']), (1, 0))
        choices = self.store.snapshot(limit=1,work='choice')
        self.assertEqual((choices['metadata_total'], choices['trimming_total']), (0, 1))
        manual = self.store.snapshot(limit=1,work='choice',metadata_automatic=False)
        self.assertEqual(manual['metadata'][0]['id'], FIRST)

    def test_shared_rolling_rate_limit_survives_restart_and_yields_to_playback(self):
        now = 10000
        store = CatalogueReview(self.tmp.name, automatic_limit=2, clock=lambda: now)
        store.observe(TRACK, {}, 'a'*64)
        def resolve(row): return dict(values={'album': 'Album'})
        self.assertFalse(store.process_one(lambda: False, resolve))
        self.assertTrue(store.reserve_automatic('source search'))
        self.assertTrue(store.process_one(lambda: True, resolve))
        restarted = CatalogueReview(self.tmp.name, automatic_limit=2, clock=lambda: now)
        self.assertFalse(restarted.reserve_automatic('source replacement'))
        now += 3599
        self.assertFalse(restarted.reserve_automatic())
        now += 1
        self.assertTrue(restarted.reserve_automatic('source replacement'))
        self.assertTrue(restarted.reserve_automatic())
        self.assertFalse(restarted.reserve_automatic())

    def test_metadata_undo_preserves_a_later_manual_edit(self):
        self.observe()
        self.store.process_one(lambda: True, lambda row: dict(values={'album': 'Automatic album', 'genre': 'Rock'}))
        store = CatalogueReview(self.tmp.name)
        row = store.data['metadata'][FIRST]
        store.edit_metadata(FIRST, row['revision'], {'album': 'Manual album'})
        with self.assertRaises(ReviewError):
            store.undo_metadata(FIRST, 'b'*64)
        store.undo_metadata(FIRST, 'a'*64)
        self.assertEqual(store.overrides(FIRST, 'a'*64), {'album': 'Manual album'})
        self.assertEqual(store.snapshot()['metadata'][0]['missing'], ['genre'])
        self.assertEqual(store.data['metadata_fixed'], {})
        self.assertFalse(store.process_one(lambda: True, lambda row: self.fail('Undone metadata stays in review.')))

    def test_default_metadata_capacity_preserves_source_search_budget(self):
        self.store.source_automation = True
        for _ in range(120):
            self.assertTrue(self.store.reserve_automatic())
        self.assertFalse(self.store.reserve_automatic())
        for _ in range(5):
            self.assertTrue(self.store.reserve_automatic('source search'))
        self.assertFalse(self.store.reserve_automatic('source search'))
        self.assertTrue(self.store.reserve_automatic('source replacement'))

    def test_verified_title_preserves_edition_and_undo_stays_in_review(self):
        original = 'Artist - Song (Acoustic) [Official Video]'
        track = dict(TRACK, title=original, library_album='Album', genre='Rock')
        source = dict(kind='youtube', title=original, channel='Artist - Topic')
        candidate = dict(id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title='Song (Acoustic)', length=180000,
                         score=100, **{'artist-credit': [{'name': 'Artist'}]})
        details = {'title': candidate['title'], 'artist-credit': candidate['artist-credit']}
        self.store.observe(track, source, 'a'*64, automatic_title=True)
        row = self.store.snapshot()['metadata'][0]
        self.assertEqual(row['missing'], ['title'])
        with patch('music_web.catalogue_review.musicbrainz', return_value={'recordings': [
                dict(candidate, title='Song (Live)')]}):
            self.assertEqual(lookup(row)['values'], {})
        with patch('music_web.catalogue_review.musicbrainz', side_effect=[{'recordings': [candidate]}, details]):
            self.assertTrue(self.store.process_one(lambda: True))
        self.assertEqual(self.store.overrides(FIRST, 'a'*64), {'title': 'Song (Acoustic)'})
        self.store.undo_metadata(FIRST, 'a'*64)
        reopened = CatalogueReview(self.tmp.name)
        self.assertEqual(reopened.snapshot()['metadata'][0]['title'], original)
        self.assertFalse(reopened.process_one(lambda: True))

    def test_legacy_title_is_suggested_and_explicit_import_title_is_preserved(self):
        track = dict(TRACK, library_album='Album', genre='Rock')
        source = dict(kind='youtube', title=track['title'], channel='Artist - Topic')
        self.store.observe(track, source, 'a'*64, automatic_title=False)
        self.assertEqual(self.store.snapshot()['metadata'], [])
        self.store.observe(track, source, 'a'*64)
        row = self.store.snapshot()['metadata'][0]
        self.assertEqual(row['missing'], ['title'])
        candidate = dict(id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title='Song', length=180000,
                         score=100, **{'artist-credit': [{'name': 'Artist'}]})
        with patch('music_web.catalogue_review.musicbrainz', side_effect=[
                {'recordings': [candidate]}, {'title': 'Song', 'artist-credit': candidate['artist-credit']}]):
            result = lookup(row)
        self.assertEqual(result['suggested']['title'], 'Song')
        self.assertEqual(result['values'], {})

    def test_hourly_retry_exposes_next_attempt_and_reason(self):
        now = 10000
        store = CatalogueReview(self.tmp.name, automatic_limit=1, clock=lambda: now)
        store.observe(TRACK, {}, 'a'*64)
        self.assertTrue(store.reserve_automatic('source search'))
        row = store.snapshot()['metadata'][0]
        self.assertEqual((row['retry_at'], row['retry_reason']), (13600, 'Hourly catalogue limit'))
        now += 3600
        self.assertNotIn('retry_at', store.snapshot()['metadata'][0])
    def test_embedded_tags_are_used_without_lookup(self):
        self.store.observe({**TRACK,'channel':'Unknown artist'},{'artist':'Tagged artist','album':'Tagged album'},'a'*64)
        self.assertEqual(self.store.overrides(FIRST,'a'*64),dict(artist='Tagged artist',album='Tagged album'))
    def test_manual_edits_win_over_inflight_lookup(self):
        self.observe()
        def resolver(row):
            self.store.edit_metadata(FIRST,row['revision'],dict(album='Manual album',genre='Punk'))
            return dict(values=dict(album='Old result'))
        self.store.process_one(lambda:True,resolver)
        self.assertEqual(self.store.overrides(FIRST,'a'*64)['album'],'Manual album')
    def test_revisions_validation_and_missing_match_review(self):
        self.observe();row=self.store.snapshot()['metadata'][0]
        for values in ({'album':22},{'x':'bad'},{'genre':'a\nvalue'}):
            with self.assertRaises(ReviewError):self.store.edit_metadata(FIRST,row['revision'],values)
        with self.assertRaises(ReviewError):self.store.edit_metadata(FIRST,0,dict(album='Album'))
        self.store.process_one(lambda:True,lambda row:dict(values={}))
        self.assertEqual(self.store.snapshot()['metadata'][0]['state'],'review')
    def test_lookup_failure_retries_later_then_goes_to_review_and_yields_to_playback(self):
        self.observe();self.assertFalse(self.store.process_one(lambda:False))
        def fail(row):raise OSError('MusicBrainz busy')
        for attempt in range(4):
            self.store.process_one(lambda:True,fail)
            row=self.store.snapshot()['metadata'][0]
            self.assertEqual((row['state'],row['attempts']),('queued',attempt+1))
            self.assertFalse(self.store.process_one(lambda:True,fail),'waits for its retry time')
            for stored in self.store.data['metadata'].values():stored['retry_at']=0
        self.store.process_one(lambda:True,fail)
        row=self.store.snapshot()['metadata'][0]
        self.assertEqual((row['state'],row['source']),('review','Lookup unavailable; review manually'))
    def test_progress_counts_this_pass_and_ends_when_done(self):
        self.observe()
        self.assertEqual(self.store.progress(),dict(processed=0,total=1,remaining=1,waiting=0,current_title=''))
        self.store.process_one(lambda:True,lambda row:dict(values={},source='No unique title, artist and duration match'))
        self.assertIsNone(self.store.progress(),'no tagging row once every song was looked up')
    def test_throttling_requeues_without_using_an_attempt(self):
        from music_web.musicbrainz import Throttled
        self.observe()
        def busy(row): raise Throttled('slow down')
        self.store.process_one(lambda:True,busy)
        row=next(iter(self.store.data['metadata'].values()))
        self.assertEqual((row['state'],row.get('attempts',0)),('queued',0))
        self.assertGreater(row['retry_at'],0)

    def test_older_automatic_results_are_looked_up_again_once(self):
        self.observe();self.store.process_one(lambda:True,lambda row:dict(values={},source='No unique title, artist and duration match'))
        row=next(iter(self.store.data['metadata'].values()));row.pop('lookup_version',None);self.store.dirty=True;self.store.flush()
        reopened=type(self.store)(self.store.path.parent)
        self.assertEqual(next(iter(reopened.data['metadata'].values()))['state'],'queued')
        reopened.process_one(lambda:True,lambda row:dict(values={},source='No unique title, artist and duration match'))
        self.assertEqual(type(self.store)(self.store.path.parent).snapshot()['metadata'][0]['state'],'review','a current result is not looked up again')
    def test_observe_during_lookup_requeues(self):
        self.observe()
        self.store.process_one(lambda:True,lambda row:(self.observe(title='Corrected title') or {}))
        self.assertEqual(self.store.snapshot()['metadata'][0]['state'],'queued')
    def test_lookup_requires_unique_title_artist_and_duration(self):
        self.observe();row=self.store.snapshot()['metadata'][0]
        candidate=dict(id='a'*8+'-aaaa-aaaa-aaaa-'+'a'*12,title='Song',length=180000,score=100,**{'artist-credit':[{'artist':{'name':'Artist'}}]})
        details={'artist-credit':[{'name':'Artist'}],'releases':[{'title':'Album','status':'Official','release-group':{'primary-type':'Album'}}],'genres':[{'name':'punk','count':2}]}
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[candidate]),details]):
            self.assertEqual(lookup(row)['values'],dict(album='Album',genre='punk'))
        for bad in ({**candidate,'length':183001},{**candidate,'title':'Song (Live)'},{**candidate,'score':89}):
            with patch('music_web.catalogue_review.musicbrainz',return_value=dict(recordings=[bad])):self.assertEqual(lookup(row)['values'],{})
        other={**candidate,'id':'b'*8+'-bbbb-bbbb-bbbb-'+'b'*12}
        # The same song released twice (single and album) is one match; different credits are not.
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[candidate,other]),details]):
            self.assertEqual(lookup(row)['values'],dict(album='Album',genre='punk'))
        with patch('music_web.catalogue_review.musicbrainz',return_value=dict(recordings=[candidate,{**other,'artist-credit':[{'artist':{'name':'Artist'}},{'artist':{'name':'Guest'}}]}])):self.assertEqual(lookup(row)['values'],{})
        remaster={**candidate,'title':'Song (Remastered 2011)'}
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[remaster]),details]):
            self.assertEqual(lookup(row)['values'],dict(album='Album',genre='punk'))
        boundary={**candidate,'length':183000,'score':90}
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[boundary]),details]):
            self.assertEqual(lookup(row)['values'],dict(album='Album',genre='punk'))
    def test_missing_recording_genre_uses_the_artist(self):
        self.observe();row=self.store.snapshot()['metadata'][0]
        candidate=dict(id='a'*8+'-aaaa-aaaa-aaaa-'+'a'*12,title='Song',length=180000,score=100,**{'artist-credit':[{'artist':{'name':'Artist'}}]})
        details={'artist-credit':[{'name':'Artist','artist':{'id':'c'*8+'-cccc-cccc-cccc-'+'c'*12}}],'releases':[],'genres':[]}
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[candidate]),details,dict(genres=[{'name':'synth-pop','count':4}])]):
            self.assertEqual(lookup(row)['values'].get('genre'),'synth-pop')
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[]),dict(artists=[{'name':'Artist','tags':[{'name':'hard rock','count':3}]}])]):
            result = lookup(row)
            self.assertEqual(result['suggested'].get('genre'),'Rock')
            self.assertNotIn('genre', result['values'])
        self.assertIn('Remix',seed({},dict(TRACK,title='Artist - Song (Official Remix)'))['title'])
    def test_store_matches_fill_an_agreed_album_and_are_kept(self):
        self.observe();row=self.store.snapshot()['metadata'][0]
        single=[dict(source='Deezer',artist='Artist',album='Song',album_type='single',genre='Dance',url='https://www.deezer.com/track/1'),
                dict(source='iTunes',artist='Artist',album='Song - Single',album_type='single',genre='Electronic',url='https://music.apple.com/x')]
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[]),dict(artists=[])]):
            result=lookup(row,lambda *a:single)
        self.assertEqual(result['values'],dict(album='Song'));self.assertEqual(result['source'],'Deezer/iTunes');self.assertEqual(len(result['candidates']),2)
        split=[single[0],{**single[1],'album':'Other album'}]
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[]),dict(artists=[])]):
            self.assertEqual(lookup(row,lambda *a:split)['values'],{},'stores that disagree leave the album for review')
        compiled=[single[0],{**single[1],'album':'Hits Vol. 4','album_type':'compile'}]
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[]),dict(artists=[])]):
            self.assertEqual(lookup(row,lambda *a:compiled)['values'],dict(album='Song'),'compilations do not count')
        self.store.process_one(lambda:True,lambda row:dict(values={},source='Deezer/iTunes',candidates=single))
        self.assertEqual(self.store.snapshot()['metadata'][0]['candidates'][1]['album'],'Song - Single')

    def test_deezer_filters_cover_artists_and_caps_duration_difference(self):
        def row(name, duration, title='Song'):
            return dict(title=title, duration=duration, artist={'name':name}, album={'title':'Album'})
        from music_web import catalog_search
        with patch.object(catalog_search, '_get', side_effect=[{'data': [
            row('Cover artist', 180), row('Artist', 184), row('Artist', 180, 'Song (Live)'), row('Artist', 183)]}, {}]):
            result = store_candidates({'artist':'Artist','title':'Song','duration':180},core_title,normal)
        self.assertEqual(len(result), 1)
        self.assertEqual((result[0]['source'], result[0]['artist']), ('Deezer', 'Artist'))
    def test_votes_fill_agreed_fields_and_suggest_the_rest(self):
        self.observe();self.store.process_one(lambda:True,lambda row:dict(values={},source='No unique title, artist and duration match'))
        vote=dict(id=FIRST,sha256='a'*64,values=dict(genre='Drum and bass',artist='Ignored'),suggested=dict(album='Maybe album'))
        self.assertEqual(self.store.apply_votes([vote,dict(vote,sha256='b'*64),'junk'],'AI vote (3 runs)'),1)
        row=self.store.snapshot()['metadata'][0]
        self.assertEqual(row['current']['genre'],'Drum and bass');self.assertEqual(row['suggested']['album'],'Maybe album')
        self.assertEqual(row['missing'],['album']);self.assertEqual(row['source'],'AI vote (3 runs)')
        self.assertEqual(self.store.overrides(FIRST,'a'*64),dict(genre='Drum and bass'))
        self.assertEqual(self.store.apply_votes([dict(vote,values=dict(album='x'*200))],'AI vote'),0,'invalid values are skipped')
    def test_snapshot_bounds_and_search(self):
        for i in range(105):
            track={**TRACK,'id':f'{i:011d}','title':f'Song {i}'}
            self.store.flag_trim(track,'a'*64,'one')
            self.store.observe(track,{},'a'*64)
        data=self.store.snapshot();self.assertEqual(data['trimming_total'],105);self.assertEqual(len(data['trimming']),100)
        self.assertEqual((data['metadata_total'],len(data['metadata'])),(105,100))
        self.assertEqual(self.store.snapshot('Song 104')['trimming_total'],1)
        expanded=self.store.snapshot(limit=200)
        self.assertEqual((len(expanded['trimming']),len(expanded['metadata'])),(105,105))
        self.assertEqual((expanded['trimming_total'],expanded['metadata_total']),(105,105))
        self.assertEqual(len(self.store.snapshot()['trimming']),100)
        self.assertEqual(self.store.snapshot('Song 104',limit=200)['metadata_total'],1)

class ReviewApi(Base):
    extra={'ADMIN_USERS':['sample-a']}
    def test_review_page_size_is_bounded(self):
        admin,_=self.signed_in()
        for limit in ('0','-1','10001','many','1.5'):
            self.assertEqual(self.go(admin,'GET','/api/catalogue/review?limit='+limit).status_code,400)
        for i in range(3):
            self.state.catalogue_review.flag_trim({**TRACK,'id':f'{i:011d}'},'a'*64,'one')
        result=self.go(admin,'GET','/api/catalogue/review?limit=2')
        self.assertEqual(result.status_code,200)
        self.assertEqual(len(result.json['trimming']),2)
        self.assertEqual(result.json['trimming_total'],3)
    def test_flag_metadata_update_permissions_and_csrf(self):
        native.NativeMusicApi.recording(self)
        admin,token=self.signed_in();member,member_token=self.signed_in('sample-b')
        self.go(admin,'GET','/api/library')
        self.assertEqual(self.go(admin,'POST','/api/catalogue/trimming',json={'id':FIRST}).status_code,400)
        self.assertEqual(self.post(admin,token,'/api/catalogue/trimming',json={'id':FIRST,'position':float('nan')}).status_code,400)
        self.assertEqual(self.post(admin,token,'/api/catalogue/trimming',json={'id':FIRST,'position':12}).status_code,201)
        self.assertEqual(self.post(member,member_token,f'/api/catalogue/trimming/{FIRST}/resolve',json={}).status_code,403)
        data=self.go(admin,'GET','/api/catalogue/review').json;self.assertTrue(data['can_edit']);self.assertEqual(data['trimming_total'],1)
        row=data['metadata'][0]
        result=self.go(admin,'PATCH',f'/api/catalogue/metadata/{FIRST}',headers={'X-CSRFToken':token},json=dict(revision=row['revision'],values={'genre':'Punk'}))
        self.assertEqual(result.status_code,200,result.json)
        self.assertEqual(self.go(admin,'GET','/api/library').json['results'][0]['genre'],'Punk')
        self.assertEqual(self.go(member,'PATCH',f'/api/catalogue/metadata/{FIRST}',headers={'X-CSRFToken':member_token},json=dict(revision=1,values={'album':'Oops'})).status_code,403)
        self.assertEqual(self.post(admin,token,f'/api/catalogue/trimming/{FIRST}/resolve',json={}).status_code,200)

    def test_song_reports_deduplicate_persist_and_require_admin_to_review(self):
        native.NativeMusicApi.recording(self)
        admin, token = self.signed_in()
        member, member_token = self.signed_in('sample-b')
        self.go(admin, 'GET', '/api/library')
        payload = dict(id=FIRST, reason='bad_quality')
        self.assertEqual(self.go(member, 'POST', '/api/catalogue/reports', json=payload).status_code, 400)
        for _ in range(2):
            self.assertEqual(self.post(member, member_token, '/api/catalogue/reports', json=payload).status_code, 201)
        self.assertEqual(self.go(member, 'GET', '/api/catalogue/reports').status_code, 403)
        rows = self.go(admin, 'GET', '/api/catalogue/reports').json['reports']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['profile'], 'sample-b')
        self.assertGreater(rows[0]['time'], 0)
        self.assertEqual(len(CatalogueReview(self.state.catalogue_review.path.parent).data['reports']), 1)
        self.assertEqual(self.post(member, member_token, '/api/catalogue/reports/resolve', json=dict(key=rows[0]['key'])).status_code, 403)
        self.assertEqual(self.post(admin, token, '/api/catalogue/reports/resolve', json=dict(key=rows[0]['key'])).status_code, 200)
        self.assertEqual(self.go(admin, 'GET', '/api/catalogue/reports').json['reports'], [])
        for reason in ('trimming', '', None, ['bad_quality']):
            self.assertEqual(self.post(member, member_token, '/api/catalogue/reports', json=dict(id=FIRST, reason=reason)).status_code, 400)


class PlaylistGapApi(Base):
    extra = {'FAMILY_PROFILES': True, 'ADMIN_USERS': ['sample-a']}

    def test_admin_sees_unresolved_matches_with_playlist_access(self):
        store = PlaylistStore(self.ws)
        for owner in ('sample-a', 'sample-b'):
            store.save(owner, dict(id='p'*22, name=owner + ' playlist', tracks=[
                dict(title='Unmatched song', artist='Artist', state='review'),
                dict(title='Already matched', artist='Artist', state='ready', source_id=FIRST)]))
        def review(owner):
            client = self.app.test_client()
            token = self.go(client, 'GET', '/api/connect').json['csrf_token']
            self.post(client, token, '/api/profile/select', json={'profile_id': owner})
            return self.go(client, 'GET', '/api/catalogue/review?limit=10').json
        data = review('sample-a')
        self.assertEqual(data['playlist_gaps_total'], 2)
        self.assertEqual([(gap['owner_id'], gap['index'], gap['can_edit']) for gap in data['playlist_gaps']],
                         [('sample-a', 0, True), ('sample-b', 0, False)])
        self.assertNotIn('playlist_gaps', review('sample-b'))
