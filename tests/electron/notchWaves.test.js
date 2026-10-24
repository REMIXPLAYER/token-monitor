'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createNotchWaves } = require('../../src/electron/renderer/notch/waves');

function fixture(t, { missing = false, reduced = false, clipped = false, pageHasWave = true, metaClipped = false } = {}) {
  let time = 1000, next = 0, ready = true, stateListener;
  const frames = new Map(), timers = new Map(), listeners = new Map(), classes = new Set(), sent = [], replies = [];
  const rect = (x, y, width, height) => ({ left: x, top: y, width, height, right: x + width, bottom: y + height });
  const animation = { currentTime: 100 };
  const bar = { getBoundingClientRect: () => rect(10, 10, 2, 10), getAnimations: () => [animation] };
  const list = { getBoundingClientRect: () => rect(-10, -10, 100, 100) };
  const meta = { getBoundingClientRect: () => metaClipped ? rect(10, 14, 15, 4)
    : clipped ? rect(90, 10, 15, 10) : rect(0, 0, 80, 70) };
  const wave = { getBoundingClientRect: () => rect(clipped ? 90 : 10, 10, 15, 10), checkVisibility: () => true,
    closest: selector => selector.includes('meta') ? meta : list,
    querySelector: () => bar, querySelectorAll: () => [bar] };
  const page = { querySelectorAll: () => pageHasWave ? [wave] : [], getAnimations: () => [] };
  const body = { getBoundingClientRect: () => rect(0, 0, 80, 70), getAnimations: () => [] };
  const panel = {};
  const root = { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
    toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
  querySelectorAll: () => [wave], querySelector: selector => ({ '.notch-page.is-selected': page, '.notch-body': body, '.notch-panel': panel })[selector],
  addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const window = { performance: { now: () => time }, innerWidth: 200, innerHeight: 100,
    requestAnimationFrame: fn => { frames.set(++next, fn); return next; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    getComputedStyle(node) {
      if (node === root) return { getPropertyValue: key => ({ '--notch-wave-cycle': '1.05s', '--notch-wave-min-scale': '.4', '--notch-wave-easing': 'cubic-bezier(.42,0,.58,1)' })[key] };
      if (node === body) return { opacity: '1', filter: 'blur(0px)' };
      if (node === panel) return { zoom: '1' };
      return { borderRadius: '2px', backgroundColor: 'rgb(255, 0, 0)', animationDelay: '-0.2s' };
    }
  };
  const bridge = { onWaveState: fn => { stateListener = fn; return () => { stateListener = null; }; } };
  if (!missing) bridge.reportWave = payload => {
    sent.push(payload);
    if (!payload.visible) return { ok: true };
    return new Promise(resolve => replies.push(resolve));
  };
  const coordinator = createNotchWaves({ window, root, bridge, isReady: () => ready, prefersReducedMotion: () => reduced });
  t.after(() => coordinator.dispose());
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  return { coordinator, classes, sent, timers, frames, page, body, wave, bar, meta, list,
    async frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); await flush(); },
    async reply(ack = { ok: true }) { replies.shift()?.(ack); await flush(); },
    async tick() { time += 2000; const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); await flush(); },
    async scroll() { listeners.get('scroll')(); await flush(); },
    async transition(name) { listeners.get(name)({ target: { matches: () => true } }); await flush(); },
    async state(value) { stateListener(value); await flush(); },
    async flush() { await flush(); },
    reduced(value) { reduced = value; coordinator.update(); }, ready(value) { ready = value; coordinator.update(); }
  };
}

test('native wave waits for ack, preserves CSS parameters and clip, and has no idle timer', async t => {
  const f = fixture(t);
  f.coordinator.update(); await f.frame();
  assert.equal(f.classes.has('has-native-wave'), false, 'CSS stays visible while IPC is pending');
  const payload = f.sent[0];
  assert.deepEqual(payload.motion, { cycle: 1.05, minScale: .4, timing: [.42, 0, .58, 1] });
  assert.deepEqual(payload.waves[0].clip, { x: 0, y: 0, width: 80, height: 70 });
  assert.equal(payload.waves[0].bars[0].delay, -.2, 'delay is read before animation:none resets it');
  await f.reply(); assert.equal(f.classes.has('has-native-wave'), true);
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
});

test('native waves preserve metadata overflow clipping inside the list and body', async t => {
  const f = fixture(t, { metaClipped: true });
  f.coordinator.update(); await f.frame();
  assert.deepEqual(f.sent[0].waves[0].clip, { x: 10, y: 14, width: 15, height: 4 });
});

test('a bar extending outside the wave box remains visible at the list edge', async t => {
  const f = fixture(t);
  f.list.getBoundingClientRect = () => ({ left: 0, top: 21, right: 80, bottom: 70 });
  f.meta.getBoundingClientRect = () => ({ left: 10, top: 8.5, right: 25, bottom: 21.5 });
  f.bar.getBoundingClientRect = () => ({ left: 10, top: 7.5, width: 2, height: 15 });
  f.coordinator.update(); await f.frame();
  assert.equal(f.sent[0].waves.length, 1);
  assert.deepEqual(f.sent[0].waves[0].clip, { x: 10, y: 21, width: 15, height: .5 });
});

