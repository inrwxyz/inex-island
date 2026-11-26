import { DEFAULTS, DEFAULT_ACTION_TILES, MAX_ACTION_TILES, save } from './shared.js';
import {
  invoke, S, UI, replaceState, reloadState, resetStateToDefaults,
  registerCommitHooks, getPath, commit
} from './js/settings/state.js';
import { NAV, type NavItemTuple } from './js/settings/constants.js';
import { refreshPreviews } from './js/settings/previews.js';
import { renderAlarmBox, alarmAction } from './js/settings/alarms.js';
import { getSavedLocation, resolvePrayerLocation, updatePrayerCityUI, resetMasjidToCalculated } from './js/settings/prayer.js';
import { refreshTilePicker } from './js/settings/tiles.js';
import { renderScreenTimeData } from './js/settings/screentime.js';
import { buildPages, commitWeatherCity, skinName } from './js/settings/pages.js';
import { playStagePreview, stopStagePreviews } from './js/settings/stage-preview.js';

registerCommitHooks({
  onCompanionToggle: () => {
    const pn = document.getElementById('p-notch');
    if (pn) pn.innerHTML = buildPages().notch;
  },
  onCommit: refreshPreviews
});

function applyTheme(theme?: string): void {
  const win = document.getElementById('win');
  if (!win) return;
  let mode = theme || 'system';
  if (mode === 'system') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  win.setAttribute('data-t', mode);
  invoke('set_settings_glass', { dark: mode === 'dark' }).catch(() => {});
}

function syncVisibility(): void {
  const pm = document.getElementById('p-menu');
  if (pm) pm.dataset.ml = S.appearance?.menuLayout || 'deck';
  const ps = document.getElementById('p-sounds');
  if (ps) ps.dataset.msj = S.prayer?.masjidOverride ? 'on' : 'off';
  const win = document.getElementById('win');
  if (!win) return;
  const g = (k: string, v: unknown): void => { win.dataset[k] = v ? 'on' : 'off'; };
  g('gPet', getPath(S, 'companion.enabled', false));
  g('gWell', getPath(S, 'wellness.enabled', false));
  g('gWater', getPath(S, 'wellness.water', true));
  g('gEye', getPath(S, 'wellness.eye', true));
  g('gStretch', getPath(S, 'wellness.stretch', true));
  g('gHov', getPath(S, 'widgets.enabled', true));
  g('gWx', getPath(S, 'weather.enabled', true));
  g('gPrayer', getPath(S, 'prayer.enabled', false));
  g('gPrayeredit', UI.prayerEdit);
  g('gMusic', getPath(S, 'notch.musicMode', true));
  g('gSnd', getPath(S, 'sounds.enabled', true));
  g('gSndedit', UI.sndEdit);
  g('gSkin', UI.skinOpen);
  g('gCompEdit', UI.compEdit);
  g('gTrayopen', UI.trayOpen);
  g('gRecvopen', UI.recvOpen);
  g('gSendopen', UI.sendOpen);
  g('gMcopen', UI.mcOpen);
  g('gEqopen', UI.eqOpen);
  g('gWelledit', UI.wellEdit);
  g('gAnims', getPath(S, 'animations.enabled', false));
  g('gAnimtray', getPath(S, 'animations.tray.enabled', false));
  g('gAnimrecv', getPath(S, 'animations.receive.enabled', false));
  g('gAnimsend', getPath(S, 'animations.send.enabled', false));
}

let curTab = 'notch';

