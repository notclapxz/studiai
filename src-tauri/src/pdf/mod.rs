// =============================================================================
// pdf — generación nativa de PDF con Typst (módulo aislado)
// =============================================================================
//
// Toda la dependencia de typst está confinada aquí. El resto de lib.rs solo ve
// `pdf::create_pdf(app, args) -> serde_json::Value`. NADA typst-typed escapa de
// este módulo (la API pública usa únicamente `tauri::AppHandle` y serde_json).
//
// Reglas de robustez:
//   - Ninguna ruta de código no-test usa unwrap()/expect(): todo error es un
//     `{ "error": "<desc>" }` JSON. NUNCA panic ante ninguna entrada.
//   - Errores de compilación Typst vuelven verbatim en `error` → el agente
//     corrige y reintenta dentro del mismo loop agéntico.

mod assets;
mod engine;
mod templates;

use std::io::Cursor;
use std::path::PathBuf;

use image::ImageFormat;
use typst::foundations::{Dict, IntoValue};

/// Entry point del tool `create_pdf`. Valida args por `doc_type`, compila el
/// template correspondiente y escribe/abre el PDF. Devuelve siempre un
/// `serde_json::Value` (éxito o `{ "error": ... }`), nunca entra en panic.
pub fn create_pdf(app: &tauri::AppHandle, args: &serde_json::Value) -> serde_json::Value {
    let doc_type = match args.get("doc_type").and_then(|v| v.as_str()) {
        Some(d) => d,
        None => return err("Falta 'doc_type' (informe | presentacion | tarea)"),
    };

    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let course = args.get("course").and_then(|v| v.as_str()).unwrap_or("");
    let author = args.get("author").and_then(|v| v.as_str()).unwrap_or("");

    if title.is_empty() {
        return err("Falta 'title'");
    }

    // Fecha: fallback a fecha actual en español ("D de MMMM de YYYY").
    let date = match args.get("date").and_then(|v| v.as_str()) {
        Some(d) if !d.trim().is_empty() => d.to_string(),
        _ => current_date_es(),
    };

    // ── Estilo: base persistida + override one-shot (precedencia override > base) ──
    // `chat_session_id` (opcional): la Fase 6 lo inyectará desde el modal/contexto.
    // Mientras no llegue, el override pendiente más reciente se consume como
    // fallback resiliente (escenario realista: el usuario acaba de fijarlo en el
    // modal justo antes de pedir el documento).
    let session_id = args.get("chat_session_id").and_then(|v| v.as_i64());

    // El override NO se consume aquí: solo se borra tras una generación EXITOSA
    // (más abajo), de modo que los reintentos del agente ante un error de
    // compilación conserven el estilo elegido. `consumed_session` recuerda la fila
    // exacta a limpiar.
    let base_style = read_document_style(app);
    let pending = read_pending_override(app, session_id);
    let consumed_session: Option<i64> = pending.as_ref().map(|(sid, _)| *sid);
    let style = merge_style(base_style, pending.map(|(_, cfg)| cfg));

    // Precedencia de logo (Open Question Fase 3 resuelta): un `logo` explícito en el
    // estilo (usil/utec) gana sobre la auto-detección por `canvas_url`; el default
    // "none" cae a la auto-detección → NO hay regresión para usuarios que ya tenían
    // su universidad detectada sin configurar nada.
    let university = match style.logo.as_str() {
        "usil" => "USIL".to_string(),
        "utec" => "UTEC".to_string(),
        _ => detect_university(app),
    };

    // Base del Dict de inputs (escalares comunes a todos los doc_type).
    let mut inputs = Dict::new();
    inputs.insert("title".into(), title.into_value());
    inputs.insert("course".into(), course.into_value());
    inputs.insert("author".into(), author.into_value());
    inputs.insert("date".into(), date.into_value());
    inputs.insert("university".into(), university.clone().into_value());

    // Logos al file resolver según universidad (key estable usada por el template).
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    if let Some(bytes) = assets::logo_for(&university) {
        let key = match university.as_str() {
            "USIL" => "logo_usil.png",
            "UTEC" => "logo_utec.png",
            _ => "",
        };
        if !key.is_empty() {
            files.push((key.to_string(), bytes.to_vec()));
        }
    }

    // Selección de template + inyección específica por doc_type (con validación).
    // Cada template se parametriza con `&style` vía `format!()` Rust-owned.
    let template = match doc_type {
        "informe" => match build_informe(args, &mut inputs) {
            Ok(()) => templates::informe(&style),
            Err(e) => return err(&e),
        },
        "presentacion" => match build_presentacion(args, &mut inputs) {
            Ok(()) => templates::presentacion(&style),
            Err(e) => return err(&e),
        },
        "tarea" => match build_tarea(args, &mut inputs, &mut files) {
            Ok(()) => templates::tarea(&style),
            Err(e) => return err(&e),
        },
        other => return err(&format!("doc_type inválido: '{other}'")),
    };

    // Compilar a bytes PDF, alimentando al engine SOLO con la familia de fuentes
    // activa (`fonts_for`) en vez del catálogo completo. Err → verbatim al agente.
    let pdf_bytes = match engine::compile(&template, inputs, &files, assets::fonts_for(&style.font_family)) {
        Ok(b) => b,
        Err(diag) => return err(&diag),
    };

    // Resolver directorio de salida + escribir + abrir.
    let dir = resolve_output_dir(app);
    let safe_name = sanitize_filename(title);
    let path = dir.join(format!("{safe_name}.pdf"));

    if let Err(e) = std::fs::write(&path, &pdf_bytes) {
        return err(&format!("Error escribiendo PDF: {e}"));
    }

    crate::open_pdf_file(&path);

    // Consumo one-shot: el override pendiente SOLO se borra tras generar el PDF con
    // éxito. Si la compilación o la escritura fallan, la fila persiste y el siguiente
    // intento del agente reutiliza el mismo estilo.
    if let Some(sid) = consumed_session {
        clear_pending_override(app, sid);
    }

    serde_json::json!({
        "success": true,
        "path": path.display().to_string(),
        "doc_type": doc_type,
    })
}

