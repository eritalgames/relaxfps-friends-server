const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'relaxfps-friends-data.json');

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      service: 'RelaxFPS Friends Server',
      version: '4.1.0-admin',
      online: onlineIds().length,
      time: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('RELAXFPS Friends Server is running. Use WebSocket: wss://relaxfps-friends-server.onrender.com');
});

const wss = new WebSocket.Server({ server: httpServer });

const clients = new Map(); // RelaxFPS ID -> Set<WebSocket>
const offlineQueue = new Map(); // RelaxFPS ID -> queued payloads
const relayRooms = new Map(); // room -> {members:Set<string>, lastActive:number, chunks:number}
const ADMIN_PASSWORD = process.env.RELAXFPS_ADMIN_PASSWORD || '6a32beb1-0e30-83eb-bf71-be356cbd095a';

function defaultAppSettings() {
  return {
    maintenanceMode: false,
    maintenanceMessage: '',
    maintenanceUntil: '',
    friendsEnabled: true,
    communityEnabled: false,
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
    freeFriendMinutes: 10,
    premiumFriendMinutes: 60,
    appLockFailLimit: 3,
    appLockLockMinutes: 10,
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
      state.crashReports = Array.isArray(state.crashReports) ? state.crashReports : [];
      state.clientEvents = Array.isArray(state.clientEvents) ? state.clientEvents : [];
      state.testUsers = state.testUsers || {};
      state.userNotes = state.userNotes || {};
      state.backups = Array.isArray(state.backups) ? state.backups : [];
      state.adminAuditLog = Array.isArray(state.adminAuditLog) ? state.adminAuditLog : [];
      state.adminSecurity = state.adminSecurity || { wrongPasswordCount: 0, lastWrongPasswordAt: null, sessionMinutes: 60 };
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
  return (state.announcements || [])
    .filter((item) => item && item.active !== false)
    .slice()
    .sort((a, b) => (Number(a.order || 0) - Number(b.order || 0)) || String(b.time || '').localeCompare(String(a.time || '')))
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
    analytics: buildAnalytics(),
    systemHealth: {
      profiles: Object.keys(state.profiles || {}).length,
      friendships: Object.keys(state.friendships || {}).length,
      relayRooms: relayRooms.size,
      online: onlineIds().length,
      messages: Object.values(state.messages || {}).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0),
      dataFile: DATA_FILE,
      crashReports: (state.crashReports || []).length,
      clientEvents: (state.clientEvents || []).length,
      dataFileBytes: safeFileSize(DATA_FILE),
    },
    onlineIds: onlineIds(),
    time: new Date().toISOString(),
  };
}

function requireAdmin(socket, isAdmin, requestId) {
  if (!isAdmin) {
    send(socket, { type: 'admin_error', ok: false, requestId, message: 'Admin authorization required' });
    return false;
  }
  return true;
}

function pushDeveloperMessages(id, socket) {
  const clean = normalizeId(id);
  const items = (state.developerMessages || []).filter((item) => item.to === clean && item.read !== true).slice(-10);
  if (items.length) send(socket, { type: 'developer_messages', items });
}

loadState();

wss.on('connection', (socket) => {
  let currentId = null;
  let isAdmin = false;

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

    if (type === 'admin_login') {
      state.adminSecurity = state.adminSecurity || { wrongPasswordCount: 0, lastWrongPasswordAt: null, sessionMinutes: 60 };
      if (String(data.password || '') === ADMIN_PASSWORD) {
        isAdmin = true;
        state.adminSecurity.wrongPasswordCount = 0;
        adminAudit('admin_login', { ok: true });
        send(socket, { type: 'admin_login', ok: true, requestId, time: new Date().toISOString(), sessionMinutes: state.adminSecurity.sessionMinutes || 60 });
      } else {
        state.adminSecurity.wrongPasswordCount = Number(state.adminSecurity.wrongPasswordCount || 0) + 1;
        state.adminSecurity.lastWrongPasswordAt = new Date().toISOString();
        adminAudit('admin_login_failed', { count: state.adminSecurity.wrongPasswordCount });
        send(socket, { type: 'admin_login', ok: false, requestId, message: 'Invalid admin password' });
      }
      return;
    }

    if (type === 'admin_snapshot') {
      if (!requireAdmin(socket, isAdmin, requestId)) return;
      send(socket, { ...adminSnapshot(), requestId });
      return;
    }

    if (type === 'admin_create_announcement' || type === 'admin_upsert_announcement') {
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
      const id = String(data.id || '').trim();
      state.announcements = (state.announcements || []).filter((item) => item.id !== id);
      adminAudit('delete_announcement', { id });
      saveStateSoon();
      send(socket, { type: 'admin_delete_announcement', ok: true, requestId, id });
      return;
    }

    if (type === 'admin_upsert_custom_panel') {
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
      const id = String(data.id || '').trim();
      state.customPanels = (state.customPanels || []).filter((item) => item.id !== id);
      adminAudit('delete_custom_panel', { id });
      saveStateSoon();
      send(socket, { type: 'admin_delete_custom_panel', ok: true, requestId, id });
      return;
    }

    if (type === 'admin_update_feedback') {
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      if (!requireAdmin(socket, isAdmin, requestId)) return;
      state.adminAuditLog = [];
      adminAudit('clear_admin_log', {});
      saveStateSoon();
      send(socket, { type: 'admin_clear_admin_log', ok: true, requestId });
      return;
    }

    if (type === 'admin_clear_crash_reports') {
      if (!requireAdmin(socket, isAdmin, requestId)) return;
      state.crashReports = [];
      adminAudit('clear_crash_reports', {});
      saveStateSoon();
      send(socket, { type: 'admin_clear_crash_reports', ok: true, requestId });
      return;
    }

    if (type === 'admin_update_security') {
      if (!requireAdmin(socket, isAdmin, requestId)) return;
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
      ensureProfile(id, data.name || 'RelaxFPS User');

      send(socket, {
        type: 'registered',
        id,
        online: true,
        onlineIds: onlineIds(),
        profile: publicProfile(id),
        premiumGrant: isPremiumGranted(id),
      });
      sendFriendsList(socket, id);

      if (wasOffline) broadcastPresence(id, true);
      flushQueue(id);
      pushDeveloperMessages(id, socket);
      console.log(`[REGISTER] ${id} (${socketsFor(id).size} socket(s))`);
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
      ensureProfile(from, data.name || 'RelaxFPS User');
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
      };
      storeMessage(payload);

      if (isOnline(to)) {
        sendTo(to, payload);
        send(socket, { type: 'delivered', to, messageId, time: new Date().toISOString() });
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
      sendTo(to, { type: 'read', from, to, messageId, time: new Date().toISOString() });
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
      sendTo(to, { ...data, from, to, time: data.time || new Date().toISOString() });
      if (type === 'call_invite') send(socket, { type: 'call_ringing', to, mode: data.mode || 'voice' });
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
      broadcastPresence(id, false);
    }
  }
}, 30000);

function shutdown() {
  saveStateNow();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT, () => {
  console.log(`RelaxFPS Friends Server v4.1-admin running on ws://0.0.0.0:${PORT}`);
});