function renderAll(): void {
  const sb = document.getElementById('sb');
  const pages = document.getElementById('pages');
  if (!sb || !pages) return;

  sb.innerHTML = NAV.flatMap(([, items]) => items).map(([id, label, icon, color]) => {
    return `<div class="nv${id === curTab ? ' on' : ''}" data-id="${id}">
      <em style="background:${color}"><i class="ti ${icon}" aria-hidden="true"></i></em>
      <span>${label}</span>
    </div>`;
  }).join('');

  const P = buildPages();
  pages.innerHTML = Object.keys(P).map((k) => `<div class="pg${k === curTab ? ' on' : ''}" id="p-${k}">${P[k]}</div>`).join('');

  applyTheme(S.general?.settingsTheme);
  syncVisibility();
  setTitle();
  if (curTab === 'screentime') {
    renderScreenTimeData();
  }
}

function setTitle(): void {
  let m: NavItemTuple | null = null;
  NAV.forEach(([, items]) => items.forEach((i) => { if (i[0] === curTab) m = i; }));
  const t = document.getElementById('tb-title'), ic = document.getElementById('tb-ico');
  if (t && m) t.textContent = (m as NavItemTuple)[1];
  if (ic && m) {
    const item = m as NavItemTuple;
    ic.style.background = item[3];
    ic.innerHTML = `<i class="ti ${item[2]}" aria-hidden="true"></i>`;
  }
}

const DRAWER_TOGGLES: Array<[act: string, flag: string, onLbl: string, offLbl: string]> = [
  ['skin-toggle', 'skinOpen', 'Close', 'Choose'],
  ['comp-edit', 'compEdit', 'Done', 'Edit'],
  ['tray-choose', 'trayOpen', 'Close', 'Choose'],
  ['recv-choose', 'recvOpen', 'Close', 'Choose'],
  ['send-choose', 'sendOpen', 'Close', 'Choose'],
  ['mc-choose', 'mcOpen', 'Close', 'Choose'],
  ['eq-choose', 'eqOpen', 'Close', 'Choose'],
  ['well-edit', 'wellEdit', 'Done', 'Edit'],
  ['snd-edit', 'sndEdit', 'Done', 'Edit'],
  ['prayer-edit', 'prayerEdit', 'Done', 'Edit']
];

function closeTransientDrawers(): boolean {
  let closed = false;
  DRAWER_TOGGLES.forEach(([act, flag, _onLbl, offLbl]) => {
    if (act === 'snd-edit' || act === 'prayer-edit') return;
    if (UI[flag]) {
      UI[flag] = false;
      const b = document.querySelector(`[data-act="${act}"]`);
      if (b) b.textContent = offLbl;
      closed = true;
    }
  });
  return closed;
}

function go(id: string | undefined): void {
  if (!id) return;
  curTab = id;
  stopStagePreviews();
  if (closeTransientDrawers()) syncVisibility();
  setTitle();
  const targetPage = document.getElementById('p-' + id);
  if (targetPage && (id === 'notch' || id === 'companion' || id === 'screentime')) {
    const P = buildPages();
    targetPage.innerHTML = P[id] || '';
  }
  document.querySelectorAll('.pg').forEach((p) => p.classList.toggle('on', p.id === 'p-' + id));
  document.querySelectorAll<HTMLElement>('.nv').forEach((n) => n.classList.toggle('on', n.dataset.id === id));
  if (id === 'screentime') {
    renderScreenTimeData();
  }
}

function closeAllMenus(): void {
  document.querySelectorAll('.mn.open').forEach((m) => m.classList.remove('open'));
}

