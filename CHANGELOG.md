# Changelog

All notable changes to Inex Island are documented in this file.

## [1.2.0] - 2026-11-26

### Added
- Migrated frontend from plain JavaScript to **Vite 8 + Strict TypeScript** (`strict: true`, `allowJs: false`, zero unused locals/parameters).
- Automated testing and CI suite:
  - Vitest frontend unit tests (`tests/`).
  - Native Rust `#[test]` unit suite (`npm run test:rust`) and strict `cargo clippy -- -D warnings`.
  - Playwright + Pixelmatch Golden UI regression harness (`scripts/golden-ui-harness.mjs`).
  - GitHub Actions CI workflow (`.github/workflows/ci.yml`).
- Engineering documentation: `ARCHITECTURE.md` and `SECURITY.md`.

### Changed & Improved
- **Quick Share / Inex Drop Engine Hardening**: Synced hardened `wquickshare` engine (`UKEY2` `client_commitment` SHA-512 verification, strict `sequence_number` replay rejection, 2 MB peer chunk buffer limits, path-traversal sanitization, and lock-free download path updates).
- **Speed Test Upload Accuracy**: Upgraded `wgSpeedUpload` from 1x `1 MB` sequential upload to 4x `4 MB` parallel upload streams matching download throughput.
- **Screen Time Instant Sync**: Added 5-second today session caching in `session_history.rs`, pre-warmed cache & app icons on Deck/Settings open, and eliminated repeated `"Reading event log..."` reloads when switching `Apps | Screen Time` tabs.
- **Lower Idle Memory Footprint**: Enabled WebView2 `COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW` when the island or Settings window is idle/hidden, plus `SetProcessWorkingSetSize` trim when closing Settings.
- **5-Band Audio Visualizer Efficiency**: Pauses Rust WASAPI loopback FFT capture automatically on startup, when fullscreen Smart Mode hides the island (`.smart-hidden`), when the UI window is hidden, or when viewing panels without 5-band bars (such as Control Deck or Glass Media Card).
- **Settings Dropdown Polish**: Made all Settings popup menus (`.mn`, including Fonts) viewport-clamped and scrollable with crisp high-contrast acrylic opacity (`0.92`).
- **Accurate Documentation**: Corrected `README.md` P2P Link signaling notes (QR image exchange) and documented FFT/memory/Quick Share updates.
- Removed 23 dead legacy `main-parts/` stub files and unused `build-main.mjs`.
