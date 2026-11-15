#!/usr/bin/env python3
"""Verify FamilyHub sample playback through the native Jellyfin and Navidrome APIs.

Run as root inside the Debian VM. Setup mode initialises fresh servers and creates users;
--verify-only only reads (re-authenticates, checks earlier state and the raw FLAC bytes).
Stdlib only. Prints concise check JSON; never prints passwords or tokens.
"""
import argparse, hashlib, json, os, secrets, stat, sys, time, urllib.error, urllib.parse, urllib.request

JF, ND = "http://127.0.0.1:8096", "http://127.0.0.1:4533"
USERS = {"admin": "fh-admin", "a": "sample-a", "b": "sample-b"}
JF_AUTH = 'MediaBrowser Client="FamilyHubCheck", Device="Dev", DeviceId="familyhub-check-dev", Version="1"'
checks = []


class Fail(Exception):
    pass


def http(method, url, headers=None, body=None, form=None, stage="", ok=(200, 201, 204)):
    h = dict(headers or {})
    data = None
    if body is not None:
        data, h["Content-Type"] = json.dumps(body).encode(), "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            st, hd, raw = r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        st, hd, raw = e.code, e.headers, b""
    except OSError as e:
        raise Fail(f"{stage}: connection failed ({type(e).__name__})")
    if ok and st not in ok:
        raise Fail(f"{stage}: HTTP {st}")
    return st, hd, raw


def jget(*a, **k):
    st, _, raw = http(*a, **k)
    return json.loads(raw) if raw else None


def check(name, fn):
    try:
        detail = fn()
        checks.append({"check": name, "ok": True, **({"detail": detail} if detail else {})})
    except (Fail, AssertionError, KeyError, IndexError, ValueError, OSError) as e:
        checks.append({"check": name, "ok": False, "detail": f"{type(e).__name__}: {e}"})


def finish(code=0):
    ok = all(c["ok"] for c in checks) and code == 0
    print(json.dumps({"ok": ok, "checks": checks}, indent=1))
    sys.exit(0 if ok else 1)


def die(msg):
    checks.append({"check": "fatal", "ok": False, "detail": msg})
    finish(1)


# ---- state: private dir and credential file, symlinks rejected ----
def load_state(d, create):
    if os.path.lexists(d):
        if stat.S_ISLNK(os.lstat(d).st_mode) or not os.path.isdir(d):
            die("state dir is a symlink or not a directory")
    elif create:
        os.makedirs(d, mode=0o700)
    else:
        die("state dir missing; run setup first")
    if create:
        os.chmod(d, 0o700)
    elif os.stat(d).st_mode & 0o077:
        die("state dir is not private (0700)")
    f = os.path.join(d, "credentials.json")
    if os.path.lexists(f):
        if stat.S_ISLNK(os.lstat(f).st_mode):
            die("credential file is a symlink")
        if os.stat(f).st_mode & 0o077:
            die("credential file is not private (0600)")
        with open(f) as fh:
            return f, json.load(fh)
    return f, {}


def save_state(f, creds):
    tmp = f + ".tmp"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(creds, fh)
    os.replace(tmp, f)


def new_creds():
    return {k: secrets.token_urlsafe(18) for k in USERS}


# ---- Jellyfin ----
def jf_hdr(tok=None):
    return {"Authorization": f'MediaBrowser Token="{tok}"'} if tok else {"Authorization": JF_AUTH}


def jf_setup(pw):
    http("GET", JF + "/Startup/Configuration", stage="jf startup config", ok=None)
    http("GET", JF + "/Startup/User", stage="jf startup user", ok=None)  # primes the default user on some versions
    h = jf_hdr()
    http("POST", JF + "/Startup/Configuration", h, {"ServerName": "FamilyHub", "UICulture": "en-US",
         "MetadataCountryCode": "US", "PreferredMetadataLanguage": "en"}, stage="jf startup config")
    http("POST", JF + "/Startup/User", h, {"Name": USERS["admin"], "Password": pw["admin"]}, stage="jf startup user")
    http("POST", JF + "/Startup/Complete", h, stage="jf startup complete")