function runAction(act: string | undefined): void {
  if (!act) return;
  const drawer = DRAWER_TOGGLES.find(([a]) => a === act);
  if (drawer) {
    const [, flag, onLbl, offLbl] = drawer;
    UI[flag] = !UI[flag];
    syncVisibility();
    const b = document.querySelector(`[data-act="${act}"]`);
    if (b) b.textContent = UI[flag] ? onLbl : offLbl;
    return;
  }
  if (act === 'pet-tour') invoke('trigger_companion_demo', { kind: 'tour' });
  else if (act === 'pet-peek') invoke('trigger_companion_demo', { kind: 'peek' });
  else if (act === 'chime-test') invoke('play_alarm_sound');
  else if (act === 'tiles-toggle') {
    UI.tilesEdit = !UI.tilesEdit;
    refreshTilePicker();
  } else if (act === 'prayer-preview') {
    try { localStorage.setItem('inex.prayer.preview', String(Date.now())); } catch { /* ignore */ }
  } else if (act === 'prayer-reset-masjid') {
    resetMasjidToCalculated();
  } else if (act === 'prayer-detect') {
    commit('prayer.city', '');
    try { localStorage.removeItem('inex.prayer.loc'); } catch { /* ignore */ }
    try { localStorage.removeItem('inex.loc'); } catch { /* ignore */ }
    try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch { /* ignore */ }
    resetMasjidToCalculated();
  } else if (act === 'prayer-refresh') {
    try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch { /* ignore */ }
    resetMasjidToCalculated();
  }
}

function importSettings(): void {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    f.text().then((txt) => {
      try {
        const data = JSON.parse(txt) as Record<string, unknown>;
        const base = JSON.parse(JSON.stringify(DEFAULTS)) as Record<string, unknown>;
        const merge = (b: Record<string, unknown>, e: Record<string, unknown> | null | undefined): void => {
          Object.keys(e || {}).forEach((k) => {
            const bk = b[k];
            const ek = e?.[k];
            if (bk && typeof bk === 'object' && !Array.isArray(bk) && ek && typeof ek === 'object') {
              merge(bk as Record<string, unknown>, ek as Record<string, unknown>);
            } else if (k in b) {
              b[k] = ek;
            }
          });
        };
        merge(base, data);
        save(replaceState(base));
        renderAll();
      } catch { alert('That file is not a valid Inex Island settings file.'); }
    });
  };
  inp.click();
}

