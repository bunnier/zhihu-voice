/* Provider contract: start(paragraphs, settings, callbacks), pause(), resume(), stop().
   Providers call onParagraph(index), onEnd(), or onError(message); stop is silent.
   Providers report user-facing errors. */
(() => {
  function splitText(text, max = 180) {
    const parts = [];
    while (text.length > max) {
      let end = max;
      const candidate = text.slice(0, max + 1);
      const punctuation = Math.max(...['。', '！', '？', '；', '.', '!', '?', ';', '，', ','].map(c => candidate.lastIndexOf(c)));
      if (punctuation >= max / 3) end = punctuation + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      parts.push(text.slice(0, end));
      text = text.slice(end);
    }
    if (text) parts.push(text);
    return parts;
  }
  class BrowserSpeechProvider {
    constructor(synth = speechSynthesis) { this.synth = synth; this.generation = 0; this.running = false; }
    start(paragraphs, settings, callbacks) {
      if (this.running) this.stop();
      this.running = true;
      const generation = this.generation;
      const chunks = paragraphs.flatMap((p, index) => splitText(p.text).map(text => ({ text, index })));
      let cursor = 0;
      const next = () => {
        if (generation !== this.generation) return;
        if (cursor >= chunks.length) { this.running = false; callbacks.onEnd(); return; }
        const chunk = chunks[cursor++];
        const utterance = new SpeechSynthesisUtterance(chunk.text);
        utterance.lang = 'zh-CN';
        utterance.rate = Number(settings.rate) || 1;
        const voices = this.synth.getVoices();
        utterance.voice = voices.find(v => v.voiceURI === settings.voiceURI) || voices.find(v => /^zh(?:-|_)/i.test(v.lang)) || null;
        let started = false;
        utterance.onstart = () => { if (generation === this.generation) { started = true; callbacks.onParagraph(chunk.index); } };
        utterance.onend = () => {
          if (generation !== this.generation) return;
          if (!started) { this.generation++; this.running = false; callbacks.onError('语音未能开始，请重试或检查浏览器语音设置'); return; }
          next();
        };
        utterance.onerror = event => { if (generation === this.generation) { this.generation++; this.running = false; callbacks.onError(event.error || '语音播放失败'); } };
        this.synth.speak(utterance);
      };
      next();
    }
    pause() { this.synth.pause(); }
    resume() { this.synth.resume(); }
    stop() { this.generation++; if (this.running) { this.running = false; this.synth.cancel(); } }
  }
  globalThis.ZhihuVoiceSpeech = { BrowserSpeechProvider, splitText };
})();
