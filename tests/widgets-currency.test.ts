import { describe, expect, it } from 'vitest';
import { wgAppColor, wgFmtNum, wgFmtShort, wgMkPrice, wgNum, wgResolveCurrency } from '../src/js/features/widgets/index.js';

describe('widgets currency resolver and formatting utilities', () => {
  it('resolves country names, currency words, and ISO region codes', () => {
    expect(wgResolveCurrency('Bangladesh')).toBe('BDT');
    expect(wgResolveCurrency('taka')).toBe('BDT');
    expect(wgResolveCurrency('IN')).toBe('INR');
    expect(wgResolveCurrency('Japan')).toBe('JPY');
    expect(wgResolveCurrency('chf')).toBe('CHF');
    expect(wgResolveCurrency('')).toBeNull();
  });

  it('formats durations, comma numbers, and market prices cleanly', () => {
    expect(wgFmtShort(45)).toBe('45s');
    expect(wgFmtShort(125)).toBe('2m');
    expect(wgFmtShort(3725)).toBe('1h 02m');
    expect(wgFmtShort(-10)).toBe('0s');

    expect(wgNum('12,345.67')).toBeCloseTo(12345.67);
    expect(wgFmtNum(NaN)).toBe('--');
    expect(wgFmtNum(1234.5)).toBe('1,235');
    expect(wgMkPrice({ symbol: 'BTC-USD', currency: 'USD' }, 94500.2)).toBe('$94,500');
    expect(wgMkPrice({ symbol: '^NSEI', currency: 'INR' }, 24150.75)).toBe('24,151');
  });

  it('assigns predictable accent colors for known and fallback apps', () => {
    expect(wgAppColor({ name: 'Visual Studio Code', exe: 'code.exe' })).toBe('#0a84ff');
    expect(wgAppColor({ name: 'Spotify', exe: 'spotify.exe' })).toBe('#30d158');
    expect(wgAppColor({ name: 'CustomApp', exe: 'custom.exe' })).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
