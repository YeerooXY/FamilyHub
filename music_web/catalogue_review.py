"""Persistent trimming flags and source-backed metadata repair proposals."""
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import threading
import time
import unicodedata
from .musicbrainz import read as musicbrainz, Throttled
from .genres import group as genre_group
from . import catalog_search

ID=re.compile(r'(?:[A-Za-z0-9_-]{11}|local-[0-9a-f]{16})')
UNKNOWN={'','unknown','unknown artist','unknown album','unsorted','selected recordings','youtube','local imports'}
FIELDS=('artist','album','genre')
# Raise when the lookup improves: automatic results from older versions are looked up again.
# 3: Deezer and iTunes fill albums MusicBrainz lacks and keep their matches for the AI vote.
LOOKUP_VERSION=3
AUTOMATIC_SOURCES={'No unique title, artist and duration match','Deezer/iTunes','Lookup unavailable; review manually','MusicBrainz','File/source tags',''}
# Failed lookups (MusicBrainz busy or unreachable) retry after 30 minutes, then 1, 2 and 4 hours.
RETRY_SECONDS=(1800,3600,7200,14400)

class ReviewError(ValueError):
    def __init__(self,message,status=400):super().__init__(message);self.status=status

def missing(value): return not isinstance(value,str) or value.strip().casefold() in UNKNOWN

def text(value,limit=120):
    if not isinstance(value,str) or len(value)>limit or re.search(r'[\x00-\x1f\x7f]',value):
        raise ReviewError('Enter text without control characters.')
    return value.strip()

def normal(value):
    value=''.join(c for c in unicodedata.normalize('NFKD',value or '') if not unicodedata.combining(c))
    return re.sub(r'[^\w]+',' ',value.casefold()).strip()

def core_title(value):
    # "Song (feat. X)", "Song [Remastered 2011]" and "Song - Radio Edit" name the same song for matching.
    # Brackets naming a different performance (live, remix, acoustic...) stay part of the title.
    value=re.sub(r'\s*[\[(][^\])]*[\])]',lambda m:m.group(0) if re.search(r'live|remix|acoustic|instrumental|slowed|sped|nightcore|cover|demo|karaoke|unplugged',m.group(0),re.I) else '',value or '')
    value=re.sub(r'\s+(?:feat\.?|ft\.?|featuring)\s.*$','',value,flags=re.I)
    value=re.sub(r'\s+-\s+(?:radio edit|remaster(?:ed)?(?: \d{4})?|single version|original mix)$','',value,flags=re.I)
    return normal(value)

def artist_genre(artist_id='',name=''):
    # Recording genres are sparse on MusicBrainz; the artist's genres and tags cover most songs.
    if artist_id and re.fullmatch(r'[0-9a-f-]{36}',artist_id):
        artist=musicbrainz('artist/'+artist_id,inc='genres+tags')
    else:
        found=[a for a in musicbrainz('artist/',query='artist:"'+name.replace('"',' ')+'"',limit=3).get('artists',[]) if normal(a.get('name',''))==normal(name)]
        if len(found)!=1:return ''
        artist=found[0]
    genres=sorted(artist.get('genres') or [],key=lambda g:g.get('count',0),reverse=True)
    if genres and genres[0].get('count',0)>0:return str(genres[0]['name'])[:80]
    label=genre_group(artist.get('tags') or [])
    return '' if label=='Unsorted' else label

def seed(source,track):
    title=source.get('track_title') or track['title']
    artist=source.get('artist') or track.get('channel','')
    parts=re.split(r'\s+[-\u2013\u2014]\s+',title,maxsplit=1)
    if not source.get('track_title') and len(parts)==2:
        artist=source.get('artist') or parts[0];title=parts[1]
    title=re.sub(r'\s*[\[(][^\])]*(?:official|audio|video|lyrics|release|hq|hd)[^\])]*[\])]',lambda m:m.group(0) if re.search(r'remix|live|acoustic|slowed|nightcore|instrumental',m.group(0),re.I) else '',title,flags=re.I).strip()
    artist=re.sub(r'\s*-?\s*Topic$|VEVO$','',artist,flags=re.I).strip()
    return dict(title=title[:200],artist=artist[:120],duration=track.get('original_duration') or track.get('duration') or 0)

