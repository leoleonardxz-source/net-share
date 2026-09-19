const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');

function client(storage = new Map(), overrides = {}) {
  const elements = new Map(), handlers = {}, windowHandlers = {}, alerts = [];
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, prepend() {}, querySelector: () => element(), value: '' });
  const context = vm.createContext({ crypto: webcrypto, location: { protocol: 'http:', host: 'localhost' }, navigator: { userAgent: 'Android' },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: { addEventListener: (name, fn) => { windowHandlers[name] = fn; } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, body: element(), addEventListener() {} },
    io: () => ({ connected: true, on(name, fn) { handlers[name] = fn; }, emit() {} }),
    setTimeout, clearTimeout, setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); return timer; }, clearInterval,
    AbortController, Uint8Array, Blob, URL, console, confirm: () => { throw Error('Unexpected connection prompt'); }, alert: (text) => alerts.push(text), ...overrides,
  });
  vm.runInContext(fs.readFileSync('frontend/client.js', 'utf8'), context);
  return { run: (code) => vm.runInContext(code, context), context, handlers, elements, windowHandlers, alerts };
}
class Channel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; sent = [];
  send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : Buffer.from(data)); }
}

test('snapshot removes stale discovery entries even when peer-left was missed', () => {
  const c = client();
  c.run("peers.set('ghost', { name: '用户-001' }); selectedPeerId = 'ghost';");
  c.handlers['room-peers']({ peers: [] });
  assert.equal(c.run('peers.size'), 0);
  assert.equal(c.run('selectedPeerId'), null);
});

test('snapshot probes missing direct peers without resetting the deadline on refresh', () => {
  const timers = new Map();
  const c = client(new Map(), { setTimeout: (fn, ms) => { timers.set(fn, ms); return fn; }, clearTimeout: (fn) => timers.delete(fn) });
  c.context.chat = new Channel();
  c.run("peers.set('p', { name: 'phone', authorized: true, chatChannel: chat });");
  c.handlers['room-peers']({ peers: [] });
  const deadline = [...timers.keys()][0];
  c.handlers['room-peers']({ peers: [] });
  assert.equal([...timers.keys()][0], deadline);
  assert.equal(c.run("peers.has('p')"), true);
  c.handlers['room-peers']({ peers: [{ socketId: 'p', deviceName: 'phone' }] });
  assert.equal(timers.size, 0);
  assert.equal(c.run("peers.get('p').authorized"), true);
  assert.equal(c.run("peers.get('p').chatChannel"), c.context.chat);
});

test('copy menu copies the complete original message including whitespace and markup characters', async () => {
  const c = client(); let copied;
  c.context.navigator.clipboard = { writeText: async (text) => { copied = text; } };
  c.run(fs.readFileSync('frontend/message-copy.js', 'utf8'));
  const original = '\n  第一行 <tag> & "文字"\n\n最后一行\n';
  c.context.original = original;
  c.run("selectedCopyText = original;"); await c.run('copySelectedMessage()');
  assert.equal(copied, original);
  assert.equal(c.elements.get('copyMessageStatus').textContent, '已复制');
  assert.equal(c.elements.get('messageCopyMenu').hidden, true);
  c.run('clearTimeout(copyStatusTimer)');
});

test('clipboard rejection uses fallback and reports a real failure honestly', async () => {
  const c = client();
  c.context.navigator.clipboard = { writeText: async () => { throw Error('denied'); } };
  let field, removed = false;
  c.context.document.createElement = () => (field = { style: {}, select() {}, setSelectionRange() {}, remove() { removed = true; } });
  c.context.document.execCommand = () => false;
  c.run(fs.readFileSync('frontend/message-copy.js', 'utf8'));
  c.context.original = '全文\n下一行';
  c.run('selectedCopyText = original'); await c.run('copySelectedMessage()');
  assert.equal(field.value, '全文\n下一行'); assert.equal(removed, true);
  assert.match(c.elements.get('copyMessageStatus').textContent, /复制失败/);
  c.run('clearTimeout(copyStatusTimer)');
});

