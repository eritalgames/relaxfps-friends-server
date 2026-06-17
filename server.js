const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'relaxfps-friends-data.json');
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map(); // RelaxFPS ID -> socket
const offlineQueue = new Map(); // RelaxFPS ID -> queued payloads

const state = {
  profiles: {}, // id -> {id,name,lastSeen}
  friendships: {}, // id -> [friendId]
  friendRequests: [], // {from,to,name,time,status}
  messages: {}, // conversationKey -> message payloads
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      Object.assign(state, parsed);
    }
  } catch (error) {
    console.warn('[STATE] Could not load data file:', error.message);
  }
}

let saveTimer = null;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
      console.warn('[STATE] Could not save data file:', error.message);
    }
  }, 300);
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
  send(clients.get(normalizeId(id)), payload);
}

function onlineIds() {
  return Array.from(clients.keys());
}

function broadcastPresence(id, online) {
  const targets = state.friendships[id] || [];
  for (const targetId of targets) {
    sendTo(targetId, { type: 'presence', id, online });
  }
}

function publicProfile(id) {
  const profile = state.profiles[id] || { id, name: 'Relax Friend' };
  return { id, name: profile.name || 'Relax Friend', online: clients.has(id), lastSeen: profile.lastSeen || null };
}

function sendFriendsList(socket, id) {
  const friends = (state.friendships[id] || []).map(publicProfile);
  send(socket, { type: 'friends_list', id, friends, onlineIds: onlineIds() });
}

function flushQueue(id) {
  const socket = clients.get(id);
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const queue = offlineQueue.get(id) || [];
  if (!queue.length) return;
  for (const payload of queue) {
    send(socket, payload);
    sendTo(payload.from, { type: 'delivered', to: id, messageId: payload.messageId, time: new Date().toISOString(), queued: true });
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

loadState();

wss.on('connection', (socket) => {
  let currentId = null;

  socket.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (_) {
      send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const type = String(data.type || '');

    if (type === 'register') {
      const id = normalizeId(data.id);
      if (!validId(id)) return send(socket, { type: 'error', message: 'Invalid RelaxFPS ID' });
      if (currentId && clients.get(currentId) === socket) {
        clients.delete(currentId);
        broadcastPresence(currentId, false);
      }
      currentId = id;
      clients.set(id, socket);
      ensureProfile(id, data.name || 'RelaxFPS User');
      send(socket, { type: 'registered', id, online: true, onlineIds: onlineIds(), profile: publicProfile(id) });
      sendFriendsList(socket, id);
      broadcastPresence(id, true);
      flushQueue(id);
      console.log(`[REGISTER] ${id}`);
      return;
    }

    if (type === 'status') {
      const ids = Array.isArray(data.ids) ? data.ids.map(normalizeId) : [];
      send(socket, { type: 'status', onlineIds: ids.filter((id) => clients.has(id)), allOnlineIds: onlineIds() });
      return;
    }

    if (type === 'friends_list') {
      const id = normalizeId(data.id || currentId);
      if (validId(id)) sendFriendsList(socket, id);
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
      send(socket, { type: 'friend_accepted', from: to, id: to, name: publicProfile(to).name });
      sendTo(to, { type: 'friend_accepted', from, id: from, name: publicProfile(from).name });
      sendFriendsList(socket, from);
      const target = clients.get(to);
      if (target) sendFriendsList(target, to);
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
      const text = String(data.text || '').trim().slice(0, 2000);
      const messageId = String(data.messageId || `srv-${Date.now()}-${Math.floor(Math.random() * 99999)}`);
      if (!validId(from) || !validId(to) || !text) return send(socket, { type: 'error', message: 'Invalid message payload', messageId });
      const payload = { type: 'message', from, to, text, messageId, time: data.time || new Date().toISOString() };
      storeMessage(payload);
      const target = clients.get(to);
      if (target && target.readyState === WebSocket.OPEN) {
        send(target, payload);
        send(socket, { type: 'delivered', to, messageId, time: new Date().toISOString() });
      } else {
        const queue = offlineQueue.get(to) || [];
        queue.push(payload);
        offlineQueue.set(to, queue);
        send(socket, { type: 'queued', to, messageId, time: new Date().toISOString() });
      }
      console.log(`[MESSAGE] ${from} -> ${to}: ${text}`);
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

    if (type === 'ping') {
      send(socket, { type: 'pong', time: new Date().toISOString(), onlineIds: onlineIds() });
      return;
    }

    send(socket, { type: 'error', message: 'Unknown message type' });
  });

  socket.on('close', () => {
    if (currentId && clients.get(currentId) === socket) {
      clients.delete(currentId);
      if (state.profiles[currentId]) {
        state.profiles[currentId].lastSeen = new Date().toISOString();
        saveStateSoon();
      }
      broadcastPresence(currentId, false);
      console.log(`[DISCONNECT] ${currentId}`);
    }
  });
});

console.log(`RelaxFPS Friends Server v3 running on ws://0.0.0.0:${PORT}`);
