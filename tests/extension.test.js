const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const path = require('node:path');
const source = name => readFileSync(path.join(__dirname, '..', 'extension', name), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function answer(id, content, extra = '') {
  return `<div class="ContentItem AnswerItem" id="${id}"><div class="RichContent"><span class="RichText ztext">${content}</span>${extra}<div class="ContentItem-actions"><span><button aria-label="赞同">赞同</button><button aria-label="反对">反对</button></span><button>评论</button></div></div></div>`;
}
function setup(html) {
  const dom = new JSDOM(html, { url: 'https://www.zhihu.com/question/1', runScripts: 'outside-only' });
  const { window } = dom;
  const synth = { utterances: [], paused: false, cancels: 0, speak(u) { this.utterances.push(u); }, cancel() { this.cancels++; }, pause() { this.paused = true; }, resume() { this.paused = false; }, getVoices() { return [{ lang: 'zh-CN', voiceURI: 'zh' }]; } };
  window.speechSynthesis = synth;
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.chrome = { runtime: { sendMessage: async () => ({ rate: 1, voiceURI: '' }) } };
  for (const file of ['extract.js', 'speech.js', 'content.js']) window.eval(source(file));
  return { dom, window, synth };
}

test('reads visible answer paragraphs directly, preserving inline text and excluding hidden controls', () => {
  const { dom, window } = setup(answer('a', '<p>第一段 <a>链接</a> 末尾</p><p hidden>隐藏</p><p><b>第二</b> <b>段</b></p>'));
  const result = window.ZhihuVoiceExtract.extract(window.document.querySelector('#a'));
  assert.deepEqual(Array.from(result.paragraphs, p => p.text), ['第一段 链接 末尾', '第二 段']);
  assert.equal(result.incomplete, false);
  dom.window.close();
});

test('controls insert after votes, play, pause, resume, highlight and switch answers', async () => {
  const { dom, window, synth } = setup(answer('a', '<p>甲第一段</p><p>甲第二段</p>') + answer('b', '<p>乙正文</p>'));
  const a = window.document.querySelector('#a'), b = window.document.querySelector('#b');
  assert.equal(a.querySelector('.ContentItem-actions').children[1].className, 'zv-controls');
  a.querySelector('.zv-play').click(); await sleep(200);
  assert.equal(synth.utterances.at(-1).text, '甲第一段');
  synth.utterances.at(-1).onstart(); assert.ok(a.querySelector('p').classList.contains('zv-highlight'));
  a.querySelector('.zv-play').click(); assert.equal(synth.paused, true);
  a.querySelector('.zv-play').click(); assert.equal(synth.paused, false);
  synth.utterances.at(-1).onend(); assert.equal(synth.utterances.at(-1).text, '甲第二段');
  synth.utterances.at(-1).onstart(); assert.ok(a.querySelectorAll('p')[1].classList.contains('zv-highlight'));
  const stale = synth.utterances.at(-1);
  b.querySelector('.zv-play').click(); await sleep(200);
  assert.equal(synth.utterances.at(-1).text, '乙正文');
  assert.equal(a.querySelectorAll('.zv-highlight').length, 0);
  const count = synth.utterances.length; stale.onend(); assert.equal(synth.utterances.length, count);
  b.querySelector('.zv-stop').click(); assert.equal(b.querySelector('.zv-status').textContent, '已停止');
  dom.window.close();
});

test('expands before extraction and warns when expansion does not succeed', async () => {
  const { dom, window, synth } = setup(answer('a', '<p>预览</p>', '<button class="expand">展开阅读全文</button>'));
  const a = window.document.querySelector('#a');
  a.querySelector('.expand').addEventListener('click', event => { a.querySelector('.RichText').innerHTML = '<p>完整内容</p>'; event.target.remove(); });
  a.querySelector('.zv-play').click(); await sleep(400);
  assert.equal(synth.utterances.at(-1).text, '完整内容');
  dom.window.close();
  const second = setup(answer('b', '<p>预览</p>', '<button>展开阅读全文</button>'));
  second.window.document.querySelector('.zv-play').click(); await sleep(3300);
  assert.match(second.window.document.querySelector('.zv-status').textContent, /未能完整展开/);
  second.dom.window.close();
});

test('handles dynamically added answers and stops if active answer disappears', async () => {
  const { dom, window, synth } = setup('');
  window.document.body.insertAdjacentHTML('beforeend', answer('a', '<p>动态回答</p>'));
  await sleep(150);
  const a = window.document.querySelector('#a'); assert.ok(a.querySelector('.zv-play'));
  a.querySelector('.zv-play').click(); await sleep(200);
  const count = synth.cancels; a.remove(); await sleep(150);
  assert.ok(synth.cancels > count);
  dom.window.close();
});

test('chunks long text without dropping characters or splitting surrogate pairs', () => {
  const { dom, window } = setup('');
  const text = '中文'.repeat(89) + '😀' + '句子。'.repeat(100);
  const chunks = window.ZhihuVoiceSpeech.splitText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(c => !/[\uD800-\uDBFF]$/.test(c)));
  dom.window.close();
});

