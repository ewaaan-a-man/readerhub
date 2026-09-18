// ReaderHub — revision access site (students request access, admin approves + messages)
// Zero dependencies. Node 18+. Run: node server.js
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Admin bootstrap (created on first run). Override via ADMIN_EMAIL / ADMIN_PASS env vars.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@readerhub.local';
const ADMIN_PASS = process.env.ADMIN_PASS || crypto.randomBytes(12).toString('base64url');

// Student signup domain allowlist. Empty array = any email allowed.
const SCHOOL_DOMAINS = [];

const PLANS = {
  week: { id: 'week', label: '1 week pass', price: '£1', days: 7 },
  twoweek: { id: 'twoweek', label: '2 week pass', price: '£2', days: 14 },
  month: { id: 'month', label: '4 week pass', price: '£3', days: 28 },
  term: { id: 'term', label: '12 week pass', price: '£9', days: 84 },
};

// ---------- tiny JSON DB ----------
// Storage backends, chosen by env:
//  - TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN): Turso hosted SQLite over HTTP -> survives redeploys/spin-downs
//  - otherwise: local file data/db.json (dev use; wiped on Render free tier)
let db = null;
let dbReady = null; // promise
let cloudLoaded = false; // turso mode: true once remote state has been read successfully
let TURSO_URL = process.env.TURSO_DATABASE_URL || null;
if (TURSO_URL && TURSO_URL.startsWith('libsql://')) TURSO_URL = 'https://' + TURSO_URL.slice('libsql://'.length);
if (TURSO_URL) TURSO_URL = TURSO_URL.replace(/\/$/, '');
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const RELOAD_MS = Number(process.env.DB_RELOAD_MS) || 30000;

