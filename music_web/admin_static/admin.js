import { createServiceStatus } from './service-status.js';

const $ = id => document.getElementById(id);
const REFRESH_MS = 30000;
let csrf = '', timer = 0, refreshing = false;
const posters = new Map();
let posterRequest = Promise.resolve();
const outage = createServiceStatus({
  detail: 'Reconnect to load torrent activity.', label: 'Retry torrent activity', retry: refresh,
  focus: () => $('boards').hidden ? $('page-title') : $('downloads-title'), automatic: true, fullSection: true
});
$('seeding-outage').append(outage.card);
const signInOutage = createServiceStatus({
  detail: 'Reload profiles, then enter your password again.', label: 'Retry profile lookup',
  retry: () => showSignIn(), focus: () => $('password')
});
$('signin-outage').append(signInOutage.card);

async function api(path, options = {}) {
  const headers = {Accept: 'application/json'};
  if (options.body) { headers['Content-Type'] = 'application/json'; headers['X-CSRFToken'] = csrf; }
  const response = await fetch(path, {credentials: 'same-origin', signal: AbortSignal.timeout(10000), ...options, headers});
  let data = null;
  try { data = await response.json(); } catch { /* the reply has no body */ }
  return {status: response.status, data};
}

const gb = bytes => ((Number(bytes) || 0) / 1073741824).toFixed(bytes >= 107374182400 ? 0 : 1) + ' GB';
const fixed = value => (Number(value) || 0).toFixed(2);

function meter(node, fraction) {
  const percent = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
  node.setAttribute('aria-valuenow', percent);
  node.firstElementChild.style.width = percent + '%';
}

function show(which) {
  $('signin').hidden = which !== 'signin';
  $('seeding').hidden = which !== 'seeding';
}

async function showSignIn(message) {
  clearTimeout(timer);
  const select = $('profile');
  const prior = select.value;
  const {data} = await api('/api/connect').catch(() => ({data: null}));
  if (!Array.isArray(data?.profiles) || !data.profiles.length) {
    showUnavailable();
    return;
  }
  csrf = data.csrf_token;
  select.replaceChildren(...data.profiles.map(profile => new Option(profile.name, profile.id)));
  if (data.profiles.some(profile => profile.id === prior)) select.value = prior;
  $('signin-error').textContent = message || '';
  const shouldFocus = $('seeding').contains(document.activeElement) ||
    $('signin').contains(document.activeElement) || document.activeElement === document.body;
  show('signin');
  if (shouldFocus) select.focus();
  outage.clear();
  signInOutage.clear();
}

function part(label, value) {
  const span = document.createElement('span'), strong = document.createElement('b');
  strong.textContent = value;
  span.append(label + ' ', strong);
  return span;
}

function artwork(item, enabled) {
  const tile = document.createElement('div');
  tile.className = 'poster';
  tile.setAttribute('aria-hidden', 'true');
  tile.textContent = (item.title || item.name).trim().charAt(0).toUpperCase();
  const color = Number.parseInt(item.hash?.slice(0, 6), 16) % 360 || 0;
  tile.style.setProperty('--poster-hue', color);
  if (enabled && item.hash) {
    if (!posters.has(item.hash)) {
      const lookup = posterRequest.then(async () => {
        const {data} = await api('/api/server/seeding?poster=' + encodeURIComponent(item.hash)).catch(() => ({}));
        return data?.poster;
      });
      posters.set(item.hash, lookup);
      posterRequest = lookup;
    }
    posters.get(item.hash).then(url => {
      if (!url || !tile.isConnected) return;
      const img = new Image();
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove(), {once: true});
      img.src = url;
      tile.append(img);
    });
  }
  return tile;
}

