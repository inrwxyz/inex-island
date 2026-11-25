import { S, esc, getPath } from './state.js';

export const ic = (n, c) => `<i class="ti ti-${n}${c ? ' ' + c : ''}" aria-hidden="true"></i>`;

export function sw(path, def) {
  const on = !!getPath(S, path, def);
  return `<div class="sw${on ? ' on' : ''}" data-path="${path}"></div>`;
}

export function seg(path, opts, def) {
  const cur = getPath(S, path, def);
  return `<div class="seg" data-path="${path}">${opts.map(([v, l]) => `<b class="${v === cur ? 'on' : ''}" data-val="${v}">${l}</b>`).join('')}</div>`;
}

export function pop(path, opts, def) {
  const cur = getPath(S, path, def);
  const found = opts.find(([v]) => String(v) === String(cur)) || opts[0] || [cur, cur];
  return `<div class="pw" data-path="${path}">
    <button class="pop" type="button">${found[1]} <i class="ti ti-selector" aria-hidden="true"></i></button>
    <div class="mn">${opts.map(([v, l]) => `<div class="mi${String(v) === String(cur) ? ' on' : ''}" data-val="${v}"><i class="ti ti-check" aria-hidden="true"></i>${l}</div>`).join('')}</div>
  </div>`;
}

export function sl(path, min, max, unit, def) {
  const v = getPath(S, path, def);
  return `<div class="sl" data-path="${path}"><input type="range" min="${min}" max="${max}" value="${v}" data-u="${unit}"><span>${v}${unit}</span></div>`;
}

export function tx(path, ph, w, extra) {
  return `<input class="tx" type="text" data-path="${path}" value="${esc(getPath(S, path, ''))}" placeholder="${esc(ph)}" style="width:${w}px" spellcheck="false" ${extra || ''}>`;
}

export function btn(act, label, extra) {
  return `<button class="btn" type="button" data-act="${act}" ${extra || ''}>${label}</button>`;
}

export function row(t, _d, c, cls) {
  return `<div class="rw${cls ? ' ' + cls : ''}"><div class="t">${t}</div>${c || ''}</div>`;
}

export function card(rows, cls) {
  return `<div class="gp${cls ? ' ' + cls : ''}">${rows.join('')}</div>`;
}
