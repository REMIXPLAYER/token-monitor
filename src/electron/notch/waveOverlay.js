'use strict';

// A CALayer wave overlay above Chromium's content view. Each wave
// gets a clipping group (the active list or panel body), so a partially scrolled
// wave stays native and is clipped exactly like the CSS list. CA owns the
// animation; Chromium does not present the window per frame.

const MAX_WAVES = 32;
const MAX_BARS = 8;
const KEY = 'wave';

let cachedApi;

function loadApi() {
  if (cachedApi !== undefined) return cachedApi;
  cachedApi = null;
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) return null;
  const koffi = require('koffi');
  const quartz = koffi.load('/System/Library/Frameworks/QuartzCore.framework/QuartzCore');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cls = objc.func('objc_getClass', 'uintptr_t', ['str']);
  const sel = objc.func('sel_registerName', 'uintptr_t', ['str']);
  const point = koffi.struct('TokenMonitorWavePoint', { x: 'double', y: 'double' });
  const size = koffi.struct('TokenMonitorWaveSize', { width: 'double', height: 'double' });
  const rect = koffi.struct('TokenMonitorWaveRect', { origin: point, size });
  const get = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
  const release = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t']);
  const put = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const boolean = objc.func('objc_msgSend', 'bool', ['uintptr_t', 'uintptr_t']);
  const number = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'double']);
  const floatNumber = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'float']);
  const setRect = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', rect]);
  const setPoint = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', point]);
  const color = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'double', 'double', 'double', 'double']);
  const string = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'str']);
  const object = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const doubleObject = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'double']);
  const addSublayer = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const addAnimation = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t']);
  const removeAnimation = objc.func('objc_msgSend', 'void', ['uintptr_t', 'uintptr_t', 'uintptr_t']);
  const timing = objc.func('objc_msgSend', 'uintptr_t', ['uintptr_t', 'uintptr_t', 'float', 'float', 'float', 'float']);
  const frame = process.arch === 'x64'
    ? objc.func('objc_msgSend_stret', 'void', [koffi.out(koffi.pointer(rect)), 'uintptr_t', 'uintptr_t'])
    : objc.func('objc_msgSend', rect, ['uintptr_t', 'uintptr_t']);
  const currentMediaTime = quartz.func('CACurrentMediaTime', 'double', []);
  for (const name of ['CALayer', 'CABasicAnimation', 'CAMediaTimingFunction', 'CATransaction', 'NSThread', 'NSString', 'NSNumber', 'NSColor']) {
    if (!cls(name)) throw new Error(`${name} unavailable`);
  }
  function getBounds(view) {
    if (process.arch !== 'x64') return frame(view, sel('bounds'));
    const result = {};
    frame(result, view, sel('bounds'));
    return result;
  }
  cachedApi = {
    cls, sel, get, release, boolean, setRect, setPoint, color, string, object, doubleObject,
    addSublayer, addAnimation, removeAnimation, timing, getBounds, currentMediaTime,
    put: (target, name, value) => put(target, sel(name), value),
    number: (target, name, value) => number(target, sel(name), value),
    floatNumber: (target, name, value) => floatNumber(target, sel(name), value),
    lookup: (target, name) => get(target, sel(name)),
    layer: (name) => get(cls(name), sel('layer')),
    withoutAnimation(callback) {
      const transaction = cls('CATransaction');
      release(transaction, sel('begin'));
      try { put(transaction, sel('setDisableActions:'), 1); callback(); }
      finally { release(transaction, sel('commit')); }
    }
  };
  return cachedApi;
}

