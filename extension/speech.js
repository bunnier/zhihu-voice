/* Provider contract: start(paragraphs, settings, callbacks), pause(), resume(), stop().
   Providers call onParagraph(index), onEnd(), or onError(message); stop is silent.
   Providers report safe, user-facing errors without exposing credentials. */
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
  class TencentSpeechProvider {
    constructor() { this.generation = 0; this.audio = null; this.port = null; this.url = null; this.paused = false; this.playAttempt = 0; }
    start(paragraphs, settings, callbacks) {
      this.stop();
      const generation = this.generation;
      const chunks = paragraphs.flatMap((p, index) => splitText(p.text, 120).filter(text => text.trim()).map(text => ({ text, index })));
      let cursor = 0;
      const fail = message => { if (generation === this.generation) { this.stop(); callbacks.onError(message); } };
      this.error = fail;
      const next = () => {
        if (generation !== this.generation || this.paused) return;
        if (cursor >= chunks.length) { callbacks.onEnd(); return; }
        const chunk = chunks[cursor++];
        const port = chrome.runtime.connect({ name: 'tencent-tts' });
        this.port = port;
        let received = false;
        port.onDisconnect.addListener(() => { if (!received && generation === this.generation) fail('腾讯云连接中断，请重试'); });
        port.onMessage.addListener(result => {
          received = true;
          this.port = null;
          port.disconnect();
          if (generation !== this.generation) return;
          if (result.error) { fail(result.error); return; }
          try {
            const bytes = Uint8Array.from(atob(result.audio), c => c.charCodeAt(0));
            this.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
            const audio = this.audio = new Audio(this.url);
            audio.playbackRate = Math.max(0.5, Math.min(2, Number(settings.rate) || 1));
            audio.onplaying = () => { if (generation === this.generation) callbacks.onParagraph(chunk.index); };
            audio.onended = () => { if (generation !== this.generation) return; this.releaseAudio(); next(); };
            audio.onerror = () => fail('腾讯云音频播放失败，请重试');
            if (!this.paused) this.playAudio();
          } catch (_) { fail('腾讯云音频数据无效，请重试'); }
        });
        port.postMessage({ text: chunk.text, voiceType: settings.tencentVoice });
      };
      this.next = next;
      next();
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
      if (this.audio) this.playAudio();
      else if (!this.port) this.next?.();
    }
    stop() { this.generation++; this.playAttempt++; this.paused = false; if (this.port) { const port = this.port; this.port = null; port.disconnect(); } this.releaseAudio(); this.next = null; this.error = null; }
  }
  globalThis.ZhihuVoiceSpeech = { BrowserSpeechProvider, TencentSpeechProvider, splitText };
})();
