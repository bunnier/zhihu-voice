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
  window.chrome = { runtime: { sendMessage: async () => ({ provider: 'browser', rate: 1, voiceURI: '' }) } };
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
  assert.equal(synth.utterances.at(-1).text, '甲第一段。 甲第二段');
  synth.utterances.at(-1).onstart(); assert.ok(a.querySelector('p').classList.contains('zv-highlight'));
  a.querySelector('.zv-play').click(); assert.equal(synth.paused, true);
  a.querySelector('.zv-play').click(); assert.equal(synth.paused, false);
  synth.utterances.at(-1).onboundary({ charIndex: '甲第一段。 '.length });
  assert.ok(a.querySelectorAll('p')[1].classList.contains('zv-highlight'));
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
  assert.ok(chunks.every(c => c.length <= 180 && !/[\uD800-\uDBFF]$/.test(c)));
  assert.ok(window.ZhihuVoiceSpeech.splitText('甲'.repeat(180) + '。乙').every(c => c.length <= 180));
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
  utterance.onboundary({ charIndex: '第一段。 '.length });
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

test('browser joins short paragraphs, bounds long utterances and highlights boundary events', () => {
  const { dom, window, synth } = setup('');
  const provider = new window.ZhihuVoiceSpeech.BrowserSpeechProvider(synth);
  const highlights = []; let ended = 0;
  provider.start([{ text: '第一段。' }, { text: '第二段' }, { text: '长'.repeat(370) }], {}, {
    onParagraph(i) { highlights.push(i); }, onEnd() { ended++; }, onError(e) { assert.fail(e); }
  });
  let i = 0;
  while (i < synth.utterances.length) {
    const u = synth.utterances[i++]; assert.ok(u.text.length <= 180); u.onstart();
    if (i === 1) { assert.equal(u.text, '第一段。 第二段'); u.onboundary({ charIndex: '第一段。 '.length }); }
    u.onend();
  }
  assert.deepEqual(highlights.slice(0, 2), [0, 1]); assert.ok(highlights.includes(2)); assert.equal(ended, 1);
  dom.window.close();
});


test('article cards expand and read their own full body while adjacent answers stay independent', async () => {
  const article = answer('article', '<p>文章预览</p>', '<button class="expand">阅读全文</button>')
    .replace('AnswerItem', 'ArticleItem').replace('id="article"', `id="article" data-zop='{"type":"article","itemId":"42"}'`);
  const other = answer('other', '<p>相邻回答</p>')
    .replace('id="other"', `id="other" data-zop='{"type":"answer","itemId":"42"}'`);
  const { dom, window, synth } = setup(article + other);
  const item = window.document.querySelector('#article');
  item.querySelector('.expand').addEventListener('click', event => {
    event.target.remove();
    setTimeout(() => { item.querySelector('.RichText').innerHTML = '<p>文章第一段</p><p>文章第二段</p>'; }, 500);
  });
  item.querySelector('.zv-play').click(); await sleep(900);
  assert.equal(synth.utterances.at(-1).text, '文章第一段。 文章第二段');
  synth.utterances.at(-1).onstart();
  assert.ok(item.querySelector('p').classList.contains('zv-highlight'));
  window.document.querySelector('#other .zv-play').click(); await sleep(50);
  assert.equal(synth.utterances.at(-1).text, '相邻回答');
  dom.window.close();
});

test('dynamic article redraw retains playback and does not confuse an answer with the same id', async () => {
  const article = answer('article', '<p>文章正文</p>').replace('AnswerItem', 'ArticleItem')
    .replace('id="article"', `id="article" data-zop='{"type":"article","itemId":"42"}'`);
  const other = answer('other', '<p>回答正文</p>').replace('id="other"', `id="other" data-zop='{"type":"answer","itemId":"42"}'`);
  const { dom, window, synth } = setup(other);
  window.document.body.insertAdjacentHTML('beforeend', article); await sleep(150);
  window.document.querySelector('#article .zv-play').click(); await sleep(50);
  const utterance = synth.utterances.at(-1); utterance.onstart();
  window.document.querySelector('#article').outerHTML = article; await sleep(150);
  assert.equal(window.document.querySelector('#article .zv-play').textContent, '⏸ 暂停');
  assert.ok(window.document.querySelector('#article p').classList.contains('zv-highlight'));
  assert.equal(window.document.querySelector('#other .zv-play').textContent, '🔊 朗读');
  dom.window.close();
});

test('collapsed article keeps the incomplete warning during playback', async () => {
  const article = answer('article', '<p>预览</p>', '<button>阅读全文</button>')
    .replace('AnswerItem', 'ArticleItem').replace('class="RichContent"', 'class="RichContent is-collapsed"');
  const { dom, window, synth } = setup(article);
  window.document.querySelector('.zv-play').click(); await sleep(3300);
  synth.utterances.at(-1).onstart();
  assert.match(window.document.querySelector('.zv-status').textContent, /未能完整展开/);
  dom.window.close();
});

test('ignores nested content belonging to another card and does not add controls to unsupported types', () => {
  const nested = answer('inner', '<p>内层正文</p>', '<button>阅读全文</button>').replace('AnswerItem', 'ArticleItem');
  const outer = answer('outer', '<p>外层正文</p>' + nested);
  const { dom, window } = setup(outer + '<div class="ContentItem PinItem"><div class="ContentItem-actions"></div></div>');
  const item = window.document.querySelector('#outer');
  assert.deepEqual(Array.from(window.ZhihuVoiceExtract.extract(item).paragraphs, p => p.text), ['外层正文']);
  assert.equal(window.ZhihuVoiceExtract.expandButton(item), undefined);
  assert.equal(window.document.querySelector('.PinItem .zv-controls'), null);
  dom.window.close();
});

