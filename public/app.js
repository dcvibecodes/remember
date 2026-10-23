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
  view: 'today',
  search: '',
  showCompleted: false,
  editingId: null,
  editingListId: null,
  selectedColor: 'blue',
  csrfToken: null,
  subscription: null,
  lastListId: Number(localStorage.getItem('remember.lastList')) || null,
};

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
  if (state.lastListId && !listById(state.lastListId)) {
    state.lastListId = state.lists[0] ? state.lists[0].id : null;
  }
}

async function refreshState() {
  const btn = $('#refresh-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    await loadState();
    render();
    toast('Refreshed');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
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
  if (raw === 'today' || raw === 'all' || raw === 'completed') return raw;
  return 'today';
}

function route() {
  const view = parseRoute();
  if (view !== state.view) state.showCompleted = false;
  const active = document.activeElement;
  if (active && active.matches('input, textarea, select')) active.blur();
  state.view = view;
  document.body.dataset.screen = view === 'home' ? 'home' : 'detail';
  render();
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
    api('/api/lists/order', { method: 'PUT', body: { ids } }).catch(async (err) => {
      toast(err.message);
      await loadState();
      render();
    });
  };

  drag.onCancel = () => cleanupListDrag();

  grip.setPointerCapture(event.pointerId);
  grip.addEventListener('pointermove', drag.onMove);
  grip.addEventListener('pointerup', drag.onUp);
  grip.addEventListener('pointercancel', drag.onCancel);
}

function renderSidebar() {
  const todayLimit = endOfToday();
  const todayCount = incompleteReminders()
    .filter((reminder) => reminder.due_at && new Date(reminder.due_at) <= todayLimit).length;
  const allCount = incompleteReminders().length;

  $('#count-today').textContent = todayCount ? String(todayCount) : '';
  $('#count-all').textContent = allCount ? String(allCount) : '';

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
      'aria-hidden': 'true',
      html: ICON('grip', 'ic'),
    });
    grip.addEventListener('pointerdown', (event) => startListDrag(event, list, row, grip));
    grip.addEventListener('click', (event) => event.stopPropagation());
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
    const message = state.search
      ? 'No matching reminders'
      : view === 'today'
        ? 'Nothing due today'
        : view === 'completed'
          ? 'No completed reminders yet'
          : 'No reminders yet';
    const emptyIcon = view === 'today' ? 'calendar' : view === 'completed' ? 'done' : 'all';
    content.append(el('div', { class: 'empty' }, [
      el('span', { html: ICON(emptyIcon) }),
      el('p', { text: message }),
    ]));
    if (state.search) return;
  } else {
    const group = el('div', { class: 'reminder-group' });
    for (const reminder of items) group.append(reminderRow(reminder));
    content.append(group);
  }

  if (typeof view === 'number' && completeCount) {
    content.append(el('button', {
      class: 'toggle-completed',
      text: `${state.showCompleted ? 'Hide' : 'Show'} ${completeCount} Completed`,
      onclick: () => {
        state.showCompleted = !state.showCompleted;
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

function reminderRow(reminder) {
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
  if (reminder.urgent) {
    meta.append(el('span', {
      class: 'meta-urgent',
      html: ICON('bell', 'ic') + '<span>Urgent</span>',
    }));
  }

  const body = el('div', { class: 'reminder-body' }, [
    el('div', { class: 'reminder-title', text: reminder.title }),
    meta,
  ]);
  if (reminder.notes) {
    body.append(el('div', { class: 'reminder-notes', text: reminder.notes.split('\n')[0] }));
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

  return el('div', {
    class: 'reminder' + (reminder.completed ? ' done' : ''),
    style: { '--c': color },
    onclick: () => openEditor(reminder.id),
  }, [check, body]);
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
    await api('/api/reminders/' + reminder.id, {
      method: 'PATCH',
      body: { completed: !reminder.completed },
    });
    await loadState();
    render();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- Editor ---------------- */

function syncDateTimeRows() {
  if ($('#e-time-on').checked) $('#e-date-on').checked = true;
  if (!$('#e-date-on').checked) $('#e-time-on').checked = false;
  if ($('#e-date-on').checked && !$('#e-date').value) $('#e-date').value = localDateValue(new Date());
  if ($('#e-time-on').checked && !$('#e-time').value) $('#e-time').value = '09:00';
  $('#e-date-row').hidden = !$('#e-date-on').checked;
  $('#e-time-row').hidden = !$('#e-time-on').checked;
}

function updateEditorListVisual() {
  const list = listById(Number($('#e-list').value));
  $('#e-list-icon').style.setProperty('--c', colorVar(list ? list.color : 'blue'));
  $('#e-list-value').textContent = list ? list.name : '';
}

function resetDetails() {
  $('#details-panel').hidden = true;
  $('#details-toggle').classList.remove('open');
  $('#details-toggle').setAttribute('aria-expanded', 'false');
}

function openEditor(id) {
  const reminder = id ? state.reminders.find((item) => item.id === id) : null;
  if (!state.lists.length) {
    toast('Create a list first');
    openListSheet(null);
    return;
  }

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

  $('#e-completed').checked = Boolean(reminder && reminder.completed);
  $('#details-section').hidden = false;
  $('#e-delete').hidden = !reminder;
  resetDetails();

  openSheet('#editor');
  setTimeout(() => $('#e-title').focus(), 80);
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
      dueAt = new Date(year, month - 1, day, 9, 0).toISOString();
    }
  }

  const body = {
    title,
    notes: $('#e-notes').value,
    list_id: listId,
    due_at: dueAt,
    has_time: hasTime,
    urgent: $('#e-urgent').checked,
  };
  body.completed = $('#e-completed').checked;

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

function openListSheet(list) {
  state.editingListId = list ? list.id : null;
  state.selectedColor = list ? list.color : 'blue';
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

function syncSheetState() {
  document.body.classList.toggle('sheet-open', $$('.sheet').some((sheet) => !sheet.hidden));
}

function openSheet(selector) {
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

function openSettings() {
  applyTheme(themePreference, false);
  $('#pw-msg').hidden = true;
  openSheet('#settings-sheet');
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

$('#new-list').addEventListener('click', () => openListSheet(null));
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

$('#fab-add').addEventListener('click', () => openEditor(null));
$('#refresh-btn').addEventListener('click', refreshState);

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
$('#e-date-on').addEventListener('change', syncDateTimeRows);
$('#e-time-on').addEventListener('change', syncDateTimeRows);
$('#e-date').addEventListener('change', () => {
  if (!$('#e-date').value) {
    $('#e-date-on').checked = false;
    $('#e-time-on').checked = false;
    syncDateTimeRows();
  }
});
$('#e-time').addEventListener('change', () => {
  if (!$('#e-time').value) {
    $('#e-time-on').checked = false;
    syncDateTimeRows();
  }
});
$('#e-list').addEventListener('change', updateEditorListVisual);
$('#details-toggle').addEventListener('click', () => {
  const panel = $('#details-panel');
  const open = panel.hidden;
  panel.hidden = !open;
  $('#details-toggle').classList.toggle('open', open);
  $('#details-toggle').setAttribute('aria-expanded', String(open));
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

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  if (state.authenticated) {
    loadState().then(render).catch(() => {});
  }
});

boot();
