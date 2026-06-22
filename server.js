const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'relaxfps-friends-data.json');
const ADMIN_WEB_DIR = path.join(__dirname, 'admin');
const ADMIN_PASSWORD = String(process.env.RELAXFPS_ADMIN_PASSWORD || '');
const ADMIN_TOTP_SECRET = String(process.env.RELAXFPS_ADMIN_TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase();
const ADMIN_SESSION_SECRET = String(process.env.RELAXFPS_ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
const ADMIN_LOGIN_MAX_ATTEMPTS = Math.max(3, Math.min(Number(process.env.RELAXFPS_ADMIN_LOGIN_MAX_ATTEMPTS || 5), 20));
const ADMIN_LOGIN_BLOCK_MINUTES = Math.max(1, Math.min(Number(process.env.RELAXFPS_ADMIN_LOGIN_BLOCK_MINUTES || 15), 1440));

const adminSessions = new Map(); // token -> {createdAt, expiresAt, lastUsedAt, ip, userAgent}
const adminLoginAttempts = new Map(); // ip -> {count, blockedUntil, lastAttemptAt}

const httpServer = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((error) => {
    console.warn('[HTTP ERROR]', error.message);
    if (!res.headersSent) sendJsonResponse(res, 500, { ok: false, message: 'Internal server error' });
    else res.end();
  });
});

const wss = new WebSocket.Server({ server: httpServer });

const clients = new Map(); // RelaxFPS ID -> Set<WebSocket>
const offlineQueue = new Map(); // RelaxFPS ID -> queued payloads
const relayRooms = new Map(); // room -> {members:Set<string>, lastActive:number, chunks:number}
const groupCallRooms = new Map(); // groupId -> {members:Set<string>, lastActive:number, chunks:number}
const activeFriendUsage = new Map(); // RelaxFPS ID -> {lastCommitMs, timezoneOffsetMinutes}

function defaultAppSettings() {
  return {
    maintenanceMode: false,
    maintenanceMessage: '',
    maintenanceUntil: '',
    friendsEnabled: true,
    communityEnabled: true,
    relaxBenchEnabled: true,
    winsimEnabled: true,
    gameHubEnabled: true,
    appLockEnabled: true,
    soundBoosterEnabled: true,
    virtualRamEnabled: true,
    overlayEnabled: true,
    messagingEnabled: true,
    imageSharingEnabled: true,
    voiceCallEnabled: true,
    relayVoiceEnabled: true,
    forceUpdate: false,
    latestVersion: '',
    minimumVersion: '',
    updateMessage: '',
    playStoreUrl: '',
    freeFriendMinutes: 15,
    premiumFriendMinutes: 60,
    appLockFailLimit: 3,
    appLockLockMinutes: 2,
    betaToolsEnabled: true,
    adsEnabled: true,
    telemetryEnabled: true,
    updatedAt: '',
  };
}

function normalizeAppSettings(value) {
  return { ...defaultAppSettings(), ...(value && typeof value === 'object' ? value : {}) };
}

const state = {
  profiles: {}, // id -> {id,name,lastSeen}
  friendships: {}, // id -> [friendId]
  friendRequests: [], // {from,to,name,time,status}
  messages: {}, // conversationKey -> message payloads
  announcements: [], // {id,title,body,imageBase64,videoBase64,link,buttonLabel,panelId,active,order,time}
  customPanels: [], // {id,title,body,imageBase64,buttonLabel,buttonUrl,time}
  feedback: [], // {id,from,title,body,reply,status,time}
  developerMessages: [], // {id,to,title,body,time,read}
  premiumUsers: {}, // id -> {id,until,months,time}
  bannedUsers: {}, // id -> {id,reason,until,time}
  appSettings: defaultAppSettings(),
  crashReports: [], // {id,from,screen,error,stack,time}
  clientEvents: [], // {id,from,event,meta,time}
  testUsers: {}, // id -> {id,enabled,time}
  userNotes: {}, // id -> {id,note,time}
  backups: [], // {id,time,size,summary,data}
  adminAuditLog: [], // {action, detail, time}
  adminSecurity: { wrongPasswordCount: 0, lastWrongPasswordAt: null, sessionMinutes: 60 },
  benchmarkScores: {}, // RelaxFPS ID -> latest persistent RelaxBench result
  promoCodes: {}, // CODE -> reward definition and usage state
  groups: {}, // groupId -> {id,name,ownerId,admins,members,createdAt,updatedAt}
  groupInvites: [], // {id,groupId,from,to,status,time}
  groupMessages: {}, // groupId -> message payloads
  friendUsage: {}, // RelaxFPS ID -> {day,usedSeconds,timezoneOffsetMinutes,updatedAt}
  dailyWheel: {}, // RelaxFPS ID -> persistent wheel state, history and temporary grants
  premiumDiscounts: {}, // RelaxFPS ID -> active Google Play offer entitlement
  flashOffers: {}, // RelaxFPS ID -> persistent 3-day flash offer schedule
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      Object.assign(state, parsed);
      state.announcements = Array.isArray(state.announcements) ? state.announcements : [];
      state.customPanels = Array.isArray(state.customPanels) ? state.customPanels : [];
      state.feedback = Array.isArray(state.feedback) ? state.feedback : [];
      state.developerMessages = Array.isArray(state.developerMessages) ? state.developerMessages : [];
      state.premiumUsers = state.premiumUsers || {};
      state.bannedUsers = state.bannedUsers || {};
      state.appSettings = normalizeAppSettings(state.appSettings);
      if (Number(state.appSettings.appLockLockMinutes || 0) === 10) state.appSettings.appLockLockMinutes = 2;
      state.crashReports = Array.isArray(state.crashReports) ? state.crashReports : [];
      state.clientEvents = Array.isArray(state.clientEvents) ? state.clientEvents : [];
      state.testUsers = state.testUsers || {};
      state.userNotes = state.userNotes || {};
      state.backups = Array.isArray(state.backups) ? state.backups : [];
      state.adminAuditLog = Array.isArray(state.adminAuditLog) ? state.adminAuditLog : [];
      state.adminSecurity = state.adminSecurity || { wrongPasswordCount: 0, lastWrongPasswordAt: null, sessionMinutes: 60 };
      state.benchmarkScores = state.benchmarkScores || {};
      state.promoCodes = state.promoCodes || {};
      state.groups = state.groups || {};
      state.groupInvites = Array.isArray(state.groupInvites) ? state.groupInvites : [];
      state.groupMessages = state.groupMessages || {};
      state.friendUsage = state.friendUsage || {};
      state.dailyWheel = state.dailyWheel || {};
      state.premiumDiscounts = state.premiumDiscounts || {};
      state.flashOffers = state.flashOffers || {};
    }
  } catch (error) {
    console.warn('[STATE] Could not load data file:', error.message);
  }
}

let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 300);
}

function adminAudit(action, detail = {}) {
  state.adminAuditLog = state.adminAuditLog || [];
  state.adminAuditLog.push({ action, detail, time: new Date().toISOString() });
  if (state.adminAuditLog.length > 600) state.adminAuditLog = state.adminAuditLog.slice(-600);
  saveStateSoon();
}

function saveStateNow() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn('[STATE] Could not save data file:', error.message);
  }
}


function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJsonResponse(res, statusCode, payload, extraHeaders = {}) {
  applySecurityHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendTextResponse(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  applySecurityHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end(text);
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function readJsonBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function secureStringEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length || aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCodeForCounter(secret, counter) {
  const key = decodeBase32(secret);
  const buffer = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  buffer.writeUInt32BE(high >>> 0, 0);
  buffer.writeUInt32BE(low, 4);
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(value % 1000000).padStart(6, '0');
}

function verifyTotp(code) {
  if (!ADMIN_TOTP_SECRET) return true;
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let drift = -1; drift <= 1; drift += 1) {
    if (secureStringEqual(clean, totpCodeForCounter(ADMIN_TOTP_SECRET, counter + drift))) return true;
  }
  return false;
}

function createAdminSession(req) {
  const now = Date.now();
  const minutes = Math.max(5, Math.min(Number(state.adminSecurity?.sessionMinutes || 60), 1440));
  const nonce = crypto.randomBytes(32).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(nonce).digest('base64url');
  const token = `${nonce}.${signature}`;
  const session = {
    createdAt: now,
    expiresAt: now + minutes * 60 * 1000,
    lastUsedAt: now,
    ip: requestIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
  };
  adminSessions.set(token, session);
  return { token, ...session, sessionMinutes: minutes };
}

function validateAdminSession(token, touch = false) {
  const clean = String(token || '');
  if (!clean || !clean.includes('.')) return null;
  const [nonce, signature] = clean.split('.', 2);
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(nonce).digest('base64url');
  if (!secureStringEqual(signature, expected)) return null;
  const session = adminSessions.get(clean);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(clean);
    return null;
  }
  if (touch) session.lastUsedAt = Date.now();
  return session;
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
}

function loginAttemptState(ip) {
  const stateForIp = adminLoginAttempts.get(ip) || { count: 0, blockedUntil: 0, lastAttemptAt: 0 };
  if (stateForIp.blockedUntil > 0 && stateForIp.blockedUntil <= Date.now()) {
    stateForIp.count = 0;
    stateForIp.blockedUntil = 0;
  }
  adminLoginAttempts.set(ip, stateForIp);
  return stateForIp;
}

function recordFailedAdminLogin(ip) {
  const attempt = loginAttemptState(ip);
  attempt.count += 1;
  attempt.lastAttemptAt = Date.now();
  if (attempt.count >= ADMIN_LOGIN_MAX_ATTEMPTS) {
    const multiplier = Math.min(4, Math.max(1, attempt.count - ADMIN_LOGIN_MAX_ATTEMPTS + 1));
    attempt.blockedUntil = Date.now() + ADMIN_LOGIN_BLOCK_MINUTES * multiplier * 60 * 1000;
  }
  adminLoginAttempts.set(ip, attempt);
  return attempt;
}

