const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 5000,
  // Up to ~30 s: 5 s heartbeat + 19 s timeout + 2 s reconnect + 4 s peer probe.
  pingTimeout: 19000,
});
const rooms = new Map();
const sessions = new Map();
const RECONNECT_GRACE_MS = 2000;
const FILE_PICKER_GRACE_MS = 5 * 60 * 1000;

app.get('/', (_req, res) => res.send('Net Share signaling server is running'));

function clientAddress(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return String(forwarded ? forwarded.split(',')[0] : socket.handshake.address).trim().replace(/^::ffff:/, '');
}

function removeFromRoom(socket, explicit = false) {
  const roomName = socket.currentRoom;
  if (!roomName || !rooms.has(roomName)) return;
  rooms.get(roomName).delete(socket.peerId);
  socket.leave(roomName);
  if (!rooms.get(roomName).size) rooms.delete(roomName);
  else io.to(roomName).emit('peer-left', { socketId: socket.peerId, explicit });
  socket.currentRoom = null;
}

io.on('connection', (socket) => {
  const roomName = clientAddress(socket); // Same public egress IP: same LAN discovery group.
  // A tab-scoped secret survives refresh as well as picker suspension.
  // Only the public peer id is exposed to other devices.
  const token = socket.handshake.auth?.sessionToken;
  const key = `${roomName}:${typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : socket.id}`;
  const previous = sessions.get(key);
  if (previous) clearTimeout(previous.timer);
  socket.peerId = previous?.socket.peerId || socket.id;
  sessions.set(key, { socket });
  if (previous?.socket.connected) previous.socket.disconnect(true);

  function listedPeers() {
    const room = rooms.get(roomName);
    if (!room) return [];
    return [...room.entries()]
      .filter(([id]) => id !== socket.peerId)
      .map(([socketId, peer]) => ({ socketId, ...peer }));
  }

  // The client decides its own 用户-xxx number after inspecting these peers.
  // The server never allocates or rewrites device numbers.
  socket.on('discover', () => {
    socket.emit('discovered-peers', { peers: listedPeers() });
  });

  socket.on('join', ({ deviceName } = {}) => {
    if (socket.currentRoom && socket.currentRoom !== roomName) removeFromRoom(socket);
    socket.currentRoom = roomName;
    socket.join(roomName);
    if (!rooms.has(roomName)) rooms.set(roomName, new Map());
    const room = rooms.get(roomName);
    const isNew = !room.has(socket.peerId);
    room.set(socket.peerId, { deviceName: String(deviceName || '未命名设备').slice(0, 30) });
    socket.emit('room-peers', { peers: listedPeers() });
    socket.to(roomName).emit(isNew ? 'peer-joined' : 'peer-returned', { socketId: socket.peerId, ...room.get(socket.peerId) });
  });

  function relay(event, data = {}) {
    if (!socket.currentRoom || !data.to || !rooms.get(socket.currentRoom)?.has(data.to)) return;
    const target = [...sessions.values()].find((entry) => entry.socket.peerId === data.to && entry.socket.currentRoom === socket.currentRoom);
    target?.socket.emit(event, { from: socket.peerId, ...(data.signalData ? { signalData: data.signalData } : {}) });
  }

  socket.on('signal', (data) => relay('signal', data));
  socket.on('chat-request', (data) => relay('chat-request', data));
  socket.on('chat-leave', (data) => relay('chat-leave', data));
  socket.on('file-picker', ({ active } = {}) => { socket.pickingFile = active === true; });
  socket.on('page-leave', () => {
    const session = sessions.get(key);
    if (session?.socket !== socket) return;
    clearTimeout(session.timer);
    removeFromRoom(socket, true);
    sessions.delete(key);
    socket.disconnect(true);
  });
  socket.on('disconnect', () => {
    const session = sessions.get(key);
    if (session?.socket !== socket) return;
    session.timer = setTimeout(() => { removeFromRoom(socket); sessions.delete(key); }, socket.pickingFile ? FILE_PICKER_GRACE_MS : RECONNECT_GRACE_MS);
  });
});

// Nginx is the only public entry point; keep the signaling service private.
server.listen(process.env.PORT || 3000, '127.0.0.1', () => console.log('Net Share signaling server listening'));
