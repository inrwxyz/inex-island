import { describe, expect, it } from 'vitest';
import { clipFileName, clipHashString, clipPathKey } from '../src/js/features/clipboard/index.js';
import { SEARCH_URL, resolveTarget } from '../src/js/features/spotlight/search.js';
import { browserById } from '../src/js/features/spotlight/browsers.js';

describe('clipboard key normalization and spotlight URL resolution', () => {
  it('normalizes Windows/POSIX paths and extracts filenames', () => {
    expect(clipPathKey('C:/Users/Test/Pictures/Screens///')).toBe('c:\\users\\test\\pictures\\screens');
    expect(clipFileName('C:\\Users\\Test\\shot_01.png')).toBe('shot_01.png');
    expect(clipFileName('/tmp/export/clip.txt')).toBe('clip.txt');
  });

  it('produces deterministic FNV-1a length-tagged hashes', () => {
    const h1 = clipHashString('hello inex');
    const h2 = clipHashString('hello inex');
    const h3 = clipHashString('hello world');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1.endsWith(':10')).toBe(true);
  });

  it('resolves explicit URLs, bare domains, and web search queries in Spotlight', () => {
    expect(resolveTarget('')).toBe('');
    expect(resolveTarget('   ')).toBe('');
    expect(resolveTarget('https://github.com/inrwxyz')).toBe('https://github.com/inrwxyz');
    expect(resolveTarget('example.com/docs?q=1')).toBe('https://example.com/docs?q=1');
    expect(resolveTarget('rust cargo test')).toBe(`${SEARCH_URL}rust%20cargo%20test`);
    expect(browserById('edge')?.name).toBe('Edge');
    expect(browserById('unknown-browser')).toBeNull();
  });
});
