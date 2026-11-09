//! Single owner of stdin.
//!
//! One background thread reads every line you type and forwards it into a channel.
//! Prompts (`read_line`) and live transfer commands (`try_line`: p / r / c) both take
//! lines from that channel, so they never fight over stdin.

use std::sync::OnceLock;
use tokio::sync::{mpsc, Mutex};

struct ConsoleChannel {
    tx: mpsc::UnboundedSender<String>,
    rx: Mutex<mpsc::UnboundedReceiver<String>>,
}

fn get_channel() -> &'static ConsoleChannel {
    static CHAN: OnceLock<ConsoleChannel> = OnceLock::new();
    CHAN.get_or_init(|| {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        ConsoleChannel {
            tx,
            rx: Mutex::new(rx),
        }
    })
}

/// Call once at program start (optional: also reads stdin if running in a console).
pub fn init() {
    let chan = get_channel();
    let tx = chan.tx.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        loop {
            let mut line = String::new();
            match stdin.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let cleaned = line.trim_end_matches(|c| c == '\r' || c == '\n').to_string();
                    if tx.send(cleaned).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// Lets the UI "type" a line (y / n / p / r / c) exactly as if it came from the keyboard.
pub fn inject(line: &str) {
    let chan = get_channel();
    let _ = chan.tx.send(line.to_string());
}

/// Waits for the next line you type (a prompt).
pub async fn read_line() -> Option<String> {
    let chan = get_channel();
    let mut rx = chan.rx.lock().await;
    rx.recv().await
}

/// Non-blocking: returns a line only if one is already waiting (used for p / r / c during a transfer).
pub fn try_line() -> Option<String> {
    let chan = get_channel();
    let mut rx = chan.rx.try_lock().ok()?;
    rx.try_recv().ok()
}

/// Throws away anything typed earlier (so an old Enter press is not taken as an answer).
pub fn drain() {
    while try_line().is_some() {}
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Pause,
    Resume,
    Cancel,
    Other,
}

pub fn parse_command(line: &str) -> Command {
    match line.trim().to_lowercase().as_str() {
        "p" | "pause" => Command::Pause,
        "r" | "resume" => Command::Resume,
        "c" | "cancel" | "x" => Command::Cancel,
        _ => Command::Other,
    }
}
