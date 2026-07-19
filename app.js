'use strict';

const PROJECTS = [
  { name: '本業',     color: '#4CAF50' },
  { name: '試験勉強', color: '#2196F3' },
  { name: '家事',     color: '#FF9800' },
  { name: 'ジム',     color: '#F44336' },
  { name: '自由時間', color: '#00BCD4' },
  { name: '遊ぶ',     color: '#E91E63' },
  { name: '移動',     color: '#607D8B' },
  { name: '風呂',     color: '#29B6F6' },
  { name: '支度',     color: '#AB47BC' },
  { name: '学校',     color: '#FF7043' },
];

const SLOT_COUNT = 84;
const SLOT_START_MIN = 300;
const STORAGE_KEY    = 'timeTracker.v2';
const TOKEN_KEY      = 'timeTracker.ghToken';
const BONUS_KEY      = 'timeTracker.bonusShown';
const BONUS_PROJECT  = '試験勉強';
const BONUS_THRESHOLD = 10 * 60; // 10時間（分）
const REPO_OWNER = 'culapy1995';
const REPO_NAME  = 'time-tracker-2';
const DATA_PATH  = 'data.json';

// 8:45〜17:45 = slot 15〜50
const HONGYOU_START = 15;
const HONGYOU_END   = 50;

function slotToLabel(slot) {
  const total = SLOT_START_MIN + slot * 15;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateStr(d);
}

const DAYS = ['日', '月', '火', '水', '木', '金', '土'];

function fmtDate(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtDateDay(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日（${DAYS[d.getDay()]}）`;
}

function fmtHM(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}時間${m}分`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}
function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
let selectedProject = PROJECTS[0];
let dayOffset = 0;
let isPainting = false;
let paintMode = null;
let weekOffset = 0;
let monthOffset = 0;
let ghToken = localStorage.getItem(TOKEN_KEY) || '';
let dataFileSha = null;
let saveTimer = null;
let browseMode = false;
let currentTabName = 'timeline';

// ── シークレットボーナス ────────────────────────────────

function calcProjectTotal(projectName) {
  let slots = 0;
  Object.values(state).forEach(day => {
    if (!day) return;
    Object.values(day).forEach(p => { if (p === projectName) slots++; });
  });
  return slots * 15;
}

function checkBonus() {
  if (localStorage.getItem(BONUS_KEY)) return;
  const totalMin = calcProjectTotal(BONUS_PROJECT);
  if (totalMin >= BONUS_THRESHOLD) {
    localStorage.setItem(BONUS_KEY, '1');
    setTimeout(() => {
      document.getElementById('bonusModal').classList.remove('hidden');
    }, 800);
  }
}

document.getElementById('bonusCloseBtn').addEventListener('click', () => {
  document.getElementById('bonusModal').classList.add('hidden');
});

// ── Undo ───────────────────────────────────────────────

const undoStack = [];
const UNDO_MAX = 30;

function pushUndo() {
  const key = dateKey(dayOffset);
  undoStack.push({ key, slots: JSON.stringify(state[key] ?? null) });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  document.getElementById('undoBtn').disabled = false;
}

function undo() {
  if (!undoStack.length) return;
  const { key, slots } = undoStack.pop();
  if (slots === 'null') {
    delete state[key];
  } else {
    state[key] = JSON.parse(slots);
  }
  saveLocal();
  renderTimeline();
  if (!undoStack.length) document.getElementById('undoBtn').disabled = true;
}

// ── GitHub API ──────────────────────────────────────────

function apiHeaders() {
  return {
    'Authorization': `token ${ghToken}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

async function ghFetchData() {
  showSync('同期中…');
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}`,
      { headers: apiHeaders() }
    );
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    dataFileSha = json.sha;
    const raw = atob(json.content.replace(/\n/g, ''));
    const decoded = JSON.parse(decodeURIComponent(escape(raw)));
    state = decoded;
    saveLocal();
    showSync('同期完了', true);
    return true;
  } catch (e) {
    showSync('同期失敗', false, true);
    return false;
  }
}

async function ghSaveData() {
  if (!ghToken) return;
  showSync('保存中…');
  try {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    const body = {
      message: 'update time tracker data',
      content,
      ...(dataFileSha ? { sha: dataFileSha } : {}),
    };
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}`,
      { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) }
    );
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    dataFileSha = json.content.sha;
    showSync('保存完了', true);
  } catch (e) {
    showSync('保存失敗', false, true);
  }
}

function scheduleSave() {
  saveLocal();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ghSaveData(), 2000);
}

// ── 同期ステータス表示 ──────────────────────────────────

const syncEl = document.getElementById('syncStatus');
let syncHideTimer = null;

function showSync(msg, success, error) {
  syncEl.textContent = msg;
  syncEl.className = 'sync-status';
  if (success) syncEl.classList.add('sync-ok');
  if (error) syncEl.classList.add('sync-err');
  syncEl.classList.remove('hidden');
  clearTimeout(syncHideTimer);
  if (success || error) {
    syncHideTimer = setTimeout(() => syncEl.classList.add('hidden'), 2500);
  }
}

// ── トークン設定モーダル ────────────────────────────────

const tokenModal = document.getElementById('tokenModal');
const tokenInput = document.getElementById('tokenInput');
const tokenSave  = document.getElementById('tokenSave');
const tokenError = document.getElementById('tokenError');

async function validateAndSaveToken(token) {
  tokenSave.disabled = true;
  tokenSave.textContent = '確認中…';
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}`,
      { headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (!res.ok) throw new Error();
    ghToken = token;
    localStorage.setItem(TOKEN_KEY, token);
    tokenModal.classList.add('hidden');
    const json = await res.json();
    dataFileSha = json.sha;
    const raw = atob(json.content.replace(/\n/g, ''));
    const decoded = JSON.parse(decodeURIComponent(escape(raw)));
    state = decoded;
    saveLocal();
    renderTimeline();
    showSync('GitHub連携完了', true);
  } catch (e) {
    tokenError.classList.remove('hidden');
    tokenSave.disabled = false;
    tokenSave.textContent = '保存して接続';
  }
}