def lookup(row,search=None):
    result=musicbrainz_lookup(row)
    still=[k for k in ('album','genre') if k in row['missing'] and k not in result['values']]
    if not still or result['source'] in ('File/source tags','No unambiguous artist'):return result
    found=(search or catalog_search.candidates)(row['seed'],core_title,normal)
    result['candidates']=found
    album=catalog_search.agreed_album(found,normal) if 'album' in still else ''
    if album:
        result['values']['album']=result['suggested']['album']=text(album)
        if not result['source_url']:
            result['source']='Deezer/iTunes';result['source_url']=next((c['url'] for c in found if c['url'].startswith('https://')),'')
    return result

def musicbrainz_lookup(row):
    values={};suggested={};source_url='';seed_info=row['seed'];embedded=row.get('embedded',{})
    for key in ('artist','album'):
        if key in row['missing'] and not missing(embedded.get(key)):values[key]=text(embedded[key])
    if not set(row['missing'])-values.keys():return dict(values=values,suggested={},source_url='',source='File/source tags')
    title,artist=seed_info['title'],seed_info['artist']
    if not title or missing(artist):return dict(values=values,suggested={},source_url='',source='No unambiguous artist')
    quote=lambda value:'"'+value.replace('\\',' ').replace('"',' ')+'"'
    found=musicbrainz('recording/',query='recording:'+quote(core_title(title) or title)+' AND artist:'+quote(artist),limit=15).get('recordings',[])
    exact=[]
    for candidate in found:
        artists=[normal(c.get('artist',{}).get('name',c.get('name',''))) for c in candidate.get('artist-credit',[]) if isinstance(c,dict)]
        duration=candidate.get('length')
        if (core_title(candidate.get('title',''))==core_title(title) and normal(artist) in artists
                and type(duration) in (int,float) and seed_info['duration']>0 and abs(duration/1000-seed_info['duration'])<=3
                and int(candidate.get('score',0))>=90):exact.append(candidate)
    exact={c['id']:c for c in exact if re.fullmatch(r'[0-9a-f-]{36}',c.get('id',''))}
    # The same song is often several MusicBrainz recordings (single, album, remaster). They count
    # as one match when every candidate credits the same artists; the best-scored one is read.
    credits={tuple(sorted(normal(c.get('artist',{}).get('name',c.get('name',''))) for c in r.get('artist-credit',[]) if isinstance(c,dict))) for r in exact.values()}
    if not exact or len(credits)!=1:
        if 'genre' in row['missing'] and 'genre' not in values:
            genre=artist_genre(name=artist)
            if genre:values['genre']=genre;suggested['genre']=genre
        return dict(values=values,suggested=suggested,source_url='',source='No unique title, artist and duration match')
    identifier=max(exact.values(),key=lambda r:(int(r.get('score',0)),len(r.get('releases') or [])))['id']
    record=musicbrainz('recording/'+identifier,inc='artists+releases+genres')
    source_url='https://musicbrainz.org/recording/'+identifier
    credit=''.join(c.get('name',c.get('artist',{}).get('name',''))+c.get('joinphrase','') for c in record.get('artist-credit',[]) if isinstance(c,dict)).strip()
    if credit:suggested['artist']=credit[:120]
    releases=[r for r in record.get('releases',[]) if r.get('status')=='Official' and 'Compilation' not in r.get('release-group',{}).get('secondary-types',[])]
    albums=[r for r in releases if r.get('release-group',{}).get('primary-type')=='Album']
    titles={r['title'] for r in albums or releases if r.get('title')}
    if len(titles)==1:suggested['album']=next(iter(titles))[:120]
    genres=sorted(record.get('genres',[]),key=lambda g:g.get('count',0),reverse=True)
    if genres and genres[0].get('count',0)>0:suggested['genre']=str(genres[0]['name'])[:80]
    elif 'genre' in row['missing']:
        credited=next((c.get('artist',{}).get('id','') for c in record.get('artist-credit',[]) if isinstance(c,dict)),'')
        genre=artist_genre(artist_id=credited,name=artist)
        if genre:suggested['genre']=genre
    for key,value in suggested.items():
        if key in row['missing'] and not missing(value):values.setdefault(key,value)
    return dict(values=values,suggested=suggested,source_url=source_url,source='MusicBrainz')

