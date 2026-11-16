"""Review pools preserve recordings and reject uncertain metadata matches."""
import tempfile
import unittest
from unittest.mock import patch
from music_web.catalogue_review import CatalogueReview, ReviewError, lookup, seed
from test_music_web import Base
import test_native_music_api as native
FIRST=native.FIRST

TRACK=dict(id=FIRST,title='Artist - Song (Official Audio)',channel='Artist',library_album='Unknown album',genre='Unsorted',duration=180)
class ReviewStore(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=CatalogueReview(self.tmp.name)
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
        for bad in ({**candidate,'length':210000},{**candidate,'title':'Song (Live)'}):
            with patch('music_web.catalogue_review.musicbrainz',return_value=dict(recordings=[bad])):self.assertEqual(lookup(row)['values'],{})
        other={**candidate,'id':'b'*8+'-bbbb-bbbb-bbbb-'+'b'*12}
        # The same song released twice (single and album) is one match; different credits are not.
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[candidate,other]),details]):
            self.assertEqual(lookup(row)['values'],dict(album='Album',genre='punk'))
        with patch('music_web.catalogue_review.musicbrainz',return_value=dict(recordings=[candidate,{**other,'artist-credit':[{'artist':{'name':'Artist'}},{'artist':{'name':'Guest'}}]}])):self.assertEqual(lookup(row)['values'],{})
        remaster={**candidate,'title':'Song (Remastered 2011)'}
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[remaster]),details]):
            self.assertEqual(lookup(row)['values'],dict(album='Album',genre='punk'))
    def test_missing_recording_genre_uses_the_artist(self):
        self.observe();row=self.store.snapshot()['metadata'][0]
        candidate=dict(id='a'*8+'-aaaa-aaaa-aaaa-'+'a'*12,title='Song',length=180000,score=100,**{'artist-credit':[{'artist':{'name':'Artist'}}]})
        details={'artist-credit':[{'name':'Artist','artist':{'id':'c'*8+'-cccc-cccc-cccc-'+'c'*12}}],'releases':[],'genres':[]}
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[candidate]),details,dict(genres=[{'name':'synth-pop','count':4}])]):
            self.assertEqual(lookup(row)['values'].get('genre'),'synth-pop')
        with patch('music_web.catalogue_review.musicbrainz',side_effect=[dict(recordings=[]),dict(artists=[{'name':'Artist','tags':[{'name':'hard rock','count':3}]}])]):
            self.assertEqual(lookup(row)['values'].get('genre'),'Rock')
        self.assertIn('Remix',seed({},dict(TRACK,title='Artist - Song (Official Remix)'))['title'])
    def test_snapshot_bounds_and_search(self):
        for i in range(105):self.store.flag_trim({**TRACK,'id':f'{i:011d}','title':f'Song {i}'},'a'*64,'one')
        data=self.store.snapshot();self.assertEqual(data['trimming_total'],105);self.assertEqual(len(data['trimming']),100)
        self.assertEqual(self.store.snapshot('Song 104')['trimming_total'],1)

class ReviewApi(Base):
    extra={'ADMIN_USERS':['sample-a']}
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