document.getElementById('saveBtn').addEventListener('click', () => ghSaveData());

document.getElementById('undoBtn').addEventListener('click', () => undo());

document.getElementById('cursorBtn').addEventListener('click', () => {
  browseMode = !browseMode;
  document.getElementById('cursorBtn').classList.toggle('active', browseMode);
  if (browseMode) {
    document.querySelectorAll('.proj-btn').forEach((b) => b.classList.remove('selected'));
  } else {
    selectedProject = PROJECTS[0];
    document.querySelectorAll('.proj-btn')[0].classList.add('selected');
  }
});

tokenSave.addEventListener('click', () => {
  const t = tokenInput.value.trim();
  if (!t) return;
  tokenError.classList.add('hidden');
  validateAndSaveToken(t);
});

// ── DOM ────────────────────────────────────────────────

const projectSelector = document.getElementById('projectSelector');
const dateNav    = document.getElementById('dateNav');
const timeline   = document.getElementById('timeline');
const dateLabel  = document.getElementById('dateLabel');
const dayTotalEl = document.getElementById('dayTotal');
const viewTimeline = document.getElementById('view-timeline');
const viewWeek   = document.getElementById('view-week');
const viewMonth  = document.getElementById('view-month');
const weekLabelEl  = document.getElementById('weekLabel');
const monthLabelEl = document.getElementById('monthLabel');

function buildProjectSelector() {
  PROJECTS.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'proj-btn' + (p === selectedProject ? ' selected' : '');
    btn.textContent = p.name;
    btn.style.backgroundColor = p.color;
    btn.addEventListener('click', () => {
      selectedProject = p;
      browseMode = false;
      document.getElementById('cursorBtn').classList.remove('active');
      document.querySelectorAll('.proj-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    projectSelector.appendChild(btn);
  });
}

function buildTimeline() {
  timeline.innerHTML = '';
  const hourCount = Math.ceil(SLOT_COUNT / 4);
  for (let h = 0; h < hourCount; h++) {
    const group = document.createElement('div');
    group.className = 'hour-group';

    const label = document.createElement('span');
    label.className = 'hour-label';
    label.textContent = slotToLabel(h * 4);
    group.appendChild(label);

    const halfLabel = document.createElement('span');
    halfLabel.className = 'half-hour-label';
    halfLabel.textContent = slotToLabel(h * 4 + 2);
    group.appendChild(halfLabel);

    for (let s = 0; s < 4; s++) {
      const i = h * 4 + s;
      if (i >= SLOT_COUNT) break;

      const row = document.createElement('div');
      row.className = 'slot-row';
      row.dataset.slot = i;

      const timeEl = document.createElement('span');
      timeEl.className = 'slot-time';

      const block = document.createElement('div');
      block.className = 'slot-block';

      const labelZone = document.createElement('div');
      labelZone.className = 'slot-label-zone';

      row.appendChild(timeEl);
      row.appendChild(block);
      row.appendChild(labelZone);
      group.appendChild(row);
    }
    timeline.appendChild(group);
  }

  timeline.addEventListener('touchstart', onTouchStart, { passive: false });
  timeline.addEventListener('touchmove', onTouchMove, { passive: false });
  timeline.addEventListener('touchend', onTouchEnd);
  timeline.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function getSlotFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (!el.closest('.slot-block')) return null;
  const row = el.closest('.slot-row');
  if (!row) return null;
  return parseInt(row.dataset.slot);
}

function paintSlot(slotIndex) {
  if (slotIndex == null || slotIndex < 0 || slotIndex >= SLOT_COUNT) return;
  const key = dateKey(dayOffset);
  if (!state[key]) state[key] = {};
  if (paintMode === 'erase') {
    delete state[key][slotIndex];
  } else {
    state[key][slotIndex] = selectedProject.name;
  }
  renderSlot(slotIndex);
  renderDayTotal();
}

function renderSlot(i) {
  const key = dateKey(dayOffset);
  const row = timeline.querySelector(`[data-slot="${i}"]`);
  if (!row) return;
  const block = row.querySelector('.slot-block');
  const label = row.querySelector('.slot-label-zone');
  const pName = state[key] && state[key][i];
  if (pName) {
    const p = PROJECTS.find((x) => x.name === pName);
    block.style.backgroundColor = p ? p.color : '#ccc';
    if (label) label.textContent = pName;
  } else {
    block.style.backgroundColor = '';
    if (label) label.textContent = '';
  }
}

function autoFillHongyou(key, d) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return;
  if (state[key] !== undefined) return;
  state[key] = {};
  for (let i = HONGYOU_START; i <= HONGYOU_END; i++) {
    state[key][i] = '本業';
  }
  scheduleSave();
}

