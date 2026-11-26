// Animations Coordinator: subscribes to settings + bus events and dispatches active animations.
import { bus } from '../../core/bus.js';
import { appState } from '../../core/state.js';
import { loadSettings, onSettings } from '../../core/settings.js';
import { listenTauri } from '../../core/tauri.js';
import { registerAnimation, getAnimation, type AnimationCategoryKey, type AnimationModule } from './registry.js';
import { getAnimConfig, cleanupAllAnimations, cleanupChannel } from './engine.js';

import { trayBounce } from './tray/bounce.js';
import { receiveRadar } from './receive/radar.js';
import { sendBeam } from './send/beam.js';
import { sendTrace } from './send/trace.js';

registerAnimation(trayBounce);
registerAnimation(receiveRadar);
registerAnimation(sendBeam);
registerAnimation(sendTrace);

let _lastProgTs = 0;
const _demoHandles: Record<AnimationCategoryKey, Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>> = {
  tray: [],
  receive: [],
  send: []
};
let _activeSendDemo: { id: string; anim: AnimationModule; tok: number } | null = null;
let _sendDemoToken = 0;

function clearDemoChannel(cat: AnimationCategoryKey): void {
  const list = _demoHandles[cat];
  if (list) {
    while (list.length) {
      const h = list.pop();
      if (h !== undefined) {
        clearTimeout(h as ReturnType<typeof setTimeout>);
        clearInterval(h as ReturnType<typeof setInterval>);
      }
    }
  }
  if (cat === 'send' && _activeSendDemo) {
    const prevAnim = _activeSendDemo.anim;
    _activeSendDemo = null;
    _sendDemoToken++;
    prevAnim?.onFinish?.(false);
    if (appState.transferring) {
      bus.emit('transfer:finish', { ok: false });
    }
  }
}

function activeTrayAnim(): AnimationModule | null {
  const c = getAnimConfig();
  if (!c.enabled || !c.tray?.enabled) return null;
  return getAnimation('tray', c.tray.id || 'bounce');
}

function activeReceiveAnim(forIncoming = false): AnimationModule | null {
  const c = getAnimConfig();
  if (!c.enabled || !c.receive?.enabled) return null;
  if (forIncoming && (c.receive.id || 'radar') === 'notch') return null;
  return getAnimation('receive', 'radar');
}

function activeSendAnim(): AnimationModule | null {
  if (_activeSendDemo?.anim) return _activeSendDemo.anim;
  const c = getAnimConfig();
  if (!c.enabled || !c.send?.enabled) return null;
  return getAnimation('send', c.send.id || 'beam');
}

export function playAnimationDemo(category: AnimationCategoryKey, id?: string): void {
  clearDemoChannel(category);
  if (category === 'tray') {
    const a = getAnimation('tray', id || 'bounce');
    const SET = loadSettings();
    a?.play?.({ menuLayout: SET.appearance?.menuLayout || 'deck', addedPaths: [] });
    return;
  }
  if (category === 'receive') {
    const a = getAnimation('receive', 'radar');
    if (!a) return;

    const runRecvStream = (): void => {
      clearDemoChannel('receive');
      a.onAccepted?.({ fileName: 'Report_final.pdf', sizeText: '14.2 MB', sender: 'Nearby PC', demo: true });
      const t2 = setTimeout(() => a.onProgress?.(65), 750);
      const t3 = setTimeout(() => a.onFinish?.(true), 2150);
      _demoHandles.receive.push(t2, t3);
    };

    let handled = false;
    a.onIncoming?.({
      fileName: 'Report_final.pdf',
      sizeText: '14.2 MB',
      sender: 'Nearby PC',
      demo: true,
      onAccept: () => {
        if (handled) return;
        handled = true;
        runRecvStream();
      },
      onDecline: () => {
        if (handled) return;
        handled = true;
        clearDemoChannel('receive');
        a.onOfferClosed?.();
      }
    });
    const tPress = setTimeout(() => {
      if (!handled) document.getElementById('anim-rc-accept')?.classList.add('is-pressed');
    }, 10250);
    const tAuto = setTimeout(() => {
      if (!handled) {
        handled = true;
        runRecvStream();
      }
    }, 10500);
    _demoHandles.receive.push(tPress, tAuto);
    return;
  }
  if (category === 'send') {
    const a = getAnimation('send', id || 'beam');
    if (!a) return;
    const tok = ++_sendDemoToken;
    _activeSendDemo = { id: id || 'beam', anim: a, tok };
    clearTimeout(appState.toastTimer as ReturnType<typeof setTimeout> | undefined);
    appState.toast = false;
    appState.prompting = false;
    appState.lockerPrompting = false;
    appState.xferDir = 'send';
    bus.emit('transfer:start', { dir: 'send' });
    bus.emit('transfer:progress', { pct: 0, speed: '', name: 'Sending files...' });

    let p = 0;
    const t = setInterval(() => {
      if (!_activeSendDemo || _activeSendDemo.tok !== tok) {
        clearInterval(t);
        return;
      }
      p = Math.min(100, p + 12);
      bus.emit('transfer:progress', { pct: p, speed: p < 100 ? '48 MB/s' : '', name: 'Sending files...' });
      if (p >= 100) {
        clearInterval(t);
        const tDone = setTimeout(() => {
          if (!_activeSendDemo || _activeSendDemo.tok !== tok) return;
          bus.emit('transfer:finish', { ok: true });
        }, 520);
        _demoHandles.send.push(tDone);
      }
    }, 170);
    _demoHandles.send.push(t);
  }
}

