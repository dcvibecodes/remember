'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const ICON = (name, cls = 'ic') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

const COLORS = ['red', 'rose', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'brown', 'slate', 'gray'];
const colorVar = (color) => `var(--list-${COLORS.includes(color) ? color : 'blue'})`;

const state = {
  authenticated: false,
  needsSetup: false,
  vapidPublicKey: null,
  lists: [],
  reminders: [],
  settings: {},
  view: 'today',
  search: '',
  showCompleted: false,
  editingId: null,
  editingListId: null,
  selectedColor: 'blue',
  csrfToken: null,
  subscription: null,
  editScope: 'series',
  lastListId: Number(localStorage.getItem('remember.lastList')) || null,
};

const ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Ho_Chi_Minh', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Pacific/Auckland'];

function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// Client mirror of the server's rule labels (server/recurrence.js stays canonical).
function parseRuleClient(value) {
  if (!value || value === 'none') return { type: 'none' };
  try {
    const rule = JSON.parse(value);
    return rule && rule.type ? rule : { type: 'none' };
  } catch {
    return { type: 'none' };
  }
}

function repeatLabel(rule) {
  if (!rule || rule.type === 'none') return 'Never';
  const n = rule.interval || 1;
  if (rule.type === 'daily') return n === 1 ? 'Daily' : `Every ${n} days`;
  if (rule.type === 'weekly') return n === 1 ? 'Weekly' : `Every ${n} weeks`;
  if (rule.type === 'monthly') return n === 1 ? 'Monthly' : `Every ${n} months`;
  if (rule.type === 'yearly') return n === 1 ? 'Yearly' : `Every ${n} years`;
  if (rule.type === 'custom') {
    const unit = rule.unit === 'weeks' ? 'week' : rule.unit === 'months' ? 'month' : 'day';
    return `Every ${n} ${unit}${n === 1 ? '' : 's'}`;
  }
  return 'Repeats';
}

function announce(message) {
  const node = $('#live');
  if (!node) return;
  node.textContent = '';
  setTimeout(() => { node.textContent = message; }, 30);
}

const DENSITY_KEY = 'remember-density';

function applyDensity() {
  const density = localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  document.documentElement.dataset.density = density;
  return density;
}

function updateBadge() {
  try {
    const limit = endOfToday();
    const count = incompleteReminders()
      .filter((reminder) => reminder.due_at && new Date(reminder.due_at) <= limit).length;
    if ('setAppBadge' in navigator && navigator.setAppBadge) {
      if (count > 0) navigator.setAppBadge(count);
      else if ('clearAppBadge' in navigator) navigator.clearAppBadge();
    }
  } catch {
    // Badging is best-effort: skip silently where unsupported.
  }
}

// The device zone is synced to the server on open/resume so floating
// reminders ("6pm wherever I am") fire in the last zone the server saw.
// The PWA cannot detect travel while closed — the UI always says so.
async function syncDeviceZone() {
  if (!state.authenticated) return;
  const zone = deviceZone();
  if (!zone || zone === (state.settings.device_zone || '')) return;
  try {
    const result = await api('/api/settings', {
      method: 'POST',
      body: {
        settings: { device_zone: zone, device_zone_updated_at: new Date().toISOString() },
      },
    });
    state.settings = result.settings || state.settings;
    if (result.floatingMoved) {
      toast(`Time zone is now ${zone}; moved ${result.floatingMoved} floating reminder${result.floatingMoved === 1 ? '' : 's'}`);
    }
    render();
  } catch {
    // Offline or failed: the old zone stands until the next open.
  }
}

/* ---------------- Utilities ---------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') {
      for (const [prop, val] of Object.entries(value)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {},
  };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (state.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(init.method.toUpperCase())) {
    init.headers['X-CSRF-Token'] = state.csrfToken;
  }
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && state.authenticated) {
      state.authenticated = false;
      showAuth();
    }
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}

let toastTimer = null;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

function isMobile() {
  return window.matchMedia('(max-width: 899px)').matches;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimeValue(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function endOfToday() {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function dueValue(reminder) {
  return reminder.due_at ? new Date(reminder.due_at).getTime() : Number.MAX_SAFE_INTEGER;
}

function formatDue(reminder) {
  if (!reminder.due_at) return null;
  const date = new Date(reminder.due_at);
  const today = startOfToday();
  const dueDay = new Date(date);
  dueDay.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((dueDay - today) / 86400000);
  let day;
  if (dayDiff === 0) day = 'Today';
  else if (dayDiff === 1) day = 'Tomorrow';
  else if (dayDiff === -1) day = 'Yesterday';
  else if (date.getFullYear() === today.getFullYear()) {
    day = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } else {
    day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const time = reminder.has_time
    ? ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '';
  const overdue = !reminder.completed && (
    reminder.has_time ? date.getTime() < Date.now() : dueDay.getTime() < today.getTime()
  );
  return { text: day + time, overdue };
}

function listById(id) {
  return state.lists.find((list) => list.id === id) || null;
}

function defaultListId() {
  if (state.view !== 'home' && typeof state.view === 'number' && listById(state.view)) {
    return state.view;
  }
  if (state.lastListId && listById(state.lastListId)) return state.lastListId;
  return state.lists[0] ? state.lists[0].id : null;
}

function rememberList(id) {
  state.lastListId = id;
  localStorage.setItem('remember.lastList', String(id));
}

/* ---------------- Auth ---------------- */

async function boot() {
  registerServiceWorker();
  try {
    const session = await api('/api/session');
    state.needsSetup = session.needsSetup;
    if (!session.authenticated) return showAuth();
    state.csrfToken = session.csrfToken;
    state.vapidPublicKey = session.vapidPublicKey;
    await loadState();
    showApp();
    syncPushState();
    syncDeviceZone();
  } catch (err) {
    toast(err.message);
  }
}

function showAuth() {
  state.authenticated = false;
  $$('.sheet').forEach((sheet) => { sheet.hidden = true; });
  syncSheetState();
  $('#auth').hidden = false;
  $('#shell').hidden = true;
  $('#auth-confirm').hidden = !state.needsSetup;
  $('#auth-sub').textContent = state.needsSetup
    ? 'Create a password to protect your reminders'
    : 'Enter your password to continue';
  $('#auth-submit').textContent = state.needsSetup ? 'Create Password' : 'Unlock';
  $('#auth-password').setAttribute('autocomplete', state.needsSetup ? 'new-password' : 'current-password');
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
  $('#auth-error').hidden = true;
  setTimeout(() => $('#auth-password').focus(), 50);
}

function authError(message) {
  const node = $('#auth-error');
  node.textContent = message;
  node.hidden = false;
}

async function submitAuth(event) {
  event.preventDefault();
  const password = $('#auth-password').value;
  if (state.needsSetup) {
    if (password.length < 8) return authError('Use at least 8 characters');
    if (password !== $('#auth-confirm').value) return authError('Passwords do not match');
  }
  try {
    await api(state.needsSetup ? '/api/setup' : '/api/login', {
      method: 'POST',
      body: { password },
    });
    const session = await api('/api/session');
    state.needsSetup = false;
    state.csrfToken = session.csrfToken;
    state.vapidPublicKey = session.vapidPublicKey;
    await loadState();
    showApp();
    syncPushState();
  } catch (err) {
    authError(err.message);
  }
}

function showApp() {
  state.authenticated = true;
  $('#auth').hidden = true;
  $('#shell').hidden = false;
  route();
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch { /* ignore */ }
  state.authenticated = false;
  state.csrfToken = null;
  state.lists = [];
  state.reminders = [];
  state.subscription = null;
  showAuth();
}

/* ---------------- Data ---------------- */

async function loadState() {
  const data = await api('/api/state');
  state.lists = data.lists || [];
  state.reminders = data.reminders || [];
  state.settings = data.settings || {};
  if (state.lastListId && !listById(state.lastListId)) {
    state.lastListId = state.lists[0] ? state.lists[0].id : null;
  }
}

async function refreshState() {
  const buttons = $$('.refresh-btn');
  if (buttons.some((btn) => btn.disabled)) return;
  buttons.forEach((btn) => {
    btn.disabled = true;
    btn.classList.add('loading');
  });
  try {
    await loadState();
    render();
    toast('Refreshed');
  } catch (err) {
    toast(err.message);
  } finally {
    buttons.forEach((btn) => {
      btn.disabled = false;
      btn.classList.remove('loading');
    });
  }
}

/* ---------------- Routing ---------------- */

function go(view) {
  location.hash = '#/' + view;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return isMobile() ? 'home' : 'today';
  if (raw === 'home') return 'home';
  if (raw.startsWith('list/')) {
    const id = Number(raw.slice(5));
    return listById(id) ? id : 'all';
  }
  if (raw === 'today' || raw === 'scheduled' || raw === 'all' || raw === 'flagged' || raw === 'completed') return raw;
  return 'today';
}

