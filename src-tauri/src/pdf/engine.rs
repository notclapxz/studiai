// =============================================================================
// PDF engine — wrapper sobre typst-as-lib =0.15.5
// =============================================================================
//
// NOTA (Fase 1, task 1.1): este archivo aún NO está enlazado vía `mod pdf;`
// (eso ocurre en Fase 2.10 / Fase 3). Por ahora solo documenta la API REAL
// verificada del crate, leída directamente del source de typst-as-lib 0.15.5
// (crate descargado de static.crates.io). NO son suposiciones.
//
// -----------------------------------------------------------------------------
// HALLAZGOS DE API VERIFICADOS — typst-as-lib =0.15.5
// -----------------------------------------------------------------------------
//
// Re-exports:
//   - typst-as-lib NO re-exporta `typst` ni `typst-pdf` (no hay `pub use typst...`).
//     Hay que añadirlos como deps DIRECTAS. Versión usada por la lib: 0.14.2
//     (confirmado en su Cargo.lock). Cargo.toml ya pinea:
//       typst-as-lib = "=0.15.5"
//       typst        = "=0.14.2"
//       typst-pdf    = "=0.14.2"
//   - typst-as-lib depende de `typst = "0.14"` y `chrono = "0.4"`. `typst-pdf`
//     es DEV-dependency en la lib, por eso debe declararse aparte en nuestro crate.
//
// Imports correctos (en este módulo, Fase 2):
//   use typst_as_lib::TypstEngine;
//   use typst::foundations::{Bytes, Dict, IntoValue};      // construir inputs
//   use typst::layout::PagedDocument;                       // tipo del documento
//   use typst::diag::SourceDiagnostic;                      // diagnostics verbatim
//   use ecow::EcoVec;                                       // contenedor de diagnostics
//
// Builder (estados de tipo: con/sin main_file):
//   let engine = TypstEngine::builder()
//       .main_file(template_src)             // S: IntoSource (&str / String del template)
//       .fonts([FONT_BYTES_A, FONT_BYTES_B]) // I: IntoIterator<Item = F: IntoFonts>
//                                            //    IntoFonts acepta &[u8], Vec<u8>, Bytes, Font
//       .with_static_file_resolver([("ex_0.png", png_bytes)]) // imágenes en memoria (tarea)
//                                            //    IB: IntoIterator<Item=(F: IntoFileId, B: IntoBytes)>
//       .build();
//
//   Resolver de archivos estáticos — FIRMAS EXACTAS (NO adivinadas):
//     .with_static_file_resolver([(file_id, bytes)])      // BINARIOS (imágenes)
//     .with_static_source_file_resolver([(id, src)])      // SOURCES .typ adicionales
//     .with_file_system_resolver(root: Into<PathBuf>)     // filesystem (NO se usa: todo en memoria)
//   => Para `tarea` usamos `with_static_file_resolver` con key "ex_{i}.png" y bytes PNG
//      recortados en memoria. El template referencia `image("ex_0.png", ...)`.
//
// Compilación (con main_file ya seteado):
//   let warned: typst::diag::Warned<Result<PagedDocument, typst_as_lib::TypstAsLibError>>
//       = engine.compile_with_input(inputs);   // inputs: D: Into<Dict>
//   // El doc-tag genérico Doc DEBE anotarse como PagedDocument (turbofish o binding tipado).
//   let doc: PagedDocument = warned.output?;   // .output: Result<PagedDocument, TypstAsLibError>
//   // .warnings: EcoVec<SourceDiagnostic>  (disponible pero opcional)
//
//   OJO: `.output` NO es `Vec<SourceDiagnostic>` (como asumía el design borrador).
//        Es `Result<Doc, TypstAsLibError>`. Para diagnostics verbatim hay que
//        hacer match sobre el error (ver abajo).
//
// Inputs (sys.inputs.*):
//   - NO existe macro `dict!` en typst-as-lib 0.15.5. (El design asumía
//     `typst_as_lib::dict` — INCORRECTO.)
//   - Construir un `typst::foundations::Dict` a mano:
//       let mut inputs = Dict::new();
//       inputs.insert("title".into(), title.into_value());
//       inputs.insert("university".into(), uni.into_value());
//       ... // strings vía IntoValue; serializar slides[] a JSON string e inyectar como string
//   - Alternativa (NO adoptada en Fase 1): crate `derive_typst_intoval` (#[derive(IntoDict)])
//     es opcional; preferimos Dict manual para no añadir otra dep.
//   - Accesibles en el template como `sys.inputs.title`, etc.
//
// Tipo de error — typst_as_lib::TypstAsLibError (enum, derive thiserror, Clone):
//   TypstSource(EcoVec<SourceDiagnostic>)   // <- errores de compilación del usuario
//   TypstFile(FileError)
//   MainSourceFileDoesNotExist(FileId)
//   HintedString(HintedString)
//   Unspecified(EcoString)
//
//   format_diagnostics (Fase 2.2): para feedback verbatim al loop agéntico ->
//     match err {
//         TypstAsLibError::TypstSource(diags) =>
//             diags.iter()
//                  .map(|d| format!("{}", d.message))  // + span/ubicación si se desea
//                  .collect::<Vec<_>>()
//                  .join("\n"),
//         other => format!("{other}"),  // Display ya implementado por thiserror
//     }
//   (SourceDiagnostic expone .message, .span, .severity, .hints — typst::diag.)
//
// Export PDF (typst-pdf, dep directa):
//   use typst_pdf::{pdf, PdfOptions};
//   let bytes: Vec<u8> = typst_pdf::pdf(&doc, &PdfOptions::default())
//       .map_err(|e| format!("{e:?}"))?;   // doc: &PagedDocument
//
// Resumen de firma objetivo del módulo (Fase 2.2):
//   pub fn compile(template: &str, inputs: Dict, files: &[(&str, Vec<u8>)])
//       -> Result<Vec<u8>, String>
//   // nunca panic; todo Err se mapea a String verbatim.
// =============================================================================