// Reject the whole update rather than hiding CSS for only a subset of waves.
// Invalid geometry must never reach Objective-C: native exceptions bypass JS.
function number(value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('Invalid wave geometry');
  return value;
}
function sanitize(payload, contentWidth, contentHeight) {
  if (payload?.visible !== true) return { visible: false, waves: [] };
  const source = payload.waves;
  if (!Array.isArray(source) || source.length > MAX_WAVES) throw new Error('Invalid wave count');
  const motion = {
    cycle: number(payload.motion?.cycle, 0.1, 10),
    minScale: number(payload.motion?.minScale, 0, 1),
    timing: payload.motion?.timing
  };
  if (!Array.isArray(motion.timing) || motion.timing.length !== 4) throw new Error('Invalid wave timing');
  motion.timing = motion.timing.map(value => number(value, 0, 1));
  number(contentWidth, 1, 100000); number(contentHeight, 1, 100000);
  const waves = source.map(wave => {
    const c = wave?.clip;
    const x = number(c?.x, 0, contentWidth), y = number(c?.y, 0, contentHeight);
    const clip = { x, y, width: Math.min(number(c?.width, 0.001, 10000), contentWidth - x),
      height: Math.min(number(c?.height, 0.001, 10000), contentHeight - y) };
    if (!(clip.width > 0 && clip.height > 0)) throw new Error('Empty wave clip');
    if (!Array.isArray(wave.bars) || !wave.bars.length || wave.bars.length > MAX_BARS) throw new Error('Invalid bar count');
    const bars = wave.bars.map(item => {
      const width = number(item.width, 0.001, 10000), height = number(item.height, 0.001, 10000);
      if (!Array.isArray(item.color) || item.color.length !== 4) throw new Error('Invalid wave color');
      const phase = number(item.phase, -100000, 100000);
      return { x: number(item.x, -100000, 100000), y: number(item.y, -100000, 100000), width, height,
        radius: Math.min(number(item.radius, 0, 10000), width / 2, height / 2),
        color: item.color.map(value => number(value, 0, 1)), delay: number(item.delay, -10, 10),
        phase: ((phase % motion.cycle) + motion.cycle) % motion.cycle };
    });
    return { clip, bars };
  });
  return { visible: true, waves, motion };
}