const SHOW_COMPLETED_KEY = 'remember.showCompleted';

function showCompletedPrefs() {
  try {
    return JSON.parse(localStorage.getItem(SHOW_COMPLETED_KEY)) || {};
  } catch {
    return {};
  }
}

// Completed stays hidden by default, but when you tap "Show N Completed" on
// a list, that choice is remembered per list and restored on every visit.
function getShowCompleted(listId) {
  return Boolean(showCompletedPrefs()[listId]);
}

function setShowCompleted(listId, value) {
  const prefs = showCompletedPrefs();
  if (value) prefs[listId] = true;
  else delete prefs[listId];
  localStorage.setItem(SHOW_COMPLETED_KEY, JSON.stringify(prefs));
}

function route() {
  const view = parseRoute();
  if (view !== state.view) {
    state.showCompleted = typeof view === 'number' ? getShowCompleted(view) : false;
  }
  const active = document.activeElement;
  // Don't steal the keyboard when the user is mid-search: the results view
  // takes over and focus is handed to its own search box below.
  const searching = active && (active === $('#search') || active === $('#main-search')) && state.search;
  if (!searching && active && active.matches('input, textarea, select')) active.blur();
  state.view = view;
  document.body.dataset.screen = view === 'home' ? 'home' : 'detail';
  render();
  if (searching) {
    // The old screen (and its search box) may now be hidden; keep focus on a
    // visible search box so the keyboard stays up.
    let target = document.activeElement;
    if (!target || target.offsetParent === null) {
      target = $('#main-search').offsetParent ? $('#main-search') : $('#search');
    }
    if (target && target.offsetParent !== null) {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
      const value = target.value;
      target.value = '';
      target.value = value;
    }
  }
}

/* ---------------- Render ---------------- */

function incompleteReminders() {
  return state.reminders.filter((reminder) => !reminder.completed);
}

function matchesSearch(reminder) {
  if (!state.search) return true;
  const needle = state.search.toLowerCase();
  return reminder.title.toLowerCase().includes(needle)
    || (reminder.notes || '').toLowerCase().includes(needle);
}

function viewItems() {
  const view = state.view;
  let items;

  if (view === 'today') {
    const limit = endOfToday();
    items = incompleteReminders()
      .filter((reminder) => reminder.due_at && new Date(reminder.due_at) <= limit)
      .sort((a, b) => dueValue(a) - dueValue(b));
  } else if (view === 'scheduled') {
    items = incompleteReminders()
      .filter((reminder) => reminder.due_at)
      .sort((a, b) => dueValue(a) - dueValue(b));
  } else if (view === 'flagged') {
    items = incompleteReminders()
      .filter((reminder) => reminder.urgent)
      .sort((a, b) => dueValue(a) - dueValue(b)
        || new Date(a.created_at) - new Date(b.created_at)
        || a.id - b.id);
  } else if (view === 'all') {
    items = incompleteReminders()
      .sort((a, b) => dueValue(a) - dueValue(b)
        || new Date(a.created_at) - new Date(b.created_at)
        || a.id - b.id);
  } else if (view === 'completed') {
    items = state.reminders
      .filter((reminder) => reminder.completed)
      .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
  } else if (typeof view === 'number') {
    items = state.reminders
      .filter((reminder) => reminder.list_id === view && !reminder.completed)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  } else {
    items = [];
  }

  return items.filter(matchesSearch);
}

function completedInList(listId) {
  return state.reminders
    .filter((reminder) => reminder.list_id === listId && reminder.completed)
    .filter(matchesSearch)
    .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
}

function render() {
  renderSidebar();
  renderMain();
  updateBadge();
}

const SIDEBAR_KEY = 'remember.sidebar';

// Desktop drawer: open by default, toggleable, and the choice persists.
function applySidebar() {
  const open = localStorage.getItem(SIDEBAR_KEY) !== 'closed';
  document.body.classList.toggle('sidebar-closed', !open);
  const btn = $('#menu-btn');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

function toggleSidebar() {
  const closed = document.body.classList.toggle('sidebar-closed');
  localStorage.setItem(SIDEBAR_KEY, closed ? 'closed' : 'open');
  const btn = $('#menu-btn');
  if (btn) btn.setAttribute('aria-expanded', String(!closed));
}

let listDrag = null;

function cleanupListDrag() {
  if (!listDrag) return;
  const drag = listDrag;
  listDrag = null;
  drag.grip.removeEventListener('pointermove', drag.onMove);
  drag.grip.removeEventListener('pointerup', drag.onUp);
  drag.grip.removeEventListener('pointercancel', drag.onCancel);
  try { drag.grip.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
  drag.ghost.remove();
  drag.row.classList.remove('dragging');
  $$('#lists .list-row').forEach((node) => node.classList.remove('drop-before', 'drop-after'));
  document.body.classList.remove('list-dragging');
}

function startListDrag(event, list, row, grip) {
  if (event.button !== undefined && event.button !== 0) return;
  if (state.lists.length < 2 || listDrag) return;
  event.preventDefault();

  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('list-drag-ghost');
  ghost.classList.remove('active');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  document.body.append(ghost);

  row.classList.add('dragging');
  document.body.classList.add('list-dragging');

  const drag = {
    list,
    row,
    grip,
    ghost,
    pointerId: event.pointerId,
    startY: event.clientY,
    startTop: rect.top,
    height: rect.height,
    targetIndex: state.lists.findIndex((item) => item.id === list.id),
    onMove: null,
    onUp: null,
    onCancel: null,
  };
  listDrag = drag;

  drag.onMove = (moveEvent) => {
    if (!listDrag || moveEvent.pointerId !== drag.pointerId) return;
    const dy = moveEvent.clientY - drag.startY;
    drag.ghost.style.top = `${drag.startTop + dy}px`;
    const center = drag.startTop + drag.height / 2 + dy;
    const rows = $$('#lists .list-row').filter((node) => node !== row);
    let index = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      const box = rows[i].getBoundingClientRect();
      if (center < box.top + box.height / 2) {
        index = i;
        break;
      }
    }
    drag.targetIndex = index;
    $$('#lists .list-row').forEach((node) => node.classList.remove('drop-before', 'drop-after'));
    if (index < rows.length) rows[index].classList.add('drop-before');
    else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
  };

  drag.onUp = (upEvent) => {
    if (!listDrag || upEvent.pointerId !== drag.pointerId) return;
    const index = drag.targetIndex;
    const ids = state.lists.map((item) => item.id).filter((id) => id !== list.id);
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, list.id);
    const changed = ids.some((id, i) => id !== state.lists[i].id);
    cleanupListDrag();
    if (!changed) return;

    state.lists = ids.map((id) => state.lists.find((item) => item.id === id));
    renderSidebar();
    persistListOrder(ids);
  };

  drag.onCancel = () => cleanupListDrag();

  grip.setPointerCapture(event.pointerId);
  grip.addEventListener('pointermove', drag.onMove);
  grip.addEventListener('pointerup', drag.onUp);
  grip.addEventListener('pointercancel', drag.onCancel);
}

function persistListOrder(ids) {
  api('/api/lists/order', { method: 'PUT', body: { ids } }).catch(async (err) => {
    toast(err.message);
    await loadState();
    render();
  });
}