function torrentRow(item, download, goal, snapshot) {
  const node = document.createElement('li'), content = document.createElement('div');
  const title = document.createElement('h3'), tag = document.createElement('span');
  const header = document.createElement('div'), detail = document.createElement('p');
  header.className = 'torrent-header';
  title.textContent = item.subtitle ? `${item.title} · ${item.subtitle}` : item.title || item.name;
  title.title = item.name;
  const speed = snapshot.stale ? 0 : download ? item.dl_speed : item.up_speed;
  tag.className = 'tag';
  tag.textContent = download || item.complete ? item.state : speed > 0 ? 'Uploading' : 'Waiting to seed';
  header.append(title, tag);
  content.append(header);
  node.append(artwork(item, snapshot.posters_enabled), content);
  if (download && item.progress === 0 && !item.size && !item.downloaded) return node;
  const fraction = download ? item.progress : item.ratio / goal;
  const value = download ? `${Math.min(99.9, Math.floor(item.progress * 1000) / 10)}%`
    : `${fixed(item.ratio)}× of ${goal.toFixed(1)}×`;
  detail.className = 'row';
  detail.append(download ? part('Downloaded', item.size ? `${gb(item.progress * item.size)} of ${gb(item.size)}`
    : gb(item.downloaded)) : part('Uploaded', gb(item.uploaded)));
  if (speed > 0) {
    const mb = speed / 1048576;
    detail.append(part(download ? 'Down' : 'Up', mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.ceil(speed / 1024)} KB/s`));
  } else if (!download) {
    detail.append(part('Up', snapshot.stale || speed == null ? 'Unavailable' : '0 KB/s'));
  }
  if (fraction != null) {
    const bar = document.createElement('div'), fill = document.createElement('i');
    bar.className = 'meter';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${title.textContent} ${download ? 'download' : 'share ratio'}`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuetext', value);
    bar.append(fill);
    meter(bar, fraction);
    detail.prepend(part(download ? 'Progress' : 'Ratio', value));
    content.append(bar);
  } else {
    detail.prepend('Progress unavailable');
  }
  content.append(detail);
  return node;
}

function render(snapshot) {
  const goal = Number(snapshot.goal) || 2;
  $('goal').textContent = goal.toFixed(1);
  $('global-ratio').textContent = fixed(snapshot.global_ratio);
  meter($('global-meter'), (Number(snapshot.global_ratio) || 0) / goal);
  $('global-meter').setAttribute('aria-valuetext', `${fixed(snapshot.global_ratio)}× of ${goal.toFixed(1)}×`);
  const need = Math.max(0, goal * snapshot.total_downloaded - snapshot.total_uploaded);
  const detail = need ? `${gb(need)} more to reach ${goal.toFixed(1)}×`
    : snapshot.global_ratio >= goal ? `${goal.toFixed(1)}× goal reached` : 'No downloads recorded.';
  $('global-detail').textContent = `${gb(snapshot.total_uploaded)} uploaded · ${gb(snapshot.total_downloaded)} downloaded · ${detail}`;
  const downloads = snapshot.items.filter(item => !item.complete);
  const seedOrder = {Seeding: 0, Waiting: 1};
  const seeds = snapshot.items.filter(item => item.complete || item.uploaded > 0)
    .sort((left, right) => (seedOrder[left.state] ?? 2) - (seedOrder[right.state] ?? 2));
  const seedingCount = seeds.filter(item => item.state === 'Seeding').length;
  $('seeding-count').textContent = `${seedingCount} ${seedingCount === 1 ? 'title' : 'titles'} seeding`;
  $('download-items').replaceChildren(...downloads.map(item => torrentRow(item, true, goal, snapshot)));
  $('seed-items').replaceChildren(...seeds.map(item => torrentRow(item, false, goal, snapshot)));
  $('downloads-empty').hidden = downloads.length > 0;
  $('seeds-empty').hidden = seeds.length > 0;
  $('boards').hidden = false;
  const sampleTime = new Date(snapshot.last_sample_at);
  $('sample-time').textContent = Number.isNaN(+sampleTime) ? '' : `Last sampled ${sampleTime.toLocaleTimeString()}`;
  const activeDownloads = downloads.filter(item => item.state === 'Downloading').length;
  const activeSeeds = seeds.filter(item => item.up_speed > 0).length;
  const status = snapshot.stale ? 'Showing a reading from more than two minutes ago.'
    : `${downloads.length} unfinished · ${activeDownloads} downloading · ${activeSeeds} uploading`;
  if ($('status').textContent !== status) $('status').textContent = status;
}

function showUnavailable() {
  const wasSigningIn = $('signin').contains(document.activeElement);
  show('seeding');
  $('status').textContent = '';
  if (outage.card.hidden) outage.card.querySelector('.service-status-announcement p').textContent =
    $('boards').hidden ? 'Reconnect to load torrent activity.' : 'Showing the last reading.';
  outage.show();
  if (wasSigningIn || document.activeElement === document.body) outage.card.querySelector('button').focus();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  clearTimeout(timer);
  const {status, data} = await api('/api/server/seeding').catch(() => ({status: 0, data: null}));
  if (status === 401 || status === 403) {
    $('boards').hidden = true;
    $('sample-time').textContent = '';
    await showSignIn(status === 403 ? 'Choose an administrator profile.' : '');
    refreshing = false;
    return;
  }
  if (status === 200 && data?.available) {
    const moveFocus = $('signin').contains(document.activeElement);
    render(data);
    show('seeding');
    if (moveFocus) $('downloads-title').focus();
    outage.clear();
  } else {
    showUnavailable();
  }
  refreshing = false;
  if (!document.hidden && outage.card.hidden) timer = setTimeout(refresh, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else if (!$('seeding').hidden) refresh();
});
$('signin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('signin-submit');
  if (submit.getAttribute('aria-disabled') === 'true') return;
  submit.setAttribute('aria-disabled', 'true');
  $('signin-error').textContent = '';
  const {status, data} = await api('/api/profile/select', {method: 'POST',
    body: JSON.stringify({profile_id: $('profile').value, password: $('password').value})}).catch(() => ({status: 0, data: null}));
  $('password').value = '';
  submit.removeAttribute('aria-disabled');
  if (status === 200) {
    csrf = data?.csrf_token || csrf;
    await refresh();
    return;
  }
  if (status === 0 || status >= 500) signInOutage.show();
  else {
    signInOutage.clear();
    $('signin-error').textContent = status === 403 || status === 401 ? (data?.error || 'Incorrect password. Try again.')
      : status === 429 ? 'Too many attempts. Wait a few minutes.' : 'Sign-in could not finish. Try again.';
  }
  $('password').focus();
});
refresh();
