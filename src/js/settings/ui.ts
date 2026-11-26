import { S, esc, getPath } from './state.js';
import type { OptionTuple } from './constants.js';

export const ic = (n: string, c?: string): string => `<i class="ti ti-${n}${c ? ' ' + c : ''}" aria-hidden="true"></i>`;

export function sw(path: string, def: boolean): string {
  const on = !!getPath(S, path, def);
  return `<div class="sw${on ? ' on' : ''}" data-path="${path}"></div>`;
}

export function seg(path: string, opts: OptionTuple[], def: string): string {
  const cur = getPath(S, path, def);
  return `<div class="seg" data-path="${path}">${opts.map(([v, l]) => `<b class="${v === cur ? 'on' : ''}" data-val="${v}">${l}</b>`).join('')}</div>`;
}

export function pop(path: string, opts: OptionTuple[], def: string): string {
  const cur = getPath(S, path, def);
  const found = opts.find(([v]) => String(v) === String(cur)) || opts[0] || [cur, cur];
  return `<div class="pw" data-path="${path}">
    <button class="pop" type="button">${found[1]} <i class="ti ti-selector" aria-hidden="true"></i></button>
    <div class="mn">${opts.map(([v, l]) => `<div class="mi${String(v) === String(cur) ? ' on' : ''}" data-val="${v}"><i class="ti ti-check" aria-hidden="true"></i>${l}</div>`).join('')}</div>
  </div>`;
}

export function sl(path: string, min: number, max: number, unit: string, def: number): string {
  const v = getPath(S, path, def);
  return `<div class="sl" data-path="${path}"><input type="range" min="${min}" max="${max}" value="${v}" data-u="${unit}"><span>${v}${unit}</span></div>`;
}

export function tx(path: string, ph: string, w: number, extra?: string): string {
  return `<input class="tx" type="text" data-path="${path}" value="${esc(getPath(S, path, ''))}" placeholder="${esc(ph)}" style="width:${w}px" spellcheck="false" ${extra || ''}>`;
}

export function btn(act: string, label: string, extra?: string): string {
  return `<button class="btn" type="button" data-act="${act}" ${extra || ''}>${label}</button>`;
}

export function row(t: string, _d: string, c?: string, cls?: string): string {
  return `<div class="rw${cls ? ' ' + cls : ''}"><div class="t">${t}</div>${c || ''}</div>`;
}

export function card(rows: string[], cls?: string): string {
  return `<div class="gp${cls ? ' ' + cls : ''}">${rows.join('')}</div>`;
}
