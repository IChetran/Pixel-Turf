// Phone client. Sends joystick direction, renders whatever the host broadcasts.
// Never decides anything about the game, so devtools can't be used to cheat.
import { connect } from './backend.js';
import { drawWorld, rebuildMini, drawMiniOverlay } from './render.js';
import { PALETTE, genPid, cleanName, parsePos, fmtTime, esc } from './shared.js';

const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const SESSION_KEY = 'turf-session';
const VIEW_ROWS = 12; // tiles visible vertically: smaller = more zoomed in

let B, room = (qs.get('r') || '').trim().toUpperCase(), base, me = null, meta = null;
const players = new Map();  // pid -> {name,color,uid}
const cellMap = new Map();  // tile idx -> owner pid
const counts = new Map();   // pid -> tiles
const pos = new Map();      // pid -> {x,y,prog,rx,ry,dprog}
const effects = [];
let resultStr = null, miniDirty = true, selectedColor = null, bootAt = performance.now();
let lastDirKey = '0,0', loopStarted = false;

function show(id) {
  for (const s of document.querySelectorAll('.screen, #screen-game')) s.hidden = s.id !== id;
  document.body.classList.toggle('in-game', id === 'screen-game');
}
function fatal(msg) {
  document.body.classList.add('ready');
  const f = $('#fatal');
  f.hidden = false;
  f.innerHTML = esc(msg) + '<br><br><a href="index.html" style="color:#19e3ff">Back</a>';
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), 2600);
}
const loadSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };
const saveSession = () => { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ room, pid: me.pid })); } catch {} };
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch {} };

boot().catch((e) => fatal(e.message || String(e)));

async function boot() {
  try { B = await connect(); } catch (e) { return fatal(e.message || 'Could not connect.'); }
  document.body.classList.add('ready');

  if (!room) {
    show('screen-code');
    const go = () => {
      const v = $('#code-in').value.trim().toUpperCase();
      if (v.length === 4) { const u = new URL(location.href); u.searchParams.set('r', v); location.href = u.toString(); }
    };
    $('#code-go').onclick = go;
    $('#code-in').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    return;
  }

  base = `rooms/${room}`;
  meta = await B.get(base + '/meta');
  if (!meta) return fatal(`Room ${room} doesn't exist. Check the code or ask the host.`);

  B.onChild(base + '/players', {
    added: (k, v) => { players.set(k, v); onPlayers(); },
    changed: (k, v) => { players.set(k, v); onPlayers(); },
    removed: (k) => { players.delete(k); if (me && k === me.pid) kicked(); onPlayers(); },
  });

  const s = loadSession();
  if (s && s.room === room) {
    const p = await B.get(`${base}/players/${s.pid}`);
    if (p && p.uid === B.uid) { me = { pid: s.pid, name: p.name, color: p.color }; return enterGame(); }
  }
  showJoin();
}

// ---------- join ----------
function showJoin() {
  show('screen-join');
  $('#room-tag').textContent = 'ROOM ' + room;
  buildSwatches();
  $('#join').onclick = join;
  $('#name').onkeydown = (e) => { if (e.key === 'Enter') join(); };
  const last = (() => { try { return localStorage.getItem('turf-name'); } catch { return null; } })();
  if (last) $('#name').value = last;
}

function takenColors() {
  const s = new Set();
  for (const [pid, p] of players) if (!me || pid !== me.pid) s.add(p.color);
  return s;
}

function buildSwatches() {
  const box = $('#swatches');
  const taken = takenColors();
  if (selectedColor && taken.has(selectedColor)) selectedColor = null;
  box.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.style.setProperty('--c', c);
    b.setAttribute('aria-label', 'color ' + c);
    if (taken.has(c)) b.disabled = true;
    if (c === selectedColor) b.classList.add('sel');
    b.onclick = () => { selectedColor = c; buildSwatches(); };
    box.appendChild(b);
  }
}

function onPlayers() {
  if (!$('#screen-join').hidden) buildSwatches();
  renderWaitList();
}