function renderTimeline() {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const key = dateKey(dayOffset);
  if (dayOffset >= 0) autoFillHongyou(key, d);
  dateLabel.textContent = dayOffset === 0
    ? `今日（${fmtDateDay(d)}）`
    : fmtDateDay(d);
  for (let i = 0; i < SLOT_COUNT; i++) renderSlot(i);
  renderDayTotal();
}

function renderDayTotal() {
  const key = dateKey(dayOffset);
  const slots = state[key] || {};
  dayTotalEl.textContent = fmtHM(Object.keys(slots).length * 15);
  renderMiniDayChart(slots);
}

function fmtHMshort(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function renderMiniDayChart(slots) {
  const chart = document.getElementById('miniDayChart');
  if (!chart) return;
  const key = dateKey(dayOffset);
  if (!slots) slots = state[key] || {};
  const totals = {};
  Object.values(slots).forEach((pName) => {
    totals[pName] = (totals[pName] || 0) + 1;
  });
  const coloredCount = Object.values(totals).reduce((a, b) => a + b, 0);
  const otherCount = state[key] !== undefined ? Math.max(0, SLOT_COUNT - coloredCount) : 0;
  const maxCount = Math.max(1, ...PROJECTS.map((p) => totals[p.name] || 0), otherCount);
  chart.innerHTML = '';
  PROJECTS.forEach((p) => {
    const count = totals[p.name] || 0;
    if (count === 0) return;
    const row = document.createElement('div');
    row.className = 'mini-bar-row';
    row.innerHTML = `
      <span class="mini-bar-label">${p.name}</span>
      <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${(count / maxCount) * 100}%;background:${p.color}"></div></div>
      <span class="mini-bar-value">${fmtHMshort(count * 15)}</span>`;
    chart.appendChild(row);
  });
  if (otherCount > 0) {
    const row = document.createElement('div');
    row.className = 'mini-bar-row';
    row.innerHTML = `
      <span class="mini-bar-label other-label">その他</span>
      <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${(otherCount / maxCount) * 100}%;background:#B0BEC5"></div></div>
      <span class="mini-bar-value">${fmtHMshort(otherCount * 15)}</span>`;
    chart.appendChild(row);
  }
}

function startPaint(slot) {
  if (slot == null) return;
  if (browseMode) return;
  pushUndo();
  isPainting = true;
  const key = dateKey(dayOffset);
  const existing = state[key] && state[key][slot];
  paintMode = existing === selectedProject.name ? 'erase' : 'fill';
  paintSlot(slot);
}

function onTouchStart(e) {
  const t = e.touches[0];
  const slot = getSlotFromPoint(t.clientX, t.clientY);
  if (slot == null) return;
  e.preventDefault();
  startPaint(slot);
}
function onTouchMove(e) {
  if (!isPainting) return;
  e.preventDefault();
  const t = e.touches[0];
  paintSlot(getSlotFromPoint(t.clientX, t.clientY));
}
function onTouchEnd() {
  isPainting = false;
  saveLocal();
  checkBonus();
}

function onMouseDown(e) {
  startPaint(getSlotFromPoint(e.clientX, e.clientY));
}
function onMouseMove(e) {
  if (!isPainting) return;
  paintSlot(getSlotFromPoint(e.clientX, e.clientY));
}
function onMouseUp() {
  if (!isPainting) return;
  isPainting = false;
  saveLocal();
}

// ── タブ切り替え ────────────────────────────────────────

function switchTab(viewName) {
  if (gachaOpen) closeGacha(true);
  currentTabName = viewName;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === viewName);
  });
  viewTimeline.classList.toggle('hidden', viewName !== 'timeline');
  viewWeek.classList.toggle('hidden', viewName !== 'week');
  viewMonth.classList.toggle('hidden', viewName !== 'month');
  dateNav.classList.toggle('hidden', viewName !== 'timeline');
  document.getElementById('miniDayChart').classList.toggle('hidden', viewName !== 'timeline');
  if (viewName === 'week') { renderWeek(); maybeShowMissionModal('week'); }
  else if (viewName === 'month') { renderMonth(); maybeShowMissionModal('month'); }
  else renderTimeline();
}

// ── スワイプでタブ切り替え ──────────────────────────────

const TAB_ORDER = ['timeline', 'week', 'month'];
let swipeStartX = null, swipeStartY = null, swipeTarget = null;

document.addEventListener('touchstart', (e) => {
  swipeStartX = e.touches[0].clientX;
  swipeStartY = e.touches[0].clientY;
  swipeTarget = e.target;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (swipeStartX === null) return;
  const dx = e.changedTouches[0].clientX - swipeStartX;
  const dy = e.changedTouches[0].clientY - swipeStartY;
  swipeStartX = null;
  if (gachaOpen) return;
  if (swipeTarget && swipeTarget.closest('.slot-block')) return;
  if (swipeTarget && swipeTarget.closest('.egg-carousel')) return;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const idx = TAB_ORDER.indexOf(currentTabName);
  if (dx < 0) {
    switchTab(TAB_ORDER[(idx + 1) % 3]);
  } else {
    switchTab(TAB_ORDER[(idx + 2) % 3]);
  }
}, { passive: true });

// ── 週グラフ ────────────────────────────────────────────