// ─── Validación + inyección por doc_type ─────────────────────────────────────

/// `informe` exige `body` no vacío. Inyecta `body` como input markup.
fn build_informe(args: &serde_json::Value, inputs: &mut Dict) -> Result<(), String> {
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .filter(|b| !b.trim().is_empty())
        .ok_or_else(|| "informe requiere 'body' (markup Typst no vacío)".to_string())?;
    inputs.insert("body".into(), body.into_value());
    Ok(())
}

/// `presentacion` exige `slides[]` no vacío. Inyecta `slide_count` +
/// `slide_{i}_heading` / `slide_{i}_content`.
fn build_presentacion(args: &serde_json::Value, inputs: &mut Dict) -> Result<(), String> {
    let slides = args
        .get("slides")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| "presentacion requiere 'slides' (array no vacío)".to_string())?;

    inputs.insert("slide_count".into(), slides.len().to_string().into_value());
    for (i, slide) in slides.iter().enumerate() {
        let heading = slide.get("heading").and_then(|v| v.as_str()).unwrap_or("");
        let content = slide.get("content").and_then(|v| v.as_str()).unwrap_or("");
        inputs.insert(
            format!("slide_{i}_heading").into(),
            heading.into_value(),
        );
        inputs.insert(
            format!("slide_{i}_content").into(),
            content.into_value(),
        );
    }
    Ok(())
}

/// `tarea` exige `exercises[]` no vacío. Por cada ejercicio: lee PNG (ruta
/// absoluta), recorta 5% inferior en memoria, re-encode PNG → file resolver con
/// key "ex_{i}.png". Inyecta `ex_count` + `ex_{i}_title`.
fn build_tarea(
    args: &serde_json::Value,
    inputs: &mut Dict,
    files: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), String> {
    let exercises = args
        .get("exercises")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| "tarea requiere 'exercises' (array no vacío)".to_string())?;

    inputs.insert("ex_count".into(), exercises.len().to_string().into_value());
    for (i, ex) in exercises.iter().enumerate() {
        let title = ex.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let image_path = ex
            .get("image_path")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if image_path.is_empty() {
            return Err(format!("Ejercicio {i}: falta 'image_path'"));
        }
        let png = process_screenshot(image_path)?;
        inputs.insert(format!("ex_{i}_title").into(), title.into_value());
        files.push((format!("ex_{i}.png"), png));
    }
    Ok(())
}

/// Carga un PNG desde ruta absoluta, recorta su 5% inferior y lo re-encode a
/// bytes PNG en memoria. Ruta inexistente / imagen inválida → error descriptivo.
fn process_screenshot(path: &str) -> Result<Vec<u8>, String> {
    if !std::path::Path::new(path).exists() {
        return Err(format!("No existe screenshot: {path}"));
    }
    let img = image::open(path)
        .map_err(|e| format!("No se pudo abrir screenshot '{path}': {e}"))?;

    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(format!("Screenshot vacío: {path}"));
    }
    // Recortar 5% inferior → conservar el 95% superior.
    let keep_h = ((h as u64 * 95) / 100) as u32;
    let keep_h = keep_h.max(1);
    let cropped = img.crop_imm(0, 0, w, keep_h);

    let mut buf: Vec<u8> = Vec::new();
    cropped
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| format!("No se pudo re-encode screenshot '{path}': {e}"))?;
    Ok(buf)
}