async function join() {
  const name = cleanName($('#name').value);
  if (!name) { $('#join-note').textContent = 'Type a name first.'; $('#name').focus(); return; }
  if (!selectedColor) { $('#join-note').textContent = 'Pick a color.'; return; }
  $('#join-note').textContent = '';
  try { localStorage.setItem('turf-name', name); } catch {}
  goFullscreen();
  for (let i = 0; i < 5; i++) {
    const pid = genPid();
    try {
      await B.set(`${base}/players/${pid}`, { name, color: selectedColor, uid: B.uid });
      me = { pid, name, color: selectedColor };
      saveSession();
      return enterGame();
    } catch (e) {
      if (i === 4) $('#join-note').textContent = 'Could not join: ' + (e.message || e);
    }
  }
}

function kicked() {
  clearSession();
  me = null;
  toast('You were removed by the host.');
  showJoin();
}

async function goFullscreen() {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
  try { await screen.orientation.lock('landscape'); } catch {}
}

async function wakeLock() {
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch {}
}

// ---------- in the game ----------
function enterGame() {
  B.onDisconnectSet(`${base}/input/${me.pid}`, { dx: 0, dy: 0 });
  B.set(`${base}/input/${me.pid}`, { dx: 0, dy: 0 });
  $('#me-name').textContent = me.name;
  $('#me-dot').style.setProperty('--c', me.color);

  B.onValue(base + '/meta', (m) => {
    if (!m) { clearSession(); return fatal('The host closed this room.'); }
    meta = m;
    applyPhase();
  });
  B.onChild(base + '/cells', {
    added: (k, v) => setCell(k, v, true),
    changed: (k, v) => setCell(k, v, true),
    removed: (k) => setCell(k, null, false),
  });
  B.onValue(base + '/pos', (s) => {
    const next = new Map();
    for (const e of parsePos(s)) {
      const old = pos.get(e.pid);
      next.set(e.pid, { x: e.x, y: e.y, prog: e.prog, rx: old ? old.rx : e.x, ry: old ? old.ry : e.y, dprog: old ? old.dprog : e.prog });
    }
    pos.clear();
    for (const [k, v] of next) pos.set(k, v);
  });
  B.onValue(base + '/result', (s) => { resultStr = s; if (meta && meta.state === 'ended') renderResults(); });

  wakeLock();
  document.addEventListener('visibilitychange', () => { if (document.hidden) setDir(0, 0); else wakeLock(); });
  addEventListener('contextmenu', (e) => e.preventDefault());
  setupInput();
  applyPhase();
  if (!loopStarted) { loopStarted = true; resize(); addEventListener('resize', resize); requestAnimationFrame(loop); }
}

function applyPhase() {
  if (!me || !meta) return;
  if (meta.state === 'lobby') {
    show('screen-wait');
    renderWaitList();
    $('#results').hidden = true;
  } else {
    show('screen-game');
    resize();
    if (meta.state === 'ended') renderResults(); else $('#results').hidden = true;
  }
}

function renderWaitList() {
  const box = $('#wait-list');
  if (!box) return;
  box.innerHTML = '';
  for (const p of players.values()) {
    const el = document.createElement('span');
    el.style.setProperty('--c', p.color);
    el.textContent = p.name;
    box.appendChild(el);
  }
}

function setCell(k, v, fx) {
  const i = +k;
  const prev = cellMap.get(i);
  if (prev) counts.set(prev, Math.max(0, (counts.get(prev) || 1) - 1));
  if (v) {
    cellMap.set(i, v);
    counts.set(v, (counts.get(v) || 0) + 1);
    if (fx && meta && meta.state === 'running' && performance.now() - bootAt > 1500) {
      const w = meta.w;
      effects.push({ x: i % w, y: Math.floor(i / w), t0: performance.now(), color: (players.get(v) || {}).color || '#fff' });
      if (effects.length > 60) effects.shift();
      if (me && v === me.pid && navigator.vibrate) navigator.vibrate(25);
    }
  } else cellMap.delete(i);
  miniDirty = true;
}

