(() => {
  const { extract, expandButton } = globalThis.ZhihuVoiceExtract;
  let provider = new globalThis.ZhihuVoiceSpeech.BrowserSpeechProvider();
  const ANSWER = `.AnswerItem, .ArticleItem, [data-zop*='"type":"answer"'], [data-zop*='"type":"article"']`;
  let active = null;
  let serial = 0;
  let locationHref = location.href;
  let scheduled = false;
  let pageRate = null;
  let floating = null;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function answerKey(answer) {
    try {
      const data = JSON.parse(answer.getAttribute('data-zop') || '{}');
      return ['answer', 'article'].includes(data.type) && data.itemId ? `${data.type}:${data.itemId}` : null;
    } catch (_) { return null; }
  }
  function sameAnswer(answer) {
    return active && (answer === active.answer || (active.key && answerKey(answer) === active.key));
  }
  function controlsFor(answer) {
    return [...answer.querySelectorAll('.zv-controls')].filter(c => c.closest(ANSWER) === answer);
  }
  function setText(element, value) { if (element.textContent !== value) element.textContent = value; }
  function renderControls(controls, state, message = '') {
    const play = controls.querySelector('.zv-play');
    setText(play, state === 'playing' ? '⏸ 暂停' : state === 'paused' ? '▶ 继续' : '🔊 朗读');
    play.setAttribute('aria-label', state === 'playing' || state === 'paused' ? '暂停或继续朗读' : '朗读此内容');
    controls.querySelector('.zv-stop').hidden = !state;
    setText(controls.querySelector('.zv-status'), message);
  }
  function renderActive() {
    renderFloating();
    if (!active?.answer.isConnected) return;
    for (const controls of controlsFor(active.answer)) renderControls(controls, active.state, active.message);
  }
  function clearHighlight() {
    if (active?.highlight) active.highlight.classList.remove('zv-highlight');
    if (active) active.highlight = null;
  }
  function reset(message = '') {
    ++serial;
    if (!active) return;
    provider.stop();
    clearHighlight();
    if (active.answer.isConnected) for (const controls of controlsFor(active.answer)) renderControls(controls, null, message);
    active = null;
    renderFloating();
  }
  function togglePlayback() {
    if (!active || active.state === 'loading') return;
    if (active.state === 'playing') { provider.pause(); active.state = 'paused'; active.message = '已暂停'; }
    else { provider.resume(); active.state = 'playing'; active.message = active.incomplete ? '可能未能完整展开，正在朗读可见正文' : '朗读中'; }
    renderActive();
  }
  function reconcileAnswer() {
    if (!active) return false;
    if (!active.answer.isConnected && active.key) {
      const replacement = [...document.querySelectorAll(ANSWER)].find(answer => answerKey(answer) === active.key);
      if (replacement) active.answer = replacement;
    }
    return active.answer.isConnected;
  }
  function createControls(answer, actions) {
    const controls = document.createElement('span');
    controls.className = 'zv-controls';
    controls.innerHTML = '<button type="button" class="zv-play" aria-label="朗读此内容">🔊 朗读</button><button type="button" class="zv-stop" hidden>停止</button><span class="zv-status" role="status" aria-live="polite"></span>';
    const vote = actions.querySelector('button[aria-label^="反对"], .VoteButton');
    let anchor = vote;
    while (anchor && anchor.parentElement !== actions) anchor = anchor.parentElement;
    if (anchor) anchor.after(controls); else actions.prepend(controls);
    controls.addEventListener('click', event => event.stopPropagation());
    controls.querySelector('.zv-stop').addEventListener('click', () => { if (sameAnswer(answer)) reset('已停止'); });
    controls.querySelector('.zv-play').addEventListener('click', async () => {
      if (sameAnswer(answer)) {
        togglePlayback();
        return;
      }
      reset();
      const token = ++serial;
      active = { answer, key: answerKey(answer), state: 'loading', message: '正在准备正文…', highlight: null, paragraphIndex: null };
      renderActive();
      const button = expandButton(answer);
      let expansionUnconfirmed = false;
      if (button) {
        const preview = extract(answer).paragraphs.map(p => p.text).join('\n');
        expansionUnconfirmed = true;
        button.click();
        let previous = '', stable = 0;
        for (let i = 0; i < 20 && token === serial; i++) {
          await wait(150);
          if (!reconcileAnswer()) continue;
          const current = extract(active.answer);
          const text = current.paragraphs.map(p => p.text).join('\n');
          stable = !current.incomplete && text && text === previous ? stable + 1 : 0;
          previous = text;
          if (stable >= 1 && text !== preview) { expansionUnconfirmed = false; break; }
        }
      }
      if (token !== serial || !reconcileAnswer()) return;
      const result = extract(active.answer);
      result.incomplete ||= expansionUnconfirmed;
      if (!result.paragraphs.length) { reset('未能读取正文，请手动展开或刷新页面后重试'); return; }
      let settings = {};
      try { settings = await chrome.runtime.sendMessage({ type: 'settings' }); if (!settings || settings.error) throw new Error(); } catch (_) { if (token === serial) reset('无法读取扩展设置，请重新加载扩展'); return; }
      if (token !== serial || !reconcileAnswer()) return;
      settings.rate = pageRate ?? settings.rate;
      active.rate = Number(settings.rate) || 1;
      active.provider = settings.provider;
      provider = settings.provider === 'tencent' ? new globalThis.ZhihuVoiceSpeech.TencentSpeechProvider() : new globalThis.ZhihuVoiceSpeech.BrowserSpeechProvider();
      active.state = 'playing';
      active.message = result.incomplete ? '可能未能完整展开，正在朗读可见正文' : '正在启动语音…';
      active.incomplete = result.incomplete;
      active.paragraphs = result.paragraphs;
      renderActive();
      try {
        provider.start(result.paragraphs, settings, {
          onParagraph(index) {
            if (token !== serial || !active) return;
            active.paragraphIndex = index;
            active.message = result.incomplete ? '可能未能完整展开，正在朗读可见正文' : '朗读中';
            updateHighlight();
            renderActive();
          },
          onEnd() { if (token === serial) reset('朗读完成'); },
          onError(message) { if (token === serial) reset(message || '语音播放失败，请检查设置后重试'); }
        });
      } catch (_) { if (token === serial) reset('语音播放失败，请检查浏览器语音设置后重试'); }
    });
  }
  function renderFloating() {
    if (!active) { if (floating) { floating.hidden = true; floating.classList.remove('zv-float-open'); floating.querySelector('.zv-float-menu').setAttribute('aria-expanded', 'false'); floating.querySelector('.zv-float-menu').setAttribute('aria-label', '展开朗读工具'); floating.querySelector('.zv-float-hint').textContent = ''; } return; }
    if (!floating) createFloating();
    floating.hidden = false;
    const button = floating.querySelector('.zv-float-play');
    const loading = active.state === 'loading';
    button.setAttribute('aria-disabled', String(loading));
    setText(button, loading ? '…' : active.state === 'playing' ? 'Ⅱ' : '▶');
    const label = loading ? '正在准备朗读' : active.state === 'playing' ? '正在朗读，点击暂停' : '已暂停，点击继续';
    button.setAttribute('aria-label', label);
    button.title = label + '；拖动或使用方向键可移动';
    setText(floating.querySelector('.zv-float-state'), loading ? '准备中' : active.state === 'playing' ? '朗读中' : '已暂停');
    const rate = floating.querySelector('select');
    rate.disabled = loading;
    if (!loading) {
      const value = String(active.rate);
      if (![...rate.options].some(option => option.value === value)) rate.add(new Option(value + '×', value));
      rate.value = value;
    }
    clampFloating();
  }
  function clampFloating() {
    if (!floating || floating.hidden) return;
    const button = floating.querySelector('.zv-float-play');
    const width = button.offsetWidth || 48, height = button.offsetHeight || 48;
    const maxX = Math.max(0, innerWidth - width), maxY = Math.max(0, innerHeight - height);
    const x = Math.min(maxX, Math.max(0, parseFloat(floating.style.left) || 0));
    const y = Math.min(maxY, Math.max(0, parseFloat(floating.style.top) || 0));
    floating.style.left = x + 'px'; floating.style.top = y + 'px';
    floating.classList.toggle('zv-float-right', x > innerWidth / 2);
    floating.classList.toggle('zv-float-top', y < 130);
  }
  function createFloating() {
    floating = document.createElement('div');
    floating.className = 'zv-floating';
    floating.style.left = '16px'; floating.style.top = Math.max(0, innerHeight - 140) + 'px';
    floating.innerHTML = `<button type="button" class="zv-float-play"></button><div class="zv-float-panel"><span class="zv-float-state"></span><label>倍速 <select aria-label="当前朗读倍速"><option value="0.75">0.75×</option><option value="0.8">0.8×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select></label><button type="button" class="zv-float-settings">设置</button><span class="zv-float-hint" role="status"></span></div><button type="button" class="zv-float-menu" aria-label="展开朗读工具" aria-expanded="false">⋯</button>`;
    document.documentElement.append(floating);
    const button = floating.querySelector('.zv-float-play');
    const menu = floating.querySelector('.zv-float-menu');
    let drag = null, suppressClick = false;
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: parseFloat(floating.style.left), top: parseFloat(floating.style.top), moved: false };
      button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) >= 5) drag.moved = true;
      if (drag.moved) { floating.style.left = (drag.left + dx) + 'px'; floating.style.top = (drag.top + dy) + 'px'; clampFloating(); }
    });
    button.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      suppressClick = drag.moved; drag = null;
      if (suppressClick) setTimeout(() => { suppressClick = false; }, 0);
    });
    button.addEventListener('pointercancel', () => { drag = null; suppressClick = false; });
    button.addEventListener('click', event => { event.stopPropagation(); if (!suppressClick) togglePlayback(); suppressClick = false; });
    button.addEventListener('keydown', event => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      floating.style.left = (parseFloat(floating.style.left) + direction[0] * 20) + 'px';
      floating.style.top = (parseFloat(floating.style.top) + direction[1] * 20) + 'px';
      clampFloating();
    });
    menu.addEventListener('click', () => {
      const open = floating.classList.toggle('zv-float-open');
      menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? '收起朗读工具' : '展开朗读工具');
    });
    floating.querySelector('select').addEventListener('change', event => {
      if (!active || active.state === 'loading') return;
      pageRate = active.rate = Number(event.target.value);
      provider.setRate(pageRate);
      floating.querySelector('.zv-float-hint').textContent = active.provider === 'tencent' ? '倍速已调整' : '浏览器语音将在下一片段使用新倍速';
    });
    floating.querySelector('.zv-float-settings').addEventListener('click', async () => {
      try { const result = await chrome.runtime.sendMessage({ type: 'open-options' }); if (result?.error) throw new Error(); }
      catch (_) { floating.querySelector('.zv-float-hint').textContent = '无法打开设置，请在扩展管理中打开'; }
    });
    floating.addEventListener('click', event => event.stopPropagation());
    addEventListener('resize', clampFloating);
  }
  function updateHighlight() {
    if (!active || active.paragraphIndex === null || !active.answer.isConnected) return;
    let paragraph = active.paragraphs[active.paragraphIndex];
    if (!paragraph?.element.isConnected || !active.answer.contains(paragraph.element)) {
      const replacement = extract(active.answer).paragraphs;
      // Only map by index when the text still describes the same answer body.
      if (replacement.length === active.paragraphs.length && replacement.every((p, i) => p.text === active.paragraphs[i].text)) {
        active.paragraphs = replacement;
        paragraph = replacement[active.paragraphIndex];
      } else return;
    }
    if (active.highlight !== paragraph.element) {
      clearHighlight();
      active.highlight = paragraph.element;
      active.highlight.classList.add('zv-highlight');
    }
  }
  function scan() {
    scheduled = false;
    if (location.href !== locationHref) { locationHref = location.href; reset(); }
    document.querySelectorAll(ANSWER).forEach(answer => {
      answer.querySelectorAll('.ContentItem-actions').forEach(actions => {
        if (actions.closest(ANSWER) !== answer || actions.querySelector('.zv-controls')) return;
        createControls(answer, actions);
      });
    });
    if (active) {
      if (reconcileAnswer()) {
        active.missingSince = null;
        updateHighlight();
        renderActive();
      } else if (!active.key || (active.missingSince && Date.now() - active.missingSince >= 1000)) reset();
      else {
        active.missingSince ||= Date.now();
        setTimeout(() => { if (active?.missingSince) scan(); }, 1000);
      }
    }
  }
  const observer = new MutationObserver(() => { if (!scheduled) { scheduled = true; setTimeout(scan, 100); } });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (active && location.href !== locationHref) { locationHref = location.href; reset(); } }, 1000);
  addEventListener('pagehide', () => reset());
  addEventListener('popstate', () => { if (location.href !== locationHref) { locationHref = location.href; reset(); } });
  scan();
})();