// ─── Helpers de salida / detección ───────────────────────────────────────────

/// Detecta la universidad leyendo `canvas_url` de settings. Si la URL contiene
/// "usil" → "USIL"; "utec" → "UTEC"; en otro caso "none" (carátula solo-texto).
fn detect_university(app: &tauri::AppHandle) -> String {
    let url = read_setting(app, "canvas_url").unwrap_or_default().to_lowercase();
    if url.contains("usil") {
        "USIL".to_string()
    } else if url.contains("utec") {
        "UTEC".to_string()
    } else {
        "none".to_string()
    }
}

/// Directorio de salida: si `storage_preference == "local_folder"` y hay
/// `download_path`, usarlo; en otro caso Downloads del SO (fallback al home).
fn resolve_output_dir(app: &tauri::AppHandle) -> PathBuf {
    let pref = read_setting(app, "storage_preference").unwrap_or_default();
    if pref == "local_folder" {
        if let Some(p) = read_setting(app, "download_path").filter(|p| !p.is_empty()) {
            let pb = PathBuf::from(p);
            if pb.is_dir() {
                return pb;
            }
        }
    }
    dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"))
}

/// Lee un setting de la DB. Devuelve None si la DB no abre o la clave no existe
/// (nunca panic).
fn read_setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let conn = crate::open_db(app).ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|v| !v.is_empty())
}

/// Sanitiza un nombre de archivo: conserva alfanuméricos + `-_ `; fallback
/// "documento" si queda vacío.
fn sanitize_filename(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() {
        "documento".to_string()
    } else {
        s
    }
}

/// Fecha actual en español, formato "D de MMMM de YYYY".
fn current_date_es() -> String {
    use chrono::Datelike;
    let now = chrono::Local::now();
    let meses = [
        "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
        "septiembre", "octubre", "noviembre", "diciembre",
    ];
    let mes = meses
        .get((now.month() as usize).saturating_sub(1))
        .copied()
        .unwrap_or("");
    format!("{} de {} de {}", now.day(), mes, now.year())
}

/// Construye un result de error JSON uniforme.
fn err(msg: &str) -> serde_json::Value {
    serde_json::json!({ "error": msg })
}

// =============================================================================
// StyleConfig — configuración de estilo de documento (Fase 1)
// =============================================================================
//
// Refleja la tabla single-row `document_style` (migración 17). Es la fuente de
// verdad que parametriza los templates Typst (Fase 3) vía `format!()` Rust-owned.
// El agente NUNCA construye un StyleConfig: lo lee el backend desde la DB en
// runtime (igual que `detect_university`), por lo que NINGÚN campo de geometría
// llega al `eval(mode:markup)` del body → invariante de seguridad intacta.
//
// `orientation` y `presentation_ratio` se modelan como enums: su dominio es
// cerrado y binario, y al ser enums serde RECHAZA en la frontera de
// deserialización cualquier valor fuera de dominio (validación gratis para el
// comando `set_*`). El resto de dimensiones tienen dominios distintos entre sí
// (p.ej. cover_theme∈{light,dark,minimal} vs presentation_theme∈{light,dark,
// colorful}) y se validan por allowlist en `validate()`.

/// Orientación de página. Dominio cerrado → enum (serde valida en deserialización).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Landscape,
}

impl Default for Orientation {
    fn default() -> Self {
        Orientation::Portrait
    }
}

impl Orientation {
    /// Representación canónica en DB (columna TEXT).
    pub fn as_str(&self) -> &'static str {
        match self {
            Orientation::Portrait => "portrait",
            Orientation::Landscape => "landscape",
        }
    }

    /// Parsea desde el valor TEXT de la DB; desconocido → default (Portrait).
    fn from_db(s: &str) -> Self {
        match s {
            "landscape" => Orientation::Landscape,
            _ => Orientation::Portrait,
        }
    }
}

/// Ratio de presentación. Dominio cerrado → enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Ratio {
    #[serde(rename = "16:9")]
    R16_9,
    #[serde(rename = "4:3")]
    R4_3,
}

impl Default for Ratio {
    fn default() -> Self {
        Ratio::R16_9
    }
}

