// canvas/cleanup.rs — Limpieza post-sync: duplicados y huérfanos de Canvas LMS
//
// Reglas de negocio:
//   1. Duplicado Canvas: título con sufijo " (\d+)" en el stem (ej: "notas (1).pdf").
//      Solo se elimina si existe un documento base (sin el sufijo) en el mismo curso.
//   2. Huérfano: canvas_file_id que ya no aparece en el sync actual de Canvas.
//   3. Orden de borrado SIEMPRE: archivo físico PRIMERO → DELETE en DB DESPUÉS.
//   4. Errores de fs no abortan el sync — solo warn!.

use log::warn;
use regex::Regex;
use rusqlite::{params, Connection};
use std::path::Path;

// ─── Helpers internos ─────────────────────────────────────────────────────────

/// Separa el stem y la extensión de un título de archivo Canvas.
///
/// "matemáticas (1).pdf" → ("matemáticas (1)", ".pdf")
/// "notas" → ("notas", "")
/// "archivo.tar.gz" → ("archivo.tar", ".gz")  ← último punto
fn split_stem_ext(title: &str) -> (&str, &str) {
    if let Some(dot_pos) = title.rfind('.') {
        (&title[..dot_pos], &title[dot_pos..])
    } else {
        (title, "")
    }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/// Elimina el sufijo de duplicado Canvas del stem de un título de archivo.
///
/// Patrón reconocido: " (\d+)" al final del stem (insensible a mayúsculas).
///
/// Ejemplos:
///   "matemáticas (1).pdf"        → Some("matemáticas.pdf")
///   "nota (10).md"               → Some("nota.md")
///   "archivo (versión final).pdf" → None  (el paréntesis no contiene solo dígitos)
///   "notas.pdf"                  → None  (no hay sufijo de duplicado)
pub fn strip_canvas_duplicate_suffix(title: &str) -> Option<String> {
    // Compilar una sola vez por llamada — el regex es simple, el costo es mínimo.
    // Si se necesita rendimiento en hot-paths, envolver en once_cell::sync::Lazy.
    let re = Regex::new(r"(?i)\s\(\d+\)$").expect("regex de duplicado Canvas inválido");

    let (stem, ext) = split_stem_ext(title);

    if re.is_match(stem) {
        let clean_stem = re.replace(stem, "");
        Some(format!("{}{}", clean_stem, ext))
    } else {
        None
    }
}

/// Elimina duplicados Canvas de un curso específico.
///
/// Un duplicado es un documento cuyo título contiene el patrón " (\d+)" en el stem
/// Y existe un documento base (sin ese sufijo) en el mismo curso.
///
/// Orden garantizado: borrar archivo físico → DELETE DB.
/// Si falla el borrado físico → warn! y continúa con el DELETE igual.
/// Si file_path es NULL → skip del borrado físico, ejecuta DELETE igual.
///
/// Retorna la cantidad de duplicados eliminados.
pub fn cleanup_duplicates(
    conn: &Connection,
    course_id: i64,
    app_data_dir: &Path,
) -> Result<usize, rusqlite::Error> {
    // Obtener todos los documentos del curso con su título y path
    let mut stmt =
        conn.prepare("SELECT id, title, file_path FROM documents WHERE course_id = ?1")?;

    struct DocRow {
        id: i64,
        title: String,
        file_path: Option<String>,
    }

    let docs: Vec<DocRow> = stmt
        .query_map(params![course_id], |row| {
            Ok(DocRow {
                id: row.get(0)?,
                title: row.get(1)?,
                file_path: row.get(2)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    // Construir set de títulos base para lookup O(1)
    let base_titles: std::collections::HashSet<String> =
        docs.iter().map(|d| d.title.clone()).collect();

    let mut removed = 0usize;

    for doc in &docs {
        // Verificar si este documento es un duplicado Canvas
        let base_title = match strip_canvas_duplicate_suffix(&doc.title) {
            Some(t) => t,
            None => continue, // No es duplicado
        };

        // Solo eliminar si existe el documento base en el mismo curso
        if !base_titles.contains(&base_title) {
            continue;
        }

        // Borrar archivo físico PRIMERO
        if let Some(ref path_str) = doc.file_path {
            // file_path puede ser absoluto o relativo al app_data_dir
            let abs_path = if Path::new(path_str).is_absolute() {
                Path::new(path_str).to_path_buf()
            } else {
                app_data_dir.join(path_str)
            };

            if abs_path.exists() {
                if let Err(e) = std::fs::remove_file(&abs_path) {
                    warn!(
                        "[canvas::cleanup] Error borrando archivo físico '{}': {}. Continúa con DELETE en DB.",
                        abs_path.display(),
                        e
                    );
                }
            }
            // Si no existe en disco → skip silencioso, continúa con DELETE
        }
        // Si file_path es NULL → skip silencioso del borrado físico

        // DELETE en DB después del borrado físico (o skip del mismo)
        conn.execute("DELETE FROM documents WHERE id = ?1", params![doc.id])?;
        removed += 1;
    }

    Ok(removed)
}

/// Elimina documentos huérfanos del curso: registros en DB cuyo canvas_file_id
/// no aparece en la lista de IDs del último sync de Canvas.
///
/// Orden garantizado: borrar archivo físico → DELETE DB.
/// Errores de fs → warn!, continúa con DELETE.
///
/// Retorna la cantidad de huérfanos eliminados.
pub fn cleanup_orphans(
    conn: &Connection,
    course_id: i64,
    current_canvas_file_ids: &[i64],
    app_data_dir: &Path,
) -> Result<usize, rusqlite::Error> {
    // Obtener todos los documentos con canvas_file_id para el curso
    let mut stmt = conn.prepare(
        "SELECT id, canvas_file_id, file_path FROM documents
         WHERE course_id = ?1 AND canvas_file_id IS NOT NULL",
    )?;

    struct OrphanRow {
        id: i64,
        canvas_file_id: i64,
        file_path: Option<String>,
    }

    let docs: Vec<OrphanRow> = stmt
        .query_map(params![course_id], |row| {
            Ok(OrphanRow {
                id: row.get(0)?,
                canvas_file_id: row.get(1)?,
                file_path: row.get(2)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    // Set de IDs actuales para lookup O(1)
    let current_ids: std::collections::HashSet<i64> =
        current_canvas_file_ids.iter().copied().collect();

    let mut removed = 0usize;

    for doc in &docs {
        // Si el canvas_file_id sigue en el sync actual → no es huérfano
        if current_ids.contains(&doc.canvas_file_id) {
            continue;
        }

        // Borrar archivo físico PRIMERO
        if let Some(ref path_str) = doc.file_path {
            let abs_path = if Path::new(path_str).is_absolute() {
                Path::new(path_str).to_path_buf()
            } else {
                app_data_dir.join(path_str)
            };

            if abs_path.exists() {
                if let Err(e) = std::fs::remove_file(&abs_path) {
                    warn!(
                        "[canvas::cleanup] Error borrando huérfano físico '{}': {}. Continúa con DELETE en DB.",
                        abs_path.display(),
                        e
                    );
                }
            }
        }

        // DELETE en DB
        conn.execute("DELETE FROM documents WHERE id = ?1", params![doc.id])?;
        removed += 1;
    }

    Ok(removed)
}

// ─── Tests unitarios ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── strip_canvas_duplicate_suffix ────────────────────────────────────────

    #[test]
    fn test_strip_pdf_con_numero() {
        // Caso base: duplicado típico con número
        assert_eq!(
            strip_canvas_duplicate_suffix("matemáticas (1).pdf"),
            Some("matemáticas.pdf".to_string())
        );
    }

    #[test]
    fn test_strip_numero_doble_digito() {
        assert_eq!(
            strip_canvas_duplicate_suffix("nota (10).md"),
            Some("nota.md".to_string())
        );
    }

    #[test]
    fn test_no_strip_version_final() {
        // Paréntesis con texto no-numérico → no es duplicado
        assert_eq!(
            strip_canvas_duplicate_suffix("archivo (versión final).pdf"),
            None
        );
    }

    #[test]
    fn test_no_strip_sin_sufijo() {
        // Título sin ningún paréntesis
        assert_eq!(strip_canvas_duplicate_suffix("matemáticas.pdf"), None);
    }

    #[test]
    fn test_no_strip_sin_extension() {
        assert_eq!(strip_canvas_duplicate_suffix("notas"), None);
    }

    #[test]
    fn test_strip_sin_extension_con_numero() {
        // Stem sin extensión con sufijo numérico
        assert_eq!(
            strip_canvas_duplicate_suffix("notas (2)"),
            Some("notas".to_string())
        );
    }

    // ── cleanup_duplicates con DB in-memory ──────────────────────────────────

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE courses (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                course_id INTEGER,
                canvas_file_id INTEGER,
                title TEXT NOT NULL,
                file_path TEXT
            );
        ",
        )
        .unwrap();
        // Insertar un curso de prueba
        conn.execute("INSERT INTO courses (id, name) VALUES (1, 'Test')", [])
            .unwrap();
        conn
    }

    #[test]
    fn test_cleanup_duplicates_borra_duplicado_con_base() {
        let conn = setup_test_db();
        // Insertar base + duplicado
        conn.execute(
            "INSERT INTO documents (course_id, title, file_path) VALUES (1, 'matemáticas.pdf', NULL)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO documents (course_id, title, file_path) VALUES (1, 'matemáticas (1).pdf', NULL)",
            [],
        ).unwrap();

        let removed = cleanup_duplicates(&conn, 1, Path::new("/tmp")).unwrap();
        assert_eq!(removed, 1);

        // Solo debe quedar el documento base
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE course_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let title: String = conn
            .query_row("SELECT title FROM documents WHERE course_id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "matemáticas.pdf");
    }

    #[test]
    fn test_cleanup_duplicates_no_borra_sin_base() {
        let conn = setup_test_db();
        // Solo el duplicado, sin el documento base
        conn.execute(
            "INSERT INTO documents (course_id, title, file_path) VALUES (1, 'matemáticas (1).pdf', NULL)",
            [],
        ).unwrap();

        let removed = cleanup_duplicates(&conn, 1, Path::new("/tmp")).unwrap();
        assert_eq!(removed, 0);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE course_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    // ── cleanup_orphans con DB in-memory ─────────────────────────────────────

    #[test]
    fn test_cleanup_orphans_borra_huerfano() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO documents (course_id, canvas_file_id, title, file_path) VALUES (1, 999, 'viejo.pdf', NULL)",
            [],
        ).unwrap();

        // canvas_ids actuales no incluye 999 → es huérfano
        let removed = cleanup_orphans(&conn, 1, &[], Path::new("/tmp")).unwrap();
        assert_eq!(removed, 1);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE course_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_cleanup_orphans_no_borra_presente() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO documents (course_id, canvas_file_id, title, file_path) VALUES (1, 42, 'actual.pdf', NULL)",
            [],
        ).unwrap();

        // 42 está en el sync actual → no es huérfano
        let removed = cleanup_orphans(&conn, 1, &[42], Path::new("/tmp")).unwrap();
        assert_eq!(removed, 0);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE course_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_cleanup_orphans_canvas_ids_vacio_borra_todos() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO documents (course_id, canvas_file_id, title) VALUES (1, 1, 'a.pdf')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO documents (course_id, canvas_file_id, title) VALUES (1, 2, 'b.pdf')",
            [],
        )
        .unwrap();

        let removed = cleanup_orphans(&conn, 1, &[], Path::new("/tmp")).unwrap();
        assert_eq!(removed, 2);
    }
}
