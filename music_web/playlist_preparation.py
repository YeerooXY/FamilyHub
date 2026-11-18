"""Resumable playlist matching and acquisition through the existing music queue."""
import threading
import time
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from .playlists import PlaylistError, rank_matches, preferred_match
from .worker_activity import WorkerActivity
from .resources import observe, background_request


class _PlaylistOperation:
    def __init__(self, store, lock, prepare, match=None, read=None, download_workers=1):
        self.download_workers = max(1, min(3, download_workers))
        self.store, self.lock, self.prepare = store, lock, prepare
        self.match, self.read = match, read
        self.thread = None
        self.stop = threading.Event()
        self.active = None

    def status(self, user, pid):
        with self.lock:
            data = self.store.read(user, pid)
            status = data.get("preparation", {"state": "idle", "mode": "match"})
            if status["state"] in ("running", "pausing") and self.active != (user, pid):
                status = {**status, "state": "paused", "message": "Server restarted. Import the playlist again." if status.get("phase") == "reading" else "Server restarted. Resume to continue."}
                data["preparation"] = status
                self.store.save(user, data)
            if status["state"] == "done" and self.active != (user, pid):
                start_index = status.get("start_index", 0) if status.get("playlist_revision") == data["revision"] else 0
                tracks = data["tracks"][start_index:]
                status = {**status, "total": len(tracks),
                          "processed": sum(t.get("state") in ("ready", "saved", "review", "error", "preparing") for t in tracks),
                          "found": sum(t.get("state") in ("ready", "saved") for t in tracks),
                          "saved": sum(t.get("state") == "saved" for t in tracks),
                          "review": sum(t.get("state") == "review" for t in tracks),
                          "failed": sum(t.get("state") == "error" for t in tracks)}
                status["recent"] = [{"index": start_index + i + 1, "title": t["title"], "artist": t["artist"], "state": t["state"]}
                                    for i, t in list(enumerate(tracks))[-8:]]
            return deepcopy(status)

    def _claim(self, user, pid):
        if self.active:
            raise ValueError("Another playlist operation is running. Wait for it to finish.")
        self.active = (user, pid)
        self.stop.clear()

    @staticmethod
    def _status(mode, total=0):
        return {"state": "running", "mode": mode, "phase": "reading" if mode == "import" else "matching" if mode == "match" else "download",
                "total": total, "processed": 0, "cursor": 0, "completed_after": [], "active_searches": 0,
                "download_after_matching": False,
                "found": 0, "saved": 0, "review": 0, "failed": 0,
                "index": 0, "title": "", "message": "Reading playlist" if mode == "import" else "Starting", "recent": []}

    def begin_import(self, user, pid, revision, provider, url, download=True, name=None, append=False, actor=None):
        with self.lock:
            data = self.store.read(user, pid)
            if (data["tracks"] and not append) or type(revision) is not int or revision != data["revision"]:
                raise ValueError("Refresh this playlist before adding songs." if append else "Import into an empty, unchanged playlist.")
            previous = data.get("preparation", {})
            # A new import downloads its matched songs straight away; re-importing keeps a
            # download the owner paused or cancelled.
            same = previous.get("import_url") == url and previous.get("provider") == provider
            queued_download = download is not False and (append or (same and previous.get("download_after_matching") is True) or (
                not data.get("auto_download_paused") and (not same or previous.get("state") not in ("paused", "error"))))
            if download is False: data["auto_download_paused"] = True
            elif append: data["auto_download_paused"] = False
            self._claim(user, pid)
            data["preparation"] = {**self._status("import"), "provider": provider, "import_url": url,
                                   "download_after_matching": queued_download, "append": append, "actor": actor or user}
            # A name typed in Create playlist wins over the source's name.
            if name: data["preparation"]["name"] = name
            try:
                self.store.save(user, data)
                self.thread = threading.Thread(target=self._import, args=(user, pid, provider, url), daemon=True)
                self.thread.start()
            except Exception:
                self.active = None
                raise
            return deepcopy(data["preparation"])

    def start(self, user, pid, mode="download"):
        if mode not in ("download", "match"):
            raise ValueError("Choose matching or downloading.")
        with self.lock:
            data = self.store.read(user, pid)
            if self.active == (user, pid):
                if mode == "download" and data["preparation"].get("mode") != "download":
                    data["preparation"]["download_after_matching"] = True
                    if data["preparation"]["state"] == "done":
                        data["preparation"].update(state="running", message="Starting server downloads")
                    self.store.save(user, data)
                return self.status(user, pid)
            if not data["tracks"]: raise ValueError("Import songs first.")
            # A direct resume request after restart must not rely on a preceding status poll.
            previous = self.status(user, pid)
            queued_download = previous.get("download_after_matching") is True
            if mode == "download" and previous.get("state") == "paused" and previous.get("mode") in ("import", "match"):
                mode = "match"
                queued_download = True
            self._claim(user, pid)
            resume = (previous.get("state") == "paused" and previous.get("phase") != "reading"
                      and previous.get("playlist_revision") == data["revision"]
                      and (previous.get("mode") == mode or mode == "match" and previous.get("mode") == "import"))
            start_index = previous.get("cursor", previous.get("processed", 0)) if resume else 0
            data["preparation"] = ({**previous, "state": "running", "mode": mode, "message": "Resuming"}
                                   if resume else self._status(mode, len(data["tracks"])))
            data["preparation"]["playlist_revision"] = data["revision"]
            if (previous.get("append") and previous.get("playlist_revision") == data["revision"]
                    and (previous.get("state") == "paused" or mode == "download" and previous.get("mode") in ("import", "match"))):
                first_index = previous.get("start_index", 0)
                data["preparation"].update(append=True, start_index=first_index, total=len(data["tracks"]) - first_index)
            data["preparation"]["download_after_matching"] = queued_download if mode != "download" else False
            if mode == "download" and previous.get("state") == "done" and previous.get("mode") in ("import", "match"):
                data["preparation"]["matched_only"] = True
            try:
                self.store.save(user, data)
                self.thread = threading.Thread(target=self._run, args=(user, pid, mode, start_index), daemon=True)
                self.thread.start()
            except Exception:
                self.active = None
                raise
            return deepcopy(data["preparation"])

    def pause(self, user, pid):
        with self.lock:
            self.store.read(user, pid)
            if self.active == (user, pid):
                self.stop.set()
                self.update(user, pid, state="pausing", message="Pausing after current searches" if self.store.read(user, pid)["preparation"].get("mode") != "download" else "Pausing after the current song")
            return self.status(user, pid)

    def update(self, user, pid, **changes):
        with self.lock:
            data = self.store.read(user, pid)
            data["preparation"].update(changes)
            self.store.save(user, data)

    def _import(self, user, pid, provider, url):
        delegated = False
        try:
            def progress(loaded, total):
                self.update(user, pid, loaded=loaded, total=total, message=f"Read {loaded} of {total} {'releases' if provider == 'spotify' and '/artist/' in url else 'songs'}")
                if self.stop.is_set(): raise InterruptedError()
            imported = self.read(provider, url, progress)
            if self.stop.is_set(): raise InterruptedError()
            with self.lock:
                original = self.store.read(user, pid)
                append = original["preparation"].get("append", False)
                start_index = len(original["tracks"]) if append else 0
                imported["id"] = pid
                if original["preparation"].get("name"): imported["name"] = original["preparation"]["name"]
                imported["preparation"] = {**original["preparation"], "phase": "matching", "total": len(imported["tracks"]), "playlist_revision": original["revision"] + 1}
                imported = self.store.import_playlist(user, imported, append=append, actor=original["preparation"].get("actor"))
                imported["preparation"].update(total=len(imported["tracks"]) - start_index, start_index=start_index)
                self.store.save(user, imported)
            delegated = True
            self._run(user, pid, "import")
        except InterruptedError:
            self.update(user, pid, state="paused", message="Reading paused. Import the playlist again to continue.")
        except PlaylistError as error:
            self.update(user, pid, state="error", message=str(error))
        except Exception:
            self.update(user, pid, state="error", message="Could not read the public playlist. Check its link and try again.")
        finally:
            if not delegated:
                with self.lock:
                    if self.active == (user, pid): self.active = None

    def _run(self, user, pid, mode, start_index=0):
        phase_succeeded = False
        try:
            with self.lock:
                data = self.store.read(user, pid)
                tracks = deepcopy(data["tracks"])
                prior = data["preparation"]
            first_index = prior.get("start_index", 0)
            start_index = max(start_index, first_index)
            found, saved, review, failed = (prior.get(k, 0) for k in ("found", "saved", "review", "failed"))
            recent = deepcopy(prior.get("recent", []))
            cursor = start_index
            completed_after = {i for i in prior.get("completed_after", []) if type(i) is int and cursor <= i < len(tracks)}
            if mode != "download":
                rescued = []
                for index in sorted(set(range(first_index, cursor)) | completed_after):
                    track = tracks[index]
                    if track.get("state") != "review" or track.get("source_id") or track.get("match") or not track.get("candidates"):
                        continue
                    ranked = rank_matches(track, track["candidates"])
                    result = preferred_match(ranked)
                    if result is None: continue
                    track.update(candidates=ranked, source_id=result["id"], match=result, state="ready")
                    rescued.append(index)
                if rescued:
                    found += len(rescued); review = max(0, review - len(rescued))
                    for item in recent:
                        if item["index"] - 1 in rescued: item["state"] = "ready"
                    with self.lock:
                        data = self.store.read(user, pid)
                        for index in rescued: data["tracks"][index] = tracks[index]
                        data["preparation"].update(found=found, review=review, recent=recent)
                        self.store.save(user, data)
            remaining = iter((i, track) for i, track in enumerate(tracks) if i >= cursor and i not in completed_after)
            workers = self.download_workers if mode == "download" else 3
            file_progress = {}

            def process(index, track):
                if prior.get("automatic") and ((mode == "download" and track.get("state") not in ("ready","saved")) or (mode != "download" and track.get("state") in ("review","error"))):
                    return track
                def progress(message, **fields):
                    with self.lock:
                        if mode == "download":
                            current = file_progress.setdefault(index, {"index": index + 1, "title": track["title"]})
                            current.update(message=message, **fields)
                            visible = [dict(row) for _, row in sorted(file_progress.items())
                                       if row.get("file_phase") not in ("saved", "error")]
                            self.update(user, pid, active_downloads=visible, **(visible[0] if visible else current))
                        else:
                            self.update(user, pid, index=index + 1, title=track["title"], message=message, **fields)
                progress("Preparing recording" if mode == "download" else "Finding recording",
                         file_phase="queued" if mode == "download" else "matching",
                         download_bytes=0, download_total_bytes=None, file_size_bytes=None)
                try:
                    if mode == "download" and prior.get("matched_only") and not track.get("source_id") and not track.get("match"):
                        track["state"] = "error" if track.get("state") == "error" else "review"
                        progress("Choose a recording", file_phase="error")
                        return track
                    callback = self.prepare if mode == "download" else self.match
                    result = callback(user, track, progress)
                    if result is None:
                        track["state"] = "review"
                        if mode == "download": progress("Choose a recording", file_phase="error")
                    else:
                        track.update(source_id=result["id"], match=result,
                                     state="saved" if result.get("saved") else "ready")
                        if mode == "download" and result.get("saved"):
                            progress("Ready on server", file_phase="saved", file_size_bytes=result.get("download_size"))
                except InterruptedError:
                    return None
                except Exception:
                    track["state"] = "error"
                    if mode == "download": progress("Recording preparation failed", file_phase="error")
                return track

            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="playlist-match" if workers > 1 else "playlist-save") as pool:
                pending = {}
                exhausted = False
                while pending or not exhausted:
                    while len(pending) < workers and not self.stop.is_set() and not exhausted:
                        item = next(remaining, None)
                        if item is None:
                            exhausted = True
                            break
                        index, track = item
                        with self.lock:
                            if self.stop.is_set(): break
                            pending[pool.submit(process, index, track)] = index
                    self.update(user, pid, active_searches=len(pending) if mode != "download" else 0)
                    if not pending:
                        break
                    finished, _ = wait(pending, return_when=FIRST_COMPLETED)
                    for future in sorted(finished, key=lambda item: pending[item]):
                        index = pending.pop(future)
                        track = future.result()
                        if track is None: continue
                        found += int(track["state"] in ("ready", "saved"))
                        saved += int(track["state"] == "saved")
                        review += int(track["state"] == "review")
                        failed += int(track["state"] == "error")
                        completed_after.add(index)
                        while cursor in completed_after:
                            completed_after.remove(cursor)
                            cursor += 1
                        recent.append({"index": index + 1, "title": track["title"], "artist": track["artist"], "state": track["state"]})
                        recent = recent[-8:]
                        with self.lock:
                            data = self.store.read(user, pid)
                            data["tracks"][index] = track
                            # Save each finished search immediately; the cursor only crosses contiguous results.
                            data["preparation"].update(processed=cursor - first_index + len(completed_after), cursor=cursor,
                                completed_after=sorted(completed_after), found=found, saved=saved, review=review,
                                failed=failed, recent=recent, active_searches=len(pending) if mode != "download" else 0)
                            self.store.save(user, data)
            phase_succeeded = not self.stop.is_set()
            self.update(user, pid, state="paused" if self.stop.is_set() else "done", active_searches=0,
                        message="Paused" if self.stop.is_set() else "Downloads finished" if mode == "download" else "Matching finished")
        except Exception:
            self.update(user, pid, state="paused", active_searches=0, message="Operation stopped. Resume to retry.")
        finally:
            download_next = False
            with self.lock:
                if self.active == (user, pid):
                    data = self.store.read(user, pid)
                    if (phase_succeeded and mode != "download" and not self.stop.is_set()
                            and data["preparation"].get("download_after_matching") is True):
                        data["preparation"] = {**self._status("download", len(data["tracks"]) - data["preparation"].get("start_index",0)),
                                               "automatic": data["preparation"].get("automatic",False),
                                               "append": data["preparation"].get("append",False),
                                               "start_index": data["preparation"].get("start_index",0),
                                               "playlist_revision": data["revision"], "matched_only": True}
                        self.store.save(user, data)
                        download_next = True
                    else:
                        if self.stop.is_set() and data["preparation"].get("state") in ("running", "pausing", "done"):
                            data["preparation"].update(state="paused", active_searches=0, message="Paused")
                            self.store.save(user, data)
                        self.active = None
            if download_next:
                self._run(user, pid, "download")


