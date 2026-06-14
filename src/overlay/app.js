const LANES = ['backlog', 'queued', 'in_progress', 'in_review', 'done'];
const LANE_LABELS = { backlog: 'Backlog', queued: 'Queued', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' };

// tags are stored as ui/api/db/infra; viewers see teams
const TEAMS = {
  ui: { name: 'Frontend', color: '#c678dd' },
  api: { name: 'Backend', color: '#61afef' },
  db: { name: 'Database', color: '#e5c07b' },
  infra: { name: 'Infra', color: '#56b6c2' },
  _none: { name: 'General', color: '#8b93a7' },
  _qc: { name: 'QC', color: '#d19a66' }, // in_review cards, grouped regardless of tag
};
const team = (tag) => TEAMS[tag] ?? TEAMS._none;

const cards = new Map(); // id -> {id,title,lane,tag,agent}

const boardEl = document.getElementById('board');
const headlineEl = document.getElementById('headline');
const connEl = document.getElementById('conn');
const statsEl = document.getElementById('stats');
const timerEl = document.getElementById('timer');

// ── timer + stats ───────────────────────────────────────────────────
let startedAt = null; // daemon start (ms) — survives overlay reloads
const reviews = { pass: 0, fail: 0 };

// Browsers — and OBS browser sources — throttle setInterval/setTimeout in a
// backgrounded or hidden page, which freezes time-based UI on stream. A Web
// Worker is exempt, so every 1s tick is driven from one. Attach with tick.add.
const tick = (() => {
  const fns = new Set();
  try {
    const blob = new Blob(['setInterval(()=>postMessage(0),1000)'], { type: 'text/javascript' });
    new Worker(URL.createObjectURL(blob)).onmessage = () => fns.forEach((f) => f());
  } catch {
    setInterval(() => fns.forEach((f) => f()), 1000); // fallback if Worker is unavailable
  }
  return { add: (f) => fns.add(f) };
})();

tick.add(() => {
  if (startedAt === null) return;
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  timerEl.textContent = `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
});

function renderStats() {
  const all = [...cards.values()];
  const done = all.filter((c) => c.lane === 'done').length;
  const flight = all.filter((c) => c.lane === 'in_progress' || c.lane === 'in_review').length;
  statsEl.innerHTML =
    `<span class="n">${done}</span> done · <span class="n">${flight}</span> in flight` +
    ` · reviews <span class="pass">${reviews.pass}✓</span>/<span class="fail">${reviews.fail}✗</span>`;
}

// ── websocket ───────────────────────────────────────────────────────
function connect() {
  const project = new URLSearchParams(location.search).get('project');
  const ws = new WebSocket(`ws://${location.host}/ws${project ? `?project=${project}` : ''}`);
  ws.onopen = () => setConn(true);
  ws.onmessage = (e) => applyEvent(JSON.parse(e.data));
  ws.onclose = () => {
    setConn(false);
    setTimeout(connect, 2000);
  };
}

function setConn(online) {
  connEl.textContent = online ? 'live' : 'offline';
  connEl.className = `conn ${online ? 'online' : 'offline'}`;
  document.body.classList.toggle('offline', !online);
}

// ── project switcher ────────────────────────────────────────────────
const projectBtn = document.getElementById('project-btn');
const projectMenu = document.getElementById('project-menu');

function setProject(project) {
  document.getElementById('project-name').textContent = project?.name ?? 'no project yet';
  document.title = project?.name ? `${project.name} - KanKanBan` : 'KanKanBan';
}

// Turn the name into a dropdown only when more than one project lives on this daemon.
async function loadProjects() {
  let list = [];
  try {
    list = await (await fetch('/projects')).json();
  } catch {
    /* daemon hiccup — leave the switcher as plain text */
  }
  if (list.length > 1) {
    projectBtn.classList.add('multi');
    projectMenu.innerHTML = list
      .map((p) => `<div class="pm-item${p.id === projectId ? ' current' : ''}" data-id="${esc(p.id)}">${esc(p.name)}</div>`)
      .join('');
  } else {
    projectBtn.classList.remove('multi');
    projectMenu.classList.add('hidden');
  }
}

projectBtn.onclick = (e) => {
  if (!projectBtn.classList.contains('multi')) return;
  e.stopPropagation();
  projectMenu.classList.toggle('hidden');
};
projectMenu.onclick = (e) => {
  const item = e.target.closest('.pm-item');
  if (item) location.search = `?project=${item.dataset.id}`;
};
document.addEventListener('click', (e) => {
  const sw = document.getElementById('project-switcher');
  if (!projectMenu.classList.contains('hidden') && !sw.contains(e.target)) projectMenu.classList.add('hidden');
});

// ── state ───────────────────────────────────────────────────────────
function applyEvent(msg) {
  if (msg.type === 'init') {
    cards.clear();
    for (const card of msg.board) cards.set(card.id, card);
    setProject(msg.project);
    projectId = msg.project?.id ?? null;
    loadProjects();
    refreshBranch();
    seedHeadline(msg.events);
    startedAt = msg.stats?.started_at ?? Date.now();
    reviews.pass = msg.stats?.reviews.pass ?? 0;
    reviews.fail = msg.stats?.reviews.fail ?? 0;
    renderUsage(msg.usage);
    renderBoard();
    renderTicker();
  } else if (msg.type === 'card') {
    cards.set(msg.card.id, msg.card);
    renderBoard();
    if (msg.card.id === openCardId) refreshCardModal();
  } else if (msg.type === 'event') {
    pushHeadline(msg.event);
    const ev = msg.event;
    if (ev.type === 'review') {
      const verdict = ev.payload && JSON.parse(ev.payload).verdict;
      if (verdict in reviews) reviews[verdict] += 1;
      renderStats();
    }
    if (['tool', 'build_start', 'build_end', 'check'].includes(ev.type)) pulse(ev.task_id);
  } else if (msg.type === 'status') {
    setStatus(msg.status);
  } else if (msg.type === 'usage') {
    renderUsage(msg.usage);
  }
}

// ── subscription usage bars (fed by the statusline script) ─────────
function renderUsage(usage) {
  const windows = [
    ['usage-5h', usage?.five_hour],
    ['usage-wk', usage?.seven_day],
  ];
  for (const [id, win] of windows) {
    const el = document.getElementById(id);
    const pct = win?.used_percentage;
    if (typeof pct !== 'number') {
      el.querySelector('.upct').textContent = '—';
      el.querySelector('.ufill').style.width = '0';
      el.className = 'usage';
      el.title = '';
      continue;
    }
    el.querySelector('.upct').textContent = `${Math.round(pct)}%`;
    el.querySelector('.ufill').style.width = `${Math.min(100, pct)}%`;
    el.className = `usage${pct >= 85 ? ' hot' : pct >= 60 ? ' warn' : ''}`;
    el.title = win.resets_at
      ? `resets ${new Date(win.resets_at * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : '';
  }
}

// ── live agent status (ephemeral, decays to thinking…) ─────────────
const statusEl = document.getElementById('agent-status');
let statusAt = 0;
let statusIdle = true;
let lastAgent = '';

function setStatus({ agent, verb, detail, task_id }) {
  statusAt = Date.now();
  statusIdle = verb === 'idle';
  lastAgent = agent;
  statusEl.className = statusIdle ? 'idle' : '';
  statusEl.innerHTML = `● <span class="who">${esc(agent)}</span> — ${esc(verb)}${detail ? ` ${esc(detail)}` : ''}`;
  if (task_id) pulse(task_id);
}

tick.add(() => {
  // no signal for a while but not idle → the agent is between tools: thinking
  if (!statusIdle && statusAt && Date.now() - statusAt > 8000) {
    statusEl.className = 'thinking';
    statusEl.innerHTML = `● <span class="who">${esc(lastAgent)}</span> — thinking…`;
  }
});

/** Brief glow on a card when its agent does something. */
function pulse(cardId) {
  const el = boardEl.querySelector(`.card[data-id="${cardId}"]`);
  if (!el) return;
  el.classList.remove('pulse');
  void el.offsetWidth; // restart the animation
  el.classList.add('pulse');
}

// ── board render (FLIP) ─────────────────────────────────────────────
function renderBoard() {
  // First: capture where every card currently is.
  const before = new Map();
  for (const el of boardEl.querySelectorAll('.card')) {
    before.set(el.dataset.id, el.getBoundingClientRect());
  }

  boardEl.replaceChildren(
    ...LANES.map((lane) => {
      const inLane = [...cards.values()].filter((c) => c.lane === lane);
      if (lane === 'done') inLane.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)); // freshest first
      const laneEl = document.createElement('div');
      laneEl.className = 'lane';
      laneEl.dataset.lane = lane;
      laneEl.innerHTML = `<div class="lane-head"><span>${LANE_LABELS[lane]}</span><span>${inLane.length}</span></div>`;
      const cardsEl = document.createElement('div');
      cardsEl.className = 'cards';
      cardsEl.append(...inLane.map(cardEl));
      laneEl.append(cardsEl);
      return laneEl;
    }),
  );

  // Last + Invert + Play: slide moved cards from their old position.
  for (const el of boardEl.querySelectorAll('.card')) {
    const prev = before.get(el.dataset.id);
    if (!prev) continue;
    const next = el.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (!dx && !dy) continue;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }

  renderStats();
  renderTeams();
}

// ── teams: counter + peek panel ─────────────────────────────────────
const teamsBtn = document.getElementById('teams-btn');
const teamsPeek = document.getElementById('teams-peek');

function activeTeams() {
  const byTag = new Map();
  for (const card of cards.values()) {
    if (card.lane !== 'in_progress' && card.lane !== 'in_review') continue;
    const key = card.lane === 'in_review' ? '_qc' : (card.tag ?? '_none');
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(card);
  }
  return byTag;
}

function renderTeams() {
  const n = activeTeams().size;
  teamsBtn.textContent = `${n} team${n === 1 ? '' : 's'} active`;
  teamsBtn.classList.toggle('on', n > 0);
  if (!teamsPeek.classList.contains('hidden')) renderPeek();
}

function renderPeek() {
  const groups = activeTeams();
  if (groups.size === 0) {
    teamsPeek.innerHTML = '<div class="tp-empty">No teams working right now</div>';
    return;
  }
  teamsPeek.innerHTML = [...groups.entries()]
    .map(([tag, list]) => {
      const t = team(tag === '_none' ? null : tag);
      const rows = list
        .map((c) => {
          const prog = c.subs ? ` · ${c.subs.done}/${c.subs.total}` : '';
          return `<div class="tp-card">${esc(c.title)}<span class="tp-sub">${esc(c.agent ?? 'unassigned')}${prog}</span></div>`;
        })
        .join('');
      return `<div class="tp-team"><div class="tp-head"><span class="tp-dot" style="background:${t.color}"></span>${esc(t.name)} team</div>${rows}</div>`;
    })
    .join('');
}

teamsBtn.onclick = (e) => {
  e.stopPropagation();
  teamsPeek.classList.toggle('hidden');
  if (!teamsPeek.classList.contains('hidden')) renderPeek();
};
document.addEventListener('click', (e) => {
  if (!teamsPeek.classList.contains('hidden') && !teamsPeek.contains(e.target)) {
    teamsPeek.classList.add('hidden');
  }
});

function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  if (card.tag) el.dataset.tag = card.tag;
  const meta = [
    card.tag && `<span class="tag">${esc(team(card.tag).name)}</span>`,
    card.agent && `<span class="agent">${esc(card.agent)}</span>`,
    card.rounds > 0 && `<span class="rounds${card.rounds >= 2 ? ' cap' : ''}">R${card.rounds}</span>`,
    card.subs && `<span class="subs">${card.subs.done}/${card.subs.total}</span>`,
  ].filter(Boolean).join('');
  const bar = card.subs
    ? `<div class="bar"><div class="bar-fill" style="width:${(100 * card.subs.done) / card.subs.total}%"></div></div>`
    : '';
  el.innerHTML = `<div class="title">${esc(card.title)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}${bar}`;
  el.onclick = () => openCardModal(card.id);
  return el;
}

// ── headline ticker: one plain-English event at a time ─────────────
// tool events are excluded — the live status (left) owns "doing right now";
// the headline owns "what just happened".
const HOLD_MS = 5000;
const QUEUE_MAX = 4;
const hq = [];
let headlineBusy = false;

function headline(ev) {
  const p = ev.payload ? JSON.parse(ev.payload) : {};
  const title = (id) => `“<span class="hl-title">${esc(cards.get(id)?.title ?? p.title ?? id ?? 'a card')}</span>”`;
  switch (ev.type) {
    case 'create': return `📋 New task: ${title(ev.task_id)}`;
    case 'move':
      if (p.to === 'done') return `🎉 ${title(ev.task_id)} is Done!`;
      return `➡️ ${title(ev.task_id)} moved to ${esc(LANE_NAME(p.to))}`;
    case 'assign': return `👷 ${title(ev.task_id)} assigned to ${esc(ev.agent ?? 'an agent')}`;
    case 'build_start': return `🔨 ${esc(ev.agent ?? 'builder')} started building ${title(ev.task_id)}`;
    case 'build_end': return `🔨 ${esc(ev.agent ?? 'builder')} finished building ${title(ev.task_id)}`;
    case 'review':
      return p.verdict === 'pass'
        ? `🔍 Review passed — ${title(ev.task_id)}`
        : `🔍 Review found issues on ${title(ev.task_id)} (round ${p.round ?? '?'})`;
    case 'subtasks': return `🧩 ${p.total ?? '?'} acceptance criteria set for ${title(ev.task_id)}`;
    case 'check':
      return `✅ Step ${p.progress ? `${p.progress.done} of ${p.progress.total}` : 'done'} on ${title(ev.task_id)}: ${esc(p.text ?? '')}`;
    case 'note': return p.msg ? `💬 ${esc(p.msg)}` : null;
    default: return null; // tool + anything unmappable: skip
  }
}

function pushHeadline(ev) {
  if (ev.type === 'tool') return;
  const html = headline(ev);
  if (!html) return;
  hq.push(html);
  if (hq.length > QUEUE_MAX) hq.shift(); // burst: drop oldest, never lag behind
  if (!headlineBusy) drainHeadlines();
}

function drainHeadlines() {
  if (hq.length === 0) {
    headlineBusy = false;
    return; // keep the last headline on screen until something new happens
  }
  headlineBusy = true;
  const html = hq.shift();
  headlineEl.classList.add('fade');
  setTimeout(() => {
    headlineEl.innerHTML = html;
    headlineEl.classList.remove('fade');
    setTimeout(drainHeadlines, HOLD_MS);
  }, 250);
}

function seedHeadline(events) {
  const last = events
    .slice()
    .reverse()
    .find((ev) => ev.type !== 'tool' && headline(ev));
  if (last) headlineEl.innerHTML = headline(last);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Inline formatting on already-escaped text: `code` and **bold**.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Tiny, safe markdown for card descriptions — headings, bullet/numbered
// lists, and paragraphs. Escapes first, so no HTML can slip through.
function renderMarkdown(src) {
  const lines = esc(src ?? '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); }
    else if ((m = /^#{1,3}\s+(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<div class="md-h">${inlineMd(m[1])}</div>`); }
    else if ((m = /^[-*]\s+(.*)$/.exec(line))) { flushPara(); if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(m[1])}</li>`); }
    else if ((m = /^\d+\.\s+(.*)$/.exec(line))) { flushPara(); if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(m[1])}</li>`); }
    else { flushList(); para.push(inlineMd(line)); }
  }
  flushPara();
  flushList();
  return out.join('');
}

