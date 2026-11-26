import { describe, expect, it } from 'vitest';
import { prCalc, prParseClock, prSun } from '../src/js/features/prayer/index.js';

describe('prayer solar and clock utilities', () => {
  it('computes realistic solar declination and ordered daily prayer times', () => {
    const juneSolstice = prSun(2451545.0 + 172);
    expect(juneSolstice.dec).toBeGreaterThan(0.35);

    const times = prCalc({ lat: 23.8103, lon: 90.4125, tz: 'Asia/Dhaka' }, 2026, 10, 26, true);
    expect(times).not.toBeNull();
    if (!times) return;

    expect(times.fajr).toBeLessThan(times.sunrise);
    expect(times.sunrise).toBeLessThan(times.dhuhr);
    expect(times.dhuhr).toBeLessThan(times.asr);
    expect(times.asr).toBeLessThan(times.maghrib);
    expect(times.maghrib).toBeLessThan(times.isha);

    // Hanafi Asr shadow (2x) must be later than Standard Shafi'i/Maliki/Hanbali (1x)
    const stdTimes = prCalc({ lat: 23.8103, lon: 90.4125, tz: 'Asia/Dhaka' }, 2026, 10, 26, false);
    expect(stdTimes).not.toBeNull();
    if (stdTimes) {
      expect(times.asr).toBeGreaterThan(stdTimes.asr);
    }
  });

  it('parses 12h, 24h, and contextual masjid clock strings', () => {
    expect(prParseClock('05:15 am', 'fajr')).toBe(5 * 60 + 15);
    expect(prParseClock('1:30 pm', 'dhuhr')).toBe(13 * 60 + 30);
    expect(prParseClock('1.45', 'dhuhr')).toBe(13 * 60 + 45);
    expect(prParseClock('5:25', 'maghrib')).toBe(17 * 60 + 25);
    expect(prParseClock('25:99', 'isha')).toBeNull();
  });
});