for (const { name, options } of [
  { name: 'all selected-page waves are outside the clip', options: { clipped: true } },
  { name: 'selected page has no wave while a hidden CSS wave remains', options: { pageHasWave: false } }
]) {
  test(`empty visible wave set still acknowledges when ${name}`, async t => {
    const f = fixture(t, options);
    f.coordinator.update(); await f.frame();
    assert.deepEqual(f.sent.map(payload => payload.waves), [[]],
      'an empty selected-page wave set must still reach the native overlay');
    await f.reply();
    assert.equal(f.classes.has('has-native-wave'), true,
      'the successful empty update must stop CSS waves elsewhere in the document');
  });
}

test('unsupported bridge, reduced motion and moving shell retain CSS without invoking native', async t => {
  for (const options of [{ missing: true }, { reduced: true }]) {
    const f = fixture(t, options); f.coordinator.update(); await f.frame();
    assert.equal(f.classes.has('has-native-wave'), false); assert.equal(f.sent.length, 0);
  }
  const f = fixture(t); f.ready(false); await f.frame(); assert.equal(f.sent.length, 0);
  f.ready(true); await f.frame(); await f.reply();
  f.reduced(true); await f.flush(); assert.equal(f.classes.has('has-native-wave'), false);
  assert.equal(f.sent.at(-1).visible, false);
});

test('native rejection and timeout keep CSS and stop retries', async t => {
  for (const timeout of [false, true]) {
    const f = fixture(t); f.coordinator.update(); await f.frame();
    if (timeout) await f.tick(); else await f.reply({ ok: false });
    assert.equal(f.classes.has('has-native-wave'), false);
    assert.equal(f.sent.at(-1).disable, true);
    const count = f.sent.length;
    f.coordinator.update(); await f.frame(); assert.equal(f.sent.length, count);
    if (timeout) { await f.reply(); assert.equal(f.classes.has('has-native-wave'), false, 'late ack cannot hide CSS'); }
  }
});

test('scroll invalidates pending activation; native resumes only after scrolling settles', async t => {
  const f = fixture(t); f.coordinator.update(); await f.frame();
  await f.scroll(); await f.reply();
  assert.equal(f.classes.has('has-native-wave'), false);
  assert.equal(f.sent.at(-1).visible, false);
  f.coordinator.update(); await f.frame();
  assert.equal(f.sent.filter(p => p.visible).length, 1);
  await f.tick(); await f.frame(); await f.reply();
  assert.equal(f.classes.has('has-native-wave'), true);
});

test('updates during an acknowledgement wait send only the latest geometry next', async t => {
  const f = fixture(t); f.coordinator.update(); await f.frame();
  for (const x of [20, 30, 40]) {
    f.bar.getBoundingClientRect = () => ({ left: x, top: 10, width: 2, height: 10 });
    f.coordinator.update();
  }
  assert.equal(f.frames.size, 0);
  await f.reply();
  assert.equal(f.classes.has('has-native-wave'), false, 'the old acknowledgement cannot hide CSS');
  await f.frame();
  const visible = f.sent.filter(p => p.visible);
  assert.equal(visible.length, 2);
  assert.equal(visible[1].waves[0].bars[0].x, 40);
  await f.reply();
  assert.equal(f.classes.has('has-native-wave'), true);
});

test('disposing while an acknowledgement is pending hides native and ignores the reply', async t => {
  const f = fixture(t); f.coordinator.update(); await f.frame();
  f.coordinator.dispose(); await f.flush();
  assert.equal(f.sent.at(-1).visible, false);
  await f.reply();
  assert.equal(f.classes.has('has-native-wave'), false);
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

test('window suppression, failure notification and page disposal restore CSS and stop native', async t => {
  const f = fixture(t); f.coordinator.update(); await f.frame(); await f.reply();
  await f.state({ available: true, visible: false });
  assert.equal(f.classes.has('has-native-wave'), false); assert.equal(f.classes.has('is-wave-suppressed'), true);
  await f.state({ available: true, visible: true }); await f.frame(); await f.reply();
  assert.equal(f.classes.has('has-native-wave'), true);
  await f.state({ available: false, visible: true }); await f.frame();
  assert.equal(f.classes.has('has-native-wave'), false);
  f.coordinator.dispose(); assert.equal(f.frames.size, 0);
});

for (const event of ['transitionend', 'transitioncancel']) {
  test(`${event} resumes native waves after the page settles`, async t => {
    const f = fixture(t);
    f.coordinator.update(); await f.frame(); await f.reply();
    f.page.getAnimations = () => [{ playState: 'running' }];
    await f.transition('transitionrun'); await f.frame();
    assert.equal(f.classes.has('has-native-wave'), false);
    assert.equal(f.sent.filter(p => p.visible).length, 1);
    f.page.getAnimations = () => [];
    await f.transition(event); await f.frame();
    assert.equal(f.sent.filter(p => p.visible).length, 2);
    await f.reply({ ok: true, suppressed: true });
    assert.equal(f.classes.has('has-native-wave'), false);
  });
}