impl Ratio {
    /// Representación canónica en DB (columna TEXT).
    pub fn as_str(&self) -> &'static str {
        match self {
            Ratio::R16_9 => "16:9",
            Ratio::R4_3 => "4:3",
        }
    }

    /// Parsea desde el valor TEXT de la DB; desconocido → default (16:9).
    fn from_db(s: &str) -> Self {
        match s {
            "4:3" => Ratio::R4_3,
            _ => Ratio::R16_9,
        }
    }
}

/// Configuración de estilo de documento. Espeja `document_style` (id=1).
/// Los campos String/numéricos respetan el almacenamiento TEXT/INTEGER/REAL del
/// spec; la validación de dominio se hace en `validate()` (comandos `set_*`) y el
/// clamp a defaults en `from_row` (lectura tolerante).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StyleConfig {
    pub format: String,             // apa | harvard | ieee | mla
    pub font_family: String,        // inter | lora | mono
    pub font_size: i64,             // 10..=14
    pub line_height: f64,           // 1.0 | 1.15 | 1.5 | 2.0
    pub margins_cm: f64,            // 2.0 | 2.5 | 3.0
    pub orientation: Orientation,   // portrait | landscape
    pub logo: String,               // usil | utec | none
    pub cover_theme: String,        // light | dark | minimal
    pub accent_color: String,       // blue | red | green | purple
    pub presentation_ratio: Ratio,  // 16:9 | 4:3
    pub presentation_theme: String, // light | dark | colorful
}

// ─── Dominios permitidos (fuente única de validación + clamp) ────────────────
const FORMATS: &[&str] = &["apa", "harvard", "ieee", "mla"];
const FONTS: &[&str] = &["inter", "lora", "mono"];
const LINE_HEIGHTS: &[f64] = &[1.0, 1.15, 1.5, 2.0];
const MARGINS: &[f64] = &[2.0, 2.5, 3.0];
const LOGOS: &[&str] = &["usil", "utec", "none"];
const COVER_THEMES: &[&str] = &["light", "dark", "minimal"];
const ACCENTS: &[&str] = &["blue", "red", "green", "purple"];
const PRES_THEMES: &[&str] = &["light", "dark", "colorful"];

const FONT_SIZE_MIN: i64 = 10;
const FONT_SIZE_MAX: i64 = 14;

/// Compara floats de dominio discreto con tolerancia (evita errores de IEEE-754).
fn float_in(value: f64, allowed: &[f64]) -> bool {
    allowed.iter().any(|a| (a - value).abs() < 1e-6)
}

impl Default for StyleConfig {
    fn default() -> Self {
        StyleConfig {
            format: "apa".to_string(),
            font_family: "inter".to_string(),
            font_size: 12,
            line_height: 1.5,
            margins_cm: 2.5,
            orientation: Orientation::Portrait,
            logo: "none".to_string(),
            cover_theme: "light".to_string(),
            accent_color: "blue".to_string(),
            presentation_ratio: Ratio::R16_9,
            presentation_theme: "light".to_string(),
        }
    }
}

impl StyleConfig {
    /// Defaults válidos (apa, inter, 12, 1.5, 2.5, portrait, none, light, blue,
    /// 16:9, light). Alias explícito de `Default::default` para call-sites claros.
    pub fn defaults() -> Self {
        Self::default()
    }

    /// Valida que TODOS los campos String/numéricos estén dentro de dominio.
    /// `orientation`/`presentation_ratio` ya están garantizados por su tipo enum.
    /// Devuelve `Err(descripción)` ante el PRIMER campo inválido SIN mutar nada.
    pub fn validate(&self) -> Result<(), String> {
        if !FORMATS.contains(&self.format.as_str()) {
            return Err(format!(
                "format inválido: '{}' (esperado: {})",
                self.format,
                FORMATS.join(" | ")
            ));
        }
        if !FONTS.contains(&self.font_family.as_str()) {
            return Err(format!(
                "font_family inválido: '{}' (esperado: {})",
                self.font_family,
                FONTS.join(" | ")
            ));
        }
        if self.font_size < FONT_SIZE_MIN || self.font_size > FONT_SIZE_MAX {
            return Err(format!(
                "font_size fuera de rango: {} (esperado {}..={})",
                self.font_size, FONT_SIZE_MIN, FONT_SIZE_MAX
            ));
        }
        if !float_in(self.line_height, LINE_HEIGHTS) {
            return Err(format!(
                "line_height inválido: {} (esperado: 1.0 | 1.15 | 1.5 | 2.0)",
                self.line_height
            ));
        }
        if !float_in(self.margins_cm, MARGINS) {
            return Err(format!(
                "margins_cm inválido: {} (esperado: 2.0 | 2.5 | 3.0)",
                self.margins_cm
            ));
        }
        if !LOGOS.contains(&self.logo.as_str()) {
            return Err(format!(
                "logo inválido: '{}' (esperado: {})",
                self.logo,
                LOGOS.join(" | ")
            ));
        }
        if !COVER_THEMES.contains(&self.cover_theme.as_str()) {
            return Err(format!(
                "cover_theme inválido: '{}' (esperado: {})",
                self.cover_theme,
                COVER_THEMES.join(" | ")
            ));
        }
        if !ACCENTS.contains(&self.accent_color.as_str()) {
            return Err(format!(
                "accent_color inválido: '{}' (esperado: {})",
                self.accent_color,
                ACCENTS.join(" | ")
            ));
        }
        if !PRES_THEMES.contains(&self.presentation_theme.as_str()) {
            return Err(format!(
                "presentation_theme inválido: '{}' (esperado: {})",
                self.presentation_theme,
                PRES_THEMES.join(" | ")
            ));
        }
        Ok(())
    }