test('multiline text preserves line breaks and indentation on sender and receiver', async () => {
  const sender = client(), receiver = client(), chat = new Channel();
  sender.context.chat = chat; receiver.context.chat = new Channel();
  const text = '\n第一段\n\n  第二段 <hello>\n最后一行\n';
  sender.run("peers.set('p', { name: 'phone', chatChannel: chat }); activeChatPeerId = 'p';");
  sender.elements.get('chatInput').value = text; sender.run('sendText()');
  assert.equal(chat.sent[0].text, text);
  receiver.run("activeChatPeerId = 'p'; setupChatChannel(chat, 'p');");
  await receiver.context.chat.onmessage({ data: JSON.stringify(chat.sent[0]) });
  for (const c of [sender, receiver]) {
    assert.equal(c.run("chatSessions.get('p')[0].text"), text);
    assert.ok(c.elements.get('chatMessages').innerHTML.includes(text.replace('<hello>', '&lt;hello&gt;')));
    assert.match(c.elements.get('chatMessages').innerHTML, /class="message-text"/);
  }
  sender.elements.get('chatInput').value = ' \n\t'; sender.run('sendText()');
  assert.equal(chat.sent.length, 1);
});

test('large file uses batch reads and preserves every byte in negotiated chunks', async () => {
  const c = client(), channel = new Channel(), chat = new Channel();
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 17); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  let reads = 0;
  c.context.channel = channel; c.context.chat = chat;
  c.context.file = { size: bytes.length, name: 'test.mp4', slice(a, b) { reads++; return new Blob([bytes.subarray(a, b)]); } };
  c.run("peers.set('p', { fileChannel: channel, chatChannel: chat, pc: { sctp: { maxMessageSize: 65536 } } }); transferInProgress = { transferId: 't', peerId: 'p', controller: new AbortController() };");
  await c.run("sendFile(file, 'p', 't')");
  const chunks = channel.sent.filter(Buffer.isBuffer);
  assert.equal(reads, 3); assert.ok(chunks.every((b) => b.length <= 49152)); assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(channel.sent.at(-1).type, 'file-end');
  c.run("cancelTransfer('t', false)");
});

test('stop interrupts backpressure immediately and no file-end is sent', async () => {
  const c = client(), channel = new Channel(); channel.bufferedAmount = 5 * 1024 * 1024;
  c.context.channel = channel; c.context.file = new Blob([Buffer.alloc(128 * 1024)]);
  c.run("peers.set('p', { fileChannel: channel }); transferInProgress = { transferId: 't', peerId: 'p', controller: new AbortController() };");
  const sending = c.run("sendFile(file, 'p', 't')");
  await new Promise((r) => setTimeout(r, 20)); c.run("cancelTransfer('t', true)");
  await sending;
  assert.equal(channel.sent.some((m) => m.type === 'file-end'), false);
  assert.equal(c.run('transferInProgress'), null);
});

test('cancelled bytes cannot contaminate a new transfer on the same channel', async () => {
  const c = client(), channel = new Channel(); c.context.channel = channel;
  c.run("setupFileChannel(channel, 'p'); receiveStates.set('old', { peerId: 'p', transferId: 'old', chunks: [], received: 0, size: 4 });");
  await channel.onmessage({ data: JSON.stringify({ type: 'file-start', transferId: 'old' }) });
  c.run("cancelTransfer('old', false); receiveStates.set('new', { peerId: 'p', transferId: 'new', chunks: [], received: 0, size: 4 });");
  await channel.onmessage({ data: new Uint8Array([9, 9, 9, 9]).buffer });
  assert.equal(c.run("receiveStates.get('new').received"), 0);
  await channel.onmessage({ data: JSON.stringify({ type: 'file-start', transferId: 'new' }) });
  await channel.onmessage({ data: new Uint8Array([1, 2, 3, 4]).buffer });
  assert.equal(c.run("receiveStates.get('new').received"), 4);
});

test('authorized existing connection does not prompt on a repeated request', async () => {
  const c = client(); c.context.channel = new Channel();
  c.run("peers.set('p', { name: 'phone', authorized: true, chatChannel: channel, fileChannel: channel, pc: { connectionState: 'connected' } });");
  await c.handlers['chat-request']({ from: 'p' });
  assert.equal(c.run('activeChatPeerId'), 'p');
});

test('discovery refresh retains peer identity, authorization and channels', () => {
  const c = client(); c.context.channel = new Channel();
  c.run("peers.set('p', { name: 'phone', authorized: true, chatChannel: channel });");
  c.handlers['room-peers']({ peers: [{ socketId: 'p', deviceName: 'phone' }] });
  assert.equal(c.run("peers.get('p').authorized"), true);
  assert.equal(c.run("peers.get('p').chatChannel"), c.context.channel);
  c.handlers['peer-left']({ socketId: 'p' });
  assert.equal(c.run("peers.has('p')"), true);
  c.run("clearOfflineProbe('p')");
});