class CatalogueReview:
    MAX_ROWS=10000
    def __init__(self,workspace):
        self.path=Path(workspace)/'.catalogue-review.json';self.lock=threading.RLock();self.dirty=False
        self.data=json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else dict(trimming={},metadata={},overrides={})
        if not isinstance(self.data,dict):raise ReviewError('Invalid catalogue review store.')
        for section in ('trimming','metadata','overrides'):
            self.data.setdefault(section,{})
            if not isinstance(self.data[section],dict) or len(self.data[section])>self.MAX_ROWS:raise ReviewError('Invalid catalogue review store.')
        for row in self.data['metadata'].values():
            if row.get('state')=='processing':row['state']='queued';self.dirty=True
            # Songs that ran out of attempts while MusicBrainz was throttling get them back once.
            if self.data.get('throttle_reset')!=1 and row.get('state')=='queued' and row.get('attempts'):
                row.update(attempts=0);row.pop('retry_at',None);self.dirty=True
            # Automatic results from an older lookup get one more try; owner edits keep their fields.
            if row.get('state')=='review' and row.get('lookup_version',1)<LOOKUP_VERSION and row.get('source','') in AUTOMATIC_SOURCES:
                row.update(state='queued',lookup_version=LOOKUP_VERSION,attempts=0);row.pop('retry_at',None);self.dirty=True
        if self.data.get('throttle_reset')!=1:self.data['throttle_reset']=1;self.dirty=True

    def flush(self):
        with self.lock:
            if not self.dirty:return
            temporary=self.path.with_suffix('.tmp');temporary.write_text(json.dumps(self.data,ensure_ascii=False),encoding='utf-8');temporary.replace(self.path);self.dirty=False

    def overrides(self,identifier,digest):
        with self.lock:
            row=self.data['overrides'].get(identifier,{})
            return dict(row.get('values',{})) if row.get('sha256')==digest else {}

    def observe(self,track,source,digest):
        identifier=track['id'];current=dict(artist=track['channel'],album=track.get('library_album',''),genre=track.get('genre',''))
        absent=[key for key in FIELDS if missing(current[key])]
        with self.lock:
            existing=self.data['metadata'].get(identifier)
            if existing and existing['sha256']==digest:
                if existing['missing']!=absent or existing['current']!=current or existing['title']!=track['title']:
                    existing.update(missing=absent,current=current,title=track['title'],revision=existing['revision']+1)
                    if not absent:existing['state']='done'
                    elif existing['state']=='processing':existing['state']='queued'
                    self.dirty=True
                return
            if not absent or len(self.data['metadata'])>=self.MAX_ROWS:return
            self.data['metadata'][identifier]=dict(id=identifier,sha256=digest,title=track['title'],current=current,missing=absent,seed=seed(source,track),
                embedded={k:source.get(k,'') for k in ('artist','album')},state='queued',revision=1,suggested={},source='',source_url='')
            created=self.data['metadata'][identifier]
            trusted={key:re.sub(r'[\x00-\x1f\x7f]',' ',source[key])[:120] for key in ('artist','album') if key in absent and not missing(source.get(key))}
            if trusted:
                self._apply(created,trusted);created['state']='queued' if created['missing'] else 'done'
            self.dirty=True

    def flag_trim(self,track,digest,user,position=0):
        with self.lock:
            identifier=track['id'];row=self.data['trimming'].get(identifier)
            if row is None or row.get('sha256')!=digest or row.get('state')=='done':
                if row is None and len(self.data['trimming'])>=self.MAX_ROWS:raise ReviewError('The trimming queue is full.')
                row=dict(id=identifier,sha256=digest,title=track['title'],artist=track['channel'],requested_by=[],positions=[],state='queued',at=datetime.now(timezone.utc).isoformat())
                self.data['trimming'][identifier]=row
            if user not in row['requested_by'] and len(row['requested_by'])<64:row['requested_by'].append(user)
            row.setdefault('positions',[])
            if len(row['positions'])<32 and not any(abs(position-p)<.5 for p in row['positions']):row['positions'].append(round(position,2))
            self.dirty=True;self.flush();return copy.deepcopy(row)

    def resolve_trim(self,identifier):
        with self.lock:
            if identifier not in self.data['trimming']:raise ReviewError('Trimming request not found.')
            self.data['trimming'][identifier]['state']='done';self.dirty=True;self.flush()

    def _apply(self,row,values):
        valid={key:text(value,80 if key=='genre' else 120) for key,value in values.items() if key in FIELDS}
        valid={key:value for key,value in valid.items() if not missing(value)}
        previous=self.data['overrides'].get(row['id'],{})
        saved=dict(previous.get('values',{})) if previous.get('sha256')==row['sha256'] else {}
        saved.update(valid);self.data['overrides'][row['id']]=dict(sha256=row['sha256'],values=saved)
        row['current'].update(valid);row['missing']=[key for key in FIELDS if missing(row['current'].get(key))]
        row.update(state='review' if row['missing'] else 'done',revision=row['revision']+1)
        self.dirty=True

    def edit_metadata(self,identifier,revision,values):
        with self.lock:
            row=self.data['metadata'].get(identifier)
            if not row:raise ReviewError('Metadata request not found.')
            if type(revision) is not int or row['revision']!=revision:raise ReviewError('This metadata changed. Open it again.',409)
            if not isinstance(values,dict) or not values or set(values)-set(FIELDS):raise ReviewError('Choose artist, album or genre fields.')
            self._apply(row,values);self.flush();return copy.deepcopy(row)

    def process_one(self,allowed,resolver=lookup):
        if not allowed():return False
        with self.lock:
            now=time.time()
            row=next((r for r in self.data['metadata'].values() if r['state']=='queued' and r.get('retry_at',0)<=now),None)
            if row is None:return False
            row.update(state='processing',revision=row['revision']+1);version=row['revision'];captured=copy.deepcopy(row);self.dirty=True;self.flush()
        try:
            result=resolver(captured)
            if not isinstance(result,dict) or not isinstance(result.get('values',{}),dict):raise ReviewError('Invalid metadata result.')
            result['values']={key:text(value,80 if key=='genre' else 120) for key,value in result.get('values',{}).items() if key in FIELDS}
        except Throttled:result='throttled'
        except Exception:result=None
        with self.lock:
            if row['revision']!=version or row['state']!='processing':return True
            if result=='throttled':
                # Being told to slow down is not the song's fault: try it again in two minutes
                # without using one of its attempts.
                row.update(state='queued',retry_at=time.time()+120,revision=row['revision']+1)
                self.dirty=True;self.flush();return True
            if result is None:
                attempts=row.get('attempts',0)
                if attempts<len(RETRY_SECONDS):
                    row.update(state='queued',attempts=attempts+1,retry_at=time.time()+RETRY_SECONDS[attempts],revision=row['revision']+1)
                    self.dirty=True;self.flush();return True
                result=dict(values={},suggested={},source_url='',source='Lookup unavailable; review manually')
            row['lookup_version']=LOOKUP_VERSION
            row.update(suggested=result.get('suggested',{}),source=result.get('source',''),source_url=result.get('source_url',''))
            if result.get('candidates'):row['candidates']=[{k:str(c.get(k,''))[:200] for k in ('source','artist','album','album_type','genre','url')} for c in result['candidates'][:6]]
            self._apply(row,{k:v for k,v in result.get('values',{}).items() if k in row['missing']})
            self.flush()
        return True

    def apply_votes(self,votes,label):
        """Fills fields a model vote agreed on and shows the rest as suggestions; owner edits win."""
        applied=0
        with self.lock:
            for vote in votes if isinstance(votes,list) else []:
                row=self.data['metadata'].get(vote.get('id')) if isinstance(vote,dict) else None
                if not row or row.get('sha256')!=vote.get('sha256') or row['state']!='review':continue
                agreed={k:v for k,v in (vote.get('values') or {}).items() if k in row['missing'] and isinstance(v,str)}
                hints={k:v for k,v in (vote.get('suggested') or {}).items() if k in row['missing'] and isinstance(v,str) and not missing(v)}
                try:
                    agreed={k:text(v,80 if k=='genre' else 120) for k,v in agreed.items()}
                    hints={k:text(v,80 if k=='genre' else 120) for k,v in hints.items()}
                except ReviewError:continue
                row['suggested']={**row.get('suggested',{}),**hints,**agreed}
                row['source']=label;row['ai_vote']=True
                if agreed:self._apply(row,agreed);applied+=1
                else:row['revision']+=1;self.dirty=True
            self.flush()
        return applied

    def progress(self):
        # Server work row for the tagger: this lookup pass's songs, done and left.
        with self.lock:
            rows=self.data['metadata'].values()
            left=[r for r in rows if r['state'] in ('queued','processing')]
            if not left:return None
            done=sum(1 for r in rows if r.get('lookup_version')==LOOKUP_VERSION and r['state'] not in ('queued','processing'))
            now=time.time()
            waiting=sum(1 for r in left if r['state']=='queued' and r.get('retry_at',0)>now)
            current=next((r['title'] for r in left if r['state']=='processing'),'')
            return dict(processed=done,total=done+len(left),remaining=len(left),waiting=waiting,current_title=current)

    def snapshot(self,query="",limit=100):
        with self.lock:
            self.flush()
            trim=[copy.deepcopy(r) for r in self.data['trimming'].values() if r['state']!='done']
            metadata=[copy.deepcopy(r) for r in self.data['metadata'].values() if r['state']!='done']
            if query:
                wanted=normal(query);trim=[r for r in trim if wanted in normal(r['title']+' '+r['artist'])];metadata=[r for r in metadata if wanted in normal(r['title']+' '+r['current']['artist'])]
            metadata.sort(key=lambda row:(row['state']!='review',row['title'].casefold()))
            return dict(trimming=trim[:limit],metadata=metadata[:limit],trimming_total=len(trim),metadata_total=len(metadata))