def jf_login(user, pw):
    headers = {"Authorization": JF_AUTH.replace("familyhub-check-dev", "familyhub-check-" + user)}
    r = jget("POST", JF + "/Users/AuthenticateByName", headers, {"Username": user, "Pw": pw}, stage=f"jf login {user}")
    return r["AccessToken"], r["User"]["Id"], r["User"]["Policy"]["IsAdministrator"]


def jf_provision(tok, pw):
    h = jf_hdr(tok)
    have = {u["Name"]: u["Id"] for u in jget("GET", JF + "/Users", h, stage="jf list users")}
    for k in ("a", "b"):
        n = USERS[k]
        if n not in have:
            have[n] = jget("POST", JF + "/Users/New", h, {"Name": n, "Password": pw[k]}, stage="jf create user")["Id"]
        pol = jget("GET", f"{JF}/Users/{have[n]}", h, stage="jf get user")["Policy"]
        pol.update(IsAdministrator=False, EnableAllFolders=True, EnableMediaPlayback=True)
        http("POST", f"{JF}/Users/{have[n]}/Policy", h, pol, stage="jf set policy")
    existing = {v["Name"]: v for v in jget("GET", JF + "/Library/VirtualFolders", h, stage="jf libraries")}
    type_options = [{"Type": t, "MetadataFetchers": [], "MetadataFetcherOrder": [], "ImageFetchers": [],
                     "ImageFetcherOrder": [], "ImageOptions": [], "SimilarItemProviders": [], "SimilarItemProviderOrder": []}
                    for t in ("Movie", "Series", "Season", "Episode")]
    for name, ctype, path in (("SamplesMovies", "movies", "/data/movies"), ("SamplesTV", "tvshows", "/data/tv")):
        if name not in existing:
            q = urllib.parse.urlencode({"name": name, "collectionType": ctype, "refreshLibrary": "true"})
            http("POST", f"{JF}/Library/VirtualFolders?{q}", h, {"LibraryOptions": {
                "PathInfos": [{"Path": path}], "EnableInternetProviders": False, "EnableRealtimeMonitor": True,
                "TypeOptions": type_options}},
                stage=f"jf create library {name}")
        elif existing[name]["LibraryOptions"].get("TypeOptions") != type_options:
            opts = existing[name]["LibraryOptions"]
            opts.update(EnableInternetProviders=False, TypeOptions=type_options)
            http("POST", JF + "/Library/VirtualFolders/LibraryOptions", h,
                 {"Id": existing[name]["ItemId"], "LibraryOptions": opts}, stage="jf sample provider options")
            http("POST", f"{JF}/Items/{existing[name]['ItemId']}/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=FullRefresh&replaceAllMetadata=true&replaceAllImages=true",
                 h, stage="jf refresh local sample metadata", ok=(200, 202, 204))


def jf_items(tok, uid, wait):
    q = urllib.parse.urlencode({"userId": uid, "Recursive": "true", "IncludeItemTypes": "Movie,Episode",
                                "Fields": "MediaSources"})
    end = time.time() + wait
    while True:
        items = jget("GET", f"{JF}/Items?{q}", jf_hdr(tok), stage="jf items")["Items"]
        if len([i for i in items if i["Type"] == "Movie"]) == 2 and len([i for i in items if i["Type"] == "Episode"]) == 1:
            return items
        if time.time() > end:
            raise Fail(f"jf items: only {len(items)} indexed before timeout")
        time.sleep(5)


def height(item):
    return max((s.get("Height", 0) for s in item["MediaSources"][0]["MediaStreams"] if s["Type"] == "Video"), default=0)


def jf_userdata(tok, uid, iid):
    st, _, raw = http("GET", f"{JF}/Items/{iid}?userId={uid}", jf_hdr(tok), stage="jf item", ok=None)
    if st == 404:  # older route
        st, _, raw = http("GET", f"{JF}/Users/{uid}/Items/{iid}", jf_hdr(tok), stage="jf item (legacy)")
    elif st != 200:
        raise Fail(f"jf item: HTTP {st}")
    return json.loads(raw)["UserData"]


