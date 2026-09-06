// The server only discovers peers and relays WebRTC signaling. No chat or file bytes pass through it.
const CONFIG = { signalingServer: `${location.protocol}//${location.host}`, refreshIntervalMs: 30000, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
const FALLBACK_CHUNK_SIZE = 16 * 1024;
const PREFERRED_CHUNK_SIZE = 64 * 1024;
const READ_BATCH_SIZE = 4 * 1024 * 1024;
function getSessionToken() {
  const key = 'net-share-session-token';
  try { const saved = sessionStorage.getItem(key); if (/^[a-f0-9]{64}$/.test(saved || '')) return saved; } catch {}
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, '0')).join('');
  try { sessionStorage.setItem(key, token); } catch {}
  return token;
}
const sessionToken = getSessionToken();
let pickingFile = false;
const incomingTransferIds = new Map();
const offlineProbes = new Map();
let pickerPeerId = null;
let socket, deviceName = '', selectedPeerId = null, activeChatPeerId = null, transferInProgress = null;
const peers = new Map(), chatSessions = new Map(), pendingMessages = new Map(), pendingFiles = new Map(), receiveStates = new Map();
const $ = (id) => document.getElementById(id);
const statusEl = $('status'), peerListEl = $('peerList'), logContainer = $('logContainer');
const deviceNameInput = $('deviceNameInput'), refreshPeersButton = $('refreshPeersButton'), startChatButton = $('startChatButton');
const homeView = $('homeView'), chatView = $('chatView'), chatMessagesEl = $('chatMessages'), chatInput = $('chatInput'), chatFileInput = $('chatFileInput');
const chatTitleEl = $('chatTargetTitle'), chatSubtitleEl = $('chatTargetSubtitle');
const transferOverlay = $('transferOverlay'), transferTitle = $('transferTitle'), transferProgressFill = $('transferProgressFill'), transferProgressText = $('transferProgressText');
deviceNameInput.readOnly = true;

