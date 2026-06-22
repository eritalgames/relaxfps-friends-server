const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'relaxfps-friends-data.json');
const ADMIN_WEB_DIR = path.join(__dirname, 'admin');
const ADMIN_PASSWORD = String(process.env.RELAXFPS_ADMIN_PASSWORD || '');
const ADMIN_TOTP_SECRET = String(process.env.RELAXFPS_ADMIN_TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase();
const ADMIN_SESSION_SECRET = String(process.env.RELAXFPS_ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
const ADMIN_LOGIN_MAX_ATTEMPTS = Math.max(3, Math.min(Number(process.env.RELAXFPS_ADMIN_LOGIN_MAX_ATTEMPTS || 5), 20));
const ADMIN_LOGIN_BLOCK_MINUTES = Math.max(1, Math.min(Number(process.env.RELAXFPS_ADMIN_LOGIN_BLOCK_MINUTES || 15), 1440));

// RFX Token ledger security. Set RELAXFPS_WALLET_LEDGER_SECRET to a stable,
// high-entropy value in production. ADMIN_SESSION_SECRET is used only as a
// compatibility fallback so existing deployments do not fail to boot.
const WALLET_LEDGER_SECRET_SOURCE = String(
  process.env.RELAXFPS_WALLET_LEDGER_SECRET || ADMIN_SESSION_SECRET || '',
);
const WALLET_LEDGER_SECRET = crypto.createHash('sha256')
  .update(`RELAXFPS:RFX:TOKEN:${WALLET_LEDGER_SECRET_SOURCE}`, 'utf8')
  .digest();
const WALLET_LEDGER_KEY_ID = crypto.createHash('sha256')
  .update(WALLET_LEDGER_SECRET)
  .digest('hex')
  .slice(0, 16);
const WALLET_SECURITY_CONFIGURED = String(process.env.RELAXFPS_WALLET_LEDGER_SECRET || '').length >= 32;
const WALLET_MAX_TRANSACTIONS = 50000;
const WALLET_MAX_SECURITY_EVENTS = 5000;
const WALLET_MAX_REQUEST_INDEX = 30000;
const WALLET_MAX_BALANCE = 1000000000;

// Token C: AdMob rewarded-ad server-side verification (SSV).
// The official Google key endpoint is used by default. A custom endpoint is
// accepted only through an explicit server environment variable for isolated tests.
const ADMOB_SSV_KEYS_URL = String(
  process.env.RELAXFPS_ADMOB_SSV_KEYS_URL || 'https://www.gstatic.com/admob/reward/verifier-keys.json',
);
const ADMOB_REWARDED_AD_UNIT_ID = String(
  process.env.RELAXFPS_ADMOB_REWARDED_AD_UNIT_ID || '4833556672',
).trim();
const ADMOB_AD_SESSION_TTL_MS = Math.max(
  5 * 60 * 1000,
  Math.min(Number(process.env.RELAXFPS_ADMOB_SESSION_TTL_MS || 30 * 60 * 1000), 2 * 60 * 60 * 1000),
);
const ADMOB_CALLBACK_TOLERANCE_MS = Math.max(
  10 * 60 * 1000,
  Math.min(Number(process.env.RELAXFPS_ADMOB_CALLBACK_TOLERANCE_MS || 2 * 60 * 60 * 1000), 24 * 60 * 60 * 1000),
);
const ADMOB_KEY_CACHE_MS = 23 * 60 * 60 * 1000;
const ADMOB_MAX_SESSION_RECORDS = 20000;
const ADMOB_MAX_TRANSACTION_RECORDS = 30000;
let admobSsvKeyCache = { fetchedAt: 0, keys: new Map() };

// Token D: Google Play consumable RFX packages. Purchase tokens are verified
// and consumed only on this backend. The service-account JSON must never be
// bundled with the Flutter application or committed to source control.
const GOOGLE_PLAY_PACKAGE_NAME = String(
  process.env.RELAXFPS_GOOGLE_PLAY_PACKAGE_NAME || 'com.relaxfps.gamebooster',
).trim();
const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_PLAY_API_BASE_URL = String(
  process.env.RELAXFPS_GOOGLE_PLAY_API_BASE_URL || 'https://androidpublisher.googleapis.com',
).replace(/\/+$/g, '');
const GOOGLE_PLAY_OAUTH_TOKEN_URL = String(
  process.env.RELAXFPS_GOOGLE_PLAY_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
);
const GOOGLE_PLAY_LOCAL_TESTS_ALLOWED = String(
  process.env.RELAXFPS_ALLOW_INSECURE_LOCAL_TESTS || 'false',
).toLowerCase() === 'true';
const GOOGLE_PLAY_VOIDED_SYNC_INTERVAL_MS = Math.max(
  15 * 60 * 1000,
  Math.min(Number(process.env.RELAXFPS_GOOGLE_PLAY_VOIDED_SYNC_MINUTES || 30) * 60 * 1000, 24 * 60 * 60 * 1000),
);
const GOOGLE_PLAY_MAX_PURCHASE_RECORDS = 50000;
const GOOGLE_PLAY_TOKEN_PRODUCTS = Object.freeze({
  relaxfps_rfx_500: { amount: 500, label: 'Başlangıç paketi' },
  relaxfps_rfx_100000: { amount: 100000, label: 'Güç paketi' },
  relaxfps_rfx_1000000: { amount: 1000000, label: 'Pro paket' },
  relaxfps_rfx_10000000: { amount: 10000000, label: 'Mega paket' },
});
let googlePlayAccessTokenCache = { token: '', expiresAt: 0 };
const googlePlayPurchaseLocks = new Map();
let googlePlayVoidedSyncRunning = false;


// Free persistent storage through Supabase. Keep the secret/service-role key
// only in Render environment variables; never ship it in Flutter or GitHub.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/g, '');
const SUPABASE_SERVER_KEY = String(
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);
const SUPABASE_STATE_ID = String(process.env.RELAXFPS_SUPABASE_STATE_ID || 'primary')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '')
  .slice(0, 64) || 'primary';
const SUPABASE_SYNC_ENABLED = String(process.env.RELAXFPS_SUPABASE_SYNC || 'true').toLowerCase() !== 'false';
const SUPABASE_ALLOW_INSECURE_LOCAL = String(process.env.RELAXFPS_SUPABASE_ALLOW_INSECURE_LOCAL || 'false').toLowerCase() === 'true';
const SUPABASE_URL_VALID = /^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(SUPABASE_URL)
  || (SUPABASE_ALLOW_INSECURE_LOCAL && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(SUPABASE_URL));
const SUPABASE_CONFIGURED = SUPABASE_SYNC_ENABLED
  && SUPABASE_URL_VALID
  && SUPABASE_SERVER_KEY.length >= 20;
const SUPABASE_REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Math.min(Number(process.env.RELAXFPS_SUPABASE_TIMEOUT_MS || 15000), 60000),
);
const SUPABASE_SAVE_DEBOUNCE_MS = Math.max(
  250,
  Math.min(Number(process.env.RELAXFPS_SUPABASE_SAVE_DEBOUNCE_MS || 1200), 10000),
);
const SUPABASE_MAX_COMPRESSED_BYTES = Math.max(
  1024 * 1024,
  Math.min(Number(process.env.RELAXFPS_SUPABASE_MAX_COMPRESSED_BYTES || 12 * 1024 * 1024), 48 * 1024 * 1024),
);
const SUPABASE_INSTANCE_ID = `${process.env.RENDER_INSTANCE_ID || process.env.RENDER_SERVICE_ID || 'local'}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const SUPABASE_PAYLOAD_ENCODING = 'gzip-base64-json-v1';
const SUPABASE_STATE_SIGNING_KEY = crypto.createHmac('sha256', WALLET_LEDGER_SECRET)
  .update(`RELAXFPS:SUPABASE:STATE:${SUPABASE_STATE_ID}`, 'utf8')
  .digest();

const adminSessions = new Map(); // token -> {createdAt, expiresAt, lastUsedAt, ip, userAgent}
const adminLoginAttempts = new Map(); // ip -> {count, blockedUntil, lastAttemptAt}
const walletRateLimits = new Map(); // composite key -> {count, windowStartedAt, blockedUntil}
const walletAuthFailures = new Map(); // ip + RelaxFPS ID -> temporary auth throttle
let walletIntegrityStatus = { ok: true, code: 'not_checked', checkedAt: '' };

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

function defaultWalletSettings() {
  return {
    enabled: true,
    currencyName: 'RFX Token',
    welcomeBonus: 500,
    premiumUnlimited: true,
    dailyAdLimit: 3,
    adReward: 100,
    prices: {
      device_health: 10,
      battery_charge_lab: 10,
      display_doctor: 10,
      audio_haptic_lab: 10,
      sensor_studio: 10,
      storage_insight: 15,
      gamer_break_coach: 5,
      touch_lab: 15,
      gyro_test: 15,
      network_stability: 20,
      connectivity_center: 20,
      relaxbench: 25,
      optimize_normal: 30,
      optimize_advanced: 50,
      wide_optimization: 50,
      thermal_pro: 75,
      latency_optimizer: 75,
      gfx_tool: 50,
      server_10m: 50,
      server_30m: 100,
      server_2h: 250,
      server_24h: 500,
      premium_tool_trial: 250,
    },
    updatedAt: '',
  };
}

function normalizeWalletSettings(value) {
  const incoming = value && typeof value === 'object' ? value : {};
  const defaults = defaultWalletSettings();
  const incomingPrices = incoming.prices && typeof incoming.prices === 'object' ? incoming.prices : {};
  const prices = { ...defaults.prices };
  for (const [key, rawValue] of Object.entries(incomingPrices)) {
    const cleanKey = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '').slice(0, 80);
    const amount = Math.round(Number(rawValue || 0));
    if (cleanKey && Number.isFinite(amount) && amount >= 0 && amount <= 10000000) prices[cleanKey] = amount;
  }
  return {
    ...defaults,
    ...incoming,
    enabled: incoming.enabled !== false,
    currencyName: String(incoming.currencyName || defaults.currencyName).slice(0, 40),
    welcomeBonus: Math.max(0, Math.min(Math.round(Number(incoming.welcomeBonus ?? defaults.welcomeBonus)), 1000000)),
    premiumUnlimited: incoming.premiumUnlimited !== false,
    dailyAdLimit: Math.max(0, Math.min(Math.round(Number(incoming.dailyAdLimit ?? defaults.dailyAdLimit)), 100)),
    adReward: Math.max(0, Math.min(Math.round(Number(incoming.adReward ?? defaults.adReward)), 1000000)),
    prices,
    updatedAt: String(incoming.updatedAt || ''),
  };
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
  cloudBackups: {}, // RelaxFPS ID -> {keyHash,backup,createdAt,updatedAt,sizeBytes,version}
  communitySignals: {}, // RelaxFPS ID -> anonymized aggregate device/session signal
  wallets: {}, // RelaxFPS ID -> server-authoritative RFX Token wallet
  walletTransactions: [], // append-only, HMAC chained token ledger
  walletRequestIndex: {}, // userId:requestId -> transactionId, prevents duplicate spending
  walletSecurityEvents: [], // suspicious wallet activity and integrity warnings
  walletAdSessions: {}, // sessionId -> pending/verified rewarded-ad SSV session
  walletAdTransactions: {}, // AdMob transactionId -> user/session/ledger transaction
  playPurchases: {}, // purchaseTokenHash -> verified Google Play consumable purchase
  playPurchaseOrderIndex: {}, // optional orderId -> purchaseTokenHash (not used as primary key)
  playPurchaseSync: { lastVoidedSyncAt: '', startTimeMs: 0, lastError: '' },
  walletSettings: defaultWalletSettings(),
  walletLedgerHead: '',
  walletLedgerSequence: 0,
  walletLedgerAnchor: { sequence: 0, hash: 'GENESIS' },
  walletLedgerKeyId: '',
};

function applyLoadedState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('State payload is not a JSON object');
  }
  Object.assign(state, parsed);
  state.profiles = state.profiles && typeof state.profiles === 'object' ? state.profiles : {};
  state.friendships = state.friendships && typeof state.friendships === 'object' ? state.friendships : {};
  state.friendRequests = Array.isArray(state.friendRequests) ? state.friendRequests : [];
  state.messages = state.messages && typeof state.messages === 'object' ? state.messages : {};
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
  state.cloudBackups = state.cloudBackups || {};
  state.communitySignals = state.communitySignals || {};
  state.wallets = state.wallets && typeof state.wallets === 'object' ? state.wallets : {};
  state.walletTransactions = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  state.walletRequestIndex = state.walletRequestIndex && typeof state.walletRequestIndex === 'object' ? state.walletRequestIndex : {};
  state.walletSecurityEvents = Array.isArray(state.walletSecurityEvents) ? state.walletSecurityEvents : [];
  state.walletAdSessions = state.walletAdSessions && typeof state.walletAdSessions === 'object' ? state.walletAdSessions : {};
  state.walletAdTransactions = state.walletAdTransactions && typeof state.walletAdTransactions === 'object' ? state.walletAdTransactions : {};
  state.playPurchases = state.playPurchases && typeof state.playPurchases === 'object' ? state.playPurchases : {};
  state.playPurchaseOrderIndex = state.playPurchaseOrderIndex && typeof state.playPurchaseOrderIndex === 'object' ? state.playPurchaseOrderIndex : {};
  state.playPurchaseSync = state.playPurchaseSync && typeof state.playPurchaseSync === 'object'
    ? state.playPurchaseSync
    : { lastVoidedSyncAt: '', startTimeMs: 0, lastError: '' };
  state.walletSettings = normalizeWalletSettings(state.walletSettings);
  state.walletLedgerHead = String(state.walletLedgerHead || '');
  state.walletLedgerSequence = Math.max(0, Math.round(Number(state.walletLedgerSequence || 0)));
  state.walletLedgerAnchor = state.walletLedgerAnchor && typeof state.walletLedgerAnchor === 'object'
    ? state.walletLedgerAnchor
    : { sequence: 0, hash: 'GENESIS' };
  state.walletLedgerKeyId = String(state.walletLedgerKeyId || '');
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      applyLoadedState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
      return true;
    }
  } catch (error) {
    console.warn('[STATE] Could not load data file:', error.message);
  }
  return false;
}

let saveTimer = null;
let supabaseSaveTimer = null;
let supabaseSaveChain = Promise.resolve();
let supabaseStateRevision = 0;
let supabaseDirty = false;
let walletMutationChain = Promise.resolve();
let supabaseStatus = {
  configured: SUPABASE_CONFIGURED,
  enabled: SUPABASE_SYNC_ENABLED,
  connected: false,
  loadedFromCloud: false,
  cloudRowExists: false,
  revision: 0,
  dirty: false,
  conflict: false,
  lastLoadAt: '',
  lastSaveAt: '',
  lastErrorAt: '',
  lastError: '',
};

function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 300);
  saveTimer.unref?.();
}

function adminAudit(action, detail = {}) {
  state.adminAuditLog = state.adminAuditLog || [];
  state.adminAuditLog.push({ action, detail, time: new Date().toISOString() });
  if (state.adminAuditLog.length > 600) state.adminAuditLog = state.adminAuditLog.slice(-600);
  saveStateSoon();
}

function writeLocalStateNow() {
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, DATA_FILE);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {}
    console.warn('[STATE] Could not save data file:', error.message);
    return false;
  }
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVER_KEY,
    Authorization: `Bearer ${SUPABASE_SERVER_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function supabaseRequest(pathname, options = {}) {
  if (!SUPABASE_CONFIGURED) throw Object.assign(new Error('Supabase persistence is not configured.'), { code: 'supabase_not_configured' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(`${SUPABASE_URL}${pathname}`, {
      ...options,
      headers: { ...supabaseHeaders(), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let body = null;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch (_) { body = bodyText; }
    }
    if (!response.ok) {
      const message = typeof body === 'object' && body
        ? String(body.message || body.details || body.hint || response.statusText)
        : String(body || response.statusText);
      throw Object.assign(new Error(`Supabase ${response.status}: ${message}`), {
        code: 'supabase_http_error',
        statusCode: response.status,
        responseBody: body,
      });
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Supabase request timed out.'), { code: 'supabase_timeout' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function encodeSupabaseState() {
  const json = Buffer.from(JSON.stringify(state), 'utf8');
  const compressed = zlib.gzipSync(json, { level: 6 });
  if (compressed.length > SUPABASE_MAX_COMPRESSED_BYTES) {
    throw Object.assign(
      new Error(`Compressed state is too large (${compressed.length} bytes).`),
      { code: 'supabase_payload_too_large', compressedBytes: compressed.length },
    );
  }
  const payload = compressed.toString('base64');
  const checksum = crypto.createHmac('sha256', SUPABASE_STATE_SIGNING_KEY)
    .update(`${SUPABASE_PAYLOAD_ENCODING}\n${payload}`, 'utf8')
    .digest('hex');
  return {
    payload,
    checksum,
    encoding: SUPABASE_PAYLOAD_ENCODING,
    jsonBytes: json.length,
    compressedBytes: compressed.length,
  };
}

function decodeSupabaseState(row) {
  const encoding = String(row?.payload_encoding || '');
  const payload = String(row?.payload || '');
  const checksum = String(row?.checksum || '');
  if (encoding !== SUPABASE_PAYLOAD_ENCODING || !payload || !checksum) {
    throw Object.assign(new Error('Supabase state row has an unsupported format.'), { code: 'supabase_bad_payload' });
  }
  const expected = crypto.createHmac('sha256', SUPABASE_STATE_SIGNING_KEY)
    .update(`${encoding}\n${payload}`, 'utf8')
    .digest('hex');
  if (!secureStringEqual(checksum, expected)) {
    throw Object.assign(new Error('Supabase state checksum validation failed.'), { code: 'supabase_checksum_failed' });
  }
  const compressed = Buffer.from(payload, 'base64');
  if (!compressed.length || compressed.length > SUPABASE_MAX_COMPRESSED_BYTES) {
    throw Object.assign(new Error('Supabase state payload size is invalid.'), { code: 'supabase_bad_payload_size' });
  }
  const json = zlib.gunzipSync(compressed).toString('utf8');
  return JSON.parse(json);
}

function markSupabaseError(error) {
  supabaseStatus.connected = false;
  supabaseStatus.lastErrorAt = new Date().toISOString();
  supabaseStatus.lastError = String(error?.message || error || 'Unknown Supabase error').slice(0, 500);
  console.warn('[SUPABASE]', supabaseStatus.lastError);
}

async function loadStateFromSupabase() {
  if (!SUPABASE_CONFIGURED) return false;
  try {
    const rows = await supabaseRequest(
      `/rest/v1/relaxfps_server_state?state_id=eq.${encodeURIComponent(SUPABASE_STATE_ID)}&select=state_id,revision,payload,payload_encoding,checksum,updated_at&limit=1`,
      { method: 'GET' },
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      supabaseStateRevision = 0;
      supabaseStatus.connected = true;
      supabaseStatus.cloudRowExists = false;
      supabaseStatus.loadedFromCloud = false;
      supabaseStatus.revision = 0;
      supabaseStatus.lastLoadAt = new Date().toISOString();
      return false;
    }
    const parsed = decodeSupabaseState(row);
    applyLoadedState(parsed);
    supabaseStateRevision = Math.max(0, Math.round(Number(row.revision || 0)));
    supabaseStatus.connected = true;
    supabaseStatus.cloudRowExists = true;
    supabaseStatus.loadedFromCloud = true;
    supabaseStatus.revision = supabaseStateRevision;
    supabaseStatus.conflict = false;
    supabaseStatus.lastLoadAt = new Date().toISOString();
    supabaseStatus.lastError = '';
    writeLocalStateNow();
    console.log(`[SUPABASE] Restored persistent server state at revision ${supabaseStateRevision}.`);
    return true;
  } catch (error) {
    markSupabaseError(error);
    return false;
  }
}

async function saveStateToSupabaseNow({ required = false } = {}) {
  if (!SUPABASE_CONFIGURED) return !required;
  const encoded = encodeSupabaseState();
  const expectedRevision = supabaseStateRevision;
  const result = await supabaseRequest('/rest/v1/rpc/relaxfps_save_server_state', {
    method: 'POST',
    body: JSON.stringify({
      p_state_id: SUPABASE_STATE_ID,
      p_expected_revision: expectedRevision,
      p_payload: encoded.payload,
      p_payload_encoding: encoded.encoding,
      p_checksum: encoded.checksum,
      p_source_instance: SUPABASE_INSTANCE_ID,
      p_payload_bytes: encoded.compressedBytes,
    }),
  });
  const row = Array.isArray(result) ? result[0] : result;
  if (!row || row.ok !== true) {
    if (row?.conflict === true) {
      supabaseStatus.conflict = true;
      const error = Object.assign(
        new Error(`Supabase revision conflict. Local=${expectedRevision}, cloud=${row.revision ?? '?'}`),
        { code: 'supabase_revision_conflict', cloudRevision: row.revision },
      );
      markSupabaseError(error);
      throw error;
    }
    throw Object.assign(new Error('Supabase state save was rejected.'), { code: 'supabase_save_rejected' });
  }
  supabaseStateRevision = Math.max(0, Math.round(Number(row.revision || expectedRevision + 1)));
  supabaseStatus.connected = true;
  supabaseStatus.cloudRowExists = true;
  supabaseStatus.loadedFromCloud = true;
  supabaseStatus.revision = supabaseStateRevision;
  supabaseStatus.dirty = false;
  supabaseStatus.conflict = false;
  supabaseStatus.lastSaveAt = new Date().toISOString();
  supabaseStatus.lastError = '';
  return true;
}

function queueSupabaseSave(delayMs = SUPABASE_SAVE_DEBOUNCE_MS) {
  if (!SUPABASE_CONFIGURED) return;
  supabaseDirty = true;
  supabaseStatus.dirty = true;
  clearTimeout(supabaseSaveTimer);
  supabaseSaveTimer = setTimeout(() => {
    supabaseSaveTimer = null;
    flushSupabaseState().catch(() => {});
  }, delayMs);
  supabaseSaveTimer.unref?.();
}

function flushSupabaseState({ required = false } = {}) {
  if (!SUPABASE_CONFIGURED) return Promise.resolve(!required);
  clearTimeout(supabaseSaveTimer);
  supabaseSaveTimer = null;
  supabaseDirty = false;
  supabaseSaveChain = supabaseSaveChain.then(
    async () => {
      try {
        return await saveStateToSupabaseNow({ required });
      } catch (error) {
        markSupabaseError(error);
        if (!required) {
          supabaseDirty = true;
          supabaseStatus.dirty = true;
          queueSupabaseSave(Math.min(SUPABASE_SAVE_DEBOUNCE_MS * 4, 10000));
          return false;
        }
        throw error;
      }
    },
    async () => saveStateToSupabaseNow({ required }),
  );
  return supabaseSaveChain;
}

function saveStateNow() {
  const localSaved = writeLocalStateNow();
  if (localSaved) queueSupabaseSave();
  return localSaved;
}

async function saveStateDurable() {
  if (!writeLocalStateNow()) return false;
  if (!SUPABASE_CONFIGURED) return true;
  await flushSupabaseState({ required: true });
  return true;
}

function withWalletMutation(task) {
  const run = walletMutationChain.then(task, task);
  walletMutationChain = run.catch(() => {});
  return run;
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

  if (req.method === 'GET' && pathname === '/admob/ssv') {
    const ip = requestIp(req);
    const rate = walletRateLimit(`admob-ssv:${ip}`, 120, 60 * 1000, 5 * 60 * 1000);
    if (!rate.ok) {
      sendJsonResponse(res, 429, {
        ok: false,
        code: 'rate_limited',
        retryAfterSeconds: rate.retryAfterSeconds,
      }, { 'Retry-After': String(rate.retryAfterSeconds) });
      return;
    }
    const rawUrl = String(req.url || '');
    const questionIndex = rawUrl.indexOf('?');
    const rawQuery = questionIndex >= 0 ? rawUrl.slice(questionIndex + 1) : '';
    try {
      const result = await processAdmobSsvCallback(rawQuery, ip);
      sendJsonResponse(res, result.statusCode || 200, result.payload || { ok: true });
    } catch (error) {
      const code = String(error.code || 'admob_ssv_failed');
      const statusCode = Number(error.statusCode || (code === 'verification_keys_unavailable' ? 503 : 400));
      walletSecurityEvent('admob_ssv_rejected', {
        ip,
        code,
        message: String(error.message || '').slice(0, 180),
      }, statusCode >= 500 ? 'warning' : 'high');
      sendJsonResponse(res, statusCode, {
        ok: false,
        code,
        message: statusCode >= 500 ? 'SSV doğrulama hizmeti geçici olarak kullanılamıyor.' : 'Geçersiz SSV geri çağrısı.',
      });
    }
    return;
  }

  if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
    sendJsonResponse(res, 200, {
      ok: true,
      service: 'RelaxFPS Friends Server',
      version: '6.4.0-rfx-token-d',
      online: onlineIds().length,
      adminStudio: true,
      wallet: {
        enabled: normalizeWalletSettings(state.walletSettings).enabled,
        wallets: Object.keys(state.wallets || {}).length,
        transactions: (state.walletTransactions || []).length,
        integrity: walletIntegrityStatus.ok,
        securityConfigured: WALLET_SECURITY_CONFIGURED,
        admobSsv: {
          configured: ADMOB_REWARDED_AD_UNIT_ID.length > 0,
          endpoint: '/admob/ssv',
          pendingSessions: Object.values(state.walletAdSessions || {}).filter((item) => item?.status === 'pending').length,
          verifiedTransactions: Object.keys(state.walletAdTransactions || {}).length,
        },
        googlePlay: {
          configured: googlePlayConfigured(),
          packageName: GOOGLE_PLAY_PACKAGE_NAME,
          products: Object.keys(GOOGLE_PLAY_TOKEN_PRODUCTS).length,
          purchases: Object.keys(state.playPurchases || {}).length,
          lastVoidedSyncAt: String(state.playPurchaseSync?.lastVoidedSyncAt || ''),
          lastVoidedSyncError: String(state.playPurchaseSync?.lastError || ''),
        },
      },
      persistence: {
        mode: SUPABASE_CONFIGURED ? 'supabase' : 'local-ephemeral',
        configured: SUPABASE_CONFIGURED,
        connected: supabaseStatus.connected,
        loadedFromCloud: supabaseStatus.loadedFromCloud,
        revision: supabaseStatus.revision,
        dirty: supabaseStatus.dirty,
        conflict: supabaseStatus.conflict,
        lastSaveAt: supabaseStatus.lastSaveAt,
        lastError: supabaseStatus.lastError,
      },
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
  for (const [key, value] of walletRateLimits.entries()) {
    if ((value.blockedUntil || value.windowStartedAt || 0) < now - 60 * 60 * 1000) walletRateLimits.delete(key);
  }
  for (const [key, value] of walletAuthFailures.entries()) {
    if ((value.blockedUntil || value.lastFailureAt || 0) < now - 24 * 60 * 60 * 1000) walletAuthFailures.delete(key);
  }
  cleanupWalletAdState({ persist: true });
}, 60 * 1000).unref?.();

function normalizeId(value) {
  return String(value || '').trim().toUpperCase();
}

function validId(id) {
  return id.startsWith('RFX-') && id.length >= 8;
}

function normalizeRecoveryKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function validRecoveryKey(value) {
  const clean = normalizeRecoveryKey(value).replace(/-/g, '');
  return clean.length >= 12 && clean.length <= 96 && /^[A-Z0-9]+$/.test(clean);
}

function recoveryKeyHash(value) {
  return crypto.createHash('sha256').update(normalizeRecoveryKey(value), 'utf8').digest('hex');
}

function cloudBackupKeyMatches(record, recoveryKey) {
  if (!record || !record.keyHash || !validRecoveryKey(recoveryKey)) return false;
  return secureStringEqual(record.keyHash, recoveryKeyHash(recoveryKey));
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
      tokenBonusSeconds: 0,
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
  const tokenBonusSeconds = Math.max(0, Number(record.tokenBonusSeconds || 0));
  const limitSeconds = Math.max(0, Math.round(minutes * 60) + onlineBonusSeconds + tokenBonusSeconds);
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
    tokenBonusSeconds,
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


function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeWalletKey(value) {
  return String(value || '').trim();
}

function validWalletKey(value) {
  const clean = normalizeWalletKey(value);
  return clean.length >= 32 && clean.length <= 256 && /^[A-Za-z0-9_.:-]+$/.test(clean);
}

function walletCredentialHash(value, purpose) {
  return crypto.createHmac('sha256', WALLET_LEDGER_SECRET)
    .update(`${String(purpose || 'credential')}:${String(value || '')}`, 'utf8')
    .digest('hex');
}

function walletKeyMatches(wallet, walletKey) {
  if (!wallet || !wallet.walletKeyHash || !validWalletKey(walletKey)) return false;
  return secureStringEqual(wallet.walletKeyHash, walletCredentialHash(normalizeWalletKey(walletKey), 'wallet-key'));
}

function walletRecoveryMatches(wallet, recoveryKey) {
  if (!wallet || !wallet.recoveryKeyHash || !validRecoveryKey(recoveryKey)) return false;
  return secureStringEqual(wallet.recoveryKeyHash, walletCredentialHash(normalizeRecoveryKey(recoveryKey), 'wallet-recovery'));
}

function normalizeWalletDeviceId(value) {
  return String(value || '').trim().slice(0, 240);
}

function walletDeviceHash(value) {
  const clean = normalizeWalletDeviceId(value);
  if (!clean) return '';
  return walletCredentialHash(clean, 'wallet-device').slice(0, 40);
}

function walletActionKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '').slice(0, 80);
}

function validWalletRequestId(value) {
  const clean = String(value || '').trim();
  return clean.length >= 12 && clean.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(clean);
}

function normalizeWalletMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  let serialized;
  try {
    serialized = stableJson(value);
  } catch (_) {
    return {};
  }
  if (Buffer.byteLength(serialized, 'utf8') > 2048) return { truncated: true };
  const clean = {};
  for (const [key, raw] of Object.entries(value).slice(0, 24)) {
    const cleanKey = String(key || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60);
    if (!cleanKey) continue;
    if (typeof raw === 'string') clean[cleanKey] = raw.slice(0, 240);
    else if (typeof raw === 'number' && Number.isFinite(raw)) clean[cleanKey] = raw;
    else if (typeof raw === 'boolean') clean[cleanKey] = raw;
  }
  return clean;
}

function walletSettingsSnapshot() {
  const settings = normalizeWalletSettings(state.walletSettings);
  return {
    enabled: settings.enabled,
    currencyName: settings.currencyName,
    welcomeBonus: settings.welcomeBonus,
    premiumUnlimited: settings.premiumUnlimited,
    dailyAdLimit: settings.dailyAdLimit,
    adReward: settings.adReward,
    prices: { ...settings.prices },
    updatedAt: settings.updatedAt || '',
  };
}

function walletRecord(id) {
  const clean = normalizeId(id);
  return validId(clean) && state.wallets ? state.wallets[clean] || null : null;
}

function walletIsLocked(wallet) {
  if (!wallet) return null;
  if (wallet.locked === true && !wallet.lockedUntil) {
    return { locked: true, reason: wallet.lockReason || 'Token işlemleri yönetici tarafından durduruldu.', until: '' };
  }
  if (wallet.lockedUntil) {
    const untilMs = Date.parse(wallet.lockedUntil);
    if (Number.isFinite(untilMs) && untilMs > Date.now()) {
      return { locked: true, reason: wallet.lockReason || 'Token işlemleri geçici olarak durduruldu.', until: wallet.lockedUntil };
    }
    wallet.locked = false;
    wallet.lockedUntil = '';
    wallet.lockReason = '';
    saveStateSoon();
  }
  return null;
}

function walletPublicSnapshot(id) {
  const clean = normalizeId(id);
  const wallet = walletRecord(clean);
  const premium = !!isPremiumGranted(clean);
  const settings = normalizeWalletSettings(state.walletSettings);
  const lock = walletIsLocked(wallet);
  return {
    id: clean,
    enrolled: !!wallet,
    balance: wallet ? Math.max(0, Math.round(Number(wallet.balance || 0))) : 0,
    unlimited: premium && settings.premiumUnlimited,
    displayBalance: premium && settings.premiumUnlimited ? '∞' : String(wallet ? Math.max(0, Math.round(Number(wallet.balance || 0))) : 0),
    currencyName: settings.currencyName,
    welcomeGranted: !!wallet?.welcomeGranted,
    locked: !!lock,
    lockReason: lock?.reason || '',
    lockedUntil: lock?.until || '',
    createdAt: wallet?.createdAt || '',
    updatedAt: wallet?.updatedAt || '',
    lastTransactionId: wallet?.lastTransactionId || '',
    integrity: walletIntegrityStatus.ok,
  };
}

function walletAdSessionPublic(session) {
  if (!session) return null;
  return {
    id: String(session.id || ''),
    customData: `rfxad:${String(session.id || '')}`,
    status: String(session.status || 'pending'),
    createdAt: String(session.createdAt || ''),
    expiresAt: String(session.expiresAt || ''),
    verifiedAt: String(session.verifiedAt || ''),
    transactionId: String(session.transactionId || ''),
  };
}

function walletAdDayKey(timezoneOffsetMinutes = 0, nowMs = Date.now()) {
  return friendUsageDayKey(timezoneOffsetMinutes, nowMs);
}

function walletAdRewardCount(id, timezoneOffsetMinutes = 0, nowMs = Date.now()) {
  const clean = normalizeId(id);
  const day = walletAdDayKey(timezoneOffsetMinutes, nowMs);
  return (state.walletTransactions || []).filter((item) => (
    item
    && item.userId === clean
    && item.action === 'rewarded_ad'
    && String(item.metadata?.adDay || '') === day
  )).length;
}

function walletAdStateSnapshot(id, timezoneOffsetMinutes = 0) {
  const settings = normalizeWalletSettings(state.walletSettings);
  const used = walletAdRewardCount(id, timezoneOffsetMinutes);
  const limit = Math.max(0, Math.round(Number(settings.dailyAdLimit || 0)));
  return {
    enabled: settings.enabled && limit > 0 && settings.adReward > 0,
    reward: Math.max(0, Math.round(Number(settings.adReward || 0))),
    dailyLimit: limit,
    dailyUsed: used,
    dailyRemaining: Math.max(0, limit - used),
    day: walletAdDayKey(timezoneOffsetMinutes),
    serverVerified: true,
  };
}

function cleanupWalletAdState({ persist = false } = {}) {
  state.walletAdSessions = state.walletAdSessions && typeof state.walletAdSessions === 'object'
    ? state.walletAdSessions
    : {};
  state.walletAdTransactions = state.walletAdTransactions && typeof state.walletAdTransactions === 'object'
    ? state.walletAdTransactions
    : {};
  const now = Date.now();
  let changed = false;

  for (const session of Object.values(state.walletAdSessions)) {
    if (!session || session.status !== 'pending') continue;
    const expiresAt = Date.parse(session.expiresAt || '');
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      session.status = 'expired';
      session.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  const sessions = Object.values(state.walletAdSessions)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  for (const session of sessions.slice(ADMOB_MAX_SESSION_RECORDS)) {
    delete state.walletAdSessions[session.id];
    changed = true;
  }
  for (const session of sessions) {
    const createdAt = Date.parse(session.createdAt || '');
    if (session.status !== 'pending' && Number.isFinite(createdAt) && createdAt < sevenDaysAgo) {
      delete state.walletAdSessions[session.id];
      changed = true;
    }
  }

  const transactionEntries = Object.entries(state.walletAdTransactions)
    .sort((a, b) => Date.parse(b[1]?.verifiedAt || 0) - Date.parse(a[1]?.verifiedAt || 0));
  for (const [transactionId] of transactionEntries.slice(ADMOB_MAX_TRANSACTION_RECORDS)) {
    delete state.walletAdTransactions[transactionId];
    changed = true;
  }

  if (changed && persist) saveStateSoon();
  return changed;
}

function walletCreateAdSession(id, timezoneOffsetMinutes = 0, deviceId = '') {
  return withWalletMutation(async () => {
    const clean = normalizeId(id);
    const settings = normalizeWalletSettings(state.walletSettings);
    const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
    if (!settings.enabled || settings.dailyAdLimit <= 0 || settings.adReward <= 0) {
      throw Object.assign(new Error('Token kazanma reklamları şu anda kapalı.'), { code: 'reward_ads_disabled' });
    }
    if (isPremiumGranted(clean) && settings.premiumUnlimited) {
      throw Object.assign(new Error('Premium hesaplarda reklamlar tamamen kapalıdır.'), { code: 'premium_ads_disabled' });
    }
    if (SUPABASE_SYNC_ENABLED && !SUPABASE_CONFIGURED) {
      throw Object.assign(new Error('Kalıcı Supabase cüzdan bağlantısı yapılandırılmadı.'), { code: 'persistent_storage_required' });
    }
    const adState = walletAdStateSnapshot(clean, offset);
    if (adState.dailyRemaining <= 0) {
      throw Object.assign(new Error('Günlük token reklam hakkı doldu.'), { code: 'daily_ad_limit', adState });
    }

    cleanupWalletAdState();
    const existing = Object.values(state.walletAdSessions || {}).find((session) => (
      session
      && session.userId === clean
      && session.status === 'pending'
      && Date.parse(session.expiresAt || '') > Date.now()
    ));
    if (existing) {
      return { session: walletAdSessionPublic(existing), adState };
    }

    const now = new Date();
    const sessionId = `ad_${crypto.randomBytes(20).toString('hex')}`;
    const session = {
      id: sessionId,
      userId: clean,
      status: 'pending',
      timezoneOffsetMinutes: offset,
      deviceHash: deviceId
        ? crypto.createHash('sha256').update(String(deviceId).slice(0, 240)).digest('hex').slice(0, 32)
        : '',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ADMOB_AD_SESSION_TTL_MS).toISOString(),
      verifiedAt: '',
      transactionId: '',
      ledgerTransactionId: '',
    };
    state.walletAdSessions[sessionId] = session;
    try {
      if (!await saveStateDurable()) throw new Error('Ad session could not be saved.');
    } catch (error) {
      delete state.walletAdSessions[sessionId];
      writeLocalStateNow();
      throw Object.assign(new Error('Reklam doğrulama oturumu kaydedilemedi.'), {
        code: error.code || 'ad_session_persistence_failed',
      });
    }
    return { session: walletAdSessionPublic(session), adState };
  });
}

function decodeBase64Url(value) {
  const clean = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

async function fetchAdmobSsvKeys() {
  if (admobSsvKeyCache.keys.size > 0 && Date.now() - admobSsvKeyCache.fetchedAt < ADMOB_KEY_CACHE_MS) {
    return admobSsvKeyCache.keys;
  }
  let response;
  try {
    response = await fetch(ADMOB_SSV_KEYS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    if (admobSsvKeyCache.keys.size > 0) return admobSsvKeyCache.keys;
    throw Object.assign(new Error(`SSV anahtarları alınamadı: ${error.message}`), {
      code: 'verification_keys_unavailable',
      statusCode: 503,
    });
  }
  if (!response.ok) {
    if (admobSsvKeyCache.keys.size > 0) return admobSsvKeyCache.keys;
    throw Object.assign(new Error(`SSV anahtar sunucusu HTTP ${response.status} döndürdü.`), {
      code: 'verification_keys_unavailable',
      statusCode: 503,
    });
  }
  const payload = await response.json();
  const keys = new Map();
  for (const item of Array.isArray(payload?.keys) ? payload.keys : []) {
    const keyId = String(item?.keyId ?? item?.key_id ?? '').trim();
    const pem = String(item?.pem || '').trim();
    if (keyId && pem.includes('BEGIN PUBLIC KEY')) keys.set(keyId, pem);
  }
  if (keys.size === 0) {
    throw Object.assign(new Error('SSV anahtar listesi boş veya geçersiz.'), {
      code: 'verification_keys_unavailable',
      statusCode: 503,
    });
  }
  admobSsvKeyCache = { fetchedAt: Date.now(), keys };
  return keys;
}

async function verifyAdmobSsvRawQuery(rawQuery) {
  const match = String(rawQuery || '').match(/^(.*)&signature=([^&]+)&key_id=([0-9]+)$/);
  if (!match) {
    throw Object.assign(new Error('SSV imza alanlarının sırası veya biçimi geçersiz.'), { code: 'invalid_signature_format' });
  }
  const signedContent = match[1];
  const signatureText = decodeURIComponent(match[2]);
  const keyId = match[3];
  const keys = await fetchAdmobSsvKeys();
  const pem = keys.get(keyId);
  if (!pem) {
    // Refresh once when Google rotates keys.
    admobSsvKeyCache = { fetchedAt: 0, keys: new Map() };
    const refreshedKeys = await fetchAdmobSsvKeys();
    if (!refreshedKeys.has(keyId)) {
      throw Object.assign(new Error('SSV key_id tanınmıyor.'), { code: 'unknown_verification_key' });
    }
  }
  const verificationKey = (await fetchAdmobSsvKeys()).get(keyId);
  let signature;
  try {
    signature = decodeBase64Url(signatureText);
  } catch (_) {
    throw Object.assign(new Error('SSV imzası çözülemedi.'), { code: 'invalid_signature_encoding' });
  }
  const verified = crypto.verify(
    'sha256',
    Buffer.from(signedContent, 'utf8'),
    verificationKey,
    signature,
  );
  if (!verified) {
    throw Object.assign(new Error('SSV imzası doğrulanamadı.'), { code: 'invalid_signature' });
  }
  return { signedContent, keyId };
}

function normalizedAdUnit(value) {
  return String(value || '').trim().replace(/^ca-app-pub-[0-9]+\//, '');
}

function normalizeAdmobTimestampMs(value) {
  let timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  if (timestamp < 100000000000) timestamp *= 1000; // seconds -> milliseconds
  while (timestamp > Date.now() * 100) timestamp /= 1000; // micro/nanoseconds -> milliseconds
  return Math.round(timestamp);
}

async function processAdmobSsvCallback(rawQuery, ip = 'unknown') {
  await verifyAdmobSsvRawQuery(rawQuery);
  const params = new URLSearchParams(rawQuery);
  const transactionId = String(params.get('transaction_id') || '').trim();
  const userId = normalizeId(params.get('user_id'));
  const customData = String(params.get('custom_data') || '').trim();
  const adUnit = String(params.get('ad_unit') || '').trim();
  const timestampMs = normalizeAdmobTimestampMs(params.get('timestamp'));
  const adNetwork = String(params.get('ad_network') || '').slice(0, 120);
  const rewardItem = String(params.get('reward_item') || '').slice(0, 80);
  const callbackRewardAmount = Math.max(0, Math.round(Number(params.get('reward_amount') || 0)));

  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(transactionId)) {
    throw Object.assign(new Error('Geçersiz AdMob transaction_id.'), { code: 'invalid_transaction_id' });
  }
  if (!validId(userId)) {
    throw Object.assign(new Error('Geçersiz SSV user_id.'), { code: 'invalid_user_id' });
  }
  if (!customData.startsWith('rfxad:')) {
    throw Object.assign(new Error('Geçersiz SSV custom_data.'), { code: 'invalid_custom_data' });
  }
  const sessionId = customData.slice('rfxad:'.length);
  if (!/^ad_[a-f0-9]{40}$/.test(sessionId)) {
    throw Object.assign(new Error('Geçersiz reklam oturumu.'), { code: 'invalid_ad_session' });
  }
  if (normalizedAdUnit(adUnit) !== normalizedAdUnit(ADMOB_REWARDED_AD_UNIT_ID)) {
    throw Object.assign(new Error('Beklenmeyen AdMob reklam birimi.'), { code: 'unexpected_ad_unit' });
  }
  if (!timestampMs || Math.abs(Date.now() - timestampMs) > ADMOB_CALLBACK_TOLERANCE_MS) {
    throw Object.assign(new Error('SSV zaman damgası kabul edilen aralığın dışında.'), { code: 'stale_callback' });
  }

  return withWalletMutation(async () => {
    state.walletAdSessions = state.walletAdSessions || {};
    state.walletAdTransactions = state.walletAdTransactions || {};
    cleanupWalletAdState();

    const knownTransaction = state.walletAdTransactions[transactionId];
    if (knownTransaction) {
      if (knownTransaction.userId !== userId || knownTransaction.sessionId !== sessionId) {
        throw Object.assign(new Error('AdMob transaction_id başka bir kullanıcı veya oturumda kullanılmış.'), { code: 'transaction_reuse' });
      }
      return {
        statusCode: 200,
        payload: { ok: true, duplicate: true, transactionId },
      };
    }

    const session = state.walletAdSessions[sessionId];
    if (!session || session.userId !== userId) {
      throw Object.assign(new Error('Reklam oturumu bulunamadı veya kullanıcı eşleşmiyor.'), { code: 'ad_session_not_found' });
    }

    const requestId = `admob:${transactionId}`;
    const existingLedgerTransaction = walletFindTransaction(userId, requestId);
    if (existingLedgerTransaction) {
      session.status = 'verified';
      session.verifiedAt = session.verifiedAt || new Date().toISOString();
      session.updatedAt = new Date().toISOString();
      session.transactionId = transactionId;
      session.ledgerTransactionId = existingLedgerTransaction.id;
      state.walletAdTransactions[transactionId] = {
        userId,
        sessionId,
        ledgerTransactionId: existingLedgerTransaction.id,
        verifiedAt: session.verifiedAt,
      };
      await saveStateDurable();
      return { statusCode: 200, payload: { ok: true, duplicate: true, transactionId } };
    }

    if (session.status === 'verified') {
      throw Object.assign(new Error('Bu reklam oturumu daha önce farklı bir işlemle doğrulandı.'), { code: 'session_already_verified' });
    }
    if (session.status !== 'pending' || Date.parse(session.expiresAt || '') <= Date.now()) {
      throw Object.assign(new Error('Reklam doğrulama oturumunun süresi doldu.'), { code: 'ad_session_expired' });
    }

    const settings = normalizeWalletSettings(state.walletSettings);
    const offset = normalizeTimezoneOffset(session.timezoneOffsetMinutes);
    const adState = walletAdStateSnapshot(userId, offset);
    if (!adState.enabled || adState.dailyRemaining <= 0) {
      throw Object.assign(new Error('Günlük token reklam hakkı doldu.'), { code: 'daily_ad_limit' });
    }
    const reward = Math.max(0, Math.round(Number(settings.adReward || 0)));
    if (reward <= 0) {
      throw Object.assign(new Error('Reklam token ödülü kapalı.'), { code: 'reward_ads_disabled' });
    }

    const ledgerTransaction = await walletCommitDeltaUnlocked({
      id: userId,
      delta: reward,
      type: 'REWARD',
      action: 'rewarded_ad',
      requestId,
      source: 'admob_ssv',
      metadata: {
        adDay: walletAdDayKey(offset),
        timezoneOffsetMinutes: offset,
        adNetwork,
        adUnit: normalizedAdUnit(adUnit),
        rewardItem,
        callbackRewardAmount,
        sessionId,
      },
    });

    session.status = 'verified';
    session.verifiedAt = new Date().toISOString();
    session.updatedAt = session.verifiedAt;
    session.transactionId = transactionId;
    session.ledgerTransactionId = ledgerTransaction.id;
    state.walletAdTransactions[transactionId] = {
      userId,
      sessionId,
      ledgerTransactionId: ledgerTransaction.id,
      verifiedAt: session.verifiedAt,
    };
    if (!await saveStateDurable()) {
      throw Object.assign(new Error('SSV sonuç kaydı kalıcı veritabanına yazılamadı.'), { code: 'ssv_persistence_failed', statusCode: 503 });
    }

    walletSecurityEvent('admob_ssv_reward_verified', {
      id: userId,
      sessionId,
      transactionId,
      ip,
      reward,
    }, 'info');
    sendTo(userId, {
      type: 'wallet_changed',
      wallet: walletPublicSnapshot(userId),
      reason: 'rewarded_ad_verified',
      transaction: {
        id: ledgerTransaction.id,
        amount: ledgerTransaction.amount,
        action: ledgerTransaction.action,
        balanceAfter: ledgerTransaction.balanceAfter,
        createdAt: ledgerTransaction.createdAt,
      },
      serverTime: new Date().toISOString(),
    });
    return {
      statusCode: 200,
      payload: { ok: true, duplicate: false, transactionId },
    };
  });
}

function googlePlayServiceAccount() {
  let raw = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) {
    const encoded = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64 || '').trim();
    if (encoded) {
      try { raw = Buffer.from(encoded, 'base64').toString('utf8'); } catch (_) { raw = ''; }
    }
  }
  let parsed = null;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  }
  const clientEmail = String(parsed?.client_email || process.env.GOOGLE_PLAY_CLIENT_EMAIL || '').trim();
  const privateKey = String(parsed?.private_key || process.env.GOOGLE_PLAY_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .trim();
  return clientEmail && privateKey.includes('BEGIN PRIVATE KEY')
    ? { clientEmail, privateKey }
    : null;
}

function googlePlayConfigured() {
  if (GOOGLE_PLAY_LOCAL_TESTS_ALLOWED && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(GOOGLE_PLAY_API_BASE_URL)) {
    return true;
  }
  return !!googlePlayServiceAccount();
}

function googlePlayBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function googlePlayAccessToken() {
  if (GOOGLE_PLAY_LOCAL_TESTS_ALLOWED && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(GOOGLE_PLAY_API_BASE_URL)) {
    return 'local-test-token';
  }
  const now = Date.now();
  if (googlePlayAccessTokenCache.token && googlePlayAccessTokenCache.expiresAt - 60000 > now) {
    return googlePlayAccessTokenCache.token;
  }
  const account = googlePlayServiceAccount();
  if (!account) {
    throw Object.assign(new Error('Google Play service account yapılandırılmadı.'), { code: 'play_not_configured' });
  }
  const issuedAt = Math.floor(now / 1000);
  const header = googlePlayBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = googlePlayBase64Url(JSON.stringify({
    iss: account.clientEmail,
    scope: GOOGLE_PLAY_SCOPE,
    aud: GOOGLE_PLAY_OAUTH_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.privateKey).toString('base64url');
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch(GOOGLE_PLAY_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw Object.assign(new Error(`Google Play OAuth başarısız: ${body.error_description || body.error || response.status}`), {
      code: 'play_oauth_failed',
      statusCode: response.status,
    });
  }
  googlePlayAccessTokenCache = {
    token: String(body.access_token),
    expiresAt: now + Math.max(300, Number(body.expires_in || 3600)) * 1000,
  };
  return googlePlayAccessTokenCache.token;
}

async function googlePlayApiRequest(method, apiPath, { query = null, body = null } = {}) {
  if (!googlePlayConfigured()) {
    throw Object.assign(new Error('Google Play satın alma doğrulaması yapılandırılmadı.'), { code: 'play_not_configured' });
  }
  const accessToken = await googlePlayAccessToken();
  const url = new URL(`${GOOGLE_PLAY_API_BASE_URL}${apiPath}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text.slice(0, 500) }; }
  }
  if (!response.ok) {
    const message = parsed?.error?.message || parsed?.message || `Google Play API HTTP ${response.status}`;
    throw Object.assign(new Error(message), {
      code: response.status === 404 ? 'play_purchase_not_found' : 'play_api_failed',
      statusCode: response.status,
      playError: parsed?.error || parsed,
    });
  }
  return parsed;
}

function googlePlayPurchaseTokenHash(purchaseToken) {
  return crypto.createHmac('sha256', WALLET_LEDGER_SECRET)
    .update(`RELAXFPS:PLAY:PURCHASE:${String(purchaseToken || '')}`, 'utf8')
    .digest('hex');
}

function googlePlayObfuscatedAccountId(id) {
  return crypto.createHmac('sha256', WALLET_LEDGER_SECRET)
    .update(`RELAXFPS:PLAY:ACCOUNT:${normalizeId(id)}`, 'utf8')
    .digest('hex');
}

function googlePlayCatalogSnapshot(id = '') {
  return {
    configured: googlePlayConfigured(),
    packageName: GOOGLE_PLAY_PACKAGE_NAME,
    obfuscatedAccountId: validId(normalizeId(id)) ? googlePlayObfuscatedAccountId(id) : '',
    products: Object.entries(GOOGLE_PLAY_TOKEN_PRODUCTS).map(([productId, item]) => ({
      productId,
      amount: item.amount,
      label: item.label,
      consumable: true,
    })),
  };
}

function googlePlayPurchasePublic(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: String(item.id || item.tokenHash || '').slice(0, 80),
    productId: String(item.productId || ''),
    amount: Math.max(0, Math.round(Number(item.amount || 0))),
    status: String(item.status || ''),
    orderId: String(item.orderId || ''),
    purchasedAt: String(item.purchasedAt || ''),
    verifiedAt: String(item.verifiedAt || ''),
    consumedAt: String(item.consumedAt || ''),
    reversedAt: String(item.reversedAt || ''),
    reversedAmount: Math.max(0, Math.round(Number(item.reversedAmount || 0))),
    unrecoveredAmount: Math.max(0, Math.round(Number(item.unrecoveredAmount || 0))),
    regionCode: String(item.regionCode || ''),
  };
}

function googlePlayPurchaseHistory(id, limit = 50) {
  const clean = normalizeId(id);
  const maxItems = Math.max(1, Math.min(Math.round(Number(limit || 50)), 200));
  return Object.values(state.playPurchases || {})
    .filter((item) => normalizeId(item?.userId) === clean)
    .sort((a, b) => Date.parse(b?.verifiedAt || b?.purchasedAt || 0) - Date.parse(a?.verifiedAt || a?.purchasedAt || 0))
    .slice(0, maxItems)
    .map(googlePlayPurchasePublic)
    .filter(Boolean);
}

function googlePlayTrimPurchases() {
  state.playPurchases = state.playPurchases && typeof state.playPurchases === 'object' ? state.playPurchases : {};
  const entries = Object.entries(state.playPurchases);
  if (entries.length <= GOOGLE_PLAY_MAX_PURCHASE_RECORDS) return;
  entries.sort((a, b) => Date.parse(a[1]?.verifiedAt || a[1]?.purchasedAt || 0) - Date.parse(b[1]?.verifiedAt || b[1]?.purchasedAt || 0));
  const removeCount = entries.length - GOOGLE_PLAY_MAX_PURCHASE_RECORDS;
  for (const [tokenHash, item] of entries.slice(0, removeCount)) {
    if (item?.orderId) delete state.playPurchaseOrderIndex[item.orderId];
    delete state.playPurchases[tokenHash];
  }
}

async function googlePlayGetProductPurchase(productId, purchaseToken) {
  const encodedPackage = encodeURIComponent(GOOGLE_PLAY_PACKAGE_NAME);
  const encodedProduct = encodeURIComponent(productId);
  const encodedToken = encodeURIComponent(purchaseToken);
  return googlePlayApiRequest(
    'GET',
    `/androidpublisher/v3/applications/${encodedPackage}/purchases/products/${encodedProduct}/tokens/${encodedToken}`,
  );
}

async function googlePlayConsumeProduct(productId, purchaseToken) {
  const encodedPackage = encodeURIComponent(GOOGLE_PLAY_PACKAGE_NAME);
  const encodedProduct = encodeURIComponent(productId);
  const encodedToken = encodeURIComponent(purchaseToken);
  await googlePlayApiRequest(
    'POST',
    `/androidpublisher/v3/applications/${encodedPackage}/purchases/products/${encodedProduct}/tokens/${encodedToken}:consume`,
  );
  return true;
}

async function googlePlayVerifyAndGrant({ id, productId, purchaseToken, clientOrderId = '' }) {
  const clean = normalizeId(id);
  const cleanProduct = String(productId || '').trim();
  const token = String(purchaseToken || '').trim();
  const product = GOOGLE_PLAY_TOKEN_PRODUCTS[cleanProduct];
  if (!validId(clean) || !product) {
    throw Object.assign(new Error('Geçersiz kullanıcı veya RFX ürünü.'), { code: 'invalid_play_product' });
  }
  if (token.length < 20 || token.length > 4096) {
    throw Object.assign(new Error('Geçersiz Google Play purchase token.'), { code: 'invalid_purchase_token' });
  }
  const tokenHash = googlePlayPurchaseTokenHash(token);
  if (googlePlayPurchaseLocks.has(tokenHash)) return googlePlayPurchaseLocks.get(tokenHash);

  const task = (async () => {
    state.playPurchases = state.playPurchases || {};
    state.playPurchaseOrderIndex = state.playPurchaseOrderIndex || {};
    let existing = state.playPurchases[tokenHash] || null;
    if (existing) {
      if (existing.userId !== clean || existing.productId !== cleanProduct) {
        walletSecurityEvent('play_purchase_token_reuse', { id: clean, productId: cleanProduct, tokenHash }, 'high');
        throw Object.assign(new Error('Bu satın alma başka bir cüzdana veya ürüne bağlı.'), { code: 'purchase_token_reused' });
      }
      if (existing.status === 'reversed') {
        throw Object.assign(new Error('Bu satın alma Google Play tarafından iade veya iptal edildi.'), { code: 'purchase_reversed' });
      }
      if (existing.status === 'consumed') {
        return { duplicate: true, consumed: true, record: existing, transaction: walletFindTransaction(clean, `play:${tokenHash}`) };
      }
      try {
        const latest = await googlePlayGetProductPurchase(cleanProduct, token);
        const latestPurchaseState = Math.round(Number(latest.purchaseState ?? -1));
        const latestProductId = String(latest.productId || cleanProduct);
        const latestAccountId = String(latest.obfuscatedExternalAccountId || '');
        if (latestPurchaseState !== 0) {
          throw Object.assign(new Error('Google Play satın alımı artık geçerli değil.'), { code: 'purchase_not_purchased' });
        }
        if (latestProductId !== cleanProduct || latestAccountId !== googlePlayObfuscatedAccountId(clean)) {
          throw Object.assign(new Error('Google Play satın alma bağlamı değişti.'), { code: 'purchase_context_mismatch' });
        }
        if (Math.round(Number(latest.consumptionState || 0)) !== 1) {
          await googlePlayConsumeProduct(cleanProduct, token);
        }
        existing.status = 'consumed';
        existing.consumedAt = existing.consumedAt || new Date().toISOString();
        existing.lastError = '';
        await saveStateDurable();
        return { duplicate: true, consumed: true, record: existing, transaction: walletFindTransaction(clean, `play:${tokenHash}`) };
      } catch (error) {
        existing.lastError = String(error.message || '').slice(0, 240);
        existing.lastConsumeAttemptAt = new Date().toISOString();
        await saveStateDurable();
        return { duplicate: true, consumed: false, record: existing, transaction: walletFindTransaction(clean, `play:${tokenHash}`) };
      }
    }

    const requestKey = `play:${tokenHash}`;
    const recoveredTransaction = walletFindTransaction(clean, requestKey);
    const verified = await googlePlayGetProductPurchase(cleanProduct, token);
    const purchaseState = Math.round(Number(verified.purchaseState ?? -1));
    const consumptionState = Math.round(Number(verified.consumptionState ?? 0));
    const quantity = Math.max(1, Math.round(Number(verified.quantity || 1)));
    const verifiedProduct = String(verified.productId || cleanProduct);
    const expectedAccountId = googlePlayObfuscatedAccountId(clean);
    const returnedAccountId = String(verified.obfuscatedExternalAccountId || '');

    if (purchaseState === 2) {
      throw Object.assign(new Error('Google Play ödemesi hâlâ beklemede.'), { code: 'purchase_pending' });
    }
    if (purchaseState !== 0) {
      throw Object.assign(new Error('Google Play satın alımı iptal edilmiş veya geçersiz.'), { code: 'purchase_not_purchased' });
    }
    if (consumptionState === 1 && !recoveredTransaction) {
      throw Object.assign(new Error('Bu satın alma daha önce tüketilmiş.'), { code: 'purchase_already_consumed' });
    }
    if (verifiedProduct !== cleanProduct || quantity !== 1) {
      throw Object.assign(new Error('Google Play ürün bilgisi beklenen paketle eşleşmiyor.'), { code: 'purchase_product_mismatch' });
    }
    if (!returnedAccountId || returnedAccountId !== expectedAccountId) {
      walletSecurityEvent('play_account_binding_mismatch', {
        id: clean,
        productId: cleanProduct,
        missing: !returnedAccountId,
      }, 'high');
      throw Object.assign(new Error('Satın alma RelaxFPS cüzdan kimliğiyle eşleşmiyor.'), { code: 'purchase_account_mismatch' });
    }

    const orderId = String(verified.orderId || clientOrderId || '').slice(0, 160);
    if (orderId && state.playPurchaseOrderIndex[orderId] && state.playPurchaseOrderIndex[orderId] !== tokenHash) {
      walletSecurityEvent('play_order_reuse', { id: clean, productId: cleanProduct, orderId }, 'high');
      throw Object.assign(new Error('Google Play sipariş kimliği daha önce kullanılmış.'), { code: 'purchase_order_reused' });
    }

    let transaction = recoveredTransaction;
    if (!transaction) {
      transaction = await walletCommitDelta({
        id: clean,
        delta: product.amount,
        type: 'GOOGLE_PLAY_PURCHASE',
        action: cleanProduct,
        requestId: requestKey,
        source: 'google_play_server',
        metadata: {
          productId: cleanProduct,
          orderId,
          purchaseTimeMillis: String(verified.purchaseTimeMillis || ''),
          regionCode: String(verified.regionCode || ''),
          purchaseType: verified.purchaseType,
        },
      });
    }

    existing = {
      id: tokenHash,
      tokenHash,
      userId: clean,
      productId: cleanProduct,
      amount: product.amount,
      status: consumptionState === 1 ? 'consumed' : 'credited_unconsumed',
      orderId,
      purchasedAt: verified.purchaseTimeMillis
        ? new Date(Number(verified.purchaseTimeMillis)).toISOString()
        : new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      consumedAt: consumptionState === 1 ? new Date().toISOString() : '',
      reversedAt: '',
      reversedAmount: 0,
      unrecoveredAmount: 0,
      regionCode: String(verified.regionCode || ''),
      ledgerTransactionId: transaction.id,
      lastError: '',
    };
    state.playPurchases[tokenHash] = existing;
    if (orderId) state.playPurchaseOrderIndex[orderId] = tokenHash;
    googlePlayTrimPurchases();
    await saveStateDurable();

    let consumed = consumptionState === 1;
    try {
      if (!consumed) await googlePlayConsumeProduct(cleanProduct, token);
      consumed = true;
      existing.status = 'consumed';
      existing.consumedAt = new Date().toISOString();
      existing.lastError = '';
    } catch (error) {
      existing.lastError = String(error.message || '').slice(0, 240);
      existing.lastConsumeAttemptAt = new Date().toISOString();
      walletSecurityEvent('play_consume_failed', { id: clean, productId: cleanProduct, tokenHash, code: error.code || 'error' }, 'warning');
    }
    await saveStateDurable();
    walletSecurityEvent('play_purchase_verified', { id: clean, productId: cleanProduct, amount: product.amount, consumed }, 'info');
    sendTo(clean, {
      type: 'wallet_changed',
      wallet: walletPublicSnapshot(clean),
      reason: 'google_play_purchase',
      transaction: {
        id: transaction.id,
        amount: transaction.amount,
        action: transaction.action,
        balanceAfter: transaction.balanceAfter,
        createdAt: transaction.createdAt,
      },
      serverTime: new Date().toISOString(),
    });
    return { duplicate: false, consumed, record: existing, transaction };
  })().finally(() => googlePlayPurchaseLocks.delete(tokenHash));

  googlePlayPurchaseLocks.set(tokenHash, task);
  return task;
}

async function googlePlayApplyVoidedPurchase(item) {
  const purchaseToken = String(item?.purchaseToken || '').trim();
  if (!purchaseToken) return false;
  const tokenHash = googlePlayPurchaseTokenHash(purchaseToken);
  const record = state.playPurchases?.[tokenHash];
  if (!record || record.status === 'reversed') return false;
  const wallet = walletRecord(record.userId);
  if (!wallet) return false;
  const amount = Math.max(0, Math.round(Number(record.amount || 0)));
  const available = Math.max(0, Math.round(Number(wallet.balance || 0)));
  const recoverable = Math.min(amount, available);
  const voidedTimeMillis = Math.max(0, Math.round(Number(item.voidedTimeMillis || Date.now())));
  const requestKey = `play-refund:${tokenHash}:${voidedTimeMillis}`;
  let transaction = walletFindTransaction(record.userId, requestKey);
  if (!transaction) {
    transaction = await walletCommitDelta({
      id: record.userId,
      delta: -recoverable,
      type: 'GOOGLE_PLAY_REFUND',
      action: record.productId,
      requestId: requestKey,
      source: 'google_play_voided_purchases',
      metadata: {
        orderId: String(item.orderId || record.orderId || ''),
        voidedReason: item.voidedReason,
        voidedSource: item.voidedSource,
        voidedTimeMillis,
        originalAmount: amount,
        unrecoveredAmount: amount - recoverable,
      },
    });
  }
  record.status = 'reversed';
  record.reversedAt = new Date(voidedTimeMillis).toISOString();
  record.reversedAmount = recoverable;
  record.unrecoveredAmount = amount - recoverable;
  record.refundLedgerTransactionId = transaction.id;
  record.voidedReason = item.voidedReason;
  record.voidedSource = item.voidedSource;
  await saveStateDurable();
  walletSecurityEvent('play_purchase_reversed', {
    id: record.userId,
    productId: record.productId,
    amount,
    recovered: recoverable,
    unrecovered: amount - recoverable,
  }, amount > recoverable ? 'high' : 'warning');
  sendTo(record.userId, {
    type: 'wallet_changed',
    wallet: walletPublicSnapshot(record.userId),
    reason: 'google_play_refund',
    serverTime: new Date().toISOString(),
  });
  return true;
}

async function googlePlaySyncVoidedPurchases({ force = false } = {}) {
  if (!googlePlayConfigured() || googlePlayVoidedSyncRunning) return { ok: false, skipped: true };
  googlePlayVoidedSyncRunning = true;
  try {
    state.playPurchaseSync = state.playPurchaseSync || { lastVoidedSyncAt: '', startTimeMs: 0, lastError: '' };
    const previousStart = Math.max(0, Number(state.playPurchaseSync.startTimeMs || 0));
    const startTimeMs = force || !previousStart
      ? Date.now() - 30 * 24 * 60 * 60 * 1000
      : Math.max(0, previousStart - 5 * 60 * 1000);
    let pageToken = '';
    let reversed = 0;
    let pages = 0;
    do {
      const encodedPackage = encodeURIComponent(GOOGLE_PLAY_PACKAGE_NAME);
      const response = await googlePlayApiRequest(
        'GET',
        `/androidpublisher/v3/applications/${encodedPackage}/purchases/voidedpurchases`,
        { query: { startTime: startTimeMs, maxResults: 1000, token: pageToken || undefined, type: 0 } },
      );
      for (const item of Array.isArray(response.voidedPurchases) ? response.voidedPurchases : []) {
        if (await googlePlayApplyVoidedPurchase(item)) reversed += 1;
      }
      pageToken = String(response.tokenPagination?.nextPageToken || '');
      pages += 1;
    } while (pageToken && pages < 20);
    state.playPurchaseSync.lastVoidedSyncAt = new Date().toISOString();
    state.playPurchaseSync.startTimeMs = Date.now();
    state.playPurchaseSync.lastError = '';
    await saveStateDurable();
    return { ok: true, reversed, pages };
  } catch (error) {
    state.playPurchaseSync = state.playPurchaseSync || {};
    state.playPurchaseSync.lastError = String(error.message || '').slice(0, 300);
    state.playPurchaseSync.lastVoidedSyncAt = new Date().toISOString();
    writeLocalStateNow();
    console.warn('[GOOGLE PLAY] Voided purchase sync failed:', error.message);
    return { ok: false, code: error.code || 'voided_sync_failed', message: error.message };
  } finally {
    googlePlayVoidedSyncRunning = false;
  }
}


function walletRateLimit(key, maxCount, windowMs, blockMs = 0) {
  const now = Date.now();
  const cleanKey = String(key || '').slice(0, 320);
  const current = walletRateLimits.get(cleanKey) || { count: 0, windowStartedAt: now, blockedUntil: 0 };
  if (current.blockedUntil > now) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.blockedUntil - now) / 1000)) };
  }
  if (now - current.windowStartedAt >= windowMs) {
    current.count = 0;
    current.windowStartedAt = now;
    current.blockedUntil = 0;
  }
  current.count += 1;
  if (current.count > maxCount) {
    if (blockMs > 0) current.blockedUntil = now + blockMs;
    walletRateLimits.set(cleanKey, current);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil(((current.blockedUntil || current.windowStartedAt + windowMs) - now) / 1000)),
    };
  }
  walletRateLimits.set(cleanKey, current);
  return { ok: true, remaining: Math.max(0, maxCount - current.count) };
}

function walletSecurityEvent(event, details = {}, severity = 'warning') {
  state.walletSecurityEvents = Array.isArray(state.walletSecurityEvents) ? state.walletSecurityEvents : [];
  const item = {
    id: `wse-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    event: String(event || 'unknown').slice(0, 100),
    severity: String(severity || 'warning').slice(0, 20),
    details: normalizeWalletMetadata(details),
    time: new Date().toISOString(),
  };
  state.walletSecurityEvents.push(item);
  if (state.walletSecurityEvents.length > WALLET_MAX_SECURITY_EVENTS) {
    state.walletSecurityEvents = state.walletSecurityEvents.slice(-WALLET_MAX_SECURITY_EVENTS);
  }
  saveStateSoon();
  return item;
}

function walletAuthFailure(ip, id, reason) {
  const key = `${String(ip || 'unknown').slice(0, 120)}:${normalizeId(id)}`;
  const now = Date.now();
  const current = walletAuthFailures.get(key) || { count: 0, firstFailureAt: now, lastFailureAt: now, blockedUntil: 0 };
  if (now - current.firstFailureAt > 10 * 60 * 1000) {
    current.count = 0;
    current.firstFailureAt = now;
    current.blockedUntil = 0;
  }
  current.count += 1;
  current.lastFailureAt = now;
  if (current.count >= 8) current.blockedUntil = now + 15 * 60 * 1000;
  walletAuthFailures.set(key, current);
  walletSecurityEvent('wallet_auth_failed', { id: normalizeId(id), ip: String(ip || 'unknown'), reason, count: current.count }, current.count >= 8 ? 'high' : 'warning');
  return current;
}

function walletAuthThrottle(ip, id) {
  const key = `${String(ip || 'unknown').slice(0, 120)}:${normalizeId(id)}`;
  const current = walletAuthFailures.get(key);
  if (!current || current.blockedUntil <= Date.now()) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.ceil((current.blockedUntil - Date.now()) / 1000) };
}

function walletClearAuthFailures(ip, id) {
  walletAuthFailures.delete(`${String(ip || 'unknown').slice(0, 120)}:${normalizeId(id)}`);
}

function walletTransactionHash(transaction) {
  const payload = {
    sequence: Number(transaction.sequence || 0),
    id: String(transaction.id || ''),
    userId: normalizeId(transaction.userId),
    type: String(transaction.type || ''),
    amount: Math.round(Number(transaction.amount || 0)),
    balanceBefore: Math.round(Number(transaction.balanceBefore || 0)),
    balanceAfter: Math.round(Number(transaction.balanceAfter || 0)),
    action: walletActionKey(transaction.action),
    requestId: String(transaction.requestId || ''),
    source: String(transaction.source || ''),
    createdAt: String(transaction.createdAt || ''),
    previousHash: String(transaction.previousHash || ''),
    metadata: normalizeWalletMetadata(transaction.metadata),
  };
  return crypto.createHmac('sha256', WALLET_LEDGER_SECRET).update(stableJson(payload), 'utf8').digest('hex');
}

function rebuildWalletRequestIndex() {
  const index = {};
  for (const transaction of (state.walletTransactions || []).slice(-WALLET_MAX_REQUEST_INDEX)) {
    if (!transaction?.userId || !transaction?.requestId) continue;
    index[`${normalizeId(transaction.userId)}:${String(transaction.requestId)}`] = transaction.id;
  }
  state.walletRequestIndex = index;
}

function verifyWalletLedger() {
  const transactions = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  const anchor = state.walletLedgerAnchor && typeof state.walletLedgerAnchor === 'object'
    ? state.walletLedgerAnchor
    : { sequence: 0, hash: 'GENESIS' };
  if (!transactions.length) {
    state.walletLedgerKeyId = WALLET_LEDGER_KEY_ID;
    state.walletLedgerHead = String(anchor.hash || 'GENESIS');
    state.walletLedgerSequence = Math.max(0, Math.round(Number(anchor.sequence || 0)));
    rebuildWalletRequestIndex();
    walletIntegrityStatus = { ok: true, code: 'empty_ledger', checkedAt: new Date().toISOString() };
    return walletIntegrityStatus;
  }
  if (state.walletLedgerKeyId && state.walletLedgerKeyId !== WALLET_LEDGER_KEY_ID) {
    walletIntegrityStatus = { ok: false, code: 'ledger_secret_mismatch', checkedAt: new Date().toISOString() };
    console.error('[WALLET] Ledger secret mismatch. Wallet mutations are disabled.');
    return walletIntegrityStatus;
  }
  let expectedPreviousHash = String(anchor.hash || 'GENESIS');
  let expectedSequence = Math.max(0, Math.round(Number(anchor.sequence || 0))) + 1;
  for (const transaction of transactions) {
    if (Number(transaction.sequence || 0) !== expectedSequence
      || String(transaction.previousHash || '') !== expectedPreviousHash
      || !secureStringEqual(String(transaction.hash || ''), walletTransactionHash(transaction))) {
      walletIntegrityStatus = {
        ok: false,
        code: 'ledger_integrity_failed',
        transactionId: String(transaction.id || ''),
        sequence: Number(transaction.sequence || 0),
        checkedAt: new Date().toISOString(),
      };
      console.error(`[WALLET] Ledger integrity failed at transaction ${transaction.id || '?'} sequence ${transaction.sequence || '?'}.`);
      return walletIntegrityStatus;
    }
    expectedPreviousHash = String(transaction.hash || '');
    expectedSequence += 1;
  }
  state.walletLedgerKeyId = WALLET_LEDGER_KEY_ID;
  state.walletLedgerHead = expectedPreviousHash;
  state.walletLedgerSequence = expectedSequence - 1;
  rebuildWalletRequestIndex();
  walletIntegrityStatus = {
    ok: true,
    code: 'verified',
    sequence: state.walletLedgerSequence,
    checkedAt: new Date().toISOString(),
  };
  return walletIntegrityStatus;
}

function walletFindTransaction(id, requestId) {
  const key = `${normalizeId(id)}:${String(requestId || '')}`;
  const transactionId = state.walletRequestIndex?.[key];
  if (!transactionId) return null;
  return (state.walletTransactions || []).find((item) => item.id === transactionId) || null;
}

function walletTrimLedgerIfNeeded() {
  state.walletTransactions = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  if (state.walletTransactions.length <= WALLET_MAX_TRANSACTIONS) return;
  const removeCount = state.walletTransactions.length - WALLET_MAX_TRANSACTIONS;
  const removed = state.walletTransactions.splice(0, removeCount);
  const lastRemoved = removed[removed.length - 1];
  if (lastRemoved) {
    state.walletLedgerAnchor = {
      sequence: Number(lastRemoved.sequence || 0),
      hash: String(lastRemoved.hash || 'GENESIS'),
      archivedAt: new Date().toISOString(),
    };
  }
  rebuildWalletRequestIndex();
}

async function walletCommitDeltaUnlocked({ id, delta, type, action, requestId, source, metadata = {} }) {
  const clean = normalizeId(id);
  const wallet = walletRecord(clean);
  if (!wallet) throw Object.assign(new Error('RFX Token cüzdanı bulunamadı.'), { code: 'wallet_not_enrolled' });
  if (!walletIntegrityStatus.ok) throw Object.assign(new Error('Token işlem defteri güvenlik kontrolünden geçemedi.'), { code: 'ledger_unavailable' });
  if (SUPABASE_SYNC_ENABLED && !SUPABASE_CONFIGURED) {
    throw Object.assign(new Error('Kalıcı Supabase cüzdan bağlantısı yapılandırılmadı.'), { code: 'persistent_storage_required' });
  }
  if (supabaseStatus.conflict) {
    throw Object.assign(new Error('Bulut veri sürümü çakıştı; token işlemleri güvenlik için durduruldu.'), { code: 'supabase_revision_conflict' });
  }
  const settings = normalizeWalletSettings(state.walletSettings);
  if (!settings.enabled) throw Object.assign(new Error('RFX Token sistemi geçici olarak kapalı.'), { code: 'wallet_disabled' });
  const lock = walletIsLocked(wallet);
  if (lock) throw Object.assign(new Error(lock.reason), { code: 'wallet_locked', lockedUntil: lock.until });

  const signedDelta = Math.round(Number(delta || 0));
  if (!Number.isFinite(signedDelta) || Math.abs(signedDelta) > 10000000) {
    throw Object.assign(new Error('Geçersiz token miktarı.'), { code: 'invalid_amount' });
  }
  const before = Math.max(0, Math.round(Number(wallet.balance || 0)));
  const after = before + signedDelta;
  if (after < 0) throw Object.assign(new Error('Yetersiz RFX Token bakiyesi.'), { code: 'insufficient_balance', balance: before, required: Math.abs(signedDelta) });
  if (after > WALLET_MAX_BALANCE) throw Object.assign(new Error('Cüzdan üst bakiye sınırına ulaştı.'), { code: 'wallet_balance_limit' });

  const previousState = {
    balance: wallet.balance,
    updatedAt: wallet.updatedAt,
    lastTransactionId: wallet.lastTransactionId,
    ledgerLength: state.walletTransactions.length,
    ledgerHead: state.walletLedgerHead,
    ledgerSequence: state.walletLedgerSequence,
    requestIndexValue: state.walletRequestIndex?.[`${clean}:${requestId}`],
    anchor: { ...(state.walletLedgerAnchor || {}) },
  };

  const sequence = Math.max(0, Math.round(Number(state.walletLedgerSequence || 0))) + 1;
  const transaction = {
    id: `rfx-${sequence}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
    sequence,
    userId: clean,
    type: String(type || 'ADJUSTMENT').slice(0, 50),
    amount: signedDelta,
    balanceBefore: before,
    balanceAfter: after,
    action: walletActionKey(action),
    requestId: String(requestId || '').slice(0, 160),
    source: String(source || 'server').slice(0, 80),
    metadata: normalizeWalletMetadata(metadata),
    createdAt: new Date().toISOString(),
    previousHash: String(state.walletLedgerHead || state.walletLedgerAnchor?.hash || 'GENESIS'),
  };
  transaction.hash = walletTransactionHash(transaction);

  wallet.balance = after;
  wallet.updatedAt = transaction.createdAt;
  wallet.lastTransactionId = transaction.id;
  state.walletTransactions.push(transaction);
  state.walletLedgerSequence = sequence;
  state.walletLedgerHead = transaction.hash;
  state.walletLedgerKeyId = WALLET_LEDGER_KEY_ID;
  state.walletRequestIndex = state.walletRequestIndex || {};
  if (requestId) state.walletRequestIndex[`${clean}:${requestId}`] = transaction.id;
  walletTrimLedgerIfNeeded();

  try {
    if (!await saveStateDurable()) throw new Error('Local state could not be saved.');
  } catch (error) {
    wallet.balance = previousState.balance;
    wallet.updatedAt = previousState.updatedAt;
    wallet.lastTransactionId = previousState.lastTransactionId;
    state.walletTransactions = state.walletTransactions.slice(0, previousState.ledgerLength);
    state.walletLedgerHead = previousState.ledgerHead;
    state.walletLedgerSequence = previousState.ledgerSequence;
    state.walletLedgerAnchor = previousState.anchor;
    if (requestId) {
      const key = `${clean}:${requestId}`;
      if (previousState.requestIndexValue) state.walletRequestIndex[key] = previousState.requestIndexValue;
      else delete state.walletRequestIndex[key];
    }
    writeLocalStateNow();
    throw Object.assign(new Error('Token işlemi kalıcı veritabanına güvenli şekilde kaydedilemedi.'), {
      code: error.code || 'wallet_persistence_failed',
    });
  }
  return transaction;
}

function walletCommitDelta(args) {
  return withWalletMutation(() => walletCommitDeltaUnlocked(args));
}

function walletEnroll(id, walletKey, recoveryKey, deviceId = '') {
  return withWalletMutation(async () => {
    const clean = normalizeId(id);
    if (!validId(clean) || !validWalletKey(walletKey) || !validRecoveryKey(recoveryKey)) {
      throw Object.assign(new Error('Geçerli RelaxFPS ID, cüzdan anahtarı ve kurtarma anahtarı gerekli.'), { code: 'invalid_wallet_credentials' });
    }
    const existing = walletRecord(clean);
    if (existing) {
      if (!walletKeyMatches(existing, walletKey)) {
        throw Object.assign(new Error('Bu RelaxFPS ID için cüzdan zaten oluşturulmuş.'), { code: 'wallet_already_enrolled' });
      }
      const deviceHash = walletDeviceHash(deviceId);
      if (deviceHash) existing.devices = Array.from(new Set([...(existing.devices || []), deviceHash])).slice(-8);
      existing.lastAccessAt = new Date().toISOString();
      await saveStateDurable();
      return { wallet: existing, created: false, transaction: null };
    }

    const cloudRecord = (state.cloudBackups || {})[clean] || null;
    if (!cloudRecord) {
      throw Object.assign(
        new Error('Cüzdan oluşturmadan önce aynı kurtarma anahtarıyla bulut yedeği etkinleştirilmeli.'),
        { code: 'recovery_binding_required' },
      );
    }
    if (!cloudBackupKeyMatches(cloudRecord, recoveryKey)) {
      throw Object.assign(new Error('Bulut yedeğindeki kurtarma anahtarıyla eşleşmedi.'), { code: 'recovery_key_mismatch' });
    }

    const stateBefore = JSON.parse(JSON.stringify({
      wallets: state.wallets,
      walletTransactions: state.walletTransactions,
      walletRequestIndex: state.walletRequestIndex,
      walletLedgerHead: state.walletLedgerHead,
      walletLedgerSequence: state.walletLedgerSequence,
      walletLedgerAnchor: state.walletLedgerAnchor,
      walletLedgerKeyId: state.walletLedgerKeyId,
    }));
    const now = new Date().toISOString();
    const deviceHash = walletDeviceHash(deviceId);
    const wallet = {
      id: clean,
      balance: 0,
      walletKeyHash: walletCredentialHash(normalizeWalletKey(walletKey), 'wallet-key'),
      recoveryKeyHash: walletCredentialHash(normalizeRecoveryKey(recoveryKey), 'wallet-recovery'),
      welcomeGranted: true,
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      lastTransactionId: '',
      devices: deviceHash ? [deviceHash] : [],
      locked: false,
      lockedUntil: '',
      lockReason: '',
      riskScore: 0,
    };
    state.wallets[clean] = wallet;

    let transaction = null;
    try {
      const bonus = Math.max(0, Math.round(Number(normalizeWalletSettings(state.walletSettings).welcomeBonus || 0)));
      if (bonus > 0) {
        transaction = await walletCommitDeltaUnlocked({
          id: clean,
          delta: bonus,
          type: 'WELCOME_BONUS',
          action: 'wallet_enroll',
          requestId: `welcome-${clean}`,
          source: 'server',
          metadata: { cloudBackupBound: true },
        });
      } else if (!await saveStateDurable()) {
        throw Object.assign(new Error('Cüzdan güvenli şekilde kaydedilemedi.'), { code: 'wallet_persistence_failed' });
      }
    } catch (error) {
      state.wallets = stateBefore.wallets;
      state.walletTransactions = stateBefore.walletTransactions;
      state.walletRequestIndex = stateBefore.walletRequestIndex;
      state.walletLedgerHead = stateBefore.walletLedgerHead;
      state.walletLedgerSequence = stateBefore.walletLedgerSequence;
      state.walletLedgerAnchor = stateBefore.walletLedgerAnchor;
      state.walletLedgerKeyId = stateBefore.walletLedgerKeyId;
      verifyWalletLedger();
      writeLocalStateNow();
      throw error;
    }
    walletSecurityEvent('wallet_enrolled', { id: clean, cloudBackupBound: true }, 'info');
    return { wallet, created: true, transaction };
  });
}

function walletRecover(id, recoveryKey, newWalletKey, deviceId = '') {
  return withWalletMutation(async () => {
    const clean = normalizeId(id);
    const wallet = walletRecord(clean);
    if (!wallet) throw Object.assign(new Error('Bu RelaxFPS ID için cüzdan bulunamadı.'), { code: 'wallet_not_enrolled' });
    if (!validRecoveryKey(recoveryKey) || !validWalletKey(newWalletKey) || !walletRecoveryMatches(wallet, recoveryKey)) {
      throw Object.assign(new Error('Kurtarma anahtarı yanlış.'), { code: 'recovery_key_mismatch' });
    }
    const before = { walletKeyHash: wallet.walletKeyHash, devices: [...(wallet.devices || [])], updatedAt: wallet.updatedAt, lastAccessAt: wallet.lastAccessAt };
    wallet.walletKeyHash = walletCredentialHash(normalizeWalletKey(newWalletKey), 'wallet-key');
    const deviceHash = walletDeviceHash(deviceId);
    if (deviceHash) wallet.devices = Array.from(new Set([...(wallet.devices || []), deviceHash])).slice(-8);
    wallet.updatedAt = new Date().toISOString();
    wallet.lastAccessAt = wallet.updatedAt;
    try {
      if (!await saveStateDurable()) throw new Error('State save failed');
    } catch (error) {
      Object.assign(wallet, before);
      writeLocalStateNow();
      throw Object.assign(new Error('Yeni cihaz anahtarı kalıcı veritabanına kaydedilemedi.'), { code: error.code || 'wallet_persistence_failed' });
    }
    walletSecurityEvent('wallet_recovered', { id: clean, deviceAdded: !!deviceHash }, 'info');
    return wallet;
  });
}


function walletHistory(id, limit = 50, beforeSequence = Number.MAX_SAFE_INTEGER) {
  const clean = normalizeId(id);
  const maxItems = Math.max(1, Math.min(Math.round(Number(limit || 50)), 200));
  const before = Number.isFinite(Number(beforeSequence)) ? Number(beforeSequence) : Number.MAX_SAFE_INTEGER;
  return (state.walletTransactions || [])
    .filter((item) => normalizeId(item.userId) === clean && Number(item.sequence || 0) < before)
    .slice(-maxItems)
    .reverse()
    .map((item) => ({
      id: item.id,
      sequence: item.sequence,
      type: item.type,
      amount: item.amount,
      balanceBefore: item.balanceBefore,
      balanceAfter: item.balanceAfter,
      action: item.action,
      requestId: item.requestId,
      source: item.source,
      metadata: item.metadata || {},
      createdAt: item.createdAt,
    }));
}


function walletServerBonusSeconds(action) {
  const key = walletActionKey(action);
  if (key === 'server_10m') return 10 * 60;
  if (key === 'server_30m') return 30 * 60;
  if (key === 'server_2h') return 2 * 60 * 60;
  if (key === 'server_24h') return 24 * 60 * 60;
  return 0;
}

function walletCommitSpendAction({ id, action, operationId, price, unlimited, metadata, timezoneOffsetMinutes }) {
  return withWalletMutation(async () => {
    const existing = walletFindTransaction(id, operationId);
    if (existing) {
      if (existing.action !== action) {
        throw Object.assign(new Error('Aynı operationId farklı bir işlemde kullanılamaz.'), {
          code: 'request_replay_mismatch',
        });
      }
      return {
        transaction: existing,
        duplicate: true,
        friendUsage: walletServerBonusSeconds(action) > 0 ? friendUsageSnapshot(id, timezoneOffsetMinutes) : null,
      };
    }

    const serverBonusSeconds = walletServerBonusSeconds(action);
    let usageRecord = null;
    let previousTokenBonusSeconds = 0;
    if (serverBonusSeconds > 0) {
      usageRecord = friendUsageRecord(id, timezoneOffsetMinutes);
      previousTokenBonusSeconds = Math.max(0, Number(usageRecord.tokenBonusSeconds || 0));
      usageRecord.tokenBonusSeconds = previousTokenBonusSeconds + serverBonusSeconds;
      usageRecord.updatedAt = new Date().toISOString();
    }

    try {
      const transaction = await walletCommitDeltaUnlocked({
        id,
        delta: unlimited ? 0 : -price,
        type: serverBonusSeconds > 0
          ? 'SERVER_TIME_SPEND'
          : (unlimited ? 'PREMIUM_BYPASS' : 'TOOL_SPEND'),
        action,
        requestId: operationId,
        source: 'app',
        metadata: {
          ...normalizeWalletMetadata(metadata),
          price,
          premium: unlimited,
          serverBonusSeconds,
        },
      });
      return {
        transaction,
        duplicate: false,
        friendUsage: serverBonusSeconds > 0 ? friendUsageSnapshot(id, timezoneOffsetMinutes) : null,
      };
    } catch (error) {
      if (usageRecord) {
        usageRecord.tokenBonusSeconds = previousTokenBonusSeconds;
        usageRecord.updatedAt = new Date().toISOString();
        writeLocalStateNow();
      }
      throw error;
    }
  });
}

function walletAuthenticate(socket, ip, id, walletKey, requestId, responseType) {
  const clean = normalizeId(id);
  if (!validId(clean) || !currentSocketIdentityMatches(socket, clean)) {
    send(socket, { type: responseType, ok: false, requestId, code: 'identity_required', message: 'Önce aynı RelaxFPS ID ile sunucuya bağlan.' });
    return null;
  }
  const throttle = walletAuthThrottle(ip, clean);
  if (!throttle.ok) {
    send(socket, { type: responseType, ok: false, requestId, code: 'auth_rate_limited', retryAfterSeconds: throttle.retryAfterSeconds, message: 'Çok fazla hatalı cüzdan doğrulaması. Daha sonra tekrar dene.' });
    return null;
  }
  const wallet = walletRecord(clean);
  if (!wallet || !walletKeyMatches(wallet, walletKey)) {
    walletAuthFailure(ip, clean, wallet ? 'invalid_wallet_key' : 'wallet_not_enrolled');
    send(socket, { type: responseType, ok: false, requestId, code: wallet ? 'invalid_wallet_key' : 'wallet_not_enrolled', message: wallet ? 'Cüzdan anahtarı yanlış.' : 'RFX Token cüzdanı henüz oluşturulmadı.' });
    return null;
  }
  walletClearAuthFailures(ip, clean);
  wallet.lastAccessAt = new Date().toISOString();
  return wallet;
}

// Socket identity is stored in a WeakMap so wallet helpers can verify that a
// request cannot claim another RelaxFPS ID merely by changing JSON fields.
const walletSocketIdentities = new WeakMap();
function setCurrentSocketIdentity(socket, id) {
  if (socket) walletSocketIdentities.set(socket, normalizeId(id));
}
function currentSocketIdentityMatches(socket, id) {
  return walletSocketIdentities.get(socket) === normalizeId(id);
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
    wallets: Object.values(state.wallets || {}).map((wallet) => ({
      id: wallet.id,
      balance: Math.max(0, Math.round(Number(wallet.balance || 0))),
      welcomeGranted: wallet.welcomeGranted === true,
      locked: !!walletIsLocked(wallet),
      lockReason: wallet.lockReason || '',
      lockedUntil: wallet.lockedUntil || '',
      createdAt: wallet.createdAt || '',
      updatedAt: wallet.updatedAt || '',
      riskScore: Math.max(0, Number(wallet.riskScore || 0)),
    })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    walletTransactions: (state.walletTransactions || []).slice(-160).reverse().map((item) => ({
      id: item.id,
      sequence: item.sequence,
      userId: item.userId,
      type: item.type,
      amount: item.amount,
      balanceBefore: item.balanceBefore,
      balanceAfter: item.balanceAfter,
      action: item.action,
      source: item.source,
      createdAt: item.createdAt,
    })),
    walletSecurityEvents: (state.walletSecurityEvents || []).slice(-160).reverse(),
    walletSettings: walletSettingsSnapshot(),
    walletIntegrity: walletIntegrityStatus,
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
      persistence: { ...supabaseStatus, stateId: SUPABASE_STATE_ID },
      crashReports: (state.crashReports || []).length,
      clientEvents: (state.clientEvents || []).length,
      promoCodes: Object.keys(state.promoCodes || {}).length,
      wheelUsers: Object.keys(state.dailyWheel || {}).length,
      activeDiscounts: Object.keys(state.premiumDiscounts || {}).length,
      wallets: Object.keys(state.wallets || {}).length,
      walletTransactions: (state.walletTransactions || []).length,
      walletIntegrity: walletIntegrityStatus.ok,
      walletSecurityConfigured: WALLET_SECURITY_CONFIGURED,
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

function maskedRelaxId(id) {
  return String(id || '').replace(/^(RFX-\d{2})\d{2}-(\d{2})\d{2}$/, '$1**-$2**');
}

function friendBenchmarkEntries(requester) {
  const clean = normalizeId(requester);
  const ids = Array.from(new Set([clean, ...((state.friendships || {})[clean] || [])])).filter(validId);
  const rows = ids.map((id) => {
    const profile = publicProfile(id);
    const bench = (state.benchmarkScores || {})[id] || null;
    return {
      id,
      displayId: maskedRelaxId(id),
      name: profile.name || 'Relax Friend',
      online: !!profile.online,
      mine: id === clean,
      model: bench ? String(bench.model || 'Unknown device') : 'Benchmark yapılmadı',
      manufacturer: bench ? String(bench.manufacturer || '') : '',
      androidVersion: bench ? String(bench.androidVersion || '') : '',
      totalScore: bench ? Number(bench.totalScore || 0) : 0,
      categoryScores: bench && bench.categoryScores && typeof bench.categoryScores === 'object' ? bench.categoryScores : {},
      updatedAt: bench ? String(bench.updatedAt || '') : '',
      hasScore: !!bench && Number(bench.totalScore || 0) > 0,
    };
  });
  rows.sort((a, b) => {
    if (a.hasScore !== b.hasScore) return a.hasScore ? -1 : 1;
    if (a.hasScore && b.hasScore) return b.totalScore - a.totalScore;
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return a.name.localeCompare(b.name, 'tr');
  });
  let rank = 0;
  return rows.map((item) => {
    if (item.hasScore) rank += 1;
    return { ...item, rank: item.hasScore ? rank : 0 };
  });
}

function safeCommunityNumber(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(number, max));
}

function communityInsights(manufacturer, model) {
  const cleanManufacturer = String(manufacturer || '').trim().toLowerCase();
  const cleanModel = String(model || '').trim().toLowerCase();
  const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const all = Object.values(state.communitySignals || {}).filter((item) => {
    if (!item || Number(item.sessionCount || 0) <= 0) return false;
    const updated = Date.parse(item.updatedAt || '') || 0;
    return updated >= cutoff;
  });
  const sameModel = all.filter((item) => String(item.model || '').trim().toLowerCase() === cleanModel && cleanModel);
  const sameManufacturer = all.filter((item) => String(item.manufacturer || '').trim().toLowerCase() === cleanManufacturer && cleanManufacturer);
  let selected = sameModel;
  let scope = cleanModel ? 'Aynı cihaz modeli' : 'Cihaz topluluğu';
  if (selected.length < 2 && sameManufacturer.length >= 2) {
    selected = sameManufacturer;
    scope = 'Aynı üretici cihazları';
  }
  if (!selected.length) {
    selected = all.slice(-30);
    scope = 'Genel Android topluluğu';
  }
  if (!selected.length) {
    return {
      sampleCount: 0,
      scope,
      averageSessionScore: 0,
      averageTemperature: 0,
      averageBatteryPerHour: 0,
      commonMode: 'Normal',
      recommendations: [],
      message: 'Henüz karşılaştırma için yeterli topluluk verisi yok.',
    };
  }
  let totalWeight = 0;
  let scoreSum = 0;
  let tempSum = 0;
  let tempWeight = 0;
  let batterySum = 0;
  let batteryWeight = 0;
  const modes = {};
  for (const item of selected) {
    const weight = Math.max(1, Math.min(Number(item.sessionCount || 1), 12));
    totalWeight += weight;
    scoreSum += Number(item.averageSessionScore || 0) * weight;
    const temp = Number(item.averageTemperature || 0);
    if (temp > 0) {
      tempSum += temp * weight;
      tempWeight += weight;
    }
    const battery = Number(item.averageBatteryPerHour || 0);
    if (battery > 0) {
      batterySum += battery * weight;
      batteryWeight += weight;
    }
    const mode = String(item.commonMode || 'Normal').slice(0, 32);
    modes[mode] = Number(modes[mode] || 0) + weight;
  }
  const commonMode = Object.entries(modes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Normal';
  const averageSessionScore = totalWeight ? Math.round((scoreSum / totalWeight) * 10) / 10 : 0;
  const averageTemperature = tempWeight ? Math.round((tempSum / tempWeight) * 10) / 10 : 0;
  const averageBatteryPerHour = batteryWeight ? Math.round((batterySum / batteryWeight) * 10) / 10 : 0;
  const recommendations = [];
  if (averageTemperature >= 42) recommendations.push('Bu cihaz grubunda sıcaklık yüksek; Thermal Guard ve Normal/Tasarruf profili önerilir.');
  else if (averageTemperature > 0) recommendations.push('Topluluk sıcaklık ortalaması dengeli görünüyor; uzun oturumlarda yine termal takibi açık tut.');
  if (averageBatteryPerHour >= 28) recommendations.push('Saatlik pil tüketimi yüksek; parlaklığı azaltmak ve Tasarruf modunu denemek faydalı olabilir.');
  if (averageSessionScore < 70) recommendations.push('Topluluk oturum puanı orta seviyede; oyun öncesi hazırlık ve ağ testiyle başla.');
  if (commonMode) recommendations.push(`Bu cihaz grubunda en yaygın profil: ${commonMode}.`);
  if (recommendations.length < 2) recommendations.push('Ayarları tek seferde değiştirmek yerine her oturumdan sonra raporu karşılaştır.');
  return {
    sampleCount: selected.length,
    scope,
    averageSessionScore,
    averageTemperature,
    averageBatteryPerHour,
    commonMode,
    recommendations: recommendations.slice(0, 4),
    message: '',
  };
}

wss.on('connection', (socket, request) => {
  let currentId = null;
  let adminSessionToken = null;
  const socketIp = requestIp(request || { headers: {}, socket: socket?._socket });

  socket.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const type = String(data.type || '');
    const requestId = String(data.requestId || '');

    if (type === 'wallet_catalog') {
      const rate = walletRateLimit(`catalog:${socketIp}`, 30, 60 * 1000, 60 * 1000);
      if (!rate.ok) {
        send(socket, { type: 'wallet_catalog', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok fazla istek gönderildi.' });
        return;
      }
      send(socket, {
        type: 'wallet_catalog',
        ok: true,
        requestId,
        settings: walletSettingsSnapshot(),
        integrity: walletIntegrityStatus.ok,
        securityConfigured: WALLET_SECURITY_CONFIGURED,
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (type === 'wallet_enroll') {
      const id = normalizeId(currentId || data.id);
      if (!validId(id) || currentId !== id) {
        send(socket, { type: 'wallet_enroll', ok: false, requestId, code: 'identity_required', message: 'Önce geçerli RelaxFPS ID ile sunucuya bağlan.' });
        return;
      }
      const rate = walletRateLimit(`enroll:${socketIp}:${id}`, 5, 60 * 60 * 1000, 30 * 60 * 1000);
      if (!rate.ok) {
        send(socket, { type: 'wallet_enroll', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok fazla cüzdan oluşturma denemesi.' });
        return;
      }
      try {
        const result = await walletEnroll(id, data.walletKey, data.recoveryKey, data.deviceId);
        setCurrentSocketIdentity(socket, id);
        sendTo(id, {
          type: 'wallet_changed',
          wallet: walletPublicSnapshot(id),
          reason: result.created ? 'wallet_enrolled' : 'wallet_connected',
          serverTime: new Date().toISOString(),
        });
        send(socket, {
          type: 'wallet_enroll',
          ok: true,
          requestId,
          created: result.created,
          wallet: walletPublicSnapshot(id),
          welcomeTransaction: result.transaction ? {
            id: result.transaction.id,
            amount: result.transaction.amount,
            balanceAfter: result.transaction.balanceAfter,
            createdAt: result.transaction.createdAt,
          } : null,
          serverTime: new Date().toISOString(),
        });
      } catch (error) {
        walletSecurityEvent('wallet_enroll_failed', { id, ip: socketIp, code: error.code || 'error' }, 'warning');
        send(socket, { type: 'wallet_enroll', ok: false, requestId, code: error.code || 'wallet_enroll_failed', message: error.message });
      }
      return;
    }

    if (type === 'wallet_recover') {
      const id = normalizeId(currentId || data.id);
      if (!validId(id) || currentId !== id) {
        send(socket, { type: 'wallet_recover', ok: false, requestId, code: 'identity_required', message: 'Önce aynı RelaxFPS ID ile sunucuya bağlan.' });
        return;
      }
      const rate = walletRateLimit(`recover:${socketIp}:${id}`, 3, 24 * 60 * 60 * 1000, 60 * 60 * 1000);
      if (!rate.ok) {
        send(socket, { type: 'wallet_recover', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Cüzdan kurtarma sınırına ulaşıldı.' });
        return;
      }
      try {
        await walletRecover(id, data.recoveryKey, data.newWalletKey, data.deviceId);
        setCurrentSocketIdentity(socket, id);
        walletClearAuthFailures(socketIp, id);
        sendTo(id, { type: 'wallet_changed', wallet: walletPublicSnapshot(id), reason: 'wallet_recovered', serverTime: new Date().toISOString() });
        send(socket, { type: 'wallet_recover', ok: true, requestId, wallet: walletPublicSnapshot(id), serverTime: new Date().toISOString() });
      } catch (error) {
        walletAuthFailure(socketIp, id, error.code || 'wallet_recover_failed');
        send(socket, { type: 'wallet_recover', ok: false, requestId, code: error.code || 'wallet_recover_failed', message: error.message });
      }
      return;
    }

    if (type === 'wallet_status') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_status');
      if (!wallet) return;
      const rate = walletRateLimit(`status:${socketIp}:${id}`, 60, 60 * 1000, 60 * 1000);
      if (!rate.ok) {
        send(socket, { type: 'wallet_status', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok fazla bakiye sorgusu.' });
        return;
      }
      send(socket, { type: 'wallet_status', ok: true, requestId, wallet: walletPublicSnapshot(id), settings: walletSettingsSnapshot(), serverTime: new Date().toISOString() });
      return;
    }

    if (type === 'wallet_history') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_history');
      if (!wallet) return;
      const rate = walletRateLimit(`history:${socketIp}:${id}`, 30, 60 * 1000, 60 * 1000);
      if (!rate.ok) {
        send(socket, { type: 'wallet_history', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok fazla geçmiş isteği.' });
        return;
      }
      send(socket, {
        type: 'wallet_history',
        ok: true,
        requestId,
        wallet: walletPublicSnapshot(id),
        items: walletHistory(id, data.limit, data.beforeSequence),
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (type === 'wallet_ad_session') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_ad_session');
      if (!wallet) return;
      const rate = walletRateLimit(`ad-session:${socketIp}:${id}`, 8, 10 * 60 * 1000, 10 * 60 * 1000);
      if (!rate.ok) {
        send(socket, {
          type: 'wallet_ad_session',
          ok: false,
          requestId,
          code: 'rate_limited',
          retryAfterSeconds: rate.retryAfterSeconds,
          message: 'Çok hızlı reklam oturumu isteği gönderildi.',
          adState: walletAdStateSnapshot(id, data.timezoneOffsetMinutes),
        });
        return;
      }
      try {
        const result = await walletCreateAdSession(
          id,
          data.timezoneOffsetMinutes,
          data.deviceId,
        );
        send(socket, {
          type: 'wallet_ad_session',
          ok: true,
          requestId,
          session: result.session,
          adState: walletAdStateSnapshot(id, data.timezoneOffsetMinutes),
          wallet: walletPublicSnapshot(id),
          settings: walletSettingsSnapshot(),
          serverTime: new Date().toISOString(),
        });
      } catch (error) {
        send(socket, {
          type: 'wallet_ad_session',
          ok: false,
          requestId,
          code: error.code || 'ad_session_failed',
          message: error.message,
          adState: error.adState || walletAdStateSnapshot(id, data.timezoneOffsetMinutes),
          wallet: walletPublicSnapshot(id),
          settings: walletSettingsSnapshot(),
        });
      }
      return;
    }

    if (type === 'wallet_ad_status') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_ad_status');
      if (!wallet) return;
      const rate = walletRateLimit(`ad-status:${socketIp}:${id}`, 90, 60 * 1000, 60 * 1000);
      if (!rate.ok) {
        send(socket, {
          type: 'wallet_ad_status',
          ok: false,
          requestId,
          code: 'rate_limited',
          retryAfterSeconds: rate.retryAfterSeconds,
          message: 'Çok fazla reklam doğrulama sorgusu.',
        });
        return;
      }
      cleanupWalletAdState({ persist: true });
      const sessionId = String(data.sessionId || '').trim();
      let session = null;
      if (sessionId) {
        session = state.walletAdSessions?.[sessionId] || null;
        if (!session || session.userId !== id) {
          send(socket, {
            type: 'wallet_ad_status',
            ok: false,
            requestId,
            code: 'ad_session_not_found',
            message: 'Reklam doğrulama oturumu bulunamadı.',
            adState: walletAdStateSnapshot(id, data.timezoneOffsetMinutes),
            wallet: walletPublicSnapshot(id),
            settings: walletSettingsSnapshot(),
          });
          return;
        }
      }
      const status = String(session?.status || 'none');
      send(socket, {
        type: 'wallet_ad_status',
        ok: true,
        requestId,
        status,
        sessionStatus: status,
        verified: status === 'verified',
        session: walletAdSessionPublic(session),
        adState: walletAdStateSnapshot(id, data.timezoneOffsetMinutes),
        wallet: walletPublicSnapshot(id),
        settings: walletSettingsSnapshot(),
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (type === 'wallet_play_catalog') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_play_catalog');
      if (!wallet) return;
      const rate = walletRateLimit(`play-catalog:${socketIp}:${id}`, 30, 60 * 1000, 60 * 1000);
      if (!rate.ok) {
        send(socket, { type: 'wallet_play_catalog', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok fazla Google Play katalog isteği.' });
        return;
      }
      send(socket, {
        type: 'wallet_play_catalog',
        ok: true,
        requestId,
        ...googlePlayCatalogSnapshot(id),
        wallet: walletPublicSnapshot(id),
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (type === 'wallet_play_history') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_play_history');
      if (!wallet) return;
      const rate = walletRateLimit(`play-history:${socketIp}:${id}`, 30, 60 * 1000, 60 * 1000);
      if (!rate.ok) {
        send(socket, { type: 'wallet_play_history', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok fazla satın alma geçmişi isteği.' });
        return;
      }
      send(socket, {
        type: 'wallet_play_history',
        ok: true,
        requestId,
        items: googlePlayPurchaseHistory(id, data.limit),
        wallet: walletPublicSnapshot(id),
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (type === 'wallet_play_verify') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_play_verify');
      if (!wallet) return;
      const rate = walletRateLimit(`play-verify:${socketIp}:${id}`, 12, 10 * 60 * 1000, 30 * 60 * 1000);
      if (!rate.ok) {
        walletSecurityEvent('play_verify_rate_limited', { id, ip: socketIp }, 'warning');
        send(socket, { type: 'wallet_play_verify', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok fazla satın alma doğrulama isteği.' });
        return;
      }
      try {
        const result = await googlePlayVerifyAndGrant({
          id,
          productId: data.productId,
          purchaseToken: data.purchaseToken,
          clientOrderId: data.orderId,
        });
        send(socket, {
          type: 'wallet_play_verify',
          ok: true,
          requestId,
          duplicate: result.duplicate === true,
          consumed: result.consumed === true,
          amount: Math.max(0, Math.round(Number(result.record?.amount || 0))),
          purchase: googlePlayPurchasePublic(result.record),
          transaction: result.transaction ? {
            id: result.transaction.id,
            type: result.transaction.type,
            amount: result.transaction.amount,
            balanceAfter: result.transaction.balanceAfter,
            action: result.transaction.action,
            createdAt: result.transaction.createdAt,
          } : null,
          wallet: walletPublicSnapshot(id),
          serverTime: new Date().toISOString(),
        });
      } catch (error) {
        const code = String(error.code || 'play_verify_failed');
        const severity = ['purchase_pending', 'play_not_configured'].includes(code) ? 'info' : 'high';
        walletSecurityEvent('play_purchase_rejected', {
          id,
          productId: String(data.productId || ''),
          code,
          ip: socketIp,
        }, severity);
        send(socket, {
          type: 'wallet_play_verify',
          ok: false,
          requestId,
          code,
          message: error.message,
          wallet: walletPublicSnapshot(id),
        });
      }
      return;
    }

    if (type === 'wallet_spend') {
      const id = normalizeId(currentId || data.id);
      const wallet = walletAuthenticate(socket, socketIp, id, data.walletKey, requestId, 'wallet_spend');
      if (!wallet) return;
      const rate = walletRateLimit(`spend:${socketIp}:${id}`, 12, 60 * 1000, 5 * 60 * 1000);
      if (!rate.ok) {
        walletSecurityEvent('wallet_spend_rate_limited', { id, ip: socketIp }, 'warning');
        send(socket, { type: 'wallet_spend', ok: false, requestId, code: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds, message: 'Çok hızlı token harcama isteği gönderildi.' });
        return;
      }
      const operationId = String(data.operationId || data.requestId || requestId || '').trim();
      const action = walletActionKey(data.action);
      if (!validWalletRequestId(operationId)) {
        send(socket, { type: 'wallet_spend', ok: false, requestId, code: 'invalid_operation_id', message: 'Her işlem için benzersiz ve geçerli operationId gerekli.' });
        return;
      }
      const settings = normalizeWalletSettings(state.walletSettings);
      if (!Object.prototype.hasOwnProperty.call(settings.prices, action)) {
        walletSecurityEvent('wallet_unknown_action', { id, action, ip: socketIp }, 'warning');
        send(socket, { type: 'wallet_spend', ok: false, requestId, code: 'unknown_action', message: 'Bu işlem sunucu fiyat listesinde bulunmuyor.' });
        return;
      }
      const existing = walletFindTransaction(id, operationId);
      if (existing) {
        if (existing.action !== action) {
          walletSecurityEvent('wallet_replay_action_mismatch', { id, operationId, oldAction: existing.action, newAction: action, ip: socketIp }, 'high');
          send(socket, { type: 'wallet_spend', ok: false, requestId, code: 'request_replay_mismatch', message: 'Aynı operationId farklı bir işlemde kullanılamaz.' });
          return;
        }
        send(socket, {
          type: 'wallet_spend',
          ok: true,
          duplicate: true,
          requestId,
          transaction: {
            id: existing.id,
            type: existing.type,
            amount: existing.amount,
            balanceBefore: existing.balanceBefore,
            balanceAfter: existing.balanceAfter,
            action: existing.action,
            createdAt: existing.createdAt,
          },
          wallet: walletPublicSnapshot(id),
          friendUsage: walletServerBonusSeconds(action) > 0
            ? friendUsageSnapshot(id, data.timezoneOffsetMinutes)
            : undefined,
          serverTime: new Date().toISOString(),
        });
        return;
      }
      const price = Math.max(0, Math.round(Number(settings.prices[action] || 0)));
      const serverBonusSeconds = walletServerBonusSeconds(action);
      // Premium bypass applies to tools/optimizations. Server-time packages are
      // always charged until Google Play entitlement verification arrives in Token D.
      const unlimited = !!isPremiumGranted(id) && settings.premiumUnlimited && serverBonusSeconds <= 0;
      try {
        const spendResult = await walletCommitSpendAction({
          id,
          action,
          operationId,
          price,
          unlimited,
          metadata: data.metadata,
          timezoneOffsetMinutes: data.timezoneOffsetMinutes,
        });
        const transaction = spendResult.transaction;
        sendTo(id, {
          type: 'wallet_changed',
          wallet: walletPublicSnapshot(id),
          reason: unlimited ? 'premium_bypass' : 'token_spent',
          transaction: {
            id: transaction.id,
            amount: transaction.amount,
            action: transaction.action,
            balanceAfter: transaction.balanceAfter,
            createdAt: transaction.createdAt,
          },
          serverTime: new Date().toISOString(),
        });
        send(socket, {
          type: 'wallet_spend',
          ok: true,
          duplicate: spendResult.duplicate === true,
          requestId,
          charged: !unlimited && price > 0,
          price,
          transaction: {
            id: transaction.id,
            type: transaction.type,
            amount: transaction.amount,
            balanceBefore: transaction.balanceBefore,
            balanceAfter: transaction.balanceAfter,
            action: transaction.action,
            createdAt: transaction.createdAt,
          },
          wallet: walletPublicSnapshot(id),
          friendUsage: spendResult.friendUsage || undefined,
          serverTime: new Date().toISOString(),
        });
      } catch (error) {
        if (error.code === 'insufficient_balance') walletSecurityEvent('wallet_insufficient_balance', { id, action, price, balance: error.balance }, 'info');
        send(socket, {
          type: 'wallet_spend',
          ok: false,
          requestId,
          code: error.code || 'wallet_spend_failed',
          message: error.message,
          balance: error.balance,
          required: error.required || price,
          wallet: walletPublicSnapshot(id),
        });
      }
      return;
    }

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

    if (type === 'cloud_backup_put') {
      const id = normalizeId(data.id || currentId);
      const recoveryKey = normalizeRecoveryKey(data.recoveryKey);
      const backup = data.backup;
      if (!validId(id) || !validRecoveryKey(recoveryKey)) {
        send(socket, { type: 'cloud_backup_put', ok: false, requestId, message: 'Geçerli RelaxFPS ID ve kurtarma anahtarı gerekli.' });
        return;
      }
      if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
        send(socket, { type: 'cloud_backup_put', ok: false, requestId, message: 'Geçerli yedek verisi gerekli.' });
        return;
      }
      let serialized;
      try {
        serialized = JSON.stringify(backup);
      } catch (_) {
        send(socket, { type: 'cloud_backup_put', ok: false, requestId, message: 'Yedek verisi işlenemedi.' });
        return;
      }
      const sizeBytes = Buffer.byteLength(serialized, 'utf8');
      if (sizeBytes < 2 || sizeBytes > 800 * 1024) {
        send(socket, { type: 'cloud_backup_put', ok: false, requestId, message: 'Yedek boyutu 800 KB sınırını aşıyor.' });
        return;
      }
      state.cloudBackups = state.cloudBackups || {};
      const existing = state.cloudBackups[id] || null;
      if (existing && !cloudBackupKeyMatches(existing, recoveryKey)) {
        send(socket, { type: 'cloud_backup_put', ok: false, requestId, message: 'Kurtarma anahtarı yanlış.' });
        return;
      }
      const now = new Date().toISOString();
      state.cloudBackups[id] = {
        keyHash: recoveryKeyHash(recoveryKey),
        backup,
        createdAt: existing && existing.createdAt ? existing.createdAt : now,
        updatedAt: now,
        sizeBytes,
        version: Math.max(1, Math.min(Number(backup.version || 1), 50)),
      };
      saveStateSoon();
      send(socket, { type: 'cloud_backup_put', ok: true, requestId, updatedAt: now, sizeBytes, version: state.cloudBackups[id].version, serverTime: now });
      return;
    }

    if (type === 'cloud_backup_get' || type === 'cloud_backup_status') {
      const id = normalizeId(data.id || currentId);
      const recoveryKey = normalizeRecoveryKey(data.recoveryKey);
      const record = (state.cloudBackups || {})[id] || null;
      if (!validId(id) || !validRecoveryKey(recoveryKey)) {
        send(socket, { type, ok: false, requestId, message: 'Geçerli RelaxFPS ID ve kurtarma anahtarı gerekli.' });
        return;
      }
      if (!record) {
        send(socket, { type, ok: false, requestId, message: 'Bu RelaxFPS ID için bulut yedeği bulunamadı.' });
        return;
      }
      if (!cloudBackupKeyMatches(record, recoveryKey)) {
        send(socket, { type, ok: false, requestId, message: 'Kurtarma anahtarı yanlış.' });
        return;
      }
      const response = {
        type,
        ok: true,
        requestId,
        createdAt: record.createdAt || '',
        updatedAt: record.updatedAt || '',
        sizeBytes: Number(record.sizeBytes || 0),
        version: Number(record.version || 1),
        serverTime: new Date().toISOString(),
      };
      if (type === 'cloud_backup_get') response.backup = record.backup || {};
      send(socket, response);
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

    if (type === 'friend_benchmarks') {
      const requester = normalizeId(currentId || data.id);
      if (!validId(requester) || currentId !== requester) {
        send(socket, { type: 'friend_benchmarks', ok: false, requestId, message: 'Önce geçerli RelaxFPS kimliğiyle bağlan.' });
        return;
      }
      const entries = friendBenchmarkEntries(requester);
      send(socket, {
        type: 'friend_benchmarks',
        ok: true,
        requestId,
        entries,
        groupSize: entries.length,
        scoredCount: entries.filter((item) => item.hasScore).length,
        serverTime: new Date().toISOString(),
      });
      return;
    }

    if (type === 'device_community_submit') {
      const id = normalizeId(currentId || data.id);
      if (!validId(id) || currentId !== id) {
        send(socket, { type: 'device_community_submit', ok: false, requestId, message: 'Önce geçerli RelaxFPS kimliğiyle bağlan.' });
        return;
      }
      const item = {
        id,
        manufacturer: String(data.manufacturer || '').slice(0, 80),
        model: String(data.model || 'Unknown device').slice(0, 120),
        androidVersion: String(data.androidVersion || '').slice(0, 40),
        sessionCount: Math.round(safeCommunityNumber(data.sessionCount, 1, 100)),
        averageSessionScore: safeCommunityNumber(data.averageSessionScore, 0, 100),
        averageTemperature: safeCommunityNumber(data.averageTemperature, 0, 90),
        averageBatteryPerHour: safeCommunityNumber(data.averageBatteryPerHour, 0, 100),
        commonMode: String(data.commonMode || 'Normal').slice(0, 32),
        updatedAt: new Date().toISOString(),
      };
      state.communitySignals = state.communitySignals || {};
      state.communitySignals[id] = item;
      saveStateSoon();
      send(socket, { type: 'device_community_submit', ok: true, requestId, updatedAt: item.updatedAt, serverTime: item.updatedAt });
      return;
    }

    if (type === 'device_community_insights') {
      const id = normalizeId(currentId || data.id);
      if (!validId(id) || currentId !== id) {
        send(socket, { type: 'device_community_insights', ok: false, requestId, message: 'Önce geçerli RelaxFPS kimliğiyle bağlan.' });
        return;
      }
      const profile = state.profiles[id] || {};
      const ownSignal = (state.communitySignals || {})[id] || {};
      const manufacturer = String(data.manufacturer || ownSignal.manufacturer || profile.manufacturer || '');
      const model = String(data.model || ownSignal.model || profile.deviceModel || '');
      send(socket, {
        type: 'device_community_insights',
        ok: true,
        requestId,
        ...communityInsights(manufacturer, model),
        serverTime: new Date().toISOString(),
      });
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

    if (type === 'admin_wallet_adjust') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = normalizeId(data.id);
      const amount = Math.round(Number(data.amount || 0));
      const reason = String(data.reason || 'Yönetici düzeltmesi').slice(0, 240);
      if (!validId(id) || !walletRecord(id)) {
        send(socket, { type: 'admin_error', ok: false, requestId, message: 'Kayıtlı RFX Token cüzdanı olan geçerli bir RelaxFPS ID gerekli.' });
        return;
      }
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10000000) {
        send(socket, { type: 'admin_error', ok: false, requestId, message: 'Miktar sıfırdan farklı ve en fazla 10.000.000 olmalı.' });
        return;
      }
      try {
        const transaction = await walletCommitDelta({
          id,
          delta: amount,
          type: amount > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
          action: 'admin_adjustment',
          requestId: `admin-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
          source: 'admin',
          metadata: { reason },
        });
        adminAudit('wallet_adjust', { id, amount, reason, transactionId: transaction.id });
        sendTo(id, { type: 'wallet_changed', wallet: walletPublicSnapshot(id), reason: 'admin_adjustment', serverTime: new Date().toISOString() });
        send(socket, { type: 'admin_wallet_adjust', ok: true, requestId, wallet: walletPublicSnapshot(id), transaction });
      } catch (error) {
        send(socket, { type: 'admin_error', ok: false, requestId, code: error.code || 'wallet_adjust_failed', message: error.message });
      }
      return;
    }

    if (type === 'admin_wallet_lock') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const id = normalizeId(data.id);
      const wallet = walletRecord(id);
      if (!validId(id) || !wallet) {
        send(socket, { type: 'admin_error', ok: false, requestId, message: 'Kayıtlı cüzdan bulunamadı.' });
        return;
      }
      const locked = data.locked === true;
      const minutes = Math.max(0, Math.min(Math.round(Number(data.minutes || 0)), 525600));
      wallet.locked = locked;
      wallet.lockReason = locked ? String(data.reason || 'Güvenlik kontrolü').slice(0, 240) : '';
      wallet.lockedUntil = locked && minutes > 0 ? new Date(Date.now() + minutes * 60 * 1000).toISOString() : '';
      wallet.updatedAt = new Date().toISOString();
      try {
        if (!await saveStateDurable()) throw new Error('State save failed');
      } catch (error) {
        send(socket, { type: 'admin_error', ok: false, requestId, code: error.code || 'wallet_persistence_failed', message: 'Cüzdan kilidi kalıcı veritabanına kaydedilemedi.' });
        return;
      }
      walletSecurityEvent(locked ? 'wallet_admin_locked' : 'wallet_admin_unlocked', { id, minutes, reason: wallet.lockReason }, locked ? 'high' : 'info');
      adminAudit('wallet_lock', { id, locked, minutes, reason: wallet.lockReason });
      sendTo(id, { type: 'wallet_changed', wallet: walletPublicSnapshot(id), reason: locked ? 'wallet_locked' : 'wallet_unlocked', serverTime: new Date().toISOString() });
      send(socket, { type: 'admin_wallet_lock', ok: true, requestId, wallet: walletPublicSnapshot(id) });
      return;
    }

    if (type === 'admin_update_wallet_settings') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const incoming = data.settings && typeof data.settings === 'object' ? data.settings : {};
      const current = normalizeWalletSettings(state.walletSettings);
      state.walletSettings = normalizeWalletSettings({
        ...current,
        ...incoming,
        prices: { ...current.prices, ...(incoming.prices && typeof incoming.prices === 'object' ? incoming.prices : {}) },
        updatedAt: new Date().toISOString(),
      });
      try {
        if (!await saveStateDurable()) throw new Error('State save failed');
      } catch (error) {
        send(socket, { type: 'admin_error', ok: false, requestId, code: error.code || 'wallet_persistence_failed', message: 'Cüzdan ayarları kalıcı veritabanına kaydedilemedi.' });
        return;
      }
      adminAudit('wallet_settings_updated', { settings: walletSettingsSnapshot() });
      send(socket, { type: 'admin_update_wallet_settings', ok: true, requestId, settings: walletSettingsSnapshot() });
      return;
    }

    if (type === 'admin_wallet_verify_ledger') {
      if (!requireAdmin(socket, adminSessionToken, requestId)) return;
      const result = verifyWalletLedger();
      if (result.ok) await saveStateDurable();
      adminAudit('wallet_ledger_verified', result);
      send(socket, { type: 'admin_wallet_verify_ledger', ok: result.ok, requestId, integrity: result });
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
      setCurrentSocketIdentity(socket, id);
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
        walletAvailable: normalizeWalletSettings(state.walletSettings).enabled,
        walletEnrolled: !!walletRecord(id),
        walletSecurityConfigured: WALLET_SECURITY_CONFIGURED,
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
    walletSocketIdentities.delete(socket);
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

async function shutdown() {
  for (const id of Array.from(activeFriendUsage.keys())) stopFriendUsage(id);
  writeLocalStateNow();
  try {
    if (SUPABASE_CONFIGURED) await flushSupabaseState({ required: true });
  } catch (error) {
    console.warn('[SUPABASE] Final shutdown save failed:', error.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });

async function bootstrapServer() {
  const localLoaded = loadState();
  const cloudLoaded = await loadStateFromSupabase();
  verifyWalletLedger();

  if (!WALLET_SECURITY_CONFIGURED) {
    console.warn('[WALLET] RELAXFPS_WALLET_LEDGER_SECRET is not configured. Set a stable 32+ character secret before production use.');
  }
  if (SUPABASE_SYNC_ENABLED && !SUPABASE_CONFIGURED) {
    console.warn('[SUPABASE] Persistent storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY). Wallet mutations will remain disabled.');
  } else if (SUPABASE_CONFIGURED && !cloudLoaded) {
    const seeded = await flushSupabaseState({ required: true });
    if (seeded) console.log(`[SUPABASE] Created initial persistent state from ${localLoaded ? 'local data' : 'empty server state'}.`);
  }

  httpServer.listen(PORT, () => {
    console.log(`RelaxFPS Friends Server v6.4-rfx-token-d running on ws://0.0.0.0:${PORT}`);
    console.log(`RELAXFPS Admin Studio: http://0.0.0.0:${PORT}/admin`);
    console.log(`[PERSISTENCE] ${SUPABASE_CONFIGURED ? `Supabase active, state=${SUPABASE_STATE_ID}, revision=${supabaseStateRevision}` : 'local ephemeral mode'}`);
    if (ADMIN_PASSWORD.length < 12) console.warn('[SECURITY] RELAXFPS_ADMIN_PASSWORD is missing or shorter than 12 characters. Admin login is disabled.');
    if (ADMIN_TOTP_SECRET) console.log('[SECURITY] Admin TOTP is enabled.');
    if (googlePlayConfigured()) {
      console.log(`[GOOGLE PLAY] Token D verification active for ${GOOGLE_PLAY_PACKAGE_NAME}.`);
      const initialPlaySync = setTimeout(() => {
        googlePlaySyncVoidedPurchases().catch((error) => console.warn('[GOOGLE PLAY] Initial voided sync failed:', error.message));
      }, 15000);
      initialPlaySync.unref?.();
      const playSyncTimer = setInterval(() => {
        googlePlaySyncVoidedPurchases().catch((error) => console.warn('[GOOGLE PLAY] Scheduled voided sync failed:', error.message));
      }, GOOGLE_PLAY_VOIDED_SYNC_INTERVAL_MS);
      playSyncTimer.unref?.();
    } else {
      console.warn('[GOOGLE PLAY] Token D is installed but service-account credentials are not configured.');
    }
  });
}

bootstrapServer().catch((error) => {
  console.error('[BOOT] Server could not start safely:', error);
  process.exit(1);
});

