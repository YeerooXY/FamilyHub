const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../clients/FamilyHub.App/wwwroot/app.js'), 'utf8');
const handlers = {}, elements = {};
let tooltip;
const control = (id, classes = []) => {
    const attributes = {}, names = new Set(classes);
    return {
        id, isConnected: true, dataset: {}, style: {}, textContent: '',
        classList: {
            contains: name => names.has(name),
            add: name => names.add(name), remove: name => names.delete(name),
            toggle: (name, enabled) => enabled ? names.add(name) : names.delete(name)
        },
        getAttribute: name => attributes[name],
        hasAttribute: name => name in attributes,
        setAttribute: (name, value) => { attributes[name] = value; },
        removeAttribute: name => { delete attributes[name]; },
        getBoundingClientRect: () => ({left: 100, top: 100, bottom: 132, width: 32, height: 32}),
        closest() { return this; }, matches: () => true,
        contains(target) { return this === target; },
        focus() { document.activeElement = this; }
    };
};
const body = control('body'), root = control('stats');
const point = elements['stats-point-2026-11-17'] = control('stats-point-2026-11-17', ['stats-chart-point-button']);
const refresh = elements['server-stats-refresh'] = control('server-stats-refresh');
point.dataset.tooltip = '17 Nov 2026: 1 h 2 min 3 s';
root.contains = target => target === point || target === refresh;
root.querySelector = () => point.isConnected ? point : null;
root.getClientRects = () => [{}];
const document = {
    body, activeElement: body, hidden: false,
    addEventListener: (type, handler) => { (handlers[type] ??= []).push(handler); },
    createElement: () => (tooltip = control('app-control-tooltip')),
    querySelector: () => root,
    getElementById: id => elements[id]
};
body.append = () => {};
const window = {familyhub: {}, addEventListener() {}};
const start = source.lastIndexOf('(() => {', source.indexOf('    let active, tip, observer;'));
vm.runInNewContext(source.slice(start, source.indexOf('window.familyhub.bindUpdatePolling')), {
    document, window, innerWidth: 800,
    MutationObserver: class { observe() {} disconnect() {} }
});
const fire = (type, event) => (handlers[type] || []).forEach(handler => handler(event));
const visible = () => tooltip.classList.contains('is-visible');

point.focus();
fire('focusin', {target: point});
assert(visible());
assert.equal(tooltip.textContent, point.dataset.tooltip);
fire('pointerout', {target: point, relatedTarget: body});
assert(visible(), 'Pointer exit must preserve the focused chart value');
fire('keydown', {key: 'Escape'});
assert(!visible(), 'Escape must dismiss the chart value without moving focus');
assert.equal(document.activeElement, point);
document.activeElement = body;
fire('pointerover', {target: point, pointerType: 'mouse'});
assert(visible());
fire('pointerout', {target: point, relatedTarget: body});
assert(!visible(), 'An unfocused hover tooltip must dismiss on pointer exit');
fire('pointerdown', {target: point, pointerType: 'touch'});
fire('click', {target: point});
assert(visible(), 'Tapping a chart point must reveal its exact value');
fire('focusout', {target: point});
assert(!visible());

point.focus();
window.familyhub.captureStatsFocus();
point.isConnected = false;
delete elements[point.id];
document.activeElement = body;
window.familyhub.restoreStatsFocus();
assert.equal(document.activeElement, refresh, 'Removing a focused chart point must focus Refresh');
point.isConnected = true;
point.focus();
window.familyhub.captureStatsFocus();
const outside = control('outside');
outside.focus();
window.familyhub.restoreStatsFocus();
assert.equal(document.activeElement, outside, 'A refresh must preserve focus moved outside the chart');
assert(window.familyhub.statsVisible());
document.hidden = true;
assert(!window.familyhub.statsVisible(), 'Hidden pages must skip statistics polling');
