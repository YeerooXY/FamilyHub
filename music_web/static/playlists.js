"use strict";
(() => {
  let playlists=[], selected=null, busy=false, stopping=false;
  const choices=new Map(), feedback=$('playlist-feedback');
  const say=text=>{feedback.textContent=text;};
  const identity=p=>p ? (p.owner_id ? p.owner_id+':' : '')+p.id : '';
  function controls(value) {
    const stopFocused=document.activeElement===$('playlist-stop');
    busy=value; for(const id of ['playlist-match','playlist-download','playlist-select','playlist-play']) $(id).disabled=value;
    $('spotify-playlist-form').querySelector('button').disabled=value;
    $('playlist-stop').hidden=!value;
    if(!value && stopFocused) $('playlist-download').focus();
  }
  function render() {
    $('playlist-detail').hidden=!selected; if(!selected)return;
    for(const id of ['playlist-match','playlist-download']) $(id).disabled=busy || selected.can_edit===false;
    $('playlist-name').textContent=selected.name;
    $('playlist-notice').textContent=selected.notice;
    const focus=document.activeElement?.dataset.playlistIndex;
    $('playlist-tracks').replaceChildren(...selected.tracks.map((track,index)=>{
      const select=el('select',{'aria-label':'Recording for '+track.title,'data-playlist-index':String(index)},el('option',{value:''},'Skip / choose a recording'));
      track.candidates.forEach((candidate,i)=>select.append(el('option',{value:String(i)},candidate.title+' - '+candidate.channel+(candidate.recommended?' (Suggested)':''))));
      const key=identity(selected)+':'+index;
      if(!choices.has(key)) choices.set(key, track.match ? String(track.candidates.findIndex(c=>c.id===track.match.id)) : track.candidates[0]?.recommended ? '0' : '');
      select.value=choices.get(key); select.disabled=busy || selected.can_edit===false || track.state==='saved';
      select.addEventListener('change',()=>choices.set(key,select.value));
      return el('li',{},el('div',{},el('strong',{},track.title),el('small',{},track.artist),el('span',{class:'playlist-state'},({saved:'Saved on server',running:'Saving',queued:'Queued',error:'Failed',cancelled:'Stopped'})[track.state]||'')),select);
    }));
    if(focus!==undefined) $('playlist-tracks').querySelector('[data-playlist-index="'+focus+'"]')?.focus();
  }
  async function refresh() {
    const result=await api('/api/playlists'); playlists=result.playlists;
    const id=identity(selected) || $('playlist-select').value;
    $('playlist-select').replaceChildren(el('option',{value:''},'Choose a playlist'),...playlists.map(p=>el('option',{value:identity(p)},p.name+' ('+p.tracks.length+')'+(p.can_edit===false?' · '+p.owner_name:''))));
    if(id){selected=playlists.find(p=>identity(p)===id)||null;$('playlist-select').value=id;} render();
  }
  $('playlist-panel').addEventListener('toggle',()=>{if($('playlist-panel').open&&!busy)refresh().catch(e=>say(e.message));});
  $('playlist-select').addEventListener('change',()=>{selected=playlists.find(p=>identity(p)===$('playlist-select').value)||null;render();});
  $('spotify-playlist-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    const submit=event.currentTarget.querySelector('button');
    if(document.activeElement===submit) $('spotify-playlist-url').focus();
    controls(true);say('Reading playlist…');
    try { const result=await api('/api/playlists/spotify',{method:'POST',json:{url:$('spotify-playlist-url').value.trim()}});selected=result.playlist;for(const key of choices.keys())if(key.startsWith(identity(selected)+':'))choices.delete(key);await refresh();say(selected.tracks.length+' playlist entries loaded.'); }
    catch(e){say(e.message);}finally{controls(false);render();}
  });
  $('playlist-stop').addEventListener('click',()=>{stopping=true;say('Stopping after the current song.');});
  $('playlist-match').addEventListener('click',async()=>{
    if(!selected||selected.can_edit===false||busy)return;controls(true);stopping=false;render();
    try {
      for(let index=0;index<selected.tracks.length&&!stopping;index++) {
        if(selected.tracks[index].candidates.length)continue;
        say('Finding recordings '+(index+1)+' / '+selected.tracks.length);
        const {track}=await api('/api/playlists/'+selected.id+'/match',{method:'POST',json:{index}});
        selected.tracks[index]=track;choices.delete(identity(selected)+':'+index);render();
      }
      say(stopping?'Matching stopped. You can resume.':'Matches ready. Review the recording choices, then save.');
    }catch(e){say(e.message+' Completed matches are kept.');}finally{controls(false);render();}
  });
  $('playlist-download').addEventListener('click',async()=>{
    if(!selected||selected.can_edit===false||busy)return;controls(true);stopping=false;render();let count=0;
    try {
      for(let index=0;index<selected.tracks.length&&!stopping;index++) {
        const choice=choices.get(identity(selected)+':'+index);if(choice===''||choice===undefined||selected.tracks[index].state==='saved')continue;
        say('Saving '+(index+1)+' / '+selected.tracks.length+' to server');
        let {job}=await api('/api/playlists/'+selected.id+'/download',{method:'POST',json:{index,choice:Number(choice)}});
        const deadline=Date.now()+15*60*1000;
        while(['queued','running'].includes(job.state)) {
          if(Date.now()>deadline)throw Error('This song is taking longer than expected. Its server job can continue; refresh the playlist before resuming.');
          await new Promise(resolve=>setTimeout(resolve,1200));
          job=(await api('/api/jobs/'+job.id)).job;
        }
        if(job.state!=='done')throw Error('Could not save '+selected.tracks[index].title+'. You can retry.');
        count++;await refresh();
      }
      say((stopping?'Stopped. ':'')+count+' recordings saved.');await loadLibrary();
    }catch(e){say(e.message);}finally{controls(false);await refresh().catch(()=>{});render();}
  });
  $('playlist-play').addEventListener('click',()=>{
    const tracks=selected?.tracks.map((t,index)=>t.state==='saved'&&t.match ? {...t.match,saved:true,playlistEntry:identity(selected)+':'+index} : null).filter(Boolean)||[];
    if(!tracks.length){say('Save a matched recording first.');return;}
    queue=tracks.slice(1);manualQueue.clear();queue.forEach(t=>manualQueue.add(sourceKey(t)));
    renderQueue();listen(tracks[0],true);
  });
})();
