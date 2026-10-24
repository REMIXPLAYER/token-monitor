'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function nativeHarness() {
  let next = 10;
  let failAnimation = false;
  const nodes = new Map();
  const animations = new Set();
  const allocate = () => { const id = next++; nodes.set(id, { parent: null, hidden: false }); return id; };
  const api = {
    cls: (name) => name, sel: (name) => name,
    boolean: (_target, selector) => selector === 'isMainThread',
    layer: allocate, string: allocate, timing: allocate, color: allocate, doubleObject: () => 1,
    object() { return failAnimation === 'nil' ? 0 : allocate(); },
    lookup(target, selector) {
      if (typeof target === 'bigint') target = Number(target);
      if (target === 1 && selector === 'window') return 2;
      if (target === 2 && selector === 'contentView') return 3;
      if (target === 3 && selector === 'layer') return 4;
      if (selector === 'superlayer') return nodes.get(target)?.parent || 0;
      return target;
    },
    getBounds: () => ({ origin: { x: 0, y: 0 }, size: { width: 200, height: 100 } }),
    currentMediaTime: () => 1,
    put(target, selector, value) { if (selector === 'setHidden:') nodes.get(target).hidden = !!value; },
    number() {}, floatNumber() {}, setRect() {}, setPoint() {},
    withoutAnimation(callback) { callback(); },
    addSublayer(parent, _selector, child) { nodes.get(child).parent = parent; },
    addAnimation(bar) { if (failAnimation === 'throw') throw new Error('injected animation failure'); animations.add(bar); },
    removeAnimation: bar => animations.delete(bar),
    release(target, selector) { if (selector === 'removeFromSuperlayer') nodes.get(target).parent = null; }
  };
  const module = { exports: {} };
  const nativeSource = fs.readFileSync(path.join(__dirname, '../../src/electron/notch/waveOverlay.js'), 'utf8');
  vm.runInNewContext(nativeSource.replace('let cachedApi;', 'let cachedApi = injectedApi;'), {
    module, injectedApi: api, Buffer, process: { platform: 'darwin', arch: 'arm64' }, console: { log() {} }
  });
  const win = { getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]) };
  return { overlay: module.exports.createWaveOverlay(win), animations, nodes,
    failAnimation: value => { failAnimation = value; } };
}
const payload = () => ({ visible: true, motion: { cycle: 1.05, minScale: .4, timing: [.42, 0, .58, 1] },
  waves: [{ clip: { x: 0, y: 0, width: 100, height: 80 }, bars: [
    { x: 10, y: 10, width: 2, height: 10, radius: 1, color: [1, 0, 0, 1], delay: -.2, phase: .1 }
  ] }] });

test('native wave reuses layers, stops removed waves, and detaches on dispose', () => {
  const f = nativeHarness(), p = payload();
  p.waves.push(structuredClone(p.waves[0]));
  f.overlay.update(p); assert.equal(f.animations.size, 2);
  p.waves.pop(); f.overlay.update(p); assert.equal(f.animations.size, 1);
  f.overlay.update({ visible: false }); assert.equal(f.animations.size, 0);
  f.overlay.dispose(); f.overlay.dispose();
  assert.equal([...f.nodes.values()].filter(node => node.parent === 4).length, 0);
});

test('invalid native geometry and excessive counts fail before adding animations', () => {
  for (const change of [p => { p.waves[0].bars[0].x = NaN; }, p => { p.waves[0].bars[0].height = -1; },
    p => { p.motion.cycle = Infinity; }, p => { p.waves = Array(33).fill(p.waves[0]); },
    p => { p.waves[0].bars = Array(9).fill(p.waves[0].bars[0]); }]) {
    const f = nativeHarness(), p = payload(); change(p);
    assert.throws(() => f.overlay.update(p)); assert.equal(f.animations.size, 0); f.overlay.dispose();
  }
});

test('nil native animation fails for the controller to restore CSS', () => {
  const f = nativeHarness(); f.failAnimation('nil');
  assert.throws(() => f.overlay.update(payload()), /CABasicAnimation unavailable/);
  f.overlay.dispose(); assert.equal(f.animations.size, 0);
});

test('Windows and Linux never load the macOS wave bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/notch/waveOverlay.js'), 'utf8');
  for (const platform of ['win32', 'linux']) {
    const module = { exports: {} };
    vm.runInNewContext(source, { module, process: { platform, arch: 'x64' },
      require: () => assert.fail('Non-macOS must not load Koffi or native libraries') });
    assert.throws(() => module.exports.createWaveOverlay({}), /wave overlay unavailable/);
  }
});