def verify_jellyfin(pw, args):
    s = {}
    for k in USERS:
        s[k] = None
        def f(k=k):
            s[k] = jf_login(USERS[k], pw[k])
            assert s[k][2] == (k == "admin"), "unexpected IsAdministrator"
            return f"IsAdministrator={s[k][2]}"
        check(f"jellyfin login {USERS[k]}", f)
    if not all(s.values()):
        return
    ta, ua, _ = s["a"]
    tb, ub, _ = s["b"]
    items = []
    def idx():
        items.extend(jf_items(ta, ua, 0 if args.verify_only else args.scan_timeout))
        return f"{len(items)} items"
    check("jellyfin library indexed (2 movies + episode)", idx)
    if not items:
        return
    movies = sorted((i for i in items if i["Type"] == "Movie"), key=height)
    check("jellyfin heights 1080p and 2160p present", lambda: [height(m) for m in movies] == [1080, 2160] or
          (_ for _ in ()).throw(AssertionError(f"heights {[height(m) for m in movies]}")))
    m1080 = next((m for m in movies if height(m) == 1080), movies[0])
    if not args.verify_only:
        for movie in movies:
            dto = jget("GET", f"{JF}/Items/{movie['Id']}?userId={s['admin'][1]}", jf_hdr(s['admin'][0]), stage="jf fixture metadata")
            if not dto.get("Path", "").startswith("/data/movies/FamilyHub Samples/Sample "):
                raise Fail("refusing metadata changes outside generated sample movies")
            title = "FamilyHub Sample 1080p" if height(movie) == 1080 else "FamilyHub Sample 4K HEVC"
            if dto["Name"] != title or dto.get("ProviderIds") or dto.get("People") or dto.get("Overview") != "Synthetic test pattern and tones.":
                dto.update(Name=title, OriginalTitle=title, SortName=title, ProviderIds={}, LockData=True,
                           LockedFields=["Name", "Overview"], Overview="Synthetic test pattern and tones.",
                           People=[], Genres=[], Studios=[], Tags=[], Taglines=[], OfficialRating=None,
                           CommunityRating=None, CriticRating=None)
                http("POST", f"{JF}/Items/{movie['Id']}", jf_hdr(s['admin'][0]), dto, stage="jf label synthetic movie")
                if dto.get("ImageTags", {}).get("Primary"):
                    http("DELETE", f"{JF}/Items/{movie['Id']}/Images/Primary", jf_hdr(s['admin'][0]), stage="jf remove mismatched sample artwork")
                movie["Name"] = title
        def mark():
            http("POST", f"{JF}/UserFavoriteItems/{m1080['Id']}?userId={ua}", jf_hdr(ta), stage="jf favorite")
            http("POST", f"{JF}/UserPlayedItems/{m1080['Id']}?userId={ua}", jf_hdr(ta), stage="jf played")
        check("jellyfin user A marks 1080p favorite+played", mark)

    def labels():
        names = {i["Name"] for i in jf_items(ta, ua, 0) if i["Type"] == "Movie"}
        assert names == {"FamilyHub Sample 1080p", "FamilyHub Sample 4K HEVC"}, "synthetic titles were replaced"
    check("jellyfin synthetic titles remain distinct", labels)

    def state():
        da, db = jf_userdata(ta, ua, m1080["Id"]), jf_userdata(tb, ub, m1080["Id"])
        assert da["IsFavorite"] and da["Played"], "A state missing"
        assert not db["IsFavorite"] and not db["Played"], "B shares A state"
        return "A favorite+played, B neither"
    check("jellyfin per-user state differs", state)

    def denied():
        endpoint = JF + "/System/Configuration/MetadataOptions/Default"
        st = http("GET", endpoint, jf_hdr(ta), stage="jf admin metadata defaults as A", ok=None)[0]
        assert st in (401, 403), f"ordinary user got HTTP {st}"
        ad = http("GET", endpoint, jf_hdr(s['admin'][0]), stage="jf admin metadata defaults as admin", ok=None)[0]
        assert ad == 200, f"admin control got HTTP {ad}"
        return f"user HTTP {st}, admin HTTP {ad}"
    check("jellyfin ordinary user denied admin metadata defaults", denied)

    def rng(item=m1080):
        iid = item["Id"]
        pi = jget("POST", f"{JF}/Items/{iid}/PlaybackInfo?userId={ua}", jf_hdr(ta), {}, stage="jf playbackinfo")
        src = pi["MediaSources"][0]
        h = dict(jf_hdr(ta), Range="bytes=0-4095")
        st, hd, raw = http("GET", f"{JF}/Videos/{iid}/stream?static=true", h, stage="jf stream", ok=(206,))
        assert len(raw) == 4096 and raw[:4] == b"\x1a\x45\xdf\xa3", "not 4096 Matroska bytes"
        local = os.path.join(args.media_root, "movies", "FamilyHub Samples", "Sample 1080p (2026)", "Sample 1080p (2026).mkv")
        with open(local, "rb") as fh:
            assert fh.read(4096) == raw, "range bytes differ from original file"
        return f"HTTP 206, 4096 bytes match original; DirectPlay={src.get('SupportsDirectPlay')} (no decode claim)"
    check("jellyfin 1080p static Range bytes match original", rng)
    # The generated episode hardlinks the movie fixture; indexing alone can hide a stale path.
    for episode in (i for i in items if i["Type"] == "Episode"):
        check("jellyfin episode static Range bytes match original", lambda ep=episode: rng(ep))