test('continues preparing when expanding replaces the answer and its controls', async () => {
  const collapsed = answer('a', '<p>预览</p>', '<button class="expand">阅读全文</button>')
    .replace('id="a"', 'id="a" data-zop=\'{"type":"answer","itemId":"42"}\'');
  const { dom, window, synth } = setup(collapsed);
  const a = window.document.querySelector('#a');
  a.querySelector('.expand').addEventListener('click', () => {
    const expanded = answer('a', '<p>完整回答</p>')
      .replace('id="a"', 'id="a" data-zop=\'{"type":"answer","itemId":"42"}\'');
    a.outerHTML = expanded;
  });
  a.querySelector('.zv-play').click();
  await sleep(600);
  const replacement = window.document.querySelector('#a');
  assert.equal(synth.utterances.at(-1).text, '完整回答');
  assert.equal(replacement.querySelector('.zv-play').textContent, '⏸ 暂停');
  assert.equal(replacement.querySelector('.zv-stop').hidden, false);
  replacement.querySelector('.zv-stop').click();
  assert.equal(replacement.querySelector('.zv-status').textContent, '已停止');
  dom.window.close();
});

test('reports an error if browser speech ends without starting', () => {
  const { dom, window, synth } = setup('');
  const provider = new window.ZhihuVoiceSpeech.BrowserSpeechProvider(synth);
  let error = '', ended = false;
  provider.start([{ text: '一段正文' }], {}, {
    onParagraph() {}, onEnd() { ended = true; }, onError(message) { error = message; }
  });
  synth.utterances.at(-1).onend();
  assert.match(error, /未能开始/);
  assert.equal(ended, false);
  dom.window.close();
});

test('keeps playback and synchronizes replacement and floating action bars', async () => {
  const markup = answer('a', '<p>第一段</p><p>第二段</p>')
    .replace('id="a"', 'id="a" data-zop=\'{"type":"answer","itemId":"42"}\'');
  const { dom, window, synth } = setup(markup);
  const a = window.document.querySelector('#a');
  a.querySelector('.zv-play').click(); await sleep(30);
  const utterance = synth.utterances.at(-1);
  utterance.onstart();
  const oldBar = a.querySelector('.ContentItem-actions');
  const newBar = oldBar.cloneNode(true);
  newBar.querySelector('.zv-controls').remove();
  oldBar.replaceWith(newBar);
  const floating = newBar.cloneNode(true);
  a.querySelector('.RichContent').append(floating);
  await sleep(150);
  const controls = a.querySelectorAll('.zv-controls');
  assert.equal(controls.length, 2);
  assert.ok([...controls].every(c => c.querySelector('.zv-play').textContent === '⏸ 暂停'));
  assert.ok(a.querySelector('p').classList.contains('zv-highlight'));
  controls[1].querySelector('.zv-play').click();
  assert.equal(synth.paused, true);
  assert.ok([...controls].every(c => c.querySelector('.zv-play').textContent === '▶ 继续'));
  controls[0].querySelector('.zv-play').click();
  assert.equal(synth.paused, false);
  controls[1].querySelector('.zv-stop').click();
  assert.ok([...controls].every(c => c.querySelector('.zv-status').textContent === '已停止'));
  dom.window.close();
});

test('preserves playback and remaps highlight when the answer is redrawn', async () => {
  const markup = answer('a', '<p>第一段</p><p>第二段</p>')
    .replace('id="a"', 'id="a" data-zop=\'{"type":"answer","itemId":"42"}\'');
  const { dom, window, synth } = setup(markup);
  window.document.querySelector('.zv-play').click(); await sleep(30);
  const utterance = synth.utterances.at(-1); utterance.onstart();
  const cancelCount = synth.cancels;
  window.document.querySelector('#a').outerHTML = markup;
  await sleep(150);
  const a = window.document.querySelector('#a');
  assert.equal(synth.cancels, cancelCount);
  assert.equal(a.querySelector('.zv-play').textContent, '⏸ 暂停');
  assert.ok(a.querySelector('p').classList.contains('zv-highlight'));
  utterance.onend();
  assert.equal(synth.utterances.at(-1).text, '第二段');
  synth.utterances.at(-1).onstart();
  assert.ok(a.querySelectorAll('p')[1].classList.contains('zv-highlight'));
  dom.window.close();
});

test('starts after expansion replaces the answer before the observer scan', async () => {
  const markup = answer('a', '<p>预览</p>', '<button class="expand">阅读全文</button>')
    .replace('id="a"', 'id="a" data-zop=\'{"type":"answer","itemId":"42"}\'');
  const { dom, window, synth } = setup(markup);
  const a = window.document.querySelector('#a');
  a.querySelector('.expand').addEventListener('click', () => {
    a.outerHTML = answer('a', '<p>完整正文</p>')
      .replace('id="a"', 'id="a" data-zop=\'{"type":"answer","itemId":"42"}\'');
  });
  a.querySelector('.zv-play').click();
  await sleep(400);
  assert.equal(synth.utterances.at(-1).text, '完整正文');
  synth.utterances.at(-1).onstart();
  assert.ok(window.document.querySelector('#a p').classList.contains('zv-highlight'));
  dom.window.close();
});

test('does not cancel browser speech when starting an idle provider', () => {
  const { dom, window, synth } = setup('');
  const provider = new window.ZhihuVoiceSpeech.BrowserSpeechProvider(synth);
  provider.start([{ text: '正文' }], {}, { onParagraph() {}, onEnd() {}, onError() {} });
  assert.equal(synth.cancels, 0);
  provider.stop();
  assert.equal(synth.cancels, 1);
  dom.window.close();
});