test('floating control follows active playback, switches answers, and hides on end or failure', async () => {
  const { dom, window, synth } = setup(answer('a', '<p>甲</p>') + answer('b', '<p>乙</p>'));
  const $ = s => window.document.querySelector(s);
  $('#a .zv-play').click(); await sleep(30);
  const ball = $('.zv-floating'), button = $('.zv-float-play');
  assert.equal(ball.hidden, false); assert.match(button.getAttribute('aria-label'), /暂停/);
  button.click(); assert.equal(synth.paused, true); assert.match(button.getAttribute('aria-label'), /继续/);
  assert.match($('#a .zv-play').textContent, /继续/);
  button.click(); assert.equal(synth.paused, false);
  $('#b .zv-play').click(); await sleep(30);
  button.click(); assert.equal(synth.paused, true); assert.match($('#b .zv-play').textContent, /继续/);
  button.click(); const u = synth.utterances.at(-1); u.onstart(); u.onend(); assert.equal(ball.hidden, true);
  $('#a .zv-play').click(); await sleep(30); synth.utterances.at(-1).onerror({ error: '失败' });
  assert.equal(ball.hidden, true); assert.match($('#a .zv-status').textContent, /失败/);
  dom.window.close();
});

test('locates the current paragraph after playback advances and the answer is redrawn', async () => {
  const markup = answer('a', '<p>第一段</p><p>第二段</p>')
    .replace('id="a"', `id="a" data-zop='{"type":"answer","itemId":"42"}'`);
  const { dom, window, synth } = setup(markup);
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function(options) { scrolled.push({ element: this, options }); };
  window.document.querySelector('.zv-play').click(); await sleep(30);
  const locate = window.document.querySelector('.zv-float-locate');
  locate.click();
  assert.equal(scrolled.length, 0);
  assert.match(window.document.querySelector('.zv-float-hint').textContent, /无法定位/);
  const utterance = synth.utterances.at(-1);
  utterance.onstart();
  utterance.onboundary({ charIndex: '第一段。 '.length });
  window.document.querySelector('#a').outerHTML = markup;
  locate.click();
  assert.equal(scrolled.length, 1);
  assert.equal(scrolled[0].element, window.document.querySelectorAll('#a p')[1]);
  assert.equal(scrolled[0].options.block, 'center');
  assert.equal(window.document.querySelector('.zv-float-hint').textContent, '');
  dom.window.close();
});

test('floating drag does not toggle, stays in viewport, and menu and rate follow playback', async () => {
  const { dom, window, synth } = setup(answer('a', '<p>' + '甲'.repeat(250) + '</p>'));
  const $ = s => window.document.querySelector(s);
  $('#a .zv-play').click(); await sleep(30);
  const ball = $('.zv-floating'), button = $('.zv-float-play'), menu = $('.zv-float-menu');
  const pointer = (type, x, y) => { const e = new window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(e, 'pointerId', { value: 1 }); button.dispatchEvent(e); };
  pointer('pointerdown', 20, 20); pointer('pointermove', 5000, 5000); pointer('pointerup', 5000, 5000); button.click();
  assert.equal(synth.paused, false); assert.ok(parseFloat(ball.style.left) <= window.innerWidth - 48); assert.ok(parseFloat(ball.style.top) <= window.innerHeight - 48);
  Object.defineProperty(window, 'innerWidth', { value: 300, configurable: true }); Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true }); window.dispatchEvent(new window.Event('resize'));
  assert.ok(parseFloat(ball.style.left) <= 252); assert.ok(parseFloat(ball.style.top) <= 152);
  const oldLeft = parseFloat(ball.style.left); button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(parseFloat(ball.style.left), oldLeft - 20);
  menu.click(); assert.equal(menu.getAttribute('aria-expanded'), 'true');
  const select = $('.zv-float-panel select'); select.value = '1.25'; select.dispatchEvent(new window.Event('change', { bubbles: true }));
  const first = synth.utterances[0]; assert.equal(first.rate, 1); first.onstart(); first.onend(); assert.equal(synth.utterances[1].rate, 1.25);
  $('#a .zv-stop').click(); assert.equal(ball.hidden, true); assert.equal(menu.getAttribute('aria-expanded'), 'false');
  dom.window.close();
});

test('floating panel stays inside the viewport on either edge and on narrow screens', async () => {
  const { dom, window } = setup(answer('a', '<p>正文</p>'));
  window.document.querySelector('.zv-play').click(); await sleep(30);
  const ball = window.document.querySelector('.zv-floating'), panel = ball.querySelector('.zv-float-panel');
  Object.defineProperty(panel, 'offsetWidth', { get: () => Math.min(224, window.innerWidth - 16) });
  Object.defineProperty(panel, 'offsetHeight', { get: () => 150 });
  function position(width, height, x, y) {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
    ball.style.left = x + 'px'; ball.style.top = y + 'px';
    window.dispatchEvent(new window.Event('resize'));
    const left = parseFloat(ball.style.left) + parseFloat(panel.style.left);
    const top = parseFloat(ball.style.top) + parseFloat(panel.style.top);
    assert.ok(left >= 8 && left + panel.offsetWidth <= width - 8);
    assert.ok(top >= 8 && top + panel.offsetHeight <= height - 8);
    return ball.dataset.panelSide;
  }
  assert.equal(position(800, 600, 0, 0), 'right');
  assert.equal(position(800, 600, 752, 552), 'left');
  assert.equal(position(320, 568, 136, 500), 'above');
  assert.equal(position(320, 568, 136, 0), 'below');
  dom.window.close();
});
