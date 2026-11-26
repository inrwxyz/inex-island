import { ALL_ACTION_TILES, DEFAULT_ACTION_TILES, MAX_ACTION_TILES } from '../../shared.js';
import { S, UI } from './state.js';

function tileIconClass(icon: string): string {
  const map: Record<string, string> = {
    sun: 'ti-sun',
    mic: 'ti-microphone',
    snip: 'ti-scissors',
    calendar: 'ti-calendar',
    clock: 'ti-clock',
    clipboard: 'ti-clipboard',
    lock: 'ti-lock',
    gear: 'ti-settings',
    calc: 'ti-calculator',
    refresh: 'ti-rotate-clockwise',
    notepad: 'ti-notes'
  };
  return map[icon] || ('ti-' + icon);
}

function tilePickerInnerHtml(): string {
  const cur = Array.isArray(S.menu?.actionTiles) ? S.menu.actionTiles : DEFAULT_ACTION_TILES;
  const atMax = cur.length >= MAX_ACTION_TILES;
  const allTiles = Object.values(ALL_ACTION_TILES);
  const avail = allTiles.filter((t) => !cur.includes(t.id));

  return `
    <div class="gp" style="margin-top:12px">
      <div class="rw" style="align-items:center;padding:10px 14px">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="qa-hdr-ico"><i class="ti ti-layout-grid" aria-hidden="true"></i></span>
          <div>
            <div class="t" style="font-weight:600;font-size:13px">Quick Action Tiles</div>
            <div class="d" style="font-size:11px;color:var(--faint)">${cur.length} / ${MAX_ACTION_TILES} tiles active. Tap Edit to add or remove</div>
          </div>
        </div>
        <button class="btn" data-act="tiles-toggle">${UI.tilesEdit ? 'Done' : 'Edit'}</button>
      </div>
      ${UI.tilesEdit ? `
        <div style="height:1px;background:var(--line);margin:0 14px"></div>
        <div class="qa-section">
          <div class="qa-sec-hdr">
            <b>Active Tiles (${cur.length} / ${MAX_ACTION_TILES})</b>
            <span>Click – to remove</span>
          </div>
          <div class="qa-grid">
            ${cur.map((id) => {
              const t = ALL_ACTION_TILES[id];
              if (!t) return '';
              const ic = tileIconClass(t.icon);
              return `
                <div class="qa-tile active" data-tile-remove="${t.id}" title="Click to remove ${t.label}">
                  <span class="qa-badge minus"><i class="ti ti-minus" aria-hidden="true"></i></span>
                  <i class="ti ${ic} qa-icon" aria-hidden="true"></i>
                  <span class="qa-label">${t.label}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="qa-section" style="padding-top:4px">
          <div class="qa-sec-hdr">
            <b>Available Tiles</b>
            <span>${atMax ? 'Maximum ' + MAX_ACTION_TILES + ' tiles reached' : 'Click + to add'}</span>
          </div>
          <div class="qa-grid">
            ${avail.map((t) => {
              const ic = tileIconClass(t.icon);
              return `
                <div class="qa-tile avail${atMax ? ' disabled' : ''}" ${atMax ? '' : `data-tile-add="${t.id}"`} title="${atMax ? 'Maximum tiles active' : `Click to add ${t.label}`}">
                  <span class="qa-badge plus"><i class="ti ti-plus" aria-hidden="true"></i></span>
                  <i class="ti ${ic} qa-icon" aria-hidden="true"></i>
                  <span class="qa-label">${t.label}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="qa-footer-note">Changes apply immediately to the island menu.</div>
      ` : ''}
    </div>
  `;
}

export function tilePickerHtml(): string {
  return `<div id="qa-picker-box">${tilePickerInnerHtml()}</div>`;
}

export function refreshTilePicker(): void {
  const box = document.getElementById('qa-picker-box');
  if (box) box.innerHTML = tilePickerInnerHtml();
}
