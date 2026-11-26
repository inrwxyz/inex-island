//! Native Win32 Event Log PC Session History (`wevtapi.dll`).
//! Zero PowerShell, zero child processes, zero persistent RAM — queried strictly on demand.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct PcSession {
    pub start_label: String,
    pub end_label: String,
    pub duration_secs: u64,
    pub status: String, // "Clean" | "Unexpected" | "Sleep" | "Active"
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionHistoryDay {
    pub date: String,
    pub total_secs: u64,
    pub sessions: Vec<PcSession>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RawEventKind {
    Boot,
    Shutdown,
    UnexpectedAt(i64), // local unix seconds extracted from 6008 EventData when available
    Sleep,
    Wake,
}

#[derive(Debug, Clone)]
struct RawEvent {
    local_secs: i64,
    kind: RawEventKind,
}

// ---------------------------------------------------------------- Win32 time helpers

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct WinSystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn SystemTimeToTzSpecificLocalTime(
        tz: *const core::ffi::c_void,
        utc: *const WinSystemTime,
        local: *mut WinSystemTime,
    ) -> i32;
    fn GetLocalTime(st: *mut WinSystemTime);
}

#[cfg(target_os = "windows")]
#[link(name = "wevtapi")]
extern "system" {
    fn EvtQuery(session: isize, path: *const u16, query: *const u16, flags: u32) -> isize;
    fn EvtNext(
        result_set: isize,
        events_size: u32,
        events: *mut isize,
        timeout: u32,
        flags: u32,
        returned: *mut u32,
    ) -> i32;
    fn EvtRender(
        context: isize,
        fragment: isize,
        flags: u32,
        buffer_size: u32,
        buffer: *mut u8,
        buffer_used: *mut u32,
        property_count: *mut u32,
    ) -> i32;
    fn EvtClose(object: isize) -> i32;
}

/// Howard Hinnant's civil-from-days / days-from-civil (exact UTC/local wall-clock seconds).
fn ymd_hms_to_secs(y: i32, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> i64 {
    let mut y64 = y as i64;
    if m <= 2 {
        y64 -= 1;
    }
    let era = if y64 >= 0 { y64 } else { y64 - 399 } / 400;
    let yoe = y64 - era * 400;
    let m_adj = if m > 2 { m as i64 - 3 } else { m as i64 + 9 };
    let doy = (153 * m_adj + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days * 86_400 + (hh as i64) * 3_600 + (mm as i64) * 60 + ss as i64
}

fn secs_to_ymd_hms(epoch_secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = epoch_secs.div_euclid(86_400);
    let rem = epoch_secs.rem_euclid(86_400) as u32;
    let hh = rem / 3_600;
    let mm = (rem % 3_600) / 60;
    let ss = rem % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32, hh, mm, ss)
}

fn fmt_date(epoch_secs: i64) -> String {
    let (y, m, d, _, _, _) = secs_to_ymd_hms(epoch_secs);
    format!("{y:04}-{m:02}-{d:02}")
}

fn fmt_time_12h(epoch_secs: i64) -> String {
    let (_, _, _, hh, mm, _) = secs_to_ymd_hms(epoch_secs);
    let suffix = if hh >= 12 { "PM" } else { "AM" };
    let h12 = match hh % 12 {
        0 => 12,
        v => v,
    };
    format!("{h12:02}:{mm:02} {suffix}")
}

#[cfg(target_os = "windows")]
fn utc_to_local_secs(utc: &WinSystemTime) -> i64 {
    let mut local = WinSystemTime::default();
    let ok = unsafe { SystemTimeToTzSpecificLocalTime(core::ptr::null(), utc, &mut local) };
    let st = if ok != 0 { &local } else { utc };
    ymd_hms_to_secs(
        st.year as i32,
        st.month as u32,
        st.day as u32,
        st.hour as u32,
        st.minute as u32,
        st.second as u32,
    )
}

#[cfg(not(target_os = "windows"))]
fn utc_to_local_secs(utc: &WinSystemTime) -> i64 {
    ymd_hms_to_secs(
        utc.year as i32,
        utc.month as u32,
        utc.day as u32,
        utc.hour as u32,
        utc.minute as u32,
        utc.second as u32,
    )
}

#[cfg(target_os = "windows")]
fn now_local_secs() -> i64 {
    let mut st = WinSystemTime::default();
    unsafe { GetLocalTime(&mut st) };
    ymd_hms_to_secs(
        st.year as i32,
        st.month as u32,
        st.day as u32,
        st.hour as u32,
        st.minute as u32,
        st.second as u32,
    )
}

#[cfg(not(target_os = "windows"))]
fn now_local_secs() -> i64 {
    0
}

// ---------------------------------------------------------------- XML extractors

fn extract_tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let pos = xml.find(&open)?;
    let after_tag = &xml[pos + open.len()..];
    let gt = after_tag.find('>')?;
    let rest = &after_tag[gt + 1..];
    let close = format!("</{tag}>");
    let end = rest.find(&close)?;
    Some(rest[..end].trim())
}