function tursoArg(a) {
  if (a === null || a === undefined) return { type: 'null' };
  if (typeof a === 'string') return { type: 'text', value: a };
  if (Number.isInteger(a)) return { type: 'integer', value: a };
  if (typeof a === 'number') return { type: 'float', value: a };
  return a; // already a Hrana value
}
let saveChain = Promise.resolve();
function tursoExec(stmts) {
  // stmts: [{q, args}] executed in order in an implicit transaction
  return fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TURSO_TOKEN ? { Authorization: `Bearer ${TURSO_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ requests: stmts.map((s) => ({ type: 'execute', stmt: { sql: s.q, args: (s.args || []).map(tursoArg) } })).concat([{ type: 'close' }]) }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`Turso HTTP ${r.status}: ${await r.text()}`);
    return r.json();
  });
}

function storeSave() {
  const blob = JSON.stringify(db, null, 1);
  if (TURSO_URL) {
    if (!cloudLoaded) { console.error('DB save skipped: remote state unverified (initial load still retrying)'); return saveChain; }
    const write = () => tursoExec([{ q: 'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)' }, { q: "INSERT INTO kv (k, v) VALUES ('db', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", args: [blob] }]).catch((e) => console.error('DB save failed:', e.message));
    saveChain = saveChain.then(write, write);
    return saveChain;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, blob);
  return Promise.resolve();
}
function storeLoad() {
  // resolves with parsed db (or null = empty store); rejects on transport/protocol errors
  if (TURSO_URL) {
    return tursoExec([{ q: 'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)' }, { q: "SELECT v FROM kv WHERE k = 'db'" }]).then((res) => {
      const rows = res.results[1].response.result.rows;
      if (!rows || !rows.length) return null;
      const row = rows[0];
      const cell = Array.isArray(row) ? row[0] : row;
      const raw = cell && typeof cell === 'object' ? (cell.value !== undefined ? cell.value : cell.v) : cell;
      return raw ? JSON.parse(raw) : null;
    });
  }
  if (fs.existsSync(DB_FILE)) return Promise.resolve(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  return Promise.resolve(null);
}
async function loadWithRetry(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try { return { ok: true, data: await storeLoad() }; }
    catch (e) {
      console.error(`DB load attempt ${i + 1}/${attempts} failed:`, e.message);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return { ok: false };
}
function adoptDb(data) {
  db = data || { users: [], sessions: {}, requests: [], orders: [], messages: [], waitlist: [] };
  if (!db.orders) db.orders = [];
  if (!db.waitlist) db.waitlist = [];
  if (!db.sessions) db.sessions = {};
  if (!db.users) db.users = [];
  if (!db.messages) db.messages = [];
  if (!db.requests) db.requests = [];
  if (!db.users.some((u) => u.role === 'admin')) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.users.push({
      id: crypto.randomUUID(),
      email: ADMIN_EMAIL,
      name: 'Admin',
      role: 'admin',
      salt,
      hash: crypto.scryptSync(ADMIN_PASS, salt, 64).toString('hex'),
      createdAt: Date.now(),
      access: null, xp: 0, streak: 0, lastPractice: null,
    });
  }
}
function scheduleRemoteReload() {
  const t = setInterval(() => {
    loadWithRetry(1).then(({ ok, data }) => {
      if (!ok) return;
      clearInterval(t);
      cloudLoaded = true;
      adoptDb(data);
      console.log('DB recovered: loaded remote state');
    });
  }, RELOAD_MS);
  t.unref();
}
function loadDb() {
  dbReady = loadWithRetry().then(({ ok, data }) => {
    if (ok) {
      cloudLoaded = true;
      adoptDb(data);
      return storeSave();
    }
    console.error('DB unavailable after retries — serving empty in-memory state; remote will NOT be overwritten until it can be read');
    adoptDb(null);
    scheduleRemoteReload();
  });
}
let saveTimer = null;
function saveDbNow() { if (db) storeSave(); }
function saveDbSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDbNow, 300);
}
process.on('exit', saveDbNow);
process.on('SIGINT', () => { saveDbNow(); process.exit(0); });
process.on('SIGTERM', () => {
  clearTimeout(saveTimer);
  Promise.resolve(storeSave()).catch(() => {}).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

// ---------- helpers ----------
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100000) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
    });
  });
}
function getUser(req) {
  const token = parseCookies(req).rh_token;
  if (!token) return null;
  const sess = db.sessions[token];
  if (!sess || sess.expires < Date.now()) return null;
  return db.users.find((u) => u.email === sess.email) || null;
}
function setSession(res, user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { email: user.email, expires: Date.now() + 30 * 86400000 };
  // prune expired sessions
  for (const [t, s] of Object.entries(db.sessions)) if (s.expires < Date.now()) delete db.sessions[t];
  saveDbSoon();
  res.setHeader('Set-Cookie', `rh_token=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
}
function clearSession(req, res) {
  const token = parseCookies(req).rh_token;
  if (token) delete db.sessions[token];
  saveDbSoon();
  res.setHeader('Set-Cookie', 'rh_token=; HttpOnly; Path=/; Max-Age=0');
}
function accessActive(user) {
  return !!(user.access && user.access.expiresAt > Date.now());
}
function unreadCount(user, peerEmail) {
  return db.messages.filter((m) => m.from === peerEmail && m.to === user.email && !m.read).length;
}

// ---------- practice content (answers stay server-side) ----------
const PASSAGES = [
  {
    id: 'p1', title: 'The Fox and the Crow (Aesop)', free: true,
    text: 'A crow once stole a piece of cheese and flew with it to a high branch of a tree. A fox, smelling the cheese, sat below and began to praise the crow. "What beautiful feathers you have!" he said. "And surely such a handsome bird must have an even handsomer voice. Sing for me, queen of birds!" Flattered, the crow opened her beak to sing. Down fell the cheese, and the fox snapped it up. "That was all I wanted," he said, "plus a lesson: do not trust flatterers."',
    questions: [
      { q: 'Why did the fox speak kindly to the crow?', choices: ['He was lonely', 'He wanted the cheese', 'He loved birdsong', 'He was afraid of her'], answer: 1 },
      { q: 'What made the crow drop the cheese?', choices: ['She sneezed', 'The branch was slippery', 'She opened her beak to sing', 'Another bird attacked her'], answer: 2 },
      { q: 'What is the lesson of the story?', choices: ['Share your food', 'Sing every day', 'Beware of flattery', 'Trust the fox'], answer: 2 },
      { q: 'The word "flattered" suggests the crow felt…', choices: ['angry', 'pleased by praise', 'frightened', 'confused'], answer: 1 },
    ],
  },
  {
    id: 'p2', title: 'Extract: The Wind in the Willows (adapted)', free: false,
    text: 'The Mole had been working very hard all morning, spring-cleaning his little home. First with brooms, then with dusters; then on ladders and steps and chairs, with a brush and a pail of whitewash — till he had dust in his throat and eyes, splashes of whitewash all over his black fur, and an aching back and weary arms. Spring was moving in the air above him and in the earth below and around him, and even in his dark and lowly little house — it made him suddenly restless. He flung down his brush and said, "Bother!" and "O blow!" and also "Hang spring-cleaning!" and bolted out of the house without even waiting to put on his coat.',
    questions: [
      { q: 'What was the Mole doing before he left?', choices: ['Resting', 'Spring-cleaning', 'Cooking lunch', 'Reading'], answer: 1 },
      { q: 'How did the Mole feel about spring-cleaning in that moment?', choices: ['Proud', 'Peaceful', 'Fed up', 'Curious'], answer: 2 },
      { q: '"Bolted out" tells us he left…', choices: ['slowly and sadly', 'suddenly and quickly', 'through the back door', 'with his coat on'], answer: 1 },
      { q: 'Spring made the Mole feel…', choices: ['sleepy', 'grateful for chores', 'restless', 'ill'], answer: 2 },
    ],
  },
  {
    id: 'p3', title: 'Non-fiction: The Voyager Probes', free: false,
    text: 'Launched in 1977, the twin Voyager probes were built to study the outer planets. Voyager 1 visited Jupiter and Saturn before heading upwards out of the plane of the planets; Voyager 2 went on to Uranus and Neptune, completing a "grand tour". Each spacecraft carries a golden record: sounds and images of Earth, from whale song to Beethoven. Powered by slowly decaying plutonium, their instruments fade a little more each year, yet both still whisper data home across billions of miles — signals so faint that it takes more than a day for them to arrive, travelling at the speed of light.',
    questions: [
      { q: 'When were the Voyager probes launched?', choices: ['1957', '1977', '1997', '2007'], answer: 1 },
      { q: 'Which planets did Voyager 2 visit that Voyager 1 did not?', choices: ['Jupiter and Saturn', 'Uranus and Neptune', 'Mars and Venus', 'Mercury and Pluto'], answer: 1 },
      { q: 'What powers the probes as they age?', choices: ['Solar panels', 'Batteries recharged from Earth', 'Decaying plutonium', 'Nuclear reactors kept warm by the Sun'], answer: 2 },
      { q: 'Why do the signals take more than a day to arrive?', choices: ['The antennas are small', 'They travel slower than light', 'The distances are billions of miles', 'The golden record blocks the signal'], answer: 2 },
    ],
  },
];

// ---------- API ----------
const loginAttempts = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 8) { loginAttempts.set(ip, arr); return true; }
  arr.push(now); loginAttempts.set(ip, arr); return false;
}

