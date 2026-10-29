(() => {
  const { extract, expandButton } = globalThis.ZhihuVoiceExtract;
  let provider = new globalThis.ZhihuVoiceSpeech.BrowserSpeechProvider();
  const ANSWER = `.AnswerItem, [data-zop*='"type":"answer"']`;
  let active = null;
  let serial = 0;
  let locationHref = location.href;
  let scheduled = false;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function answerKey(answer) {
    try { return String(JSON.parse(answer.getAttribute('data-zop') || '{}').itemId || '') || null; } catch (_) { return null; }
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
    play.setAttribute('aria-label', state === 'playing' || state === 'paused' ? '暂停或继续朗读' : '朗读此回答');
    controls.querySelector('.zv-stop').hidden = !state;
    setText(controls.querySelector('.zv-status'), message);
  }
  function renderActive() {
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
    controls.innerHTML = '<button type="button" class="zv-play" aria-label="朗读此回答">🔊 朗读</button><button type="button" class="zv-stop" hidden>停止</button><span class="zv-status" role="status" aria-live="polite"></span>';
    const vote = actions.querySelector('button[aria-label^="反对"], .VoteButton');
    let anchor = vote;
    while (anchor && anchor.parentElement !== actions) anchor = anchor.parentElement;
    if (anchor) anchor.after(controls); else actions.prepend(controls);
    controls.addEventListener('click', event => event.stopPropagation());
    controls.querySelector('.zv-stop').addEventListener('click', () => { if (sameAnswer(answer)) reset('已停止'); });
    controls.querySelector('.zv-play').addEventListener('click', async () => {
      if (sameAnswer(answer)) {
        if (active.state === 'loading') return;
        if (active.state === 'playing') { provider.pause(); active.state = 'paused'; active.message = '已暂停'; }
        else { provider.resume(); active.state = 'playing'; active.message = '朗读中'; }
        renderActive();
        return;
      }
      reset();
      const token = ++serial;
      active = { answer, key: answerKey(answer), state: 'loading', message: '正在准备正文…', highlight: null, paragraphIndex: null };
      renderActive();
      const button = expandButton(answer);
      if (button) {
        button.click();
        for (let i = 0; i < 20 && token === serial; i++) {
          await wait(150);
          if (reconcileAnswer() && !expandButton(active.answer)) break;
        }
        await wait(150);
      }
      if (token !== serial || !reconcileAnswer()) return;
      const result = extract(active.answer);
      if (!result.paragraphs.length) { reset('未能读取正文，请手动展开或刷新页面后重试'); return; }
      let settings = {};
      try { settings = await chrome.runtime.sendMessage({ type: 'settings' }); if (!settings || settings.error) throw new Error(); } catch (_) { if (token === serial) reset('无法读取扩展设置，请重新加载扩展'); return; }
      if (token !== serial || !reconcileAnswer()) return;
      provider = new globalThis.ZhihuVoiceSpeech.BrowserSpeechProvider();
      active.state = 'playing';
      active.message = result.incomplete ? '可能未能完整展开，正在朗读可见正文' : '正在启动语音…';
      active.paragraphs = result.paragraphs;
      renderActive();
      try {
        provider.start(result.paragraphs, settings, {
          onParagraph(index) {
            if (token !== serial || !active) return;
            active.paragraphIndex = index;
            active.message = '朗读中';
            updateHighlight();
            renderActive();
          },
          onEnd() { if (token === serial) reset('朗读完成'); },
          onError(message) { if (token === serial) reset(message || '语音播放失败，请检查设置后重试'); }
        });
      } catch (_) { if (token === serial) reset('语音播放失败，请检查浏览器语音设置后重试'); }
    });
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