fn extract_attr<'a>(xml: &'a str, attr: &str) -> Option<&'a str> {
    for quote in ['\'', '"'] {
        let needle = format!("{attr}={quote}");
        if let Some(pos) = xml.find(&needle) {
            let start = pos + needle.len();
            if let Some(end) = xml[start..].find(quote) {
                return Some(&xml[start..start + end]);
            }
        }
    }
    None
}

fn parse_iso_utc(s: &str) -> Option<WinSystemTime> {
    // Format: 2026-11-26T01:11:30.5000000Z
    if s.len() < 19 {
        return None;
    }
    Some(WinSystemTime {
        year: s.get(0..4)?.parse().ok()?,
        month: s.get(5..7)?.parse().ok()?,
        day: s.get(8..10)?.parse().ok()?,
        hour: s.get(11..13)?.parse().ok()?,
        minute: s.get(14..16)?.parse().ok()?,
        second: s.get(17..19)?.parse().ok()?,
        ..Default::default()
    })
}

fn parse_6008_data_timestamp(xml: &str) -> Option<i64> {
    // <EventData><Data>16:00:08</Data><Data>‎25/‎11/‎2026</Data>...
    let ed_start = xml.find("<EventData")?;
    let sub = &xml[ed_start..];
    let d1_start = sub.find("<Data>")? + 6;
    let d1_end = sub[d1_start..].find("</Data>")?;
    let time_raw: String = sub[d1_start..d1_start + d1_end]
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == ':')
        .collect();

    let after_d1 = &sub[d1_start + d1_end + 7..];
    let d2_start = after_d1.find("<Data>")? + 6;
    let d2_end = after_d1[d2_start..].find("</Data>")?;
    let date_raw: String = after_d1[d2_start..d2_start + d2_end]
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '/' || *c == '-')
        .collect();

    let mut t_parts = time_raw.split(':');
    let hh: u32 = t_parts.next()?.parse().ok()?;
    let mm: u32 = t_parts.next()?.parse().ok()?;
    let ss: u32 = t_parts.next()?.parse().ok()?;

    let d_parts: Vec<&str> = date_raw.split(['/', '-']).collect();
    if d_parts.len() != 3 {
        return None;
    }
    let (year, month, day) = if d_parts[0].len() == 4 {
        (
            d_parts[0].parse::<i32>().ok()?,
            d_parts[1].parse::<u32>().ok()?,
            d_parts[2].parse::<u32>().ok()?,
        )
    } else {
        (
            d_parts[2].parse::<i32>().ok()?,
            d_parts[1].parse::<u32>().ok()?,
            d_parts[0].parse::<u32>().ok()?,
        )
    };
    Some(ymd_hms_to_secs(year, month, day, hh, mm, ss))
}

fn parse_event_xml(xml: &str) -> Option<RawEvent> {
    let id: u32 = extract_tag_text(xml, "EventID")?.parse().ok()?;
    let sys_time = extract_attr(xml, "SystemTime").and_then(parse_iso_utc)?;
    let local_secs = utc_to_local_secs(&sys_time);
    let kind = match id {
        12 => RawEventKind::Boot,
        13 => RawEventKind::Shutdown,
        42 => RawEventKind::Sleep,
        107 => RawEventKind::Wake,
        6008 => {
            let at = parse_6008_data_timestamp(xml).unwrap_or(local_secs);
            RawEventKind::UnexpectedAt(at)
        }
        _ => return None,
    };
    Some(RawEvent { local_secs, kind })
}

