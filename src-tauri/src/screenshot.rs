//! macOS screenshot capture — lets Bugyo feed a screenshot of the running app
//! into a session (Codex-style) as an ACP image content block, without an MCP
//! server. See `docs/acp-notes.md` ("Image prompts") for the verified wire
//! format the block is injected into.
//!
//! Capture uses the system `screencapture(1)` with explicit args (never a shell
//! string). It is a blocking subprocess call — callers on the async runtime
//! must run it via `spawn_blocking`.
//!
//! Requires the **Screen Recording** permission (System Settings → Privacy &
//! Security → Screen Recording) for the capturing process; without it macOS
//! yields desktop-only pixels rather than window contents.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// Errors from screenshot capture.
#[derive(Debug, thiserror::Error)]
pub enum ScreenshotError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("screencapture failed (exit {code}): {stderr}")]
    Capture { code: i32, stderr: String },
    #[error("screenshots are only supported on macOS")]
    Unsupported,
    #[error("invalid region {0:?} (expected \"x,y,w,h\")")]
    InvalidRegion(String),
    #[error("invalid temp path")]
    InvalidPath,
}

/// A rectangular capture region in screen points: `x,y,w,h`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub x: i64,
    pub y: i64,
    pub w: u32,
    pub h: u32,
}

impl Region {
    /// Parse `"x,y,w,h"` (as accepted by `screencapture -R`).
    pub fn parse(s: &str) -> Result<Region, ScreenshotError> {
        let parts: Vec<&str> = s.split(',').map(str::trim).collect();
        if parts.len() != 4 {
            return Err(ScreenshotError::InvalidRegion(s.to_string()));
        }
        let err = || ScreenshotError::InvalidRegion(s.to_string());
        Ok(Region {
            x: parts[0].parse().map_err(|_| err())?,
            y: parts[1].parse().map_err(|_| err())?,
            w: parts[2].parse().map_err(|_| err())?,
            h: parts[3].parse().map_err(|_| err())?,
        })
    }
}

/// What to capture. With no field set, captures the full main display.
/// Precedence: `region` > `window_id` > `display` > full screen.
#[derive(Debug, Clone, Default)]
pub struct ScreenshotOpts {
    /// Capture a specific display (`-D`, 1 = main).
    pub display: Option<u32>,
    /// Capture an explicit rectangle (`-R x,y,w,h`).
    pub region: Option<Region>,
    /// Capture a specific window by CoreGraphics window id (`-l`).
    pub window_id: Option<u32>,
}

/// A captured image, ready to inject as an ACP image content block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedImage {
    /// Always `image/png`.
    pub mime_type: String,
    /// Base64-encoded PNG bytes.
    pub data_base64: String,
    /// Raw (pre-encoding) byte length, for logging/telemetry.
    pub bytes: usize,
}

/// Build the `screencapture` argv (excluding the program name), ending in
/// `out_path`. Pure and deterministic so it can be unit-tested offline.
///
/// Base flags: `-x` (silent, no camera sound) and `-t png`.
pub fn build_args(opts: &ScreenshotOpts, out_path: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["-x".into(), "-t".into(), "png".into()];
    if let Some(r) = &opts.region {
        args.push("-R".into());
        args.push(format!("{},{},{},{}", r.x, r.y, r.w, r.h));
    } else if let Some(id) = opts.window_id {
        // `-l <id>` captures a specific window; `-o` drops the drop-shadow so
        // the image is tightly cropped to the window.
        args.push("-l".into());
        args.push(id.to_string());
        args.push("-o".into());
    } else if let Some(d) = opts.display {
        args.push(format!("-D{d}"));
    }
    args.push(out_path.to_string());
    args
}

