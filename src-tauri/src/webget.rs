//! Tiny HTTPS GET for the Control Deck widgets (currency rates, markets).
//! Uses curl.exe (ships with Windows 10 1803+ / 11), so no new Rust dependency and no browser CORS problems.
//! Only a fixed list of hosts is allowed.

const ALLOWED_HOSTS: [&str; 3] = ["open.er-api.com", "api.coingecko.com", "query1.finance.yahoo.com"];

fn host_ok(url: &str) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    ALLOWED_HOSTS.contains(&host)
}

#[tauri::command]
pub async fn http_get(url: String) -> Result<String, String> {
    if !host_ok(&url) {
        return Err("host not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::process::Command;
        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("curl.exe");
        c.args([
            "-s",
            "--max-time",
            "8",
            "--max-filesize",
            "1000000",
            "-A",
            "Mozilla/5.0",
            "-H",
            "Accept: application/json",
            url.as_str(),
        ]);
        #[cfg(target_os = "windows")]
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let out = c.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("curl failed ({:?})", out.status.code()));
        }
        String::from_utf8(out.stdout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::host_ok;

    #[test]
    fn allows_only_whitelisted_https_hosts() {
        assert!(host_ok("https://open.er-api.com/v6/latest/USD"));
        assert!(host_ok("https://api.coingecko.com/api/v3/simple/price"));
        assert!(host_ok("https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=1d"));
    }

    #[test]
    fn rejects_non_https_and_unknown_or_spoofed_hosts() {
        assert!(!host_ok("http://open.er-api.com/v6/latest/USD"));
        assert!(!host_ok("https://evil.example.com/open.er-api.com"));
        assert!(!host_ok("https://open.er-api.com.evil.com/x"));
        assert!(!host_ok("file:///C:/Windows/win.ini"));
    }
}