// ---------------------------------------------------------------- Win32 query

#[cfg(target_os = "windows")]
fn query_system_events_30d() -> Vec<RawEvent> {
    const EVT_QUERY_CHANNEL_PATH: u32 = 0x1;
    const EVT_QUERY_FORWARD: u32 = 0x100;
    const EVT_RENDER_EVENT_XML: u32 = 1;
    const BATCH: usize = 64;

    let channel: Vec<u16> = "System\0".encode_utf16().collect();
    let xpath = "*[System[((Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=12 or EventID=13)) or (Provider[@Name='EventLog'] and EventID=6008) or (Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=42 or EventID=107))) and TimeCreated[timediff(@SystemTime) <= 2592000000]]]\0";
    let query: Vec<u16> = xpath.encode_utf16().collect();

    let h_query = unsafe { EvtQuery(0, channel.as_ptr(), query.as_ptr(), EVT_QUERY_CHANNEL_PATH | EVT_QUERY_FORWARD) };
    if h_query == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut handles = [0isize; BATCH];
    let mut buf: Vec<u8> = vec![0u8; 4096];

    loop {
        let mut returned = 0u32;
        let ok = unsafe { EvtNext(h_query, BATCH as u32, handles.as_mut_ptr(), 2000, 0, &mut returned) };
        if ok == 0 || returned == 0 {
            break;
        }
        for &h in &handles[..returned as usize] {
            if h != 0 {
                let mut used = 0u32;
                let mut count = 0u32;
                let rendered = unsafe {
                    EvtRender(0, h, EVT_RENDER_EVENT_XML, buf.len() as u32, buf.as_mut_ptr(), &mut used, &mut count)
                };
                if rendered == 0 && (used as usize) > buf.len() {
                    buf.resize(used as usize + 64, 0);
                    let _ = unsafe {
                        EvtRender(0, h, EVT_RENDER_EVENT_XML, buf.len() as u32, buf.as_mut_ptr(), &mut used, &mut count)
                    };
                }
                if used >= 2 {
                    let u16_len = (used as usize / 2).min(buf.len() / 2);
                    let slice: &[u16] = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u16, u16_len) };
                    let trim = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
                    let xml = String::from_utf16_lossy(&slice[..trim]);
                    if let Some(ev) = parse_event_xml(&xml) {
                        out.push(ev);
                    }
                }
                unsafe { let _ = EvtClose(h); }
            }
        }
    }

    unsafe { let _ = EvtClose(h_query); }
    out
}

#[cfg(not(target_os = "windows"))]
fn query_system_events_30d() -> Vec<RawEvent> {
    Vec::new()
}

// ---------------------------------------------------------------- pairing & splitting

fn push_interval_split_days(
    days: &mut BTreeMap<String, Vec<PcSession>>,
    start_s: i64,
    end_s: i64,
    status: &str,
) {
    if end_s <= start_s {
        return;
    }
    let mut cur = start_s;
    while cur < end_s {
        let day_start = cur - cur.rem_euclid(86_400);
        let next_day = day_start + 86_400;
        let seg_end = end_s.min(next_day);
        let dur = (seg_end - cur) as u64;
        if dur >= 1 {
            let end_label = if status == "Active" && seg_end == end_s {
                "Now".to_string()
            } else if seg_end == next_day && seg_end < end_s {
                "11:59 PM".to_string()
            } else {
                fmt_time_12h(seg_end)
            };
            days.entry(fmt_date(cur)).or_default().push(PcSession {
                start_label: fmt_time_12h(cur),
                end_label,
                duration_secs: dur,
                status: status.to_string(),
            });
        }
        cur = seg_end;
    }
}

