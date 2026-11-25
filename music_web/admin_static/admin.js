import { createServiceStatus } from './service-status.js';

const $ = id => document.getElementById(id);
const REFRESH_MS = 30000;
let csrf = '', timer = 0, refreshing = false;
const outage = createServiceStatus({
  detail: 'Reconnect to load seeding records.', label: 'Retry seeding', retry: refresh,
  focus: () => $('global').hidden ? $('page-title') : $('global-title'), automatic: true, fullSection: true
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

function render(snapshot) {
  const goal = Number(snapshot.goal) || 2;
  $('goal').textContent = goal.toFixed(1);
  $('global-ratio').textContent = fixed(snapshot.global_ratio);
  meter($('global-meter'), (Number(snapshot.global_ratio) || 0) / goal);
  const need = Math.max(0, goal * snapshot.total_downloaded - snapshot.total_uploaded);
  const detail = need ? `${gb(need)} more to reach ${goal.toFixed(1)}×`
    : snapshot.global_ratio >= goal ? `${goal.toFixed(1)}× goal reached` : 'No downloads recorded.';
  $('global-detail').textContent = `${gb(snapshot.total_uploaded)} uploaded · ${gb(snapshot.total_downloaded)} downloaded · ${detail}`;
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
  $('items').hidden = $('files-title').hidden = !items.length;
  $('global').hidden = false;
  $('status').textContent = snapshot.stale ? 'The latest reading is more than two minutes old.'
    : items.length ? '' : 'No torrents on the server.';
}

function showUnavailable() {
  const wasSigningIn = $('signin').contains(document.activeElement);
  show('seeding');
  $('status').textContent = '';
  if (outage.card.hidden) outage.card.querySelector('.service-status-announcement p').textContent =
    $('global').hidden ? 'Reconnect to load seeding records.' : 'Showing the last reading.';
  outage.show();
  if (wasSigningIn) outage.card.querySelector('button').focus();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  clearTimeout(timer);
  const {status, data} = await api('/api/server/seeding').catch(() => ({status: 0, data: null}));
  if (status === 401 || status === 403) {
    $('global').hidden = $('items').hidden = $('files-title').hidden = true;
    await showSignIn(status === 403 ? 'Choose an administrator profile.' : '');
    refreshing = false;
    return;
  }
  if (status === 200 && data?.available) {
    const moveFocus = $('signin').contains(document.activeElement);
    render(data);
    show('seeding');
    if (moveFocus) $('global-title').focus();
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
