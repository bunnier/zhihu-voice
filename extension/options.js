const $ = selector => document.querySelector(selector);
const voice = $('#voice'), rate = $('#rate'), provider = $('#provider');
let selectedVoice = '';
function updateVoices() {
  voice.replaceChildren(new Option('自动选择中文声音', ''));
  for (const item of globalThis.speechSynthesis?.getVoices?.() || []) voice.add(new Option(`${item.name} (${item.lang})`, item.voiceURI));
  if (selectedVoice && ![...voice.options].some(option => option.value === selectedVoice)) voice.add(new Option(`不可用：${selectedVoice}`, selectedVoice));
  voice.value = selectedVoice;
}
function updateProvider() { $('#browser-settings').hidden = provider.value !== 'browser'; $('#tencent-settings').hidden = provider.value !== 'tencent'; }
function credentialStatus(settings) { $('#credential-status').textContent = settings.secretId && settings.secretKey ? '已保存腾讯云密钥。' : '尚未保存腾讯云密钥。'; }
voice.addEventListener('change', () => { selectedVoice = voice.value; });
provider.addEventListener('change', updateProvider);
globalThis.speechSynthesis?.addEventListener?.('voiceschanged', updateVoices);
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => chrome.storage.local.get({ provider: 'browser', rate: 1, voiceURI: '', tencentVoice: 101001, secretId: '', secretKey: '' })).then(settings => {
  selectedVoice = settings.voiceURI; provider.value = settings.provider; rate.value = String(settings.rate);
  if (!rate.value) { rate.add(new Option(`${settings.rate}×（原设置）`, String(settings.rate))); rate.value = String(settings.rate); }
  $('#tencent-voice').value = String(settings.tencentVoice); credentialStatus(settings); updateProvider(); updateVoices();
}).catch(() => { $('#status').textContent = '无法读取设置，请重新加载扩展'; });
$('#save').addEventListener('click', async () => {
  const secretId = $('#secret-id').value.trim(), secretKey = $('#secret-key').value.trim();
  if (!!secretId !== !!secretKey) { $('#status').textContent = '请同时填写 SecretId 和 SecretKey，或两项均留空'; return; }
  try {
    const settings = { provider: provider.value, rate: Number(rate.value), voiceURI: voice.value, tencentVoice: Number($('#tencent-voice').value) };
    if (secretId && secretKey) Object.assign(settings, { secretId, secretKey });
    await chrome.storage.local.set(settings);
    $('#secret-id').value = ''; $('#secret-key').value = '';
    credentialStatus(await chrome.storage.local.get({ secretId: '', secretKey: '' }));
    $('#status').textContent = '设置已保存，下次开始朗读时生效';
  } catch (_) { $('#status').textContent = '保存失败，请重试'; }
});
$('#clear-credentials').addEventListener('click', async () => {
  try { await chrome.storage.local.remove(['secretId', 'secretKey']); $('#secret-id').value = ''; $('#secret-key').value = ''; credentialStatus({}); $('#status').textContent = '密钥已删除'; }
  catch (_) { $('#status').textContent = '删除失败，请重试'; }
});