/// Capture a screenshot and return it base64-encoded. Blocking (spawns
/// `screencapture`); call via `spawn_blocking` on the async runtime.
pub fn capture(opts: &ScreenshotOpts) -> Result<CapturedImage, ScreenshotError> {
    if !cfg!(target_os = "macos") {
        return Err(ScreenshotError::Unsupported);
    }

    let out_path = unique_temp_path();
    let out_str = out_path.to_str().ok_or(ScreenshotError::InvalidPath)?;
    let args = build_args(opts, out_str);

    let output = Command::new("screencapture").args(&args).output()?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&out_path);
        return Err(ScreenshotError::Capture {
            code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    let data = std::fs::read(&out_path)?;
    // Best-effort cleanup; a leftover temp file is not fatal.
    let _ = std::fs::remove_file(&out_path);

    Ok(CapturedImage {
        mime_type: "image/png".to_string(),
        data_base64: base64_encode(&data),
        bytes: data.len(),
    })
}

/// Resolve the CoreGraphics window number of a Cocoa `NSWindow` (the pointer
/// returned by Tauri's `WebviewWindow::ns_window()`), for window-scoped capture
/// (`screencapture -l <id>`). Returns `None` on a null pointer.
///
/// This is how the screenshot button/command defaults to capturing *Bugyo's
/// own window* instead of the whole screen — keeping the image focused, cheap,
/// and free of unrelated on-screen content.
#[cfg(target_os = "macos")]
pub fn ns_window_number(ns_window: *mut std::ffi::c_void) -> Option<u32> {
    if ns_window.is_null() {
        return None;
    }
    // SAFETY: `ns_window` is a valid `NSWindow*` obtained from Tauri's
    // `WebviewWindow::ns_window()`. `-[NSWindow windowNumber]` takes no
    // arguments and returns an `NSInteger`; the window outlives this
    // synchronous message send.
    let number: isize = unsafe {
        let obj: *mut objc2::runtime::AnyObject = ns_window.cast();
        objc2::msg_send![obj, windowNumber]
    };
    u32::try_from(number).ok()
}

/// Non-macOS stub: window-number resolution is macOS-only.
#[cfg(not(target_os = "macos"))]
pub fn ns_window_number(_ns_window: *mut std::ffi::c_void) -> Option<u32> {
    None
}

/// A process-unique temp path for the capture output.
fn unique_temp_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("bugyo-shot-{}-{n}-{nanos}.png", std::process::id()))
}

/// Standard base64 (RFC 4648) with padding. Dependency-free to avoid adding a
/// crate for one small, well-specified function; verified against known vectors
/// in the tests below.
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // The canonical RFC 4648 §10 test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_encodes_binary_bytes() {
        assert_eq!(base64_encode(&[0x00]), "AA==");
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }

    #[test]
    fn full_screen_args_default() {
        assert_eq!(
            build_args(&ScreenshotOpts::default(), "/tmp/x.png"),
            vec!["-x", "-t", "png", "/tmp/x.png"]
        );
    }

    #[test]
    fn region_args() {
        let opts = ScreenshotOpts {
            region: Some(Region {
                x: 10,
                y: 20,
                w: 300,
                h: 400,
            }),
            ..Default::default()
        };
        assert_eq!(
            build_args(&opts, "/tmp/x.png"),
            vec!["-x", "-t", "png", "-R", "10,20,300,400", "/tmp/x.png"]
        );
    }

    #[test]
    fn window_args_drop_shadow() {
        let opts = ScreenshotOpts {
            window_id: Some(42),
            ..Default::default()
        };
        assert_eq!(
            build_args(&opts, "/tmp/x.png"),
            vec!["-x", "-t", "png", "-l", "42", "-o", "/tmp/x.png"]
        );
    }

    #[test]
    fn display_args() {
        let opts = ScreenshotOpts {
            display: Some(2),
            ..Default::default()
        };
        assert_eq!(
            build_args(&opts, "/tmp/x.png"),
            vec!["-x", "-t", "png", "-D2", "/tmp/x.png"]
        );
    }

    #[test]
    fn region_takes_precedence_over_window_and_display() {
        let opts = ScreenshotOpts {
            display: Some(1),
            window_id: Some(7),
            region: Some(Region {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            }),
        };
        assert_eq!(
            build_args(&opts, "/tmp/x.png"),
            vec!["-x", "-t", "png", "-R", "0,0,1,1", "/tmp/x.png"]
        );
    }

    #[test]
    fn region_parse_ok_and_errors() {
        assert_eq!(
            Region::parse("1,2,3,4").unwrap(),
            Region {
                x: 1,
                y: 2,
                w: 3,
                h: 4
            }
        );
        assert_eq!(Region::parse(" 10, 20, 30, 40 ").unwrap().w, 30);
        assert!(Region::parse("1,2,3").is_err());
        assert!(Region::parse("a,b,c,d").is_err());
        assert!(Region::parse("").is_err());
    }

    #[test]
    fn ns_window_number_null_is_none() {
        assert_eq!(ns_window_number(std::ptr::null_mut()), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires an interactive macOS display"]
    fn capture_full_screen_produces_png() {
        // Live integration: exercises the real `screencapture`. Headless and
        // background desktop sessions can have no capturable display, so keep
        // this out of the deterministic default suite.
        let img = capture(&ScreenshotOpts::default()).expect("capture");
        assert_eq!(img.mime_type, "image/png");
        assert!(img.bytes > 0);
        // PNG magic (\x89PNG) base64-encodes with the "iVBORw0KGgo" prefix.
        assert!(
            img.data_base64.starts_with("iVBORw0KGgo"),
            "expected PNG magic prefix, got {}",
            &img.data_base64[..img.data_base64.len().min(16)]
        );
    }
}