    /// Construye un StyleConfig desde una fila cruda de DB aplicando CLAMP a
    /// defaults por-campo: cualquier valor fuera de dominio se reemplaza por su
    /// default seguro. Garantiza que la lectura NUNCA produce un config inválido.
    #[allow(clippy::too_many_arguments)]
    fn from_row(
        format: String,
        font_family: String,
        font_size: i64,
        line_height: f64,
        margins_cm: f64,
        orientation: String,
        logo: String,
        cover_theme: String,
        accent_color: String,
        presentation_ratio: String,
        presentation_theme: String,
    ) -> Self {
        let d = StyleConfig::defaults();
        StyleConfig {
            format: clamp_str(format, FORMATS, d.format),
            font_family: clamp_str(font_family, FONTS, d.font_family),
            font_size: if (FONT_SIZE_MIN..=FONT_SIZE_MAX).contains(&font_size) {
                font_size
            } else {
                d.font_size
            },
            line_height: if float_in(line_height, LINE_HEIGHTS) {
                line_height
            } else {
                d.line_height
            },
            margins_cm: if float_in(margins_cm, MARGINS) {
                margins_cm
            } else {
                d.margins_cm
            },
            orientation: Orientation::from_db(&orientation),
            logo: clamp_str(logo, LOGOS, d.logo),
            cover_theme: clamp_str(cover_theme, COVER_THEMES, d.cover_theme),
            accent_color: clamp_str(accent_color, ACCENTS, d.accent_color),
            presentation_ratio: Ratio::from_db(&presentation_ratio),
            presentation_theme: clamp_str(presentation_theme, PRES_THEMES, d.presentation_theme),
        }
    }
}

/// Devuelve `value` si está en `allowed`, en otro caso el `fallback` (default).
fn clamp_str(value: String, allowed: &[&str], fallback: String) -> String {
    if allowed.contains(&value.as_str()) {
        value
    } else {
        fallback
    }
}

/// Lee el estilo base persistido (`document_style` id=1). Tolerante: si la DB no
/// abre, la fila no existe o algún campo está corrupto/fuera de dominio, devuelve
/// defaults (clamp por-campo). NUNCA falla → el call-site siempre obtiene un
/// StyleConfig válido.
pub fn read_document_style(app: &tauri::AppHandle) -> StyleConfig {
    let conn = match crate::open_db(app) {
        Ok(c) => c,
        Err(_) => return StyleConfig::defaults(),
    };

    let row = conn.query_row(
        "SELECT format, font_family, font_size, line_height, margins_cm, orientation, \
                logo, cover_theme, accent_color, presentation_ratio, presentation_theme \
         FROM document_style WHERE id = 1",
        [],
        |r| {
            Ok(StyleConfig::from_row(
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, String>(10)?,
            ))
        },
    );

    row.unwrap_or_else(|_| StyleConfig::defaults())
}

// =============================================================================
// Override one-shot — pending_style_override (Fase 4)
// =============================================================================
//
// El modal de creación escribe un StyleConfig COMPLETO (pre-rellenado con los
// defaults persistidos + ajustes del usuario) en `pending_style_override`,
// keyed por la sesión de chat. `create_pdf` lo consume ONE-SHOT: lo lee, lo
// mergea sobre la base y, tras una generación EXITOSA, borra la fila.

/// Combina el estilo base persistido con un override one-shot opcional.
///
/// Precedencia: **override > base**. Como el override (cuando existe) es un
/// `StyleConfig` COMPLETO (todas las columnas NOT NULL; el modal lo pre-rellena
/// con la base), la precedencia se materializa reemplazando la base por completo.
/// Sin override → se usa la base tal cual.
fn merge_style(base: StyleConfig, over: Option<StyleConfig>) -> StyleConfig {
    over.unwrap_or(base)
}