// ── card detail modal ───────────────────────────────────────────────
let openCardId = null;

const LANE_NAME = (l) => ({ backlog: 'Backlog', queued: 'Queued', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' })[l] ?? l;

async function openCardModal(cardId) {
  openCardId = cardId;
  document.getElementById('card-modal').classList.remove('hidden');
  await refreshCardModal();
}

function closeCardModal() {
  openCardId = null;
  document.getElementById('card-modal').classList.add('hidden');
}

async function refreshCardModal() {
  if (!openCardId) return;
  const res = await fetch(`/task/${openCardId}`);
  if (!res.ok) return closeCardModal();
  const task = await res.json();
  document.getElementById('card-title').textContent = task.title;
  const meta = [
    task.tag && `${team(task.tag).name} team`,
    LANE_NAME(task.lane),
    task.assigned_agent && `● ${task.assigned_agent}`,
    task.review_rounds > 0 && `review round ${task.review_rounds}`,
    task.branch,
  ].filter(Boolean);
  document.getElementById('card-meta').innerHTML = meta.map((m) => `<span>${esc(m)}</span>`).join('');
  document.getElementById('card-desc').innerHTML = renderMarkdown(task.requirements);
  const subs = task.subtasks ?? [];
  const total = subs.length;
  const done = subs.filter((s) => s.done).length;
  const pct = total ? Math.round((100 * done) / total) : 0;
  document.getElementById('card-progress').textContent = total ? `${done} of ${total}` : '';
  document.getElementById('card-progressbar').style.display = total ? '' : 'none';
  document.getElementById('card-progressfill').style.width = `${pct}%`;
  // while a builder is on the card, flag the first unchecked criterion as "working"
  const activeIdx = task.lane === 'in_progress' ? subs.findIndex((s) => !s.done) : -1;
  document.getElementById('card-subs').innerHTML = total
    ? subs
        .map(
          (s, i) =>
            `<li class="${s.done ? 'done' : ''}${i === activeIdx ? ' active' : ''}"><span class="ck">${s.done ? '✓' : ''}</span><span class="txt">${esc(s.text)}</span>${i === activeIdx ? '<span class="sub-now">working</span>' : ''}</li>`,
        )
        .join('')
    : '<li class="empty">No acceptance criteria yet</li>';
}

document.getElementById('card-close').onclick = closeCardModal;
document.getElementById('card-modal').onclick = (e) => {
  if (e.target === document.getElementById('card-modal')) closeCardModal();
};

// ── git: branch chip + commit modal ─────────────────────────────────
let projectId = null;
let selectedFile = null;

const $ = (id) => document.getElementById(id);

async function gitApi(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res;
}

async function refreshBranch() {
  const chip = $('branch-chip');
  if (!projectId) return chip.classList.add('hidden');
  try {
    const { branch } = await (await gitApi(`/git/status?project=${projectId}`)).json();
    $('branch-name').textContent = branch;
    chip.classList.remove('hidden');
  } catch {
    chip.classList.add('hidden'); // not a git repo / daemon hiccup
  }
}

async function openGitModal() {
  $('git-modal').classList.remove('hidden');
  $('git-result').textContent = '';
  $('git-result').className = '';
  await refreshFiles();
}

async function refreshFiles() {
  const { branch, files } = await (await gitApi(`/git/status?project=${projectId}`)).json();
  $('git-title').textContent = `${files.length} change${files.length === 1 ? '' : 's'} on ${branch}`;
  $('branch-name').textContent = branch;
  const list = $('git-files');
  list.replaceChildren(
    ...files.map((f) => {
      const li = document.createElement('li');
      const st = f.status === '??' ? 'U' : f.status[0];
      li.innerHTML = `<span class="st ${esc(st)}">${esc(st)}</span><span>${esc(f.path)}</span>`;
      li.onclick = () => selectFile(f.path, li);
      return li;
    }),
  );
  if (files.length) selectFile(files[0].path, list.firstChild);
  else $('git-diff').innerHTML = '<div class="dl meta"><span class="ln"></span><span class="ln"></span><span class="dt">working tree clean</span></div>';
}

async function selectFile(path, li) {
  selectedFile = path;
  for (const el of $('git-files').children) el.classList.toggle('sel', el === li);
  const diff = await (await gitApi(`/git/diff?project=${projectId}&file=${encodeURIComponent(path)}`)).text();
  $('git-diff').innerHTML = renderDiff(diff);
}

// GitHub-style unified diff: line-number gutters + green/red rows
function renderDiff(text) {
  let oldN = 0;
  let newN = 0;
  const row = (cls, o, n, t) =>
    `<div class="dl ${cls}"><span class="ln">${o}</span><span class="ln">${n}</span><span class="dt">${esc(t)}</span></div>`;
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => {
      if (line.startsWith('@@')) {
        const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) [oldN, newN] = [Number(m[1]), Number(m[2])];
        return row('hunk', '', '', line);
      }
      if (/^(diff |index |--- |\+\+\+ |new file|deleted file|rename |similarity |\\)/.test(line))
        return row('meta', '', '', line);
      if (line.startsWith('+')) return row('add', '', newN++, line);
      if (line.startsWith('-')) return row('del', oldN++, '', line);
      return row('ctx', oldN++, newN++, line);
    })
    .join('');
}

async function commitAndPush() {
  const message = $('commit-msg').value.trim();
  const result = $('git-result');
  if (!message) {
    result.textContent = 'commit message required';
    result.className = 'err';
    return;
  }
  const btn = $('commit-btn');
  btn.disabled = true;
  result.textContent = 'committing…';
  result.className = '';
  try {
    const out = await (
      await gitApi('/git/commit', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, message, description: $('commit-desc').value.trim() }),
      })
    ).json();
    result.textContent = out.pushed ? 'committed and pushed ✓' : `committed ✓ — push failed: ${out.push_error}`;
    result.className = out.pushed ? 'ok' : 'err';
    if (out.ok) {
      $('commit-msg').value = '';
      $('commit-desc').value = '';
    }
    await refreshFiles();
  } catch (err) {
    result.textContent = err.message;
    result.className = 'err';
  } finally {
    btn.disabled = false;
  }
}

$('branch-chip').onclick = openGitModal;
$('git-close').onclick = () => $('git-modal').classList.add('hidden');
$('git-modal').onclick = (e) => { if (e.target === $('git-modal')) $('git-modal').classList.add('hidden'); };
$('commit-btn').onclick = commitAndPush;

connect();