function startOfWeekDate(wOffset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + wOffset * 7);
  return d;
}

function renderWeek() {
  const ws = startOfWeekDate(weekOffset);
  const we = new Date(ws);
  we.setDate(ws.getDate() + 6);
  const rangeStr = `${fmtDate(ws)}〜${fmtDate(we)}`;
  if (weekOffset === 0) {
    weekLabelEl.innerHTML = `今週<br><span class="week-range">（${rangeStr}）</span>`;
  } else {
    weekLabelEl.textContent = rangeStr;
  }

  const totals = {};
  PROJECTS.forEach((p) => (totals[p.name] = 0));
  let totalTrackedSlots = 0;

  for (let d = 0; d < 7; d++) {
    const day = new Date(ws);
    day.setDate(ws.getDate() + d);
    const key = localDateStr(day);
    const slots = state[key];
    if (slots === undefined) continue;
    totalTrackedSlots += SLOT_COUNT;
    Object.values(slots).forEach((pName) => {
      if (totals[pName] !== undefined) totals[pName] += 15;
    });
  }

  const coloredMin = Object.values(totals).reduce((a, b) => a + b, 0);
  const otherMin = Math.max(0, totalTrackedSlots * 15 - coloredMin);
  const max = Math.max(1, ...Object.values(totals), otherMin);

  const chart = document.getElementById('weekChart');
  chart.innerHTML = '';
  let weekTotal = 0;
  PROJECTS.forEach((p) => {
    const min = totals[p.name] || 0;
    weekTotal += min;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label">${p.name}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(min / max) * 100}%;background:${p.color}"></div></div>
      <span class="bar-value">${fmtHM(min)}</span>`;
    chart.appendChild(row);
  });

  if (otherMin > 0) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label other-label">その他</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(otherMin / max) * 100}%;background:#B0BEC5"></div></div>
      <span class="bar-value">${fmtHM(otherMin)}</span>`;
    chart.appendChild(row);
  }

  document.getElementById('weekTotal').textContent = fmtHM(weekTotal);
  renderMissionSection('week');
}

// ── 月グラフ ────────────────────────────────────────────

function renderMonth() {
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + monthOffset);
  base.setHours(0, 0, 0, 0);

  const m = base.getMonth() + 1;
  monthLabelEl.textContent = monthOffset === 0 ? `今月（${m}月）` : `${m}月`;

  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const totals = {};
  PROJECTS.forEach((p) => (totals[p.name] = 0));
  let totalTrackedSlots = 0;

  for (let d = 0; d < daysInMonth; d++) {
    const day = new Date(base);
    day.setDate(d + 1);
    const key = localDateStr(day);
    const slots = state[key];
    if (slots === undefined) continue;
    totalTrackedSlots += SLOT_COUNT;
    Object.values(slots).forEach((pName) => {
      if (totals[pName] !== undefined) totals[pName] += 15;
    });
  }

  const coloredMin = Object.values(totals).reduce((a, b) => a + b, 0);
  const otherMin = Math.max(0, totalTrackedSlots * 15 - coloredMin);
  const max = Math.max(1, ...Object.values(totals), otherMin);

  const chart = document.getElementById('monthChart');
  chart.innerHTML = '';
  let monthTotal = 0;
  PROJECTS.forEach((p) => {
    const min = totals[p.name] || 0;
    monthTotal += min;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label">${p.name}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(min / max) * 100}%;background:${p.color}"></div></div>
      <span class="bar-value">${fmtHM(min)}</span>`;
    chart.appendChild(row);
  });

  if (otherMin > 0) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label other-label">その他</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(otherMin / max) * 100}%;background:#B0BEC5"></div></div>
      <span class="bar-value">${fmtHM(otherMin)}</span>`;
    chart.appendChild(row);
  }

  document.getElementById('monthTotal').textContent = fmtHM(monthTotal);
  renderMissionSection('month');
}

// ── イベントリスナー ────────────────────────────────────

document.getElementById('prevDay').addEventListener('click', () => { dayOffset--; renderTimeline(); });
document.getElementById('nextDay').addEventListener('click', () => { if (dayOffset < 0) { dayOffset++; renderTimeline(); } });
document.getElementById('prevWeek').addEventListener('click', () => { weekOffset--; renderWeek(); });
document.getElementById('nextWeek').addEventListener('click', () => { if (weekOffset < 0) { weekOffset++; renderWeek(); } });
document.getElementById('prevMonth').addEventListener('click', () => { monthOffset--; renderMonth(); });
document.getElementById('nextMonth').addEventListener('click', () => { if (monthOffset < 0) { monthOffset++; renderMonth(); } });

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.view));
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ghToken) {
    ghFetchData().then((ok) => {
      if (!ok) return;
      if (gachaOpen) { renderGachaPage(); return; }
      if (currentTabName === 'week') { renderWeek(); maybeShowMissionModal('week'); }
      else if (currentTabName === 'month') { renderMonth(); maybeShowMissionModal('month'); }
      else renderTimeline();
    });
  }
});

// ── シークレットミッション ─────────────────────────────

const GACHA_KEY = 'timeTracker.gacha.v1';

// mode: 'gte' = 目標時間以上で達成（現在はすべてこのタイプ）
// 判定は表示中の週/月に対して行い、週毎・月毎にリセットされる。
// ★ project: の値は友達サイトの記録項目名（試験勉強／学校／家事）に合わせてある ★

