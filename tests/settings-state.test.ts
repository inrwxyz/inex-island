import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../src/js/core/bus.js';
import { appState, setAppState } from '../src/js/core/state.js';
import { ensureDefaults, esc, getPath, setPath } from '../src/js/settings/state.js';
import { shouldActivateVisualizer } from '../src/js/features/equalizer/index.js';

describe('core bus, appState, and settings helpers', () => {
  beforeEach(() => {
    setAppState('currentView', 'view-compact');
    setAppState('volOpen', false);
  });

  it('delivers and unsubscribes EventBus listeners cleanly', () => {
    const seen: number[] = [];
    const onceSeen: string[] = [];
    const off = bus.on<number>('test:num', (n) => seen.push(n));
    bus.once<string>('test:once', (s) => onceSeen.push(s));

    bus.emit('test:num', 1);
    bus.emit('test:num', 2);
    off();
    bus.emit('test:num', 3);

    bus.emit('test:once', 'first');
    bus.emit('test:once', 'second');

    expect(seen).toEqual([1, 2]);
    expect(onceSeen).toEqual(['first']);
  });

  it('emits state:change only when appState value actually changes', () => {
    const spy = vi.fn();
    const off = bus.on('state:change', spy);

    setAppState('volOpen', true);
    setAppState('volOpen', true);
    setAppState('volOpen', false);
    off();

    expect(appState.volOpen).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, { key: 'volOpen', value: true, oldValue: false });
  });

  it('escapes HTML meta-characters safely in settings renderer', () => {
    expect(esc('Tom & "Jerry" <script>')).toBe('Tom &amp; &quot;Jerry&quot; &lt;script>');
    expect(esc(null)).toBe('');
  });

  it('reads, writes, and ensures nested settings paths safely', () => {
    const target: Record<string, unknown> = {};
    setPath(target, 'appearance.scale', 125);
    expect(getPath(target, 'appearance.scale')).toBe(125);
    expect(getPath(target, 'missing.branch', 'fallback')).toBe('fallback');

    const ensured = ensureDefaults(null);
    expect(ensured.prayer.masjid).toEqual({ fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' });
  });

  it('activates 5-band visualizer only when playing, unhidden, and bars are visible', () => {
    const base = {
      mediaPlaying: true,
      musicMode: true,
      eqSync: true,
      compactMode: true,
      mediaCard: 'glass',
      currentView: 'view-compact',
      documentHidden: false,
      islandHidden: false,
      isBusy: false,
    };

    expect(shouldActivateVisualizer(base)).toBe(true);
    expect(shouldActivateVisualizer({ ...base, mediaPlaying: false })).toBe(false);
    expect(shouldActivateVisualizer({ ...base, islandHidden: true })).toBe(false);
    expect(shouldActivateVisualizer({ ...base, documentHidden: true })).toBe(false);
    expect(shouldActivateVisualizer({ ...base, isBusy: true })).toBe(false);
    expect(shouldActivateVisualizer({ ...base, compactMode: false })).toBe(false);
    expect(shouldActivateVisualizer({ ...base, currentView: 'view-control-deck' })).toBe(false);
    expect(shouldActivateVisualizer({ ...base, currentView: 'view-media', mediaCard: 'glass' })).toBe(false);
    expect(shouldActivateVisualizer({ ...base, currentView: 'view-media', mediaCard: 'classic' })).toBe(true);
  });
});