function serveAdminAsset(res, fileName, contentType) {
  const safeNames = new Set(['index.html', 'app.js', 'styles.css', 'favicon.svg']);
  if (!safeNames.has(fileName)) return sendTextResponse(res, 404, 'Not found');
  const filePath = path.join(ADMIN_WEB_DIR, fileName);
  if (!fs.existsSync(filePath)) return sendTextResponse(res, 404, 'Admin Studio asset not found');
  applySecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': fileName === 'index.html' ? 'no-store, max-age=0' : 'public, max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleHttpRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
    sendJsonResponse(res, 200, {
      ok: true,
      service: 'RelaxFPS Friends Server',
      version: '6.0.0-web-admin',
      online: onlineIds().length,
      adminStudio: true,
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/api/status') {
    sendJsonResponse(res, 200, {
      ok: true,
      configured: ADMIN_PASSWORD.length >= 12,
      totpRequired: ADMIN_TOTP_SECRET.length >= 16,
      sessionMinutes: Math.max(5, Math.min(Number(state.adminSecurity?.sessionMinutes || 60), 1440)),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/admin/api/login') {
    const ip = requestIp(req);
    const attempt = loginAttemptState(ip);
    if (attempt.blockedUntil > Date.now()) {
      const retryAfter = Math.ceil((attempt.blockedUntil - Date.now()) / 1000);
      sendJsonResponse(res, 429, {
        ok: false,
        message: `Çok fazla hatalı giriş. ${Math.ceil(retryAfter / 60)} dakika sonra tekrar dene.`,
        retryAfter,
      }, { 'Retry-After': String(retryAfter) });
      return;
    }
    if (ADMIN_PASSWORD.length < 12) {
      sendJsonResponse(res, 503, { ok: false, message: 'RELAXFPS_ADMIN_PASSWORD sunucuda ayarlanmamış veya çok kısa.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, 8192);
    } catch (error) {
      sendJsonResponse(res, error.statusCode || 400, { ok: false, message: error.message });
      return;
    }
    const passwordOk = secureStringEqual(body.password, ADMIN_PASSWORD);
    const totpOk = verifyTotp(body.otp);
    if (!passwordOk || !totpOk) {
      const failed = recordFailedAdminLogin(ip);
      state.adminSecurity = state.adminSecurity || {};
      state.adminSecurity.wrongPasswordCount = Number(state.adminSecurity.wrongPasswordCount || 0) + 1;
      state.adminSecurity.lastWrongPasswordAt = new Date().toISOString();
      adminAudit('admin_web_login_failed', { ip, count: failed.count, passwordOk, totpOk });
      sendJsonResponse(res, 401, { ok: false, message: 'Parola veya doğrulama kodu hatalı.' });
      return;
    }
    adminLoginAttempts.delete(ip);
    state.adminSecurity = state.adminSecurity || {};
    state.adminSecurity.wrongPasswordCount = 0;
    const session = createAdminSession(req);
    adminAudit('admin_web_login', { ip, totp: ADMIN_TOTP_SECRET.length >= 16, expiresAt: new Date(session.expiresAt).toISOString() });
    sendJsonResponse(res, 200, {
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      sessionMinutes: session.sessionMinutes,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/admin/api/logout') {
    const token = bearerToken(req);
    if (token) adminSessions.delete(token);
    sendJsonResponse(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
    serveAdminAsset(res, 'index.html', 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && pathname === '/admin/app.js') {
    serveAdminAsset(res, 'app.js', 'application/javascript; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && pathname === '/admin/styles.css') {
    serveAdminAsset(res, 'styles.css', 'text/css; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && pathname === '/admin/favicon.svg') {
    serveAdminAsset(res, 'favicon.svg', 'image/svg+xml; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    sendTextResponse(res, 200, 'RELAXFPS Friends Server is running. Admin Studio: /admin');
    return;
  }

  sendTextResponse(res, 404, 'Not found');
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (session.expiresAt <= now) adminSessions.delete(token);
  }
  for (const [ip, attempt] of adminLoginAttempts.entries()) {
    if ((attempt.blockedUntil || attempt.lastAttemptAt || 0) < now - 24 * 60 * 60 * 1000) adminLoginAttempts.delete(ip);
  }
}, 60 * 1000).unref?.();

function normalizeId(value) {
  return String(value || '').trim().toUpperCase();
}

function validId(id) {
  return id.startsWith('RFX-') && id.length >= 8;
}

function conversationKey(a, b) {
  return [normalizeId(a), normalizeId(b)].sort().join('__');
}

function socketsFor(id) {
  return clients.get(normalizeId(id)) || new Set();
}

function isOnline(id) {
  const sockets = clients.get(normalizeId(id));
  return !!sockets && sockets.size > 0;
}

function addClient(id, socket) {
  const clean = normalizeId(id);
  const sockets = clients.get(clean) || new Set();
  sockets.add(socket);
  clients.set(clean, sockets);
}

function removeClient(id, socket) {
  const clean = normalizeId(id);
  const sockets = clients.get(clean);
  if (!sockets) return true;

  sockets.delete(socket);
  if (sockets.size === 0) {
    clients.delete(clean);
    return true;
  }

  return false;
}

function ensureProfile(id, name = '') {
  const clean = normalizeId(id);
  if (!validId(clean)) return null;
  const current = state.profiles[clean] || { id: clean, name: 'RelaxFPS User', lastSeen: null };
  state.profiles[clean] = {
    ...current,
    id: clean,
    name: String(name || current.name || 'RelaxFPS User').slice(0, 40),
    lastSeen: new Date().toISOString(),
  };
  state.friendships[clean] = state.friendships[clean] || [];
  saveStateSoon();
  return state.profiles[clean];
}

function addFriendship(a, b) {
  const aa = normalizeId(a);
  const bb = normalizeId(b);
  if (!validId(aa) || !validId(bb) || aa === bb) return;
  state.friendships[aa] = Array.from(new Set([...(state.friendships[aa] || []), bb]));
  state.friendships[bb] = Array.from(new Set([...(state.friendships[bb] || []), aa]));
  saveStateSoon();
}

function removeFriendship(a, b) {
  const aa = normalizeId(a);
  const bb = normalizeId(b);
  state.friendships[aa] = (state.friendships[aa] || []).filter((id) => id !== bb);
  state.friendships[bb] = (state.friendships[bb] || []).filter((id) => id !== aa);
  saveStateSoon();
}

function send(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function sendTo(id, payload) {
  for (const socket of socketsFor(id)) {
    send(socket, payload);
  }
}

function sendFriendsListToId(id) {
  for (const socket of socketsFor(id)) {
    sendFriendsList(socket, normalizeId(id));
  }
}

function onlineIds() {
  return Array.from(clients.keys());
}

function normalizeTimezoneOffset(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-840, Math.min(840, Math.round(parsed)));
}

function friendUsageDayKey(timezoneOffsetMinutes = 0, nowMs = Date.now()) {
  const shifted = new Date(nowMs + normalizeTimezoneOffset(timezoneOffsetMinutes) * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function friendUsageRecord(id, timezoneOffsetMinutes = 0) {
  const clean = normalizeId(id);
  state.friendUsage = state.friendUsage || {};
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  const day = friendUsageDayKey(offset);
  const current = state.friendUsage[clean];
  if (!current || current.day !== day) {
    state.friendUsage[clean] = {
      day,
      usedSeconds: 0,
      timezoneOffsetMinutes: offset,
      updatedAt: new Date().toISOString(),
    };
  } else {
    current.timezoneOffsetMinutes = offset;
  }
  return state.friendUsage[clean];
}

function commitFriendUsage(id, nowMs = Date.now()) {
  const clean = normalizeId(id);
  const active = activeFriendUsage.get(clean);
  const offset = active ? active.timezoneOffsetMinutes : (state.friendUsage?.[clean]?.timezoneOffsetMinutes || 0);
  const record = friendUsageRecord(clean, offset);
  if (active) {
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - active.lastCommitMs) / 1000));
    if (elapsedSeconds > 0) {
      record.usedSeconds = Math.max(0, Number(record.usedSeconds || 0)) + elapsedSeconds;
      record.updatedAt = new Date(nowMs).toISOString();
      active.lastCommitMs += elapsedSeconds * 1000;
      saveStateSoon();
    }
  }
  return record;
}

function startFriendUsage(id, timezoneOffsetMinutes = 0) {
  const clean = normalizeId(id);
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  friendUsageRecord(clean, offset);
  const existing = activeFriendUsage.get(clean);
  if (existing) {
    commitFriendUsage(clean);
    existing.timezoneOffsetMinutes = offset;
    return;
  }
  activeFriendUsage.set(clean, { lastCommitMs: Date.now(), timezoneOffsetMinutes: offset });
}

function stopFriendUsage(id) {
  const clean = normalizeId(id);
  commitFriendUsage(clean);
  activeFriendUsage.delete(clean);
}

function friendUsageSnapshot(id, timezoneOffsetMinutes = null) {
  const clean = normalizeId(id);
  if (timezoneOffsetMinutes !== null && timezoneOffsetMinutes !== undefined) {
    const active = activeFriendUsage.get(clean);
    if (active) active.timezoneOffsetMinutes = normalizeTimezoneOffset(timezoneOffsetMinutes);
  }
  const record = commitFriendUsage(clean);
  const premium = !!isPremiumGranted(clean);
  const minutes = premium
    ? Number(state.appSettings?.premiumFriendMinutes || 60)
    : Number(state.appSettings?.freeFriendMinutes || 15);
  const wheel = dailyWheelRecord(clean);
  const onlineBonusSeconds = Number(wheel.grants?.onlineBonusUntil || 0) > Date.now()
    ? Math.max(0, Number(wheel.grants?.onlineBonusSeconds || 0))
    : 0;
  const limitSeconds = Math.max(0, Math.round(minutes * 60) + onlineBonusSeconds);
  const usedSeconds = Math.max(0, Number(record.usedSeconds || 0));
  return {
    id: clean,
    day: record.day,
    usedSeconds,
    limitSeconds,
    remainingSeconds: Math.max(0, limitSeconds - usedSeconds),
    timezoneOffsetMinutes: Number(record.timezoneOffsetMinutes || 0),
    premium,
    onlineBonusSeconds,
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}
function getRelayRoom(roomId) {
  const key = String(roomId || '').slice(0, 120);
  const current = relayRooms.get(key) || { members: new Set(), lastActive: Date.now(), chunks: 0 };
  current.lastActive = Date.now();
  relayRooms.set(key, current);
  return current;
}

function cleanupRelayRooms() {
  const now = Date.now();
  for (const [roomId, room] of relayRooms.entries()) {
    if (now - room.lastActive > 10 * 60 * 1000) relayRooms.delete(roomId);
  }
  for (const [groupId, room] of groupCallRooms.entries()) {
    if (now - room.lastActive > 10 * 60 * 1000) groupCallRooms.delete(groupId);
  }
}

setInterval(cleanupRelayRooms, 60 * 1000).unref?.();


function broadcastPresence(id, online) {
  const targets = state.friendships[id] || [];
  for (const targetId of targets) {
    sendTo(targetId, { type: 'presence', id, online });
  }
}

function publicProfile(id) {
  const profile = state.profiles[id] || { id, name: 'Relax Friend' };
  return {
    id,
    name: profile.name || 'Relax Friend',
    online: isOnline(id),
    lastSeen: profile.lastSeen || null,
  };
}

function sendFriendsList(socket, id) {
  const friends = (state.friendships[id] || []).map(publicProfile);
  send(socket, { type: 'friends_list', id, friends, onlineIds: onlineIds() });
}

function flushQueue(id) {
  const sockets = Array.from(socketsFor(id)).filter((socket) => socket.readyState === WebSocket.OPEN);
  if (!sockets.length) return;

  const queue = offlineQueue.get(id) || [];
  if (!queue.length) return;

  for (const payload of queue) {
    sendTo(id, payload);
    sendTo(payload.from, {
      type: 'delivered',
      to: id,
      messageId: payload.messageId,
      time: new Date().toISOString(),
      queued: true,
    });
  }

  offlineQueue.delete(id);
  console.log(`[QUEUE FLUSHED] ${id}: ${queue.length} message(s)`);
}

function storeMessage(payload) {
  const key = conversationKey(payload.from, payload.to);
  state.messages[key] = state.messages[key] || [];
  state.messages[key].push(payload);
  if (state.messages[key].length > 500) state.messages[key] = state.messages[key].slice(-500);
  saveStateSoon();
}

function historyFor(a, b, limit = 80) {
  const key = conversationKey(a, b);
  return (state.messages[key] || []).slice(-Math.min(Math.max(Number(limit) || 80, 1), 200));
}


function validGroupId(value) {
  return String(value || '').startsWith('GRP-');
}

function publicGroup(group) {
  if (!group) return null;
  const members = Array.from(new Set((group.members || []).map(normalizeId).filter(validId)));
  const admins = Array.from(new Set((group.admins || []).map(normalizeId).filter(validId)));
  return {
    id: group.id,
    name: String(group.name || 'RelaxFPS Group').slice(0, 80),
    ownerId: normalizeId(group.ownerId),
    members,
    admins,
    createdAt: group.createdAt || '',
    updatedAt: group.updatedAt || '',
    memberProfiles: members.map(publicProfile),
    onlineIds: members.filter(isOnline),
  };
}

function groupsForUser(id) {
  const clean = normalizeId(id);
  return Object.values(state.groups || {})
    .filter((group) => Array.isArray(group.members) && group.members.includes(clean))
    .map(publicGroup)
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

function pendingGroupInvitesFor(id) {
  const clean = normalizeId(id);
  return (state.groupInvites || [])
    .filter((invite) => invite.to === clean && invite.status === 'pending')
    .map((invite) => ({ ...invite, group: publicGroup(state.groups[invite.groupId]) }));
}

function sendGroupsState(id) {
  const clean = normalizeId(id);
  sendTo(clean, { type: 'groups_list', id: clean, groups: groupsForUser(clean), time: new Date().toISOString() });
  sendTo(clean, { type: 'group_invites', id: clean, invites: pendingGroupInvitesFor(clean), time: new Date().toISOString() });
}

function storeGroupMessage(groupId, payload) {
  state.groupMessages[groupId] = Array.isArray(state.groupMessages[groupId]) ? state.groupMessages[groupId] : [];
  state.groupMessages[groupId].push(payload);
  if (state.groupMessages[groupId].length > 1000) state.groupMessages[groupId] = state.groupMessages[groupId].slice(-1000);
  if (state.groups[groupId]) state.groups[groupId].updatedAt = new Date().toISOString();
  saveStateSoon();
}

function groupHistory(groupId, limit = 120) {
  const items = Array.isArray(state.groupMessages[groupId]) ? state.groupMessages[groupId] : [];
  return items.slice(-Math.min(Math.max(Number(limit) || 120, 1), 300));
}

function broadcastToGroup(groupId, payload, exceptId = '') {
  const group = state.groups[groupId];
  if (!group) return;
  for (const memberId of group.members || []) {
    if (memberId !== exceptId) sendTo(memberId, payload);
  }
}

function getGroupCallRoom(groupId) {
  const key = String(groupId || '').slice(0, 120);
  const room = groupCallRooms.get(key) || { members: new Set(), lastActive: Date.now(), chunks: 0 };
  room.lastActive = Date.now();
  groupCallRooms.set(key, room);
  return room;
}


function isBanned(id) {
  const clean = normalizeId(id);
  const ban = state.bannedUsers && state.bannedUsers[clean];
  if (!ban) return null;
  if (ban.until && Date.parse(ban.until) <= Date.now()) {
    delete state.bannedUsers[clean];
    saveStateSoon();
    return null;
  }
  return ban;
}

function isPremiumGranted(id) {
  const clean = normalizeId(id);
  const item = state.premiumUsers && state.premiumUsers[clean];
  if (!item) return null;
  if (item.until && Date.parse(item.until) <= Date.now()) {
    delete state.premiumUsers[clean];
    saveStateSoon();
    return null;
  }
  return item;
}

function publicAnnouncements() {
  const now = Date.now();
  return (state.announcements || [])
    .filter((item) => {
      if (!item || item.active === false) return false;
      if (!item.expiresAt) return true;
      const expires = Date.parse(item.expiresAt);
      return !Number.isFinite(expires) || expires > now;
    })
    .slice()
    .sort((a, b) => {
      const pinnedDiff = Number(b.pinned === true) - Number(a.pinned === true);
      if (pinnedDiff !== 0) return pinnedDiff;
      const priorityDiff = Number(b.priority || 0) - Number(a.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return (Number(a.order || 0) - Number(b.order || 0)) || String(b.time || '').localeCompare(String(a.time || ''));
    })
    .slice(0, 60)
    .map((item) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      category: item.category || 'Duyuru',
      sourceName: item.sourceName || 'RELAXFPS',
      link: item.link || '',
      buttonLabel: item.buttonLabel || '',
      buttonAction: item.buttonAction || '',
      panelId: item.panelId || '',
      imageBase64: item.imageBase64 || '',
      videoBase64: item.videoBase64 || '',
      active: item.active !== false,
      pinned: item.pinned === true,
      priority: Number(item.priority || 0),
      expiresAt: item.expiresAt || '',
      order: Number(item.order || 0),
      time: item.time,
    }));
}

function safeFileSize(file) {
  try { return fs.existsSync(file) ? fs.statSync(file).size : 0; } catch (_) { return 0; }
}

function buildAnalytics() {
  const events = state.clientEvents || [];
  const byEvent = {};
  for (const item of events) {
    const key = String(item.event || 'unknown');
    byEvent[key] = (byEvent[key] || 0) + 1;
  }
  const last24h = events.filter((item) => item.time && Date.parse(item.time) > Date.now() - 24 * 60 * 60 * 1000).length;
  return {
    eventsTotal: events.length,
    eventsLast24h: last24h,
    crashTotal: (state.crashReports || []).length,
    feedbackTotal: (state.feedback || []).length,
    premiumTotal: Object.keys(state.premiumUsers || {}).length,
    bannedTotal: Object.keys(state.bannedUsers || {}).length,
    testUsersTotal: Object.keys(state.testUsers || {}).length,
    byEvent,
  };
}

function adminSnapshot() {
  const users = Object.keys(state.profiles || {}).sort().map((id) => ({
    id,
    name: state.profiles[id]?.name || 'RelaxFPS User',
    lastSeen: state.profiles[id]?.lastSeen || null,
    online: isOnline(id),
    friendsCount: (state.friendships[id] || []).length,
    banned: !!isBanned(id),
    premium: !!isPremiumGranted(id),
    premiumUntil: isPremiumGranted(id)?.until || null,
    testUser: !!(state.testUsers && state.testUsers[id]),
    note: state.userNotes && state.userNotes[id] ? state.userNotes[id].note || '' : '',
    appVersion: state.profiles[id]?.appVersion || '',
    deviceModel: state.profiles[id]?.deviceModel || '',
    language: state.profiles[id]?.language || '',
  }));

  const bannedUsers = Object.keys(state.bannedUsers || {}).map((id) => ({
    id,
    ...(state.bannedUsers[id] || {}),
  }));

  const premiumUsers = Object.keys(state.premiumUsers || {}).map((id) => ({ id, ...(state.premiumUsers[id] || {}) }));

  return {
    type: 'admin_snapshot',
    ok: true,
    users,
    bannedUsers,
    premiumUsers,
    promoCodes: Object.values(state.promoCodes || {}).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
    announcements: (state.announcements || []).slice().sort((a, b) => (Number(a.order || 0) - Number(b.order || 0)) || String(b.time || '').localeCompare(String(a.time || ''))),
    customPanels: (state.customPanels || []).slice().reverse(),
    feedback: (state.feedback || []).slice().reverse(),
    developerMessages: (state.developerMessages || []).slice().reverse(),
    appSettings: normalizeAppSettings(state.appSettings),
    crashReports: (state.crashReports || []).slice().reverse().slice(0, 120),
    clientEvents: (state.clientEvents || []).slice().reverse().slice(0, 200),
    testUsers: Object.keys(state.testUsers || {}).map((id) => ({ id, ...(state.testUsers[id] || {}) })),
    userNotes: Object.keys(state.userNotes || {}).map((id) => ({ id, ...(state.userNotes[id] || {}) })),
    backups: (state.backups || []).map((b) => ({ id: b.id, time: b.time, size: b.size, summary: b.summary })).slice().reverse().slice(0, 20),
    adminAuditLog: (state.adminAuditLog || []).slice().reverse().slice(0, 160),
    adminSecurity: state.adminSecurity || {},
    adminAuth: {
      passwordConfigured: ADMIN_PASSWORD.length >= 12,
      totpEnabled: ADMIN_TOTP_SECRET.length >= 16,
      activeSessions: adminSessions.size,
    },
    analytics: buildAnalytics(),
    systemHealth: {
      profiles: Object.keys(state.profiles || {}).length,
      friendships: Object.keys(state.friendships || {}).length,
      relayRooms: relayRooms.size,
      groupCallRooms: groupCallRooms.size,
      groups: Object.keys(state.groups || {}).length,
      online: onlineIds().length,
      messages: Object.values(state.messages || {}).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0),
      dataFile: DATA_FILE,
      crashReports: (state.crashReports || []).length,
      clientEvents: (state.clientEvents || []).length,
      promoCodes: Object.keys(state.promoCodes || {}).length,
      wheelUsers: Object.keys(state.dailyWheel || {}).length,
      activeDiscounts: Object.keys(state.premiumDiscounts || {}).length,
      dataFileBytes: safeFileSize(DATA_FILE),
    },
    onlineIds: onlineIds(),
    time: new Date().toISOString(),
  };
}

function requireAdmin(socket, adminSessionToken, requestId) {
  const session = validateAdminSession(adminSessionToken, true);
  if (!session) {
    send(socket, {
      type: 'admin_error',
      ok: false,
      requestId,
      code: 'session_expired',
      message: 'Admin session expired or is invalid',
    });
    return false;
  }
  return true;
}

function pushDeveloperMessages(id, socket) {
  const clean = normalizeId(id);
  const items = (state.developerMessages || []).filter((item) => item.to === clean && item.read !== true).slice(-10);
  if (items.length) send(socket, { type: 'developer_messages', items });
}

function publicBenchmarkLeaderboard(limit = 100) {
  const maxItems = Math.max(10, Math.min(Number(limit || 100), 250));
  return Object.values(state.benchmarkScores || {})
    .filter((item) => item && Number(item.totalScore || 0) > 0)
    .sort((a, b) => Number(b.totalScore || 0) - Number(a.totalScore || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, maxItems)
    .map((item, index) => ({
      rank: index + 1,
      id: item.id,
      displayId: String(item.id || '').replace(/^(RFX-\d{2})\d{2}-(\d{2})\d{2}$/, '$1**-$2**'),
      manufacturer: item.manufacturer || '',
      model: item.model || 'Unknown device',
      androidVersion: item.androidVersion || '',
      totalScore: Number(item.totalScore || 0),
      categoryScores: item.categoryScores || {},
      updatedAt: item.updatedAt || '',
    }));
}



const DAILY_WHEEL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DAILY_WHEEL_CODE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const DAILY_WHEEL_REWARDS = [
  { id: 'online_20m', label: '+20 dakika çevrim içi süre', wheelLabel: '+20 DK\nONLINE', weight: 20, kind: 'online' },
  { id: 'premium_code_1h', label: '1 saat Premium referans kodu', wheelLabel: '1 SAAT\nPREMIUM KOD', weight: 4, kind: 'code' },
  { id: 'winsim_1d', label: '1 gün WinSimPro oturumu', wheelLabel: 'WINSIMPRO\n1 GÜN', weight: 10, kind: 'grant' },
  { id: 'discount_20', label: 'Premium ilk ay %20 indirim kodu', wheelLabel: '%20\nİNDİRİM', weight: 2, kind: 'code' },
  { id: 'retry', label: 'Tekrar dene', wheelLabel: 'TEKRAR\nDENE', weight: 40, kind: 'retry' },
  { id: 'shizuku_1d', label: '1 günlük Shizuku Tools erişimi', wheelLabel: 'SHIZUKU\n1 GÜN', weight: 2, kind: 'grant' },
  { id: 'discount_40', label: 'Premium ilk ay %40 indirim kodu', wheelLabel: '%40\nİNDİRİM', weight: 2, kind: 'code' },
  // Kalan %20 olasılık boş dilimdir; ödül vermez ve 24 saatlik bekleme süresini başlatır.
  { id: 'empty', label: 'Boş', wheelLabel: 'BOŞ', weight: 20, kind: 'empty' },
];

function dailyWheelRecord(id) {
  const clean = normalizeId(id);
  state.dailyWheel = state.dailyWheel || {};
  const current = state.dailyWheel[clean] && typeof state.dailyWheel[clean] === 'object' ? state.dailyWheel[clean] : {};
  current.id = clean;
  current.lastSpinAt = String(current.lastSpinAt || '');
  current.nextSpinAt = String(current.nextSpinAt || '');
  current.history = Array.isArray(current.history) ? current.history : [];
  current.grants = current.grants && typeof current.grants === 'object' ? current.grants : {};
  state.dailyWheel[clean] = current;
  return current;
}

function activePremiumDiscount(id) {
  const clean = normalizeId(id);
  state.premiumDiscounts = state.premiumDiscounts || {};
  const item = state.premiumDiscounts[clean];
  if (!item) return null;
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) {
    delete state.premiumDiscounts[clean];
    saveStateSoon();
    return null;
  }
  return item;
}

function premiumFlashOfferState(id) {
  const clean = normalizeId(id);
  state.flashOffers = state.flashOffers || {};
  const current = state.flashOffers[clean] && typeof state.flashOffers[clean] === 'object'
    ? state.flashOffers[clean]
    : { id: clean, showCount: 0, lastShownAt: '', activeOffer: null };
  current.id = clean;
  current.showCount = Math.max(0, Number(current.showCount || 0));
  current.lastShownAt = String(current.lastShownAt || '');

  const now = Date.now();
  const existingDiscount = activePremiumDiscount(clean);
  const premiumGrant = isPremiumGranted(clean);
  const lastShownMs = Date.parse(current.lastShownAt) || 0;
  const nextEligibleMs = lastShownMs > 0 ? lastShownMs + 3 * 24 * 60 * 60 * 1000 : 0;

  if (premiumGrant) {
    state.flashOffers[clean] = current;
    return { shouldShow: false, offer: null, nextEligibleAt: nextEligibleMs ? new Date(nextEligibleMs).toISOString() : null, premium: true };
  }

  if (existingDiscount) {
    current.activeOffer = existingDiscount;
    state.flashOffers[clean] = current;
    return {
      shouldShow: false,
      offer: existingDiscount,
      nextEligibleAt: nextEligibleMs ? new Date(nextEligibleMs).toISOString() : null,
      premium: false,
    };
  }

  if (current.activeOffer && current.activeOffer.expiresAt && Date.parse(current.activeOffer.expiresAt) <= now) {
    current.activeOffer = null;
  }

  const due = !lastShownMs || now >= nextEligibleMs;
  if (!due) {
    state.flashOffers[clean] = current;
    return {
      shouldShow: false,
      offer: current.activeOffer || null,
      nextEligibleAt: new Date(nextEligibleMs).toISOString(),
      premium: false,
    };
  }

  const percent = current.showCount === 0 ? 30 : 20;
  const offerTag = percent === 30 ? 'relaxfps_flash_30' : 'relaxfps_flash_20';
  const startedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
  const offer = {
    id: clean,
    percent,
    offerTag,
    startedAt,
    expiresAt,
    source: 'flash_offer',
  };
  current.showCount += 1;
  current.lastShownAt = startedAt;
  current.activeOffer = offer;
  state.flashOffers[clean] = current;
  state.premiumDiscounts = state.premiumDiscounts || {};
  state.premiumDiscounts[clean] = offer;
  saveStateSoon();
  return {
    shouldShow: true,
    offer,
    nextEligibleAt: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
    premium: false,
  };
}

function chooseDailyWheelReward() {
  const total = DAILY_WHEEL_REWARDS.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  let ticket = crypto.randomInt(Math.max(1, total));
  for (const reward of DAILY_WHEEL_REWARDS) {
    const weight = Math.max(0, Number(reward.weight || 0));
    if (ticket < weight) return reward;
    ticket -= weight;
  }
  return DAILY_WHEEL_REWARDS[DAILY_WHEEL_REWARDS.length - 1];
}

function randomWheelCode(prefix = 'WHEEL') {
  state.promoCodes = state.promoCodes || {};
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
    const code = `${prefix}-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    if (!state.promoCodes[code]) return code;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

function createWheelPromoCode(id, reward) {
  const clean = normalizeId(id);
  const now = Date.now();
  let code;
  let item;
  if (reward.id === 'premium_code_1h') {
    code = randomWheelCode('RFXPREM');
    item = {
      code,
      ownerId: clean,
      rewardType: 'premium',
      durationMinutes: 60,
      totalMinutes: 60,
      maxUses: 1,
      active: true,
      expiresAt: new Date(now + DAILY_WHEEL_CODE_LIFETIME_MS).toISOString(),
      label: 'Çark ödülü: 1 saat Premium',
      note: 'Daily wheel generated personal Premium code',
      usedBy: [], uses: 0,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), source: 'daily_wheel',
    };
  } else {
    const percent = reward.id === 'discount_40' ? 40 : 20;
    code = randomWheelCode(percent === 40 ? 'RFX40' : 'RFX20');
    item = {
      code,
      ownerId: clean,
      rewardType: 'premium_discount',
      durationMinutes: 7 * 24 * 60,
      totalMinutes: 0,
      discountPercent: percent,
      offerTag: percent === 40 ? 'relaxfps_wheel_40' : 'relaxfps_wheel_20',
      maxUses: 1,
      active: true,
      expiresAt: new Date(now + DAILY_WHEEL_CODE_LIFETIME_MS).toISOString(),
      label: percent === 40 ? 'Çark ödülü: Premium ilk ay %40 indirim' : 'Çark ödülü: Premium ilk ay %20 indirim',
      note: 'Requires matching Google Play subscription offer tag',
      usedBy: [], uses: 0,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), source: 'daily_wheel',
    };
  }
  state.promoCodes[code] = item;
  return { code, promo: item };
}

function publicWheelHistory(id, history) {
  const clean = normalizeId(id);
  return (Array.isArray(history) ? history : []).slice(0, 50).map((entry) => {
    const code = String(entry.code || '');
    const promo = code ? state.promoCodes?.[code] : null;
    return {
      ...entry,
      codeRedeemed: !!(promo && Array.isArray(promo.usedBy) && promo.usedBy.includes(clean)),
    };
  });
}

function dailyWheelSnapshot(id) {
  const clean = normalizeId(id);
  const record = dailyWheelRecord(clean);
  const nextMs = record.nextSpinAt ? Date.parse(record.nextSpinAt) : 0;
  const now = Date.now();
  const grants = record.grants || {};
  return {
    id: clean,
    canSpin: !Number.isFinite(nextMs) || nextMs <= now,
    lastSpinAt: record.lastSpinAt || '',
    nextSpinAt: Number.isFinite(nextMs) && nextMs > 0 ? new Date(nextMs).toISOString() : '',
    remainingSeconds: Number.isFinite(nextMs) && nextMs > now ? Math.ceil((nextMs - now) / 1000) : 0,
    history: publicWheelHistory(clean, record.history),
    grants: {
      onlineBonusSeconds: Number(grants.onlineBonusUntil || 0) > now ? Math.max(0, Number(grants.onlineBonusSeconds || 0)) : 0,
      onlineBonusUntil: Number(grants.onlineBonusUntil || 0) > now ? new Date(Number(grants.onlineBonusUntil)).toISOString() : '',
      winSimUntil: Number(grants.winSimUntil || 0) > now ? new Date(Number(grants.winSimUntil)).toISOString() : '',
      shizukuUntil: Number(grants.shizukuUntil || 0) > now ? new Date(Number(grants.shizukuUntil)).toISOString() : '',
    },
    premiumDiscount: activePremiumDiscount(clean),
    rewards: DAILY_WHEEL_REWARDS.map(({ id, label, wheelLabel, weight }) => ({ id, label, wheelLabel, weight })),
    serverTime: new Date(now).toISOString(),
  };
}

function applyDailyWheelReward(id, reward) {
  const clean = normalizeId(id);
  const record = dailyWheelRecord(clean);
  const now = Date.now();
  const grants = record.grants || (record.grants = {});
  let code = '';
  let details = {};

  if (reward.id === 'online_20m') {
    grants.onlineBonusSeconds = 20 * 60;
    grants.onlineBonusUntil = now + DAILY_WHEEL_COOLDOWN_MS;
  } else if (reward.id === 'winsim_1d') {
    grants.winSimUntil = Math.max(now, Number(grants.winSimUntil || 0)) + DAILY_WHEEL_COOLDOWN_MS;
  } else if (reward.id === 'shizuku_1d') {
    grants.shizukuUntil = Math.max(now, Number(grants.shizukuUntil || 0)) + DAILY_WHEEL_COOLDOWN_MS;
  } else if (reward.kind === 'code') {
    const created = createWheelPromoCode(clean, reward);
    code = created.code;
    details = reward.id.startsWith('discount_')
      ? { discountPercent: Number(created.promo.discountPercent || 0), offerTag: created.promo.offerTag || '' }
      : { durationMinutes: Number(created.promo.durationMinutes || 0) };
  }

  const historyItem = {
    id: `wheel-${now}-${crypto.randomInt(100000)}`,
    rewardId: reward.id,
    label: reward.label,
    code,
    details,
    retry: reward.id === 'retry',
    time: new Date(now).toISOString(),
  };
  record.history.unshift(historyItem);
  if (record.history.length > 50) record.history = record.history.slice(0, 50);

  if (reward.id !== 'retry') {
    record.lastSpinAt = new Date(now).toISOString();
    record.nextSpinAt = new Date(now + DAILY_WHEEL_COOLDOWN_MS).toISOString();
  }
  record.updatedAt = new Date(now).toISOString();
  saveStateSoon();
  return historyItem;
}

function benchmarkComparison(model, totalScore) {
  const cleanModel = String(model || '').trim().toLowerCase();
  const matching = Object.values(state.benchmarkScores || {}).filter((item) => String(item.model || '').trim().toLowerCase() === cleanModel && Number(item.totalScore || 0) > 0);
  const average = matching.length ? Math.round(matching.reduce((sum, item) => sum + Number(item.totalScore || 0), 0) / matching.length) : Number(totalScore || 0);
  const differencePercent = average > 0 ? Math.round(((Number(totalScore || 0) - average) / average) * 1000) / 10 : 0;
  return { sampleCount: matching.length, average, differencePercent };
}

loadState();

wss.on('connection', (socket) => {
  let currentId = null;
  let adminSessionToken = null;

  socket.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const type = String(data.type || '');
    const requestId = String(data.requestId || '');

    if (type === 'get_public_announcements') {
      send(socket, { type: 'public_announcements', ok: true, requestId, announcements: publicAnnouncements(), time: new Date().toISOString() });
      return;
    }

    if (type === 'get_public_panel') {
      const id = String(data.id || '').trim();
      const panel = (state.customPanels || []).find((item) => item.id === id) || null;
      send(socket, { type: 'public_panel', ok: !!panel, requestId, panel });
      return;
    }

    if (type === 'get_app_config') {
      send(socket, { type: 'app_config', ok: true, requestId, settings: normalizeAppSettings(state.appSettings), time: new Date().toISOString() });
      return;
    }

    if (type === 'bench_leaderboard') {
      const requester = normalizeId(data.id || currentId);
      const leaderboard = publicBenchmarkLeaderboard(data.limit);
      const mine = validId(requester) ? (state.benchmarkScores || {})[requester] || null : null;
      const all = publicBenchmarkLeaderboard(250);
      const rank = mine ? all.findIndex((item) => item.id === requester) + 1 : 0;
      const comparison = mine ? benchmarkComparison(mine.model, mine.totalScore) : null;
      send(socket, { type: 'bench_leaderboard', ok: true, requestId, leaderboard, mine, rank, comparison, totalDevices: Object.keys(state.benchmarkScores || {}).length });
      return;
    }

    if (type === 'bench_submit') {
      const id = normalizeId(data.id || currentId);
      const totalScore = Math.max(0, Math.min(Number(data.totalScore || 0), 2000000));
      if (!validId(id) || totalScore <= 0) {
        send(socket, { type: 'bench_submit', ok: false, requestId, message: 'Valid RelaxFPS ID and score required' });
        return;
      }
      const categoryScores = data.categoryScores && typeof data.categoryScores === 'object' ? data.categoryScores : {};
      const previous = (state.benchmarkScores || {})[id] || null;
      const item = {
        id,
        manufacturer: String(data.manufacturer || '').slice(0, 80),
        model: String(data.model || 'Unknown device').slice(0, 120),
        androidVersion: String(data.androidVersion || '').slice(0, 40),
        totalScore,
        categoryScores,
        previousScore: previous ? Number(previous.totalScore || 0) : 0,
        createdAt: previous && previous.createdAt ? previous.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.benchmarkScores = state.benchmarkScores || {};
      state.benchmarkScores[id] = item;
      saveStateSoon();
      const all = publicBenchmarkLeaderboard(250);
      const rank = all.findIndex((entry) => entry.id === id) + 1;
      const comparison = benchmarkComparison(item.model, item.totalScore);
      send(socket, { type: 'bench_submit', ok: true, requestId, item, previous, rank, comparison, leaderboard: all.slice(0, 100), totalDevices: all.length });
      return;
    }

    if (type === 'get_premium_flash_offer') {
      const id = normalizeId(data.id || currentId);
      if (!validId(id)) {
        send(socket, { type: 'premium_flash_offer', ok: false, requestId, message: 'Geçerli RelaxFPS kimliği gerekli.' });
        return;
      }
      const flash = premiumFlashOfferState(id);
      send(socket, { type: 'premium_flash_offer', ok: true, requestId, ...flash, time: new Date().toISOString() });
      return;
    }

    if (type === 'get_daily_wheel_state') {
      const id = normalizeId(data.id || currentId);
      if (!validId(id)) {
        send(socket, { type: 'daily_wheel_state', ok: false, requestId, message: 'Geçerli RelaxFPS kimliği gerekli.' });
        return;
      }
      send(socket, { type: 'daily_wheel_state', ok: true, requestId, ...dailyWheelSnapshot(id) });
      return;
    }

    if (type === 'spin_daily_wheel') {
      const id = normalizeId(data.id || currentId);
      if (!validId(id)) {
        send(socket, { type: 'daily_wheel_spin', ok: false, requestId, message: 'Geçerli RelaxFPS kimliği gerekli.' });
        return;
      }
      const before = dailyWheelSnapshot(id);
      if (!before.canSpin) {
        send(socket, { type: 'daily_wheel_spin', ok: false, requestId, message: '24 saatlik çark süren henüz dolmadı.', state: before });
        return;
      }
      const reward = chooseDailyWheelReward();
      const result = applyDailyWheelReward(id, reward);
      adminAudit('daily_wheel_spin', { id, rewardId: reward.id, code: result.code || '' });
      send(socket, {
        type: 'daily_wheel_spin', ok: true, requestId,
        reward: { id: reward.id, label: reward.label, wheelLabel: reward.wheelLabel, weight: reward.weight, retry: reward.id === 'retry' },
        result,
        state: dailyWheelSnapshot(id),
      });
      return;
    }

    if (type === 'get_premium_offer_state') {
      const id = normalizeId(data.id || currentId);
      if (!validId(id)) {
        send(socket, { type: 'premium_offer_state', ok: false, requestId, message: 'Geçerli RelaxFPS kimliği gerekli.' });
        return;
      }
      send(socket, { type: 'premium_offer_state', ok: true, requestId, offer: activePremiumDiscount(id) });
      return;
    }

    if (type === 'redeem_promo_code') {
      const id = normalizeId(data.id || currentId);
      const code = String(data.code || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!validId(id) || !code) {
        send(socket, { type: 'promo_redeemed', ok: false, requestId, message: 'Geçerli RelaxFPS kimliği ve kod gerekli.' });
        return;
      }
      state.promoCodes = state.promoCodes || {};
      const item = state.promoCodes[code];
      if (!item || item.active === false) {
        send(socket, { type: 'promo_redeemed', ok: false, requestId, message: 'Kod geçersiz veya devre dışı.' });
        return;
      }
      if (item.ownerId && normalizeId(item.ownerId) !== id) {
        send(socket, { type: 'promo_redeemed', ok: false, requestId, message: 'Bu kişisel kod başka bir RelaxFPS kimliğine ait.' });
        return;
      }
      if (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) {
        send(socket, { type: 'promo_redeemed', ok: false, requestId, message: 'Bu kodun süresi dolmuş.' });
        return;
      }
      item.usedBy = Array.isArray(item.usedBy) ? item.usedBy : [];
      if (item.usedBy.includes(id)) {
        send(socket, { type: 'promo_redeemed', ok: false, requestId, message: 'Bu kodu daha önce kullandın.' });
        return;
      }
      const maxUses = Math.max(0, Number(item.maxUses || 0));
      if (maxUses > 0 && item.usedBy.length >= maxUses) {
        send(socket, { type: 'promo_redeemed', ok: false, requestId, message: 'Kod kullanım sınırına ulaştı.' });
        return;
      }

      const rewardType = String(item.rewardType || 'premium');
      const durationMinutes = Math.max(1, Math.min(Number(item.durationMinutes || 60), 525600));
      const totalMinutes = Math.max(10, Math.min(Number(item.totalMinutes || durationMinutes), 1440));
      const reward = {
        type: rewardType,
        durationMinutes,
        totalMinutes,
        discountPercent: Math.max(0, Math.min(Number(item.discountPercent || 0), 90)),
        offerTag: String(item.offerTag || '').slice(0, 100),
        label: String(item.label || item.note || 'Promosyon ödülü').slice(0, 240),
      };
      let premiumGrant = null;
      if (rewardType === 'premium') {
        state.premiumUsers = state.premiumUsers || {};
        const currentGrant = isPremiumGranted(id);
        const currentUntilMs = currentGrant && currentGrant.until ? Date.parse(currentGrant.until) : 0;
        const baseMs = Number.isFinite(currentUntilMs) && currentUntilMs > Date.now() ? currentUntilMs : Date.now();
        const until = new Date(baseMs + durationMinutes * 60 * 1000).toISOString();
        state.premiumUsers[id] = {
          ...(currentGrant || {}),
          id,
          minutes: Number(currentGrant?.minutes || 0) + durationMinutes,
          until,
          time: new Date().toISOString(),
          source: `promo:${code}`,
        };
        premiumGrant = state.premiumUsers[id];
        sendTo(id, { type: 'premium_granted', grant: premiumGrant });
      } else if (rewardType === 'premium_discount') {
        state.premiumDiscounts = state.premiumDiscounts || {};
        const percent = Math.max(1, Math.min(Number(item.discountPercent || 0), 90));
        const expiresAt = new Date(Date.now() + Math.max(60, durationMinutes) * 60 * 1000).toISOString();
        state.premiumDiscounts[id] = {
          id, percent, offerTag: String(item.offerTag || ''), expiresAt,
          sourceCode: code, redeemedAt: new Date().toISOString(),
        };
        reward.discountPercent = percent;
        reward.offerTag = String(item.offerTag || '');
        reward.expiresAt = expiresAt;
      }
      item.usedBy.push(id);
      item.uses = item.usedBy.length;
      item.updatedAt = new Date().toISOString();
      adminAudit('promo_redeemed', { code, id, rewardType, durationMinutes, totalMinutes });
      saveStateSoon();
      send(socket, {
        type: 'promo_redeemed',
        ok: true,
        requestId,
        code,
        reward,
        premiumGrant,
        serverTime: new Date().toISOString(),
        message: reward.label || 'Kod başarıyla kullanıldı.',
      });
      return;
    }

    if (type === 'admin_auth') {
      const token = String(data.token || '');
      const session = validateAdminSession(token, true);
      if (!session) {
        send(socket, { type: 'admin_auth', ok: false, requestId, code: 'session_expired', message: 'Invalid or expired admin session' });
        return;
      }
      adminSessionToken = token;
      send(socket, {
        type: 'admin_auth',
        ok: true,
        requestId,
        expiresAt: session.expiresAt,
        sessionMinutes: state.adminSecurity?.sessionMinutes || 60,
      });
      return;
    }

    if (type === 'admin_login') {
      send(socket, {
        type: 'admin_error',
        ok: false,
        requestId,
        code: 'web_admin_required',
        message: 'Password login is only available from the RELAXFPS Admin Studio web panel',
      });
      return;
    }

    if (type === 'admin_snapshot') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      send(socket, { ...adminSnapshot(), requestId });
      return;
    }

    if (type === 'admin_create_announcement' || type === 'admin_upsert_announcement') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const incomingId = String(data.id || '').trim();
      const id = incomingId || `ann-${Date.now()}-${Math.floor(Math.random() * 99999)}`;
      const item = {
        id,
        title: String(data.title || '').slice(0, 160),
        body: String(data.body || '').slice(0, 9000),
        category: String(data.category || 'Duyuru').slice(0, 60),
        sourceName: String(data.sourceName || 'RELAXFPS').slice(0, 80),
        link: String(data.link || '').slice(0, 600),
        buttonLabel: String(data.buttonLabel || '').slice(0, 80),
        buttonAction: String(data.buttonAction || '').slice(0, 80),
        panelId: String(data.panelId || '').slice(0, 120),
        imageBase64: String(data.imageBase64 || '').slice(0, 2200000),
        videoBase64: String(data.videoBase64 || '').slice(0, 2600000),
        active: data.active !== false,
        pinned: data.pinned === true,
        priority: Math.max(0, Math.min(Number(data.priority || 0), 100)),
        expiresAt: String(data.expiresAt || '').slice(0, 80),
        order: Number(data.order || 0),
        time: incomingId ? ((state.announcements || []).find((x) => x.id === incomingId)?.time || new Date().toISOString()) : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!item.title || !item.body) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Announcement title/body required' });
      state.announcements = state.announcements || [];
      const index = state.announcements.findIndex((x) => x.id === id);
      if (index >= 0) state.announcements[index] = item; else state.announcements.push(item);
      if (state.announcements.length > 300) state.announcements = state.announcements.slice(-300);
      adminAudit('upsert_announcement', { id, title: item.title, active: item.active });
      saveStateSoon();
      for (const id of onlineIds()) sendTo(id, { type: 'announcement', item });
      send(socket, { type: 'admin_upsert_announcement', ok: true, requestId, item });
      return;
    }

    if (type === 'admin_delete_announcement') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = String(data.id || '').trim();
      state.announcements = (state.announcements || []).filter((item) => item.id !== id);
      adminAudit('delete_announcement', { id });
      saveStateSoon();
      send(socket, { type: 'admin_delete_announcement', ok: true, requestId, id });
      return;
    }

    if (type === 'admin_upsert_custom_panel') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const incomingId = String(data.id || '').trim();
      const safeBase = String(data.title || 'panel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'panel';
      const id = incomingId || `panel-${safeBase}-${Date.now()}`;
      const panel = {
        id,
        title: String(data.title || '').slice(0, 160),
        body: String(data.body || '').slice(0, 16000),
        imageBase64: String(data.imageBase64 || '').slice(0, 2200000),
        buttonLabel: String(data.buttonLabel || '').slice(0, 80),
        buttonUrl: String(data.buttonUrl || '').slice(0, 600),
        time: incomingId ? ((state.customPanels || []).find((x) => x.id === incomingId)?.time || new Date().toISOString()) : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!panel.title || !panel.body) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Panel title/body required' });
      state.customPanels = state.customPanels || [];
      const index = state.customPanels.findIndex((x) => x.id === id);
      if (index >= 0) state.customPanels[index] = panel; else state.customPanels.push(panel);
      if (state.customPanels.length > 200) state.customPanels = state.customPanels.slice(-200);
      adminAudit('upsert_custom_panel', { id, title: panel.title });
      saveStateSoon();
      send(socket, { type: 'admin_upsert_custom_panel', ok: true, requestId, panelId: id, panel });
      return;
    }

    if (type === 'admin_delete_custom_panel') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = String(data.id || '').trim();
      state.customPanels = (state.customPanels || []).filter((item) => item.id !== id);
      adminAudit('delete_custom_panel', { id });
      saveStateSoon();
      send(socket, { type: 'admin_delete_custom_panel', ok: true, requestId, id });
      return;
    }

    if (type === 'admin_upsert_promo_code') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      state.promoCodes = state.promoCodes || {};
      const code = String(data.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 48);
      if (!code) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Promo code required' });
      const existing = state.promoCodes[code] || {};
      const rewardTypes = ['premium', 'ad_free', 'winsim', 'friends_minutes', 'premium_discount'];
      const rewardType = rewardTypes.includes(String(data.rewardType || '')) ? String(data.rewardType) : 'premium';
      const item = {
        ...existing,
        code,
        rewardType,
        durationMinutes: Math.max(1, Math.min(Number(data.durationMinutes || 60), 525600)),
        totalMinutes: Math.max(0, Math.min(Number(data.totalMinutes || data.durationMinutes || 30), 1440)),
        ownerId: normalizeId(data.ownerId || existing.ownerId || ''),
        discountPercent: Math.max(0, Math.min(Number(data.discountPercent || existing.discountPercent || 0), 90)),
        offerTag: String(data.offerTag || existing.offerTag || '').slice(0, 100),
        maxUses: Math.max(0, Math.min(Number(data.maxUses || 0), 1000000)),
        active: data.active !== false,
        expiresAt: String(data.expiresAt || '').slice(0, 80),
        label: String(data.label || '').slice(0, 240),
        note: String(data.note || '').slice(0, 1000),
        usedBy: Array.isArray(existing.usedBy) ? existing.usedBy : [],
        uses: Array.isArray(existing.usedBy) ? existing.usedBy.length : Number(existing.uses || 0),
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.promoCodes[code] = item;
      adminAudit('upsert_promo_code', { code, rewardType, active: item.active, maxUses: item.maxUses });
      saveStateSoon();
      send(socket, { type: 'admin_upsert_promo_code', ok: true, requestId, item });
      return;
    }

    if (type === 'admin_delete_promo_code') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const code = String(data.code || '').trim().toUpperCase();
      delete state.promoCodes[code];
      adminAudit('delete_promo_code', { code });
      saveStateSoon();
      send(socket, { type: 'admin_delete_promo_code', ok: true, requestId, code });
      return;
    }

    if (type === 'admin_update_feedback') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = String(data.id || '').trim();
      const item = (state.feedback || []).find((fb) => fb.id === id);
      if (!item) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Feedback not found' });
      item.status = String(data.status || item.status || 'new').slice(0, 40);
      item.reply = String(data.reply || '').slice(0, 2500);
      item.updatedAt = new Date().toISOString();
      adminAudit('update_feedback', { id, status: item.status });
      saveStateSoon();
      if (validId(item.from)) sendTo(item.from, { type: 'feedback_reply', item });
      send(socket, { type: 'admin_update_feedback', ok: true, requestId, item });
      return;
    }

    if (type === 'admin_update_app_settings') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const next = normalizeAppSettings(state.appSettings);
      const boolKeys = ['maintenanceMode','friendsEnabled','communityEnabled','relaxBenchEnabled','winsimEnabled','gameHubEnabled','appLockEnabled','soundBoosterEnabled','virtualRamEnabled','overlayEnabled','messagingEnabled','imageSharingEnabled','voiceCallEnabled','relayVoiceEnabled','forceUpdate','betaToolsEnabled','adsEnabled','telemetryEnabled'];
      for (const key of boolKeys) if (Object.prototype.hasOwnProperty.call(data, key)) next[key] = data[key] === true;
      const textLimits = { maintenanceMessage: 1000, maintenanceUntil: 80, latestVersion: 40, minimumVersion: 40, updateMessage: 1000, playStoreUrl: 600 };
      for (const [key, limit] of Object.entries(textLimits)) if (Object.prototype.hasOwnProperty.call(data, key)) next[key] = String(data[key] || '').slice(0, limit);
      const numberKeys = { freeFriendMinutes: [0, 1440], premiumFriendMinutes: [0, 1440], appLockFailLimit: [1, 20], appLockLockMinutes: [1, 1440] };
      for (const [key, range] of Object.entries(numberKeys)) if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = Number(data[key]);
        next[key] = Number.isFinite(value) ? Math.max(range[0], Math.min(value, range[1])) : next[key];
      }
      next.updatedAt = new Date().toISOString();
      state.appSettings = next;
      adminAudit('update_app_settings', state.appSettings);
      saveStateSoon();
      for (const id of onlineIds()) sendTo(id, { type: 'app_settings', settings: state.appSettings });
      send(socket, { type: 'admin_update_app_settings', ok: true, requestId, appSettings: state.appSettings });
      return;
    }

    if (type === 'admin_set_premium') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = normalizeId(data.id);
      if (!validId(id)) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Valid RelaxFPS ID required' });
      const months = Math.max(0, Math.min(Number(data.months || 0), 60));
      state.premiumUsers = state.premiumUsers || {};
      if (months <= 0) {
        delete state.premiumUsers[id];
        sendTo(id, { type: 'premium_removed', id, time: new Date().toISOString() });
      } else {
        const until = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString();
        state.premiumUsers[id] = { id, months, until, time: new Date().toISOString(), source: 'developer_panel' };
        sendTo(id, { type: 'premium_granted', grant: state.premiumUsers[id] });
      }
      adminAudit('set_premium', { id, months });
      saveStateSoon();
      send(socket, { type: 'admin_set_premium', ok: true, requestId, id, premium: !!state.premiumUsers[id], grant: state.premiumUsers[id] || null });
      return;
    }

    if (type === 'admin_send_developer_message') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const to = normalizeId(data.to);
      if (!validId(to)) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Valid RelaxFPS ID required' });
      const item = {
        id: `devmsg-${Date.now()}-${Math.floor(Math.random() * 99999)}`,
        to,
        title: String(data.title || 'Geliştiriciden mesajınız var').slice(0, 120),
        body: String(data.body || '').slice(0, 2500),
        time: new Date().toISOString(),
        read: false,
      };
      state.developerMessages = state.developerMessages || [];
      state.developerMessages.push(item);
      if (state.developerMessages.length > 1000) state.developerMessages = state.developerMessages.slice(-1000);
      adminAudit('send_developer_message', { to, title: item.title });
      saveStateSoon();
      sendTo(to, { type: 'developer_message', ...item });
      send(socket, { type: 'admin_send_developer_message', ok: true, requestId, item });
      return;
    }


    if (type === 'admin_send_bulk_developer_message') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const toAll = data.toAll === true;
      const ids = Array.isArray(data.ids) ? data.ids.map(normalizeId).filter(validId) : [];
      const targets = toAll ? Object.keys(state.profiles || {}) : Array.from(new Set(ids));
      const title = String(data.title || 'Geliştiriciden mesajınız var').slice(0, 120);
      const body = String(data.body || '').slice(0, 2500);
      state.developerMessages = state.developerMessages || [];
      const items = [];
      for (const to of targets) {
        const item = { id: `devmsg-${Date.now()}-${Math.floor(Math.random() * 99999)}`, to, title, body, time: new Date().toISOString(), read: false, bulk: true };
        state.developerMessages.push(item);
        items.push(item);
        sendTo(to, { type: 'developer_message', ...item });
      }
      if (state.developerMessages.length > 2000) state.developerMessages = state.developerMessages.slice(-2000);
      adminAudit('send_bulk_developer_message', { count: items.length, toAll });
      saveStateSoon();
      send(socket, { type: 'admin_send_bulk_developer_message', ok: true, requestId, count: items.length });
      return;
    }

    if (type === 'admin_set_ban') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = normalizeId(data.id);
      if (!validId(id)) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Valid RelaxFPS ID required' });
      state.bannedUsers = state.bannedUsers || {};
      state.appSettings = normalizeAppSettings(state.appSettings);
      state.crashReports = Array.isArray(state.crashReports) ? state.crashReports : [];
      state.clientEvents = Array.isArray(state.clientEvents) ? state.clientEvents : [];
      state.testUsers = state.testUsers || {};
      state.userNotes = state.userNotes || {};
      state.backups = Array.isArray(state.backups) ? state.backups : [];
      state.adminAuditLog = Array.isArray(state.adminAuditLog) ? state.adminAuditLog : [];
      state.adminSecurity = state.adminSecurity || { wrongPasswordCount: 0, lastWrongPasswordAt: null, sessionMinutes: 60 };
      state.benchmarkScores = state.benchmarkScores || {};
      if (data.banned === true) {
        const minutes = Math.max(0, Math.min(Number(data.minutes || 0), 525600));
        const until = minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : null;
        state.bannedUsers[id] = { id, reason: String(data.reason || 'Developer moderation').slice(0, 400), until, time: new Date().toISOString() };
        sendTo(id, { type: 'banned', ban: state.bannedUsers[id] });
      } else {
        delete state.bannedUsers[id];
        sendTo(id, { type: 'ban_removed', id, time: new Date().toISOString() });
      }
      adminAudit('set_ban', { id, banned: data.banned === true });
      saveStateSoon();
      send(socket, { type: 'admin_set_ban', ok: true, requestId, id, banned: data.banned === true });
      return;
    }

    if (type === 'admin_set_test_user') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = normalizeId(data.id);
      if (!validId(id)) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Valid RelaxFPS ID required' });
      state.testUsers = state.testUsers || {};
      if (data.enabled === true) state.testUsers[id] = { id, enabled: true, time: new Date().toISOString() }; else delete state.testUsers[id];
      adminAudit('set_test_user', { id, enabled: data.enabled === true });
      saveStateSoon();
      sendTo(id, { type: 'test_user_status', enabled: data.enabled === true });
      send(socket, { type: 'admin_set_test_user', ok: true, requestId, id, enabled: data.enabled === true });
      return;
    }

    if (type === 'admin_set_user_note') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = normalizeId(data.id);
      if (!validId(id)) return send(socket, { type: 'admin_error', ok: false, requestId, message: 'Valid RelaxFPS ID required' });
      state.userNotes = state.userNotes || {};
      const note = String(data.note || '').slice(0, 2000);
      if (note) state.userNotes[id] = { id, note, time: new Date().toISOString() }; else delete state.userNotes[id];
      adminAudit('set_user_note', { id, hasNote: !!note });
      saveStateSoon();
      send(socket, { type: 'admin_set_user_note', ok: true, requestId, id, note });
      return;
    }

    if (type === 'admin_backup_now') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      saveStateNow();
      const snapshot = JSON.parse(JSON.stringify(state));
      delete snapshot.backups;
      const dataText = JSON.stringify(snapshot);
      const backup = {
        id: `backup-${Date.now()}`,
        time: new Date().toISOString(),
        size: dataText.length,
        summary: { users: Object.keys(state.profiles || {}).length, announcements: (state.announcements || []).length, panels: (state.customPanels || []).length },
        data: snapshot,
      };
      state.backups = state.backups || [];
      state.backups.push(backup);
      if (state.backups.length > 10) state.backups = state.backups.slice(-10);
      adminAudit('backup_now', { id: backup.id, size: backup.size });
      saveStateSoon();
      send(socket, { type: 'admin_backup_now', ok: true, requestId, backup: { id: backup.id, time: backup.time, size: backup.size, summary: backup.summary } });
      return;
    }

    if (type === 'admin_clear_admin_log') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      state.adminAuditLog = [];
      adminAudit('clear_admin_log', {});
      saveStateSoon();
      send(socket, { type: 'admin_clear_admin_log', ok: true, requestId });
      return;
    }

    if (type === 'admin_clear_crash_reports') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      state.crashReports = [];
      adminAudit('clear_crash_reports', {});
      saveStateSoon();
      send(socket, { type: 'admin_clear_crash_reports', ok: true, requestId });
      return;
    }

    if (type === 'admin_update_security') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      state.adminSecurity = state.adminSecurity || {};
      const minutes = Math.max(5, Math.min(Number(data.sessionMinutes || 60), 1440));
      state.adminSecurity.sessionMinutes = minutes;
      state.adminSecurity.updatedAt = new Date().toISOString();
      adminAudit('update_security', { sessionMinutes: minutes });
      saveStateSoon();
      send(socket, { type: 'admin_update_security', ok: true, requestId, adminSecurity: state.adminSecurity });
      return;
    }

    if (type === 'client_event') {
      const from = normalizeId(data.from || currentId);
      if (state.appSettings && state.appSettings.telemetryEnabled === false) return send(socket, { type: 'client_event_saved', ok: false, requestId, disabled: true });
      const item = { id: `evt-${Date.now()}-${Math.floor(Math.random() * 99999)}`, from: validId(from) ? from : 'UNKNOWN', event: String(data.event || 'unknown').slice(0, 120), meta: data.meta || {}, time: new Date().toISOString() };
      state.clientEvents = state.clientEvents || [];
      state.clientEvents.push(item);
      if (state.clientEvents.length > 4000) state.clientEvents = state.clientEvents.slice(-4000);
      saveStateSoon();
      send(socket, { type: 'client_event_saved', ok: true, requestId, id: item.id });
      return;
    }

    if (type === 'crash_report') {
      const from = normalizeId(data.from || currentId);
      const item = {
        id: `crash-${Date.now()}-${Math.floor(Math.random() * 99999)}`,
        from: validId(from) ? from : 'UNKNOWN',
        screen: String(data.screen || '').slice(0, 160),
        error: String(data.error || '').slice(0, 4000),
        stack: String(data.stack || '').slice(0, 12000),
        appVersion: String(data.appVersion || '').slice(0, 80),
        deviceModel: String(data.deviceModel || '').slice(0, 120),
        time: new Date().toISOString(),
      };
      state.crashReports = state.crashReports || [];
      state.crashReports.push(item);
      if (state.crashReports.length > 1000) state.crashReports = state.crashReports.slice(-1000);
      saveStateSoon();
      send(socket, { type: 'crash_report_saved', ok: true, requestId, id: item.id });
      return;
    }

    if (type === 'feedback_submit') {
      const from = normalizeId(data.from || currentId);
      const item = {
        id: `fb-${Date.now()}-${Math.floor(Math.random() * 99999)}`,
        from: validId(from) ? from : 'UNKNOWN',
        title: String(data.title || 'Feedback').slice(0, 120),
        body: String(data.body || '').slice(0, 4000),
        status: 'new',
        reply: '',
        time: new Date().toISOString(),
      };
      state.feedback = state.feedback || [];
      state.feedback.push(item);
      if (state.feedback.length > 500) state.feedback = state.feedback.slice(-500);
      saveStateSoon();
      send(socket, { type: 'feedback_saved', ok: true, id: item.id, requestId });
      return;
    }

    if (type === 'register') {
      const id = normalizeId(data.id);
      if (!validId(id)) return send(socket, { type: 'error', message: 'Invalid RelaxFPS ID' });
      const ban = isBanned(id);
      if (ban) {
        send(socket, { type: 'banned', ban, message: ban.reason || 'This RelaxFPS ID is banned.' });
        return;
      }

      if (currentId && currentId !== id) {
        const wentOffline = removeClient(currentId, socket);
        if (wentOffline) broadcastPresence(currentId, false);
      }

      const wasOffline = !isOnline(id);
      currentId = id;
      addClient(id, socket);
      const incomingName = String(data.name || '').trim();
      ensureProfile(id, incomingName && incomingName !== 'RelaxFPS User' ? incomingName : '');
      state.profiles[id].appVersion = String(data.appVersion || state.profiles[id].appVersion || '').slice(0, 80);
      state.profiles[id].language = String(data.language || state.profiles[id].language || '').slice(0, 20);

      if (wasOffline) startFriendUsage(id, data.timezoneOffsetMinutes);
      const usage = friendUsageSnapshot(id, data.timezoneOffsetMinutes);
      send(socket, {
        type: 'registered',
        id,
        online: true,
        onlineIds: onlineIds(),
        profile: publicProfile(id),
        premiumGrant: isPremiumGranted(id),
        friendUsage: usage,
        serverTime: new Date().toISOString(),
      });
      sendFriendsList(socket, id);
      send(socket, { type: 'groups_list', id, groups: groupsForUser(id), time: new Date().toISOString() });
      send(socket, { type: 'group_invites', id, invites: pendingGroupInvitesFor(id), time: new Date().toISOString() });

      if (wasOffline) broadcastPresence(id, true);
      flushQueue(id);
      pushDeveloperMessages(id, socket);
      console.log(`[REGISTER] ${id} (${socketsFor(id).size} socket(s))`);
      return;
    }

    if (type === 'friend_usage_status') {
      const id = normalizeId(data.id || currentId);
      if (!validId(id)) return send(socket, { type: 'error', message: 'Valid RelaxFPS ID required' });
      send(socket, { type: 'friend_usage', ...friendUsageSnapshot(id, data.timezoneOffsetMinutes), requestId });
      return;
    }

    if (type === 'status') {
      const ids = Array.isArray(data.ids) ? data.ids.map(normalizeId) : [];
      send(socket, { type: 'status', onlineIds: ids.filter((id) => isOnline(id)), allOnlineIds: onlineIds() });
      return;
    }

    if (type === 'friends_list') {
      const id = normalizeId(data.id || currentId);
      if (validId(id)) sendFriendsList(socket, id);
      return;
    }

    if (type === 'friend_add') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      if (!validId(from) || !validId(to) || from === to) {
        return send(socket, { type: 'error', message: 'Invalid friend add payload' });
      }

      ensureProfile(from, data.name || 'RelaxFPS User');
      ensureProfile(to);
      addFriendship(from, to);

      send(socket, { type: 'friend_added', id: to, friend: publicProfile(to), time: new Date().toISOString() });
      sendTo(to, { type: 'friend_added', id: from, from, friend: publicProfile(from), time: new Date().toISOString() });
      sendFriendsListToId(from);
      sendFriendsListToId(to);
      broadcastPresence(from, true);
      broadcastPresence(to, isOnline(to));

      console.log(`[FRIEND ADD] ${from} <-> ${to}`);
      return;
    }

    if (type === 'friend_request') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      if (!validId(from) || !validId(to) || from === to) return send(socket, { type: 'error', message: 'Invalid friend request' });
      ensureProfile(from, data.name || 'RelaxFPS User');
      ensureProfile(to);
      const existing = state.friendRequests.find((r) => r.from === from && r.to === to && r.status === 'pending');
      const request = existing || { from, to, name: String(data.name || 'RelaxFPS User').slice(0, 40), time: new Date().toISOString(), status: 'pending' };
      if (!existing) state.friendRequests.push(request);
      saveStateSoon();
      send(socket, { type: 'friend_request_sent', to, time: request.time });
      sendTo(to, { type: 'friend_request', from, name: request.name, time: request.time });
      console.log(`[FRIEND REQUEST] ${from} -> ${to}`);
      return;
    }

    if (type === 'friend_accept') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      if (!validId(from) || !validId(to)) return;
      addFriendship(from, to);
      for (const r of state.friendRequests) {
        if (r.from === to && r.to === from && r.status === 'pending') r.status = 'accepted';
      }
      saveStateSoon();
      send(socket, { type: 'friend_accepted', from: to, id: to, name: publicProfile(to).name, friend: publicProfile(to) });
      sendTo(to, { type: 'friend_accepted', from, id: from, name: publicProfile(from).name, friend: publicProfile(from) });
      sendFriendsListToId(from);
      sendFriendsListToId(to);
      return;
    }

    if (type === 'friend_reject') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      for (const r of state.friendRequests) {
        if (r.from === to && r.to === from && r.status === 'pending') r.status = 'rejected';
      }
      saveStateSoon();
      sendTo(to, { type: 'friend_rejected', from });
      return;
    }

    if (type === 'friend_remove') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      removeFriendship(from, to);
      sendTo(to, { type: 'friend_removed', from });
      sendFriendsListToId(from);
      sendFriendsListToId(to);
      return;
    }

    if (type === 'history') {
      const withId = normalizeId(data.with || data.to);
      const mine = normalizeId(currentId || data.id);
      if (validId(mine) && validId(withId)) {
        send(socket, { type: 'history', with: withId, messages: historyFor(mine, withId, data.limit) });
      }
      return;
    }

    if (type === 'message') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      const kind = String(data.kind || 'text').trim().toLowerCase() === 'image' ? 'image' : 'text';
      const text = String(data.text || '').trim().slice(0, 2000);
      const imageBase64 = kind === 'image' ? String(data.imageBase64 || '').trim() : '';
      const mimeType = kind === 'image' ? String(data.mimeType || 'image/jpeg').slice(0, 80) : '';
      const fileName = kind === 'image' ? String(data.fileName || 'relaxfps-image.jpg').slice(0, 120) : '';
      const messageId = String(data.messageId || `srv-${Date.now()}-${Math.floor(Math.random() * 99999)}`);

      const validTextMessage = kind === 'text' && text.length > 0;
      const validImageMessage = kind === 'image' && imageBase64.length > 0 && imageBase64.length <= 1300000;
      if (!validId(from) || !validId(to) || (!validTextMessage && !validImageMessage)) {
        return send(socket, { type: 'error', message: 'Invalid message payload', messageId });
      }

      if (isBanned(from)) return send(socket, { type: 'error', message: 'Your RelaxFPS ID is banned.' });
      ensureProfile(from, data.name || '');
      ensureProfile(to);
      const payload = {
        type: 'message',
        from,
        to,
        kind,
        text: validTextMessage ? text : (text || 'Image'),
        imageBase64,
        mimeType,
        fileName,
        messageId,
        time: data.time || new Date().toISOString(),
        fromName: publicProfile(from).name,
        deliveredAt: null,
        readAt: null,
        deleted: false,
      };
      storeMessage(payload);

      if (isOnline(to)) {
        payload.deliveredAt = new Date().toISOString();
        sendTo(to, payload);
        send(socket, { type: 'delivered', to, messageId, time: payload.deliveredAt });
      } else {
        const queue = offlineQueue.get(to) || [];
        queue.push(payload);
        offlineQueue.set(to, queue);
        send(socket, { type: 'queued', to, messageId, time: new Date().toISOString() });
      }

      console.log(`[MESSAGE:${kind}] ${from} -> ${to}: ${kind === 'image' ? fileName : text}`);
      return;
    }

    if (type === 'read') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      const messageId = String(data.messageId || '');
      const time = new Date().toISOString();
      const key = conversationKey(from, to);
      const item = (state.messages[key] || []).find((message) => message.messageId === messageId);
      if (item) item.readAt = time;
      saveStateSoon();
      sendTo(to, { type: 'read', from, to, messageId, time });
      return;
    }

    if (type === 'message_delete') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      const messageId = String(data.messageId || '');
      const key = conversationKey(from, to);
      const item = (state.messages[key] || []).find((message) => message.messageId === messageId);
      if (!item || item.from !== from) return send(socket, { type: 'error', message: 'Message cannot be deleted', messageId });
      item.deleted = true;
      item.text = 'This message was deleted.';
      item.kind = 'text';
      item.imageBase64 = '';
      item.mimeType = '';
      item.fileName = '';
      item.deletedAt = new Date().toISOString();
      saveStateSoon();
      const payload = { type: 'message_deleted', from, to, messageId, deletedAt: item.deletedAt };
      sendTo(to, payload);
      sendTo(from, payload);
      return;
    }

    if (type === 'typing') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      sendTo(to, { type: 'typing', from, typing: data.typing === true });
      return;
    }

    if (type === 'call_invite' || type === 'call_answer' || type === 'call_end' || type === 'call_signal') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      if (!validId(from) || !validId(to)) return;
      const callPayload = { ...data, from, to, fromName: publicProfile(from).name, callId: String(data.callId || conversationKey(from, to)), time: data.time || new Date().toISOString() };
      sendTo(to, callPayload);
      if (type === 'call_invite') send(socket, { type: 'call_ringing', to, mode: data.mode || 'voice', callId: callPayload.callId });
      return;
    }

    if (type === 'relay_join' || type === 'relay_audio' || type === 'relay_end') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      if (!validId(from) || !validId(to) || from === to) return;

      const roomId = String(data.room || conversationKey(from, to));
      const room = getRelayRoom(roomId);
      room.members.add(from);
      room.members.add(to);
      room.lastActive = Date.now();

      const payload = {
        type,
        from,
        to,
        room: roomId,
        mode: 'relay_voice',
        relay: true,
        time: data.time || new Date().toISOString(),
      };

      if (type === 'relay_audio') {
        payload.data = String(data.data || '');
        payload.format = String(data.format || 'pcm16');
        payload.sampleRate = Math.max(6000, Math.min(Number(data.sampleRate || 8000), 48000));
        payload.channels = Number(data.channels || 1);
        payload.seq = Number(data.seq || 0);
        payload.level = Number(data.level || 0);
        payload.speech = data.speech === true;
        payload.speechStart = data.speechStart === true;
        payload.speechEnd = data.speechEnd === true;
        payload.smartMode = data.smartMode === true;
        if (!payload.data) return;
        room.chunks += 1;
      }

      if (type === 'relay_join') {
        payload.status = String(data.status || 'ready');
        payload.smart = data.smart === true;
        send(socket, { type: 'relay_room', room: roomId, members: Array.from(room.members), chunks: room.chunks, time: new Date().toISOString() });
      }

      if (type === 'relay_end') {
        payload.reason = String(data.reason || 'ended');
        room.members.delete(from);
        if (room.members.size === 0) relayRooms.delete(roomId);
      }

      if (clients.has(to)) {
        sendTo(to, payload);
      } else {
        send(socket, { type: 'relay_peer_offline', to, room: roomId, time: new Date().toISOString() });
      }
      return;
    }

    if (type === 'groups_list') {
      const id = normalizeId(data.id || currentId);
      if (validId(id)) send(socket, { type: 'groups_list', id, groups: groupsForUser(id), time: new Date().toISOString() });
      return;
    }

    if (type === 'group_invites') {
      const id = normalizeId(data.id || currentId);
      if (validId(id)) send(socket, { type: 'group_invites', id, invites: pendingGroupInvitesFor(id), time: new Date().toISOString() });
      return;
    }

    if (type === 'group_create') {
      const from = normalizeId(data.from || currentId);
      if (!validId(from)) return;
      const name = String(data.name || 'RelaxFPS Group').trim().slice(0, 80);
      const groupId = `GRP-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
      const now = new Date().toISOString();
      const group = { id: groupId, name, ownerId: from, admins: [from], members: [from], createdAt: now, updatedAt: now };
      state.groups[groupId] = group;
      const invitees = Array.isArray(data.members) ? Array.from(new Set(data.members.map(normalizeId).filter((id) => validId(id) && id !== from))) : [];
      for (const to of invitees) {
        const invite = { id: `ginv-${Date.now()}-${Math.floor(Math.random() * 99999)}`, groupId, from, to, status: 'pending', time: now };
        state.groupInvites.push(invite);
        sendTo(to, { type: 'group_invite', ...invite, groupName: name, fromName: publicProfile(from).name, group: publicGroup(group) });
      }
      saveStateSoon();
      send(socket, { type: 'group_created', ok: true, group: publicGroup(group), invited: invitees });
      sendGroupsState(from);
      return;
    }

    if (type === 'group_invite') {
      const from = normalizeId(data.from || currentId);
      const to = normalizeId(data.to);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || !group.members.includes(from) || !validId(to)) return;
      if (group.members.includes(to)) return send(socket, { type: 'group_error', message: 'User is already a member' });
      const existing = state.groupInvites.find((i) => i.groupId === groupId && i.to === to && i.status === 'pending');
      const invite = existing || { id: `ginv-${Date.now()}-${Math.floor(Math.random() * 99999)}`, groupId, from, to, status: 'pending', time: new Date().toISOString() };
      if (!existing) state.groupInvites.push(invite);
      saveStateSoon();
      sendTo(to, { type: 'group_invite', ...invite, groupName: group.name, fromName: publicProfile(from).name, group: publicGroup(group) });
      send(socket, { type: 'group_invite_sent', ok: true, invite });
      return;
    }

    if (type === 'group_accept' || type === 'group_reject') {
      const id = normalizeId(data.id || currentId);
      const inviteId = String(data.inviteId || '');
      const invite = state.groupInvites.find((i) => i.id === inviteId && i.to === id && i.status === 'pending');
      if (!invite) return send(socket, { type: 'group_error', message: 'Invitation not found' });
      invite.status = type === 'group_accept' ? 'accepted' : 'rejected';
      invite.respondedAt = new Date().toISOString();
      const group = state.groups[invite.groupId];
      if (type === 'group_accept' && group) {
        group.members = Array.from(new Set([...(group.members || []), id]));
        group.updatedAt = new Date().toISOString();
        broadcastToGroup(group.id, { type: 'group_member_joined', groupId: group.id, member: publicProfile(id), group: publicGroup(group) });
      }
      saveStateSoon();
      sendGroupsState(id);
      if (group) for (const member of group.members || []) sendGroupsState(member);
      return;
    }

    if (type === 'group_history') {
      const id = normalizeId(data.id || currentId);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || !group.members.includes(id)) return;
      send(socket, { type: 'group_history', groupId, messages: groupHistory(groupId, data.limit), group: publicGroup(group) });
      return;
    }

    if (type === 'group_message') {
      const from = normalizeId(data.from || currentId);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || !group.members.includes(from)) return;
      const kind = String(data.kind || 'text').toLowerCase() === 'image' ? 'image' : 'text';
      const text = String(data.text || '').trim().slice(0, 2000);
      const imageBase64 = kind === 'image' ? String(data.imageBase64 || '') : '';
      if ((kind === 'text' && !text) || (kind === 'image' && (!imageBase64 || imageBase64.length > 1300000))) return;
      const payload = {
        type: 'group_message',
        groupId,
        groupName: group.name,
        messageId: String(data.messageId || `gm-${Date.now()}-${Math.floor(Math.random() * 99999)}`),
        from,
        fromName: publicProfile(from).name,
        kind,
        text: kind === 'text' ? text : (text || 'Image'),
        imageBase64,
        mimeType: kind === 'image' ? String(data.mimeType || 'image/jpeg').slice(0, 80) : '',
        fileName: kind === 'image' ? String(data.fileName || 'relaxfps-group-image.jpg').slice(0, 120) : '',
        time: data.time || new Date().toISOString(),
        deleted: false,
      };
      storeGroupMessage(groupId, payload);
      broadcastToGroup(groupId, payload);
      send(socket, { type: 'group_delivered', groupId, messageId: payload.messageId, time: new Date().toISOString() });
      return;
    }

    if (type === 'group_message_delete') {
      const from = normalizeId(data.from || currentId);
      const groupId = String(data.groupId || '');
      const messageId = String(data.messageId || '');
      const group = state.groups[groupId];
      const item = (state.groupMessages[groupId] || []).find((m) => m.messageId === messageId);
      if (!group || !item || (item.from !== from && !group.admins.includes(from))) return;
      item.deleted = true;
      item.text = 'This message was deleted.';
      item.kind = 'text';
      item.imageBase64 = '';
      item.mimeType = '';
      item.fileName = '';
      item.deletedAt = new Date().toISOString();
      saveStateSoon();
      broadcastToGroup(groupId, { type: 'group_message_deleted', groupId, messageId, deletedAt: item.deletedAt });
      return;
    }

    if (type === 'group_promote_admin') {
      const from = normalizeId(data.from || currentId);
      const target = normalizeId(data.target);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || group.ownerId !== from || !group.members.includes(target)) return;
      group.admins = Array.from(new Set([...(group.admins || []), target]));
      group.updatedAt = new Date().toISOString();
      saveStateSoon();
      broadcastToGroup(groupId, { type: 'group_updated', group: publicGroup(group) });
      return;
    }

    if (type === 'group_remove_member') {
      const from = normalizeId(data.from || currentId);
      const target = normalizeId(data.target);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || !(group.admins || []).includes(from) || target === group.ownerId) return;
      group.members = (group.members || []).filter((id) => id !== target);
      group.admins = (group.admins || []).filter((id) => id !== target);
      group.updatedAt = new Date().toISOString();
      saveStateSoon();
      sendTo(target, { type: 'group_removed', groupId });
      broadcastToGroup(groupId, { type: 'group_updated', group: publicGroup(group) });
      sendGroupsState(target);
      return;
    }

    if (type === 'group_leave') {
      const id = normalizeId(data.id || currentId);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || !group.members.includes(id)) return;
      if (group.ownerId === id) return send(socket, { type: 'group_error', message: 'Owner must delete the group or transfer ownership' });
      group.members = group.members.filter((member) => member !== id);
      group.admins = group.admins.filter((member) => member !== id);
      group.updatedAt = new Date().toISOString();
      saveStateSoon();
      broadcastToGroup(groupId, { type: 'group_member_left', groupId, id, group: publicGroup(group) });
      sendGroupsState(id);
      return;
    }

    if (type === 'group_delete') {
      const from = normalizeId(data.from || currentId);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || group.ownerId !== from) return;
      const members = [...group.members];
      delete state.groups[groupId];
      delete state.groupMessages[groupId];
      state.groupInvites = state.groupInvites.filter((invite) => invite.groupId !== groupId);
      saveStateSoon();
      for (const member of members) {
        sendTo(member, { type: 'group_deleted', groupId });
        sendGroupsState(member);
      }
      return;
    }

    if (type === 'group_call_invite') {
      const from = normalizeId(data.from || currentId);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || !group.members.includes(from)) return;
      const payload = { type, from, fromName: publicProfile(from).name, groupId, groupName: group.name, group: publicGroup(group), callId: String(data.callId || `gcall-${groupId}`), time: new Date().toISOString() };
      broadcastToGroup(groupId, payload, from);
      return;
    }

    if (type === 'group_call_answer') {
      const from = normalizeId(data.from || currentId);
      const groupId = String(data.groupId || '');
      broadcastToGroup(groupId, { type, from, fromName: publicProfile(from).name, groupId, accepted: data.accepted === true, time: new Date().toISOString() }, from);
      return;
    }

    if (type === 'group_relay_join' || type === 'group_relay_audio' || type === 'group_relay_end') {
      const from = normalizeId(data.from || currentId);
      const groupId = String(data.groupId || '');
      const group = state.groups[groupId];
      if (!group || !group.members.includes(from)) return;
      const room = getGroupCallRoom(groupId);
      room.lastActive = Date.now();
      if (type === 'group_relay_join') room.members.add(from);
      const payload = { type, from, fromName: publicProfile(from).name, groupId, groupName: group.name, time: new Date().toISOString() };
      if (type === 'group_relay_audio') {
        payload.data = String(data.data || '');
        if (!payload.data) return;
        payload.format = String(data.format || 'pcm16');
        payload.sampleRate = Math.max(6000, Math.min(Number(data.sampleRate || 8000), 48000));
        payload.channels = Number(data.channels || 1);
        payload.seq = Number(data.seq || 0);
        payload.level = Number(data.level || 0);
        payload.speech = data.speech === true;
        payload.speechStart = data.speechStart === true;
        payload.speechEnd = data.speechEnd === true;
        room.chunks += 1;
      }
      if (type === 'group_relay_end') {
        room.members.delete(from);
        if (room.members.size === 0) groupCallRooms.delete(groupId);
      }
      for (const member of room.members) if (member !== from) sendTo(member, payload);
      broadcastToGroup(groupId, { type: 'group_call_presence', groupId, members: Array.from(room.members), time: new Date().toISOString() });
      return;
    }

    if (type === 'ping') {
      send(socket, { type: 'pong', time: new Date().toISOString(), onlineIds: onlineIds() });
      return;
    }

    send(socket, { type: 'error', message: 'Unknown message type' });
  });

  socket.on('close', () => {
    if (currentId) {
      const wentOffline = removeClient(currentId, socket);
      if (wentOffline) {
        stopFriendUsage(currentId);
        if (state.profiles[currentId]) {
          state.profiles[currentId].lastSeen = new Date().toISOString();
          saveStateSoon();
        }
        broadcastPresence(currentId, false);
        console.log(`[DISCONNECT] ${currentId}`);
      } else {
        console.log(`[SOCKET CLOSED] ${currentId} (${socketsFor(currentId).size} socket(s) left)`);
      }
    }
  });

  socket.on('error', (error) => {
    console.warn('[SOCKET ERROR]', error.message);
  });
});

