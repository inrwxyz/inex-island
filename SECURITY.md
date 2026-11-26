# Security Policy & Threat Model

## Security Posture

Inex Island runs locally on Windows as a single-user desktop utility. It operates with a zero-cloud architecture:

- **Local Storage Only**: User preferences are persisted in local `localStorage` (`inex.settings.v1`, `inex.alarms.v1`). Screen Time metrics and cached application icons are stored strictly under the local application data directory (`%LOCALAPPDATA%`).
- **No Telemetry or Remote Accounts**: There are no analytics SDKs, background update pings beyond explicit Tauri updater checks when enabled by the user, or external accounts.

## Security Controls in Codebase

1. **Strict Outbound HTTPS Allowlist (`src-tauri/src/webget.rs`)**:
   - The Rust `http_get` proxy command validates that every requested URL starts with `https://` and matches an exact allowlisted host (`open.er-api.com`, `api.coingecko.com`, `query1.finance.yahoo.com`) before invoking `curl.exe` without a shell.
2. **Safe URL & Browser Launching (`src-tauri/src/actions.rs`, `src-tauri/src/spotlight.rs`)**:
   - `open_url` and `spotlight_open` enforce `is_safe_web_url()`, rejecting any non-`http://`/`https://` scheme (e.g., `file://`, `javascript:`, `ms-msdt:`) and rejecting control characters (`\r`, `\n`, `\0`) before handing off to `ShellExecuteW` or a verified browser binary.
3. **XSS / DOM Injection Hardening (`src/js/`)**:
   - Dynamic user-supplied or OS-supplied strings rendered into DOM markup (clipboard history snippets, app names, icon URLs, Spotlight browser names) are sanitized via HTML escaping (`esc`, `escHtml`) or written directly through `.textContent`.
4. **Local File Handling (`src-tauri/src/net.rs`, `src-tauri/src/clipboard.rs`)**:
   - Incoming transfer filenames are sanitized (`clean_name`) against path traversal separators (`..`, `/`, `\`) and written with collision-safe unique naming (`unique_dest`).
5. **Memory & Panic Discipline in Rust**:
   - Mutex acquisitions prefer poison recovery (`.unwrap_or_else(|e| e.into_inner())`) or structured `Result`/`Option` error propagation, and non-`quick_share` crates pass `cargo clippy -- -D warnings`.

## Reporting a Vulnerability

If you discover a security vulnerability in Inex Island (such as an unsafe IPC command, XSS vector in WebView2 templates, path traversal in file transfer, or privilege issue):

1. Please avoid disclosing unpatched exploit details publicly on GitHub Issues.
2. Open a private security advisory on the GitHub repository (`Security -> Advisories -> Report a vulnerability`) or contact the maintainer directly via GitHub (`@inrwxyz`).
3. Include steps to reproduce, affected version, and proof-of-concept details if available.