// Keyboard alternative to drag-and-drop (WCAG 2.2 AA): focus a list's grip
// and use arrow keys to move it. Every move is announced.
function moveListKeyboard(listId, direction) {
  const from = state.lists.findIndex((item) => item.id === listId);
  if (from === -1) return;
  const to = Math.max(0, Math.min(state.lists.length - 1, from + direction));
  if (to === from) return;
  const ids = state.lists.map((item) => item.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  state.lists = ids.map((id) => state.lists.find((item) => item.id === id));
  renderSidebar();
  persistListOrder(ids);
  const list = listById(listId);
  announce(`${list ? list.name : 'List'} moved to position ${to + 1} of ${ids.length}`);
  const grip = $(`#lists .list-grip[data-list-id="${listId}"]`);
  if (grip) grip.focus();
}

function isOverdue(reminder) {
  if (!reminder.due_at || reminder.completed) return false;
  const due = formatDue(reminder);
  return Boolean(due && due.overdue);
}

function isSnoozed(reminder) {
  return Boolean(reminder.snoozed_until && new Date(reminder.snoozed_until).getTime() > Date.now());
}

function snoozeLabel(untilISO) {
  const date = new Date(untilISO);
  const today = startOfToday();
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const sameDay = day.getTime() === today.getTime();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Snoozed until ${time}` : `Snoozed until ${day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function renderSidebar() {
  const todayLimit = endOfToday();
  const incomplete = incompleteReminders();
  const todayCount = incomplete
    .filter((reminder) => reminder.due_at && new Date(reminder.due_at) <= todayLimit).length;
  const allCount = incomplete.length;
  const scheduledCount = incomplete.filter((reminder) => reminder.due_at).length;
  const flaggedCount = incomplete.filter((reminder) => reminder.urgent).length;

  $('#count-today').textContent = todayCount ? String(todayCount) : '';
  $('#count-scheduled').textContent = scheduledCount ? String(scheduledCount) : '';
  $('#count-all').textContent = allCount ? String(allCount) : '';
  $('#count-flagged').textContent = flaggedCount ? String(flaggedCount) : '';

  $$('#smart-nav .nav-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.view === state.view);
  });

  const wrap = $('#lists');
  wrap.replaceChildren();
  if (!state.lists.length) {
    wrap.append(el('p', { class: 'section-empty', text: 'No lists yet' }));
    return;
  }

  for (const list of state.lists) {
    const row = el('button', {
      class: 'list-row' + (state.view === list.id ? ' active' : ''),
      style: { '--c': colorVar(list.color) },
      onclick: () => go('list/' + list.id),
    }, [
      el('span', { class: 'list-dot' }),
      el('span', { class: 'list-name', text: list.name }),
      el('span', { class: 'badge', text: list.count ? String(list.count) : '' }),
    ]);
    const grip = el('span', {
      class: 'list-grip',
      title: 'Drag to reorder',
      tabindex: '0',
      role: 'button',
      'data-list-id': list.id,
      'aria-label': `Reorder ${list.name}: drag, or press up and down arrows to move`,
      html: ICON('grip', 'ic'),
    });
    grip.addEventListener('pointerdown', (event) => startListDrag(event, list, row, grip));
    grip.addEventListener('click', (event) => event.stopPropagation());
    grip.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        moveListKeyboard(list.id, event.key === 'ArrowUp' ? -1 : 1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        const from = state.lists.findIndex((item) => item.id === list.id);
        moveListKeyboard(list.id, (event.key === 'Home' ? 0 : state.lists.length - 1) - from);
      }
    });
    row.append(grip);
    wrap.append(row);
  }

  $('#notifications-label').textContent = state.subscription ? 'Notifications On' : 'Notifications';
}

function renderMain() {
  const view = state.view;
  const content = $('#content');
  content.replaceChildren();
  $('#view-menu').hidden = true;

  if (view === 'home') {
    $('#view-title').textContent = 'My Lists';
    $('#view-count').textContent = state.lists.length ? String(state.lists.length) : '';
    document.title = 'Remember';
    renderHome(content);
    return;
  }

  let title = 'Today';
  let list = null;
  if (view === 'all') title = 'All';
  else if (view === 'scheduled') title = 'Scheduled';
  else if (view === 'flagged') title = 'Flagged';
  else if (view === 'completed') title = 'Completed';
  else if (typeof view === 'number') {
    list = listById(view);
    title = list ? list.name : 'All';
  }

  const items = viewItems();
  const completed = typeof view === 'number' && state.showCompleted ? completedInList(view) : [];
  const completeCount = typeof view === 'number' && list
    ? state.reminders.filter((reminder) => reminder.list_id === list.id && reminder.completed).length
    : 0;

  $('#view-title').textContent = title;
  const shownCount = typeof view === 'number'
    ? items.length + (state.showCompleted ? completed.length : 0)
    : items.length;
  $('#view-count').textContent = shownCount ? String(shownCount) : '';
  if (typeof view === 'number') {
    $('#view-menu').hidden = false;
    $('#view-menu').onclick = () => openListSheet(list);
  }
  document.title = `Remember — ${title}`;

  if (!items.length && !completed.length) {
    content.append(emptyState(view));
    if (state.search) return;
  } else if (view === 'scheduled') {
    renderScheduled(content, items);
  } else if (view === 'today') {
    renderToday(content, items);
  } else {
    const group = el('div', { class: 'reminder-group' });
    for (const reminder of items) {
      group.append(reminderRow(reminder, { reschedule: view === 'flagged' && isOverdue(reminder) }));
    }
    content.append(group);
  }

  if (typeof view === 'number' && completeCount) {
    content.append(el('button', {
      class: 'toggle-completed',
      text: `${state.showCompleted ? 'Hide' : 'Show'} ${completeCount} Completed`,
      onclick: () => {
        state.showCompleted = !state.showCompleted;
        if (typeof state.view === 'number') setShowCompleted(state.view, state.showCompleted);
        renderMain();
      },
    }));

    if (state.showCompleted && completed.length) {
      content.append(el('h3', { class: 'group-title', text: 'Completed' }));
      const group = el('div', { class: 'reminder-group' });
      for (const reminder of completed) group.append(reminderRow(reminder));
      content.append(group);
    }
  }

  if (!state.lists.length) {
    content.append(el('button', {
      class: 'toggle-completed',
      text: 'Create a list to start adding reminders',
      onclick: () => openListSheet(null),
    }));
  }
}

function emptyState(view) {
  // Warmer empty states with a primary action where one makes sense.
  const copy = {
    today: { icon: 'calendar', heading: 'All clear', message: 'Nothing is due today. Enjoy the quiet — or get ahead.', action: 'New Reminder' },
    scheduled: { icon: 'clock', heading: 'Nothing scheduled', message: 'Give a reminder a date and it will show up here, grouped by day.', action: 'New Reminder' },
    all: { icon: 'all', heading: 'A fresh start', message: 'No reminders yet. Capture the first thing on your mind.', action: 'New Reminder' },
    flagged: { icon: 'flag', heading: 'Nothing flagged', message: 'Mark a reminder urgent and it will wait for you here.', action: null },
    completed: { icon: 'done', heading: 'No history yet', message: 'Finished reminders land here for the next 30 days.', action: null },
  }[view] || { icon: 'all', heading: 'Nothing here', message: 'No reminders in this list yet.', action: 'New Reminder' };
  const children = [
    el('span', { html: ICON(copy.icon) }),
    el('h3', { class: 'empty-heading', text: copy.heading }),
    el('p', { text: state.search ? 'No matching reminders' : copy.message }),
  ];
  if (state.search) {
    children.push(el('button', {
      type: 'button',
      class: 'primary-btn',
      text: 'Clear search',
      onclick: () => setSearch('', 'both'),
    }));
  } else if (copy.action) {
    children.push(el('button', {
      type: 'button',
      class: 'primary-btn',
      text: copy.action,
      onclick: () => openEditor(null),
    }));
  }
  return el('div', { class: 'empty' }, children);
}