test('first attachment waits for both channels before sending its offer', async () => {
  const c = client(), chat = new Channel(), fileChannel = new Channel();
  fileChannel.readyState = 'connecting'; c.context.chat = chat; c.context.fileChannel = fileChannel;
  c.context.file = { size: 120 * 1024 * 1024, name: 'first.mp4', type: 'video/mp4' };
  c.run("peers.set('p', { requested: true, chatChannel: chat, fileChannel });");
  const offering = c.run("offerFile(file, 'p')");
  assert.equal(chat.sent.length, 0);
  fileChannel.readyState = 'open'; await offering;
  assert.equal(chat.sent[0].type, 'file-offer');
  assert.equal(c.elements.get('transferOverlay').hidden, false);
  c.run('cancelTransfer(transferInProgress.transferId, true)');
  assert.equal(chat.sent.at(-1).type, 'file-cancel');
});

test('refresh reuses tab identity while an independent tab gets a new identity', () => {
  const storage = new Map();
  assert.equal(client(storage).run('sessionToken'), client(storage).run('sessionToken'));
  assert.notEqual(client(storage).run('sessionToken'), client().run('sessionToken'));
});

test('Android must confirm before receive state, progress, or acceptance is created', async () => {
  for (const accepted of [false, true]) {
    const c = client(), chat = new Channel(); c.context.chat = chat;
    c.run("peers.set('p', { name: 'desktop', chatChannel: chat });");
    let prompts = 0;
    c.context.confirm = (text) => {
      prompts++; assert.match(text, /desktop/); assert.match(text, /test.mp4/);
      assert.equal(chat.sent.length, 0); assert.equal(c.run('receiveStates.size'), 0);
      assert.equal(c.run('transferInProgress'), null); return accepted;
    };
    await c.run("acceptIncomingFile('p', { transferId: 't', name: 'test.mp4', size: 120000000, mimeType: 'video/mp4' })");
    assert.equal(prompts, 1);
    assert.equal(chat.sent[0].type, accepted ? 'file-accept' : 'file-reject');
    assert.equal(c.run('receiveStates.size'), accepted ? 1 : 0);
    c.run("cancelTransfer('t', false)");
  }
});

test('explicit page close exits chat even before the data channel closes', () => {
  const c = client(); c.context.channel = new Channel();
  c.run("peers.set('p', { name: 'phone', chatChannel: channel }); activeChatPeerId = 'p';");
  c.handlers['peer-left']({ socketId: 'p', explicit: true });
  assert.equal(c.run('activeChatPeerId'), null); assert.equal(c.run("peers.has('p')"), false);
  assert.equal(c.alerts.length, 1); assert.match(c.alerts[0], /已下线/);
});

test('pagehide sends departure over data channel', () => {
  const c = client(); const chat = new Channel(); c.context.chat = chat;
  c.run("peers.set('p', { chatChannel: chat });"); c.windowHandlers.pagehide();
  assert.equal(chat.sent[0].type, 'page-leave');
});

test('stale open channel cannot delay offline notification beyond the probe timeout', () => {
  const timers = new Map();
  const c = client(new Map(), { setTimeout: (fn, ms) => { timers.set(fn, ms); return fn; }, clearTimeout: (fn) => timers.delete(fn) });
  const chat = new Channel(); c.context.chat = chat;
  c.run("peers.set('p', { name: 'phone', chatChannel: chat }); activeChatPeerId = 'p';");
  c.handlers['peer-left']({ socketId: 'p' });
  assert.equal(chat.sent[0].type, 'presence-ping');
  assert.equal(c.alerts.length, 0);
  const [expire, delay] = [...timers][0]; assert.equal(delay, 4000); expire();
  assert.equal(c.alerts.length, 1); assert.equal(c.run('activeChatPeerId'), null);
});

