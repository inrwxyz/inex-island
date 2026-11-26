// Entry point for the Inex Island main window
import { load as loadSettings, applyTheme } from './shared.js';
import { initMenu } from './js/features/menu/index.js';
import { initBattery } from './js/features/battery/index.js';
import { initMedia } from './js/features/media/index.js';
import { initSystemPolling } from './js/core/system.js';
import { initWifi } from './js/features/wifi/index.js';
import { initBluetooth } from './js/features/bluetooth/index.js';
import { initControls } from './js/features/controls/index.js';
import { initTray } from './js/features/tray/index.js';
import { initFileTransfer } from './js/features/file-transfer/index.js';
import { initToastsLocker } from './js/features/toasts-locker/index.js';
import { initTimer } from './js/features/timer/index.js';
import { initEqualizer } from './js/features/equalizer/index.js';
import { initWeather } from './js/features/weather/index.js';
import { initPrivacyDot } from './js/features/privacy-dot/index.js';
import { initClipboard } from './js/features/clipboard/index.js';
import { initStartup } from './js/core/startup.js';
import { initAlarm } from './js/features/alarm/index.js';
import { initSpotlight } from './js/features/spotlight/index.js';
import { initCompanionAndWellness } from './js/features/pet-and-wellness/index.js';
import { initWidgets } from './js/features/widgets/index.js';
import { initPrayer } from './js/features/prayer/index.js';
import { initAnimations } from './js/features/animations/index.js';
import { initGlassMedia } from './js/features/media-glass/index.js';
import { bus } from './js/core/bus.js';
import { invokeTauri } from './js/core/tauri.js';

const SET = loadSettings();
applyTheme(SET);

initMenu();
initBattery();
initMedia();
initSystemPolling();
initWifi();
initBluetooth();
initControls();
initTray();
initFileTransfer();
initToastsLocker();
initTimer();
initEqualizer();
initWeather();
initPrivacyDot();
initClipboard();
initStartup();
initAlarm();
initSpotlight();
initCompanionAndWellness();
initWidgets();
initPrayer();
initAnimations();
initGlassMedia();

let _idleMemTimer: ReturnType<typeof setTimeout> | 0 = 0;
bus.on<string>('view:change', (viewId) => {
  if (_idleMemTimer) {
    clearTimeout(_idleMemTimer);
    _idleMemTimer = 0;
  }
  if (viewId === 'view-compact') {
    _idleMemTimer = setTimeout(() => {
      void invokeTauri('set_idle_memory_mode', { low: true });
    }, 800);
  } else {
    void invokeTauri('set_idle_memory_mode', { low: false });
  }
});
