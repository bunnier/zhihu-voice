const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = name => readFileSync(path.join(__dirname, '..', 'extension', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = () => { const callbacks = []; return { addListener(f) { callbacks.push(f); }, fire(...args) { callbacks.forEach(f => f(...args)); } }; };
const example = '你好，这是一段语音试听。请选择适合你的声音和播放速度。';

async function optionsHarness(settings = {}) {
  const dom = new JSDOM(source('options.html'), { url: 'chrome-extension://extension-id/options.html', runScripts: 'outside-only' });
  const w = dom.window, ports = [], audios = [];
  const saved = { provider: 'browser', rate: 1, voiceURI: '', tencentVoice: 101001, secretId: '', secretKey: '', ...settings };
  const synth = { utterances: [], cancels: 0, getVoices: () => [{ name: '中文', lang: 'zh-CN', voiceURI: 'zh' }], addEventListener() {}, speak(u) { this.utterances.push(u); }, cancel() { this.cancels++; } };
  w.speechSynthesis = synth;
  w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  w.Audio = class { constructor() { audios.push(this); } play() { this.onplaying?.(); return Promise.resolve(); } pause() {} removeAttribute() {} load() {} };
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  w.chrome = { storage: { local: { setAccessLevel: async () => {}, get: async defaults => ({ ...defaults, ...saved }), set: async data => Object.assign(saved, data), remove: async keys => keys.forEach(key => delete saved[key]) } }, runtime: { connect({ name }) { const port = { name, onMessage: event(), onDisconnect: event(), postMessage(m) { this.sent = m; }, disconnect() { this.disconnected = true; this.onDisconnect.fire(); } }; ports.push(port); return port; } } };
  w.eval(source('speech.js')); w.eval(source('options.js')); await tick(); await tick();
  return { dom, w, saved, synth, ports, audios };
}
const change = (w, selector, value) => { const element = w.document.querySelector(selector); element.value = value; element.dispatchEvent(new w.Event('change')); };

test('browser preview uses unsaved voice and speed, stops on changes, and ignores stale events', async () => {
  const { dom, w, saved, synth } = await optionsHarness();
  change(w, '#voice', 'zh'); change(w, '#rate', '1.25');
  w.document.querySelector('#preview').click();
  const first = synth.utterances[0]; assert.equal(first.text, example); assert.equal(first.rate, 1.25); assert.equal(first.voice.voiceURI, 'zh'); assert.equal(saved.rate, 1);
  assert.match(w.document.querySelector('#preview-status').textContent, /准备/);
  first.onstart(); assert.match(w.document.querySelector('#preview-status').textContent, /正在试听/);
  change(w, '#rate', '1.5'); assert.equal(synth.cancels, 1); first.onend(); assert.match(w.document.querySelector('#preview-status').textContent, /重新试听/);
  w.document.querySelector('#preview').click(); assert.equal(synth.utterances[1].rate, 1.5);
  w.document.querySelector('#stop-preview').click(); assert.equal(synth.cancels, 2); assert.match(w.document.querySelector('#preview-status').textContent, /停止/);
  w.document.querySelector('#preview').click(); w.dispatchEvent(new w.Event('pagehide')); assert.equal(synth.cancels, 3);
  dom.window.close();
});

test('Tencent preview uses current selections and saved credentials without saving inputs', async () => {
  const { dom, w, saved, ports, audios } = await optionsHarness({ provider: 'tencent', secretId: 'stored', secretKey: 'stored-key' });
  assert.match(w.document.querySelector('#preview-notice').textContent, /发送至腾讯云.*可能产生费用/);
  change(w, '#tencent-voice', '101004'); change(w, '#rate', '1.5'); w.document.querySelector('#secret-id').value = 'new';
  w.document.querySelector('#preview').click();
  assert.equal(ports[0].name, 'tencent-preview'); assert.equal(ports[0].sent.voiceType, 101004); assert.equal(ports[0].sent.text, undefined);
  assert.equal(saved.secretId, 'stored'); assert.equal(saved.rate, 1);
  ports[0].onMessage.fire({ audio: 'YQ==' }); assert.equal(audios[0].playbackRate, 1.5); assert.match(w.document.querySelector('#preview-status').textContent, /正在试听/);
  audios[0].onended(); assert.match(w.document.querySelector('#preview-status').textContent, /完成/);
  w.document.querySelector('#preview').click(); w.document.querySelector('#stop-preview').click(); assert.equal(ports[1].disconnected, true);
  ports[1].onMessage.fire({ audio: 'YQ==' }); assert.equal(audios.length, 1);
  dom.window.close();
});

test('credential actions save independently, preserve old credentials on failure, and use current preview choices', async () => {
  const { dom, w, saved, ports, audios } = await optionsHarness({ provider: 'tencent', secretId: 'old-id', secretKey: 'old-key' });
  const $ = selector => w.document.querySelector(selector);
  const storage = w.chrome.storage.local;
  const set = storage.set, remove = storage.remove;
  change(w, '#tencent-voice', '101004'); change(w, '#rate', '1.5');
  $('#secret-id').value = 'new-id'; $('#save-credentials').click(); await tick();
  assert.match($('#credential-feedback').textContent, /同时填写/); assert.equal(saved.secretId, 'old-id');
  $('#save').click(); await tick();
  assert.equal(saved.rate, 1.5); assert.equal(saved.secretId, 'old-id'); assert.equal($('#secret-id').value, 'new-id');
  change(w, '#rate', '1.25'); $('#secret-key').value = 'new-key';
  storage.set = async () => { throw new Error('simulated storage failure'); };
  $('#save-credentials').click(); await tick();
  assert.match($('#credential-feedback').textContent, /保存失败/); assert.match($('#credential-status').textContent, /已保存/);
  assert.equal(saved.secretId, 'old-id'); assert.equal($('#secret-key').value, 'new-key');
  storage.set = set; $('#save-credentials').click(); await tick();
  assert.equal(saved.secretId, 'new-id'); assert.equal(saved.secretKey, 'new-key'); assert.equal(saved.rate, 1.5);
  assert.equal($('#secret-id').value, ''); assert.equal($('#secret-key').value, '');
  assert.match($('#credential-feedback').textContent, /已保存/);
  $('#preview').click(); assert.equal(ports[0].sent.voiceType, 101004);
  ports[0].onMessage.fire({ audio: 'YQ==' }); assert.equal(audios[0].playbackRate, 1.25);
  storage.remove = async () => { throw new Error('simulated storage failure'); };
  $('#clear-credentials').click(); await tick();
  assert.equal(ports[0].disconnected, true); assert.equal(saved.secretId, 'new-id');
  assert.match($('#credential-feedback').textContent, /删除失败/); assert.match($('#credential-status').textContent, /已保存/);
  storage.remove = remove; $('#clear-credentials').click(); await tick();
  assert.equal(saved.secretId, undefined); assert.equal(saved.secretKey, undefined); assert.match($('#credential-status').textContent, /尚未保存/);
  dom.window.close();
});

test('credential writes block preview and repeated actions until storage finishes', async () => {
  const { dom, w, saved } = await optionsHarness({ provider: 'tencent' });
  const $ = selector => w.document.querySelector(selector); let finish;
  w.chrome.storage.local.set = data => new Promise(resolve => { finish = () => { Object.assign(saved, data); resolve(); }; });
  $('#secret-id').value = 'test-id'; $('#secret-key').value = 'test-key'; $('#save-credentials').click();
  assert.equal($('#preview').disabled, true); assert.equal($('#clear-credentials').disabled, true); assert.equal($('#secret-key').disabled, true);
  finish(); await tick();
  assert.equal($('#preview').disabled, false); assert.equal($('#clear-credentials').disabled, false); assert.equal(saved.secretId, 'test-id');
  dom.window.close();
});

test('preview reports unavailable browser speech and provider errors', async () => {
  const { dom, w, ports } = await optionsHarness();
  delete w.speechSynthesis; w.document.querySelector('#preview').click(); assert.match(w.document.querySelector('#preview-status').textContent, /浏览器语音不可用/);
  change(w, '#provider', 'tencent'); w.document.querySelector('#preview').click(); ports[0].onMessage.fire({ error: '尚未保存腾讯云密钥，请填写并保存密钥后试听' });
  assert.match(w.document.querySelector('#preview-status').textContent, /尚未保存腾讯云密钥/); assert.equal(w.document.querySelector('#stop-preview').hidden, true);
  dom.window.close();
});

test('background preview accepts only settings page, fixes text, and requires saved credentials', async () => {
  const onMessage = event(), onConnect = event(), calls = [], authorizations = [];
  let saved = { secretId: '', secretKey: '' };
  const chrome = { runtime: { id: 'extension-id', getURL: path => `chrome-extension://extension-id/${path}`, onMessage, onConnect }, storage: { local: { setAccessLevel: async () => {}, get: async defaults => ({ ...defaults, ...saved }) } } };
  const ctx = { chrome, crypto: webcrypto, TextEncoder, URL, AbortController, setTimeout, clearTimeout, importScripts() { vm.runInContext(source('tencent.js'), ctx); }, fetch: async (url, options) => { calls.push(JSON.parse(options.body)); authorizations.push(options.headers.Authorization); return { ok: true, json: async () => ({ Response: { Audio: 'YQ==' } }) }; } };
  vm.createContext(ctx); vm.runInContext(source('background.js'), ctx);
  function connect(sender) { const port = { name: 'tencent-preview', sender, onMessage: event(), onDisconnect: event(), postMessage(result) { this.result = result; }, disconnect() { this.disconnected = true; } }; onConnect.fire(port); return port; }
  const bad = connect({ id: 'extension-id', url: 'https://www.zhihu.com/question/1' }); assert.equal(bad.disconnected, true);
  const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/options.html' };
  const missing = connect(sender); missing.onMessage.fire({ text: '真实知乎文本', voiceType: 101004 }); await tick(); await tick(); assert.match(missing.result.error, /尚未保存/); assert.equal(calls.length, 0);
  saved = { secretId: 'id', secretKey: 'key' }; const good = connect(sender); good.onMessage.fire({ text: '真实知乎文本', voiceType: 101004 });
  for (let i = 0; i < 50 && !good.result; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(good.result.audio, 'YQ=='); assert.equal(calls[0].Text, example); assert.equal(calls[0].VoiceType, 101004); assert.equal(calls[0].Speed, 0);
  saved = { secretId: 'updated-id', secretKey: 'updated-key' }; const next = connect(sender); next.onMessage.fire({ voiceType: 101001 });
  for (let i = 0; i < 50 && !next.result; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(authorizations[1], /Credential=updated-id\//);
});
