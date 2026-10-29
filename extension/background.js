const restricted = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const allowed = sender => {
  try { return sender.id === chrome.runtime.id && new URL(sender.url).origin === 'https://www.zhihu.com'; } catch (_) { return false; }
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!allowed(sender) || message?.type !== 'settings') return;
  (async () => {
    await restricted;
    const { rate, voiceURI } = await chrome.storage.local.get({ rate: 1, voiceURI: '' });
    respond({ rate, voiceURI });
  })().catch(() => respond({ error: '无法读取扩展设置，请重新加载扩展' }));
  return true;
});