async function handleApi(req, res, pathname) {
  await dbReady;
  const user = getUser(req);
  const ip = req.socket.remoteAddress || '?';
  const url = new URL(req.url, 'http://x');
  const route = `${req.method} ${pathname}`;

  if (route === 'GET /api/health') {
    return sendJson(res, 200, {
      ok: true,
      storage: TURSO_URL ? 'turso' : 'file',
      cloudLoaded,
      users: db.users.length,
      uptimeSec: Math.round(process.uptime()),
    });
  }

  if (route === 'POST /api/signup') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim().slice(0, 60);
    const password = String(body.password || '');
    if (!name || name.length < 2) return sendJson(res, 400, { error: 'Please enter your name' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email' });
    if (SCHOOL_DOMAINS.length && !SCHOOL_DOMAINS.some((d) => email.endsWith(d)))
      return sendJson(res, 400, { error: `Please use your school email (${SCHOOL_DOMAINS.join(' or ')})` });
    if (password.length < 6) return sendJson(res, 400, { error: 'Password needs at least 6 characters' });
    if (db.users.some((u) => u.email === email)) return sendJson(res, 400, { error: 'Email already registered — try logging in' });
    const salt = crypto.randomBytes(16).toString('hex');
    const nu = {
      id: crypto.randomUUID(), email, name, role: 'student', salt,
      hash: hashPassword(password, salt), createdAt: Date.now(),
      access: null, xp: 0, streak: 0, lastPractice: null,
    };
    db.users.push(nu);
    db.messages.push({ id: crypto.randomUUID(), from: 'admin', to: email, body: `Welcome to ReaderHub, ${name}! Pick a pass on your dashboard, then message me here if you need anything.`, at: Date.now(), read: false });
    saveDbSoon();
    setSession(res, nu);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/login') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many attempts, wait a minute' });
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const email = String(body.email || '').trim().toLowerCase();
    const u = db.users.find((x) => x.email === email);
    if (!u || hashPassword(String(body.password || ''), u.salt) !== u.hash)
      return sendJson(res, 401, { error: 'Wrong email or password' });
    setSession(res, u);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/logout') { clearSession(req, res); return sendJson(res, 200, { ok: true }); }

  if (route === 'GET /api/me') {
    if (!user) return sendJson(res, 401, { error: 'Not logged in' });
    const pendingOrder = db.orders.find((o) => o.email === user.email && o.status === 'pending');
    const wl = db.waitlist.find((w) => w.email === user.email && (w.status === 'pending' || w.status === 'approved'));
    return sendJson(res, 200, {
      email: user.email, name: user.name, role: user.role,
      access: accessActive(user) ? { plan: user.access.plan, expiresAt: user.access.expiresAt } : null,
      pendingOrder: pendingOrder ? { plan: pendingOrder.plan, at: pendingOrder.at } : null,
      waitlist: wl ? { plan: wl.plan, status: wl.status, at: wl.at } : null,
      weekResetAt: nextSundayCutoff(),
      bannedUntil: user.ban && user.ban.until > Date.now() ? user.ban.until : null,
      xp: user.xp, streak: user.streak, unread: unreadCount(user, 'admin'),
    });
  }

  if (!user) return sendJson(res, 401, { error: 'Not logged in' });

  if (route === 'POST /api/change-password') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    if (hashPassword(String(body.current || ''), user.salt) !== user.hash)
      return sendJson(res, 400, { error: 'Current password is wrong' });
    if (String(body.next || '').length < 6) return sendJson(res, 400, { error: 'New password too short' });
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = hashPassword(String(body.next), user.salt);
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/order-pass') {
    weeklyReset();
    const body = await readBody(req);
    if (!body || !PLANS[body.plan]) return sendJson(res, 400, { error: 'Pick a plan' });
    if (user.ban && user.ban.until > Date.now())
      return sendJson(res, 403, { error: `Banned from getting passes until ${new Date(user.ban.until).toLocaleDateString('en-GB')}` });
    if (db.orders.some((o) => o.email === user.email && o.status === 'pending'))
      return sendJson(res, 400, { error: 'You are already on the waiting list' });
    db.orders.push({ id: crypto.randomUUID(), email: user.email, name: user.name, plan: body.plan, status: 'pending', at: Date.now() });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  // approval waiting list: student picks a size, admin approves
  if (route === 'POST /api/waitlist') {
    weeklyReset();
    const body = await readBody(req);
    if (!body || !PLANS[body.plan]) return sendJson(res, 400, { error: 'Pick a plan' });
    if (user.ban && user.ban.until > Date.now())
      return sendJson(res, 403, { error: `Banned from getting passes until ${new Date(user.ban.until).toLocaleDateString('en-GB')}` });
    if (db.waitlist.some((w) => w.email === user.email && (w.status === 'pending' || w.status === 'approved')))
      return sendJson(res, 400, { error: 'You already have a spot requested or approved' });
    db.waitlist.push({ id: crypto.randomUUID(), email: user.email, name: user.name, plan: body.plan, status: 'pending', at: Date.now() });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/practice') {
    return sendJson(res, 200, {
      passages: PASSAGES.map((p) => ({ id: p.id, title: p.title, text: p.text, locked: !(p.free || accessActive(user)) })),
    });
  }

  if (route === 'GET /api/quiz') {
    const p = PASSAGES.find((x) => x.id === url.searchParams.get('passageId'));
    if (!p) return sendJson(res, 404, { error: 'No such passage' });
    if (!(p.free || accessActive(user))) return sendJson(res, 403, { error: 'This passage needs an active pass' });
    // questions only — answers never leave the server
    return sendJson(res, 200, { questions: p.questions.map((q) => ({ q: q.q, choices: q.choices })) });
  }

  if (route === 'POST /api/practice/submit') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const p = PASSAGES.find((x) => x.id === body.passageId);
    if (!p) return sendJson(res, 404, { error: 'No such passage' });
    if (!(p.free || accessActive(user))) return sendJson(res, 403, { error: 'This passage needs an active pass' });
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const results = p.questions.map((q, i) => ({ correct: answers[i] === q.answer, correctIndex: q.answer }));
    const correct = results.filter((r) => r.correct).length;
    user.xp += correct * 10;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    user.streak = user.lastPractice === today ? user.streak : user.lastPractice === yesterday ? user.streak + 1 : 1;
    user.lastPractice = today;
    saveDbSoon();
    return sendJson(res, 200, { results, correct, total: p.questions.length, xp: user.xp, streak: user.streak });
  }

  if (route === 'GET /api/messages') {
    const thread = db.messages
      .filter((m) => (m.from === user.email && m.to === 'admin') || (m.from === 'admin' && m.to === user.email))
      .sort((a, b) => a.at - b.at)
      .map((m) => { if (m.to === user.email) m.read = true; return { from: m.from === 'admin' ? 'admin' : 'me', body: m.body, at: m.at }; });
    saveDbSoon();
    return sendJson(res, 200, { messages: thread });
  }

  if (route === 'POST /api/messages') {
    const body = await readBody(req);
    const text = String((body && body.body) || '').trim().slice(0, 2000);
    if (!text) return sendJson(res, 400, { error: 'Empty message' });
    db.messages.push({ id: crypto.randomUUID(), from: user.email, to: 'admin', body: text, at: Date.now(), read: false });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  // ---------- admin ----------
  if (user.role !== 'admin') return sendJson(res, 404, { error: 'Not found' });

  if (route === 'GET /api/admin/overview') {
    const students = db.users.filter((u) => u.role === 'student').map((u) => ({
      email: u.email, name: u.name, createdAt: u.createdAt,
      active: accessActive(u), plan: u.access ? u.access.plan : null,
      expiresAt: u.access ? u.access.expiresAt : null, xp: u.xp, streak: u.streak,
      bannedUntil: u.ban && u.ban.until > Date.now() ? u.ban.until : null,
      unread: unreadCount(user, u.email),
    }));
    weeklyReset();
    const orders = db.orders.filter((o) => o.status === 'pending');
    return sendJson(res, 200, { students, orders, weekResetAt: nextSundayCutoff() });
  }

  if (route === 'POST /api/admin/grant') {
    const body = await readBody(req);
    if (!body || !PLANS[body.plan]) return sendJson(res, 400, { error: 'Bad request' });
    const target = db.users.find((u) => u.email === String(body.email || '').toLowerCase());
    if (!target || target.role !== 'student') return sendJson(res, 404, { error: 'No such student' });
    target.access = { plan: body.plan, expiresAt: passExpiry(body.plan) };
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/admin/revoke') {
    const body = await readBody(req);
    const target = db.users.find((u) => u.email === String((body && body.email) || '').toLowerCase());
    if (!target || target.role !== 'student') return sendJson(res, 404, { error: 'No such student' });
    target.access = null;
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/admin/ban') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const target = db.users.find((u) => u.email === String(body.email || '').toLowerCase());
    if (!target || target.role !== 'student') return sendJson(res, 404, { error: 'No such student' });
    const days = Number(body.days);
    if (!Number.isFinite(days) || days <= 0) return sendJson(res, 400, { error: 'Ban length must be a positive number of days' });
    target.ban = { until: Date.now() + Math.min(days, 3650) * 86400000 };
    target.access = null; // banning also strips any active pass
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/admin/unban') {
    const body = await readBody(req);
    const target = db.users.find((u) => u.email === String((body && body.email) || '').toLowerCase());
    if (!target || target.role !== 'student') return sendJson(res, 404, { error: 'No such student' });
    target.ban = null;
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/admin/complete-order') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const o = db.orders.find((x) => x.id === body.id && x.status === 'pending');
    if (!o) return sendJson(res, 404, { error: 'No such order' });
    const target = db.users.find((u) => u.email === o.email);
    if (!target) return sendJson(res, 404, { error: 'Student gone' });
    o.status = 'completed';
    target.access = { plan: o.plan, expiresAt: passExpiry(o.plan) }; // always ends a Sunday 18:00
    db.messages.push({ id: crypto.randomUUID(), from: 'admin', to: target.email, body: `Payment received — your pass is active until Sunday 6pm. Practice is unlocked. Good luck!`, at: Date.now(), read: false });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/admin/remove-order') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const o = db.orders.find((x) => x.id === body.id && x.status === 'pending');
    if (!o) return sendJson(res, 404, { error: 'No such order' });
    o.status = 'removed';
    db.messages.push({ id: crypto.randomUUID(), from: 'admin', to: o.email, body: 'Your pass order was removed from the waiting list. Message me if you think that is a mistake.', at: Date.now(), read: false });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/admin/waitlist') {
    weeklyReset();
    return sendJson(res, 200, {
      pending: db.waitlist.filter((w) => w.status === 'pending'),
      approved: db.waitlist.filter((w) => w.status === 'approved'),
      weekResetAt: nextSundayCutoff(),
    });
  }

  if (route === 'POST /api/admin/waitlist/approve') {
    const body = await readBody(req);
    const w = db.waitlist.find((x) => x.id === (body && body.id) && x.status === 'pending');
    if (!w) return sendJson(res, 404, { error: 'No such request' });
    w.status = 'approved'; w.approvedAt = Date.now();
    db.messages.push({ id: crypto.randomUUID(), from: 'admin', to: w.email,
      body: `You're approved for the ${PLANS[w.plan].label} waiting list (${PLANS[w.plan].price}). Bring ${PLANS[w.plan].price} to your coach before Sunday 6pm to activate your pass.`,
      at: Date.now(), read: false });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/admin/waitlist/decline') {
    const body = await readBody(req);
    const w = db.waitlist.find((x) => x.id === (body && body.id) && x.status === 'pending');
    if (!w) return sendJson(res, 404, { error: 'No such request' });
    w.status = 'declined';
    db.messages.push({ id: crypto.randomUUID(), from: 'admin', to: w.email, body: 'Your waiting list request was declined this time. Message me if you have a question.', at: Date.now(), read: false });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/admin/thread') {
    const email = url.searchParams.get('student') || '';
    const thread = db.messages
      .filter((m) => (m.from === email && m.to === 'admin') || (m.from === 'admin' && m.to === email))
      .sort((a, b) => a.at - b.at)
      .map((m) => { if (m.to === 'admin') m.read = true; return { from: m.from === 'admin' ? 'me' : 'them', body: m.body, at: m.at }; });
    saveDbSoon();
    return sendJson(res, 200, { messages: thread });
  }

  if (route === 'POST /api/admin/reply') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const to = String(body.to || '').toLowerCase();
    const text = String(body.body || '').trim().slice(0, 2000);
    const target = db.users.find((u) => u.email === to);
    if (!target || !text) return sendJson(res, 400, { error: 'Bad message' });
    db.messages.push({ id: crypto.randomUUID(), from: 'admin', to, body: text, at: Date.now(), read: false });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/admin/broadcast') {
    const body = await readBody(req);
    const text = String((body && body.body) || '').trim().slice(0, 2000);
    if (!text) return sendJson(res, 400, { error: 'Empty message' });
    for (const u of db.users.filter((x) => x.role === 'student'))
      db.messages.push({ id: crypto.randomUUID(), from: 'admin', to: u.email, body: text, at: Date.now(), read: false });
    saveDbSoon();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // authed pages redirect to login when missing
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Weekly reset: ALL passes and the waiting list cycle at Sunday 18:00 London time.
function londonWall(ms) { return new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'Europe/London' })); }
function lastSundayCutoff(nowMs) {
  const w = londonWall(nowMs || Date.now());
  const d = new Date(w); d.setHours(18, 0, 0, 0);
  while (d.getDay() !== 0 || d > w) d.setDate(d.getDate() - 1);
  return d;
}
function nextSundayCutoff(nowMs) { return lastSundayCutoff(nowMs).getTime() + 7 * 86400000; }
function passExpiry(planId) { return nextSundayCutoff() + (PLANS[planId].days - 7) * 86400000; }
function weeklyReset() {
  if (!db) return false;
  const cutoff = lastSundayCutoff();
  if (!db.lastWeeklyReset) db.lastWeeklyReset = 0;
  if (db.lastWeeklyReset >= cutoff.getTime()) return false;
  let cleared = 0;
  db.users.forEach((u) => {
    if (u.role === 'student' && u.access && u.access.expiresAt <= cutoff.getTime() + 60000) { u.access = null; cleared++; }
  });
  let expired = 0;
  (db.orders || []).forEach((o) => { if (o.status === 'pending' && londonWall(o.at) < cutoff) { o.status = 'expired'; expired++; } });
  (db.waitlist || []).forEach((w) => { if ((w.status === 'pending' || w.status === 'approved') && londonWall(w.at) < cutoff) { w.status = 'expired'; expired++; } });
  db.lastWeeklyReset = cutoff.getTime();
  console.log(`weekly reset to ${cutoff.toISOString()}: cleared ${cleared} pass(es), expired ${expired} order(s)`);
  saveDbSoon();
  return true;
}
setInterval(weeklyReset, 5 * 60000).unref();

loadDb();
dbReady.then(() => { try { weeklyReset(); } catch (e) { console.error(e); } });
http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error(e);
    try { sendJson(res, 500, { error: 'Server error' }); } catch {}
  }
}).listen(PORT, () => console.log(`ReaderHub running on http://localhost:${PORT}`));
