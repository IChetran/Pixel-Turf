// Host / spectator screen. This tab is the game server: it runs the engine, owns the clock,
// and is the only client allowed to write cells/positions (enforced by database.rules.json).
import { connect } from './backend.js';
import { Game } from './engine.js';
import { drawWorld } from './render.js';
import { genCode, joinUrl, drawQR, fmtTime, esc, parsePos } from './shared.js';

const $ = (s) => document.querySelector(s);
const SESSION_KEY = 'turf-host-room';
const TICK_MS = 50;       // game logic rate
const POS_EVERY_MS = 80;  // position broadcast rate (~12/s)
const COUNTDOWN_MS = 4000;

let B, code, base, meta = null, game = null;
const players = new Map(); // pid -> {name,color}
const dirs = new Map();    // pid -> [dx,dy] (latest input, applied when the player exists)
const rpos = new Map();    // pid -> smoothed render position
const effects = [];
let follow = null;
let lastPosStr = '', lastPosAt = 0, finishing = false;
const cam = { x: 30, y: 30, cell: 10, init: false };

boot().catch(fatal);

function fatal(e) {
  console.error(e);
  $('#fatal').textContent = String((e && e.message) || e);
  document.body.dataset.phase = 'fatal';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), 2600);
}

async function boot() {
  B = await connect();
  code = await openRoom();
  base = `rooms/${code}`;
  try { localStorage.setItem(SESSION_KEY, code); } catch {}

  $('#roomcode').textContent = code;
  const url = joinUrl(code);
  $('#joinurl').textContent = url.replace(/^https?:\/\//, '').replace(/&mock=1$/, '');
  if (!drawQR($('#qr'), url)) {
    $('#qr').replaceWith(Object.assign(document.createElement('div'), { className: 'qr-fallback', textContent: 'QR library blocked on this network. Share the link instead.' }));
  }

  if (meta.state !== 'lobby') await restore();

  B.onChild(base + '/players', {
    added: onPlayer,
    changed: onPlayer,
    removed: (pid) => { players.delete(pid); dirs.delete(pid); renderChips(); },
  });
  B.onChild(base + '/input', { added: onInput, changed: onInput });

  $('#start').onclick = start;
  $('#end').onclick = () => finish();
  $('#rematch').onclick = rematch;
  $('#close').onclick = closeRoom;
  addEventListener('keydown', (e) => { if (e.key === 'Escape') setFollow(null); });

  applyPhase();
  startTicker();
  requestAnimationFrame(frame);
  setInterval(updateUI, 250);
  try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch {}
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch {} }
  });
}

async function openRoom() {
  let saved = null;
  try { saved = localStorage.getItem(SESSION_KEY); } catch {}
  if (saved) {
    const m = await B.get(`rooms/${saved}/meta`);
    if (m && m.hostUid === B.uid) { meta = m; return saved; } // refreshed the host tab: resume
  }
  for (let i = 0; i < 8; i++) {
    const c = genCode();
    if (await B.get(`rooms/${c}/meta`)) continue;
    const m = { hostUid: B.uid, state: 'lobby', w: 60, h: 60, minutes: 3, createdAt: B.now() };
    try { await B.set(`rooms/${c}/meta`, m); meta = m; return c; } catch (e) { console.warn('room create failed, retrying', e); }
  }
  throw new Error('Could not create a room. Check your database rules and that Anonymous sign-in is enabled.');
}

// Rebuild the game after a host refresh, from what is stored in the database.
async function restore() {
  game = new Game({ w: meta.w, h: meta.h });
  const [cells, pos] = await Promise.all([B.get(base + '/cells'), B.get(base + '/pos')]);
  if (cells) for (const [k, v] of Object.entries(cells)) if (v) game.loadCell(+k, v);
  for (const e of parsePos(pos)) game.placePlayer(e.pid, e.x, e.y);
}

async function setMeta(patch) {
  meta = { ...meta, ...patch };
  await B.update(base + '/meta', patch);
  applyPhase();
}

// ---------- players ----------
function onPlayer(pid, v) {
  if (!v) return;
  players.set(pid, { name: v.name, color: v.color });
  if (game && meta.state === 'running' && !game.players.has(pid)) {
    game.addPlayer(pid, B.now());
    const d = dirs.get(pid);
    if (d) game.setDir(pid, d[0], d[1]);
  }
  renderChips();
}