function dateGroupLabel(dueAt) {
  const date = new Date(dueAt);
  const today = startOfToday();
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// Overdue items stay pinned at the top until completed or rescheduled,
// with one-tap Today/Tomorrow buttons on each row.
function renderOverdueSection(content, items) {
  const overdue = items.filter(isOverdue);
  if (!overdue.length) return [];
  content.append(el('h3', { class: 'group-title overdue-title', text: `Overdue · ${overdue.length}` }));
  const group = el('div', { class: 'reminder-group' });
  for (const reminder of overdue) group.append(reminderRow(reminder, { reschedule: true }));
  content.append(group);
  return overdue.map((reminder) => reminder.id);
}

function renderToday(content, items) {
  const seen = new Set(renderOverdueSection(content, items));
  const rest = items.filter((reminder) => !seen.has(reminder.id));
  if (!rest.length) return;
  const group = el('div', { class: 'reminder-group' });
  for (const reminder of rest) group.append(reminderRow(reminder));
  content.append(group);
}

function renderScheduled(content, items) {
  const seen = new Set(renderOverdueSection(content, items));
  const upcoming = items.filter((reminder) => !seen.has(reminder.id));
  const groups = new Map();
  for (const reminder of upcoming) {
    const day = new Date(reminder.due_at);
    day.setHours(0, 0, 0, 0);
    const key = day.getTime();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(reminder);
  }
  for (const [key, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    content.append(el('h3', { class: 'group-title', text: dateGroupLabel(group[0].due_at) }));
    const wrap = el('div', { class: 'reminder-group' });
    for (const reminder of group) wrap.append(reminderRow(reminder));
    content.append(wrap);
  }
}

function renderHome(content) {
  if (state.search) {
    const matches = state.reminders.filter(matchesSearch);
    if (!matches.length) {
      content.append(el('div', { class: 'empty' }, [
        el('span', { html: ICON('search') }),
        el('p', { text: 'No matching reminders' }),
      ]));
      return;
    }
    const group = el('div', { class: 'reminder-group' });
    for (const reminder of matches) group.append(reminderRow(reminder));
    content.append(group);
    return;
  }

  const grid = el('div', { class: 'grid' });
  for (const list of state.lists) {
    const card = el('button', {
      class: 'list-card',
      style: { '--c': colorVar(list.color) },
      onclick: () => go('list/' + list.id),
    }, [
      el('span', { class: 'card-count', text: list.count ? String(list.count) : '' }),
      el('span', { class: 'card-dot' }),
      el('span', { class: 'card-name', text: list.name }),
    ]);
    grid.append(card);
  }

  grid.append(el('button', {
    class: 'list-card card-add',
    onclick: () => openListSheet(null),
  }, [
    el('span', { html: ICON('plus') }),
    el('span', { text: 'New List' }),
  ]));

  content.append(grid);
}

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

function cleanUrl(value) {
  return value.replace(/[),.;!?]+$/, '');
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

function linkChip(url) {
  // Compact chip (icon + domain) instead of a full magenta URL: the full
  // address stays in the notes field. No third-party favicon service — the
  // link glyph is inline SVG so domains never leak to Google.
  return el('a', {
    class: 'link-chip',
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: url,
    'aria-label': `Open link: ${domainOf(url)}`,
    onclick: (event) => event.stopPropagation(),
  }, [
    el('span', { html: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a5 5 0 007.07 0l3.54-3.54a5 5 0 00-7.07-7.07L12 5M14 10a5 5 0 00-7.07 0L3.39 13.54a5 5 0 007.07 7.07L12 19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>' }),
    el('span', { class: 'link-domain', text: domainOf(url) }),
  ]);
}

// First line of notes with URLs replaced by compact chips.
function appendNotePreview(parent, value) {
  const text = String(value);
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const url = cleanUrl(raw);
    const trailing = raw.slice(url.length);
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    if (url) parent.append(linkChip(url));
    if (trailing) parent.append(document.createTextNode(trailing));
    last = match.index + raw.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function appendLinkedText(parent, value) {
  appendNotePreview(parent, value);
}

function renderEditorLinks() {
  const wrap = $('#e-notes-links');
  if (!wrap) return;
  const urls = [...$('#e-notes').value.matchAll(URL_PATTERN)]
    .map((match) => cleanUrl(match[0]))
    .filter(Boolean);
  const unique = [...new Set(urls)];
  wrap.replaceChildren();
  if (!unique.length) {
    wrap.hidden = true;
    return;
  }
  for (const url of unique) {
    wrap.append(linkChip(url));
  }
  wrap.hidden = false;
}

function autoGrowTitle() {
  const title = $('#e-title');
  title.style.height = 'auto';
  title.style.height = `${title.scrollHeight}px`;
}

function autoGrowNotes() {
  const notes = $('#e-notes');
  notes.style.height = 'auto';
  notes.style.height = `${notes.scrollHeight}px`;
}

function timeModelLabel(reminder) {
  if (reminder.time_model === 'floating') {
    const zone = (state.settings && state.settings.device_zone) || reminder.time_zone;
    return zone ? `Floating · ${zone}` : 'Floating';
  }
  if (reminder.time_model === 'anchored') {
    return reminder.time_zone ? `Anchored · ${reminder.time_zone}` : 'Anchored';
  }
  return null;
}

async function snoozeRow(reminder, hours = 1) {
  try {
    const result = await api('/api/reminders/' + reminder.id + '/snooze', {
      method: 'POST',
      body: { hours },
    });
    await loadState();
    render();
    toast(`Snoozed until ${new Date(result.snoozedUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
  } catch (err) {
    toast(err.message);
  }
}

async function rescheduleRow(reminder, date) {
  try {
    await api('/api/reminders/' + reminder.id + '/reschedule', {
      method: 'POST',
      body: { date },
    });
    await loadState();
    render();
    toast(date === 'today' ? 'Moved to today' : 'Moved to tomorrow');
  } catch (err) {
    toast(err.message);
  }
}

function reminderRow(reminder, options = {}) {
  const list = listById(reminder.list_id);
  const color = colorVar(list ? list.color : 'blue');
  const due = formatDue(reminder);
  const viewIsList = typeof state.view === 'number';

  const meta = el('div', { class: 'reminder-meta' });
  if (!viewIsList && list) {
    meta.append(el('span', { class: 'meta-list', style: { '--c': color } }, [
      el('span', { class: 'meta-dot' }),
      el('span', { text: list.name }),
    ]));
  }
  if (due) {
    meta.append(el('span', {
      class: 'meta-due' + (due.overdue ? ' overdue' : ''),
      html: ICON('calendar', 'ic') + `<span>${escapeHtml(due.text)}</span>`,
    }));
  }
  const rule = parseRuleClient(reminder.repeat_rule);
  if (rule.type !== 'none') {
    meta.append(el('span', {
      class: 'meta-repeat',
      title: repeatLabel(rule),
      html: ICON('repeat', 'ic') + `<span>${escapeHtml(repeatLabel(rule))}</span>`,
    }));
  }
  if (reminder.urgent) {
    meta.append(el('span', {
      class: 'meta-urgent',
      html: ICON('bell', 'ic') + '<span>Urgent</span>',
    }));
  }
  const model = timeModelLabel(reminder);
  if (model) {
    meta.append(el('span', { class: 'meta-model', text: model }));
  }
  if (reminder.occurrence_edited) {
    meta.append(el('span', { class: 'meta-edited', text: 'This occurrence' }));
  }
  if (isSnoozed(reminder)) {
    meta.append(el('span', {
      class: 'meta-snoozed',
      html: ICON('clock', 'ic') + `<span>${escapeHtml(snoozeLabel(reminder.snoozed_until))}</span>`,
    }));
  }

  const body = el('div', { class: 'reminder-body' }, [
    el('div', { class: 'reminder-title', text: reminder.title }),
    meta,
  ]);
  if (reminder.notes) {
    const notes = el('div', { class: 'reminder-notes' });
    appendNotePreview(notes, reminder.notes.split('\n')[0]);
    body.append(notes);
  }

  // Contextual actions live on the row so due items never require opening
  // the editor: snooze on any due/overdue item, one-tap reschedule on
  // overdue items in the smart views.
  if (!reminder.completed && reminder.due_at && !isSnoozed(reminder) && due
    && new Date(reminder.due_at) <= endOfToday()) {
    body.append(el('div', { class: 'row-actions' }, [
      el('button', {
        type: 'button',
        class: 'mini-btn',
        text: 'Snooze 1h',
        'aria-label': `Snooze ${reminder.title} for 1 hour`,
        onclick: (event) => { event.stopPropagation(); snoozeRow(reminder, 1); },
      }),
    ]));
  }
  if (!reminder.completed && options.reschedule && isOverdue(reminder)) {
    body.append(el('div', { class: 'row-actions' }, [
      el('button', {
        type: 'button',
        class: 'mini-btn',
        text: 'Today',
        'aria-label': `Move ${reminder.title} to today`,
        onclick: (event) => { event.stopPropagation(); rescheduleRow(reminder, 'today'); },
      }),
      el('button', {
        type: 'button',
        class: 'mini-btn',
        text: 'Tomorrow',
        'aria-label': `Move ${reminder.title} to tomorrow`,
        onclick: (event) => { event.stopPropagation(); rescheduleRow(reminder, 'tomorrow'); },
      }),
    ]));
  }

  const check = el('button', {
    class: 'check',
    'aria-label': reminder.completed ? 'Mark incomplete' : 'Mark complete',
    html: ICON('check'),
  });
  check.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleCompleted(reminder);
  });

  // Web equivalent of swipe-to-delete: a quiet × that appears on hover for
  // mouse users (never on touch, where the swipe owns this gesture).
  const remove = el('button', {
    type: 'button',
    class: 'row-delete',
    'aria-label': `Delete ${reminder.title}`,
    html: ICON('x', 'ic'),
    onclick: (event) => { event.stopPropagation(); deleteReminderSwipe(reminder); },
  });

  const content = el('div', { class: 'swipe-content' }, [check, body, remove]);
  const background = el('div', { class: 'swipe-bg', 'aria-hidden': 'true' }, [
    el('span', { class: 'swipe-act done' }, [
      el('span', { html: ICON('check', 'ic') }),
      el('span', { text: 'Done' }),
    ]),
    el('span', { class: 'swipe-act del' }, [
      el('span', { text: 'Delete' }),
      el('span', { html: ICON('x', 'ic') }),
    ]),
  ]);

  return el('div', {
    class: 'reminder' + (reminder.completed ? ' done' : ''),
    style: { '--c': color },
    'data-reminder-id': reminder.id,
    onclick: () => {
      // A swipe that just ended must not open the editor.
      if (Date.now() - lastSwipeEnd < 400) return;
      openEditor(reminder.id);
    },
  }, [background, content]);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* ---------------- Reminder actions ---------------- */

async function toggleCompleted(reminder) {
  try {
    const result = await api('/api/reminders/' + reminder.id, {
      method: 'PATCH',
      body: { completed: !reminder.completed },
    });
    await loadState();
    render();
    if (result && result.advanced && result.nextDue) {
      const next = new Date(result.nextDue);
      toast(`Done — next: ${next.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`);
    }
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Editor ---------------- */

function syncDateTimeRows() {
  if ($('#e-time-on').checked) $('#e-date-on').checked = true;
  if (!$('#e-date-on').checked) $('#e-time-on').checked = false;
  if ($('#e-date-on').checked && !$('#e-date').value) $('#e-date').value = localDateValue(new Date());
  if ($('#e-time-on').checked && !$('#e-time').value) {
    $('#e-time').value = (state.settings && state.settings.default_time) || '09:00';
  }
  $('#e-date-row').hidden = !$('#e-date-on').checked;
  $('#e-time-row').hidden = !$('#e-time-on').checked;
}

function updateEditorListVisual() {
  const list = listById(Number($('#e-list').value));
  $('#e-list-icon').style.setProperty('--c', colorVar(list ? list.color : 'blue'));
  $('#e-list-value').textContent = list ? list.name : '';
}

function setScope(scope) {
  state.editScope = scope === 'occurrence' ? 'occurrence' : 'series';
  $('#scope-occurrence').classList.toggle('active', state.editScope === 'occurrence');
  $('#scope-series').classList.toggle('active', state.editScope === 'series');
  $('#scope-occurrence').setAttribute('aria-pressed', state.editScope === 'occurrence' ? 'true' : 'false');
  $('#scope-series').setAttribute('aria-pressed', state.editScope === 'series' ? 'true' : 'false');
}

function syncRepeatRows() {
  const value = $('#e-repeat').value;
  $('#e-repeat-custom').hidden = value !== 'custom';
  $('#e-repeat-value').textContent = value === 'custom'
    ? `Every ${Math.max(1, Number($('#e-repeat-interval').value) || 1)} ${$('#e-repeat-unit').value}`
    : repeatLabel({ type: value, interval: 1 });
  const editing = Boolean(state.editingId);
  const recurring = value !== 'none';
  $('#completed-row').hidden = !editing || recurring;
  $('#series-section').hidden = !editing || !recurring;
}

function buildZoneOptions(selected) {
  const select = $('#e-zone');
  select.replaceChildren();
  const zones = [...new Set([deviceZone(), ...ZONES].filter(Boolean))];
  for (const zone of zones) {
    select.append(el('option', { value: zone, text: zone.replace(/_/g, ' ') }));
  }
  select.value = zones.includes(selected) ? selected : (zones[0] || 'UTC');
}

function syncModelRows() {
  const model = $('#e-model').value;
  $('#e-model-value').textContent = model === 'fixed' ? 'Fixed time'
    : model === 'floating' ? 'Floating' : 'Anchored';
  $('#e-zone-row').hidden = model !== 'anchored';
  const hint = $('#e-model-hint');
  if (model === 'floating') {
    const synced = (state.settings && state.settings.device_zone) || '';
    hint.hidden = false;
    hint.textContent = synced
      ? `Follows this device; last synced in ${synced}. Travel without opening the app cannot move it.`
      : 'Follows this device once it reports its time zone.';
  } else if (model === 'anchored') {
    hint.hidden = false;
    hint.textContent = `Always fires at that clock time in ${$('#e-zone').value || 'the chosen zone'}.`;
  } else {
    hint.hidden = true;
  }
}

// Any manual touch of the Date/Time/Repeat controls wins over the
// natural-language autofill: your edits are never overwritten.
function markScheduleManual() {
  scheduleLocked = true;
  hideParseChip();
}

function onRepeatChange(manual = true) {
  syncRepeatRows();
  if (manual) markScheduleManual();
  if ($('#e-repeat').value !== 'none' && $('#e-model').value === 'fixed') {
    // Recurring reminders default to zone-anchored on the creation zone.
    $('#e-model').value = 'anchored';
    const zone = deviceZone();
    if (zone) $('#e-zone').value = zone;
    syncModelRows();
  }
  if ($('#e-repeat').value !== 'none' && !$('#e-date-on').checked) {
    $('#e-date-on').checked = true;
    syncDateTimeRows();
  }
}

function syncSnoozeRow() {
  const reminder = state.editingId
    ? state.reminders.find((item) => item.id === state.editingId)
    : null;
  const row = $('#snooze-row');
  if (!reminder || !reminder.due_at) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  if (isSnoozed(reminder)) {
    $('#e-snooze-label').textContent = snoozeLabel(reminder.snoozed_until);
    $('#e-snooze-btn').textContent = 'Cancel';
  } else {
    $('#e-snooze-label').textContent = 'Snooze';
    $('#e-snooze-btn').textContent = 'Snooze 1h';
  }
}

async function toggleEditorSnooze() {
  const reminder = state.reminders.find((item) => item.id === state.editingId);
  if (!reminder) return;
  try {
    if (isSnoozed(reminder)) {
      await api('/api/reminders/' + reminder.id + '/snooze', { method: 'POST', body: { clear: true } });
      toast('Snooze cancelled');
    } else {
      const result = await api('/api/reminders/' + reminder.id + '/snooze', { method: 'POST', body: { hours: 1 } });
      toast(`Snoozed until ${new Date(result.snoozedUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
    }
    await loadState();
    render();
    syncSnoozeRow();
  } catch (err) {
    toast(err.message);
  }
}

async function skipCurrentOccurrence() {
  if (!state.editingId) return;
  try {
    const result = await api('/api/reminders/' + state.editingId + '/skip', { method: 'POST' });
    closeSheet('#editor');
    await loadState();
    render();
    const next = new Date(result.nextDue);
    toast(`Skipped — next: ${next.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`);
  } catch (err) {
    toast(err.message);
  }
}

function formatOccurrenceDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

async function loadHistory(id) {
  const wrap = $('#e-history');
  wrap.replaceChildren();
  try {
    const data = await api('/api/reminders/' + id + '/occurrences');
    const rows = data.occurrences || [];
    if (!rows.length) {
      wrap.append(el('p', { class: 'history-empty', text: 'No completions or skips yet.' }));
    }
    for (const occurrence of rows) {
      const label = occurrence.status === 'completed' ? 'Done'
        : occurrence.status === 'skipped' ? 'Skipped' : 'Edited';
      wrap.append(el('div', { class: 'history-row' }, [
        el('span', { class: 'history-status', text: label }),
        el('span', { class: 'history-date', text: formatOccurrenceDate(occurrence.occurrence_at) }),
      ]));
    }
    wrap.hidden = false;
  } catch {
    wrap.hidden = true;
  }
}

function openEditor(id) {
  const reminder = id ? state.reminders.find((item) => item.id === id) : null;
  if (!state.lists.length) {
    toast('Create a list first');
    openListSheet(null);
    return;
  }

  clearTimeout(parseTimer);
  scheduleLocked = false;
  parseSnapshot = null;
  hideParseChip();

  state.editingId = reminder ? reminder.id : null;
  $('#editor-heading').textContent = reminder ? 'Edit Reminder' : 'New Reminder';
  $('#e-title').value = reminder ? reminder.title : '';
  $('#e-notes').value = reminder ? reminder.notes : '';

  const select = $('#e-list');
  select.replaceChildren();
  for (const list of state.lists) {
    select.append(el('option', { value: String(list.id), text: list.name }));
  }
  select.value = String(reminder ? reminder.list_id : defaultListId());
  updateEditorListVisual();

  const due = reminder && reminder.due_at ? new Date(reminder.due_at) : null;
  $('#e-date-on').checked = Boolean(due);
  $('#e-time-on').checked = Boolean(due && reminder.has_time);
  $('#e-date').value = due ? localDateValue(due) : '';
  $('#e-time').value = due && reminder.has_time ? localTimeValue(due) : '';
  $('#e-urgent').checked = Boolean(reminder && reminder.urgent);
  syncDateTimeRows();

  const rule = parseRuleClient(reminder ? reminder.repeat_rule : 'none');
  if (rule.type === 'custom') {
    $('#e-repeat').value = 'custom';
    $('#e-repeat-interval').value = rule.interval || 2;
    $('#e-repeat-unit').value = rule.unit || 'days';
  } else {
    $('#e-repeat').value = rule.type;
  }
  $('#e-model').value = reminder
    ? (reminder.time_model || 'fixed')
    : ((state.settings && state.settings.default_time_model) || 'fixed');
  buildZoneOptions(reminder ? reminder.time_zone : deviceZone());
  setScope('series');
  syncRepeatRows();
  syncModelRows();

  const editing = Boolean(reminder);
  $('#e-completed').checked = editing && reminder.completed;
  $('#e-delete').hidden = !editing;
  renderEditorLinks();
  syncSnoozeRow();
  $('#e-history').hidden = true;
  if (editing && rule.type !== 'none') loadHistory(reminder.id);

  openSheet('#editor');
  setTimeout(() => {
    autoGrowTitle();
    autoGrowNotes();
    $('#e-title').focus();
  }, 80);
}

async function saveEditor(event) {
  event.preventDefault();
  const title = $('#e-title').value.trim();
  if (!title) return toast('Title is required');

  const listId = Number($('#e-list').value);
  const dateOn = $('#e-date-on').checked;
  const timeOn = $('#e-time-on').checked;
  const dateValue = dateOn ? $('#e-date').value : '';
  const timeValue = timeOn ? $('#e-time').value : '';
  if (dateOn && !dateValue) return toast('Choose a date');
  if (timeOn && !dateValue) return toast('Choose a date for the time');

  let dueAt = null;
  let hasTime = 0;
  if (dateValue) {
    const [year, month, day] = dateValue.split('-').map(Number);
    if (timeOn && timeValue) {
      const [hours, minutes] = timeValue.split(':').map(Number);
      dueAt = new Date(year, month - 1, day, hours, minutes).toISOString();
      hasTime = 1;
    } else {
      const [defHours, defMinutes] = String((state.settings && state.settings.default_time) || '09:00').split(':').map(Number);
      dueAt = new Date(year, month - 1, day, defHours, defMinutes).toISOString();
    }
  }

  const repeatValue = $('#e-repeat').value;
  let repeatRule = 'none';
  if (repeatValue !== 'none') {
    if (!dateOn) return toast('Repeating reminders need a date');
    if (repeatValue === 'custom') {
      const interval = Math.max(1, Math.min(366, Number($('#e-repeat-interval').value) || 1));
      repeatRule = { type: 'custom', interval, unit: $('#e-repeat-unit').value };
    } else {
      repeatRule = { type: repeatValue, interval: 1 };
    }
  }

  const model = $('#e-model').value;
  const current = state.editingId
    ? state.reminders.find((item) => item.id === state.editingId)
    : null;
  const editingSeries = current && parseRuleClient(current.repeat_rule).type !== 'none';
  const scope = editingSeries ? state.editScope : 'series';
  const body = {
    title,
    notes: $('#e-notes').value,
    list_id: listId,
    urgent: $('#e-urgent').checked,
    device_zone: deviceZone(),
  };
  if (scope === 'occurrence') {
    // Occurrence-only edits carry just the overridden fields; date changes
    // always go through the series path (the server enforces this too).
    body.scope = 'occurrence';
  } else {
    body.due_at = dueAt;
    body.has_time = hasTime;
    body.repeat_rule = repeatRule;
    body.time_model = model;
    body.time_zone = model === 'anchored' ? $('#e-zone').value : (model === 'floating' ? deviceZone() || null : null);
    // Recurring series are never marked completed — completing advances them.
    if (!editingSeries) body.completed = $('#e-completed').checked;
  }

  try {
    if (state.editingId) {
      await api('/api/reminders/' + state.editingId, { method: 'PATCH', body });
    } else {
      await api('/api/reminders', { method: 'POST', body });
    }
    rememberList(listId);
    closeSheet('#editor');
    await loadState();
    render();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Natural-language quick add ---------------- */

let parseTimer = null;
let parseSeq = 0;
let parseSnapshot = null;
let scheduleLocked = false;

function hideParseChip() {
  $('#e-parse-chip').hidden = true;
}

function scheduleParse() {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(runParse, 450);
}

async function runParse() {
  const text = $('#e-title').value;
  if ($('#editor').hidden || scheduleLocked || text.trim().length < 3) return;
  const seq = ++parseSeq;
  let result;
  try {
    result = await api('/api/parse', { method: 'POST', body: { text, timeZone: deviceZone() } });
  } catch {
    return; // offline: the title still saves verbatim
  }
  if (seq !== parseSeq || $('#editor').hidden || scheduleLocked) return;
  applyParse(result);
}

function chipDateLabel(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  const label = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (!timeStr) return label;
  const [h, mi] = timeStr.split(':').map(Number);
  const time = new Date(y, mo - 1, d, h, mi)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${label} · ${time}`;
}

function applyParse(result) {
  if ((!result.date) && (!result.repeat || result.repeat === 'none')) {
    hideParseChip();
    return;
  }
  parseSnapshot = {
    dateOn: $('#e-date-on').checked,
    timeOn: $('#e-time-on').checked,
    date: $('#e-date').value,
    time: $('#e-time').value,
    repeat: $('#e-repeat').value,
    interval: $('#e-repeat-interval').value,
    unit: $('#e-repeat-unit').value,
  };
  if (result.date) {
    $('#e-date-on').checked = true;
    $('#e-date').value = result.date;
    if (result.hasTime && result.time) {
      $('#e-time-on').checked = true;
      $('#e-time').value = result.time;
    } else {
      $('#e-time-on').checked = false;
    }
    syncDateTimeRows();
  }
  if (result.repeat && result.repeat !== 'none') {
    if (result.repeat.type === 'custom') {
      $('#e-repeat').value = 'custom';
      $('#e-repeat-interval').value = result.repeat.interval;
      $('#e-repeat-unit').value = result.repeat.unit;
    } else {
      $('#e-repeat').value = result.repeat.type;
    }
    onRepeatChange(false);
  }
  const parts = [];
  if (result.date) parts.push(chipDateLabel(result.date, result.time));
  if (result.repeat && result.repeat !== 'none') parts.push(repeatLabel(result.repeat));
  $('#e-parse-text').textContent = parts.join(' · ') || 'Parsed';
  $('#e-parse-chip').hidden = false;
}

function clearParse() {
  if (parseSnapshot) {
    $('#e-date-on').checked = parseSnapshot.dateOn;
    $('#e-time-on').checked = parseSnapshot.timeOn;
    $('#e-date').value = parseSnapshot.date;
    $('#e-time').value = parseSnapshot.time;
    $('#e-repeat').value = parseSnapshot.repeat;
    $('#e-repeat-interval').value = parseSnapshot.interval;
    $('#e-repeat-unit').value = parseSnapshot.unit;
    syncDateTimeRows();
    syncRepeatRows();
  }
  parseSnapshot = null;
  scheduleLocked = true;
  hideParseChip();
}

async function deleteReminder() {
  if (!state.editingId) return;
  if (!window.confirm('Delete this reminder?')) return;
  try {
    await api('/api/reminders/' + state.editingId, { method: 'DELETE' });
    closeSheet('#editor');
    await loadState();
    render();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Lists ---------------- */

function nextListColor() {
  // Pre-select the first palette color no list uses yet, so every list
  // starts distinct. When all 15 are taken, rotate through the palette.
  const used = new Set(state.lists.map((list) => list.color));
  const free = COLORS.find((color) => !used.has(color));
  if (free) return free;
  return COLORS[state.lists.length % COLORS.length];
}

function openListSheet(list) {
  state.editingListId = list ? list.id : null;
  state.selectedColor = list ? list.color : nextListColor();
  $('#list-heading').textContent = list ? 'Edit List' : 'New List';
  $('#l-name').value = list ? list.name : '';
  $('#l-delete').hidden = !list;
  renderSwatches();
  openSheet('#list-sheet');
  setTimeout(() => $('#l-name').focus(), 80);
}

function renderSwatches() {
  const wrap = $('#swatches');
  wrap.replaceChildren();
  for (const color of COLORS) {
    wrap.append(el('button', {
      type: 'button',
      class: 'swatch' + (color === state.selectedColor ? ' selected' : ''),
      style: { '--c': colorVar(color) },
      'aria-label': 'Color ' + color,
      onclick: () => {
        state.selectedColor = color;
        renderSwatches();
      },
    }));
  }
}

async function saveList(event) {
  event.preventDefault();
  const name = $('#l-name').value.trim();
  if (!name) return toast('List name is required');

  const body = { name, color: state.selectedColor };
  try {
    if (state.editingListId) {
      await api('/api/lists/' + state.editingListId, { method: 'PATCH', body });
      closeSheet('#list-sheet');
      await loadState();
      render();
    } else {
      const created = await api('/api/lists', { method: 'POST', body });
      closeSheet('#list-sheet');
      await loadState();
      go('list/' + created.id);
    }
  } catch (err) {
    toast(err.message);
  }
}

async function deleteList() {
  if (!state.editingListId) return;
  if (!window.confirm('Delete this list and all of its reminders?')) return;
  const id = state.editingListId;
  try {
    await api('/api/lists/' + id, { method: 'DELETE' });
    closeSheet('#list-sheet');
    await loadState();
    if (state.view === id) go('home');
    else render();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Push notifications ---------------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err.message);
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function syncPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    state.subscription = await registration.pushManager.getSubscription();
  } catch {
    state.subscription = null;
  }
  renderSidebar();
  updateNotifyUI();
}

function updateNotifyUI() {
  const enabled = Boolean(state.subscription);
  $('#notify-status').textContent = enabled
    ? 'Notifications are on for this device. You will be notified when a reminder is due.'
    : 'Allow Remember to send a notification when a reminder is due.';
  $('#notify-enable').hidden = enabled;
  $('#notify-test').hidden = !enabled;
  $('#notify-disable').hidden = !enabled;
  $('#notifications-label').textContent = enabled ? 'Notifications On' : 'Notifications';
}

function openNotifySheet() {
  const standalone = window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const hint = $('#notify-hint');
  const enable = $('#notify-enable');

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    hint.hidden = false;
    hint.textContent = 'This browser does not support web push notifications.';
    enable.disabled = true;
  } else if (isIOS && !standalone) {
    hint.hidden = false;
    hint.textContent = 'On iPhone or iPad, notifications only work after adding Remember to your Home Screen: tap Share, then Add to Home Screen, and open it from there.';
    enable.disabled = true;
  } else {
    hint.hidden = true;
    enable.disabled = false;
  }

  updateNotifyUI();
  openSheet('#notify-sheet');
}

async function enableNotifications() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notification permission was not granted');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey),
    });
    await api('/api/push/subscribe', {
      method: 'POST',
      body: { subscription: subscription.toJSON() },
    });
    state.subscription = subscription;
    updateNotifyUI();
    toast('Notifications enabled');
  } catch (err) {
    toast(err.message || 'Could not enable notifications');
  }
}

async function disableNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = state.subscription || await registration.pushManager.getSubscription();
    if (subscription) {
      await api('/api/push/unsubscribe', {
        method: 'POST',
        body: { endpoint: subscription.endpoint },
      });
      await subscription.unsubscribe();
    }
    state.subscription = null;
    updateNotifyUI();
    toast('Notifications turned off');
  } catch (err) {
    toast(err.message);
  }
}

async function sendTestNotification() {
  try {
    const result = await api('/api/push/test', { method: 'POST' });
    if (!result.sent) toast('No device is subscribed for notifications');
    else toast('Test notification sent');
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Sheets ---------------- */

let lastFocused = null;

function syncSheetState() {
  const anyOpen = $$('.sheet').some((sheet) => !sheet.hidden);
  document.body.classList.toggle('sheet-open', anyOpen);
  if (!anyOpen && lastFocused && document.contains(lastFocused)) {
    try { lastFocused.focus({ preventScroll: true }); } catch { /* ignore */ }
    lastFocused = null;
  }
}

function openSheet(selector) {
  if (!$$('.sheet').some((sheet) => !sheet.hidden)) {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  $(selector).hidden = false;
  syncSheetState();
}

function closeSheet(selector) {
  $(selector).hidden = true;
  syncSheetState();
}

function closeTopSheet() {
  const open = $$('.sheet').filter((sheet) => !sheet.hidden);
  if (open.length) open[open.length - 1].hidden = true;
  syncSheetState();
  return open.length > 0;
}

function focusableIn(sheet) {
  return $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', sheet)
    .filter((node) => !node.disabled && node.offsetParent !== null);
}

// Keep Tab inside the topmost sheet (WCAG 2.2 AA): focus wraps instead of
// escaping to the page behind.
function trapSheetTab(event) {
  const open = $$('.sheet').filter((sheet) => !sheet.hidden);
  if (!open.length) return;
  const sheet = open[open.length - 1];
  if (!sheet.contains(event.target)) return;
  const focusable = focusableIn(sheet);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && event.target === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && event.target === last) {
    event.preventDefault();
    first.focus();
  }
}

// Interactive swipe: the card follows the finger, revealing Done on the
// right-swipe side and Delete on the left-swipe side. Releasing past the
// threshold acts (delete still asks first); otherwise the card springs back.
// Links and buttons opt out, and vertical scrolling passes through untouched
// (rows also declare touch-action: pan-y).
let swipe = null;
let lastSwipeEnd = 0;

function swipeContentOf(row) {
  return row ? row.querySelector('.swipe-content') : null;
}

function resetSwipe(row) {
  const content = swipeContentOf(row);
  if (content) {
    content.classList.remove('swiping');
    content.style.transform = '';
  }
}

$('#content').addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) {
    swipe = null;
    return;
  }
  const row = event.target.closest('.reminder');
  if (!row || event.target.closest('a, button, input, textarea, select')) {
    swipe = null;
    return;
  }
  const touch = event.touches[0];
  swipe = {
    id: Number(row.dataset.reminderId),
    row,
    startX: touch.clientX,
    startY: touch.clientY,
    active: false,
  };
}, { passive: true });

$('#content').addEventListener('touchmove', (event) => {
  if (!swipe || event.touches.length !== 1) return;
  if (!document.contains(swipe.row)) {
    swipe = null;
    return;
  }
  const touch = event.touches[0];
  const dx = touch.clientX - swipe.startX;
  const dy = touch.clientY - swipe.startY;
  if (!swipe.active) {
    if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
    swipe.active = true;
    const content = swipeContentOf(swipe.row);
    if (content) content.classList.add('swiping');
  }
  event.preventDefault();
  const content = swipeContentOf(swipe.row);
  if (!content) return;
  const max = Math.min(140, (swipe.row.offsetWidth || 300) * 0.45);
  const clamped = Math.max(-max, Math.min(max, dx));
  content.style.transform = clamped ? `translateX(${clamped}px)` : '';
}, { passive: false });

async function endSwipe(commit) {
  const current = swipe;
  swipe = null;
  if (!current || !current.active) return;
  lastSwipeEnd = Date.now();
  const reminder = state.reminders.find((item) => item.id === current.id);
  if (!reminder || reminder.completed || commit === 0) {
    resetSwipe(current.row);
    return;
  }
  if (commit < 0) {
    // Keep the card parked on Delete while the confirm is up; spring back
    // if the user cancels.
    deleteReminderSwipe(reminder, () => resetSwipe(current.row));
  } else {
    resetSwipe(current.row);
    toggleCompleted(reminder);
  }
}

$('#content').addEventListener('touchend', (event) => {
  if (!swipe || !swipe.active || event.changedTouches.length !== 1) {
    swipe = null;
    return;
  }
  const dx = event.changedTouches[0].clientX - swipe.startX;
  const width = swipe.row.offsetWidth || 300;
  const threshold = Math.min(100, width * 0.35);
  endSwipe(Math.abs(dx) < threshold ? 0 : dx);
}, { passive: true });

$('#content').addEventListener('touchcancel', () => {
  if (swipe && swipe.active) resetSwipe(swipe.row);
  swipe = null;
}, { passive: true });

async function deleteReminderSwipe(reminder, onCancel) {
  const title = reminder.title.length > 60 ? reminder.title.slice(0, 60) + '…' : reminder.title;
  if (!window.confirm(`Delete "${title}"?`)) {
    if (onCancel) onCancel();
    return;
  }
  try {
    await api('/api/reminders/' + reminder.id, { method: 'DELETE' });
    await loadState();
    render();
    toast('Reminder deleted');
  } catch (err) {
    if (onCancel) onCancel();
    toast(err.message);
  }
}

/* ---------------- Theme & settings ---------------- */

const THEME_PREF_KEY = 'theme-preference';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themePreference = localStorage.getItem(THEME_PREF_KEY) || 'auto';

function applyTheme(pref, persist = true) {
  themePreference = ['auto', 'light', 'dark'].includes(pref) ? pref : 'auto';
  if (persist) localStorage.setItem(THEME_PREF_KEY, themePreference);
  const dark = themePreference === 'dark' || (themePreference === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#000000' : '#f5efe6');
  $$('.theme-option-btn').forEach((btn) => {
    const active = btn.dataset.themePref === themePreference;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

async function openSettings() {
  applyTheme(themePreference, false);
  $('#pw-msg').hidden = true;
  $('#settings-msg').hidden = true;
  try {
    Object.assign(state.settings, await api('/api/settings'));
  } catch {
    // Offline: show last-known values.
  }
  const s = state.settings;
  $('#set-density').value = localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  $('#set-default-model').value = ['fixed', 'floating', 'anchored'].includes(s.default_time_model)
    ? s.default_time_model : 'fixed';
  $('#set-default-time').value = s.default_time || '09:00';
  $('#set-repush').checked = s.repush_enabled === '1';
  $('#set-repush-cadence').value = s.repush_cadence_min || '60';
  $('#set-repush-max').value = s.repush_max || '3';
  $('#set-quiet-start').value = s.quiet_start || '23:00';
  $('#set-quiet-end').value = s.quiet_end || '07:00';
  $('#device-zone-label').textContent = s.device_zone
    ? `This device reports ${s.device_zone}${s.device_zone_updated_at ? ` (last synced ${new Date(s.device_zone_updated_at).toLocaleString()})` : ''}. Floating reminders follow it.`
    : 'This device has not reported its time zone yet — open the app once online.';
  $('#token-once').hidden = true;
  $('#token-name').value = '';
  await renderTokenList();
  openSheet('#settings-sheet');
}

function settingsMessage(message, ok = false) {
  const node = $('#settings-msg');
  node.textContent = message;
  node.classList.toggle('ok', ok);
  node.hidden = false;
}

async function saveAppSettings() {
  const density = $('#set-density').value === 'compact' ? 'compact' : 'comfortable';
  localStorage.setItem(DENSITY_KEY, density);
  applyDensity();
  try {
    const result = await api('/api/settings', {
      method: 'POST',
      body: {
        settings: {
          default_time_model: $('#set-default-model').value,
          default_time: $('#set-default-time').value,
          repush_enabled: $('#set-repush').checked ? '1' : '0',
          repush_cadence_min: $('#set-repush-cadence').value,
          repush_max: $('#set-repush-max').value,
          quiet_start: $('#set-quiet-start').value,
          quiet_end: $('#set-quiet-end').value,
        },
      },
    });
    state.settings = result.settings || state.settings;
    settingsMessage('Settings saved', true);
  } catch (err) {
    settingsMessage(err.message);
  }
}

async function renderTokenList() {
  const wrap = $('#token-list');
  wrap.replaceChildren();
  let tokens = [];
  try {
    const data = await api('/api/tokens');
    tokens = data.tokens || [];
  } catch (err) {
    wrap.append(el('p', { class: 'form-msg', text: err.message }));
    return;
  }
  if (!tokens.length) {
    wrap.append(el('p', { class: 'notify-hint', text: 'No tokens yet.' }));
    return;
  }
  for (const token of tokens) {
    const row = el('div', { class: 'token-row' }, [
      el('span', { class: 'token-name', text: token.name || 'token' }),
      el('span', {
        class: 'token-meta',
        text: token.revoked_at
          ? 'revoked'
          : `used ${token.last_used_at ? new Date(token.last_used_at).toLocaleDateString() : 'never'}`,
      }),
    ]);
    if (!token.revoked_at) {
      row.append(el('button', {
        type: 'button',
        class: 'secondary-btn small-btn',
        text: 'Revoke',
        onclick: async () => {
          if (!window.confirm(`Revoke the token "${token.name || 'token'}"? Agents using it stop working immediately.`)) return;
          try {
            await api('/api/tokens/' + token.id + '/revoke', { method: 'POST' });
            await renderTokenList();
            toast('Token revoked');
          } catch (err) {
            toast(err.message);
          }
        },
      }));
    }
    wrap.append(row);
  }
}

async function generateToken() {
  const name = $('#token-name').value.trim() || 'agent';
  try {
    const result = await api('/api/tokens', { method: 'POST', body: { name } });
    $('#token-value').textContent = result.token;
    $('#token-once').hidden = false;
    $('#token-name').value = '';
    await renderTokenList();
  } catch (err) {
    toast(err.message);
  }
}

async function exportBackup() {
  try {
    const res = await fetch('/api/export', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `remember-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Backup downloaded');
  } catch (err) {
    toast(err.message || 'Export failed');
  }
}

function importMessage(message, ok = false) {
  const node = $('#import-msg');
  node.textContent = message;
  node.classList.toggle('ok', ok);
  node.hidden = false;
}

async function importBackupFile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const result = await api('/api/import', { method: 'POST', body: { data } });
    importMessage(
      `Imported ${result.listsAdded} lists and ${result.remindersAdded} reminders ` +
      `(${result.listsSkipped + result.remindersSkipped + result.occurrencesSkipped} skipped as already present).`,
      true
    );
    await loadState();
    render();
  } catch (err) {
    importMessage(err.message);
  }
}

function passwordMessage(message, ok = false) {
  const node = $('#pw-msg');
  node.textContent = message;
  node.classList.toggle('ok', ok);
  node.hidden = false;
}

async function changePassword(event) {
  event.preventDefault();
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  const confirm = $('#pw-confirm').value;
  if (next.length < 8) return passwordMessage('Use at least 8 characters');
  if (next !== confirm) return passwordMessage('New passwords do not match');
  try {
    await api('/api/password', {
      method: 'POST',
      body: { current_password: current, new_password: next, confirm_password: confirm },
    });
    $('#password-form').reset();
    passwordMessage('Password updated', true);
  } catch (err) {
    passwordMessage(err.message);
  }
}

applyTheme(themePreference, false);
darkQuery.addEventListener('change', () => {
  if (themePreference === 'auto') applyTheme('auto', false);
});

/* ---------------- Events ---------------- */

$('#auth-form').addEventListener('submit', submitAuth);

$('#smart-nav').addEventListener('click', (event) => {
  const row = event.target.closest('.nav-row');
  if (row) go(row.dataset.view);
});

$('#new-list-2').addEventListener('click', () => openListSheet(null));
$('#back-btn').addEventListener('click', () => go('home'));
$('#logout-btn').addEventListener('click', logout);
$('#notifications-btn').addEventListener('click', openNotifySheet);
$('#settings-btn').addEventListener('click', openSettings);
$('#password-form').addEventListener('submit', changePassword);
$$('.theme-option-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themePref));
});
$('#notify-enable').addEventListener('click', enableNotifications);
$('#notify-disable').addEventListener('click', disableNotifications);
$('#notify-test').addEventListener('click', sendTestNotification);
$('#settings-save').addEventListener('click', saveAppSettings);
$('#token-generate').addEventListener('click', generateToken);
$('#token-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#token-value').textContent);
    toast('Token copied');
  } catch {
    toast('Copy failed — select the token manually');
  }
});
$('#export-btn').addEventListener('click', exportBackup);
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (event) => {
  importBackupFile(event.target.files[0]);
  event.target.value = '';
});

$('#fab-add').addEventListener('click', () => openEditor(null));
$('#menu-btn').addEventListener('click', toggleSidebar);
$$('.refresh-btn').forEach((btn) => btn.addEventListener('click', refreshState));

function setSearch(value, source) {
  state.search = value.trim();
  if (source !== 'sidebar') $('#search').value = value;
  if (source !== 'main') $('#main-search').value = value;
  if (state.search && state.view === 'home') {
    go('all');
    return;
  }
  render();
}

$('#search').addEventListener('input', (event) => setSearch(event.target.value, 'sidebar'));
$('#main-search').addEventListener('input', (event) => setSearch(event.target.value, 'main'));

$('#main-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('#main-search').blur();
});