/// Columnas del SELECT de override, en el orden que espera `StyleConfig::from_row`
/// (precedido por `session_id`).
const PENDING_COLS: &str = "session_id, format, font_family, font_size, line_height, \
     margins_cm, orientation, logo, cover_theme, accent_color, presentation_ratio, \
     presentation_theme";

/// Mapea una fila de `pending_style_override` a `(session_id, StyleConfig)`.
/// Aplica clamp por-campo vía `from_row` (la fila NUNCA produce un config inválido).
fn map_pending_row(r: &rusqlite::Row) -> rusqlite::Result<(i64, StyleConfig)> {
    Ok((
        r.get::<_, i64>(0)?,
        StyleConfig::from_row(
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, f64>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, String>(11)?,
        ),
    ))
}

/// Lee (SIN consumir) el override pendiente sobre una conexión dada. Si
/// `session_id` es `Some`, busca esa sesión; si es `None`, devuelve el más
/// reciente (`created_at DESC`) como fallback resiliente. Devuelve también el
/// `session_id` de la fila para poder borrar exactamente esa fila al consumir.
fn select_pending_override(
    conn: &rusqlite::Connection,
    session_id: Option<i64>,
) -> Option<(i64, StyleConfig)> {
    match session_id {
        Some(id) => conn
            .query_row(
                &format!("SELECT {PENDING_COLS} FROM pending_style_override WHERE session_id = ?1"),
                [id],
                map_pending_row,
            )
            .ok(),
        None => conn
            .query_row(
                &format!(
                    "SELECT {PENDING_COLS} FROM pending_style_override \
                     ORDER BY created_at DESC, session_id DESC LIMIT 1"
                ),
                [],
                map_pending_row,
            )
            .ok(),
    }
}

/// Borra la fila de override consumida sobre una conexión dada. Idempotente.
fn delete_pending_override(conn: &rusqlite::Connection, session_id: i64) {
    let _ = conn.execute(
        "DELETE FROM pending_style_override WHERE session_id = ?1",
        [session_id],
    );
}

/// Lee el override pendiente desde la DB (sin consumir). Tolerante: si la DB no
/// abre o no hay fila → `None`. Devuelve `(session_id_fila, StyleConfig)`.
fn read_pending_override(
    app: &tauri::AppHandle,
    session_id: Option<i64>,
) -> Option<(i64, StyleConfig)> {
    let conn = crate::open_db(app).ok()?;
    select_pending_override(&conn, session_id)
}