// 週ビュー用ミッション（週毎にリセット）
const MISSION_DEFS_WEEK = [
  { id: 'shikaku-10', project: '試験勉強', hours: 10, mode: 'gte', tickets: 1 },
  { id: 'shikaku-15', project: '試験勉強', hours: 15, mode: 'gte', tickets: 1 },
  { id: 'shikaku-20', project: '試験勉強', hours: 20, mode: 'gte', tickets: 1 },
  { id: 'shikaku-25', project: '試験勉強', hours: 25, mode: 'gte', tickets: 1 },
  { id: 'shikaku-30', project: '試験勉強', hours: 30, mode: 'gte', tickets: 1 },
  { id: 'shikaku-32', project: '試験勉強', hours: 32, mode: 'gte', tickets: 1 },
  { id: 'shikaku-34', project: '試験勉強', hours: 34, mode: 'gte', tickets: 1 },
  { id: 'shikaku-35', project: '試験勉強', hours: 35, mode: 'gte', tickets: 1 },
  { id: 'shikaku-36', project: '試験勉強', hours: 36, mode: 'gte', tickets: 1 },
  { id: 'shikaku-37', project: '試験勉強', hours: 37, mode: 'gte', tickets: 1 },
  { id: 'shikaku-38', project: '試験勉強', hours: 38, mode: 'gte', tickets: 1 },
  { id: 'shikaku-39', project: '試験勉強', hours: 39, mode: 'gte', tickets: 1 },
  { id: 'shikaku-40', project: '試験勉強', hours: 40, mode: 'gte', tickets: 1 },
  { id: 'gakko-10',   project: '学校',     hours: 10, mode: 'gte', tickets: 1 },
  { id: 'gakko-20',   project: '学校',     hours: 20, mode: 'gte', tickets: 1 },
  { id: 'gakko-30',   project: '学校',     hours: 30, mode: 'gte', tickets: 1 },
  { id: 'kaji-15',    project: '家事',     hours: 15, mode: 'gte', tickets: 1 },
  { id: 'kaji-30',    project: '家事',     hours: 30, mode: 'gte', tickets: 1 },
];

// 月ビュー用ミッション（月毎にリセット）
const MISSION_DEFS_MONTH = [
  { id: 'shikaku-m-20', project: '試験勉強', hours: 20, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-30', project: '試験勉強', hours: 30, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-40', project: '試験勉強', hours: 40, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-50', project: '試験勉強', hours: 50, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-60', project: '試験勉強', hours: 60, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-65', project: '試験勉強', hours: 65, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-70', project: '試験勉強', hours: 70, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-72', project: '試験勉強', hours: 72, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-74', project: '試験勉強', hours: 74, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-76', project: '試験勉強', hours: 76, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-78', project: '試験勉強', hours: 78, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-80', project: '試験勉強', hours: 80, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-81', project: '試験勉強', hours: 81, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-82', project: '試験勉強', hours: 82, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-83', project: '試験勉強', hours: 83, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-84', project: '試験勉強', hours: 84, mode: 'gte', tickets: 1 },
  { id: 'shikaku-m-85', project: '試験勉強', hours: 85, mode: 'gte', tickets: 1 },
  { id: 'gakko-m-20',   project: '学校',     hours: 20, mode: 'gte', tickets: 1 },
  { id: 'gakko-m-30',   project: '学校',     hours: 30, mode: 'gte', tickets: 1 },
  { id: 'gakko-m-40',   project: '学校',     hours: 40, mode: 'gte', tickets: 1 },
  { id: 'gakko-m-50',   project: '学校',     hours: 50, mode: 'gte', tickets: 1 },
  { id: 'kaji-m-15',    project: '家事',     hours: 15, mode: 'gte', tickets: 1 },
  { id: 'kaji-m-30',    project: '家事',     hours: 30, mode: 'gte', tickets: 1 },
  { id: 'kaji-m-40',    project: '家事',     hours: 40, mode: 'gte', tickets: 1 },
  { id: 'kaji-m-50',    project: '家事',     hours: 50, mode: 'gte', tickets: 1 },
];

function missionDefsFor(period) {
  return period === 'month' ? MISSION_DEFS_MONTH : MISSION_DEFS_WEEK;
}

function loadGacha() {
  try {
    const r = localStorage.getItem(GACHA_KEY);
    if (r) {
      const g = JSON.parse(r);
      return { tickets: g.tickets || 0, claimed: g.claimed || [], achieved: g.achieved || [], prizes: g.prizes || [] };
    }
  } catch (e) {}
  return { tickets: 0, claimed: [], achieved: [], prizes: [] };
}
function saveGacha() { localStorage.setItem(GACHA_KEY, JSON.stringify(gacha)); }

let gacha = loadGacha();

// 表示中の週/月に含まれる日付キー一覧
function periodDayKeys(period, offset) {
  const keys = [];
  if (period === 'week') {
    const ws = startOfWeekDate(offset);
    for (let i = 0; i < 7; i++) {
      const d = new Date(ws); d.setDate(ws.getDate() + i);
      keys.push(localDateStr(d));
    }
  } else {
    const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + offset); base.setHours(0, 0, 0, 0);
    const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    for (let i = 0; i < dim; i++) {
      const d = new Date(base); d.setDate(i + 1);
      keys.push(localDateStr(d));
    }
  }
  return keys;
}