def register(app,body,review,recording,admin,rate):
    import math
    from flask import g,jsonify,request
    @app.errorhandler(ReviewError)
    def invalid_review(error):return jsonify(error=str(error)),error.status
    @app.get('/api/catalogue/review')
    def review_queues():
        query=request.args.get('q','')
        if len(query)>120:raise ReviewError('Search up to 120 characters.')
        try:limit=int(request.args.get('limit','100'))
        except ValueError:raise ReviewError('Choose a valid review page size.')
        if not 1<=limit<=review.MAX_ROWS:raise ReviewError('Choose a valid review page size.')
        return jsonify(**review.snapshot(query,limit),can_edit=admin())

    @app.post('/api/catalogue/trimming')
    def request_trimming():
        data=body(2048);identifier=data.get('id');position=data.get('position',0)
        if not isinstance(identifier,str) or not ID.fullmatch(identifier):raise ReviewError('Choose a saved song.')
        if type(position) not in (int,float) or not math.isfinite(position) or not 0<=position<=86400:raise ReviewError('Invalid song position.')
        rate()
        track,digest=recording(identifier)
        return jsonify(request=review.flag_trim(track,digest,g.user,position)),201

    @app.post('/api/catalogue/trimming/<identifier>/resolve')
    def resolve_trimming(identifier):
        if not admin():return jsonify(error='Only the admin can resolve trimming requests.'),403
        body(1024);review.resolve_trim(identifier);return jsonify(ok=True)

    @app.patch('/api/catalogue/metadata/<identifier>')
    def edit_metadata(identifier):
        if not admin():return jsonify(error='Only the admin can edit shared song metadata.'),403
        data=body(4096)
        recording(identifier)
        return jsonify(metadata=review.edit_metadata(identifier,data.get('revision'),data.get('values')))
