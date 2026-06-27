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

/// Lora Regular (cyrealtype/Lora v3.021, OFL 1.1) — familia serif. Nombre interno: "Lora".
pub const FONT_LORA_REGULAR: &[u8] =
    include_bytes!("../../assets/fonts/Lora-Regular.ttf");

/// Lora Bold (cyrealtype/Lora v3.021, OFL 1.1). Nombre interno: "Lora" (subfamily Bold).
pub const FONT_LORA_BOLD: &[u8] =
    include_bytes!("../../assets/fonts/Lora-Bold.ttf");

/// JetBrains Mono Regular (JetBrains/JetBrainsMono v2.304, OFL 1.1) — familia mono.
/// Peso único embebido. Nombre interno: "JetBrains Mono".
pub const FONT_MONO_REGULAR: &[u8] =
    include_bytes!("../../assets/fonts/JetBrainsMono-Regular.ttf");

/// New Computer Modern Math (typst-assets 0.14.2, GUST Font License) — para `$ $`.
pub const FONT_NEWCM_MATH: &[u8] =
    include_bytes!("../../assets/fonts/NewCMMath-Book.otf");

/// Catálogo COMPLETO de fuentes embebidas (todas las familias + matemática).
/// Desde Fase 4 la producción alimenta al engine con `fonts_for(&cfg.font_family)`
/// (solo la familia activa), por lo que `FONTS` queda como baseline de tests y
/// referencia del set total. `allow(dead_code)`: no se usa en el binario, solo en
/// los smoke tests de `engine.rs`.
#[allow(dead_code)]
pub const FONTS: &[&[u8]] = &[
    FONT_INTER_REGULAR,
    FONT_INTER_BOLD,
    FONT_LORA_REGULAR,
    FONT_LORA_BOLD,
    FONT_MONO_REGULAR,
    FONT_NEWCM_MATH,
];

// ─── Selección de familia por configuración ──────────────────────────────────
// Cada familia devuelve su(s) variante(s) propia(s) MÁS Inter (fallback de glifos
// latinos) y la fuente matemática, de modo que el resultado de `fonts_for` sea
// autosuficiente si la integración (Fase 4) decide alimentar el engine con la
// familia seleccionada en lugar de `FONTS` completo — sin romper `$ $` ni glifos
// no cubiertos por la serif/mono.

/// Familia Inter (sans, default). Regular + Bold + matemática.
const INTER_FAMILY: &[&[u8]] = &[FONT_INTER_REGULAR, FONT_INTER_BOLD, FONT_NEWCM_MATH];

/// Familia Lora (serif). Regular + Bold + Inter (fallback glifos) + matemática.
const LORA_FAMILY: &[&[u8]] = &[
    FONT_LORA_REGULAR,
    FONT_LORA_BOLD,
    FONT_INTER_REGULAR,
    FONT_INTER_BOLD,
    FONT_NEWCM_MATH,
];

/// Familia Mono (JetBrains Mono, peso único). Mono + Inter (fallback) + matemática.
const MONO_FAMILY: &[&[u8]] = &[
    FONT_MONO_REGULAR,
    FONT_INTER_REGULAR,
    FONT_INTER_BOLD,
    FONT_NEWCM_MATH,
];

/// Devuelve el conjunto de fuentes embebidas para la familia configurada en
/// `StyleConfig.font`. Familia desconocida → Inter (fallback seguro, ver design
/// decisión #5: "desconocida → Inter").
///
/// Acepta tanto el código corto del enum (`"mono"`) como el nombre interno de la
/// fuente (`"jetbrains mono"`), case-insensitive.
///
/// Consumido por `engine::compile` vía `create_pdf` (Fase 4, task 4.2): alimenta
/// al engine SOLO con la familia activa en vez del catálogo `FONTS` completo.
pub fn fonts_for(font: &str) -> &'static [&'static [u8]] {
    match font.to_lowercase().as_str() {
        "inter" => INTER_FAMILY,
        "lora" => LORA_FAMILY,
        "mono" | "jetbrains mono" | "jetbrainsmono" => MONO_FAMILY,
        _ => INTER_FAMILY, // fallback
    }
}

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
        // Inter(reg/bold) + Lora(reg/bold) + Mono + NewCMMath = 6 familias/variantes.
        assert_eq!(FONTS.len(), 6);
        assert!(FONTS.iter().all(|f| !f.is_empty()));
    }

    // Identidad por longitud: cada .ttf/.otf embebido tiene un tamaño único, así
    // que `len()` distingue las fuentes de forma fiable (ptr::eq sobre fat-pointers
    // de `&[u8]` no es estable bajo const-eval).
    fn contains(set: &[&[u8]], font: &[u8]) -> bool {
        set.iter().any(|f| f.len() == font.len())
    }

    #[test]
    fn fonts_for_lora_includes_lora_bytes() {
        let set = fonts_for("lora");
        assert!(contains(set, FONT_LORA_REGULAR));
        assert!(contains(set, FONT_LORA_BOLD));
    }

    #[test]
    fn fonts_for_mono_includes_mono_bytes() {
        let set = fonts_for("mono");
        assert!(contains(set, FONT_MONO_REGULAR));
        // El nombre interno también resuelve a la familia mono (mismo tamaño de set).
        assert_eq!(fonts_for("JetBrains Mono").len(), fonts_for("mono").len());
        assert!(contains(fonts_for("JetBrains Mono"), FONT_MONO_REGULAR));
    }

    #[test]
    fn fonts_for_inter_includes_inter_bytes() {
        let set = fonts_for("inter");
        assert!(contains(set, FONT_INTER_REGULAR));
        assert!(contains(set, FONT_INTER_BOLD));
    }

    #[test]
    fn fonts_for_unknown_falls_back_to_inter() {
        // Familia desconocida → mismo conjunto que Inter (design decisión #5).
        let inter = fonts_for("inter");
        for unknown in ["unknown", "", "comic sans"] {
            let set = fonts_for(unknown);
            assert_eq!(set.len(), inter.len(), "fallback de {unknown:?} != inter");
            assert!(contains(set, FONT_INTER_REGULAR));
            assert!(contains(set, FONT_INTER_BOLD));
            // El fallback NO debe arrastrar la serif ni la mono.
            assert!(!contains(set, FONT_LORA_REGULAR));
            assert!(!contains(set, FONT_MONO_REGULAR));
        }
    }

    #[test]
    fn fonts_for_is_case_insensitive() {
        assert!(contains(fonts_for("LORA"), FONT_LORA_REGULAR));
        assert!(contains(fonts_for("Inter"), FONT_INTER_REGULAR));
    }

    #[test]
    fn all_family_sets_non_empty_and_embed_math() {
        for fam in ["inter", "lora", "mono"] {
            let set = fonts_for(fam);
            assert!(!set.is_empty(), "familia {fam} vacía");
            assert!(set.iter().all(|f| !f.is_empty()));
            // Toda familia incluye la fuente matemática para `$ $`.
            assert!(contains(set, FONT_NEWCM_MATH), "familia {fam} sin matemática");
        }
    }
}
