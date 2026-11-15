const assert=require('node:assert/strict');
const R=require('../music_web/static/recommendations.js');
const seed={title:'Alone',channel:'Maduk',url:'a'};
for(const title of ['Maduk - Alone (ft. Marianna Ray) (Lyrics)','Nightcore - Alone - Maduk ft. Marianna Ray (Lyrics)','Maduk - Alone (feat. Marianna Ray) | 8D Audio']) {
 const candidate={title,channel:'Different uploader'};
 assert(R.same(seed,candidate), title);
}
assert(R.same(seed,{title:'Maduk \u2014 Alone (Official Audio)',channel:'Uploader'}));
assert(!R.same(seed,{title:'Not Alone (Radio Edit)',channel:'Maduk'}));
assert(!R.same(seed,{title:'Alone',channel:'Other artist'}));
assert.equal(R.unique([{title:'Not Alone (Radio Edit)',channel:'Maduk'},{title:'Not Alone (Album Mix)',channel:'Maduk'}],[seed]).length,1);
const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
let now=1000000000;
let a=R.createHistory(storage,'a',()=>now);a.record(seed,'played');assert(a.recent(seed));
assert(!R.createHistory(storage,'b',()=>now).recent(seed));
a=R.createHistory(storage,'a',()=>now);assert(a.recent({title:'Maduk - Alone (Lyrics)',channel:'Uploader'}));
now+=2*86400000;assert(!a.recent(seed));a.record(seed,'skipped');assert(a.recent(seed));
now+=8*86400000;assert(!a.recent(seed));a.clear();assert.equal(a.entries().length,0);
assert.equal(R.createHistory({getItem:()=>'{broken',setItem:()=>{throw Error()},removeItem:()=>{}},'a').entries().length,0);
console.log('Recommendation identity, deduplication, history expiry, persistence and account isolation passed');
const rock={title:'Numb',channel:'Linkin Park',genre:'Rock'};
assert(R.similar(rock,{title:'Faint',channel:'Linkin Park'}));
assert(R.similar(rock,{title:'Bring Me To Life',channel:'Evanescence',genre:'Rock'}));
assert(!R.similar(rock,{title:'Barbie Girl',channel:'Aqua',genre:'Pop'}));
assert(!R.similar(rock,{title:'Unknown',channel:'Other artist',genre:'Unsorted'}));
assert(!R.similar({...rock,genre:'Unsorted'},{title:'Unknown',channel:'Other artist',genre:'Unsorted'}));
assert(!R.similar(rock,{title:'Different genre',channel:'Linkin Park',genre:'Pop'}));
for(let i=0;i<40;i++) {
 const candidates=[{title:'Rock '+i,channel:'Rock artist '+i,genre:'Rock'},{title:'Barbie Girl',channel:'Aqua',genre:'Pop'}];
 assert.deepEqual(candidates.filter(t=>R.similar(rock,t)),[candidates[0]]);
}
console.log('Fixed-seed genre filtering, unknown genres and 40 consecutive recommendation batches passed');
