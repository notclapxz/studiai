// =============================================================================
// PDF templates — markup Typst Rust-owned, parametrizado por StyleConfig (Fase 3)
// =============================================================================
//
// Cada función recibe `&StyleConfig` y devuelve el SOURCE Typst completo de un
// `doc_type`, interpolando geometría / tipografía / tema vía `format!()`
// (Rust-owned). El agente solo aporta CONTENIDO (markup para `informe`; datos
// para `presentacion`/`tarea`), nunca geometría ni tema. Los datos escalares
// (title/course/author/date/university) y el contenido markup se inyectan vía
// `sys.inputs.*` y se evalúan con `eval(..., mode: "markup")` — esto limita el
// scripting (no permite `#set page` arbitrario que rompería la geometría).
//
// DECISIÓN DE DISEÑO #2 (design): la parametrización ocurre SOLO sobre strings
// Rust-owned interpolados con `format!()`. NO se usan `sys.inputs.style_*`: pasar
// geometría/orientación por inputs exigiría `eval()` de longitudes = NUEVA
// superficie de scripting. Manteniendo todo en el string Rust-owned el `body` del
// agente sigue en su `eval(mode:"markup")` separado → invariante de seguridad más
// fuerte (no llega ningún `#set page` desde el agente).
//
// Inyección de listas (slides/exercises): para evitar JSON frágil, `mod.rs`
// inserta entradas indexadas en el Dict de inputs:
//   - presentacion: `slide_count`, `slide_{i}_heading`, `slide_{i}_content`
//   - tarea:        `ex_count`, `ex_{i}_title`  (+ imagen "ex_{i}.png" en el
//                   file resolver)
// y las plantillas iteran con `#for i in range(...)` leyendo esas claves.
//
// Fuentes embebidas (assets.rs): Inter / Lora / JetBrains Mono (+ New Computer
// Modern Math para `$ $`). El engine carga TODAS (assets::FONTS) y Typst resuelve
// por NOMBRE de familia, así que la SELECCIÓN ocurre aquí vía `#set text(font:)`.

use super::{Orientation, Ratio, StyleConfig};

// ─── Mapeos config → valores Typst ───────────────────────────────────────────

/// Código de familia (`StyleConfig.font_family`) → nombre interno de la fuente
/// embebida tal como Typst lo resuelve. Desconocido → Inter (design decisión #5).
fn font_name(font: &str) -> &'static str {
    match font {
        "lora" => "Lora",
        "mono" => "JetBrains Mono",
        _ => "Inter",
    }
}

/// Color de acento (`StyleConfig.accent_color`) → hex. Desconocido → blue.
fn accent_hex(accent: &str) -> &'static str {
    match accent {
        "red" => "#dc2626",
        "green" => "#16a34a",
        "purple" => "#7c3aed",
        _ => "#2563eb", // blue (default)
    }
}

/// Geometría de página A4 según orientación. Portrait = 21×29.7cm;
/// Landscape = 29.7×21cm (A4 rotado). Devuelto como `(width, height)`.
fn page_dims(orientation: Orientation) -> (&'static str, &'static str) {
    match orientation {
        Orientation::Landscape => ("29.7cm", "21cm"),
        Orientation::Portrait => ("21cm", "29.7cm"),
    }
}

/// Geometría de slide según ratio. 16:9 = 33.87×19.05cm (1920×1080 a 96dpi);
/// 4:3 = 25.4×19.05cm. Devuelto como `(width, height)`.
fn pres_dims(ratio: Ratio) -> (&'static str, &'static str) {
    match ratio {
        Ratio::R16_9 => ("33.87cm", "19.05cm"),
        Ratio::R4_3 => ("25.4cm", "19.05cm"),
    }
}

/// Colores de la carátula del `informe` (página blanca) según `cover_theme`.
/// Devuelve `(fg, muted)`. El acento lo aporta `accent_color` por separado.
fn cover_theme_colors(theme: &str) -> (&'static str, &'static str) {
    match theme {
        "dark" => ("#000000", "#333333"),
        "minimal" => ("#444444", "#999999"),
        _ => ("#1a1a1a", "#555555"), // light (default)
    }
}

/// Tema de presentación → `(bg, fg, accent)`. En `light` el acento proviene del
/// `accent_color` configurado; en `dark`/`colorful` es propio del tema.
fn pres_theme_colors(theme: &str, accent_cfg: &str) -> (&'static str, &'static str, &'static str) {
    match theme {
        "light" => ("#ffffff", "#1a1a1a", accent_hex(accent_cfg)),
        "colorful" => ("#2c2c2c", "#f0f0f0", "#ff6b6b"),
        _ => ("#1e1e1e", "#e8e8e8", "#4fc3f7"), // dark (default)
    }
}