setInterval(() => {
  for (const [id, sockets] of clients.entries()) {
    for (const socket of Array.from(sockets)) {
      if (socket.readyState !== WebSocket.OPEN) {
        sockets.delete(socket);
      }
    }
    if (sockets.size === 0) {
      clients.delete(id);
      stopFriendUsage(id);
      broadcastPresence(id, false);
    }
  }
}, 30000);

setInterval(() => {
  for (const id of activeFriendUsage.keys()) {
    const snapshot = friendUsageSnapshot(id);
    sendTo(id, { type: 'friend_usage', ...snapshot });
  }
}, 10000).unref?.();

function shutdown() {
  for (const id of Array.from(activeFriendUsage.keys())) stopFriendUsage(id);
  saveStateNow();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, () => {
  console.log(`RelaxFPS Friends Server v6.0-web-admin running on ws://0.0.0.0:${PORT}`);
  console.log(`RELAXFPS Admin Studio: http://0.0.0.0:${PORT}/admin`);
  if (ADMIN_PASSWORD.length < 12) console.warn('[SECURITY] RELAXFPS_ADMIN_PASSWORD is missing or shorter than 12 characters. Admin login is disabled.');
  if (ADMIN_TOTP_SECRET) console.log('[SECURITY] Admin TOTP is enabled.');
});
