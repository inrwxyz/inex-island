export {};

declare global {
  interface TauriEvent<T = unknown> {
    event: string;
    payload: T;
  }

  interface TauriGlobalApi {
    core?: {
      invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    };
    event?: {
      listen<T = unknown>(name: string, handler: (ev: TauriEvent<T>) => void): Promise<() => void>;
      emit(name: string, payload?: unknown): Promise<void>;
    };
    window?: {
      getCurrentWindow(): {
        show(): Promise<void>;
        hide(): Promise<void>;
        close(): Promise<void>;
        startDragging(): Promise<void>;
      };
    };
  }

  interface Window {
    __TAURI__?: TauriGlobalApi;
    __TAURI_INVOKE__?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    qrcode?: (typeNumber: number, errorCorrectionLevel: string) => {
      addData(data: string): void;
      make(): void;
      getModuleCount(): number;
      isDark(row: number, col: number): boolean;
    };
    QRCode?: Window['qrcode'];
    jsQR?: (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      options?: Record<string, unknown>
    ) => { data: string } | null;
    inexIslandCodec?: {
      pack(payload: unknown): string;
      unpack(code: string): unknown;
      [key: string]: unknown;
    };
    InexCompanion?: Record<string, (...args: unknown[]) => unknown>;
    switchView?: (viewId: string, stateClass: string, winWidth: number, winHeight: number) => void;
    goCompact?: () => void;
    openControlMenu?: () => void;
    openMedia?: () => void;
    openDeckSub?: (viewId: string, title?: string, from?: string) => void;
    closeDeckSub?: () => void;
    applySettings?: () => void;
    scheduleApplySettings?: () => void;
    syncWeatherTimer?: () => void;
    pixelSnap?: () => void;
    syncLoadTimer?: () => void;
    loadTick?: () => Promise<void>;
    loadWanted?: () => boolean;
    refreshLoad?: () => Promise<void>;
    refreshRadios?: () => Promise<void>;
    refreshWifiNow?: () => Promise<void>;
    refreshStats?: () => Promise<void>;
    refreshMic?: () => Promise<void>;
    renderMic?: (muted: boolean | null | undefined) => void;
    toggleMic?: () => Promise<void>;
    syncDeckStatsUI?: () => void;
    setDeckStatMeter?: (...args: unknown[]) => void;
    applyDeckMenuConfig?: () => void;
    applySlots?: () => void;
    syncCompactCycleTimer?: () => void;
    pollSystemAndMedia?: () => Promise<void>;
    showToast?: (icon: string, title: string, ms?: number) => void;
    playStatusSound?: (category: string, kind: string) => void;
    triggerCloseEase?: (ms?: number) => void;
    cancelCloseEase?: () => void;
    updateCompactStateClasses?: () => void;
    deckWidgetsReset?: () => void;
    wgSetTab?: (tab: string) => void;
    wxdOpenDeck?: () => void;
    wxdCloseDeck?: () => void;
    sendTrayFiles?: (...args: unknown[]) => void;
    startCompactTransferUI?: (...args: unknown[]) => void;
    updateCompactTransferPct?: (...args: unknown[]) => void;
    finishCompactTransferUI?: (...args: unknown[]) => void;
    formatCompactCenterHtml?: (...args: unknown[]) => string;
    triggerBiometricMorph?: (...args: unknown[]) => void;
    triggerNexusVoiceAnimation?: (...args: unknown[]) => void;
    [key: string]: unknown;
  }
}