# ---- Navidrome ----
def nd_login(user, pw):
    return jget("POST", ND + "/auth/login", body={"username": user, "password": pw}, stage=f"nd login {user}")


def nd_native(tok, method="GET", path="/api/user", body=None, ok=None):
    return http(method, ND + path, {"X-ND-Authorization": "Bearer " + tok}, body, stage="nd native " + path, ok=ok)


def nd_setup(pw):
    r = http("POST", ND + "/auth/createAdmin", body={"username": USERS["admin"], "password": pw["admin"]},
             stage="nd createAdmin", ok=None)
    if r[0] != 200:
        return False
    tok = json.loads(r[2])["token"]
    for k in ("a", "b"):
        nd_native(tok, "POST", "/api/user", {"userName": USERS[k], "name": USERS[k], "password": pw[k],
                                              "isAdmin": False}, ok=(200, 201))
    return True


def sub(user, pw, method, **p):
    salt = secrets.token_hex(8)
    form = {"f": "json", "v": "1.16.1", "c": "FamilyHubCheck", "u": user, "s": salt,
            "t": hashlib.md5((pw + salt).encode()).hexdigest(), **p}
    _, _, raw = http("POST", f"{ND}/rest/{method}.view", form=form, stage=f"nd {method}")
    return raw


def sj(user, pw, method, **p):
    r = json.loads(sub(user, pw, method, **p))["subsonic-response"]
    if r["status"] != "ok":
        raise Fail(f"nd {method}: subsonic error {r.get('error', {}).get('code')}")
    return r


def sha(stream):
    h = hashlib.sha256()
    for c in iter(lambda: stream.read(1 << 20), b""):
        h.update(c)
    return h.hexdigest()


