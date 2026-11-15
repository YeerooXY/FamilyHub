"""Build an offline listening/review sheet from the read-only library edge scan."""
import argparse
import csv
import json
import math
from pathlib import Path


def spreadsheet_text(value):
    value = str(value)
    return "'" + value if value.lstrip().startswith(('=', '+', '-', '@')) else value


def build(directory, decisions_path=None):
    data = json.loads((directory / 'results.json').read_text(encoding='utf-8'))
    imported = {}
    if decisions_path:
        exported = json.loads(decisions_path.read_text(encoding='utf-8-sig'))
        if exported.get('detector') != data['detector']:
            raise ValueError('Detector version mismatch')
        tracks = {t['id']: t for t in data['tracks']}
        for decision in exported['decisions']:
            t = tracks[decision['id']]
            a, b = decision['start'], decision['end']
            if (decision['id'] in imported or decision['sha256'] != t['sha256']
                    or decision['decision'] not in ('pending', 'use-proposal', 'keep-original', 'custom')
                    or not isinstance(decision.get('notes'), str)
                    or any(type(v) not in (int, float) or not math.isfinite(v) for v in (a, b))
                    or not 0 <= a < b <= t['duration']):
                raise ValueError('Invalid or outdated review decision')
            imported[t['id']] = decision
    data['decisions'] = imported
    data['tracks'].sort(key=lambda t: (not bool(imported.get(t['id'], {}).get('notes', '').strip()),
        -(t['proposed_start'] + t['duration'] - t['proposed_end']), t['artist'], t['title']))
    with (directory / 'review.csv').open('w', newline='', encoding='utf-8-sig') as file:
        writer = csv.writer(file)
        writer.writerow(['id', 'artist', 'title', 'duration_seconds', 'proposed_start_seconds',
                         'proposed_end_seconds', 'intro_kind', 'outro_kind', 'window_limited',
                         'decision', 'reviewed_start_seconds', 'reviewed_end_seconds', 'notes', 'sha256'])
        for t in data['tracks']:
            reviewed = imported.get(t['id'], {})
            writer.writerow([spreadsheet_text(t['id']), spreadsheet_text(t['artist']), spreadsheet_text(t['title']),
                t['duration'], t['proposed_start'], t['proposed_end'], t['beginning']['kind'],
                t['ending']['kind'], t['beginning']['window_limited'] or t['ending']['window_limited'],
                reviewed.get('decision', 'pending'),
                reviewed.get('start', '') if reviewed.get('decision') != 'pending' else '',
                reviewed.get('end', '') if reviewed.get('decision') != 'pending' else '',
                spreadsheet_text(reviewed.get('notes', '')), t['sha256']])
    payload = json.dumps(data, ensure_ascii=True).replace('<', '\\u003c')
    (directory / 'index.html').write_text(PAGE.replace('/*REVIEW_DATA*/', payload), encoding='utf-8')