test('live direct peer answers probe and signaling recovery clears further probes', async () => {
  const timers = new Map();
  const c = client(new Map(), { setTimeout: (fn, ms) => { timers.set(fn, ms); return fn; }, clearTimeout: (fn) => timers.delete(fn) });
  const chat = new Channel(); c.context.chat = chat;
  c.run("peers.set('p', { name: 'phone', chatChannel: chat }); setupChatChannel(chat, 'p');");
  c.handlers['peer-left']({ socketId: 'p' });
  await chat.onmessage({ data: JSON.stringify({ type: 'presence-pong', nonce: chat.sent[0].nonce }) });
  assert.equal([...timers.values()][0], 5000); assert.equal(c.alerts.length, 0);
  c.handlers['peer-returned']({ socketId: 'p', deviceName: 'phone' });
  assert.equal(timers.size, 0); assert.equal(c.run("peers.has('p')"), true);
});

test('sent image shows preview, original download link and delivery state', async () => {
  const c = client(); const chat = new Channel(); c.context.chat = chat;
  c.context.file = new Blob(['original image bytes'], { type: 'image/png' }); c.context.file.name = '风景.png';
  c.run("peers.set('p', { name: 'phone', authorized: true, chatChannel: chat, fileChannel: chat }); activeChatPeerId = 'p';");
  await c.run("offerFile(file, 'p')");
  const html = c.elements.get('chatMessages').innerHTML;
  assert.match(html, /<img src="blob:/); assert.match(html, /下载原图/); assert.match(html, /download="风景.png"/);
  assert.match(html, /等待对方确认接收/);
  c.run("cancelTransfer(transferInProgress.transferId, true); closeChat(); openChat('p');");
  assert.match(c.elements.get('chatMessages').innerHTML, /<img/);
  assert.match(c.elements.get('chatMessages').innerHTML, /已取消/);
  c.run("resetChatSession('p')");
});

test('received image updates one message with a downloadable original', async () => {
  const c = client(), chat = new Channel(), fileChannel = new Channel();
  c.context.chat = chat; c.context.fileChannel = fileChannel;
  c.context.confirm = () => true;
  c.run("peers.set('p', { name: 'phone', chatChannel: chat }); activeChatPeerId = 'p'; setupFileChannel(fileChannel, 'p');");
  await c.run("acceptIncomingFile('p', { transferId: 'image', name: 'photo.png', size: 4, mimeType: 'image/png' })");
  await fileChannel.onmessage({ data: JSON.stringify({ type: 'file-start', transferId: 'image' }) });
  await fileChannel.onmessage({ data: new Uint8Array([1, 2, 3, 4]).buffer });
  await fileChannel.onmessage({ data: JSON.stringify({ type: 'file-end', transferId: 'image' }) });
  assert.equal(c.run("chatSessions.get('p').length"), 1);
  assert.match(c.elements.get('chatMessages').innerHTML, /download="photo.png"/);
  assert.match(c.elements.get('chatMessages').innerHTML, /接收完成/);
  const url = c.run("chatSessions.get('p')[0].previewUrl");
  assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  c.run("resetChatSession('p')");
});

test('manual exit clears both session permissions and a fresh request prompts again', async () => {
  const local = client(), remote = client();
  for (const c of [local, remote]) {
    c.context.chat = new Channel();
    c.run("peers.set('p', { name: 'phone', authorized: true, requested: true, chatChannel: chat, pc: { close() {} } }); activeChatPeerId = 'p';");
  }
  const events = []; local.context.events = events;
  local.run("socket.emit = (event, data) => events.push({ event, data }); leaveChat();");
  assert.equal(events[0].event, 'chat-leave');
  remote.handlers['chat-leave']({ from: 'p' });
  for (const c of [local, remote]) {
    assert.equal(c.run("peers.get('p').authorized"), false);
    assert.equal(c.run("peers.get('p').requested"), false);
    assert.equal(c.run("peers.get('p').pc"), null);
  }
  local.run("requestConnection('p')"); assert.equal(events.at(-1).event, 'chat-request');
  let prompts = 0; remote.context.confirm = () => { prompts++; return false; };
  await remote.handlers['chat-request']({ from: 'p' });
  assert.equal(prompts, 1); assert.equal(remote.run('activeChatPeerId'), null);
  assert.equal(remote.run("peers.get('p').authorized"), false);
  remote.context.confirm = () => { prompts++; return true; };
  remote.run('createOffer = async () => {}');
  await remote.handlers['chat-request']({ from: 'p' });
  assert.equal(prompts, 2); assert.equal(remote.run('activeChatPeerId'), 'p');
});