function onInput(pid, v) {
  if (!v) return;
  const dx = Math.sign(Number(v.dx) || 0), dy = Math.sign(Number(v.dy) || 0);
  dirs.set(pid, [dx, dy]);
  if (game && game.players.has(pid)) game.setDir(pid, dx, dy);
}

function renderChips() {
  const box = $('#chips');
  box.innerHTML = '';
  for (const [pid, p] of players) {
    const el = document.createElement('span');
    el.className = 'chip';
    el.style.setProperty('--c', p.color);
    el.innerHTML = `${esc(p.name)}<button title="Remove" aria-label="Remove ${esc(p.name)}">&times;</button>`;
    el.querySelector('button').onclick = () => B.set(`${base}/players/${pid}`, null);
    box.appendChild(el);
  }
  $('#count-note').textContent = players.size ? `${players.size} player${players.size === 1 ? '' : 's'} in` : 'Waiting for players to scan...';
  $('#start').disabled = players.size === 0;
}

// ---------- game flow ----------
async function start() {
  if (!players.size) return;
  const size = +$('#size').value, minutes = +$('#mins').value;
  const now = B.now();
  game = new Game({ w: size, h: size });
  rpos.clear();
  for (const pid of players.keys()) {
    game.addPlayer(pid, now);
    const d = dirs.get(pid);
    if (d) game.setDir(pid, d[0], d[1]);
  }
  const cells = {};
  for (const [i, pid] of game.drain()) cells[i] = pid;
  await B.set(base + '/result', null);
  await B.set(base + '/cells', cells);
  lastPosStr = game.packPos();
  await B.set(base + '/pos', lastPosStr);
  finishing = false;
  const startsAt = B.now() + COUNTDOWN_MS;
  await setMeta({ state: 'running', w: size, h: size, minutes, startsAt, endsAt: startsAt + minutes * 60000 });
}

async function finish() {
  if (finishing || !game || meta.state !== 'running') return;
  finishing = true;
  flush(B.now(), true);
  const result = game.ranking().map((r) => `${r.pid}:${r.count}`).join(';');
  await B.set(base + '/result', result);
  await setMeta({ state: 'ended' });
}

async function rematch() {
  await B.set(base + '/cells', null);
  await B.set(base + '/pos', null);
  await B.set(base + '/result', null);
  game = null;
  follow = null;
  rpos.clear();
  await setMeta({ state: 'lobby' });
  renderChips();
}

async function closeRoom() {
  if (!confirm('Close this room? Everyone gets disconnected.')) return;
  await B.set(base, null);
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  location.reload();
}

// Runs in a worker timer so it keeps ticking even if the tab is in the background.
function startTicker() {
  const src = `setInterval(() => postMessage(0), ${TICK_MS});`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  w.onmessage = tick;
}

function tick() {
  if (!game || !meta || meta.state !== 'running') return;
  const now = B.now();
  if (now < meta.startsAt) return;
  if (now >= meta.endsAt) { finish(); return; }
  game.tick(now);
  flush(now, false);
}

function flush(now, force) {
  const changes = game.drain();
  if (changes.size) {
    const patch = {};
    const t = performance.now();
    for (const [i, pid] of changes) {
      patch[i] = pid;
      effects.push({ x: i % game.w, y: Math.floor(i / game.w), t0: t, color: players.get(pid)?.color || '#fff' });
    }
    if (effects.length > 120) effects.splice(0, effects.length - 120);
    B.update(base + '/cells', patch);
  }
  if (force || now - lastPosAt >= POS_EVERY_MS) {
    const s = game.packPos();
    if (s !== lastPosStr) { lastPosStr = s; lastPosAt = now; B.set(base + '/pos', s); }
  }
}

// ---------- UI ----------
function applyPhase() {
  document.body.dataset.phase = meta.state;
  if (meta.state === 'lobby') renderChips();
  if (meta.state === 'ended') renderPodium();
  updateUI();
}

function setFollow(pid) {
  follow = pid;
  for (const el of document.querySelectorAll('#rows .row')) el.classList.toggle('following', el.dataset.pid === pid);
  $('#follow-note').textContent = pid ? 'Esc = full map' : 'click a name to spectate';
}

