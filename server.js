const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map(); // RelaxFPS ID -> socket
const offlineQueue = new Map(); // RelaxFPS ID -> queued message payloads

function send(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function onlineIds() {
  return Array.from(clients.keys());
}

function broadcastPresence(id, online) {
  for (const [clientId, socket] of clients.entries()) {
    if (clientId !== id) {
      send(socket, { type: 'presence', id, online });
    }
  }
}

function flushQueue(id) {
  const socket = clients.get(id);
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const queue = offlineQueue.get(id) || [];
  if (!queue.length) return;

  for (const payload of queue) {
    send(socket, payload);
    const sender = clients.get(payload.from);
    send(sender, {
      type: 'delivered',
      to: id,
      messageId: payload.messageId,
      time: new Date().toISOString(),
      queued: true
    });
  }

  offlineQueue.delete(id);
  console.log(`[QUEUE FLUSHED] ${id}: ${queue.length} message(s)`);
}

wss.on('connection', (socket) => {
  let currentId = null;

  socket.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (error) {
      send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (data.type === 'register') {
      const id = String(data.id || '').trim().toUpperCase();
      if (!id.startsWith('RFX-')) {
        send(socket, { type: 'error', message: 'Invalid RelaxFPS ID' });
        return;
      }

      if (currentId && clients.get(currentId) === socket) {
        clients.delete(currentId);
        broadcastPresence(currentId, false);
      }

      currentId = id;
      clients.set(id, socket);
      send(socket, { type: 'registered', id, online: true, onlineIds: onlineIds() });
      broadcastPresence(id, true);
      flushQueue(id);

      console.log(`[REGISTER] ${id}`);
      return;
    }

    if (data.type === 'status') {
      const ids = Array.isArray(data.ids) ? data.ids.map(x => String(x).trim().toUpperCase()) : [];
      const filtered = ids.filter(id => clients.has(id));
      send(socket, { type: 'status', onlineIds: filtered, allOnlineIds: onlineIds() });
      return;
    }

    if (data.type === 'message') {
      const from = String(data.from || currentId || '').trim().toUpperCase();
      const to = String(data.to || '').trim().toUpperCase();
      const text = String(data.text || '').trim();
      const messageId = String(data.messageId || `srv-${Date.now()}-${Math.floor(Math.random() * 99999)}`);

      if (!from.startsWith('RFX-') || !to.startsWith('RFX-') || !text) {
        send(socket, { type: 'error', message: 'Invalid message payload', messageId });
        return;
      }

      const payload = {
        type: 'message',
        from,
        to,
        text,
        messageId,
        time: data.time || new Date().toISOString(),
      };

      const target = clients.get(to);
      if (target && target.readyState === WebSocket.OPEN) {
        send(target, payload);
        send(socket, { type: 'delivered', to, messageId, time: new Date().toISOString() });
        console.log(`[MESSAGE] ${from} -> ${to}: ${text}`);
      } else {
        const queue = offlineQueue.get(to) || [];
        queue.push(payload);
        offlineQueue.set(to, queue);
        send(socket, { type: 'queued', to, messageId, time: new Date().toISOString() });
        console.log(`[QUEUED] ${from} -> ${to}: ${text}`);
      }
      return;
    }

    if (data.type === 'ping') {
      send(socket, { type: 'pong', time: new Date().toISOString(), onlineIds: onlineIds() });
      return;
    }

    send(socket, { type: 'error', message: 'Unknown message type' });
  });

  socket.on('close', () => {
    if (currentId && clients.get(currentId) === socket) {
      clients.delete(currentId);
      broadcastPresence(currentId, false);
      console.log(`[DISCONNECT] ${currentId}`);
    }
  });
});

console.log(`RelaxFPS Friends Server v2 running on ws://0.0.0.0:${PORT}`);
