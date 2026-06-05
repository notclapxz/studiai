// =============================================================================
// PDF assets — fuentes y logos embebidos vía include_bytes! (offline, sin red)
// =============================================================================
//
// Las fuentes y logos se vendoran en `src-tauri/assets/` (Fase 1) y se embeben
// en el binario. Esto garantiza generación de PDF offline: typst NO hace lookup
// de fuentes por sistema ni red (ver spec: "Build offline autocontenido").

/// Inter Regular (rsms/inter v4.1, OFL 1.1).
pub const FONT_INTER_REGULAR: &[u8] =
    include_bytes!("../../assets/fonts/Inter-Regular.ttf");

/// Inter Bold (rsms/inter v4.1, OFL 1.1).
pub const FONT_INTER_BOLD: &[u8] =
    include_bytes!("../../assets/fonts/Inter-Bold.ttf");

/// New Computer Modern Math (typst-assets 0.14.2, GUST Font License) — para `$ $`.
pub const FONT_NEWCM_MATH: &[u8] =
    include_bytes!("../../assets/fonts/NewCMMath-Book.otf");

/// Todas las fuentes embebidas, para alimentar `TypstEngine::builder().fonts(...)`.
pub const FONTS: &[&[u8]] = &[FONT_INTER_REGULAR, FONT_INTER_BOLD, FONT_NEWCM_MATH];

/// Logo USIL (930x927 RGB).
const LOGO_USIL: &[u8] = include_bytes!("../../assets/logos/usil.png");

/// Logo UTEC (1894x2400 RGBA).
const LOGO_UTEC: &[u8] = include_bytes!("../../assets/logos/utec.png");

/// Devuelve los bytes PNG del logo para la universidad detectada, o `None` si
/// no hay logo (carátula solo-texto, sin error).
///
/// `university` es el código normalizado producido por la detección de
/// `canvas_url` en `mod.rs` ("USIL" | "UTEC" | "none").
pub fn logo_for(university: &str) -> Option<&'static [u8]> {
    match university {
        "USIL" => Some(LOGO_USIL),
        "UTEC" => Some(LOGO_UTEC),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_for_known_universities() {
        assert!(logo_for("USIL").is_some());
        assert!(logo_for("UTEC").is_some());
    }

    #[test]
    fn logo_for_unknown_is_none() {
        assert!(logo_for("none").is_none());
        assert!(logo_for("").is_none());
        assert!(logo_for("HARVARD").is_none());
    }

    #[test]
    fn fonts_embedded_non_empty() {
        assert_eq!(FONTS.len(), 3);
        assert!(FONTS.iter().all(|f| !f.is_empty()));
    }
}
