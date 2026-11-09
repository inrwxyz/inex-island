# Inex Island 🏝️

> The Ultimate Dynamic Island & Control Center for Windows 10 & 11. Built with **Tauri 2** and **Rust**.

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)](https://github.com/inrwxyz/inex-island)
[![Backend](https://img.shields.io/badge/Backend-Rust%202021-DEA584?style=flat-square&logo=rust)](https://github.com/inrwxyz/inex-island)
[![Framework](https://img.shields.io/badge/Framework-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v0.3.6-brightgreen?style=flat-square)](https://github.com/inrwxyz/inex-island/releases)

---

## ✨ Highlights & Features

- 📲 **Inex Drop (Google Quick Share Compatible & P2P Link)**:
  - **Native Quick Share Protocol**: Reverse-engineered Google Nearby Connections implemented directly in Rust (`offline_wire_formats`, `securemessage`, and UKEY2 handshake).
  - **Zero App Required on Phone**: Seamlessly send and receive files, videos, and folders with standard Android and Windows Quick Share devices.
  - **Interactive Mode Rail**: Switch instantly between Quick Share and P2P with persistent mode memory (`localStorage`).
  - **Live Controls & Batch Progress**: Pause, resume, and cancel transfers from either the Island Notch HUD or the subview card, with cumulative multi-file batch tracking.
  - **Responsive File & Folder Pickers**: Native Windows OS file dialogs running in clean background STA threads with parent HWND attachment.

- 🏝️ **Dual Island Modes**:
  - **Bezel Notch**: Sits flush with your screen's top bezel.
  - **Floating Island**: Clean, rounded pill floating beneath the top edge.
  - **Fullscreen Awareness**: Automatically hides when gaming or running fullscreen apps.

- ⚡ **Dual P2P Wireless File Drop**:
  - **Firebase Cloud Signaling**: Quick 6-digit room discovery with live 5-minute countdown and multi-peer support (up to 5 PCs).
  - **Serverless Direct 1-on-1 Handshake**: Zero-cloud, completely offline P2P connection using compressed host & reply codes.
  - Streamed chunk-by-chunk to disk to prevent RAM bloat on large transfers.
  - **Mid-Transfer Cancel**: Cancel button (✕) in the island to stop in-flight transfers cleanly.
  - **Clean Room Controls**: Disconnect cleanly at any time with a dedicated Exit Room button.
  - Drag & drop files straight onto the notch or shelf.

- 🎧 **Audio Output Switcher (Native Windows CoreAudio COM)**:
  - 1-click device switching between Speakers, Headphones, and Bluetooth headsets directly from the media player or control center.
  - In-process Windows `IPolicyConfig` COM implementation with 0% terminal overhead.

- 📅 **Interactive Calendar & Pomodoro Focus Timer**:
  - Full interactive monthly calendar with month-by-month navigation and current-day highlights.
  - Standalone Pomodoro Focus Timer with quick presets (5m, 15m, 25m, 45m), live notch countdown, and acoustic chime.

- 📝 **In-Island Quick Notes (Scratchpad)**:
  - Built-in scratchpad widget in quick action tiles.
  - Real-time persistence across reboots, live character counter, and 1-click copy-to-clipboard.

- 🎵 **Universal Media Player (GSMTC) & 5-Band Audio Visualizer**:
  - Universal playback detection via Windows Global System Media Transport Controls (Spotify, YouTube/browsers, Windows Media Player, Apple Music, Deezer, etc.).
  - Direct hardware audio capture through Windows WASAPI Loopback (no virtual audio drivers needed).
  - 512-point Fast Fourier Transform (FFT) with tuned dynamic compensation across all 5 bands.
  - Event-driven ~32ms rendering with **0% idle CPU footprint**.

- ☁️ **Private Firebase Signaling**:
  - Users can connect their own private Firebase Realtime Database URL directly from the Settings menu.
  - Zero third-party cloud data storage — Firebase is strictly used for 5-minute SDP/ICE handshake signaling.

- 🌦️ **Crisp Vector Weather & Hardware Telemetry**:
  - Modern vector SVG weather icons (Sun, Moon, Cloud-Sun, Rain, Storm, Snow) with Open-Meteo API integration.
  - Live CPU, RAM, Disk, and Battery stats on hover and in control views.

- 🔒 **Inex Locker & Biometric Integration**:
  - Native integration with Inex App Locker / Folder Locker.
  - Dynamic unlocking animations (Face, Fingerprint, Password) with automatic priority restoration for running file transfers.

- ⏰ **Clock Alarms & Focus Timer**:
  - Standalone daily and one-time clock alarms with snooze and wake-from-sleep missed alarm detection.
  - Pomodoro Focus countdown timer with acoustic chimes.

- 📥 **Download & System HUD Alerts**:
  - Real-time browser download tracking and finished notification with click-to-open.
  - MagSafe style charging indicator and low-battery warning alerts.
  - Clipboard copy preview HUD.

- ⚡ **P2P File Transfer (AirDrop Style)**:
  - Fast peer-to-peer file transfer with live circular progress rings and delivery toasts.

- 🎛️ **Modular Control Center & Quick Tools**:
  - Wi-Fi network scanner and connection manager.
  - Windows Bluetooth device list and battery telemetry.
  - Quick volume slider with smooth mouse-wheel support.
  - Calendar tab, Quick Notes, and Clipboard history tools.

- 🎨 **Deep Customization**:
  - 14 curated typefaces (*Plus Jakarta Sans, Inter, Poppins, Outfit, Space Grotesk, JetBrains Mono, Doto, Syne, etc.*).
  - Dynamic UI scaling (80% to 140%), notch radius, glass blur, and custom accent colors.
  - Hardened Content Security Policy (CSP).

---

## 🛠️ Architecture & Tech Stack

```
┌────────────────────────────────────────────────────────┐
│                      INEX ISLAND                       │
├──────────────────────────┬─────────────────────────────┤
│  Frontend (WebView2)     │  Backend (Rust / Tauri 2)   │
├──────────────────────────┼─────────────────────────────┤
│ • Hardware-accelerated   │ • WASAPI Loopback Capture   │
│   Vanilla JS & CSS       │ • 512-point rustfft Engine  │
│ • WebRTC DataChannel     │ • Direct Win32 / WMI APIs   │
│ • Modular Architecture   │ • Zero-CLI In-Process IPC   │
│ • Strict CSP Protected   │ • Memory-Safe File Streamer │
└──────────────────────────┴─────────────────────────────┘
```

- **Framework**: Tauri v2
- **Backend**: Rust 2021 (`windows-rs`, `rustfft`, `wmi`, `tauri`)
- **Frontend**: Lightweight ES Modules (21 decoupled modules in `main-parts/`)
- **Signaling**: User-configured Firebase Realtime Database (handshake only)

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [Rust](https://rustup.rs/) (latest stable toolchain)
- Visual Studio C++ Build Tools (with Windows SDK)

### Installation & Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/inrwxyz/inex-island.git
   cd inex-island
   ```

2. **Install frontend dependencies:**
   ```bash
   npm install
   ```

3. **Run in development mode:**
   ```bash
   npm run dev
   ```

4. **Build release installer:**
   ```bash
   npm run build
   ```
   *The NSIS setup installer will be generated in `src-tauri/target/release/bundle/nsis/`.*

5. **Clean build cache:**
   ```bash
   npm run clean
   ```

---

## ☁️ Setting Up P2P File Sharing (Firebase)

Inex Island protects your privacy by allowing you to use your own free Firebase Realtime Database for WebRTC signaling:

1. Create a free project on [Firebase Console](https://console.firebase.google.com/).
2. Create a **Realtime Database** (choose any location, e.g. Singapore / US).
3. Under the **Rules** tab, paste the following rules:
   ```json
   {
     "rules": {
       "rooms": {
         "$code": {
           ".read": true,
           ".write": true
         }
       }
     }
   }
   ```
4. Copy your Realtime Database URL (e.g. `https://your-project.firebasedatabase.app`).
5. In Inex Island, open **Settings → Firebase** and paste your URL.
6. Now you can generate 6-digit codes and share files with up to 5 PCs on your network or across the globe!

---

## 👨‍💻 Author

Created and developed by **[@inrwxyz](https://github.com/inrwxyz)**.

---

## 📄 License

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

See the [LICENSE](LICENSE) file for complete terms and details.