// 表示中の週/月を一意に識別するキー（受取記録・リセットの単位）
function periodKeyStr(period, offset) {
  if (period === 'week') return localDateStr(startOfWeekDate(offset));
  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + offset);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;
}

// 表示中の週/月におけるプロジェクト合計（分）
function projectMinInPeriod(project, period, offset) {
  let c = 0;
  periodDayKeys(period, offset).forEach((k) => {
    const slots = state[k];
    if (!slots) return;
    Object.values(slots).forEach((n) => { if (n === project) c++; });
  });
  return c * 15;
}

// 表示中の週/月に対して達成しているか（週毎・月毎で判定＝リセットされる）
// lte（〜以下）は、そのプロジェクトを1分以上使った上で閾値以下のときだけ達成（0時間＝未使用は対象外）
function isAchieved(ms, period, offset) {
  const min = projectMinInPeriod(ms.project, period, offset);
  return ms.mode === 'lte' ? (min > 0 && min <= ms.hours * 60) : min >= ms.hours * 60;
}

function claimKey(ms, period, offset) {
  return `${period}:${periodKeyStr(period, offset)}:${ms.id}`;
}

function missionText(ms, masked) {
  const num = masked ? '◯'.repeat(String(ms.hours).length) : String(ms.hours);
  return ms.mode === 'lte'
    ? `${ms.project}が${num}時間以下だった`
    : `${ms.project}を${num}時間達成！`;
}

function unclaimedAchievedFor(period, offset) {
  return missionDefsFor(period).filter((ms) =>
    !gacha.claimed.includes(claimKey(ms, period, offset)) && isAchieved(ms, period, offset));
}

function renderMissionSection(period) {
  const list = document.getElementById('missionList-' + period);
  if (!list) return;
  const offset = period === 'week' ? weekOffset : monthOffset;
  list.innerHTML = '';
  missionDefsFor(period).forEach((ms) => {
    const achieved = isAchieved(ms, period, offset);
    const claimed = gacha.claimed.includes(claimKey(ms, period, offset));
    const item = document.createElement('div');
    item.className = 'mission-item' + (achieved ? (claimed ? ' claimed' : ' pending') : '');
    const badge = achieved && !claimed ? '<span class="mission-badge">【受取待ち】</span>' : '';
    item.innerHTML =
      `<span class="mission-check">${achieved ? '✅' : '☐'}</span>` +
      `<span class="mission-text">${missionText(ms, false)}</span>${badge}`;
    if (achieved && !claimed) item.addEventListener('click', () => maybeShowMissionModal(period));
    list.appendChild(item);
  });
  const linkTickets = document.getElementById('gachaLinkTickets-' + period);
  if (linkTickets) linkTickets.textContent = gacha.tickets > 0 ? `🎫×${gacha.tickets}` : '';
}

let missionModalTimer = null;
let modalPeriod = 'week';
let modalOffset = 0;

function maybeShowMissionModal(period) {
  const offset = period === 'week' ? weekOffset : monthOffset;
  const unclaimed = unclaimedAchievedFor(period, offset);
  if (!unclaimed.length) return;
  modalPeriod = period;
  modalOffset = offset;
  const listEl = document.getElementById('missionModalList');
  listEl.innerHTML = '';
  unclaimed.forEach((ms) => {
    const div = document.createElement('div');
    div.className = 'mission-modal-item';
    div.textContent = `✅ ${missionText(ms, false)}（${period === 'week' ? '週' : '月'}）`;
    listEl.appendChild(div);
  });
  const total = unclaimed.reduce((a, ms) => a + ms.tickets, 0);
  document.getElementById('missionModalReward').textContent = `🎫 ガチャ券 ×${total}`;
  clearTimeout(missionModalTimer);
  missionModalTimer = setTimeout(() => {
    if (!unclaimedAchievedFor(modalPeriod, modalOffset).length) return;
    document.getElementById('missionModal').classList.remove('hidden');
  }, 400);
}

function claimMissions() {
  clearTimeout(missionModalTimer);
  unclaimedAchievedFor(modalPeriod, modalOffset).forEach((ms) => {
    gacha.claimed.push(claimKey(ms, modalPeriod, modalOffset));
    gacha.tickets += ms.tickets;
  });
  saveGacha();
  document.getElementById('missionModal').classList.add('hidden');
  if (gachaOpen) renderGachaPage();
  else if (currentTabName === 'week') renderMissionSection('week');
  else if (currentTabName === 'month') renderMissionSection('month');
}

// ── ガチャ ──────────────────────────────────────────────

const PRIZES = [
  { star: 1,  name: 'ハズレ',               emoji: '💨' },
  { star: 2,  name: '駄菓子',               emoji: '🍬' },
  { star: 3,  name: 'ジュース',             emoji: '🧃' },
  { star: 4,  name: 'コンビニアイス',       emoji: '🍦' },
  { star: 5,  name: '31アイスクリーム',     emoji: '🍨' },
  { star: 6,  name: 'コメダ珈琲',           emoji: '☕' },
  { star: 7,  name: 'ランチ券',             emoji: '🍝' },
  { star: 8,  name: '晩御飯券（お酒なし）', emoji: '🍽️' },
  { star: 9,  name: '飲み会券',             emoji: '🍻' },
  { star: 10, name: '倉本からの祝福の言葉', emoji: '👑' },
];

