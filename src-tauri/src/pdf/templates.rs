// =============================================================================
// PDF templates — markup Typst Rust-owned (geometría / carátula / tema)
// =============================================================================
//
// Cada función devuelve el SOURCE Typst completo de un `doc_type`. El agente
// solo aporta CONTENIDO (markup para `informe`; datos para `presentacion`/
// `tarea`), nunca geometría ni tema. Los datos escalares (title/course/author/
// date/university) y el contenido markup se inyectan vía `sys.inputs.*` y se
// evalúan con `eval(..., mode: "markup")` — esto limita el scripting (no permite
// `#set page` arbitrario que rompería la geometría).
//
// Inyección de listas (slides/exercises): para evitar JSON frágil, `mod.rs`
// inserta entradas indexadas en el Dict de inputs:
//   - presentacion: `slide_count`, `slide_{i}_heading`, `slide_{i}_content`
//   - tarea:        `ex_count`, `ex_{i}_title`  (+ imagen "ex_{i}.png" en el
//                   file resolver)
// y las plantillas iteran con `#for i in range(...)` leyendo esas claves.
//
// Fuentes embebidas (assets.rs): "Inter" (regular/bold) + "New Computer Modern
// Math" (para `$ $`). Se referencian por nombre de familia.

// ─── Carátula compartida ─────────────────────────────────────────────────────
//
// Define `#let cover(...)`. El logo se resuelve por `sys.inputs.university`
// ("USIL"/"UTEC"/else solo-texto). Los logos llegan al file resolver con keys
// "logo_usil.png" / "logo_utec.png" (inyectados por mod.rs cuando aplican).
const COVER_HELPER: &str = r##"
#let _uni = sys.inputs.at("university", default: "none")
#let _logo = if _uni == "USIL" { "logo_usil.png" } else if _uni == "UTEC" { "logo_utec.png" } else { none }

#let cover(accent: rgb("#2563eb"), fg: rgb("#1a1a1a"), muted: rgb("#555555")) = {
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
}
"##;

/// `informe`: A4 retrato, tema CLARO imprimible (fondo blanco, texto #1a1a1a,
/// acento #2563eb), márgenes 2.5cm, fuente Inter. El cuerpo es markup Typst del
/// agente, evaluado vía `eval(sys.inputs.body, mode: "markup")`.
pub fn informe() -> String {
    format!(
        r##"{cover}
#set page(paper: "a4", margin: 2.5cm, fill: white)
#set text(font: "Inter", size: 11pt, fill: rgb("#1a1a1a"), lang: "es")
#show heading: set text(fill: rgb("#2563eb"))
#set par(justify: true, leading: 0.7em)

// Carátula (página propia)
#cover()
#pagebreak()

// Cuerpo aportado por el agente (markup Typst).
#eval(sys.inputs.at("body", default: ""), mode: "markup")
"##,
        cover = COVER_HELPER
    )
}

/// `presentacion`: páginas 16:9 apaisadas (33.87cm × 19.05cm), fondo oscuro
/// #1e1e1e, acento #4fc3f7. Carátula + una página por slide (heading + contenido
/// markup evaluado). `slide_count` y `slide_{i}_heading`/`slide_{i}_content`
/// llegan por inputs.
pub fn presentacion() -> String {
    format!(
        r##"{cover}
#set page(width: 33.87cm, height: 19.05cm, margin: 2cm, fill: rgb("#1e1e1e"))
#set text(font: "Inter", size: 20pt, fill: rgb("#e8e8e8"), lang: "es")
#show heading: set text(fill: rgb("#4fc3f7"))

// Carátula sobre tema oscuro.
#cover(accent: rgb("#4fc3f7"), fg: rgb("#e8e8e8"), muted: rgb("#9aa0a6"))

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
        cover = COVER_HELPER
    )
}

/// `tarea`: 16:9 apaisado (33.87cm × 19.05cm, como la guía 1920×1080), tema
/// oscuro (fondo #1e1e1e), carátula + una página por ejercicio. Cada página:
/// barra de cabecera (navy #1a1a2e, título acento #4fc3f7) + screenshot a
/// página completa (object-fit: contain → `fit: "contain"`). La imagen llega
/// al file resolver con key "ex_{i}.png" (recortada 5% inferior en mod.rs).
/// `ex_count` y `ex_{i}_title` llegan por inputs.
pub fn tarea() -> String {
    format!(
        r##"{cover}
#set page(width: 33.87cm, height: 19.05cm, margin: 0pt, fill: rgb("#1e1e1e"))
#set text(font: "Inter", size: 12pt, fill: rgb("#e8e8e8"), lang: "es")

// Carátula sobre tema oscuro (con padding manual porque margin=0).
#block(width: 100%, height: 100%, inset: 2.5cm)[
  #cover(accent: rgb("#4fc3f7"), fg: rgb("#e8e8e8"), muted: rgb("#9aa0a6"))
]

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
  // Screenshot centrado a página completa, contain (guía: área 1920×1020).
  block(width: 100%, height: 1fr)[
    #align(center + horizon)[
      #image("ex_" + str(i) + ".png", width: 100%, height: 100%, fit: "contain")
    ]
  ]
}}
"##,
        cover = COVER_HELPER
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_contain_expected_geometry() {
        assert!(informe().contains("paper: \"a4\""));
        assert!(informe().contains("fill: white"));
        assert!(presentacion().contains("33.87cm"));
        assert!(presentacion().contains("#1e1e1e"));
        assert!(tarea().contains("33.87cm"));
        assert!(tarea().contains("#1e1e1e"));
        assert!(tarea().contains("#1a1a2e"));
        assert!(tarea().contains("fit: \"contain\""));
    }

    #[test]
    fn all_templates_include_cover_helper() {
        assert!(informe().contains("#let cover("));
        assert!(presentacion().contains("#let cover("));
        assert!(tarea().contains("#let cover("));
    }
}