/// Color "muted" (curso/fecha) de la carátula de presentación según tema.
fn pres_muted(theme: &str) -> &'static str {
    match theme {
        "light" => "#666666",
        _ => "#9aa0a6",
    }
}

/// Mapea el multiplicador `line_height` (1.0/1.15/1.5/2.0, estilo CSS) al
/// `leading` de Typst (espacio entre líneas). Aproximación monotónica
/// `leading = line_height * 0.65em` (0.65em ≈ leading por defecto de Typst).
fn leading_em(line_height: f64) -> String {
    format!("{:.3}", line_height * 0.65)
}

// ─── Carátula compartida (parametrizada) ─────────────────────────────────────
//
// Genera `#let cover(...)` con los colores (accent/fg/muted) ya interpolados como
// DEFAULTS, de modo que cada template llame simplemente `#cover()`. El logo sigue
// resolviéndose por `sys.inputs.university` ("USIL"/"UTEC"/else solo-texto): es el
// mecanismo VIVO de logo (mod.rs inyecta "logo_usil.png"/"logo_utec.png" al file
// resolver según `detect_university`). La precedencia `StyleConfig.logo` vs
// universidad se decide en Fase 4 (wiring de create_pdf); mantenerlo aquí evita
// una regresión del logo de universidad en esta fase.
fn cover_markup(accent: &str, fg: &str, muted: &str) -> String {
    format!(
        r##"
#let _uni = sys.inputs.at("university", default: "none")
#let _logo = if _uni == "USIL" {{ "logo_usil.png" }} else if _uni == "UTEC" {{ "logo_utec.png" }} else {{ none }}

#let cover(accent: rgb("{accent}"), fg: rgb("{fg}"), muted: rgb("{muted}")) = {{
  set align(center + horizon)
  block(width: 100%)[
    #if _logo != none [
      #image(_logo, width: 4cm)
      #v(1.2cm)
    ]
    #text(size: 13pt, fill: muted)[#sys.inputs.at("course", default: "")]
    #v(0.4cm)
    #text(size: 30pt, weight: "bold", fill: accent)[#sys.inputs.at("title", default: "")]
    #v(0.8cm)
    #line(length: 35%, stroke: 1pt + accent)
    #v(0.6cm)
    #text(size: 14pt, fill: fg)[#sys.inputs.at("author", default: "")]
    #v(0.2cm)
    #text(size: 12pt, fill: muted)[#sys.inputs.at("date", default: "")]
  ]
}}
"##,
        accent = accent,
        fg = fg,
        muted = muted,
    )
}

/// `informe`: A4 (orientación configurable), tema CLARO imprimible (fondo blanco,
/// texto #1a1a1a, acento configurable), márgenes/fuente/tamaño/interlineado desde
/// `StyleConfig`. El cuerpo es markup Typst del agente, evaluado vía
/// `eval(sys.inputs.body, mode: "markup")`.
pub fn informe(config: &StyleConfig) -> String {
    let (w, h) = page_dims(config.orientation);
    let font = font_name(&config.font_family);
    let accent = accent_hex(&config.accent_color);
    let (fg, muted) = cover_theme_colors(&config.cover_theme);
    let cover = cover_markup(accent, fg, muted);

    format!(
        r##"{cover}
#set page(width: {w}, height: {h}, margin: {margin}cm, fill: white)
#set text(font: "{font}", size: {size}pt, fill: rgb("#1a1a1a"), lang: "es")
#show heading: set text(fill: rgb("{accent}"))
#set par(justify: true, leading: {leading}em)

// Carátula (página propia)
#cover()
#pagebreak()

// Cuerpo aportado por el agente (markup Typst).
#eval(sys.inputs.at("body", default: ""), mode: "markup")
"##,
        cover = cover,
        w = w,
        h = h,
        margin = config.margins_cm,
        font = font,
        size = config.font_size,
        accent = accent,
        leading = leading_em(config.line_height),
    )
}

