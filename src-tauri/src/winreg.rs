// Windows' own registry API (advapi32) for the HKCU keys the app needs. Replaces reg.exe.
#![cfg(target_os = "windows")]

use std::ffi::c_void;

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        hkey: isize,
        sub_key: *const u16,
        reserved: u32,
        class: *const u16,
        options: u32,
        sam: u32,
        security: *const c_void,
        result: *mut isize,
        disposition: *mut u32,
    ) -> i32;
    fn RegOpenKeyExW(hkey: isize, sub_key: *const u16, options: u32, sam: u32, result: *mut isize) -> i32;
    fn RegSetValueExW(hkey: isize, name: *const u16, reserved: u32, kind: u32, data: *const u8, len: u32) -> i32;
    fn RegQueryValueExW(
        hkey: isize,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        len: *mut u32,
    ) -> i32;
    fn RegDeleteValueW(hkey: isize, name: *const u16) -> i32;
    fn RegCloseKey(hkey: isize) -> i32;
}

// HKEY_CURRENT_USER is the sign-extended 0x80000001
const HKCU: isize = 0x8000_0001u32 as i32 as isize;
const KEY_QUERY_VALUE: u32 = 0x0001;
const KEY_SET_VALUE: u32 = 0x0002;
const REG_SZ: u32 = 1;
const REG_EXPAND_SZ: u32 = 2;
const REG_BINARY: u32 = 3;
const ERROR_SUCCESS: i32 = 0;
const ERROR_FILE_NOT_FOUND: i32 = 2;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn set_raw(subkey: &str, name: &str, kind: u32, data: &[u8]) -> bool {
    unsafe {
        let sk = wide(subkey);
        let nm = wide(name);
        let mut h: isize = 0;
        if RegCreateKeyExW(HKCU, sk.as_ptr(), 0, std::ptr::null(), 0, KEY_SET_VALUE, std::ptr::null(), &mut h, std::ptr::null_mut())
            != ERROR_SUCCESS
        {
            return false;
        }
        let rc = RegSetValueExW(h, nm.as_ptr(), 0, kind, data.as_ptr(), data.len() as u32);
        RegCloseKey(h);
        rc == ERROR_SUCCESS
    }
}

/// Writes a REG_SZ value (the key is created when it does not exist yet).
pub fn set_string(subkey: &str, name: &str, value: &str) -> bool {
    let w = wide(value);
    let bytes: Vec<u8> = w.iter().flat_map(|c| c.to_le_bytes()).collect();
    set_raw(subkey, name, REG_SZ, &bytes)
}

/// Writes a REG_BINARY value.
pub fn set_binary(subkey: &str, name: &str, data: &[u8]) -> bool {
    set_raw(subkey, name, REG_BINARY, data)
}

/// Reads a REG_SZ / REG_EXPAND_SZ value. None when the key or the value is missing.
pub fn get_string(subkey: &str, name: &str) -> Option<String> {
    unsafe {
        let sk = wide(subkey);
        let nm = wide(name);
        let mut h: isize = 0;
        if RegOpenKeyExW(HKCU, sk.as_ptr(), 0, KEY_QUERY_VALUE, &mut h) != ERROR_SUCCESS {
            return None;
        }
        let mut kind: u32 = 0;
        let mut len: u32 = 0;
        let mut out = None;
        if RegQueryValueExW(h, nm.as_ptr(), std::ptr::null_mut(), &mut kind, std::ptr::null_mut(), &mut len) == ERROR_SUCCESS
            && (kind == REG_SZ || kind == REG_EXPAND_SZ)
        {
            let mut buf = vec![0u8; len as usize + 2];
            let mut len2 = len;
            if RegQueryValueExW(h, nm.as_ptr(), std::ptr::null_mut(), &mut kind, buf.as_mut_ptr(), &mut len2) == ERROR_SUCCESS {
                let u: Vec<u16> = buf[..len2 as usize]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .take_while(|&c| c != 0)
                    .collect();
                out = Some(String::from_utf16_lossy(&u));
            }
        }
        RegCloseKey(h);
        out
    }
}

/// Deletes a value. A value (or key) that is already gone counts as success.
pub fn delete_value(subkey: &str, name: &str) -> bool {
    unsafe {
        let sk = wide(subkey);
        let nm = wide(name);
        let mut h: isize = 0;
        let rc = RegOpenKeyExW(HKCU, sk.as_ptr(), 0, KEY_SET_VALUE, &mut h);
        if rc == ERROR_FILE_NOT_FOUND {
            return true;
        }
        if rc != ERROR_SUCCESS {
            return false;
        }
        let rc = RegDeleteValueW(h, nm.as_ptr());
        RegCloseKey(h);
        rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND
    }
}