def verify_navidrome(pw, args):
    sessions = {}
    for k in USERS:
        def f(k=k):
            r = nd_login(USERS[k], pw[k])
            sessions[k] = r
            assert r.get("isAdmin", False) == (k == "admin"), f"isAdmin={r.get('isAdmin')}"
            return f"isAdmin={r.get('isAdmin', False)}"
        check(f"navidrome login {USERS[k]}", f)

    def native():
        st = nd_native(sessions["a"]["token"])[0]
        assert st in (401, 403), f"HTTP {st}: not proven denied (login isAdmin=false is the evidence)"
        return f"HTTP {st}"
    check("navidrome ordinary user denied /api/user", native)

    def scan():
        if not args.verify_only:
            sj(USERS["admin"], pw["admin"], "startScan")
        end = time.time() + (0 if args.verify_only else args.scan_timeout)
        while sj(USERS["admin"], pw["admin"], "getScanStatus")["scanStatus"].get("scanning") and time.time() < end:
            time.sleep(3)
    check("navidrome scan", scan)
    songs = []
    def albums():
        al = sj(USERS["a"], pw["a"], "getAlbumList2", type="alphabeticalByName", size=50)["albumList2"].get("album", [])
        fixture_names = {"Sample CD 16-44.1", "Sample HiRes 24-96"}
        al = [a for a in al if a.get("artist") == "Sample Artist" and a.get("name") in fixture_names]
        assert {a["name"] for a in al} == fixture_names, "sample albums missing from the first 50 albums"
        assert len(al) == 2, f"{len(al)} albums"
        for a in al:
            songs.extend(sj(USERS["a"], pw["a"], "getAlbum", id=a["id"])["album"]["song"])
        assert len(songs) == 4, f"{len(songs)} songs"
        return [a["name"] for a in al]
    check("navidrome 2 albums / 4 songs", albums)
    if len(songs) != 4:
        return
    songs.sort(key=lambda s: s["path"])
    if not args.verify_only:
        check("navidrome user A stars song", lambda: sj(USERS["a"], pw["a"], "star", id=songs[0]["id"]) and None)

    def starred(u, k):
        return [s["id"] for s in sj(USERS[u], pw[k], "getStarred2").get("starred2", {}).get("song", [])]
    def star_diff():
        assert starred("a", "a") == [songs[0]["id"]], "A star missing"
        assert starred("b", "b") == [], "B shares A star"
        return "A starred, B not"
    check("navidrome per-user star differs", star_diff)

    music = os.path.join(args.media_root, "music")
    def raw_one(s):
        def f():
            p = s["path"].lstrip("/")
            local = next((c for c in (os.path.join(music, p), os.path.join(music, p.split("/", 1)[-1]),
                                      os.path.join(music, "FamilyHub Samples", p)) if os.path.isfile(c)), None)
            assert local and not os.path.islink(local), f"no local original for {p}"
            salt = secrets.token_hex(8)
            form = urllib.parse.urlencode({"f": "json", "v": "1.16.1", "c": "FamilyHubCheck", "u": USERS["a"], "s": salt,
                                           "t": hashlib.md5((pw["a"] + salt).encode()).hexdigest(),
                                           "id": s["id"], "format": "raw"}).encode()
            try:
                with urllib.request.urlopen(f"{ND}/rest/stream.view", form, timeout=120) as r:
                    ct, got = r.headers.get("Content-Type", ""), sha(r)
            except urllib.error.HTTPError as e:
                raise Fail(f"nd stream: HTTP {e.code}")
            with open(local, "rb") as fh:
                assert got == sha(fh), f"SHA256 differs from original ({ct})"
            return "raw bytes identical"
        check(f"navidrome raw stream {os.path.basename(s['path'])}", f)
    for s in songs:
        raw_one(s)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--state-dir", default="/srv/familyhub/appdata/playback-check")
    ap.add_argument("--media-root", default="/srv/familyhub/data/media")
    ap.add_argument("--verify-only", action="store_true", help="read-only: no setup, users, libraries or favorites")
    ap.add_argument("--scan-timeout", type=int, default=240)
    args = ap.parse_args()
    cf, creds = load_state(args.state_dir, not args.verify_only)

    if not args.verify_only:
        try:
            if not jget("GET", JF + "/System/Info/Public", stage="jf public info").get("StartupWizardCompleted"):
                if "jellyfin" not in creds:
                    creds["jellyfin"] = new_creds()
                    save_state(cf, creds)
                jf_setup(creds["jellyfin"])
            elif "jellyfin" not in creds:
                die("Jellyfin is already configured but credential state is missing; not resetting it")
            tok = jf_login(USERS["admin"], creds["jellyfin"]["admin"])[0]
            jf_provision(tok, creds["jellyfin"])
            if "navidrome" not in creds:
                fresh = new_creds()
                creds["navidrome"] = fresh
                save_state(cf, creds)
                if not nd_setup(fresh):
                    die("Navidrome already has an admin but credential state is missing; not resetting it")
            else:
                tok = nd_login(USERS["admin"], creds["navidrome"]["admin"])["token"]
                have = {u["userName"] for u in json.loads(nd_native(tok, ok=(200,))[2])}
                for k in ("a", "b"):
                    if USERS[k] not in have:
                        nd_native(tok, "POST", "/api/user", {"userName": USERS[k], "name": USERS[k],
                                  "password": creds["navidrome"][k], "isAdmin": False}, ok=(200, 201))
        except Fail as e:
            die(str(e))
    for svc in ("jellyfin", "navidrome"):
        if svc not in creds:
            die(f"no {svc} credentials in state dir")
    try:
        verify_jellyfin(creds["jellyfin"], args)
        verify_navidrome(creds["navidrome"], args)
    except Fail as e:
        die(str(e))
    finish()


if __name__ == "__main__":
    main()