function ranking() {
  return [...players.keys()].map((pid) => [pid, counts.get(pid) || 0]).sort((a, b) => b[1] - a[1]);
}

function renderResults() {
  const box = $('#results');
  let rows;
  if (resultStr) rows = resultStr.split(';').map((s) => s.split(':')).map(([pid, n]) => [pid, +n]);
  else rows = ranking();
  const idx = rows.findIndex((r) => r[0] === me.pid);
  const mine = idx >= 0 ? rows[idx][1] : 0;
  const total = meta.w * meta.h;
  const medal = idx === 0 ? 'YOU WON!' : `#${idx + 1}`;
  box.hidden = false;
  box.innerHTML = `<div class="big">${medal}</div><div class="sub">${mine} tiles &middot; ${(mine / total * 100).toFixed(1)}% of the map</div>
    <div class="top">${rows.slice(0, 3).map(([pid, n], i) => {
      const p = players.get(pid) || { name: '?', color: '#888' };
      return `<span style="--c:${esc(p.color)}">${i + 1}. ${esc(p.name)}<em>${n}</em></span>`;
    }).join('')}</div><div class="label" style="margin-top:10px">WAITING FOR THE HOST...</div>`;
}

// ---------- input ----------
function setDir(dx, dy) {
  if (!me) return;
  const key = dx + ',' + dy;
  if (key === lastDirKey) return;
  lastDirKey = key;
  B.set(`${base}/input/${me.pid}`, { dx, dy });
}

function setupInput() {
  const touch = $('#touch'), stick = $('#stick'), knob = $('#knob');
  let act = null, axis = null;
  const RADIUS = 56, DEAD = 16, FLOAT = 72;

  touch.onpointerdown = (e) => {
    if (act) return;
    act = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    axis = null;
    touch.setPointerCapture(e.pointerId);
    stick.style.left = e.clientX + 'px';
    stick.style.top = e.clientY + 'px';
    stick.classList.add('on');
    e.preventDefault();
  };
  touch.onpointermove = (e) => {
    if (!act || e.pointerId !== act.id) return;
    let dx = e.clientX - act.ox, dy = e.clientY - act.oy;
    const r = Math.hypot(dx, dy);
    if (r > FLOAT) { // drag the origin along so changing direction stays easy
      const k = (r - FLOAT) / r;
      act.ox += dx * k; act.oy += dy * k;
      dx = e.clientX - act.ox; dy = e.clientY - act.oy;
      stick.style.left = act.ox + 'px'; stick.style.top = act.oy + 'px';
    }
    const rr = Math.min(RADIUS, Math.hypot(dx, dy)) / (Math.hypot(dx, dy) || 1);
    knob.style.transform = `translate(${dx * rr}px, ${dy * rr}px)`;
    if (Math.hypot(dx, dy) < DEAD) { axis = null; return setDir(0, 0); }
    const ax = Math.abs(dx), ay = Math.abs(dy);
    // hysteresis: stick with the current axis until the other clearly wins
    if (!axis) axis = ax >= ay ? 'x' : 'y';
    else if (axis === 'x' && ay > ax * 1.35) axis = 'y';
    else if (axis === 'y' && ax > ay * 1.35) axis = 'x';
    if (axis === 'x') setDir(Math.sign(dx), 0); else setDir(0, Math.sign(dy));
  };
  const up = (e) => {
    if (!act || e.pointerId !== act.id) return;
    act = null; axis = null;
    stick.classList.remove('on');
    stick.style.left = ''; stick.style.top = '';
    knob.style.transform = '';
    setDir(0, 0);
  };
  touch.onpointerup = up;
  touch.onpointercancel = up;

  // keyboard (handy for testing on a laptop)
  const held = [];
  const map = { ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0], ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1] };
  addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!map[k] || e.target.tagName === 'INPUT') return;
    e.preventDefault();
    if (!held.includes(k)) held.push(k);
    const d = map[held[held.length - 1]];
    setDir(d[0], d[1]);
  });
  addEventListener('keyup', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const i = held.indexOf(k);
    if (i < 0) return;
    held.splice(i, 1);
    const d = held.length ? map[held[held.length - 1]] : [0, 0];
    setDir(d[0], d[1]);
  });
}

