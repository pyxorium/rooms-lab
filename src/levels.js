// levels.js: who's talking (rooms-lab-plan.md, section 10: everyone sees who's here and who's talking).
// Listens to each voice (your own microphone and each other person's) with the browser's own audio
// analyser, on this computer only; nothing is sent or kept. Someone counts as talking while their level
// stays above a quiet threshold, and for a moment after.
export function createLevels({ AudioContextImpl = globalThis.AudioContext, onChange = () => {}, threshold = 0.015, everyMs = 150, holdMs = 600 } = {}) {
  let ctx = null, timer = null;
  const watched = new Map();      // id → { source, analyser, buf, lastLoud }
  let talking = new Set();

  function tick() {
    const now = Date.now();
    const next = new Set();
    for (const [id, w] of watched) {
      w.analyser.getFloatTimeDomainData(w.buf);
      let sum = 0;
      for (const v of w.buf) sum += v * v;
      if (Math.sqrt(sum / w.buf.length) > threshold) w.lastLoud = now;
      if (now - w.lastLoud < holdMs) next.add(id);
    }
    if (next.size !== talking.size || [...next].some((x) => !talking.has(x))) { talking = next; onChange(new Set(talking)); }
  }

  return {
    /** Call from the click that enters the room: browsers only let a page start audio from a click. */
    start() {
      if (!AudioContextImpl) return;
      try { ctx ||= new AudioContextImpl(); if (ctx.state === 'suspended') ctx.resume().catch(() => {}); } catch { /* no levels */ }
    },
    watch(id, stream) {
      if (!AudioContextImpl || !stream || !stream.getAudioTracks().length) return;
      this.unwatch(id);
      try {
        ctx ||= new AudioContextImpl();
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);              // not to the speakers: the page plays voices through <audio>
        watched.set(id, { source, analyser, buf: new Float32Array(analyser.fftSize), lastLoud: 0 });
        timer ||= setInterval(tick, everyMs);
      } catch { /* no level for this one */ }
    },
    unwatch(id) {
      const w = watched.get(id);
      if (!w) return;
      try { w.source.disconnect(); } catch { /* gone */ }
      watched.delete(id);
    },
    /** Call from a click: browsers start audio only after the person does something on the page. */
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); },
    get talking() { return new Set(talking); },
    close() {
      clearInterval(timer); timer = null;
      for (const id of [...watched.keys()]) this.unwatch(id);
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    },
  };
}