function initEvents(): void {
  const win = document.getElementById('win');
  if (!win) return;

  document.getElementById('titlebar')?.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('#btn-close, button, .x, input')) return;
    invoke('drag_settings');
  });

  document.getElementById('btn-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    invoke('close_settings');
  });

  win.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    let el: HTMLElement | null = null;

    if ((el = t.closest<HTMLElement>('.mi'))) {
      const menu = el.closest('.mn');
      const pw = el.closest<HTMLElement>('.pw');
      if (menu && pw && pw.classList.contains('mk')) {
        const mpath = pw.dataset.path || '';
        const isCustom = el.dataset.val === '__custom';
        UI.mkCustom[mpath] = isCustom;
        if (!isCustom) commit(mpath, el.dataset.val);
        closeAllMenus();
        menu.querySelectorAll('.mi').forEach((m) => m.classList.remove('on'));
        el.classList.add('on');
        const trigger = pw.querySelector('.pop');
        if (trigger && trigger.childNodes[0]) trigger.childNodes[0].nodeValue = (el.textContent || '').trim() + ' ';
        const parentFlex = pw.parentElement;
        if (parentFlex) {
          let inp = parentFlex.querySelector<HTMLInputElement>('input');
          if (isCustom && !inp) {
            inp = document.createElement('input');
            inp.className = 'tx';
            inp.type = 'text';
            inp.dataset.path = mpath;
            inp.placeholder = 'e.g. BTC-USD';
            inp.style.width = '120px';
            parentFlex.insertBefore(inp, pw);
          } else if (!isCustom && inp) {
            inp.remove();
          }
        }
        return;
      }
      if (menu && pw) {
        menu.querySelectorAll('.mi').forEach((m) => m.classList.remove('on'));
        el.classList.add('on');
        const trigger = pw.querySelector('.pop');
        if (trigger && trigger.childNodes[0]) trigger.childNodes[0].nodeValue = (el.textContent || '').trim() + ' ';
        const path = pw.dataset.path;
        if (path) commit(path, el.dataset.val);
      }
      closeAllMenus();
      return;
    }

    if ((el = t.closest<HTMLElement>('.pop'))) {
      const mm = el.nextElementSibling;
      const wasOpen = mm?.classList.contains('open');
      closeAllMenus();
      if (!wasOpen && mm instanceof HTMLElement) {
        mm.classList.remove('up');
        mm.style.maxHeight = '';
        mm.classList.add('open');
        const sc = el.closest('.mn2') || document.getElementById('win');
        const scRect = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const btnRect = el.getBoundingClientRect();
        const roomBelow = Math.max(120, Math.floor(scRect.bottom - btnRect.bottom - 12));
        const roomAbove = Math.max(120, Math.floor(btnRect.top - scRect.top - 12));
        const r = mm.getBoundingClientRect();
        if (r.bottom > scRect.bottom - 8 && roomAbove > roomBelow) {
          mm.classList.add('up');
          mm.style.maxHeight = `${Math.min(260, roomAbove)}px`;
        } else if (r.bottom > scRect.bottom - 8) {
          mm.style.maxHeight = `${Math.min(260, roomBelow)}px`;
        }
      }
      return;
    }

    closeAllMenus();

    if ((el = t.closest<HTMLElement>('[data-al]'))) { alarmAction(el.dataset.al, el.dataset.id); return; }
    if ((el = t.closest<HTMLElement>('[data-act]'))) { runAction(el.dataset.act); return; }

    if ((el = t.closest<HTMLElement>('[data-snd-test]'))) {
      invoke('play_status_sound', { kind: el.dataset.sndTest });
      return;
    }

    if ((el = t.closest<HTMLElement>('.anim-chip'))) {
      const id = el.dataset.choiceId || el.dataset.animId;
      if (el.dataset.mediaCard && id) {
        el.closest('.anim-opts')?.querySelectorAll('.anim-chip').forEach((c) => c.classList.remove('on'));
        el.classList.add('on');
        commit('notch.mediaCard', id);
        const curLbl = document.getElementById('mc-cur-style');
        const titleEl = el.querySelector('.anim-chip-title');
        if (curLbl && titleEl) curLbl.textContent = titleEl.textContent;
        return;
      }
      if (el.dataset.eqStyle && id) {
        el.closest('.anim-opts')?.querySelectorAll('.anim-chip').forEach((c) => c.classList.remove('on'));
        el.classList.add('on');
        commit('notch.eqStyle', id);
        const curLbl = document.getElementById('eq-cur-style');
        const titleEl = el.querySelector('.anim-chip-title');
        if (curLbl && titleEl) curLbl.textContent = titleEl.textContent;
        return;
      }
      const cat = el.dataset.animCat;
      if (cat && id) {
        el.closest('.anim-opts')?.querySelectorAll('.anim-chip').forEach((c) => c.classList.remove('on'));
        el.classList.add('on');
        commit(`animations.${cat}.id`, id);
        const curLbl = document.getElementById(`anim-cur-${cat}`);
        const titleEl = el.querySelector('.anim-chip-title');
        if (curLbl && titleEl) curLbl.textContent = titleEl.textContent;
      }
      return;
    }

    if ((el = t.closest<HTMLElement>('[data-pv-play]'))) {
      playStagePreview(el.dataset.pvPlay);
      return;
    }

    if ((el = t.closest<HTMLElement>('[data-anim-play]'))) {
      const cat = el.dataset.animPlay;
      const defId = cat === 'tray' ? 'bounce' : cat === 'receive' ? 'radar' : 'beam';
      const id = getPath(S, `animations.${cat}.id`, defId);
      invoke('trigger_animation_demo', { category: cat, id });
      return;
    }

    if ((el = t.closest<HTMLElement>('.sw'))) {
      el.classList.toggle('on');
      const path = el.dataset.path;
      const on = el.classList.contains('on');
      if (path) {
        commit(path, on);
        if (path === 'general.launchAtLogin') invoke('set_autostart', { on });
        if (path === 'general.screenTimeEnabled') {
          invoke('set_screen_time_enabled', { on });
          const stBadge = document.getElementById('st-tracking-state');
          if (stBadge) {
            stBadge.textContent = on ? 'Tracking' : 'Off';
            stBadge.style.color = on ? 'var(--mint, #20c997)' : 'var(--faint, #8e8e93)';
          }
          const dayHeader = document.getElementById('st-day-header');
          if (dayHeader) dayHeader.textContent = on ? 'Today' : 'Today (Tracking Off)';
          renderScreenTimeData();
        }
        syncVisibility();
      }
      return;
    }

    if ((el = t.closest<HTMLElement>('.seg b'))) {
      const parent = el.closest<HTMLElement>('.seg');
      if (!parent) return;
      parent.querySelectorAll('b').forEach((b) => b.classList.remove('on'));
      el.classList.add('on');
      const path = parent.dataset.path;
      if (path) {
        commit(path, el.dataset.val);
        if (path === 'general.settingsTheme') applyTheme(el.dataset.val);
      }
      return;
    }

    if ((el = t.closest<HTMLElement>('.sk'))) {
      el.closest('.skg')?.querySelectorAll('.sk').forEach((s) => s.classList.remove('on'));
      el.classList.add('on');
      commit('companion.skin', el.dataset.val);
      const nm = document.getElementById('skin-name');
      if (nm) nm.textContent = skinName();
      return;
    }

    if (t.closest('[data-act="tiles-toggle"]')) {
      UI.tilesEdit = !UI.tilesEdit;
      refreshTilePicker();
      return;
    }

    if ((el = t.closest<HTMLElement>('[data-tile-remove]'))) {
      const id = el.dataset.tileRemove || '';
      let list = Array.isArray(S.menu?.actionTiles) ? [...S.menu.actionTiles] : [...DEFAULT_ACTION_TILES];
      if (list.includes(id) && list.length > 1) {
        list = list.filter((x) => x !== id);
        commit('menu.actionTiles', list);
        refreshTilePicker();
      }
      return;
    }

    if ((el = t.closest<HTMLElement>('[data-tile-add]'))) {
      const id = el.dataset.tileAdd || '';
      const list = Array.isArray(S.menu?.actionTiles) ? [...S.menu.actionTiles] : [...DEFAULT_ACTION_TILES];
      if (!list.includes(id) && list.length < MAX_ACTION_TILES) {
        list.push(id);
        commit('menu.actionTiles', list);
        refreshTilePicker();
      }
      return;
    }

    if ((el = t.closest<HTMLElement>('.tl'))) {
      el.closest('.tg')?.querySelectorAll('.tl').forEach((tile) => tile.classList.remove('on'));
      el.classList.add('on');
      commit('notch.style', el.dataset.val);
      return;
    }

    if ((el = t.closest<HTMLElement>('.opt'))) {
      el.closest('.og')?.querySelectorAll('.opt').forEach((opt) => opt.classList.remove('on'));
      el.classList.add('on');
      commit('appearance.menuLayout', el.dataset.val);
      syncVisibility();
      return;
    }

    if ((el = t.closest<HTMLElement>('.nv'))) {
      go(el.dataset.id);
      return;
    }

    if (t.closest('#btn-reset')) {
      if (confirm('Reset all settings to defaults?')) {
        save(resetStateToDefaults());
        invoke('set_autostart', { on: !!DEFAULTS.general.launchAtLogin });
        renderAll();
      }
      return;
    }

    if (t.closest('#btn-export')) {
      const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `inex-island-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      return;
    }

    if (t.closest('#btn-import')) { importSettings(); return; }

    if ((el = t.closest<HTMLElement>('[data-url]'))) {
      invoke('open_url', { url: el.dataset.url });
      return;
    }

    if (t.id === 'btn-check-update' || t.closest('#btn-check-update')) {
      const b = (t.closest('#btn-check-update') || t) as HTMLButtonElement;
      if (b.dataset.updating === 'true') return;
      if (b.dataset.hasUpdate === 'true') {
        b.dataset.updating = 'true';
        b.textContent = 'Installing update...';
        invoke<boolean>('apply_update').then((ok) => {
          if (ok) {
            b.textContent = 'Restarting...';
          } else {
            b.textContent = 'Update failed';
            setTimeout(() => { b.textContent = 'Check for updates'; b.dataset.updating = 'false'; b.dataset.hasUpdate = 'false'; }, 3000);
          }
        }).catch(() => {
          b.textContent = 'Update error';
          setTimeout(() => { b.textContent = 'Check for updates'; b.dataset.updating = 'false'; b.dataset.hasUpdate = 'false'; }, 3000);
        });
        return;
      }

      b.textContent = 'Checking...';
      b.disabled = true;
      invoke<{ available?: boolean; latest_version?: string; version?: string }>('check_update').then((res) => {
        b.disabled = false;
        const ver = res?.latest_version || res?.version;
        if (res?.available && ver) {
          b.dataset.hasUpdate = 'true';
          b.textContent = `Update to v${ver}`;
          b.style.fontWeight = '600';
        } else {
          b.dataset.hasUpdate = 'false';
          b.textContent = 'You are on the latest version';
          setTimeout(() => { b.textContent = 'Check for updates'; }, 3500);
        }
      }).catch(() => {
        b.disabled = false;
        b.textContent = 'Unable to check';
        setTimeout(() => { b.textContent = 'Check for updates'; }, 3000);
      });
      return;
    }
  });

  win.addEventListener('input', (e) => {
    const r = e.target as HTMLInputElement | null;
    if (!r) return;
    if (r.type === 'range') {
      const span = r.nextElementSibling;
      if (span) span.textContent = `${r.value}${r.dataset.u || ''}`;
      const path = r.closest<HTMLElement>('.sl')?.dataset.path;
      if (path) commit(path, parseInt(r.value, 10));
    } else if (r.id === 'notchColorPicker') {
      commit('appearance.notchColor', r.value);
    }
  });

  win.addEventListener('change', (e) => {
    const r = e.target as HTMLInputElement | null;
    if (!r || !r.classList || !r.classList.contains('tx')) return;
    const path = r.dataset.path;
    if (!path) return;
    let v = r.value.trim();
    if (path.startsWith('deckMenu.market')) v = v.toUpperCase();
    if (path === 'weather.city') { commitWeatherCity(r, v); return; }
    commit(path, v);
    if (path === 'prayer.city') {
      try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch { /* ignore */ }
      resetMasjidToCalculated();
    }
  });
  win.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (e.key === 'Enter' && target?.classList?.contains('tx')) target.blur();
  });

  window.addEventListener('storage', (e) => { if (e.key === 'inex.alarms.v1' || e.key === null) renderAlarmBox(); });
}

try {
  invoke<string>('get_app_version').then((v) => {
    if (v) {
      const av = document.getElementById('about-ver-text');
      if (av) av.textContent = `Version ${v}`;
    }
  });
} catch { /* ignore */ }

try {
  window.__TAURI__?.event?.listen('settings-opened', () => {
    reloadState();
    stopStagePreviews();
    DRAWER_TOGGLES.forEach(([, flag]) => { UI[flag] = false; });
    renderAll();
    if (S.prayer?.enabled && !getSavedLocation()) {
      resolvePrayerLocation().then((loc) => {
        if (loc?.city) updatePrayerCityUI(loc.city);
      });
    }
  });
} catch { /* ignore */ }

renderAll();
initEvents();
setInterval(refreshPreviews, 15000);
if (S.prayer?.enabled && !getSavedLocation()) {
  resolvePrayerLocation().then((loc) => {
    if (loc?.city) updatePrayerCityUI(loc.city);
  });
}
