/* Provider contract: start(paragraphs, settings, callbacks), pause(), resume(), stop().
   Providers call onParagraph(index), onEnd(), or onError(message); stop is silent.
   Providers report safe, user-facing errors without exposing credentials. */
(() => {
  function splitText(text, max = 180) {
    const parts = [];
    while (text.length > max) {
      let end = max;
      const candidate = text.slice(0, max);
      const punctuation = Math.max(...['。', '！', '？', '；', '.', '!', '?', ';', '，', ','].map(c => candidate.lastIndexOf(c)));
      if (punctuation >= max / 3) end = punctuation + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      parts.push(text.slice(0, end));
      text = text.slice(end);
    }
    if (text) parts.push(text);
    return parts;
  }
  // Keep utterances short for browser engines, but join adjacent short paragraphs so
  // the engine does not have to restart at every paragraph boundary.
  function browserChunks(paragraphs, max = 180) {
    const chunks = [];
    let current = null;
    paragraphs.forEach((paragraph, index) => {
      const parts = splitText(paragraph.text, max);
      parts.forEach((part, partIndex) => {
        const separator = current && partIndex === 0
          ? (/[。！？；.!?;…]$/.test(current.text.trimEnd()) ? ' ' : '。 ') : '';
        if (!current || current.text.length + separator.length + part.length > max) {
          current = { text: '', marks: [] };
          chunks.push(current);
        } else current.text += separator;
        current.marks.push({ offset: current.text.length, index });
        current.text += part;
      });
    });
    return chunks;
  }
  class BrowserSpeechProvider {
    constructor(synth = speechSynthesis) { this.synth = synth; this.generation = 0; this.running = false; }
    start(paragraphs, settings, callbacks) {
      if (this.running) this.stop();
      this.running = true;
      const generation = this.generation;
      const chunks = browserChunks(paragraphs);
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
        let started = false, highlighted = -1;
        const highlight = charIndex => {
          const mark = chunk.marks.filter(m => m.offset <= charIndex).at(-1) || chunk.marks[0];
          if (mark && mark.index !== highlighted) { highlighted = mark.index; callbacks.onParagraph(mark.index); }
        };
        utterance.onstart = () => { if (generation === this.generation) { started = true; highlight(0); } };
        utterance.onboundary = event => { if (generation === this.generation && started) highlight(event.charIndex); };
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
  class TencentSpeechProvider {
    constructor({ preview = false } = {}) { this.preview = preview; this.generation = 0; this.audio = null; this.pending = null; this.url = null; this.paused = false; this.playAttempt = 0; }
    start(paragraphs, settings, callbacks) {
      this.stop();
      const generation = this.generation;
      const chunks = paragraphs.flatMap((p, index) => splitText(p.text, 120).filter(text => text.trim()).map(text => ({ text, index })));
      let cursor = 0;
      const fail = message => { if (generation === this.generation) { this.stop(); callbacks.onError(message); } };
      this.error = fail;
      const requestNext = () => {
        if (generation !== this.generation || this.paused || this.pending || cursor >= chunks.length) return;
        const chunk = chunks[cursor++];
        const port = chrome.runtime.connect({ name: this.preview ? 'tencent-preview' : 'tencent-tts' });
        const pending = this.pending = { chunk, port, result: null };
        let received = false;
        port.onDisconnect.addListener(() => {
          if (!received && generation === this.generation && this.pending === pending) {
            pending.port = null; pending.result = { error: '腾讯云连接中断，请重试' }; pump();
          }
        });
        port.onMessage.addListener(result => {
          if (received || generation !== this.generation || this.pending !== pending) return;
          received = true;
          pending.port = null;
          pending.result = result;
          port.disconnect();
          pump();
        });
        port.postMessage(this.preview ? { voiceType: settings.tencentVoice } : { text: chunk.text, voiceType: settings.tencentVoice });
      };
      const pump = () => {
        if (generation !== this.generation || this.paused || this.audio) return;
        if (!this.pending) {
          if (cursor >= chunks.length) { this.next = null; callbacks.onEnd(); return; }
          requestNext();
          return;
        }
        if (!this.pending.result) return;
        const { chunk, result } = this.pending;
        this.pending = null;
        if (result.error) { fail(result.error); return; }
        try {
          const bytes = Uint8Array.from(atob(result.audio), c => c.charCodeAt(0));
          this.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
          const audio = this.audio = new Audio(this.url);
          audio.playbackRate = Math.max(0.5, Math.min(2, Number(settings.rate) || 1));
          audio.onplaying = () => {
            if (generation !== this.generation) return;
            callbacks.onParagraph(chunk.index);
            // At most one future chunk is sent, and only after playback starts.
            requestNext();
          };
          audio.onended = () => { if (generation !== this.generation) return; this.releaseAudio(); pump(); };
          audio.onerror = () => fail('腾讯云音频播放失败，请重试');
          this.playAudio();
        } catch (_) { fail('腾讯云音频数据无效，请重试'); }
      };
      this.next = pump;
      pump();
    }
    releaseAudio() {
      if (this.audio) { this.audio.pause(); this.audio.onplaying = this.audio.onended = this.audio.onerror = null; this.audio.removeAttribute('src'); this.audio.load(); this.audio = null; }
      if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    }
    playAudio() {
      const generation = this.generation, attempt = ++this.playAttempt;
      this.audio.play().catch(() => {
        if (generation === this.generation && attempt === this.playAttempt && !this.paused) this.error?.('音频播放被浏览器阻止，请重试或检查浏览器播放权限');
      });
    }
    pause() { this.paused = true; this.playAttempt++; this.audio?.pause(); }
    resume() {
      this.paused = false;
      if (this.audio) { this.playAudio(); }
      else this.next?.();
    }
    stop() {
      this.generation++; this.playAttempt++; this.paused = false;
      const pending = this.pending; this.pending = null;
      pending?.port?.disconnect();
      this.releaseAudio(); this.next = null; this.error = null;
    }
  }
  globalThis.ZhihuVoiceSpeech = { BrowserSpeechProvider, TencentSpeechProvider, splitText };
})();