class PlaylistPreparation:
    """Bounded independent operations sharing three fair background slots."""
    MAX_ACTIVE = 8
    WORKERS = 3

    def __init__(self, store, lock, prepare, match=None, read=None, download_workers=1, allow_background=lambda: True, resources=None):
        self.store, self.lock = store, lock
        self.prepare, self.match, self.read = prepare, match, read
        self.download_workers, self.allow_background = download_workers, allow_background
        self.operations = {}
        self.thread = None
        self.condition = threading.Condition()
        self.waiters, self.served, self.inflight, self.dispatch = [], {}, 0, 0
        self.auto_served = {}
        self.activity = WorkerActivity('playlist', 'Playlist matching / preparation', self.WORKERS)
        self.resources = resources

    def _execute(self, key, operation, callback):
        with observe(self.resources, "matching", "playlist slots") as state:
            return self._execute_queued(key, operation, callback, state)

    def _execute_queued(self, key, operation, callback, state):
        ticket = object()
        with self.condition:
            self.waiters.append((ticket,key))
        try:
            while True:
                # The admission predicate takes the jobs lock. Evaluate it outside
                # the condition to preserve the coordinator's lock order.
                allowed = self.allow_background()
                with self.condition:
                    if operation.stop.is_set(): raise InterruptedError()
                    chosen = min(self.waiters,key=lambda row:self.served.get(row[1],-1))
                    if self.inflight < self.WORKERS and chosen[0] is ticket and allowed:
                        self.waiters.remove((ticket,key))
                        self.inflight += 1; self.dispatch += 1; self.served[key] = self.dispatch
                        self.condition.notify_all()
                        break
                    state("playlist slots" if allowed else "playback demand")
                    self.condition.wait(.1)
        except BaseException:
            with self.condition:
                self.waiters.remove((ticket,key)); self.condition.notify_all()
            raise
        token = background_request.set(True)
        state()
        try:
            return callback()
        finally:
            background_request.reset(token)
            with self.condition:
                self.inflight -= 1; self.condition.notify_all()

    def _operation(self, user, pid):
        key = (user,pid)
        if key not in self.operations:
            if len(self.operations) >= 64:
                self.operations = {k: op for k,op in self.operations.items() if op.active is not None}
                with self.condition: self.served = {k:v for k,v in self.served.items() if k in self.operations}
            def wrap(callback):
                if callback is None: return None
                def run(owner, track, progress):
                    progress.playlist_id = pid
                    progress("Waiting for background slot" if self.allow_background() else "Waiting for playback preparation")
                    def execute():
                        with self.activity.track(track['title'], owner=owner, playlist_id=pid):
                            progress("Preparing recording" if callback is self.prepare else "Finding recording")
                            return callback(owner,track,progress)
                    return self._execute(key, operation, execute)
                return run
            def read(provider,url,progress):
                operation.update(user,pid,message="Waiting for background slot" if self.allow_background() else "Waiting for playback preparation")
                def execute():
                    with self.lock:
                        title = self.store.read(user, pid)['name']
                    with self.activity.track(title, owner=user, playlist_id=pid):
                        operation.update(user,pid,message="Reading playlist")
                        return self.read(provider,url,progress)
                return self._execute(key, operation, execute)
            operation = _PlaylistOperation(self.store,self.lock,wrap(self.prepare),wrap(self.match),read if self.read else None,self.download_workers)
            self.operations[key] = operation
        return self.operations[key]

    def is_active(self,user,pid):
        with self.lock:
            operation = self.operations.get((user,pid))
            return operation is not None and operation.active == (user,pid)

    def _admit(self,user,pid):
        if not self.is_active(user,pid) and sum(op.active is not None for op in self.operations.values()) >= self.MAX_ACTIVE:
            raise ValueError("Eight playlist operations are active. Pause one before starting another.")

    def start(self,user,pid,mode="download"):
        with self.lock:
            self._admit(user,pid)
            operation=self._operation(user,pid)
            data=self.store.read(user,pid)
            if data.get("preparation", {}).get("append") and data["preparation"].get("phase") == "reading" and operation.active is None:
                raise ValueError("Import the playlist link again to continue adding songs.")
            data["auto_download_paused"]=False; self.store.save(user,data)
            result=operation.start(user,pid,mode); self.thread=operation.thread
            return result

    def begin_import(self,user,pid,revision,provider,url,download=True,name=None,append=False,actor=None):
        with self.lock:
            self._admit(user,pid)
            operation=self._operation(user,pid)
            result=operation.begin_import(user,pid,revision,provider,url,download,name,append,actor); self.thread=operation.thread
            return result

    def status(self,user,pid):
        with self.lock: return self._operation(user,pid).status(user,pid)

    def pause(self,user,pid):
        with self.lock:
            data=self.store.read(user,pid); data["auto_download_paused"]=True; self.store.save(user,data)
            return self._operation(user,pid).pause(user,pid)

    def update(self,user,pid,**changes):
        with self.lock: self._operation(user,pid).update(user,pid,**changes)

    def work(self):
        with self.lock:
            result=[]
            for (owner,pid),operation in self.operations.items():
                if operation.active is None: continue
                data=self.store.read(owner,pid); status=data['preparation']
                processed=status.get('loaded',0) if status.get('phase')=='reading' else status.get('processed',0)
                result.append(dict(owner=owner,playlist_id=pid,title=data['name'],kind='playlist_'+('catalogue' if status['mode']=='match' else status['mode']),
                    state='queued' if status.get('message','').startswith('Waiting') else status['state'],phase=status.get('message',''),processed=processed,total=status.get('total',0),
                    remaining=max(0,status.get('total',0)-processed),current_title=status.get('title',''),
                    files=deepcopy(status.get('active_downloads',[])),download_bytes=status.get('download_bytes',0),download_total_bytes=status.get('download_total_bytes')))
            return result


    def queue_idle(self,owners,idle,limit=3):
        """Keep up to `limit` playlists preparing, preserving manual pauses and recording reviews.
        A finished playlist frees its place for the next one at the following check."""
        if not idle() or not self.allow_background(): return []
        with self.lock:
            running={key for key,op in self.operations.items() if op.active is not None}
            limit=min(limit,3)-len(running)
            if limit<=0: return []
            candidates=[]
            for owner in owners:
                for data in self.store.list(owner):
                    if (owner,data['id']) in running: continue
                    prior=data.get('preparation',{})
                    if data.get('auto_download_paused') or prior.get('state')=='error': continue
                    if prior.get('state')=='paused' and not prior.get('automatic'): continue
                    if prior.get('state')=='paused' and prior.get('message','').startswith('Operation stopped.'): continue
                    tracks=data['tracks']
                    unmatched=any(t.get('state','unmatched')=='unmatched' for t in tracks)
                    ready=any(t.get('state')=='ready' and (t.get('source_id') or t.get('match')) for t in tracks)
                    if unmatched or ready:
                        key=(owner,data['id'])
                        candidates.append((self.auto_served.get(key,-1),key,'match' if unmatched else 'download'))
            selected=[]
            for _,(owner,pid),mode in sorted(candidates)[:limit]:
                if not idle() or not self.allow_background(): break
                self.start(owner,pid,mode)
                operation=self._operation(owner,pid)
                operation.update(owner,pid,automatic=True,matched_only=True,download_after_matching=mode=='match')
                self.auto_served[(owner,pid)]=time.monotonic()
                selected.append((owner,pid))
            valid={key for _,key,_ in candidates}|running
            self.auto_served={key:value for key,value in self.auto_served.items() if key in valid}
            return selected