export function initAnimations(): void {
  onSettings((next) => {
    const c = next?.animations;
    if (!c || !c.enabled) {
      if (!_activeSendDemo) cleanupAllAnimations();
      return;
    }
    if (!c.tray?.enabled) cleanupChannel('tray');
    if (!c.receive?.enabled) cleanupChannel('receive');
    if (!c.send?.enabled && !_activeSendDemo) cleanupChannel('send');
  });

  bus.on<string>('view:change', (viewId) => {
    if (viewId && viewId !== 'view-compact') {
      cleanupChannel('receive');
    }
  });

  bus.on<Record<string, unknown>>('anim:tray-drop', (payload) => {
    activeTrayAnim()?.play?.(payload || {});
  });

  bus.on<Record<string, unknown>>('anim:incoming', (payload) => {
    clearDemoChannel('receive');
    activeReceiveAnim(true)?.onIncoming?.(payload || {});
  });

  bus.on('anim:offer-closed', () => {
    clearDemoChannel('receive');
    activeReceiveAnim()?.onOfferClosed?.();
  });

  bus.on<Record<string, unknown>>('anim:accepted', (payload) => {
    clearDemoChannel('receive');
    activeReceiveAnim()?.onAccepted?.(payload || {});
  });

  bus.on<{ dir?: string; name?: string }>('transfer:start', (payload) => {
    clearDemoChannel('receive');
    const dir = (payload && payload.dir) || (appState.xferDir as string) || 'send';
    activeSendAnim()?.onStart?.({ dir, pct: 0 });
    if (dir === 'recv') {
      const rAnim = activeReceiveAnim();
      if (rAnim && !rAnim.isStreaming?.()) {
        rAnim.onAccepted?.({ fileName: payload?.name || 'Incoming file', sender: 'Nearby PC' });
      }
    }
  });

  bus.on<{ pct?: number }>('transfer:progress', (payload) => {
    const now = performance.now();
    const pct = Number(payload?.pct) || 0;
    if (pct < 100 && pct > 0 && now - _lastProgTs < 100) return;
    _lastProgTs = now;
    const dir = (appState.xferDir as string) || 'send';
    activeSendAnim()?.onProgress?.(pct, dir);
    activeReceiveAnim()?.onProgress?.(pct);
  });

  bus.on<{ ok?: boolean }>('transfer:finish', (payload) => {
    const ok = payload?.ok !== false;
    const sAnim = activeSendAnim();
    if (_activeSendDemo) _activeSendDemo = null;
    sAnim?.onFinish?.(ok);
    activeReceiveAnim()?.onFinish?.(ok);
  });

  listenTauri<{ category?: AnimationCategoryKey; id?: string }>('animation-demo', (event) => {
    const p = (event && event.payload) || (event as unknown as { category?: AnimationCategoryKey; id?: string });
    if (p && p.category) playAnimationDemo(p.category, p.id);
  });
}