const GACHA_EGGS = [
  { tier: 1, cost: 1,  name: 'ノーマルたまご', hint: '⭐️の高い景品は出にくい…',
    weights: [50, 25, 12, 6, 3, 2, 1, 0.7, 0.25, 0.05] },
  { tier: 2, cost: 5,  name: 'スーパーたまご', hint: 'バランス型！',
    weights: [20, 20, 18, 15, 11, 7, 4, 3, 1.5, 0.5] },
  { tier: 3, cost: 10, name: 'ウルトラたまご', hint: '⭐️の高い景品が出やすい！',
    weights: [5, 8, 12, 15, 17, 15, 12, 8, 6, 2] },
];

let gachaOpen = false;
let gachaReturnView = 'week';
let currentGachaTab = 'draw';
let activeEggIdx = 0;
let eggCarouselBuilt = false;
let isDrawing = false;
const animTimers = [];

function openGacha() {
  gachaOpen = true;
  gachaReturnView = currentTabName;
  document.querySelector('.app-header').classList.add('hidden');
  viewTimeline.classList.add('hidden');
  viewWeek.classList.add('hidden');
  viewMonth.classList.add('hidden');
  document.getElementById('view-gacha').classList.remove('hidden');
  document.querySelector('.fab-group').classList.add('hidden');
  buildEggCarousel();
  renderGachaPage();
}

function closeGacha(silent) {
  gachaOpen = false;
  document.getElementById('view-gacha').classList.add('hidden');
  document.querySelector('.app-header').classList.remove('hidden');
  document.querySelector('.fab-group').classList.remove('hidden');
  if (!silent) switchTab(gachaReturnView || 'week');
}

function renderGachaPage() {
  document.getElementById('gachaTicketCount').textContent = gacha.tickets;
  document.querySelectorAll('.gacha-subtab').forEach((t) => {
    t.classList.toggle('active', t.dataset.gtab === currentGachaTab);
  });
  document.getElementById('gachaDrawPane').classList.toggle('hidden', currentGachaTab !== 'draw');
  document.getElementById('gachaTicketsPane').classList.toggle('hidden', currentGachaTab !== 'tickets');
  if (currentGachaTab === 'draw') renderDrawUI();
  else renderPrizeList();
}