// ---------- render loop ----------
const cv = $('#cv');
let dpr = 1, W = 0, H = 0, last = performance.now(), hudAt = 0;

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const m = $('#mini2');
  m.width = Math.round(108 * dpr); m.height = Math.round(108 * dpr);
}

function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  if (!me || !meta || $('#screen-game').hidden) return;
  if (cv.clientWidth !== W || cv.clientHeight !== H) resize();

  const k = 1 - Math.exp(-dt * 18);
  for (const p of pos.values()) {
    if (Math.abs(p.x - p.rx) > 4 || Math.abs(p.y - p.ry) > 4) { p.rx = p.x; p.ry = p.y; } // teleport (respawn/resync)
    else { p.rx += (p.x - p.rx) * k; p.ry += (p.y - p.ry) * k; }
    p.dprog += (p.prog - p.dprog) * Math.min(1, dt * 14);
    if (p.prog === 0) p.dprog = 0;
  }
  const list = [];
  for (const [pid, p] of pos) {
    const info = players.get(pid);
    if (info) list.push({ pid, x: p.rx, y: p.ry, prog: p.dprog, name: info.name, color: info.color });
  }

  const mine = pos.get(me.pid);
  const cell = H / VIEW_ROWS;
  const camX = mine ? mine.rx + 0.5 : meta.w / 2;
  const camY = mine ? mine.ry + 0.5 : meta.h / 2;

  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWorld(ctx, {
    W, H, map: { w: meta.w, h: meta.h },
    owner: (i, j) => cellMap.get(j * meta.w + i),
    colorOf: (pid) => (players.get(pid) || {}).color || '#888',
    players: list, camX, camY, cell, selfPid: me.pid, t, effects,
  });

  // minimap
  if (miniDirty && meta.w) {
    miniDirty = false;
    rebuildMini($('#mini'), { w: meta.w, h: meta.h }, cellMap, (pid) => (players.get(pid) || {}).color || '#888');
  }
  const m2 = $('#mini2');
  const c2 = m2.getContext('2d');
  c2.setTransform(1, 0, 0, 1, 0, 0);
  drawMiniOverlay(m2, { w: meta.w, h: meta.h }, list, me.pid, { camX, camY, cols: W / cell, rows: VIEW_ROWS }, t);

  // countdown / go / hint
  const now = B.now();
  const big = $('#big');
  if (meta.state === 'running' && meta.startsAt) {
    const left = meta.startsAt - now;
    if (left > 0) { const n = Math.ceil(left / 1000); big.textContent = n <= 3 ? n : ''; big.classList.toggle('on', n <= 3); }
    else if (-left < 700) { big.textContent = 'GO!'; big.classList.add('on'); }
    else big.classList.remove('on');
    $('#hint').classList.toggle('on', left < 0 && -left < 9000);
  } else { big.classList.remove('on'); $('#hint').classList.remove('on'); }

  // HUD at ~4 Hz
  if (t - hudAt > 250) {
    hudAt = t;
    if (meta.state === 'running') $('#hud-time').textContent = fmtTime(meta.startsAt - now > 0 ? meta.endsAt - meta.startsAt : meta.endsAt - now);
    else if (meta.state === 'ended') $('#hud-time').textContent = 'END';
    const r = ranking();
    const idx = r.findIndex((x) => x[0] === me.pid);
    $('#hud-rank').textContent = `#${idx + 1} of ${r.length}`;
    const n = counts.get(me.pid) || 0;
    $('#hud-tiles').textContent = `${n} tiles · ${(n / (meta.w * meta.h) * 100).toFixed(1)}%`;
  }
}