function createWaveOverlay(win) {
  const api = loadApi();
  if (!api) throw new Error('wave overlay unavailable');
  if (!api.boolean(api.cls('NSThread'), api.sel('isMainThread'))) throw new Error('AppKit requires the main thread');
  const handle = win.getNativeWindowHandle();
  const view = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  const window = api.lookup(view, 'window');
  const content = window && api.lookup(window, 'contentView');
  if (!content) throw new Error('Window content view unavailable');
  let layer = api.lookup(content, 'layer');
  if (!layer) {
    api.put(content, 'setWantsLayer:', 1);
    layer = api.lookup(content, 'layer');
  }
  if (!layer) throw new Error('Content view has no layer');
  const flipped = api.boolean(content, api.sel('isFlipped'));
  const layerFlipped = api.boolean(layer, api.sel('isGeometryFlipped'));
  let container = null, key = null, path = null, disposed = false;
  const groups = [], owned = [];
  function hold(value) {
    if (!value) throw new Error('Native wave resource unavailable');
    api.lookup(value, 'retain'); owned.push(value);
    return value;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    try { if (container) api.put(container, 'setHidden:', 1); } catch {}
    try { stopAnimations(); } catch {}
    try { if (container) api.release(container, api.sel('removeFromSuperlayer')); } catch {}
    for (const value of owned.reverse()) {
      try { api.release(value, api.sel('release')); } catch {}
    }
  }
  try {
    container = hold(api.layer('CALayer'));
    key = hold(api.string(api.cls('NSString'), api.sel('stringWithUTF8String:'), KEY));
    path = hold(api.string(api.cls('NSString'), api.sel('stringWithUTF8String:'), 'transform.scale.y'));
    const bounds = api.getBounds(content);
    number(bounds.size.width, 1, 100000); number(bounds.size.height, 1, 100000);
    api.withoutAnimation(() => {
      api.setRect(container, api.sel('setFrame:'), { origin: { x: 0, y: 0 }, size: bounds.size });
      api.put(container, 'setMasksToBounds:', 0);
      api.number(container, 'setZPosition:', 10000);
      api.addSublayer(layer, api.sel('addSublayer:'), container);
    });
  } catch (error) { dispose(); throw error; }

  function stopAnimations() {
    for (const group of groups) for (const bar of group.bars) api.removeAnimation(bar, api.sel('removeAnimationForKey:'), key);
  }
  function ensureGroups(count) {
    while (groups.length < count) {
      const group = hold(api.layer('CALayer'));
      api.put(group, 'setMasksToBounds:', 1);
      api.addSublayer(container, api.sel('addSublayer:'), group);
      groups.push({ layer: group, bars: [] });
    }
  }
  function ensureBars(group, count) {
    while (group.bars.length < count) {
      const bar = hold(api.layer('CALayer'));
      api.setPoint(bar, api.sel('setAnchorPoint:'), { x: 0.5, y: 0.5 });
      api.addSublayer(group.layer, api.sel('addSublayer:'), bar);
      group.bars.push(bar);
    }
  }

  return {
    update(payload) {
      if (disposed) return;
      const contentBounds = api.getBounds(content);
      const width = contentBounds.size.width;
      const height = contentBounds.size.height;
      const state = sanitize(payload, width, height);
      if (!state.visible || !state.waves.length) {
        stopAnimations();
        api.put(container, 'setHidden:', 1);
        return;
      }
      if (api.lookup(container, 'superlayer') !== layer) api.addSublayer(layer, api.sel('addSublayer:'), container);
      ensureGroups(state.waves.length);
      const now = api.currentMediaTime();
      api.withoutAnimation(() => {
        api.setRect(container, api.sel('setFrame:'), { origin: { x: 0, y: 0 }, size: { width, height } });
        for (let index = 0; index < groups.length; index += 1) {
          const group = groups[index];
          const wave = state.waves[index];
          if (!wave) {
            api.put(group.layer, 'setHidden:', 1);
            for (const bar of group.bars) api.removeAnimation(bar, api.sel('removeAnimationForKey:'), key);
            continue;
          }
          const { clip } = wave;
          const originY = layerFlipped || flipped ? clip.y : height - (clip.y + clip.height);
          api.setRect(group.layer, api.sel('setFrame:'), { origin: { x: clip.x, y: originY }, size: { width: clip.width, height: clip.height } });
          api.put(group.layer, 'setHidden:', 0);
          ensureBars(group, wave.bars.length);
          for (let barIndex = 0; barIndex < group.bars.length; barIndex += 1) {
            const bar = group.bars[barIndex];
            const item = wave.bars[barIndex];
            if (!item) {
              api.put(bar, 'setHidden:', 1);
              api.removeAnimation(bar, api.sel('removeAnimationForKey:'), key);
              continue;
            }
            const x = item.x - clip.x;
            const top = item.y - clip.y;
            const y = layerFlipped || flipped ? top : clip.height - (top + item.height);
            api.setRect(bar, api.sel('setBounds:'), { origin: { x: 0, y: 0 }, size: { width: item.width, height: item.height } });
            api.setPoint(bar, api.sel('setPosition:'), { x: x + item.width / 2, y: y + item.height / 2 });
            api.put(bar, 'setHidden:', 0);
            api.number(bar, 'setCornerRadius:', item.radius);
            const [r, g, b, a] = item.color;
            const nsColor = api.color(api.cls('NSColor'), api.sel('colorWithSRGBRed:green:blue:alpha:'), r, g, b, a);
            api.put(bar, 'setBackgroundColor:', api.lookup(nsColor, 'CGColor'));
          }
        }
        api.put(container, 'setHidden:', 0);
      });
      const timingFunction = api.timing(api.cls('CAMediaTimingFunction'), api.sel('functionWithControlPoints::::'), ...state.motion.timing);
      if (!timingFunction) throw new Error('Animation timing unavailable');
      for (let groupIndex = 0; groupIndex < state.waves.length; groupIndex += 1) {
        const group = groups[groupIndex];
        const wave = state.waves[groupIndex];
        for (let barIndex = 0; barIndex < wave.bars.length; barIndex += 1) {
          const item = wave.bars[barIndex];
          const bar = group.bars[barIndex];
          const animation = api.object(api.cls('CABasicAnimation'), api.sel('animationWithKeyPath:'), path);
          if (!animation) throw new Error('CABasicAnimation unavailable');
          api.put(animation, 'setFromValue:', api.doubleObject(api.cls('NSNumber'), api.sel('numberWithDouble:'), 1));
          api.put(animation, 'setToValue:', api.doubleObject(api.cls('NSNumber'), api.sel('numberWithDouble:'), state.motion.minScale));
          api.number(animation, 'setDuration:', state.motion.cycle / 2);
          api.put(animation, 'setAutoreverses:', 1);
          api.floatNumber(animation, 'setRepeatCount:', 1e9);
          api.put(animation, 'setTimingFunction:', timingFunction);
          api.number(animation, 'setBeginTime:', now + item.delay - item.phase);
          api.addAnimation(bar, api.sel('addAnimation:forKey:'), animation, key);
        }
      }
    },
    dispose
  };
}

module.exports = { createWaveOverlay };
