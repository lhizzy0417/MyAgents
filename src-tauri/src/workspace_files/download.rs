//! Download a workspace file as raw bytes for the preview-image flow.
//!
//! Returns base64 + mime + filename so the renderer can reconstruct a Blob and
//! object URL. We deliberately do NOT stream — the only caller is
//! DirectoryPanel's image-preview modal, which renders a single image at a
//! time, and we cap at 25MB (picture from a photo library is usually < 10MB
//! anyway). Larger payloads should not be loaded into the preview modal at
//! all and the caller should prompt the user to "Open with default app".

use std::fs;
use std::io::Read;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;

use super::path_safety::{resolve_existing_inside_workspace, validate_workspace_root};

const MAX_DOWNLOAD_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub name: String,
    pub mime_type: String,
    /// Base64-encoded body — frontend reconstructs Blob via `atob`.
    pub data: String,
}

#[tauri::command]
pub async fn cmd_workspace_download_file(
    workspace: String,
    path: String,
) -> Result<DownloadResult, String> {
    if path.trim().is_empty() {
        return Err("Missing path".to_string());
    }
    let workspace_root = validate_workspace_root(&workspace)?;
    // Phase D.5: canonicalize-and-prefix-check blocks symlink escape via
    // `evil_link → /etc/...`. download.rs returns raw bytes; without this
    // a malicious repo could exfiltrate arbitrary files via the preview UI.
    let resolved = resolve_existing_inside_workspace(&workspace_root, &path)?;

    let metadata = fs::metadata(&resolved).map_err(|_| "File not found".to_string())?;
    if !metadata.is_file() {
        return Err("Not a regular file".to_string());
    }
    if metadata.len() > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "File too large to preview (max {} MB)",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }

    // Bounded read — TOCTOU between metadata.len() above and the read here:
    // file may grow under us. Cap the read at MAX+1 bytes; if we hit MAX+1
    // we know the size check raced and we reject. Avoids the
    // unbounded-Vec<u8> growth path the cross-review flagged.
    let mut file = fs::File::open(&resolved).map_err(|e| format!("Open failed: {}", e))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let read_cap = MAX_DOWNLOAD_BYTES + 1;
    file.by_ref()
        .take(read_cap)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Read failed: {}", e))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "File too large to preview (max {} MB)",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    Ok(DownloadResult {
        name,
        mime_type: sniff_mime(&ext),
        data: BASE64.encode(&bytes),
    })
}

/// Tiny MIME sniffer covering image / common preview cases. Sidecar's
/// `sniffMime` is similarly hand-rolled (`src/server/utils/file-response.ts`);
/// for download-to-preview we only ever return images (DirectoryPanel preview
/// modal), so the table is intentionally short. Fall back to octet-stream so
/// the renderer never gets `undefined`.
fn sniff_mime(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;

    #[tokio::test]
    async fn downloads_file_as_b64() {
        let ws = make_test_workspace("download_ok");
        fs::write(ws.join("pic.png"), b"\x89PNG\r\n").unwrap();
        let res = cmd_workspace_download_file(
            ws.to_string_lossy().to_string(),
            "pic.png".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(res.name, "pic.png");
        assert_eq!(res.mime_type, "image/png");
        assert!(!res.data.is_empty());
        let decoded = BASE64.decode(&res.data).unwrap();
        assert_eq!(decoded, b"\x89PNG\r\n");
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_oversize() {
        // Cross-review fix: the previous version of this test wrote 16 bytes
        // and only verified happy-path mime detection — the cap branch was
        // never exercised. Now we write MAX_DOWNLOAD_BYTES + 1 and assert
        // the size-check error propagates.
        let ws = make_test_workspace("download_oversize");
        let p = ws.join("huge.bin");
        let buf = vec![0u8; (MAX_DOWNLOAD_BYTES + 1) as usize];
        fs::write(&p, &buf).unwrap();
        let res = cmd_workspace_download_file(
            ws.to_string_lossy().to_string(),
            "huge.bin".to_string(),
        )
        .await;
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("too large"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_missing() {
        let ws = make_test_workspace("download_missing");
        let res = cmd_workspace_download_file(
            ws.to_string_lossy().to_string(),
            "nope.png".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let ws = make_test_workspace("download_traversal");
        let res = cmd_workspace_download_file(
            ws.to_string_lossy().to_string(),
            "../etc/hosts".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // Phase D.5 regression: download returns raw bytes. A symlink inside the
    // workspace pointing to an out-of-workspace file must not be downloadable
    // through this command — the canonicalize check in
    // `resolve_existing_inside_workspace` blocks the lexical-resolve bypass.
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let ws = make_test_workspace("download_symlink_escape");
        let outside = std::env::temp_dir().join(format!(
            "download_outside_{}",
            std::process::id()
        ));
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.png");
        fs::write(&secret, b"\x89PNG\rTOP-SECRET-BYTES").unwrap();
        symlink(&secret, ws.join("evil_link.png")).unwrap();

        let res = cmd_workspace_download_file(
            ws.to_string_lossy().to_string(),
            "evil_link.png".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }
}
