// Spotlight: search bar + scrollable list of installed browsers, mounted at the top of the deck's left column.
import { detectInstalled, browserById, logoHtml, loadChoice, saveChoice, type BrowserInfo } from './browsers.js';
import { openInBrowser } from './search.js';
import { goCompact } from '../../core/views.js';

const SEARCH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const CHECK_SVG = '<svg class="sp-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

let root: HTMLDivElement | null = null;
let input: HTMLInputElement | null = null;
let list: HTMLElement | null = null;
let installed: BrowserInfo[] = [];
let selected = '';

function pickSelected(): void {
  const ids = installed.map((b) => b.id);
  if (ids.includes(selected)) return;
  const saved = loadChoice();
  selected = ids.includes(saved) ? saved : (ids[0] || '');
}

function renderList(): void {
  if (!list) return;
  list.innerHTML = '';
  list.classList.toggle('can-scroll', installed.length > 3);
  if (!installed.length) {
    const empty = document.createElement('div');
    empty.className = 'sp-empty';
    empty.textContent = 'No browsers found';
    list.appendChild(empty);
    return;
  }
  installed.forEach((b) => {
    const row = document.createElement('div');
    row.className = 'sp-row' + (b.id === selected ? ' sel' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(b.id === selected));
    row.dataset.id = b.id;
    row.style.setProperty('--sp-c', b.color);
    row.innerHTML = `${logoHtml(b.id)}<span class="sp-name"></span>${b.id === selected ? CHECK_SVG : ''}`;
    const nameEl = row.querySelector<HTMLElement>('.sp-name');
    if (nameEl) nameEl.textContent = b.name;
    row.addEventListener('click', () => choose(b.id));
    list!.appendChild(row);
  });
}

function choose(id: string): void {
  if (!browserById(id)) return;
  selected = id;
  saveChoice(id);
  renderList();
  input?.focus();
}

function stepChoice(dir: number): void {
  if (installed.length < 2) return;
  const i = installed.findIndex((b) => b.id === selected);
  choose(installed[(i + dir + installed.length) % installed.length].id);
  list?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

async function loadBrowsers(): Promise<void> {
  installed = await detectInstalled();
  pickSelected();
  renderList();
}

async function submit(): Promise<void> {
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  const ok = await openInBrowser(selected, text);
  if (ok) {
    input.value = '';
    goCompact();
  }
}

export function mountSpotlight(): boolean {
  const host = document.querySelector('#view-control-deck .mx-left');
  if (!host || document.getElementById('deck-spotlight')) return false;

  root = document.createElement('div');
  root.id = 'deck-spotlight';
  root.className = 'mx-card mx-spotlight';
  root.setAttribute('data-deck', 'spotlight');
  root.innerHTML = `
    <div class="sp-bar">
      <div class="sp-go" role="button" tabindex="0" title="Search" aria-label="Search">${SEARCH_SVG}</div>
      <input class="sp-input" type="text" placeholder="Search" spellcheck="false" autocomplete="off" aria-label="Search the web" />
    </div>
    <div class="sp-list" role="listbox" aria-label="Browser"></div>`;
  host.prepend(root);

  input = root.querySelector('.sp-input');
  list = root.querySelector('.sp-list');
  const go = root.querySelector('.sp-go');

  go?.addEventListener('click', () => { submit(); });
  go?.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' || ke.key === ' ') {
      ke.preventDefault();
      submit();
    }
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepChoice(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepChoice(-1);
    }
  });

  loadBrowsers();
  return true;
}
