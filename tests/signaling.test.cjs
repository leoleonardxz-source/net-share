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
  function socket(id, token) {
    const handlers = {}, events = [];
    const s = { id, connected: true, handshake: { address: '10.0.0.1', headers: {}, auth: { sessionToken: token } },
      on(name, fn) { handlers[name] = fn; }, emit(event, data) { events.push({ event, data }); }, join() {}, leave() {}, to: io.to,
      disconnect() { s.connected = false; handlers.disconnect(); }, handlers, events,
    };
    connect(s); handlers.join({ deviceName: id }); return s;
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
});
