export type NotchStyle = 'attached' | 'curved' | 'floating';
export type NotchMode = 'smart' | 'fixed' | 'ghost';
export type MenuLayout = 'deck' | 'classic';
export type MenuStyle = 'color' | 'transparent';
export type SettingsTheme = 'system' | 'dark' | 'light';
export type EqStyle = 'bottom' | 'center';
export type MediaCardStyle = 'glass' | 'classic';
export type StatsMode = 'sys' | 'stocks' | 'none';

export interface IslandSize {
  width: number;
  height: number;
}

export interface ActionTileDef {
  id: string;
  label: string;
  desc: string;
  icon: string;
}

export interface AlarmItem {
  id: string;
  h: number;
  m: number;
  on: boolean;
  daily: boolean;
}

export interface InexSettings {
  general: {
    launchAtLogin: boolean;
    hour24: boolean;
    autoUpdate: boolean;
    lowBatteryAlert: boolean;
    lowBattery: number;
    chargeToast: boolean;
    lockToast: boolean;
    copyToast: boolean;
    settingsTheme: SettingsTheme;
  };
  appearance: {
    menuLayout: MenuLayout;
    notchColor: string;
    notchOpacity: number;
    notchBorderColor: string;
    notchBorderOpacity: number;
    cornerRadius: number;
    menuStyle: MenuStyle;
    themeStyle: string;
    borderColor: string;
    borderOpacity: number;
    fontStyle: string;
    scale: number;
    animations: boolean;
  };
  notch: {
    mode: NotchMode;
    style: NotchStyle;
    compactContent: string;
    musicMode: boolean;
    compactMode: boolean;
    mediaCard: MediaCardStyle;
    ambientGlow: boolean;
    compactGlow: boolean;
    calendarTimer: boolean;
    timerSound: boolean;
    eqSync: boolean;
    eqStyle: EqStyle;
    eqSensitivity: number;
    curvedEars?: boolean;
  };
  sounds: {
    enabled: boolean;
    power: boolean;
    bluetooth: boolean;
    transfer: boolean;
    lock: boolean;
  };
  deckMenu: {
    showClock: boolean;
    showWeather: boolean;
    showStats: boolean;
    showBattery: boolean;
    statsMode: StatsMode;
    widgetsEnabled: boolean;
    market1: string;
    market2: string;
  };
  weather: {
    enabled: boolean;
    unit: 'C' | 'F' | string;
    city: string;
    lat: number | null;
    lon: number | null;
    alerts: boolean;
  };
  prayer: {
    enabled: boolean;
    city: string;
    asrMethod: string;
    masjidOverride: boolean;
    masjid: {
      fajr: string;
      dhuhr: string;
      asr: string;
      maghrib: string;
      isha: string;
    };
    adhanSound: string;
    fullAdhan: boolean;
    alertLead: string;
    alertRepeat: string;
  };
  widgets: {
    enabled: boolean;
    left: string;
    right: string;
  };
  menu: {
    actionTiles: string[];
  };
  overlays: {
    btBattery: boolean;
    privacyDot: boolean;
  };
  companion: {
    enabled: boolean;
    skin: string;
    monogram: boolean;
    tracking: boolean;
    peekMinMin: number;
    peekMaxMin: number;
    activityPeekMin: number;
  };
  wellness: {
    enabled: boolean;
    water: boolean;
    waterEvery: number;
    eye: boolean;
    eyeEvery: number;
    stretch: boolean;
    stretchEvery: number;
    idleReset: number;
  };
  share: {
    deviceName: string;
    firebaseUrl?: string;
  };
  animations: {
    enabled: boolean;
    tray: { enabled: boolean; id: string };
    receive: { enabled: boolean; id: string };
    send: { enabled: boolean; id: string };
  };
  macMenu?: Record<string, unknown>;
}

export interface PeerInfo {
  id: string;
  name: string;
}

export interface TrayFileItem {
  path: string;
  name: string;
  ext?: string;
  size?: number;
  is_dir?: boolean;
  [key: string]: unknown;
}

export interface SystemStats {
  cpu_pct?: number;
  ram_pct?: number;
  ram_used_gb?: number;
  ram_total_gb?: number;
  gpu_pct?: number;
  disk_pct?: number;
  battery_pct?: number;
  battery_charging?: boolean;
  net_rx_kbps?: number;
  net_tx_kbps?: number;
  [key: string]: unknown;
}

export interface AppState {
  currentView: string;
  lastVolume: number;
  trayFiles: TrayFileItem[];
  peers: PeerInfo[];
  traySelect: { peerId: string; picked: Set<string> } | null;
  draggingOut: boolean;
  xfer: Record<string, unknown> | null;
  prompting: boolean;
  lockerPrompting?: boolean;
  incomingOpen?: boolean;
  toast?: unknown;
  transferring: boolean;
  mediaPlaying: boolean;
  mediaProgressSec: number;
  mediaDuration: number;
  mediaSeeking: boolean;
  mediaTitleKey: string;
  timerPresetMins: number;
  timerSeconds: number;
  timerRunning: boolean;
  timerInterval: ReturnType<typeof setInterval> | null;
  volOpen: boolean;
  wifiRadio: boolean;
  btRadio: boolean;
  wifiPresent: boolean;
  btPresent: boolean;
  btBusy?: boolean;
  alarmOpts: Record<string, unknown> | null;
  biometricActive: boolean;
  dropActive: boolean;
  keepOpen: boolean;
  deckSubId: string | null;
  deckTrayByDrag: boolean;
  islandSize?: IslandSize;
  stats?: SystemStats;
  [key: string]: unknown;
}
