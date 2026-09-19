// Copy the message model, not rendered HTML, to preserve whitespace and symbols.
const messageCopyMenu = document.getElementById('messageCopyMenu');
const copyMessageStatus = document.getElementById('copyMessageStatus');
let selectedCopyText = null, longPressTimer = null, pressPoint = null, copyStatusTimer;

function dismissMessageCopy() { messageCopyMenu.hidden = true; selectedCopyText = null; }
function cancelMessagePress() { clearTimeout(longPressTimer); longPressTimer = null; pressPoint = null; }
function showMessageCopy(target, x, y) {
  const bubble = target.closest?.('[data-text-index]');
  if (!bubble || !chatMessagesEl.contains(bubble)) return false;
  const message = chatSessions.get(activeChatPeerId)?.[Number(bubble.dataset.textIndex)];
  if (message?.type !== 'text') return false;
  selectedCopyText = message.text;
  messageCopyMenu.hidden = false;
  const bounds = messageCopyMenu.getBoundingClientRect();
  messageCopyMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  messageCopyMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  return true;
}

async function copySelectedMessage() {
  const text = selectedCopyText;
  if (text === null) return;
  dismissMessageCopy();
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
  } catch { /* Try the user-initiated fallback below. */ }
  if (!copied) {
    const field = document.createElement('textarea');
    const focused = document.activeElement;
    field.value = text; field.readOnly = true;
    field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;font-size:16px;';
    document.body.appendChild(field);
    try { field.select(); field.setSelectionRange(0, text.length); copied = document.execCommand('copy'); }
    catch { copied = false; }
    finally { field.remove(); focused?.focus({ preventScroll: true }); }
  }
  copyMessageStatus.textContent = copied ? '已复制' : '复制失败，请允许浏览器访问剪贴板后重试';
  copyMessageStatus.hidden = false;
  clearTimeout(copyStatusTimer);
  copyStatusTimer = setTimeout(() => { copyMessageStatus.hidden = true; }, copied ? 1800 : 4000);
}

document.getElementById('copyMessageButton').addEventListener('click', copySelectedMessage);
chatMessagesEl.addEventListener('contextmenu', (event) => {
  cancelMessagePress();
  if (showMessageCopy(event.target, event.clientX, event.clientY)) event.preventDefault();
});
chatMessagesEl.addEventListener('pointerdown', (event) => {
  cancelMessagePress();
  if (event.pointerType !== 'touch' || !event.isPrimary || !event.target.closest?.('[data-text-index]')) return;
  pressPoint = { x: event.clientX, y: event.clientY };
  longPressTimer = setTimeout(() => { showMessageCopy(event.target, event.clientX, event.clientY); cancelMessagePress(); }, 550);
});
chatMessagesEl.addEventListener('pointermove', (event) => {
  if (pressPoint && Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > 10) cancelMessagePress();
});
for (const name of ['pointerup', 'pointercancel']) chatMessagesEl.addEventListener(name, cancelMessagePress);
chatMessagesEl.addEventListener('scroll', () => { cancelMessagePress(); dismissMessageCopy(); });
document.addEventListener('pointerdown', (event) => { if (!messageCopyMenu.contains(event.target)) dismissMessageCopy(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') dismissMessageCopy(); });
window.addEventListener('resize', dismissMessageCopy);
document.addEventListener('visibilitychange', () => { cancelMessagePress(); dismissMessageCopy(); });