function buildEggCarousel() {
  if (eggCarouselBuilt) return;
  eggCarouselBuilt = true;
  const car = document.getElementById('eggCarousel');
  GACHA_EGGS.forEach((egg, i) => {
    const card = document.createElement('div');
    card.className = 'egg-card';
    card.dataset.idx = i;
    card.innerHTML = `
      <div class="egg-visual"><div class="egg-shape egg-tier${egg.tier}"></div></div>
      <div class="egg-name">${egg.name}</div>
      <div class="egg-cost">🎫 ×${egg.cost}</div>
      <div class="egg-hint">${egg.hint}</div>`;
    card.addEventListener('click', () => {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
    car.appendChild(card);
  });
  car.addEventListener('scroll', () => requestAnimationFrame(updateActiveEgg));
}

function updateActiveEgg() {
  const car = document.getElementById('eggCarousel');
  const center = car.scrollLeft + car.clientWidth / 2;
  let best = 0, bestDist = Infinity;
  [...car.children].forEach((card, i) => {
    const dist = Math.abs(card.offsetLeft + card.offsetWidth / 2 - center);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  if (best !== activeEggIdx) { activeEggIdx = best; renderDrawUI(); }
}

function renderDrawUI() {
  const car = document.getElementById('eggCarousel');
  [...car.children].forEach((card, i) => card.classList.toggle('active', i === activeEggIdx));
  document.getElementById('eggDots').innerHTML = GACHA_EGGS.map((_, i) =>
    `<span class="egg-dot${i === activeEggIdx ? ' active' : ''}"></span>`).join('');

  const egg = GACHA_EGGS[activeEggIdx];
  const enough = gacha.tickets >= egg.cost;
  document.getElementById('drawTicketStatus').textContent = `もっているガチャ券：🎫 ×${gacha.tickets}`;
  const btn = document.getElementById('drawBtn');
  btn.disabled = !enough || isDrawing;
  btn.textContent = enough
    ? `たまごを割る！（🎫 ×${egg.cost} つかう）`
    : `ガチャ券が足りない…（🎫 ×${egg.cost} 必要）`;
  renderOddsTable(egg);
}

// 選択中の卵の景品・当選確率一覧
function renderOddsTable(egg) {
  document.getElementById('oddsTitle').textContent = `${egg.name}の景品と当たる確率`;
  const total = egg.weights.reduce((a, b) => a + b, 0);
  const list = document.getElementById('oddsList');
  list.innerHTML = '';
  // レア度が高い順（★10→★1）で表示
  PRIZES.slice().reverse().forEach((prize) => {
    const pct = (egg.weights[prize.star - 1] / total) * 100;
    const pctStr = String(parseFloat(pct.toFixed(pct < 1 ? 2 : 1)));
    const row = document.createElement('div');
    row.className = 'odds-row';
    row.innerHTML = `
      <span class="odds-emoji">${prize.emoji}</span>
      <span class="odds-star">★${prize.star}</span>
      <span class="odds-name">${prize.name}</span>
      <span class="odds-pct">${pctStr}%</span>`;
    list.appendChild(row);
  });
}

function pickStar(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i + 1;
  }
  return weights.length;
}

function drawGacha() {
  if (isDrawing) return;
  const egg = GACHA_EGGS[activeEggIdx];
  if (gacha.tickets < egg.cost) return;
  isDrawing = true;
  gacha.tickets -= egg.cost;
  const star = pickStar(egg.weights);
  const prize = PRIZES[star - 1];
  gacha.prizes.unshift({ id: Date.now(), star, date: localDateStr(new Date()), used: false });
  saveGacha();
  renderGachaPage();
  runGachaAnimation(egg, star, prize);
}

function glowClassFor(star) {
  if (star >= 10) return 'glow-ultra';
  if (star >= 7) return 'glow-high';
  if (star >= 5) return 'glow-mid';
  return 'glow-low';
}

function runGachaAnimation(egg, star, prize) {
  const anim = document.getElementById('gachaAnim');
  const glow = document.getElementById('gachaAnimGlow');
  anim.className = 'gacha-anim';
  glow.className = 'gacha-anim-glow';
  document.getElementById('animEggFull').className = `egg-shape anim-egg-full egg-tier${egg.tier}`;
  document.getElementById('animEggTop').className = `egg-shape egg-tier${egg.tier}`;
  document.getElementById('animEggBottom').className = `egg-shape egg-tier${egg.tier}`;
  document.getElementById('gachaResult').classList.add('hidden');

  anim.classList.add('stage-shake');
  animTimers.push(setTimeout(() => anim.classList.add('stage-crack'), 1500));
  animTimers.push(setTimeout(() => {
    anim.classList.add('stage-open');
    glow.classList.add(glowClassFor(star));
  }, 2600));
  animTimers.push(setTimeout(() => showGachaResult(star, prize), 3200));
}

function showGachaResult(star, prize) {
  document.getElementById('gachaResultStars').innerHTML =
    `<span class="stars-filled">${'★'.repeat(star)}</span><span class="stars-empty">${'☆'.repeat(10 - star)}</span>`;
  document.getElementById('gachaResultEmoji').textContent = prize.emoji;
  document.getElementById('gachaResultName').textContent = prize.name;
  const sub = document.getElementById('gachaResultSub');
  if (star === 1) sub.textContent = '残念…また挑戦しよう！';
  else if (star === 10) sub.textContent = '🎊 最高レア！！おめでとう！！チケット一覧に追加しました';
  else sub.textContent = 'チケット一覧に追加しました';
  document.getElementById('gachaResult').classList.remove('hidden');
}

function closeGachaAnim() {
  animTimers.forEach((t) => clearTimeout(t));
  animTimers.length = 0;
  document.getElementById('gachaAnim').className = 'gacha-anim hidden';
  isDrawing = false;
  renderGachaPage();
}

function renderPrizeList() {
  const list = document.getElementById('prizeList');
  list.innerHTML = '';
  if (!gacha.prizes.length) {
    list.innerHTML = '<div class="prize-empty">まだ景品がありません。<br>ミッションを達成してガチャを引こう！</div>';
    return;
  }
  gacha.prizes.forEach((pr) => {
    const prize = PRIZES[pr.star - 1];
    const isHazure = pr.star === 1;
    const item = document.createElement('div');
    item.className = 'prize-item' + ((pr.used || isHazure) ? ' used' : '');
    const [y, m, d] = pr.date.split('-').map(Number);
    let action;
    if (isHazure) action = '<span class="prize-used-label">ざんねん</span>';
    else if (pr.used) action = '<span class="prize-used-label">使用済</span>';
    else action = '<button class="prize-use-btn">使用済みにする</button>';
    item.innerHTML = `
      <span class="prize-emoji">${prize.emoji}</span>
      <div class="prize-info">
        <div class="prize-name">★${pr.star} ${prize.name}</div>
        <div class="prize-date">${y}/${m}/${d}</div>
      </div>
      ${action}`;
    const btn = item.querySelector('.prize-use-btn');
    if (btn) btn.addEventListener('click', () => {
      if (!confirm(`「★${pr.star} ${prize.name}」を使用済みにする？\n（倉本に見せてから押してね）`)) return;
      pr.used = true;
      saveGacha();
      renderPrizeList();
    });
    list.appendChild(item);
  });
}

// ── ミッション・ガチャのイベント登録 ────────────────────

document.querySelectorAll('.gacha-link').forEach((b) => b.addEventListener('click', openGacha));
document.getElementById('gachaBackBtn').addEventListener('click', () => closeGacha());
document.getElementById('missionClaimBtn').addEventListener('click', claimMissions);
document.querySelectorAll('.gacha-subtab').forEach((t) => {
  t.addEventListener('click', () => { currentGachaTab = t.dataset.gtab; renderGachaPage(); });
});
document.getElementById('drawBtn').addEventListener('click', drawGacha);
document.getElementById('gachaResultClose').addEventListener('click', closeGachaAnim);

// ── 初期化 ─────────────────────────────────────────────

document.getElementById('undoBtn').disabled = true;
buildProjectSelector();
buildTimeline();
renderTimeline();

if (ghToken) {
  ghFetchData().then((ok) => { if (ok) { renderTimeline(); checkBonus(); } });
} else {
  tokenModal.classList.remove('hidden');
}

checkBonus();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}