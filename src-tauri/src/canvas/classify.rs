// canvas/classify.rs — Clasificación de archivos en tier auto/manual

use std::path::Path;

/// Extensiones que se descargan automáticamente (documentos de texto/ofimática)
const AUTO_EXTENSIONS: &[&str] = &[
    ".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".doc", ".ppt", ".xls", ".csv", ".odt", ".ods",
    ".odp",
];

/// Extensiones de video — siempre manual
const VIDEO_EXTENSIONS: &[&str] = &[".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".m4v"];

/// Extensiones de archivos comprimidos — siempre manual
const ARCHIVE_EXTENSIONS: &[&str] = &[".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"];

/// Extensiones de ejecutables — siempre manual
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    ".exe", ".dmg", ".pkg", ".msi", ".apk", ".deb", ".rpm", ".app",
];

/// Tamaño máximo para descarga automática: 50 MB
const MAX_AUTO_SIZE_BYTES: u64 = 50 * 1024 * 1024;

/// Tier de clasificación de un archivo
#[derive(Debug, Clone, PartialEq)]
pub enum FileTier {
    /// Se descarga automáticamente
    Auto,
    /// Requiere acción manual del usuario
    Manual,
}

/// Resultado de clasificar un archivo
#[derive(Debug, Clone)]
pub struct FileClassification {
    pub tier: FileTier,
    /// Razón human-readable (solo para Manual)
    pub reason: Option<String>,
    /// Clave corta de razón ("video", "archive", "executable", "size")
    pub reason_key: Option<String>,
}

/// Clasifica un archivo según su nombre, content-type y tamaño.
///
/// # Lógica
/// - AUTO si: extensión en AUTO_EXTENSIONS AND tamaño <= 50 MB
/// - MANUAL si:
///   - content_type empieza con "video/"
///   - extensión en VIDEO_EXTENSIONS
///   - extensión en ARCHIVE_EXTENSIONS
///   - extensión en EXECUTABLE_EXTENSIONS
///   - tamaño > 50 MB
pub fn classify_file(name: &str, content_type: &str, size_bytes: u64) -> FileClassification {
    let name_lower = name.to_lowercase();
    let ext = Path::new(&name_lower)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    let mb = size_bytes as f64 / (1024.0 * 1024.0);

    // Video por content-type
    if content_type.starts_with("video/") {
        return FileClassification {
            tier: FileTier::Manual,
            reason: Some(format!(
                "Video ({:.0} MB) — disponible para descarga manual",
                mb
            )),
            reason_key: Some("video".to_string()),
        };
    }

    // Video por extensión
    if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        return FileClassification {
            tier: FileTier::Manual,
            reason: Some(format!(
                "Video ({:.0} MB) — disponible para descarga manual",
                mb
            )),
            reason_key: Some("video".to_string()),
        };
    }

    // Archivos comprimidos
    if ARCHIVE_EXTENSIONS.contains(&ext.as_str()) {
        return FileClassification {
            tier: FileTier::Manual,
            reason: Some(format!(
                "Archivo comprimido ({:.0} MB) — disponible para descarga manual",
                mb
            )),
            reason_key: Some("archive".to_string()),
        };
    }

    // Ejecutables
    if EXECUTABLE_EXTENSIONS.contains(&ext.as_str()) {
        return FileClassification {
            tier: FileTier::Manual,
            reason: Some(format!(
                "Ejecutable ({:.0} MB) — no se descarga automáticamente",
                mb
            )),
            reason_key: Some("executable".to_string()),
        };
    }

    // Demasiado grande
    if size_bytes > MAX_AUTO_SIZE_BYTES {
        return FileClassification {
            tier: FileTier::Manual,
            reason: Some(format!(
                "Archivo grande ({:.0} MB) — disponible para descarga manual",
                mb
            )),
            reason_key: Some("size".to_string()),
        };
    }

    // Auto si la extensión está en la lista blanca
    if AUTO_EXTENSIONS.contains(&ext.as_str()) {
        return FileClassification {
            tier: FileTier::Auto,
            reason: None,
            reason_key: None,
        };
    }

    // Extensión desconocida — manual por defecto
    FileClassification {
        tier: FileTier::Manual,
        reason: Some("Tipo de archivo no reconocido — disponible para descarga manual".to_string()),
        reason_key: Some("unknown".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auto_pdf() {
        let c = classify_file("lecture.pdf", "application/pdf", 1024 * 1024);
        assert_eq!(c.tier, FileTier::Auto);
    }

    #[test]
    fn test_auto_docx() {
        let c = classify_file("tarea.docx", "application/vnd.openxmlformats", 500_000);
        assert_eq!(c.tier, FileTier::Auto);
    }

    #[test]
    fn test_manual_video_content_type() {
        let c = classify_file("clase.mp4", "video/mp4", 100_000_000);
        assert_eq!(c.tier, FileTier::Manual);
        assert_eq!(c.reason_key, Some("video".to_string()));
    }

    #[test]
    fn test_manual_video_extension() {
        let c = classify_file("grabacion.mov", "application/octet-stream", 50_000);
        assert_eq!(c.tier, FileTier::Manual);
        assert_eq!(c.reason_key, Some("video".to_string()));
    }

    #[test]
    fn test_manual_zip() {
        let c = classify_file("recursos.zip", "application/zip", 1_000_000);
        assert_eq!(c.tier, FileTier::Manual);
        assert_eq!(c.reason_key, Some("archive".to_string()));
    }

    #[test]
    fn test_manual_too_large() {
        let c = classify_file("large.pdf", "application/pdf", 60 * 1024 * 1024);
        assert_eq!(c.tier, FileTier::Manual);
        assert_eq!(c.reason_key, Some("size".to_string()));
    }

    #[test]
    fn test_50mb_boundary_auto() {
        // Exactamente 50MB — debe ser auto
        let c = classify_file("doc.pdf", "application/pdf", MAX_AUTO_SIZE_BYTES);
        assert_eq!(c.tier, FileTier::Auto);
    }

    #[test]
    fn test_50mb_boundary_manual() {
        // 50MB + 1 byte — debe ser manual
        let c = classify_file("doc.pdf", "application/pdf", MAX_AUTO_SIZE_BYTES + 1);
        assert_eq!(c.tier, FileTier::Manual);
    }
}
