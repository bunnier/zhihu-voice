const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { webcrypto, createHash, createHmac } = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');
const source = name => readFileSync(path.join(__dirname, '..', 'extension', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function event() { const callbacks = []; return { addListener: f => callbacks.push(f), fire: (...args) => callbacks.forEach(f => f(...args)) }; }

test('TC3 signature matches an independently calculated request signature', async () => {
  const ctx = { TextEncoder, crypto: webcrypto }; vm.createContext(ctx); vm.runInContext(source('tencent.js'), ctx);
  const body = { Text: '测试', SessionId: 'fixed', VoiceType: 101001, Codec: 'mp3', SampleRate: 16000, Speed: 0 };
  const timestamp = 1700000000, key = 'test-key';
  const request = await ctx.ZhihuVoiceTencent.signedRequest('test-id', key, body, timestamp);
  const hash = s => createHash('sha256').update(s).digest('hex');
  const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
  const date = '2023-11-14', scope = `${date}/tts/tc3_request`;
  const canonical = ['POST', '/', '', 'content-type:application/json; charset=utf-8\nhost:tts.tencentcloudapi.com\n', 'content-type;host', hash(JSON.stringify(body))].join('\n');
  const signed = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const signature = hmac(hmac(hmac('TC3' + key, date), 'tts'), 'tc3_request');
  const expected = createHmac('sha256', signature).update(signed).digest('hex');
  assert.equal(request.headers.Authorization, `TC3-HMAC-SHA256 Credential=test-id/${scope}, SignedHeaders=content-type;host, Signature=${expected}`);
  assert.equal(request.headers['X-TC-Action'], 'TextToVoice');
  assert.equal(request.payload, JSON.stringify(body));
});

function speechHarness() {
  const ports = [], audios = [], revoked = [];
  class Audio {
    constructor(url) { this.url = url; this.plays = 0; audios.push(this); }
    play() { this.plays++; this.onplaying?.(); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  }
  const ctx = { Audio, Blob, Uint8Array, atob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) },
    chrome: { runtime: { connect() { const port = { onMessage: event(), onDisconnect: event(), postMessage(m) { this.sent = m; }, disconnect() { this.disconnected = true; this.onDisconnect.fire(); } }; ports.push(port); return port; } } } };
  vm.createContext(ctx); vm.runInContext(source('speech.js'), ctx);
  return { ctx, ports, audios, revoked };
}
test('Tencent provider pauses during synthesis, resumes, highlights chunks, and plays selected rate', async () => {
  const { ctx, ports, audios, revoked } = speechHarness(); const p = new ctx.ZhihuVoiceSpeech.TencentSpeechProvider();
  const highlights = [], errors = []; let ended = false;
  p.start([{ text: '甲'.repeat(180) }, { text: '乙' }], { rate: 1.25, tencentVoice: 101001 }, { onParagraph: i => highlights.push(i), onEnd: () => { ended = true; }, onError: e => errors.push(e) });
  assert.equal(ports[0].sent.text.length, 120); p.pause();
  ports[0].onMessage.fire({ audio: 'YQ==' }); assert.equal(audios.length, 0);
  p.resume(); assert.equal(audios[0].plays, 1); assert.equal(audios[0].playbackRate, 1.25); assert.deepEqual(highlights, [0]);
  audios[0].onended(); assert.equal(ports[1].sent.text.length, 60);
  ports[1].onMessage.fire({ audio: 'YQ==' }); audios[1].onended();
  assert.equal(ports[2].sent.text, '乙'); ports[2].onMessage.fire({ audio: 'YQ==' }); audios[2].onended();
  assert.deepEqual(highlights, [0, 0, 1]); assert.equal(ended, true); assert.equal(revoked.length, 3); assert.deepEqual(errors, []);
});
test('Tencent provider stop cancels pending request and ignores stale results', () => {
  const { ctx, ports, audios } = speechHarness(); const p = new ctx.ZhihuVoiceSpeech.TencentSpeechProvider(); let calls = 0;
  p.start([{ text: '内容' }], { rate: 1.5, tencentVoice: 101001 }, { onParagraph: () => calls++, onEnd: () => calls++, onError: () => calls++ });
  p.stop(); assert.equal(ports[0].disconnected, true); ports[0].onMessage.fire({ audio: 'YQ==' });
  assert.equal(audios.length, 0); assert.equal(calls, 0);
});

test('background restricts storage, only shares nonsecret settings, and sends signed request', async () => {
  const onMessage = event(), onConnect = event(); const calls = [];
  const settings = { provider: 'tencent', rate: 1.5, tencentVoice: 101001, voiceURI: '', secretId: 'secret-id', secretKey: 'secret-key' };
  const chrome = { runtime: { id: 'extension-id', onMessage, onConnect }, storage: { local: {
    setAccessLevel: async x => { calls.push(x); }, get: async defaults => ({ ...defaults, ...settings })
  } } };
  let fetchRequest;
  const ctx = { chrome, crypto: webcrypto, TextEncoder, URL, AbortController, setTimeout, clearTimeout,
    importScripts() { vm.runInContext(source('tencent.js'), ctx); },
    fetch: async (url, options) => { fetchRequest = { url, options }; return { ok: true, json: async () => ({ Response: { Audio: 'YQ==' } }) }; }
  };
  vm.createContext(ctx); vm.runInContext(source('background.js'), ctx);
  const sender = { id: 'extension-id', url: 'https://www.zhihu.com/question/1' };
  let shared; onMessage.fire({ type: 'settings' }, sender, x => { shared = x; }); await tick();
  assert.equal(calls[0].accessLevel, 'TRUSTED_CONTEXTS'); assert.equal(shared.provider, 'tencent'); assert.equal(shared.secretId, undefined); assert.equal(shared.secretKey, undefined);
  let unauthorized; onMessage.fire({ type: 'settings' }, { id: 'extension-id', url: 'https://example.com/' }, x => { unauthorized = x; }); await tick(); assert.equal(unauthorized, undefined);
  const port = { name: 'tencent-tts', sender, onMessage: event(), onDisconnect: event(), postMessage: x => { port.result = x; }, disconnect() {} };
  onConnect.fire(port); port.onMessage.fire({ text: '短文本', voiceType: 101001 });
  for (let i = 0; i < 20 && !port.result; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(port.result.audio, 'YQ=='); assert.equal(fetchRequest.url, 'https://tts.tencentcloudapi.com/');
  assert.equal(JSON.parse(fetchRequest.options.body).Text, '短文本'); assert.match(fetchRequest.options.headers.Authorization, /^TC3-HMAC-SHA256/);
  assert.equal(JSON.stringify(port.result).includes('secret'), false);
});

test('settings offer common speeds and preserve stored credentials when left blank', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(source('options.html'), { url: 'chrome-extension://test/options.html', runScripts: 'outside-only' });
  const w = dom.window; const saved = { provider: 'tencent', rate: 1, voiceURI: '', tencentVoice: 101001, secretId: 'stored-id', secretKey: 'stored-key' };
  w.speechSynthesis = { getVoices: () => [], addEventListener() {} };
  w.chrome = { storage: { local: { setAccessLevel: async () => {}, get: async defaults => ({ ...defaults, ...saved }), set: async data => Object.assign(saved, data), remove: async keys => keys.forEach(key => delete saved[key]) } } };
  w.eval(source('options.js')); await tick(); await tick();
  const rate = w.document.querySelector('#rate');
  assert.ok([...rate.options].some(o => o.value === '1.25')); assert.ok([...rate.options].some(o => o.value === '1.5'));
  rate.value = '1.25'; w.document.querySelector('#save').click(); await tick();
  assert.equal(saved.rate, 1.25); assert.equal(saved.secretId, 'stored-id'); assert.equal(saved.secretKey, 'stored-key');
  w.document.querySelector('#secret-id').value = 'replacement'; w.document.querySelector('#save-credentials').click(); await tick();
  assert.equal(saved.secretId, 'stored-id'); assert.match(w.document.querySelector('#credential-feedback').textContent, /同时填写/);
  w.document.querySelector('#clear-credentials').click(); await tick(); assert.equal(saved.secretKey, undefined); assert.equal(saved.secretId, undefined);
  dom.window.close();
});

test('a play promise interrupted by pause does not report an error', async () => {
  const { ctx, ports, audios } = speechHarness(); const p = new ctx.ZhihuVoiceSpeech.TencentSpeechProvider(); let errors = 0;
  p.start([{ text: '内容' }], { rate: 1, tencentVoice: 101001 }, { onParagraph() {}, onEnd() {}, onError() { errors++; } });
  ports[0].onMessage.fire({ audio: 'YQ==' });
  let rejectPlay;
  audios[0].play = () => new Promise((_, reject) => { rejectPlay = reject; });
  p.pause(); p.resume(); p.pause(); rejectPlay(new Error('interrupted')); await tick();
  assert.equal(errors, 0); p.stop();
});

test('Tencent prefetch overlaps playback, keeps one future chunk, and defers its errors', () => {
  const { ctx, ports, audios } = speechHarness(); const p = new ctx.ZhihuVoiceSpeech.TencentSpeechProvider();
  const highlights = [], errors = [];
  p.start([{ text: '甲' }, { text: '乙' }, { text: '丙' }], {}, { onParagraph: i => highlights.push(i), onEnd() {}, onError: e => errors.push(e) });
  assert.equal(ports.length, 1);
  ports[0].onMessage.fire({ audio: 'YQ==' });
  assert.equal(audios[0].plays, 1); assert.equal(ports.length, 2); assert.equal(ports[1].sent.text, '乙');
  ports[1].onMessage.fire({ audio: 'YQ==' });
  assert.equal(ports.length, 2); assert.equal(audios.length, 1);
  audios[0].onended();
  assert.equal(audios[1].plays, 1); assert.deepEqual(highlights, [0, 1]);
  assert.equal(ports.length, 3); assert.equal(ports[2].sent.text, '丙');
  ports[2].onMessage.fire({ error: '合成失败' }); assert.deepEqual(errors, []);
  audios[1].onended(); assert.deepEqual(errors, ['合成失败']);
});

test('Tencent pause and stop bound prefetch and discard pending results', () => {
  const { ctx, ports, audios, revoked } = speechHarness(); const p = new ctx.ZhihuVoiceSpeech.TencentSpeechProvider();
  let calls = 0;
  p.start([{ text: '甲' }, { text: '乙' }, { text: '丙' }], {}, { onParagraph() { calls++; }, onEnd() { calls++; }, onError() { calls++; } });
  p.pause(); ports[0].onMessage.fire({ audio: 'YQ==' });
  assert.equal(audios.length, 0); assert.equal(ports.length, 1);
  p.resume(); assert.equal(ports.length, 2); assert.equal(calls, 1);
  p.pause(); ports[1].onMessage.fire({ audio: 'YQ==' });
  assert.equal(ports.length, 2); assert.equal(audios.length, 1);
  p.stop(); assert.equal(revoked.length, 1);
  p.start([{ text: '新回答' }, { text: '新下一段' }], {}, { onParagraph() { calls++; }, onEnd() { calls++; }, onError() { calls++; } });
  ports[2].onMessage.fire({ audio: 'YQ==' }); assert.equal(ports.length, 4);
  const stale = ports[3]; p.stop(); assert.equal(stale.disconnected, true);
  stale.onMessage.fire({ audio: 'YQ==' }); assert.equal(audios.length, 2); assert.equal(calls, 2);
});

test('disconnecting a pending Tencent request aborts fetch and suppresses its result', async () => {
  const onMessage = event(), onConnect = event(); let signal, posted = false;
  const chrome = { runtime: { id: 'extension-id', onMessage, onConnect }, storage: { local: {
    setAccessLevel: async () => {}, get: async defaults => ({ ...defaults, secretId: 'test-id', secretKey: 'test-key' })
  } } };
  const ctx = { chrome, crypto: webcrypto, TextEncoder, URL, AbortController, setTimeout, clearTimeout,
    importScripts() { vm.runInContext(source('tencent.js'), ctx); },
    fetch(url, options) { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); }
  };
  vm.createContext(ctx); vm.runInContext(source('background.js'), ctx);
  const port = { name: 'tencent-tts', sender: { id: 'extension-id', url: 'https://www.zhihu.com/question/1' }, onMessage: event(), onDisconnect: event(), postMessage() { posted = true; }, disconnect() { this.onDisconnect.fire(); } };
  onConnect.fire(port); port.onMessage.fire({ text: '下一段', voiceType: 101001 });
  for (let i = 0; i < 50 && !signal; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(signal); port.disconnect(); await tick();
  assert.equal(signal.aborted, true); assert.equal(posted, false);
});