function log(message, type = 'info') { const el = document.createElement('div'); el.className = `log-entry ${type}`; el.textContent = `[${new Date().toLocaleTimeString()}] ${message}`; logContainer.prepend(el); }
function escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`; }
function formatSpeed(bytesPerSecond) { return bytesPerSecond >= 1024 ** 2 ? `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s` : `${Math.max(0, bytesPerSecond / 1024).toFixed(1)} KB/s`; }
function needsTransferOverlay(size) { return true; }
function peerName(id) { return peers.get(id)?.name || '未知设备'; }
function statusText(status) { return ({ discovered: '已发现，未连接', connecting: '正在建立直连', connected: '局域网直连成功', failed: '直连失败' })[status] || '未知状态'; }
function setStatus(connected, text) { statusEl.className = `status ${connected ? 'connected' : 'disconnected'}`; statusEl.innerHTML = `<div class="status-main"><span class="status-indicator"></span><span>${escapeHtml(text)}</span></div>`; }
function negotiatedChunkSize(id) {
  const peer = peers.get(id);
  const maxMessageSize = peer?.pc?.sctp?.maxMessageSize;
  let chunkSize = FALLBACK_CHUNK_SIZE;
  let limitText = '浏览器未提供协商上限，回退 16 KB';

  // 0 表示只受可用内存限制；即使如此仍限制为 64 KB，避免单条消息过大阻塞通道。
  if (Number.isFinite(maxMessageSize)) {
    chunkSize = maxMessageSize === 0
      ? PREFERRED_CHUNK_SIZE
      : Math.max(1, Math.min(PREFERRED_CHUNK_SIZE, Math.floor(maxMessageSize * 0.75)));
    limitText = maxMessageSize === 0 ? '不受消息大小上限限制' : `${formatBytes(maxMessageSize)}`;
  }
  if (peer && peer.chunkSize !== chunkSize) {
    peer.chunkSize = chunkSize;
    log(`${peer.name}：协商单条上限 ${limitText}，实际分片 ${formatBytes(chunkSize)}`);
  }
  return chunkSize;
}

function nameNumber(name) { const match = /^用户-(\d+)$/.exec(name || ''); return match ? Number(match[1]) : null; }
function chooseDeviceName(remotePeers) {
  const numbers = remotePeers.map((peer) => nameNumber(peer.deviceName || peer.name)).filter(Number.isInteger);
  return `用户-${String(numbers.includes(1) ? Math.max(0, ...numbers) + 1 : 1).padStart(3, '0')}`;
}
function discoverAndJoin() { if (socket?.connected && !deviceName) socket.emit('discover'); else if (socket?.connected) socket.emit('join', { deviceName }); }

function updatePeerList() {
  peerListEl.innerHTML = '';
  if (!peers.size) peerListEl.innerHTML = '<li class="empty-message">未发现同一局域网中的其他设备</li>';
  peers.forEach((peer, id) => {
    const li = document.createElement('li'); li.className = `peer-item ${selectedPeerId === id ? 'selected' : ''}`;
    li.innerHTML = `<label class="peer-select"><input class="peer-checkbox" type="radio" name="peer" ${selectedPeerId === id ? 'checked' : ''}><span class="avatar">${escapeHtml(peer.name.slice(-3))}</span><span class="peer-info"><span class="peer-ip">${escapeHtml(peer.name)}</span><span class="peer-status ${peer.status}">${statusText(peer.status)}</span></span></label>`;
    li.querySelector('input').addEventListener('change', () => { selectedPeerId = id; updatePeerList(); });
    li.addEventListener('dblclick', () => requestConnection(id)); peerListEl.appendChild(li);
  });
  startChatButton.disabled = !selectedPeerId || !peers.has(selectedPeerId);
}

function addMessage(id, message) { const list = chatSessions.get(id) || []; list.push(message); if (list.length > 50) list.splice(0, list.length - 50); chatSessions.set(id, list); if (id === activeChatPeerId) renderMessages(); }
function updateFileMessage(id, transferId, state) { const message = (chatSessions.get(id) || []).find((entry) => entry.type === 'file' && entry.transferId === transferId); if (!message) return; message.state = state; if (id === activeChatPeerId) renderMessages(); }
function renderMessages() {
  if (!activeChatPeerId) { chatMessagesEl.innerHTML = '<div class="chat-placeholder">请选择一个已发现的设备开始聊天或传输文件。</div>'; return; }
  const list = chatSessions.get(activeChatPeerId) || [];
  chatMessagesEl.innerHTML = list.length ? list.map((message) => {
    let content = '';
    if (message.type === 'text') content = escapeHtml(message.text);
    else if (message.previewUrl) content = `<div>图片：${escapeHtml(message.name)}</div><img src="${escapeHtml(message.previewUrl)}" alt="${escapeHtml(message.name)}" loading="lazy"><a class="image-download" href="${escapeHtml(message.previewUrl)}" download="${escapeHtml(message.name)}">下载原图</a>${message.state ? `<div class="message-time">${escapeHtml(message.state)}</div>` : ''}`;
    else content = `文件：${escapeHtml(message.name)}（${formatBytes(message.size)}）${message.state ? `<div class="message-time">${escapeHtml(message.state)}</div>` : ''}`;
    return `<div class="message-row ${message.sender === 'me' ? 'me' : 'peer'}"><div class="message-bubble"><div>${content}</div><div class="message-time">${new Date(message.timestamp).toLocaleTimeString()}</div></div></div>`;
  }).join('') : '<div class="chat-placeholder">暂时还没有消息。</div>';
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}
function openChat(id) { if (!peers.has(id)) return; activeChatPeerId = id; selectedPeerId = id; chatTitleEl.textContent = peerName(id); chatSubtitleEl.textContent = statusText(peers.get(id)?.status); document.body.classList.add('chat-open'); homeView.classList.add('hidden'); chatView.classList.remove('hidden'); updatePeerList(); renderMessages(); }
function closeChat() { activeChatPeerId = null; document.body.classList.remove('chat-open'); chatView.classList.add('hidden'); homeView.classList.remove('hidden'); }
function resetChatSession(id) {
  const peer = peers.get(id);
  if (transferInProgress?.peerId === id) cancelTransfer(transferInProgress.transferId, true);
  pendingMessages.delete(id); incomingTransferIds.delete(id); clearOfflineProbe(id);
  for (const message of chatSessions.get(id) || []) if (message.previewUrl) URL.revokeObjectURL(message.previewUrl);
  chatSessions.delete(id);
  if (peer) {
    peer.authorized = false; peer.requested = false; peer.negotiating = false;
    if (peer.chatChannel) { peer.chatChannel.onmessage = null; peer.chatChannel.onclose = null; peer.chatChannel.onopen = null; }
    if (peer.fileChannel) peer.fileChannel.onmessage = null;
    if (peer.pc) { peer.pc.onconnectionstatechange = null; peer.pc.onicecandidate = null; peer.pc.ondatachannel = null; peer.pc.close(); }
    peer.pc = null; peer.chatChannel = null; peer.fileChannel = null; peer.candidates = []; peer.status = 'discovered';
  }
  updatePeerList();
}
function handlePeerChatLeave(id) {
  const wasActive = activeChatPeerId === id, name = peerName(id);
  resetChatSession(id);
  if (wasActive) { alert(name + ' 已退出聊天，即将退出聊天框。'); closeChat(); }
}
function leaveChat() {
  if (!activeChatPeerId) return;
  const id = activeChatPeerId;
  if (socket?.connected) socket.emit('chat-leave', { to: id });
  else sendControl(id, { type: 'chat-leave' });
  resetChatSession(id); closeChat();
}

let lastProgressAt = 0;
function showTransfer(title) { lastProgressAt = 0; transferTitle.textContent = title; transferProgressFill.style.width = '0%'; transferProgressText.textContent = '正在准备传输…'; transferOverlay.hidden = false; }
function updateTransfer(current, total, startedAt, action) { if (Date.now() - lastProgressAt < 150 && current !== total) return; lastProgressAt = Date.now(); const percent = total ? Math.round(current / total * 100) : 100; const seconds = Math.max((Date.now() - startedAt) / 1000, 0.1); transferProgressFill.style.width = `${percent}%`; transferProgressText.textContent = `${action}：${percent}% · ${formatSpeed(current / seconds)}`; }
function hideTransfer() { transferOverlay.hidden = true; }

function sendControl(id, message) { const channel = peers.get(id)?.chatChannel; if (channel?.readyState === 'open') channel.send(JSON.stringify(message)); }
function waitForBuffer(channel, transfer, limit) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearInterval(timer); channel.removeEventListener('bufferedamountlow', check); channel.removeEventListener('close', check); transfer?.controller.signal.removeEventListener('abort', check); };
    const check = () => {
      const error = transfer?.cancelled ? '传输已取消' : channel.readyState !== 'open' ? '连接已断开' : Date.now() - started > 60000 ? '传输超时，请重试' : null;
      if (error || channel.bufferedAmount <= limit) { cleanup(); error ? reject(new Error(error)) : resolve(); }
    };
    const started = Date.now();
    timer = setInterval(check, 200);
    channel.addEventListener('bufferedamountlow', check); channel.addEventListener('close', check); transfer?.controller.signal.addEventListener('abort', check); check();
  });
}

async function ensureChannels(id, transfer) {
  const ready = () => ['chatChannel', 'fileChannel'].every((key) => peers.get(id)?.[key]?.readyState === 'open');
  if (ready()) return;
  const peer = peers.get(id);
  if (!peer?.authorized && !peer?.requested) throw new Error('请先建立局域网直连，再发送文件');
  if (!socket.connected) socket.connect();
  const started = Date.now(); let requestedAt = 0;
  while (!ready()) {
    if (transfer?.cancelled) throw new Error('传输已取消');
    if (!peers.has(id) || Date.now() - started > 30000) throw new Error('恢复连接超时，请让对方返回页面后重试');
    if (socket.connected && Date.now() - requestedAt > 5000) { socket.emit('chat-request', { to: id }); requestedAt = Date.now(); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function createPeerConnection(id) {
  const old = peers.get(id); if (old?.pc && !['closed', 'failed'].includes(old.pc.connectionState)) return old.pc;
  const peer = { ...old, status: 'connecting', pc: new RTCPeerConnection({ iceServers: CONFIG.iceServers }), chatChannel: null, fileChannel: null };
  peers.set(id, peer); updatePeerList(); const pc = peer.pc;
  pc.onicecandidate = ({ candidate }) => { if (candidate) socket.emit('signal', { to: id, signalData: { type: 'candidate', candidate } }); };
  pc.onconnectionstatechange = () => { peer.status = pc.connectionState === 'connected' ? 'connected' : pc.connectionState === 'failed' ? 'failed' : pc.connectionState === 'disconnected' ? 'discovered' : 'connecting'; updatePeerList(); if (activeChatPeerId === id) chatSubtitleEl.textContent = statusText(peer.status); if (peer.status === 'failed') log(`无法与 ${peer.name} 建立局域网直连`, 'error'); };
  pc.ondatachannel = ({ channel }) => { if (channel.label === 'chat') { peer.chatChannel = channel; setupChatChannel(channel, id); } else if (channel.label === 'file') { peer.fileChannel = channel; setupFileChannel(channel, id); } };
  return pc;
}

function setupChatChannel(channel, id) {
  let pendingImage = null;
  channel.binaryType = 'arraybuffer';
  channel.onclose = () => { if (transferInProgress?.peerId === id) { const transferId = transferInProgress.transferId; cancelTransfer(transferId, false); updateFileMessage(id, transferId, '连接中断，请返回页面后重新发送'); } if (peers.get(id)?.signalingOffline) handlePeerOffline(id); };
  channel.onopen = () => { negotiatedChunkSize(id); const payload = pendingMessages.get(id); if (payload) { channel.send(JSON.stringify(payload)); pendingMessages.delete(id); } };
  channel.onmessage = async ({ data }) => {
    if (typeof data !== 'string') {
      if (!pendingImage) return;
      pendingImage.chunks.push(data); return;
    }
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'presence-ping') { sendControl(id, { type: 'presence-pong', nonce: message.nonce }); return; }
    if (message.type === 'presence-pong') {
      const probe = offlineProbes.get(id);
      if (probe?.nonce === message.nonce) {
        clearTimeout(probe.timer);
        probe.timer = setTimeout(() => probeOfflinePeer(id), 5000);
      }
      return;
    }
    if (message.type === 'text') addMessage(id, { ...message, sender: 'peer' });
    if (message.type === 'image-start') { pendingImage = { ...message, chunks: [], received: 0 }; log(`正在接收图片：${message.name}`); }
    if (message.type === 'image-end' && pendingImage?.id === message.id) {
      const image = { ...pendingImage, sender: 'peer', previewUrl: URL.createObjectURL(new Blob(pendingImage.chunks, { type: pendingImage.mimeType })) };
      delete image.chunks; delete image.received; addMessage(id, image); pendingImage = null;
    }
    if (message.type === 'chat-leave') handlePeerChatLeave(id);
    if (message.type === 'page-leave') handlePeerOffline(id, true);
    if (message.type === 'file-offer') await acceptIncomingFile(id, message);
    if (message.type === 'file-accept') { const pending = pendingFiles.get(message.transferId); if (pending?.peerId === id) { pendingFiles.delete(message.transferId); clearTimeout(transferInProgress?.timeout); updateFileMessage(id, message.transferId, '对方已接受，开始传输'); sendFile(pending.file, id, message.transferId); } }
    if (message.type === 'file-reject') { cancelTransfer(message.transferId, false); updateFileMessage(id, message.transferId, '对方已拒绝或正忙'); log(`${peerName(id)} 拒绝了文件`, 'info'); }
    if (message.type === 'file-complete') { updateFileMessage(id, message.transferId, '对方已接收完成'); if (transferInProgress?.transferId === message.transferId) { clearTimeout(transferInProgress.timeout); transferInProgress = null; hideTransfer(); } }
    if (message.type === 'file-cancel') cancelTransfer(message.transferId, false);
  };
}

async function acceptIncomingFile(id, offer) {
  const peer = peers.get(id);
  if (transferInProgress || !Number.isSafeInteger(offer.size) || offer.size < 0) { sendControl(id, { type: 'file-reject', transferId: offer.transferId }); return; }
  addMessage(id, { type: 'file', transferId: offer.transferId, name: offer.name, size: offer.size, state: '等待您的确认', timestamp: Date.now(), sender: 'peer' });
  if (!confirm(`${peer.name} 想向你发送文件\n${offer.name} (${formatBytes(offer.size)})\n\n是否接收并开始传输？`)) {
    updateFileMessage(id, offer.transferId, '已拒绝');
    peer.chatChannel.send(JSON.stringify({ type: 'file-reject', transferId: offer.transferId }));
    return;
  }
  const writable = null;
  receiveStates.set(offer.transferId, { ...offer, peerId: id, received: 0, writable, chunks: [], startedAt: Date.now(), lastActivityAt: Date.now(), cancelled: false });
  transferInProgress = { transferId: offer.transferId, peerId: id, receiving: true, cancelled: false, showOverlay: needsTransferOverlay(offer.size) }; updateFileMessage(id, offer.transferId, '下载中'); peer.chatChannel.send(JSON.stringify({ type: 'file-accept', transferId: offer.transferId })); if (transferInProgress.showOverlay) showTransfer(`正在接收：${offer.name}`);
}

function setupFileChannel(channel, id) {
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => negotiatedChunkSize(id);
  channel.onmessage = async ({ data }) => {
    if (typeof data === 'string') {
      let message; try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'file-start') { incomingTransferIds.set(id, message.transferId); return; }
      const state = receiveStates.get(message.transferId); if (!state) return;
      if (message.type === 'file-end') {
        try {
          if (state.received !== state.size) throw new Error('文件不完整，请重新发送');
          if (state.writable) await state.writable.close();
          else {
            const url = URL.createObjectURL(new Blob(state.chunks, { type: state.mimeType }));
            if (state.mimeType?.startsWith('image/')) { const entry = (chatSessions.get(id) || []).find((item) => item.transferId === state.transferId); if (entry) entry.previewUrl = url; else addMessage(id, { type: 'image', name: state.name, previewUrl: url, sender: 'peer', timestamp: Date.now() }); }
            else { const anchor = document.createElement('a'); anchor.href = url; anchor.download = state.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
          }
          updateFileMessage(id, message.transferId, '接收完成'); peers.get(id)?.chatChannel?.send(JSON.stringify({ type: 'file-complete', transferId: message.transferId })); log(`文件接收完成：${state.name}`, 'success');
        } catch (error) { sendControl(id, { type: 'file-cancel', transferId: message.transferId }); updateFileMessage(id, message.transferId, '保存失败'); log(`保存文件失败：${error.message}`, 'error'); }
        receiveStates.delete(message.transferId); if (transferInProgress?.transferId === message.transferId) { const showOverlay = transferInProgress.showOverlay; transferInProgress = null; if (showOverlay) hideTransfer(); }
      }
      if (message.type === 'file-cancel') cancelTransfer(message.transferId, false);
      return;
    }
    const state = receiveStates.get(incomingTransferIds.get(id)); if (!state || state.cancelled) return;
    state.received += data.byteLength;
    state.lastActivityAt = Date.now();
    if (state.received > state.size) { cancelTransfer(state.transferId, true); return; }
    try { if (state.writable) await state.writable.write(data); else state.chunks.push(data); } catch (error) { log(`写入文件失败：${error.message}`, 'error'); cancelTransfer(state.transferId, true); return; }
    if (transferInProgress?.transferId === state.transferId && transferInProgress.showOverlay) updateTransfer(state.received, state.size, state.startedAt, '接收中');
  };
}

async function createOffer(id) {
  const oldPc = peers.get(id)?.pc;
  const reset = !oldPc || ['closed', 'failed'].includes(oldPc.connectionState);
  const pc = createPeerConnection(id), peer = peers.get(id);
  if (!peer.chatChannel) { peer.chatChannel = pc.createDataChannel('chat', { ordered: true }); setupChatChannel(peer.chatChannel, id); }
  if (!peer.fileChannel) { peer.fileChannel = pc.createDataChannel('file', { ordered: true }); setupFileChannel(peer.fileChannel, id); }
  const offer = await pc.createOffer({ iceRestart: true }); await pc.setLocalDescription(offer); socket.emit('signal', { to: id, signalData: { type: 'offer', sdp: pc.localDescription, reset } });
}
function sendText() {
  const text = chatInput.value.trim(); if (!text || !activeChatPeerId) return; const message = { type: 'text', text, timestamp: Date.now() }; const peer = peers.get(activeChatPeerId); addMessage(activeChatPeerId, { ...message, sender: 'me' }); chatInput.value = '';
  if (peer?.chatChannel?.readyState === 'open') peer.chatChannel.send(JSON.stringify(message)); else { peer.requested = true; pendingMessages.set(activeChatPeerId, message); socket.emit('chat-request', { to: activeChatPeerId }); log(`正在请求与 ${peer?.name} 建立直连`, 'info'); }
}
function requestConnection(id) { const peer = peers.get(id); if (!peer) return; peer.requested = true; openChat(id); if (peer.chatChannel?.readyState !== 'open') { socket.emit('chat-request', { to: id }); log(`正在请求与 ${peer.name} 建立直连`, 'info'); } }
async function offerFile(file, id = activeChatPeerId) {
  if (!file || !id) return;
  if (transferInProgress) { log('请先停止或完成当前传输', 'info'); return; }
  const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const transfer = { transferId, peerId: id, cancelled: false, controller: new AbortController(), showOverlay: true };
  transferInProgress = transfer; showTransfer(`正在准备：${file.name}`);
  addMessage(id, { type: 'file', transferId, name: file.name, size: file.size, previewUrl: file.type?.startsWith('image/') ? URL.createObjectURL(file) : null, state: '正在准备连接', timestamp: Date.now(), sender: 'me' });
  try {
    await ensureChannels(id, transfer);
    if (transfer.cancelled) return;
    pendingFiles.set(transferId, { file, peerId: id });
    sendControl(id, { type: 'file-offer', transferId, name: file.name, size: file.size, mimeType: file.type });
    updateFileMessage(id, transferId, '等待对方确认接收'); transferProgressText.textContent = '等待对方确认接收…';
    transfer.timeout = setTimeout(() => { if (pendingFiles.has(transferId)) { cancelTransfer(transferId, true); updateFileMessage(id, transferId, '等待接收超时，请重试'); } }, 120000);
  } catch (error) { if (!transfer.cancelled) { cancelTransfer(transferId, false); updateFileMessage(id, transferId, error.message); log(error.message, 'error'); } }
}
async function sendFile(file, id, transferId) {
  const transfer = transferInProgress;
  if (transfer?.transferId !== transferId || transfer.cancelled) return;
  const channel = peers.get(id)?.fileChannel;
  const chunkSize = negotiatedChunkSize(id);
  transfer.startedAt = Date.now();
  try {
    if (channel?.readyState !== 'open') throw new Error('文件通道未就绪');
    channel.bufferedAmountLowThreshold = 1024 * 1024;
    channel.send(JSON.stringify({ type: 'file-start', transferId })); showTransfer(`正在发送：${file.name}`);
    let sent = 0;
    // Android document providers can make each slice read expensive. Read in MB,
    // then split the in-memory bytes according to the negotiated SCTP limit.
    for (let offset = 0; offset < file.size; offset += READ_BATCH_SIZE) {
      if (transfer.cancelled) throw new Error('传输已取消');
      const batch = await file.slice(offset, Math.min(offset + READ_BATCH_SIZE, file.size)).arrayBuffer();
      for (let position = 0; position < batch.byteLength; position += chunkSize) {
        if (transfer.cancelled) throw new Error('传输已取消');
        if (channel.bufferedAmount > 4 * 1024 * 1024) await waitForBuffer(channel, transfer, 1024 * 1024);
        const chunk = new Uint8Array(batch, position, Math.min(chunkSize, batch.byteLength - position));
        channel.send(chunk); sent += chunk.byteLength;
        updateTransfer(Math.max(0, sent - channel.bufferedAmount), file.size, transfer.startedAt, '发送中');
      }
    }
    await waitForBuffer(channel, transfer, 0);
    channel.send(JSON.stringify({ type: 'file-end', transferId })); updateFileMessage(id, transferId, '已发送，等待对方保存完成'); transferProgressText.textContent = '文件已发送，等待对方保存完成…';
    transfer.timeout = setTimeout(() => { if (transferInProgress === transfer) { cancelTransfer(transferId, true); updateFileMessage(id, transferId, '接收确认超时，请检查对方是否已保存'); } }, 120000);
  } catch (error) { if (transferInProgress === transfer) { cancelTransfer(transferId, true); updateFileMessage(id, transferId, transfer.cancelled && error.message === '传输已取消' ? '已取消' : `发送失败：${error.message}`); } }
}
function cancelTransfer(transferId, notify) {
  const transfer = transferInProgress?.transferId === transferId ? transferInProgress : null; if (transfer) transfer.cancelled = true;
  clearTimeout(transfer?.timeout); transfer?.controller?.abort(); pendingFiles.delete(transferId);
  const state = receiveStates.get(transferId); if (state) { state.cancelled = true; state.writable?.abort(); receiveStates.delete(transferId); updateFileMessage(state.peerId, transferId, '已取消'); }
  if (notify) sendControl(transfer?.peerId || state?.peerId, { type: 'file-cancel', transferId });
  if (transfer) { updateFileMessage(transfer.peerId, transferId, '已取消'); const showOverlay = transfer.showOverlay; transferInProgress = null; if (showOverlay) hideTransfer(); }
}

function initSocket() {
  socket = io(CONFIG.signalingServer, { transports: ['websocket', 'polling'], auth: { sessionToken } });
  socket.on('connect', () => { setStatus(true, '已连接信令服务，正在发现本地设备'); discoverAndJoin(); socket.emit('file-picker', { active: pickingFile }); });
  socket.on('disconnect', () => setStatus(false, '信令服务连接断开'));
  socket.on('discovered-peers', ({ peers: remote }) => { deviceName = chooseDeviceName(remote); deviceNameInput.value = deviceName; socket.emit('join', { deviceName }); });
  socket.on('room-peers', ({ peers: remote }) => { const old = new Map(peers); remote.forEach((peer) => peers.set(peer.socketId, { ...old.get(peer.socketId), name: peer.deviceName || '未命名设备', status: old.get(peer.socketId)?.status || 'discovered' })); if (selectedPeerId && !peers.has(selectedPeerId)) selectedPeerId = null; setStatus(true, `本机：${deviceName} · 已发现 ${peers.size} 台局域网设备`); updatePeerList(); });
  socket.on('peer-joined', (peer) => { peers.set(peer.socketId, { ...peers.get(peer.socketId), name: peer.deviceName || '未命名设备', status: peers.get(peer.socketId)?.status || 'discovered' }); updatePeerList(); });
  socket.on('peer-left', ({ socketId, explicit }) => handlePeerOffline(socketId, explicit));
  socket.on('chat-leave', ({ from }) => handlePeerChatLeave(from));
  socket.on('peer-returned', (remote) => {
    const peer = peers.get(remote.socketId);
    if (peer) { peer.name = remote.deviceName; peer.signalingOffline = false; clearOfflineProbe(remote.socketId); }
    else peers.set(remote.socketId, { name: remote.deviceName, status: 'discovered' });
    updatePeerList();
  });
  socket.on('chat-request', async ({ from }) => {
    const peer = peers.get(from); if (!peer || peer.negotiating) return;
    if (!peer.authorized && !peer.requested && !confirm(peer.name + ' 请求建立局域网直连，是否接受？')) return;
    peer.authorized = true; openChat(from);
    if (peer.chatChannel?.readyState === 'open' && peer.fileChannel?.readyState === 'open' && peer.pc?.connectionState === 'connected') return;
    peer.negotiating = true;
    try {
      if (peer.pc && (peer.chatChannel?.readyState === 'closed' || peer.fileChannel?.readyState === 'closed')) peer.pc.close();
      await createOffer(from);
    } catch (error) { log('建立连接失败：' + error.message, 'error'); }
    finally { peer.negotiating = false; const current = peers.get(from); if (current) current.negotiating = false; }
  });
  socket.on('signal', async ({ from, signalData }) => {
    try {
      let peer = peers.get(from); if (!peer) return;
      if (signalData.type === 'offer') {
        if (!peer.authorized && !peer.requested) return;
        peer.authorized = true;
        if (signalData.reset) { if (peer.chatChannel) peer.chatChannel.onclose = null; peer.pc?.close(); }
        const pc = createPeerConnection(from); peer = peers.get(from);
        await pc.setRemoteDescription(signalData.sdp);
        for (const candidate of peer.candidates || []) await pc.addIceCandidate(candidate);
        peer.candidates = [];
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, signalData: { type: 'answer', sdp: pc.localDescription } });
      }
      if (signalData.type === 'answer') {
        await peer.pc?.setRemoteDescription(signalData.sdp);
        for (const candidate of peer.candidates || []) await peer.pc.addIceCandidate(candidate);
        peer.candidates = [];
      }
      if (signalData.type === 'candidate') {
        if (peer.pc?.remoteDescription) await peer.pc.addIceCandidate(signalData.candidate);
        else (peer.candidates ||= []).push(signalData.candidate);
      }
    } catch (error) { log('直连协商失败：' + error.message, 'error'); }
  });
}
$('sendChatButton').addEventListener('click', sendText); chatInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); sendText(); } }); $('attachFileButton').addEventListener('click', () => { pickerPeerId = activeChatPeerId; pickingFile = true; socket?.emit('file-picker', { active: true }); chatFileInput.click(); }); chatFileInput.addEventListener('change', (event) => { finishFilePicker(); offerFile(event.target.files[0], pickerPeerId); event.target.value = ''; }); $('backToHomeBtn').addEventListener('click', closeChat); $('closeChatBtn').addEventListener('click', leaveChat); startChatButton.addEventListener('click', () => selectedPeerId && requestConnection(selectedPeerId)); refreshPeersButton.addEventListener('click', discoverAndJoin);
setStatus(false, '正在连接信令服务…'); updatePeerList(); initSocket(); setInterval(discoverAndJoin, CONFIG.refreshIntervalMs);

$('stopTransferButton').addEventListener('click', () => { if (transferInProgress) cancelTransfer(transferInProgress.transferId, true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!socket.connected) socket.connect(); else discoverAndJoin(); } });
setInterval(() => {
  for (const state of receiveStates.values()) {
    if (Date.now() - state.lastActivityAt > 120000) {
      cancelTransfer(state.transferId, true);
      updateFileMessage(state.peerId, state.transferId, '接收超时，请让对方返回页面后重新发送');
    }
  }
}, 5000);

function finishFilePicker() { pickingFile = false; socket?.emit('file-picker', { active: false }); }
chatFileInput.addEventListener('cancel', finishFilePicker);
// Some pickers return focus without firing cancel (e.g. dismissing the picker).
window.addEventListener('focus', () => { if (pickingFile) finishFilePicker(); });
function clearOfflineProbe(id) { clearTimeout(offlineProbes.get(id)?.timer); offlineProbes.delete(id); }
function probeOfflinePeer(id) {
  clearOfflineProbe(id);
  const peer = peers.get(id);
  if (!peer?.signalingOffline) return;
  if (peer.chatChannel?.readyState !== 'open') { handlePeerOffline(id, true); return; }
  const nonce = `${Date.now()}-${Math.random()}`;
  const timer = setTimeout(() => handlePeerOffline(id, true), 4000);
  offlineProbes.set(id, { nonce, timer });
  try { sendControl(id, { type: 'presence-ping', nonce }); } catch { handlePeerOffline(id, true); }
}
function handlePeerOffline(id, explicit = false) {
  const peer = peers.get(id); if (!peer) return;
  if (!explicit && peer.chatChannel?.readyState === 'open') { peer.signalingOffline = true; probeOfflinePeer(id); return; }
  clearOfflineProbe(id);
  if (transferInProgress?.peerId === id) cancelTransfer(transferInProgress.transferId, false);
  peer.pc?.close(); peers.delete(id); chatSessions.delete(id);
  if (activeChatPeerId === id) { alert(`${peer.name || '对方设备'} 已下线，即将退出聊天框。`); closeChat(); }
  if (selectedPeerId === id) selectedPeerId = null;
  updatePeerList();
}
// pagehide covers refresh/navigation/closing, but does not run when a file picker
// merely hides the document. Send over both transports while they are available.
window.addEventListener('pagehide', () => {
  for (const id of peers.keys()) { try { sendControl(id, { type: 'page-leave' }); } catch {} }
  socket?.emit('page-leave');
});
window.addEventListener('pageshow', (event) => { if (event.persisted) { socket.connect(); discoverAndJoin(); } });
