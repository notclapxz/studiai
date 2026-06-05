// =============================================================================
// PDF engine — wrapper sobre typst-as-lib =0.15.5
// =============================================================================
//
// API VERIFICADA leyendo el source de typst-as-lib 0.15.5 (Fase 1, task 1.1).
// Puntos críticos (corrigen el design borrador):
//   1. NO existe macro `dict!`. Los inputs se construyen con `Dict::new()` +
//      `IntoValue::into_value()`. Accesibles en el template como `sys.inputs.*`.
//   2. `compile_with_input` devuelve `Warned<Result<Doc, TypstAsLibError>>`.
//      `.output` es `Result<PagedDocument, TypstAsLibError>` (NO un
//      `Vec<SourceDiagnostic>`). Las diagnostics verbatim salen del enum de error.
//   3. typst y typst-pdf NO se re-exportan: se importan de sus crates directos.
//   4. Imágenes en memoria (tarea) → `.with_static_file_resolver([(key, bytes)])`,
//      key "ex_{i}.png"; el template referencia `image("ex_0.png", ...)`.
//   5. Export: `typst_pdf::pdf(&doc, &PdfOptions::default())`.
//
// Garantía: ninguna ruta de código no-test usa `unwrap()`/`expect()`. Todo Err
// se mapea a `String` (verbatim cuando es un error de compilación del usuario)
// para alimentar el loop agéntico de auto-corrección.

use typst::diag::SourceDiagnostic;
use typst::foundations::Dict;
use typst::layout::PagedDocument;
use typst_as_lib::{TypstAsLibError, TypstEngine};
use typst_pdf::{pdf, PdfOptions};

use super::assets;

/// Compila un template Typst a bytes PDF.
///
/// - `template`: source Typst completo (geometría + carátula + cuerpo).
/// - `inputs`: `Dict` con los datos accesibles vía `sys.inputs.*`.
/// - `files`: pares `(key, bytes)` resueltos en memoria (imágenes de `tarea`,
///   key "ex_{i}.png"). Vacío para `informe`/`presentacion`.
///
/// Devuelve `Ok(pdf_bytes)` o `Err(diagnostico_verbatim)`. Nunca entra en panic.
pub fn compile(
    template: &str,
    inputs: Dict,
    files: &[(String, Vec<u8>)],
) -> Result<Vec<u8>, String> {
    // Builder: main_file (template) + fuentes embebidas + resolver de imágenes.
    // `.with_static_file_resolver` acepta IntoIterator<Item=(IntoFileId, IntoBytes)>.
    let engine = TypstEngine::builder()
        .main_file(template)
        .fonts(assets::FONTS.iter().copied())
        .with_static_file_resolver(
            files
                .iter()
                .map(|(k, v)| (k.as_str(), v.clone()))
                .collect::<Vec<_>>(),
        )
        .build();

    let warned = engine.compile_with_input(inputs);

    // `.output`: Result<PagedDocument, TypstAsLibError>. Anotamos el tipo del doc.
    let doc: PagedDocument = warned.output.map_err(format_error)?;

    // Export a PDF. typst_pdf::pdf devuelve Result<Vec<u8>, EcoVec<SourceDiagnostic>>.
    pdf(&doc, &PdfOptions::default()).map_err(|errs| format_diagnostics(&errs))
}

/// Mapea un `TypstAsLibError` a un string legible. Para errores de compilación
/// del usuario (`TypstSource`) devuelve las diagnostics verbatim (file:line +
/// mensaje) de modo que el agente pueda corregir y reintentar. El resto de
/// variantes usa su `Display` (derivado por thiserror).
fn format_error(err: TypstAsLibError) -> String {
    match err {
        TypstAsLibError::TypstSource(diags) => format_diagnostics(&diags),
        other => format!("{other}"),
    }
}

/// Formatea un conjunto de `SourceDiagnostic` a texto verbatim multi-línea.
/// Cada línea: `[severity] mensaje` + hints (si hay). El span no se resuelve a
/// número de línea concreto (requeriría acceso al `World`); el mensaje de typst
/// suele ser autoexplicativo para el loop de corrección.
fn format_diagnostics(diags: &[SourceDiagnostic]) -> String {
    if diags.is_empty() {
        return "Error de compilación Typst (sin diagnostics)".to_string();
    }
    diags
        .iter()
        .map(|d| {
            let sev = match d.severity {
                typst::diag::Severity::Error => "error",
                typst::diag::Severity::Warning => "warning",
            };
            let mut line = format!("[{sev}] {}", d.message);
            if !d.hints.is_empty() {
                line.push_str(" (hint: ");
                line.push_str(&d.hints.join("; "));
                line.push(')');
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use typst::foundations::IntoValue;

    /// Compila un informe mínimo a PDF in-memory y verifica que produce bytes
    /// PDF válidos (header %PDF, no vacío). Cubre el gate de fin de Fase 2.
    #[test]
    fn compiles_minimal_informe_to_pdf_bytes() {
        let template = super::super::templates::informe();
        let mut inputs = Dict::new();
        inputs.insert("title".into(), "Test".into_value());
        inputs.insert("course".into(), "Curso".into_value());
        inputs.insert("author".into(), "Autor".into_value());
        inputs.insert("date".into(), "4 de junio de 2026".into_value());
        inputs.insert("university".into(), "none".into_value());
        inputs.insert("body".into(), "== Sección\n\nTexto de prueba.".into_value());

        let result = compile(&template, inputs, &[]);
        let bytes = result.expect("informe mínimo debe compilar");
        assert!(!bytes.is_empty(), "PDF bytes no deben estar vacíos");
        assert_eq!(&bytes[0..5], b"%PDF-", "debe empezar con header %PDF-");
    }

    /// Markup Typst inválido debe devolver Err con diagnostics verbatim (no panic).
    #[test]
    fn invalid_markup_returns_error_not_panic() {
        let template = super::super::templates::informe();
        let mut inputs = Dict::new();
        inputs.insert("title".into(), "Test".into_value());
        inputs.insert("course".into(), "Curso".into_value());
        inputs.insert("author".into(), "Autor".into_value());
        inputs.insert("date".into(), "hoy".into_value());
        inputs.insert("university".into(), "none".into_value());
        // `#let` sin cuerpo / sintaxis rota → error de eval del body.
        inputs.insert("body".into(), "#let x =".into_value());

        let result = compile(&template, inputs, &[]);
        assert!(result.is_err(), "markup inválido debe ser Err");
    }
}