/// `presentacion`: slides según `presentation_ratio` (16:9 = 33.87×19.05cm; 4:3 =
/// 25.4×19.05cm) y `presentation_theme` (light/dark/colorful). Fuente desde
/// `font_family`. Carátula + una página por slide (heading + contenido markup
/// evaluado). `slide_count` y `slide_{i}_heading`/`slide_{i}_content` llegan por
/// inputs. El tamaño base de slide (20pt) es fijo: `font_size` aplica al cuerpo de
/// documentos, no a presentaciones.
pub fn presentacion(config: &StyleConfig) -> String {
    let (w, h) = pres_dims(config.presentation_ratio);
    let font = font_name(&config.font_family);
    let (bg, fg, accent) = pres_theme_colors(&config.presentation_theme, &config.accent_color);
    let muted = pres_muted(&config.presentation_theme);
    let cover = cover_markup(accent, fg, muted);

    format!(
        r##"{cover}
#set page(width: {w}, height: {h}, margin: 2cm, fill: rgb("{bg}"))
#set text(font: "{font}", size: 20pt, fill: rgb("{fg}"), lang: "es")
#show heading: set text(fill: rgb("{accent}"))

// Carátula sobre el tema configurado.
#cover()

#let _n = int(sys.inputs.at("slide_count", default: "0"))
#for i in range(_n) {{
  pagebreak()
  let h = sys.inputs.at("slide_" + str(i) + "_heading", default: "")
  let c = sys.inputs.at("slide_" + str(i) + "_content", default: "")
  heading(level: 1, text(size: 32pt, weight: "bold", h))
  v(0.6cm)
  eval(c, mode: "markup")
}}
"##,
        cover = cover,
        w = w,
        h = h,
        bg = bg,
        fg = fg,
        accent = accent,
        font = font,
    )
}

