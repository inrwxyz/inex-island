// GENERATED from main-parts/*.js by scripts/build-main.mjs. Edit the parts, not this file.
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
import { initWeather } from './js/features/weather/index.js';
import { initClipboard } from './js/features/clipboard/index.js';
import { initStartup } from './js/core/startup.js';
import { initAlarm } from './js/features/alarm/index.js';
import { initCompanionAndWellness } from './js/features/pet-and-wellness/index.js';
import { initWidgets } from './js/features/widgets/index.js';
import { initPrayer } from './js/features/prayer/index.js';

const SET = loadSettings();
applyTheme(SET);
// ---------------------------------------------------------------------------------------
// Control Center Menu, View Navigation, Tile Slots & Clock - Delegated to Feature Module
// ---------------------------------------------------------------------------------------
initMenu();
initBattery();
// Media Feature: Refactored into ES module at src/js/features/media/index.js
initMedia();
// ---------------------------------------------------------------------------------------
// Hardware Polling, System Stats & Tauri Events - Delegated to Core Module
// ---------------------------------------------------------------------------------------
initSystemPolling();
// Wi-Fi Feature: Refactored into ES module at src/js/features/wifi/index.js
initWifi();
// Bluetooth Feature: Refactored into ES module at src/js/features/bluetooth/index.js
initBluetooth();
// ==================== 07. TILES, QUICK ACTIONS & SUBVIEWS ====================
// Extracted to src/js/features/controls/index.js
initControls();
// ==================== 08. TRAY & DRAG-AND-DROP ====================
// Extracted to src/js/features/tray/index.js
initTray();
// ==================== 10. FILE TRANSFER & PEERS UI ====================
// Extracted to src/js/features/file-transfer/index.js
initFileTransfer();
// ==================== 11. TOASTS, LOCKER & PROMPTS ====================
// Extracted to src/js/features/toasts-locker/index.js
initToastsLocker();
// Timer, Calendar & Notepad Feature: Refactored into ES module at src/js/features/timer/index.js
initTimer();
// Real 5-Band Audio Visualizer (WASAPI Loopback + FFT ~32ms Event-Driven)
// Refactored into ES module at src/js/features/equalizer/index.js
import { initEqualizer } from './js/features/equalizer/index.js';

initEqualizer();
// 14 - Weather Widgets (Open-Meteo + Fast IP Geolocation, RAM, CPU, Disk, Battery)
// Extracted to ES Module: src/js/features/weather/index.js
initWeather();
// Mic in-use dot. Refactored into ES module at src/js/features/privacy-dot/index.js
import { initPrivacyDot } from './js/features/privacy-dot/index.js';

initPrivacyDot();
// Clipboard Feature: Refactored into ES module at src/js/features/clipboard/index.js
initClipboard();
// ---------------------------------------------------------------------------------------
// App Startup, Live Settings Sync & Weather Timer - Delegated to Core Module
// ---------------------------------------------------------------------------------------
initStartup();
// Alarm Feature: Refactored into ES module at src/js/features/alarm/index.js
initAlarm();
// Spotlight Search (deck menu): search bar + installed-browser picker.
// Self-contained ES module at src/js/features/spotlight/index.js, styles at spotlight.css, native side at src-tauri/src/spotlight.rs.
import { initSpotlight } from './js/features/spotlight/index.js';

initSpotlight();
// 18 - Notch Companion (pet) + Smart Health Reminders
// Extracted to ES Module: src/js/features/pet-and-wellness/index.js
initCompanionAndWellness();
// ==================== 19. WIDGETS TAB & CARDS ====================
// Extracted to src/js/features/widgets/index.js
initWidgets();
// 20 - Prayer & Solar Deck
// Extracted to ES Module: src/js/features/prayer/index.js
initPrayer();