fn build_days_from_events(mut events: Vec<RawEvent>, now_secs: i64) -> Vec<SessionHistoryDay> {
    events.sort_by_key(|e| e.local_secs);
    let mut days: BTreeMap<String, Vec<PcSession>> = BTreeMap::new();
    let mut open_start: Option<i64> = None;

    for i in 0..events.len() {
        let ev = &events[i];
        match ev.kind {
            RawEventKind::Boot | RawEventKind::Wake => {
                if let Some(prev_start) = open_start {
                    // Unclosed previous session: check if a 6008 unexpected shutdown follows within 2 mins
                    let mut unexpected_end = None;
                    for next in &events[i + 1..] {
                        if next.local_secs > ev.local_secs + 120 {
                            break;
                        }
                        if let RawEventKind::UnexpectedAt(ts) = next.kind {
                            if ts > prev_start && ts <= ev.local_secs {
                                unexpected_end = Some(ts);
                            }
                            break;
                        }
                    }
                    let end_s = unexpected_end.unwrap_or(ev.local_secs);
                    let st = if unexpected_end.is_some() { "Unexpected" } else { "Clean" };
                    push_interval_split_days(&mut days, prev_start, end_s, st);
                }
                open_start = Some(ev.local_secs);
            }
            RawEventKind::Shutdown => {
                if let Some(st) = open_start.take() {
                    push_interval_split_days(&mut days, st, ev.local_secs, "Clean");
                }
            }
            RawEventKind::Sleep => {
                if let Some(st) = open_start.take() {
                    push_interval_split_days(&mut days, st, ev.local_secs, "Sleep");
                }
            }
            RawEventKind::UnexpectedAt(ts) => {
                if let Some(st) = open_start {
                    if ts > st && ts <= ev.local_secs {
                        push_interval_split_days(&mut days, st, ts, "Unexpected");
                        open_start = None;
                    }
                }
            }
        }
    }

    if let Some(st) = open_start {
        if now_secs > st {
            push_interval_split_days(&mut days, st, now_secs, "Active");
        }
    }

    days.into_iter()
        .map(|(date, mut sessions)| {
            // Newest session first inside the day list for readability, or chronological? Chronological keeps clear timeline.
            sessions.reverse();
            let total_secs = sessions.iter().map(|s| s.duration_secs).sum();
            SessionHistoryDay {
                date,
                total_secs,
                sessions,
            }
        })
        .collect()
}

#[tauri::command]
pub fn get_pc_session_history() -> Vec<SessionHistoryDay> {
    let events = query_system_events_30d();
    build_days_from_events(events, now_local_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_pairs_unexpected_shutdown_and_splits_midnight() {
        let b1 = ymd_hms_to_secs(2026, 11, 25, 23, 30, 0);
        let s1 = ymd_hms_to_secs(2026, 11, 26, 1, 0, 0);
        let b2 = ymd_hms_to_secs(2026, 11, 26, 6, 41, 30);
        let now = ymd_hms_to_secs(2026, 11, 26, 8, 20, 0);

        let xml_boot = "<Event><System><Provider Name='Microsoft-Windows-Kernel-General'/><EventID>12</EventID><TimeCreated SystemTime='2026-11-26T01:11:30.500Z'/></System></Event>";
        assert!(parse_event_xml(xml_boot).is_some());

        let xml_6008 = "<Event><System><Provider Name='EventLog'/><EventID>6008</EventID><TimeCreated SystemTime='2026-11-25T11:33:56.000Z'/></System><EventData><Data>16:00:08</Data><Data>\u{200e}25/\u{200e}11/\u{200e}2026</Data></EventData></Event>";
        let ev6008 = parse_event_xml(xml_6008).unwrap();
        assert_eq!(ev6008.kind, RawEventKind::UnexpectedAt(ymd_hms_to_secs(2026, 11, 25, 16, 0, 8)));

        let days = build_days_from_events(
            vec![
                RawEvent { local_secs: b1, kind: RawEventKind::Boot },
                RawEvent { local_secs: s1, kind: RawEventKind::Shutdown },
                RawEvent { local_secs: b2, kind: RawEventKind::Boot },
            ],
            now,
        );
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].date, "2026-11-25");
        assert_eq!(days[0].total_secs, 1800);
        assert_eq!(days[1].date, "2026-11-26");
        assert_eq!(days[1].sessions.len(), 2);
        assert_eq!(days[1].sessions[0].status, "Active");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn native_wevtapi_queries_real_system_sessions_without_powershell() {
        let hist = get_pc_session_history();
        // Verify we returned structured history quickly with today's running session
        assert!(!hist.is_empty());
        assert!(hist.iter().any(|d| d.sessions.iter().any(|s| s.status == "Active")));
    }
}