PAGE = r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Song edge review</title><style>
:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#101116;color:#f4f4f7}*{box-sizing:border-box}
body{margin:0}header{padding:20px 24px;border-bottom:1px solid #ffffff20}h1{font-size:24px;margin:0 0 4px}h2{font-size:21px;margin:0}h3{font-size:16px;margin:0 0 8px}p{margin:4px 0 14px}.muted,small{color:#bdc3cf}
button,input,select,textarea{font:inherit;color:inherit;background:#24262f;border:1px solid #747986;border-radius:7px;min-height:44px;padding:8px 12px}button{cursor:pointer}button:hover{background:#363c4b}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #a5c7ff;outline-offset:3px}input[type=checkbox]{min-height:24px;width:24px;accent-color:#a5c7ff}label{display:block;margin:0 0 6px}input[type=number],select,textarea{width:100%}textarea{min-height:88px}audio{width:100%;margin-top:8px}
.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.tools label{margin:0}.layout{display:grid;grid-template-columns:320px minmax(0,1fr);min-height:calc(100dvh - 160px)}nav{padding:16px;border-right:1px solid #ffffff20}#search{width:100%}.filter{display:flex;align-items:center;gap:8px;margin-top:10px}#song-list{display:grid;gap:6px;max-height:calc(100dvh - 320px);overflow:auto;padding:5px}#song-list button{text-align:left;overflow-wrap:anywhere}#song-list button[aria-pressed=true]{border-color:#a5c7ff;background:#29384d}#song-list small{display:block}main{padding:24px;min-width:0}.player-section{margin-top:20px;padding:18px;background:#1a1d26;border:1px solid #ffffff20;border-radius:10px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}.timeline{width:100%;height:110px;display:block;background:#11151e;border-radius:6px;margin-top:10px}.status{min-height:24px;color:#c3d9ff}a{color:#bdd4ff}.warning{color:#ffd392}.badge{font-size:13px;color:#cbd6ec}summary{cursor:pointer}details{margin-top:20px}input[type=file]{max-width:100%}[hidden]{display:none!important}
@media(max-width:760px){header,main{padding:16px}.layout{grid-template-columns:1fr}nav{border-right:0;border-bottom:1px solid #ffffff20}#song-list{max-height:180px}.fields{grid-template-columns:1fr}.tools button{flex:1}}
@media(prefers-reduced-motion:no-preference){button{transition:background-color .12s ease}}
</style><header><h1>Song edge review</h1><p class="muted">Proposals only. Original recordings and playback settings are unchanged.</p><div class="tools"><button id="export">Export decisions</button><label for="import">Import decisions</label><input id="import" type="file" accept="application/json,.json"><a href="review.csv" download>CSV sheet</a><span id="count"></span></div><p id="status" class="status" role="status"></p></header>
<div class="layout"><nav aria-label="Recordings"><label for="search">Find a song or artist</label><input id="search" type="search"><label class="filter"><input id="candidates" type="checkbox">Proposed cuts only</label><p id="matches" class="muted"></p><div id="song-list"></div></nav><main><div class="tools"><button id="previous">Previous song</button><button id="next">Next song</button></div><div id="detail"></div></main></div>
<script>
'use strict';const report=/*REVIEW_DATA*/,tracks=report.tracks,$=id=>document.getElementById(id);let current=0,decisions={};
const storageKey='familyhub-edge-review:'+report.detector+':'+tracks.map(t=>t.id+':'+t.sha256).join('|');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function stamp(seconds){return Math.floor(seconds/60)+':'+(seconds%60).toFixed(2).padStart(5,'0')}
function candidate(t){return t.proposed_start>.05||t.duration-t.proposed_end>.05}
function valid(d,t){return d&&d.sha256===t.sha256&&['pending','use-proposal','keep-original','custom'].includes(d.decision)&&Number.isFinite(d.start)&&Number.isFinite(d.end)&&d.start>=0&&d.start<d.end&&d.end<=t.duration&&typeof d.notes==='string'}
function accept(data){let accepted=0;for(const t of tracks){const d=data[t.id];if(valid(d,t)){decisions[t.id]=d;accepted++}}return accepted}
accept(report.decisions||{});
try{accept(JSON.parse(localStorage.getItem(storageKey)||'{}'))}catch{$('status').textContent='Browser storage unavailable. Export decisions before closing.'}
function decision(t){return decisions[t.id]||{id:t.id,sha256:t.sha256,decision:'pending',start:t.proposed_start,end:t.proposed_end,notes:''}}
function update(){for(const [i,t]of tracks.entries()){$('song-'+i).querySelector('small').textContent=t.artist+' · '+decision(t).decision}const reviewed=tracks.filter(t=>decision(t).decision!=='pending').length;$('count').textContent=reviewed+' / '+tracks.length+' reviewed'}
function save(){try{localStorage.setItem(storageKey,JSON.stringify(decisions));$('status').textContent='Saved in this browser.'}catch{$('status').textContent='Browser storage unavailable. Export decisions before closing.'}update()}
for(const [i,t]of tracks.entries()){const b=document.createElement('button');b.id='song-'+i;b.type='button';b.innerHTML='<strong>'+escape(t.title)+'</strong><small></small>';b.onclick=()=>choose(i);$('song-list').append(b)}
function visible(){return tracks.map((t,i)=>({t,i})).filter(({t})=>(!$('candidates').checked||candidate(t))&&(t.artist+' '+t.title).toLocaleLowerCase().includes($('search').value.toLocaleLowerCase())).map(v=>v.i)}
function filter(){const shown=new Set(visible());tracks.forEach((_,i)=>$('song-'+i).hidden=!shown.has(i));$('matches').textContent=shown.size+' songs'}
$('search').oninput=filter;$('candidates').onchange=filter;
function draw(side){attachCueTools(side);const t=tracks[current],canvas=$('plot-'+side),ctx=canvas.getContext('2d'),levels=t.levels[side],clip=t.clips[side];canvas.width=700;canvas.height=110;ctx.clearRect(0,0,700,110);ctx.strokeStyle='#9dbfff';ctx.lineWidth=1.4;ctx.beginPath();levels.forEach((w,i)=>{const x=i/Math.max(1,levels.length-1)*700,y=105-Math.max(0,Math.min(80,w.rms_dbfs+80))/80*100;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();const d=decision(t),cue=side==='beginning'?d.start:d.end,first=levels[0].time,last=levels.at(-1).time+.1,x=(cue-first)/(last-first)*700;ctx.strokeStyle='#ffd392';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,110);ctx.stroke()}
function attachCueTools(side){
const audio=$('audio-'+side),canvas=$('plot-'+side),t=tracks[current],clip=t.clips[side];
if($('cue-tools-'+side))return;
const tools=document.createElement('div');tools.id='cue-tools-'+side;tools.className='tools';
const clock=document.createElement('output');clock.setAttribute('aria-live','off');
const update=()=>clock.textContent='Original time: '+stamp(clip.offset+audio.currentTime);
audio.addEventListener('timeupdate',update);update();
const button=document.createElement('button');button.type='button';button.textContent=side==='beginning'?'Set start here':'Set end here';
button.onclick=()=>{const field=$(side==='beginning'?'start':'end');field.value=Math.min(t.duration,clip.offset+audio.currentTime).toFixed(3);field.dispatchEvent(new Event('change'))};
tools.append(clock,button);audio.before(tools);
const caption=document.createElement('p');caption.className='muted';const levels=t.levels[side];caption.textContent='Loudness graph: '+stamp(levels[0].time)+' to '+stamp(levels.at(-1).time+levels.at(-1).seconds);canvas.before(caption);
}
function choose(index){current=index;const t=tracks[index],d=decision(t);for(let i=0;i<tracks.length;i++)$('song-'+i).setAttribute('aria-pressed',String(i===index));$('detail').innerHTML=`<h2>${escape(t.title)}</h2><p class="muted">${escape(t.artist)} · ${stamp(t.duration)}</p><p class="badge">Proposed start: ${stamp(t.proposed_start)} · Proposed end: ${stamp(t.proposed_end)}</p><p>${escape(t.beginning.kind)} at beginning · ${escape(t.ending.kind)} at end</p>${t.beginning.window_limited||t.ending.window_limited?'<p class="warning">The quiet section reaches the 45-second scan limit. Check the original recording before approving a cut.</p>':''}<div class="fields"><div><label for="start">Start cue, original seconds</label><input id="start" type="number" min="0" max="${t.duration}" step="0.1" value="${d.start}"></div><div><label for="end">End cue, original seconds</label><input id="end" type="number" min="0" max="${t.duration}" step="0.1" value="${d.end}"></div></div><label for="decision">Decision</label><select id="decision"><option value="pending">Pending review</option><option value="use-proposal">Use proposed cues</option><option value="keep-original">Keep original</option><option value="custom">Use custom cues</option></select>${['beginning','ending'].map(side=>`<section class="player-section"><h3>${side==='beginning'?'Beginning':'Ending'}</h3><p class="muted">Preview begins at ${stamp(t.clips[side].offset)} in the original.</p><button id="around-${side}">Play around ${side==='beginning'?'start':'end'} cue</button><audio id="audio-${side}" controls preload="none" src="${escape(t.clips[side].file)}"></audio><canvas id="plot-${side}" class="timeline" role="img" aria-label="${side} loudness in 0.1-second windows; yellow line marks the cue"></canvas></section>`).join('')}<label for="notes">Notes</label><textarea id="notes">${escape(d.notes)}</textarea><details><summary>Detection and review details</summary><p>The first and last 45 seconds were scanned. The quiet threshold is at least 12 dB below the louder reference windows and no higher than −30 dBFS. Long candidates may contain up to 10% louder windows, with no louder run over 0.5 seconds. Proposed cues keep 0.15 seconds of padding.</p><p>These are signal-level heuristics, not music recognition or calibrated confidence scores. Quiet instrumental passages, deliberate pauses, speech, and sound effects need listening review. Previews are AAC listening copies at the original volume. Nothing is trimmed automatically.</p></details>`;
$('decision').value=d.decision;for(const side of ['beginning','ending']){$('around-'+side).onclick=async()=>{const audio=$('audio-'+side),cue=Number($(side==='beginning'?'start':'end').value);document.querySelectorAll('audio').forEach(other=>{if(other!==audio)other.pause()});audio.currentTime=Math.max(0,Math.min(t.clips[side].length-.1,cue-t.clips[side].offset-3));try{await audio.play()}catch{$('status').textContent='Use the audio player’s Play button.'}};draw(side)}
for(const id of ['start','end','notes'])$(id).onchange=()=>{const next={id:t.id,sha256:t.sha256,decision:id==='notes'?$('decision').value:'custom',start:Number($('start').value),end:Number($('end').value),notes:$('notes').value};if(!valid(next,t)){$('status').textContent='Use cue times inside the recording, with start before end.';return}decisions[t.id]=next;$('decision').value=next.decision;save();draw('beginning');draw('ending')};
$('decision').onchange=()=>{const value=$('decision').value,start=value==='keep-original'?0:value==='use-proposal'?t.proposed_start:Number($('start').value),end=value==='keep-original'?t.duration:value==='use-proposal'?t.proposed_end:Number($('end').value);const next={id:t.id,sha256:t.sha256,decision:value,start,end,notes:$('notes').value};if(!valid(next,t)){$('status').textContent='Correct the cue times before saving a decision.';return}decisions[t.id]=next;$('start').value=start;$('end').value=end;save();draw('beginning');draw('ending')};update()}
function move(delta){const list=visible(),position=list.indexOf(current),index=list[position+delta];if(index!==undefined)choose(index);else $('status').textContent=delta>0?'Last song in this filter.':'First song in this filter.'}
$('previous').onclick=()=>move(-1);$('next').onclick=()=>move(1);
$('export').onclick=()=>{const all=tracks.map(t=>({...decision(t),id:t.id,title:t.title,artist:t.artist}));const blob=new Blob([JSON.stringify({detector:report.detector,decisions:all},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='edge-review-decisions.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('import').onchange=async()=>{try{const file=$('import').files[0];if(!file)return;const data=JSON.parse(await file.text());if(data.detector!==report.detector||!Array.isArray(data.decisions))throw Error();const count=accept(Object.fromEntries(data.decisions.map(d=>[d.id,d])));save();choose(current);$('status').textContent='Imported '+count+' matching decisions.'}catch{$('status').textContent='Could not import these decisions. Use an export from this detector and matching recordings.'}};
filter();if(tracks.length)choose(0);else $('detail').textContent='No recordings were analysed.';
</script></html>'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--decisions', type=Path, help='Seed the sheet with a validated user export; entries with notes appear first')
    args = parser.parse_args()
    build(args.directory.resolve(), args.decisions)