/// Borra el override consumido (one-shot) tras una generación exitosa. Tolerante:
/// si la DB no abre o la fila ya no existe, no hace nada.
fn clear_pending_override(app: &tauri::AppHandle, session_id: i64) {
    if let Ok(conn) = crate::open_db(app) {
        delete_pending_override(&conn, session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_strips_unsafe() {
        assert_eq!(sanitize_filename("Tarea 1: análisis/v2"), "Tarea 1 análisisv2");
        assert_eq!(sanitize_filename("***"), "documento");
        assert_eq!(sanitize_filename(""), "documento");
    }

    #[test]
    fn current_date_es_format() {
        let d = current_date_es();
        assert!(d.contains(" de "));
    }

    #[test]
    fn process_screenshot_missing_path_errors() {
        let r = process_screenshot("/nope/does/not/exist.png");
        assert!(r.is_err());
        assert!(r.unwrap_err().starts_with("No existe screenshot:"));
    }

    #[test]
    fn build_informe_requires_body() {
        let mut inputs = Dict::new();
        let args = serde_json::json!({ "doc_type": "informe" });
        assert!(build_informe(&args, &mut inputs).is_err());

        let mut inputs2 = Dict::new();
        let args2 = serde_json::json!({ "doc_type": "informe", "body": "== Hola" });
        assert!(build_informe(&args2, &mut inputs2).is_ok());
    }

    #[test]
    fn build_presentacion_requires_non_empty_slides() {
        let mut inputs = Dict::new();
        let args = serde_json::json!({ "slides": [] });
        assert!(build_presentacion(&args, &mut inputs).is_err());

        let mut inputs2 = Dict::new();
        let args2 = serde_json::json!({ "slides": [{ "heading": "H", "content": "C" }] });
        assert!(build_presentacion(&args2, &mut inputs2).is_ok());
    }

    #[test]
    fn build_tarea_requires_non_empty_exercises() {
        let mut inputs = Dict::new();
        let mut files = Vec::new();
        let args = serde_json::json!({ "exercises": [] });
        assert!(build_tarea(&args, &mut inputs, &mut files).is_err());
    }

    // ─── StyleConfig (Fase 1) ────────────────────────────────────────────────

    #[test]
    fn style_defaults_are_valid() {
        let d = StyleConfig::defaults();
        assert_eq!(d.format, "apa");
        assert_eq!(d.font_family, "inter");
        assert_eq!(d.font_size, 12);
        assert_eq!(d.line_height, 1.5);
        assert_eq!(d.margins_cm, 2.5);
        assert_eq!(d.orientation, Orientation::Portrait);
        assert_eq!(d.logo, "none");
        assert_eq!(d.cover_theme, "light");
        assert_eq!(d.accent_color, "blue");
        assert_eq!(d.presentation_ratio, Ratio::R16_9);
        assert_eq!(d.presentation_theme, "light");
        // Los defaults SIEMPRE pasan su propia validación.
        assert!(d.validate().is_ok());
    }

    #[test]
    fn style_validate_rejects_out_of_domain() {
        let mut c = StyleConfig::defaults();
        c.format = "vancouver".to_string();
        assert!(c.validate().is_err());

        let mut c2 = StyleConfig::defaults();
        c2.font_size = 99;
        assert!(c2.validate().is_err());

        let mut c3 = StyleConfig::defaults();
        c3.line_height = 1.3;
        assert!(c3.validate().is_err());

        let mut c4 = StyleConfig::defaults();
        c4.accent_color = "cyan".to_string();
        assert!(c4.validate().is_err());
    }

    #[test]
    fn style_validate_accepts_valid_non_default() {
        let c = StyleConfig {
            format: "ieee".to_string(),
            font_family: "lora".to_string(),
            font_size: 14,
            line_height: 2.0,
            margins_cm: 3.0,
            orientation: Orientation::Landscape,
            logo: "usil".to_string(),
            cover_theme: "minimal".to_string(),
            accent_color: "red".to_string(),
            presentation_ratio: Ratio::R4_3,
            presentation_theme: "colorful".to_string(),
        };
        assert!(c.validate().is_ok());
    }

    #[test]
    fn style_from_row_clamps_invalid_fields() {
        // Fila corrupta: cada campo fuera de dominio → debe caer a su default.
        let c = StyleConfig::from_row(
            "vancouver".to_string(), // → apa
            "comic".to_string(),     // → inter
            99,                      // → 12
            9.9,                     // → 1.5
            0.1,                     // → 2.5
            "diagonal".to_string(),  // → portrait
            "harvard_logo".to_string(), // → none
            "neon".to_string(),      // → light
            "cyan".to_string(),      // → blue
            "21:9".to_string(),      // → 16:9
            "rainbow".to_string(),   // → light
        );
        assert_eq!(c, StyleConfig::defaults());
    }

    #[test]
    fn style_from_row_preserves_valid_fields() {
        let c = StyleConfig::from_row(
            "mla".to_string(),
            "mono".to_string(),
            10,
            1.15,
            2.0,
            "landscape".to_string(),
            "utec".to_string(),
            "dark".to_string(),
            "green".to_string(),
            "4:3".to_string(),
            "dark".to_string(),
        );
        assert_eq!(c.format, "mla");
        assert_eq!(c.font_family, "mono");
        assert_eq!(c.font_size, 10);
        assert_eq!(c.line_height, 1.15);
        assert_eq!(c.margins_cm, 2.0);
        assert_eq!(c.orientation, Orientation::Landscape);
        assert_eq!(c.logo, "utec");
        assert_eq!(c.cover_theme, "dark");
        assert_eq!(c.accent_color, "green");
        assert_eq!(c.presentation_ratio, Ratio::R4_3);
        assert_eq!(c.presentation_theme, "dark");
        assert!(c.validate().is_ok());
    }

    #[test]
    fn enums_serde_roundtrip_db_strings() {
        assert_eq!(Orientation::Portrait.as_str(), "portrait");
        assert_eq!(Orientation::Landscape.as_str(), "landscape");
        assert_eq!(Orientation::from_db("landscape"), Orientation::Landscape);
        assert_eq!(Orientation::from_db("???"), Orientation::Portrait);

        assert_eq!(Ratio::R16_9.as_str(), "16:9");
        assert_eq!(Ratio::R4_3.as_str(), "4:3");
        assert_eq!(Ratio::from_db("4:3"), Ratio::R4_3);
        assert_eq!(Ratio::from_db("???"), Ratio::R16_9);

        // serde de los enums respeta el dominio textual del frontend/DB.
        let j = serde_json::to_string(&Ratio::R16_9).unwrap();
        assert_eq!(j, "\"16:9\"");
        let o: Orientation = serde_json::from_str("\"landscape\"").unwrap();
        assert_eq!(o, Orientation::Landscape);
    }

    // ─── Override one-shot (Fase 4) ──────────────────────────────────────────

    #[test]
    fn merge_style_override_wins_over_base() {
        // Spec scenario "Override gana sobre default": base inter/apa, override
        // mono/ieee → el merge debe quedar con los valores del override.
        let base = StyleConfig::defaults(); // inter / apa
        let mut over = StyleConfig::defaults();
        over.font_family = "mono".to_string();
        over.format = "ieee".to_string();
        over.accent_color = "red".to_string();

        let merged = merge_style(base, Some(over));
        assert_eq!(merged.font_family, "mono");
        assert_eq!(merged.format, "ieee");
        assert_eq!(merged.accent_color, "red");
    }

    #[test]
    fn merge_style_uses_base_when_no_override() {
        let mut base = StyleConfig::defaults();
        base.accent_color = "green".to_string();
        base.margins_cm = 3.0;
        let merged = merge_style(base.clone(), None);
        assert_eq!(merged, base);
    }

    /// Crea una conexión SQLite in-memory con la tabla `pending_style_override`
    /// (esquema espejo de la migración 18) para testear el consumo one-shot sin
    /// necesitar un `AppHandle`.
    fn mem_db_with_pending() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("abrir sqlite in-memory");
        conn.execute_batch(
            "CREATE TABLE pending_style_override (
               session_id          INTEGER PRIMARY KEY,
               format              TEXT NOT NULL,
               font_family         TEXT NOT NULL,
               font_size           INTEGER NOT NULL,
               line_height         REAL NOT NULL,
               margins_cm          REAL NOT NULL,
               orientation         TEXT NOT NULL,
               logo                TEXT NOT NULL,
               cover_theme         TEXT NOT NULL,
               accent_color        TEXT NOT NULL,
               presentation_ratio  TEXT NOT NULL,
               presentation_theme  TEXT NOT NULL,
               created_at          TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .expect("crear tabla pending_style_override");
        conn
    }

    fn insert_pending(conn: &rusqlite::Connection, session_id: i64, cfg: &StyleConfig) {
        conn.execute(
            "INSERT INTO pending_style_override \
                (session_id, format, font_family, font_size, line_height, margins_cm, \
                 orientation, logo, cover_theme, accent_color, presentation_ratio, presentation_theme) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                session_id,
                cfg.format,
                cfg.font_family,
                cfg.font_size,
                cfg.line_height,
                cfg.margins_cm,
                cfg.orientation.as_str(),
                cfg.logo,
                cfg.cover_theme,
                cfg.accent_color,
                cfg.presentation_ratio.as_str(),
                cfg.presentation_theme,
            ],
        )
        .expect("insertar override pendiente");
    }

    #[test]
    fn pending_override_read_then_clear_one_shot() {
        let conn = mem_db_with_pending();
        let mut harvard = StyleConfig::defaults();
        harvard.format = "harvard".to_string();
        harvard.font_family = "lora".to_string();
        insert_pending(&conn, 42, &harvard);

        // 1. Lectura por session_id → devuelve el override (harvard/lora).
        let read = select_pending_override(&conn, Some(42));
        assert!(read.is_some(), "el override debe leerse antes de consumir");
        let (sid, cfg) = read.unwrap();
        assert_eq!(sid, 42);
        assert_eq!(cfg.format, "harvard");
        assert_eq!(cfg.font_family, "lora");

        // 2. Consumo one-shot: borrar la fila exacta.
        delete_pending_override(&conn, 42);

        // 3. Releer → vacío (la fila se limpió post-consumo).
        assert!(
            select_pending_override(&conn, Some(42)).is_none(),
            "tras el consumo one-shot la fila debe estar limpia"
        );
    }

    #[test]
    fn pending_override_fallback_most_recent_when_no_session() {
        let conn = mem_db_with_pending();
        let mut a = StyleConfig::defaults();
        a.accent_color = "red".to_string();
        insert_pending(&conn, 7, &a);

        // session_id None → toma el más reciente (con una fila, esa).
        let read = select_pending_override(&conn, None);
        assert!(read.is_some());
        let (sid, cfg) = read.unwrap();
        assert_eq!(sid, 7);
        assert_eq!(cfg.accent_color, "red");
    }

    #[test]
    fn pending_override_absent_returns_none() {
        let conn = mem_db_with_pending();
        assert!(select_pending_override(&conn, Some(99)).is_none());
        assert!(select_pending_override(&conn, None).is_none());
    }
}
