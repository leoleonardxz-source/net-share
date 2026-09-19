const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('picker suspension retains identity and routes signals to the reconnected socket', () => {
  let connect, options; const broadcasts = [], timers = new Set(), delays = [];
  const io = { on(_event, fn) { connect = fn; }, to(room) { return { emit: (event, data) => broadcasts.push({ room, event, data }) }; } };
  const context = vm.createContext({
    require(name) {
      if (name === 'express') return () => ({ get() {} });
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      if (name === 'socket.io') return { Server: function (_server, config) { options = config; return io; } };
      throw Error(name);
    },
    setTimeout(fn, ms) { timers.add(fn); delays.push(ms); return fn; }, clearTimeout(fn) { timers.delete(fn); }, process: { env: {} }, console,
  });
  vm.runInContext(fs.readFileSync('backend/server.js', 'utf8'), context);
  function socket(id, token, join = true) {
    const handlers = {}, events = [];
    const s = { id, connected: true, handshake: { address: '10.0.0.1', headers: {}, auth: { sessionToken: token } },
      on(name, fn) { handlers[name] = fn; }, emit(event, data) { events.push({ event, data }); }, join() {}, leave() {}, to: io.to,
      disconnect() { s.connected = false; handlers.disconnect(); }, handlers, events,
    };
    connect(s); if (join) handlers.join({ deviceName: id }); return s;
  }
  assert.equal(options.pingInterval, 5000); assert.equal(options.pingTimeout, 19000);
  const desktop = socket('desktop', 'a'.repeat(64));
  const phone = socket('phone-old', 'b'.repeat(64));
  phone.handlers['file-picker']({ active: true });
  phone.disconnect();
  assert.equal(delays.at(-1), 300000);
  assert.equal(broadcasts.some((e) => e.event === 'peer-left'), false);
  assert.equal(timers.size, 1);
  const returned = socket('phone-new', 'b'.repeat(64));
  assert.equal(returned.peerId, 'phone-old'); assert.equal(timers.size, 0);
  returned.handlers.discover();
  assert.equal(returned.events.at(-1).data.peers.length, 1);
  assert.equal(returned.events.at(-1).data.peers[0].socketId, 'desktop');
  desktop.handlers.signal({ to: 'phone-old', signalData: { type: 'offer' } });
  assert.equal(returned.events.at(-1).event, 'signal');
  assert.equal(returned.events.at(-1).data.from, 'desktop');
  returned.handlers['chat-request']({ to: 'desktop' });
  assert.equal(desktop.events.at(-1).data.from, 'phone-old');
  assert.ok(broadcasts.some((e) => e.event === 'peer-returned'));
  returned.disconnect(); assert.equal(delays.at(-1), 2000); for (const expire of [...timers]) expire();
  assert.ok(broadcasts.some((e) => e.event === 'peer-left' && e.data.socketId === 'phone-old'));
  const closing = socket('closing-phone', 'c'.repeat(64));
  closing.handlers['page-leave']();
  assert.ok(broadcasts.some((e) => e.event === 'peer-left' && e.data.socketId === 'closing-phone' && e.data.explicit));
  desktop.handlers.discover();
  assert.equal(desktop.events.at(-1).data.peers.length, 0);
  timers.clear();
  // Reproduce: join -> suspend -> reconnect -> disconnect BEFORE join.
  const original = socket('用户-001', 'd'.repeat(64)); original.disconnect();
  const obsoleteCleanup = [...timers][0];
  const replacement = socket('replacement', 'd'.repeat(64), false);
  obsoleteCleanup(); // An obsolete callback must not delete replacement ownership.
  desktop.handlers.discover();
  assert.equal(desktop.events.at(-1).data.peers.length, 1);
  assert.equal(replacement.currentRoom, '10.0.0.1');
  replacement.disconnect();
  for (const expire of [...timers]) expire();
  desktop.handlers.discover();
  assert.equal(desktop.events.at(-1).data.peers.length, 0);
  assert.equal(vm.runInContext('sessions.size', context), 1);
  // Explicit exit before join must remove the inherited room entry as well.
  const next = socket('next', 'e'.repeat(64)); next.disconnect();
  const exiting = socket('exiting', 'e'.repeat(64), false);
  exiting.handlers['page-leave']();
  desktop.handlers.discover();
  assert.equal(desktop.events.at(-1).data.peers.length, 0);
});
