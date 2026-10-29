importScripts('tencent.js');

// Content scripts must not be able to read the locally stored credentials.
const restricted = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const defaults = { provider: 'browser', rate: 1, voiceURI: '', tencentVoice: 101001, secretId: '', secretKey: '' };
const allowed = sender => {
  try { return sender.id === chrome.runtime.id && new URL(sender.url).origin === 'https://www.zhihu.com'; } catch (_) { return false; }
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!allowed(sender) || message?.type !== 'settings') return;
  (async () => {
    await restricted;
    const { provider, rate, voiceURI, tencentVoice } = await chrome.storage.local.get(defaults);
    respond({ provider, rate, voiceURI, tencentVoice });
  })().catch(() => respond({ error: '无法读取扩展设置，请重新加载扩展' }));
  return true;
});

function errorMessage(code) {
  if (/AuthFailure|Authorization|Signature|SecretId/i.test(code)) return '腾讯云鉴权失败，请检查密钥和子账号权限';
  if (/NoFreeAccount|PkgExhausted|AccountArrears/i.test(code)) return '腾讯云额度不足或账户欠费，请检查资源包和计费设置';
  if (/ServerNotOpen|AppIdNotRegistered|ForbiddenUse/i.test(code)) return '腾讯云语音合成服务未开通或无权使用';
  if (/VoiceType/i.test(code)) return '腾讯云音色不可用，请在设置中更换音色';
  if (/LimitExceeded/i.test(code)) return '腾讯云请求频率或并发超限，请稍后重试';
  return `腾讯云合成失败（${/^[\w.]+$/.test(code) ? code : '未知错误'}），请检查服务和设置`;
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'tencent-tts' || !allowed(port.sender)) { port.disconnect(); return; }
  let controller, used = false, disconnected = false;
  port.onDisconnect.addListener(() => { disconnected = true; controller?.abort(); });
  port.onMessage.addListener(async message => {
    if (used) return;
    used = true;
    try {
      const text = message?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 150) throw new Error('文本分段无效，请重新开始朗读');
      await restricted;
      const settings = await chrome.storage.local.get(defaults);
      if (!settings.secretId || !settings.secretKey) throw new Error('请在扩展设置中填写腾讯云 SecretId 和 SecretKey');
      const voiceType = Number(message.voiceType);
      if (!Number.isSafeInteger(voiceType) || voiceType < 0) throw new Error('腾讯云音色无效，请检查设置');
      const body = { Text: text, SessionId: crypto.randomUUID(), VoiceType: voiceType, Codec: 'mp3', SampleRate: 16000, Speed: 0 };
      const request = await ZhihuVoiceTencent.signedRequest(settings.secretId, settings.secretKey, body, Math.floor(Date.now() / 1000));
      if (disconnected) return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let response;
      try { response = await fetch('https://tts.tencentcloudapi.com/', { method: 'POST', headers: request.headers, body: request.payload, signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`腾讯云网络请求失败（HTTP ${response.status}）`);
      const data = (await response.json()).Response;
      if (data?.Error) throw new Error(errorMessage(data.Error.Code || '未知错误'));
      if (typeof data?.Audio !== 'string' || !data.Audio) throw new Error('腾讯云未返回音频，请重试');
      if (!disconnected) port.postMessage({ audio: data.Audio });
    } catch (error) {
      if (!disconnected) port.postMessage({ error: error.name === 'AbortError' ? '腾讯云请求超时，请重试' : (error.message || '腾讯云网络请求失败，请检查网络') });
    }
  });
});
