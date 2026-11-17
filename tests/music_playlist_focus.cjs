const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../clients/FamilyHub.App/wwwroot/app.js'), 'utf8');
const handlers = {}, elements = {};
const document = {
    body: { dataset: { view: 'playlists' } },
    addEventListener: (type, handler) => { (handlers[type] ??= []).push(handler); },
    getElementById: id => elements[id]
};
let mutated;
const context = { document, window: {}, requestAnimationFrame: callback => callback(), MutationObserver: class {
    constructor(callback) { mutated = callback; }
    observe() {}
} };
vm.runInNewContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
vm.runInNewContext(source.slice(source.indexOf('let focusedSongControl;'), source.indexOf('window.familyhub.bindSeekHover')), context);
const control = () => ({
    isConnected: true,
    closest: () => ({}),
    getClientRects: () => [{}],
    focus() { document.activeElement = this; handlers.focusin.forEach(handler => handler({ target: this })); }
});
const song = control();
const search = elements['playlist-song-search-toggle'] = control();

song.focus();
document.activeElement = document.body;
mutated();
assert.equal(document.activeElement, song, 'Moving a row must retain its focused control');
song.isConnected = false;
document.activeElement = document.body;
mutated();
assert.equal(document.activeElement, search, 'Removing a row must focus the playlist search control');
const other = control();
other.closest = () => null;
other.focus();
mutated();
assert.equal(document.activeElement, other, 'List updates must preserve focus outside the rows');

const review = elements['quality-original'] = control();
review.id = 'quality-original';
review.closest = selector => selector === '.song-row' ? {} : null;
const next = elements['quality-next'] = control();
next.id = 'quality-next';
review.focus();
review.isConnected = false;
document.activeElement = document.body;
mutated();
context.window.familyhub.restoreFocus(review.id, next.id);
assert.equal(document.activeElement, next, 'Review row removal must reach the next action without the playlist observer taking focus');
other.focus();
context.window.familyhub.restoreFocus(review.id, next.id);
assert.equal(document.activeElement, other, 'Completed review actions must preserve focus moved by the user');