const rowEls = new Map();
const ROW_H = 34;
function updateUI() {
  if (!meta) return;
  const now = B.now();
  if (meta.state === 'running') {
    if (now < meta.startsAt) {
      $('#timer').textContent = fmtTime(meta.minutes * 60000);
      const n = Math.ceil((meta.startsAt - now) / 1000);
      $('#countdown').textContent = n > 3 ? '' : String(n);
      $('#countdown').classList.toggle('on', n <= 3);
    } else {
      $('#timer').textContent = fmtTime(meta.endsAt - now);
      const sinceGo = now - meta.startsAt;
      $('#countdown').textContent = 'GO!';
      $('#countdown').classList.toggle('on', sinceGo < 700);
    }
  } else {
    $('#countdown').classList.remove('on');
    $('#timer').textContent = meta.state === 'ended' ? 'FINISH' : fmtTime(($('#mins') ? +$('#mins').value : 3) * 60000);
  }

  if (!game) { $('#rows').innerHTML = ''; rowEls.clear(); return; }
  const ranking = game.ranking();
  const total = game.w * game.h;
  const box = $('#rows');
  box.style.height = ranking.length * ROW_H + 'px';
  const seen = new Set();
  ranking.forEach((r, i) => {
    seen.add(r.pid);
    let el = rowEls.get(r.pid);
    const p = players.get(r.pid) || { name: '?', color: '#888' };
    if (!el) {
      el = document.createElement('div');
      el.className = 'row';
      el.dataset.pid = r.pid;
      el.style.setProperty('--c', p.color);
      el.innerHTML = '<div class="bar"></div><div class="rk"></div><div class="nm"></div><div class="ct"></div>';
      el.onclick = () => setFollow(follow === r.pid ? null : r.pid);
      box.appendChild(el);
      rowEls.set(r.pid, el);
    }
    el.style.setProperty('--c', p.color);
    el.style.transform = `translateY(${i * ROW_H}px)`;
    el.style.setProperty('--w', Math.min(100, (r.count / total) * 100 * 6) + '%');
    el.children[1].textContent = i + 1;
    el.children[2].textContent = p.name;
    el.children[3].textContent = r.count;
  });
  for (const [pid, el] of rowEls) if (!seen.has(pid)) { el.remove(); rowEls.delete(pid); }
}

function renderPodium() {
  if (!game) return;
  const top = game.ranking().slice(0, 3);
  const total = game.w * game.h;
  $('#podium').innerHTML = `<div class="box"><h2>TIME!</h2>${top.map((r, i) => {
    const p = players.get(r.pid) || { name: '?', color: '#888' };
    return `<div class="p ${i === 0 ? 'first' : ''}" style="--c:${esc(p.color)}"><span class="n">#${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="t">${r.count} tiles &middot; ${(r.count / total * 100).toFixed(1)}%</span></div>`;
  }).join('')}<div class="hint">Full standings on the right. Hit REMATCH to play again.</div></div>`;
}

// ---------- render loop ----------
let lastT = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  if (!game || (meta.state !== 'running' && meta.state !== 'ended')) return;

  const cv = $('#map');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // smooth positions
  const list = [];
  const k = 1 - Math.exp(-dt * 20);
  for (const p of game.players.values()) {
    let r = rpos.get(p.pid);
    if (!r) { r = { x: p.x, y: p.y }; rpos.set(p.pid, r); }
    r.x += (p.x - r.x) * k; r.y += (p.y - r.y) * k;
    const info = players.get(p.pid) || { name: '', color: '#888' };
    list.push({ pid: p.pid, x: r.x, y: r.y, prog: p.prog, name: info.name, color: info.color });
  }

  // camera: full map, or follow a player
  let tx, ty, tc;
  const fp = follow && rpos.get(follow);
  if (fp) { tx = fp.x + 0.5; ty = fp.y + 0.5; tc = H / 22; }
  else { tx = game.w / 2; ty = game.h / 2; tc = Math.min(W / game.w, H / game.h) * 0.97; }
  if (!cam.init) { cam.x = tx; cam.y = ty; cam.cell = tc; cam.init = true; }
  const kc = 1 - Math.exp(-dt * 6);
  cam.x += (tx - cam.x) * kc; cam.y += (ty - cam.y) * kc; cam.cell += (tc - cam.cell) * kc;

  drawWorld(ctx, {
    W, H,
    map: { w: game.w, h: game.h },
    owner: (i, j) => game.cells[j * game.w + i],
    colorOf: (pid) => (players.get(pid) || {}).color || '#888',
    players: list,
    camX: cam.x, camY: cam.y, cell: cam.cell,
    selfPid: follow,
    t,
    effects,
  });
}
