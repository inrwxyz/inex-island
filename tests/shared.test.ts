import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  KEY,
  applyTheme,
  hexToRgb,
  load,
  loadAlarms,
  parseCoords,
  save,
  storeAlarms,
} from '../src/shared.js';
import { cssProps } from './setup.js';

describe('shared settings and theme helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    cssProps.clear();
    delete document.documentElement.dataset.notchTone;
  });

  it('parses valid coordinate pairs and rejects out-of-range values', () => {
    expect(parseCoords('24.2741, 87.8230')).toEqual({ lat: 24.2741, lon: 87.823 });
    expect(parseCoords('24.2741, 87.8230, West Bengal')).toEqual({ lat: 24.2741, lon: 87.823 });
    expect(parseCoords('-33.8688° 151.2093°')).toEqual({ lat: -33.8688, lon: 151.2093 });
    expect(parseCoords('95.0, 10.0')).toBeNull();
    expect(parseCoords('10.0, -181.0')).toBeNull();
    expect(parseCoords('Kolkata')).toBeNull();
  });

  it('converts 3-digit and 6-digit hex colors to RGB tuples', () => {
    expect(hexToRgb('#030305')).toEqual([3, 3, 5]);
    expect(hexToRgb('#f5a')).toEqual([255, 85, 170]);
    expect(hexToRgb('0a84ff')).toEqual([10, 132, 255]);
    expect(hexToRgb(undefined)).toEqual([0, 0, 0]);
  });

  it('loads defaults, migrates legacy keys, and caps action tiles to 7', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        notch: { curvedEars: false, style: 'curved' },
        appearance: { menuLayout: 'mac', themeStyle: 'matrix' },
        macMenu: { showWeather: false },
        menu: { actionTiles: ['awake', 'mic', 'snip', 'calendar', 'timer', 'clipboard', 'lock', 'notepad'] },
      }),
    );

    const cfg = load();
    expect(cfg.notch.style).toBe('attached');
    expect(cfg.appearance.menuLayout).toBe('deck');
    expect(cfg.appearance.themeStyle).toBe('default');
    expect(cfg.deckMenu.showWeather).toBe(false);
    expect(cfg.menu.actionTiles).toHaveLength(7);
    expect(cfg.menu.actionTiles).not.toContain('notepad');
  });

  it('persists settings and validates stored alarms', () => {
    const custom = structuredClone(DEFAULTS);
    custom.share.deviceName = 'Inex-PC';
    save(custom);
    expect(load().share.deviceName).toBe('Inex-PC');
    expect(localStorage.getItem('island_pc_name')).toBe('Inex-PC');

    localStorage.setItem(
      'inex.alarms.v1',
      JSON.stringify([
        { id: 'ok', h: 6, m: 30, on: true, daily: true },
        { id: 'bad-hour', h: 25, m: 0, on: true },
        { id: 'bad-min', h: 10, m: 60, on: true },
      ]),
    );
    const alarms = loadAlarms();
    expect(alarms).toEqual([{ id: 'ok', h: 6, m: 30, on: true, daily: true }]);
    storeAlarms(alarms);
    expect(loadAlarms()).toHaveLength(1);
  });

  it('applies dark and light theme CSS tokens accurately', () => {
    const light = structuredClone(DEFAULTS);
    light.appearance.notchColor = '#ffffff';
    light.appearance.notchOpacity = 95;
    applyTheme(light);
    expect(document.documentElement.dataset.notchTone).toBe('light');
    expect(cssProps.get('--notch-fg')).toBe('#050507');

    const dark = structuredClone(DEFAULTS);
    dark.appearance.notchColor = '#030305';
    dark.appearance.notchOpacity = 100;
    applyTheme(dark);
    expect(document.documentElement.dataset.notchTone).toBe('dark');
    expect(cssProps.get('--notch-fg')).toBe('#f5f5f7');
    expect(cssProps.get('--ear-overlap')).toBe('1px');
  });
});
