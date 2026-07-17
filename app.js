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
const BONUS_THRESHOLD = 10 * 60;
const REPO_OWNER = 'culapy1995';
const REPO_NAME  = 'time-tracker-2';
const DATA_PATH  = 'data.json';

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
let isSaving = false;
let pendingSave = false;
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
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;
  pendingSave = false;
  showSync('保存中…');
  try {
    // SHAが不明な場合は先に取得する
    if (!dataFileSha) {
      const r = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}`,
        { headers: apiHeaders() }
      );
      if (r.ok) {
        const j = await r.json();
        dataFileSha = j.sha;
      }
    }
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
    if (!res.ok) {
      // 409 conflict: SHAがずれたので最新SHAを取り直してリトライ
      if (res.status === 409 || res.status === 422) {
        const r2 = await fetch(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DATA_PATH}`,
          { headers: apiHeaders() }
        );
        if (r2.ok) {
          const j2 = await r2.json();
          dataFileSha = j2.sha;
          isSaving = false;
          await ghSaveData();
          return;
        }
      }
      throw new Error(res.status);
    }
    const json = await res.json();
    dataFileSha = json.content.sha;
    showSync('保存しました。', true);
  } catch (e) {
    showSync('保存失敗', false, true);
  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      setTimeout(() => ghSaveData(), 500);
    }
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
  scheduleSave();
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
  scheduleSave();
}

// ── タブ切り替え ────────────────────────────────────────

function switchTab(viewName) {
  currentTabName = viewName;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === viewName);
  });
  viewTimeline.classList.toggle('hidden', viewName !== 'timeline');
  viewWeek.classList.toggle('hidden', viewName !== 'week');
  viewMonth.classList.toggle('hidden', viewName !== 'month');
  dateNav.classList.toggle('hidden', viewName !== 'timeline');
  document.getElementById('miniDayChart').classList.toggle('hidden', viewName !== 'timeline');
  if (viewName === 'week') renderWeek();
  else if (viewName === 'month') renderMonth();
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
  if (swipeTarget && swipeTarget.closest('.slot-block')) return;
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
      if (currentTabName === 'week') renderWeek();
      else if (currentTabName === 'month') renderMonth();
      else renderTimeline();
    });
  }
});

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