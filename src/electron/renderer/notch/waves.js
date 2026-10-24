'use strict';

(function exposeNotchWaves(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorNotchWaves = api;
})(typeof window !== 'undefined' ? window : null, () => {
  function createNotchWaves({ window, root, bridge, prefersReducedMotion, isReady }) {
    let available = typeof bridge.reportWave === 'function', visible = true, disposed = false;
    let requested = false, pending = false, dirty = false, generation = 0, frame = 0, scrollTimer = 0;
    let cycle = 1.05;
    const epochs = new WeakMap();
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const now = () => window.performance.now();
    const phase = wave => Math.max(0, (now() - (epochs.get(wave) ?? now())) / 1000) % cycle;
    const send = payload => Promise.resolve().then(() => bridge.reportWave(payload));
    const seconds = value => parseFloat(value) / (String(value).trim().endsWith('ms') ? 1000 : 1);

    function restoreCss() {
      root.classList.remove('has-native-wave');
      for (const wave of root.querySelectorAll('.notch-wave')) {
        if (!epochs.has(wave)) continue;
        const time = phase(wave) * 1000;
        for (const bar of wave.querySelectorAll('i')) {
          for (const animation of bar.getAnimations()) animation.currentTime = time;
        }
      }
    }
    function fail() {
      available = false;
      generation++;
      requested = false;
      restoreCss();
      // Also latch the main-side failure: a late invocation must not leave a
      // native wave above CSS after a renderer timeout or measurement failure.
      send({ visible: false, disable: true }).catch(() => {});
    }
    function suspend() {
      generation++;
      window.cancelAnimationFrame(frame); frame = 0;
      if (requested) {
        requested = false;
        send({ visible: false }).then(ack => { if (!disposed && !ack?.ok) fail(); }, () => { if (!disposed) fail(); });
      }
      if (root.classList.contains('has-native-wave')) restoreCss();
    }
    function schedule() {
      if (disposed || !available || !visible || frame || pending) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (dirty) refresh();
      });
    }
    function update() {
      suspend();
      dirty = true;
      schedule();
    }

    function color(value) {
      let parts;
      if (/^rgba?\(/.test(value)) {
        parts = value.match(/[\d.]+/g).map(Number);
        return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts[3] ?? 1];
      }
      if (/^color\(srgb /.test(value)) {
        parts = value.match(/-?[\d.]+/g).map(Number);
        return [parts[0], parts[1], parts[2], parts[3] ?? 1].map(v => Math.max(0, Math.min(1, v)));
      }
      throw new Error('Unsupported wave color');
    }
    function clipFor(wave, body) {
      const bounds = [body, wave.closest('.notch-active-list, .notch-recent-list'),
        wave.closest('.notch-active-meta, .notch-now-meta')].filter(Boolean).map(node => node.getBoundingClientRect());
      const x = Math.max(0, ...bounds.map(b => b.left)), y = Math.max(0, ...bounds.map(b => b.top));
      const right = Math.min(window.innerWidth, ...bounds.map(b => b.right)), bottom = Math.min(window.innerHeight, ...bounds.map(b => b.bottom));
      return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
    }
    function collect() {
      const page = root.querySelector('.notch-page.is-selected'), body = root.querySelector('.notch-body');
      if (!page || !body) return null;
      // The transition end/cancel events below remeasure once the page settles.
      if (page.getAnimations().some(a => a.playState !== 'finished')) return null;
      const bodyStyle = window.getComputedStyle(body);
      if (Number(bodyStyle.opacity) < 0.995 || bodyStyle.filter !== 'none' && !/^blur\(0(px)?\)$/.test(bodyStyle.filter)) return null;
      const style = window.getComputedStyle(root);
      cycle = seconds(style.getPropertyValue('--notch-wave-cycle'));
      const timing = style.getPropertyValue('--notch-wave-easing').match(/-?[\d.]+/g)?.map(Number);
      const motion = { cycle, minScale: Number(style.getPropertyValue('--notch-wave-min-scale')), timing };
      const zoom = Number(window.getComputedStyle(root.querySelector('.notch-panel')).zoom) || 1;
      const found = [];
      for (const wave of page.querySelectorAll('.notch-wave')) {
        // Bars extend beyond the 10px wave box; clip their ink against the ancestors.
        const clip = clipFor(wave, body);
        if (!clip || !wave.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        if (!epochs.has(wave)) {
          const time = wave.querySelector('i')?.getAnimations()[0]?.currentTime;
          epochs.set(wave, now() - (Number.isFinite(time) ? time : 0));
        }
        found.push({ wave, clip, phase: phase(wave), bars: [...wave.querySelectorAll('i')].map(bar => {
          const s = window.getComputedStyle(bar);
          return { node: bar, radius: parseFloat(s.borderRadius) * zoom, color: color(s.backgroundColor), delay: seconds(s.animationDelay) };
        }) });
      }
      // This temporary class is removed before awaiting IPC. It gives base
      // geometry without the animated scale; gBCR already includes CSS zoom.
      root.classList.add('has-native-wave');
      const waves = found.map(item => ({ clip: item.clip, bars: item.bars.map(bar => {
        const rect = bar.node.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
          radius: bar.radius, color: bar.color, delay: bar.delay, phase: item.phase };
      }) }));
      return { visible: true, motion, waves };
    }
    async function refresh() {
      if (!available || !visible || scrollTimer || !isReady() || prefersReducedMotion() || disposed) return;
      dirty = false;
      const gen = generation;
      let timeout;
      try {
        const payload = collect();
        restoreCss();
        if (!payload) return;
        requested = pending = true;
        const ack = await Promise.race([
          send(payload),
          new Promise((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Native wave timeout')), 1500); })
        ]);
        if (disposed || gen !== generation) return;
        if (!ack?.ok) { fail(); return; }
        if (!ack.suppressed) root.classList.add('has-native-wave');
      } catch {
        if (!disposed) fail();
      } finally {
        window.clearTimeout(timeout);
        pending = false;
        if (dirty) schedule();
      }
    }

    function scrolled() {
      suspend();
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => { scrollTimer = 0; update(); }, 120);
    }
    function transitionStarted(event) {
      if (event.target.matches('.notch-page')) update();
    }
    root.addEventListener('scroll', scrolled, true);
    root.addEventListener('transitionrun', transitionStarted, true);
    root.addEventListener('transitionend', transitionStarted, true);
    root.addEventListener('transitioncancel', transitionStarted, true);
    window.addEventListener('resize', update);
    media.addEventListener('change', update);
    const unsubscribe = bridge.onWaveState?.(state => {
      available = available && state?.available === true;
      visible = state?.visible === true;
      root.classList.toggle('is-wave-suppressed', !visible);
      update();
    });
    function dispose() {
      if (disposed) return;
      disposed = true;
      suspend();
      window.clearTimeout(scrollTimer);
      unsubscribe?.();
      root.removeEventListener('scroll', scrolled, true);
      for (const name of ['transitionrun', 'transitionend', 'transitioncancel']) root.removeEventListener(name, transitionStarted, true);
      window.removeEventListener('resize', update);
      media.removeEventListener('change', update);
    }
    window.addEventListener('pagehide', dispose, { once: true });
    return { update, dispose };
  }
  return { createNotchWaves };
});
