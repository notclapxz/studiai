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
///
/// `#[allow(dead_code)]`: aún no enlazado al dispatch (eso es Fase 3). El `mod
/// pdf;` de Fase 2.10 hace que el módulo compile, pero nadie lo llama todavía.
#[allow(dead_code)]
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

    // Detección de universidad por canvas_url (settings).
    let university = detect_university(app);

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
    let template = match doc_type {
        "informe" => match build_informe(args, &mut inputs) {
            Ok(()) => templates::informe(),
            Err(e) => return err(&e),
        },
        "presentacion" => match build_presentacion(args, &mut inputs) {
            Ok(()) => templates::presentacion(),
            Err(e) => return err(&e),
        },
        "tarea" => match build_tarea(args, &mut inputs, &mut files) {
            Ok(()) => templates::tarea(),
            Err(e) => return err(&e),
        },
        other => return err(&format!("doc_type inválido: '{other}'")),
    };

    // Compilar a bytes PDF. Err → verbatim al agente.
    let pdf_bytes = match engine::compile(&template, inputs, &files) {
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
}