$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('#search').blur();
});

$('#editor-form').addEventListener('submit', saveEditor);
$('#e-delete').addEventListener('click', deleteReminder);
$('#e-date-on').addEventListener('change', () => { syncDateTimeRows(); markScheduleManual(); });
$('#e-time-on').addEventListener('change', () => { syncDateTimeRows(); markScheduleManual(); });
$('#e-repeat').addEventListener('change', () => onRepeatChange(true));
$('#e-repeat-interval').addEventListener('change', () => { syncRepeatRows(); markScheduleManual(); });
$('#e-repeat-unit').addEventListener('change', () => { syncRepeatRows(); markScheduleManual(); });
$('#e-model').addEventListener('change', syncModelRows);
$('#e-zone').addEventListener('change', syncModelRows);
$('#e-snooze-btn').addEventListener('click', toggleEditorSnooze);
$('#e-skip-btn').addEventListener('click', skipCurrentOccurrence);
$('#scope-occurrence').addEventListener('click', () => setScope('occurrence'));
$('#scope-series').addEventListener('click', () => setScope('series'));
$('#e-parse-chip').addEventListener('click', clearParse);
$('#e-date').addEventListener('change', () => {
  if (!$('#e-date').value) {
    $('#e-date-on').checked = false;
    $('#e-time-on').checked = false;
    syncDateTimeRows();
  } else {
    markScheduleManual();
  }
});
$('#e-time').addEventListener('change', () => {
  if (!$('#e-time').value) {
    $('#e-time-on').checked = false;
    syncDateTimeRows();
  } else {
    markScheduleManual();
  }
});
$('#e-list').addEventListener('change', updateEditorListVisual);
$('#e-title').addEventListener('input', () => {
  autoGrowTitle();
  scheduleParse();
});
$('#e-notes').addEventListener('input', () => {
  autoGrowNotes();
  renderEditorLinks();
});
$('#list-form').addEventListener('submit', saveList);
$('#l-delete').addEventListener('click', deleteList);

document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) {
    const sheet = closer.closest('.sheet');
    if (sheet) {
      sheet.hidden = true;
      syncSheetState();
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    trapSheetTab(event);
    return;
  }
  if (event.key === 'Escape') {
    if (closeTopSheet()) return;
    if ((document.activeElement === $('#search') || document.activeElement === $('#main-search')) && state.search) {
      setSearch('', 'both');
    }
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (typing) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const target = $('#main-search').offsetParent ? $('#main-search') : $('#search');
    target.focus();
  } else if (event.key === 'n') {
    event.preventDefault();
    openEditor(null);
  }
});

async function refreshOnResume() {
  if (!state.authenticated) return;
  try {
    await loadState();
    render();
  } catch { /* offline — keep showing cached state */ }
  syncDeviceZone();
}

window.addEventListener('hashchange', route);
window.addEventListener('focus', refreshOnResume);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshOnResume();
});

applyDensity();
applySidebar();
boot();
