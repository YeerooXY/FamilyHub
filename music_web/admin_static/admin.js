'use strict';
const $ = id => document.getElementById(id);
const REFRESH_MS = 30000;
let csrf = '', timer = 0;

async function api(path, options = {}) {
  const headers = {Accept: 'application/json'};
  if (options.body) { headers['Content-Type'] = 'application/json'; headers['X-CSRFToken'] = csrf; }
  const response = await fetch(path, {credentials: 'same-origin', ...options, headers});
  let data = null;
  try { data = await response.json(); } catch { /* the reply has no body */ }
  return {status: response.status, data};
}

const gb = bytes => ((Number(bytes) || 0) / 1073741824).toFixed(bytes >= 107374182400 ? 0 : 1) + ' GB';
const fixed = value => (Number(value) || 0).toFixed(2);

function meter(node, fraction) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  node.setAttribute('aria-valuenow', percent);
  node.firstElementChild.style.width = percent + '%';
  node.classList.toggle('done', percent >= 100);
}

function show(which) {
  $('signin').hidden = which !== 'signin';
  $('seeding').hidden = which !== 'seeding';
}

async function showSignIn(message) {
  clearTimeout(timer);
  const {data} = await api('/api/connect');
  csrf = data?.csrf_token || csrf;
  const select = $('profile');
  select.replaceChildren(...(data?.profiles || []).map(profile => new Option(profile.name, profile.id)));
  $('signin-error').textContent = message || '';
  show('signin');
  (message ? $('password') : select).focus();
}

function part(label, value) {
  const span = document.createElement('span'), strong = document.createElement('b');
  strong.textContent = value;
  span.append(label + ' ', strong);
  return span;
}

function render(snapshot) {
  const goal = Number(snapshot.goal) || 2;
  $('goal').textContent = goal.toFixed(1);
  $('global-ratio').textContent = fixed(snapshot.global_ratio);
  meter($('global-meter'), (Number(snapshot.global_ratio) || 0) / goal);
  const need = Math.max(0, goal * snapshot.total_downloaded - snapshot.total_uploaded);
  $('global-detail').textContent = `${gb(snapshot.total_uploaded)} uploaded · ${gb(snapshot.total_downloaded)} downloaded` +
    (need ? ` · ${gb(need)} more to reach ${goal.toFixed(1)}×` : ` · ${goal.toFixed(1)}× goal reached`);
  const items = snapshot.items.map(item => {
    const node = document.createElement('li'), title = document.createElement('h3'), tag = document.createElement('span');
    title.textContent = item.name;
    tag.className = 'tag';
    tag.textContent = item.state;
    title.append(tag);
    const bar = document.createElement('div'), fill = document.createElement('i');
    bar.className = 'meter';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${item.name} share ratio`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.append(fill);
    meter(bar, item.ratio / goal);
    const row = document.createElement('p');
    row.className = 'row';
    row.append(part('Ratio', `${fixed(item.ratio)}× of ${goal.toFixed(1)}×`), part('Uploaded', gb(item.uploaded)),
      part('Downloaded', gb(item.downloaded)));
    node.append(title, bar, row);
    return node;
  });
  $('items').replaceChildren(...items);
  $('status').textContent = items.length ? '' : 'No torrents on the server.';
}

async function refresh() {
  clearTimeout(timer);
  const {status, data} = await api('/api/server/seeding').catch(() => ({status: 0, data: null}));
  if (status === 401 || status === 403) return showSignIn(status === 403 ? 'This profile is not an administrator.' : '');
  show('seeding');
  if (status === 200 && data?.available) {
    $('retry').hidden = true;
    render(data);
    if (data.stale) $('status').textContent = 'The latest reading is more than two minutes old.';
  } else {
    $('status').textContent = 'Seeding records did not load.';
    $('retry').hidden = false;
  }
  timer = setTimeout(refresh, REFRESH_MS);
}

$('retry').addEventListener('click', () => { $('retry').focus(); refresh(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else if (!$('seeding').hidden) refresh();
});
$('signin-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('signin-error').textContent = '';
  const {status, data} = await api('/api/profile/select', {method: 'POST',
    body: JSON.stringify({profile_id: $('profile').value, password: $('password').value})}).catch(() => ({status: 0, data: null}));
  $('password').value = '';
  if (status === 200) {
    csrf = data?.csrf_token || csrf;
    await refresh();
    $('global-title').focus();
    return;
  }
  $('signin-error').textContent = status === 403 || status === 401 ? (data?.error || 'Incorrect password. Try again.')
    : status === 429 ? 'Too many attempts. Wait a few minutes.' : 'The server did not respond. Try again.';
  $('password').focus();
});
refresh();
