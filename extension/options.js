const $ = selector => document.querySelector(selector);
const voice = $('#voice'), rate = $('#rate');
let selectedVoice = '';
function updateVoices() {
  voice.replaceChildren(new Option('自动选择中文声音', ''));
  for (const item of speechSynthesis.getVoices()) voice.add(new Option(`${item.name} (${item.lang})`, item.voiceURI));
  if (selectedVoice && ![...voice.options].some(option => option.value === selectedVoice)) voice.add(new Option(`不可用：${selectedVoice}`, selectedVoice));
  voice.value = selectedVoice;
}
voice.addEventListener('change', () => { selectedVoice = voice.value; });
speechSynthesis.addEventListener('voiceschanged', updateVoices);
chrome.storage.local.get({ rate: 1, voiceURI: '' }).then(settings => {
  selectedVoice = settings.voiceURI; rate.value = String(settings.rate);
  if (!rate.value) { rate.add(new Option(`${settings.rate}×（原设置）`, String(settings.rate))); rate.value = String(settings.rate); }
  updateVoices();
}).catch(() => { $('#status').textContent = '无法读取设置，请重新加载扩展'; });
$('#save').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ rate: Number(rate.value), voiceURI: voice.value });
    $('#status').textContent = '设置已保存，下次开始朗读时生效';
  } catch (_) { $('#status').textContent = '保存失败，请重试'; }
});