/// `tarea`: A4 (orientación configurable), tema oscuro (fondo #1e1e1e), carátula +
/// una página por ejercicio. Cada página: barra de cabecera (navy #1a1a2e, título
/// acento #4fc3f7) + screenshot a página completa (`fit: "contain"`). Márgenes y
/// fuente desde `StyleConfig`. La imagen llega al file resolver con key "ex_{i}.png"
/// (recortada 5% inferior en mod.rs). `ex_count` y `ex_{i}_title` llegan por inputs.
pub fn tarea(config: &StyleConfig) -> String {
    let (w, h) = page_dims(config.orientation);
    let font = font_name(&config.font_family);
    // Carátula sobre tema oscuro (acento/fg/muted fijos del tema de tarea).
    let cover = cover_markup("#4fc3f7", "#e8e8e8", "#9aa0a6");

    format!(
        r##"{cover}
#set page(width: {w}, height: {h}, margin: {margin}cm, fill: rgb("#1e1e1e"))
#set text(font: "{font}", size: 12pt, fill: rgb("#e8e8e8"), lang: "es")

// Carátula sobre tema oscuro.
#cover()

#let _n = int(sys.inputs.at("ex_count", default: "0"))
#for i in range(_n) {{
  pagebreak()
  let t = sys.inputs.at("ex_" + str(i) + "_title", default: "")
  // Barra de cabecera.
  block(
    width: 100%,
    fill: rgb("#1a1a2e"),
    inset: (x: 1.5cm, y: 0.5cm),
  )[
    #align(center)[#text(size: 16pt, weight: "bold", fill: rgb("#4fc3f7"))[#t]]
  ]
  // Screenshot centrado a página completa, contain.
  block(width: 100%, height: 1fr)[
    #align(center + horizon)[
      #image("ex_" + str(i) + ".png", width: 100%, height: 100%, fit: "contain")
    ]
  ]
}}
"##,
        cover = cover,
        w = w,
        h = h,
        margin = config.margins_cm,
        font = font,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_contain_expected_geometry() {
        let d = StyleConfig::defaults();
        // informe portrait default (A4 retrato, fondo blanco).
        assert!(informe(&d).contains("fill: white"));
        assert!(informe(&d).contains("width: 21cm, height: 29.7cm"));
        // presentacion 16:9 default.
        assert!(presentacion(&d).contains("33.87cm"));
        // tarea: tema oscuro + barra navy + screenshot contain.
        assert!(tarea(&d).contains("#1e1e1e"));
        assert!(tarea(&d).contains("#1a1a2e"));
        assert!(tarea(&d).contains("fit: \"contain\""));
    }

    #[test]
    fn informe_landscape_uses_a4_rotated() {
        let mut c = StyleConfig::defaults();
        c.orientation = Orientation::Landscape;
        let t = informe(&c);
        // A4 landscape = 29.7cm × 21cm (ancho × alto).
        assert!(t.contains("width: 29.7cm, height: 21cm"));
    }

    #[test]
    fn informe_portrait_uses_a4_upright() {
        let c = StyleConfig::defaults();
        assert!(informe(&c).contains("width: 21cm, height: 29.7cm"));
    }

    #[test]
    fn presentacion_ratio_4_3_dims() {
        let mut c = StyleConfig::defaults();
        c.presentation_ratio = Ratio::R4_3;
        assert!(presentacion(&c).contains("width: 25.4cm"));

        c.presentation_ratio = Ratio::R16_9;
        assert!(presentacion(&c).contains("width: 33.87cm"));
    }

    #[test]
    fn font_family_applied_in_template() {
        let mut c = StyleConfig::defaults();
        assert!(informe(&c).contains("font: \"Inter\""));
        c.font_family = "lora".to_string();
        assert!(informe(&c).contains("font: \"Lora\""));
        c.font_family = "mono".to_string();
        assert!(informe(&c).contains("font: \"JetBrains Mono\""));
        // Desconocido → fallback Inter.
        c.font_family = "comic".to_string();
        assert!(informe(&c).contains("font: \"Inter\""));
    }

    #[test]
    fn accent_color_applied() {
        let mut c = StyleConfig::defaults();
        c.accent_color = "red".to_string();
        assert!(informe(&c).contains("#dc2626"));
        c.accent_color = "green".to_string();
        assert!(informe(&c).contains("#16a34a"));
        c.accent_color = "purple".to_string();
        assert!(informe(&c).contains("#7c3aed"));
    }

    #[test]
    fn margins_size_and_leading_applied() {
        let mut c = StyleConfig::defaults();
        c.margins_cm = 3.0;
        c.font_size = 14;
        c.line_height = 2.0;
        let t = informe(&c);
        assert!(t.contains("margin: 3cm"));
        assert!(t.contains("size: 14pt"));
        // leading = 2.0 * 0.65 = 1.300em.
        assert!(t.contains("leading: 1.300em"));
    }

    #[test]
    fn presentacion_theme_colors() {
        let mut c = StyleConfig::defaults();
        // light: fondo blanco.
        c.presentation_theme = "light".to_string();
        assert!(presentacion(&c).contains("fill: rgb(\"#ffffff\")"));
        // dark: fondo #1e1e1e.
        c.presentation_theme = "dark".to_string();
        assert!(presentacion(&c).contains("fill: rgb(\"#1e1e1e\")"));
        // colorful: fondo #2c2c2c + acento #ff6b6b.
        c.presentation_theme = "colorful".to_string();
        let t = presentacion(&c);
        assert!(t.contains("fill: rgb(\"#2c2c2c\")"));
        assert!(t.contains("#ff6b6b"));
    }

    #[test]
    fn all_templates_include_cover_helper() {
        let d = StyleConfig::defaults();
        assert!(informe(&d).contains("#let cover("));
        assert!(presentacion(&d).contains("#let cover("));
        assert!(tarea(&d).contains("#let cover("));
    }

    #[test]
    fn cover_not_broken_in_landscape() {
        // La carátula (cover helper + invocación) sigue presente al rotar geometría.
        let mut c = StyleConfig::defaults();
        c.orientation = Orientation::Landscape;
        let t = informe(&c);
        assert!(t.contains("#let cover("));
        assert!(t.contains("#cover()"));
        assert!(t.contains("center + horizon"));
    }

    #[test]
    fn body_evaluated_in_markup_mode_blocks_set_page() {
        // Invariante de seguridad (design decisión #2, task 4.3): el contenido del
        // AGENTE se evalúa en `mode: "markup"`, NO en `mode: "code"`. La geometría la
        // fija exclusivamente el `#set page` Rust-owned del template; el body del
        // agente nunca puede colar un `#set page` que rompa la página. Fase 4 NO
        // debilitó esta frontera (no se pasó geometría por inputs ni se cambió el modo).
        let informe_src = informe(&StyleConfig::defaults());
        assert!(
            informe_src.contains("mode: \"markup\""),
            "el body de informe debe evaluarse en mode:markup"
        );
        assert!(
            !informe_src.contains("mode: \"code\""),
            "informe NUNCA debe evaluar contenido del agente en mode:code"
        );

        // presentacion también evalúa el contenido de cada slide en markup.
        let pres_src = presentacion(&StyleConfig::defaults());
        assert!(pres_src.contains("mode: \"markup\""));
        assert!(!pres_src.contains("mode: \"code\""));
    }
}
