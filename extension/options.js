const $ = selector => document.querySelector(selector);
const voice = $('#voice'), rate = $('#rate'), provider = $('#provider');
const previewButton = $('#preview'), stopPreviewButton = $('#stop-preview'), previewStatus = $('#preview-status');
const previewText = '你好，这是一段语音试听。请选择适合你的声音和播放速度。';
let selectedVoice = '';
let previewProvider = null, previewSerial = 0;
function updateVoices() {
  voice.replaceChildren(new Option('自动选择中文声音', ''));
  for (const item of globalThis.speechSynthesis?.getVoices?.() || []) voice.add(new Option(`${item.name} (${item.lang})`, item.voiceURI));
  if (selectedVoice && ![...voice.options].some(option => option.value === selectedVoice)) voice.add(new Option(`不可用：${selectedVoice}`, selectedVoice));
  voice.value = selectedVoice;
}
function updateProvider() { $('#browser-settings').hidden = provider.value !== 'browser'; $('#tencent-settings').hidden = provider.value !== 'tencent'; $('#preview-notice').hidden = provider.value !== 'tencent'; }
function credentialStatus(settings) { $('#credential-status').textContent = settings.secretId && settings.secretKey ? '已保存腾讯云密钥。' : '尚未保存腾讯云密钥。'; }
function stopPreview(message = '') {
  ++previewSerial;
  const current = previewProvider;
  previewProvider = null;
  current?.stop();
  stopPreviewButton.hidden = true;
  previewStatus.textContent = message;
}
voice.addEventListener('change', () => { selectedVoice = voice.value; });
provider.addEventListener('change', updateProvider);
for (const element of [voice, rate, provider, $('#tencent-voice'), $('#secret-id'), $('#secret-key')]) {
  element.addEventListener(element.tagName === 'INPUT' ? 'input' : 'change', () => {
    if (previewProvider) stopPreview('选择已更改，请重新试听');
  });
}
globalThis.speechSynthesis?.addEventListener?.('voiceschanged', updateVoices);
addEventListener('pagehide', () => stopPreview());
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => chrome.storage.local.get({ provider: 'browser', rate: 1, voiceURI: '', tencentVoice: 101001, secretId: '', secretKey: '' })).then(settings => {
  selectedVoice = settings.voiceURI; provider.value = settings.provider; rate.value = String(settings.rate);
  if (!rate.value) { rate.add(new Option(`${settings.rate}×（原设置）`, String(settings.rate))); rate.value = String(settings.rate); }
  $('#tencent-voice').value = String(settings.tencentVoice); credentialStatus(settings); updateProvider(); updateVoices(); previewButton.disabled = false;
}).catch(() => { $('#status').textContent = '无法读取设置，请重新加载扩展'; });
previewButton.addEventListener('click', () => {
  stopPreview();
  if (provider.value === 'browser' && (!globalThis.speechSynthesis?.speak || !globalThis.speechSynthesis?.getVoices || typeof globalThis.SpeechSynthesisUtterance !== 'function')) {
    previewStatus.textContent = '浏览器语音不可用，请检查浏览器语音设置或选择其他语音服务'; return;
  }
  const token = previewSerial;
  try {
    previewProvider = provider.value === 'tencent' ? new ZhihuVoiceSpeech.TencentSpeechProvider({ preview: true }) : new ZhihuVoiceSpeech.BrowserSpeechProvider();
    stopPreviewButton.hidden = false;
    previewStatus.textContent = '正在准备试听…';
    previewProvider.start([{ text: previewText }], { rate: Number(rate.value), voiceURI: voice.value, tencentVoice: Number($('#tencent-voice').value) }, {
      onParagraph() { if (token === previewSerial) previewStatus.textContent = '正在试听…'; },
      onEnd() { if (token === previewSerial) { previewProvider = null; stopPreviewButton.hidden = true; previewStatus.textContent = '试听完成'; } },
      onError(message) { if (token === previewSerial) stopPreview(message || '试听失败，请检查设置后重试'); }
    });
  } catch (_) { if (token === previewSerial) stopPreview('试听失败，请检查语音设置后重试'); }
});
stopPreviewButton.addEventListener('click', () => stopPreview('已停止试听'));
$('#save').addEventListener('click', async () => {
  const secretId = $('#secret-id').value.trim(), secretKey = $('#secret-key').value.trim();
  if (!!secretId !== !!secretKey) { $('#status').textContent = '请同时填写 SecretId 和 SecretKey，或两项均留空'; return; }
  try {
    if (secretId && secretKey && previewProvider) stopPreview('密钥已更改，请重新试听');
    const settings = { provider: provider.value, rate: Number(rate.value), voiceURI: voice.value, tencentVoice: Number($('#tencent-voice').value) };
    if (secretId && secretKey) Object.assign(settings, { secretId, secretKey });
    await chrome.storage.local.set(settings);
    $('#secret-id').value = ''; $('#secret-key').value = '';
    credentialStatus(await chrome.storage.local.get({ secretId: '', secretKey: '' }));
    $('#status').textContent = '设置已保存，下次开始朗读时生效';
  } catch (_) { $('#status').textContent = '保存失败，请重试'; }
});
$('#clear-credentials').addEventListener('click', async () => {
  try { if (previewProvider) stopPreview('密钥已更改，请重新试听'); await chrome.storage.local.remove(['secretId', 'secretKey']); $('#secret-id').value = ''; $('#secret-key').value = ''; credentialStatus({}); $('#status').textContent = '密钥已删除'; }
  catch (_) { $('#status').textContent = '删除失败，请重试'; }
});
