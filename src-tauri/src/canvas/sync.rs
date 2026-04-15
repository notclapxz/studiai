// canvas/sync.rs — Orquestador de sincronización con Canvas LMS
//
// Emite eventos "canvas-sync-event" al frontend via tauri::Emitter.
// El frontend NO se modifica — los payloads son idénticos al sidecar Python anterior.

use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::time::sleep;

use super::classify::{classify_file, FileTier};
use super::cleanup;
use super::client::{CanvasClient, CanvasError};
use super::models::{CanvasAnnouncement, CanvasAssignment, CanvasCourse, CanvasFile, CanvasModule};

// ─────────────────────────────────────────────────────────────────────────────
// Payloads de eventos — deben ser idénticos a los emitidos por sync.py
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SyncEvent {
    Start {
        mode: String,
        incremental: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    Courses {
        data: Vec<CoursePayload>,
    },
    Progress {
        current: usize,
        total: usize,
        label: String,
    },
    Assignments {
        course_id: i64,
        data: Vec<AssignmentPayload>,
    },
    Announcements {
        course_id: i64,
        data: Vec<AnnouncementPayload>,
    },
    FilesMeta {
        course_id: i64,
        data: Vec<FileMetaPayload>,
    },
    FileSkipped {
        data: FileSkippedPayload,
    },
    Done {
        stats: SyncStats,
    },
    Error {
        fatal: bool,
        message: String,
    },
    RateLimited {
        retry_after: u64,
    },
    DownloadStarted {
        data: DownloadStartedPayload,
    },
    DownloadDone {
        data: DownloadDonePayload,
    },
    DownloadError {
        data: DownloadErrorPayload,
    },
    /// Evento no fatal que indica que algo falló pero el sync continúa.
    /// Ejemplo: un archivo individual dio 404/500 al obtener sus metadatos.
    Warning {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        course_id: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        file_id: Option<i64>,
    },
    /// Resultado de la fase de limpieza post-descarga.
    /// Informa al frontend cuántos duplicados y huérfanos se eliminaron.
    CleanupDone {
        duplicates_removed: usize,
        orphans_removed: usize,
    },
}

#[derive(serde::Serialize, Debug)]
struct CoursePayload {
    id: i64,
    name: String,
    code: String,
    term: String,
}

#[derive(serde::Serialize, Debug)]
struct AssignmentPayload {
    id: i64,
    name: String,
    due_at: Option<String>,
    points_possible: Option<f64>,
    submission_state: String,
    score: Option<f64>,
    grade: Option<String>,
    html_url: Option<String>,
}

#[derive(serde::Serialize, Debug)]
struct AnnouncementPayload {
    id: i64,
    title: String,
    posted_at: Option<String>,
    message: String,
    html_url: Option<String>,
}

#[derive(serde::Serialize, Debug, Clone)]
struct FileMetaPayload {
    id: i64,
    name: String,
    size_bytes: u64,
    content_type: String,
    url: String,
    tier: String,
    module_id: Option<i64>,
    module_name: Option<String>,
}

#[derive(serde::Serialize, Debug)]
struct FileSkippedPayload {
    file_id: i64,
    name: String,
    size_bytes: u64,
    reason: String,
    reason_human: String,
}

#[derive(serde::Serialize, Debug)]
struct SyncStats {
    courses: usize,
    assignments: usize,
    announcements: usize,
    files_auto: usize,
    files_skipped: usize,
    mb_downloaded: f64,
}

#[derive(serde::Serialize, Debug)]
struct DownloadStartedPayload {
    file_id: i64,
    name: String,
    size_bytes: u64,
}

#[derive(serde::Serialize, Debug)]
struct DownloadDonePayload {
    file_id: i64,
    local_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cached: Option<bool>,
}

#[derive(serde::Serialize, Debug)]
struct DownloadErrorPayload {
    file_id: i64,
    error: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn emit_event(window: &tauri::Window, event: &SyncEvent) {
    if let Err(e) = window.emit("canvas-sync-event", event) {
        eprintln!("[canvas::sync] Error al emitir evento: {e}");
    }
}

/// Emite el evento `canvas-token-expired` para que el frontend muestre notificación
fn emit_token_expired(window: &tauri::Window) {
    if let Err(e) = window.emit("canvas-token-expired", ()) {
        eprintln!("[canvas::sync] Error al emitir canvas-token-expired: {e}");
    }
}

/// Elimina etiquetas HTML básicas del texto (equivalente a strip_html de Python)
fn strip_html(html: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    // Colapsar espacios múltiples
    result
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Sanitiza un nombre de archivo para el sistema de archivos
fn sanitize_name(name: &str) -> String {
    // Normalizar unicode (NFC) — equivalente básico sin unicode-normalization
    // Reemplazar caracteres inválidos
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();

    // Colapsar espacios múltiples y strip
    let sanitized = sanitized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches('.')
        .to_string();

    // Limitar longitud a 100 caracteres
    if sanitized.is_empty() {
        "archivo_sin_nombre".to_string()
    } else {
        sanitized.chars().take(100).collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async fn fetch_courses(client: &CanvasClient) -> Result<Vec<CanvasCourse>, CanvasError> {
    client
        .get_paginated::<CanvasCourse>(
            "/api/v1/courses",
            &[
                ("enrollment_state", "active"),
                ("per_page", "50"),
                ("include[]", "term"),
            ],
        )
        .await
}

async fn fetch_assignments(
    client: &CanvasClient,
    course_id: i64,
    since: Option<&str>,
) -> Result<Vec<CanvasAssignment>, CanvasError> {
    let mut params: Vec<(&str, &str)> = vec![
        ("include[]", "submission"),
        ("order_by", "due_at"),
        ("per_page", "50"),
    ];
    // Canvas soporta updated_since en /assignments para sync incremental
    let since_owned: String;
    if let Some(s) = since {
        since_owned = s.to_string();
        params.push(("updated_since", &since_owned));
    }
    client
        .get_paginated::<CanvasAssignment>(
            &format!("/api/v1/courses/{}/assignments", course_id),
            &params,
        )
        .await
}

async fn fetch_announcements(
    client: &CanvasClient,
    course_id: i64,
    since: Option<&str>,
) -> Result<Vec<CanvasAnnouncement>, CanvasError> {
    let context_code = format!("course_{}", course_id);
    let mut params: Vec<(&str, &str)> = vec![
        ("context_codes[]", &context_code),
        ("per_page", "50"),
    ];
    // Canvas soporta updated_since en /announcements para sync incremental
    let since_owned: String;
    if let Some(s) = since {
        since_owned = s.to_string();
        params.push(("updated_since", &since_owned));
    }
    client
        .get_paginated::<CanvasAnnouncement>(
            "/api/v1/announcements",
            &params,
        )
        .await
}

/// Fetch de metadatos de archivos vía módulos del curso.
/// Retorna (auto_files, manual_files) con payloads listos para emitir.
///
/// Si un archivo individual falla (404, 500, etc.), se emite un `Warning`
/// no fatal al frontend y el bucle CONTINÚA con los archivos restantes.
async fn fetch_files_meta(
    client: &CanvasClient,
    course_id: i64,
    window: &tauri::Window,
) -> Result<(Vec<FileMetaPayload>, Vec<FileMetaPayload>), CanvasError> {
    // 1. Obtener módulos con sus items
    let modules = client
        .get_paginated::<CanvasModule>(
            &format!("/api/v1/courses/{}/modules", course_id),
            &[("include[]", "items"), ("per_page", "100")],
        )
        .await?;

    let mut auto_files: Vec<FileMetaPayload> = Vec::new();
    let mut manual_files: Vec<FileMetaPayload> = Vec::new();

    for module in &modules {
        let items = match &module.items {
            Some(items) => items,
            None => continue,
        };

        for item in items {
            if item.item_type != "File" {
                continue;
            }

            let file_api_url = match &item.url {
                Some(url) => url.clone(),
                None => continue,
            };

            // Fetch metadatos del archivo individual
            let file_info: CanvasFile = match client.get(&file_api_url, &[]).await {
                Ok(f) => f,
                Err(CanvasError::Unauthorized) => return Err(CanvasError::Unauthorized),
                Err(CanvasError::Forbidden) => return Err(CanvasError::Forbidden),
                Err(CanvasError::RateLimited(secs)) => {
                    // Propagar rate limit para que el orquestador lo maneje
                    return Err(CanvasError::RateLimited(secs));
                }
                Err(e) => {
                    // Error no fatal: loguear, emitir Warning al frontend
                    // y CONTINUAR con los archivos restantes del curso.
                    eprintln!(
                        "[canvas::sync] Error obteniendo info de archivo '{}' (curso {}): {}",
                        item.title, course_id, e
                    );
                    emit_event(window, &SyncEvent::Warning {
                        code: "file_meta_fetch_failed".to_string(),
                        message: format!(
                            "No se pudo obtener información del archivo «{}»: {}. Se omite y se continúa con el resto.",
                            item.title, e
                        ),
                        course_id: Some(course_id),
                        file_id: None,
                    });
                    continue;
                }
            };

            let name = file_info
                .display_name
                .or(file_info.filename)
                .unwrap_or_else(|| "desconocido".to_string());
            let size_bytes = file_info.size.unwrap_or(0);
            let content_type = file_info.content_type.unwrap_or_default();
            let url = file_info.url.unwrap_or_default();
            let file_id = file_info.id;

            let classification = classify_file(&name, &content_type, size_bytes);

            let payload = FileMetaPayload {
                id: file_id,
                name: name.clone(),
                size_bytes,
                content_type: content_type.clone(),
                url: url.clone(),
                tier: match classification.tier {
                    FileTier::Auto => "auto".to_string(),
                    FileTier::Manual => "manual".to_string(),
                },
                module_id: Some(module.id),
                module_name: Some(module.name.clone()),
            };

            match classification.tier {
                FileTier::Auto => auto_files.push(payload),
                FileTier::Manual => manual_files.push(payload),
            }
        }
    }

    Ok((auto_files, manual_files))
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversión de modelos a payloads
// ─────────────────────────────────────────────────────────────────────────────

fn course_to_payload(course: &CanvasCourse) -> CoursePayload {
    CoursePayload {
        id: course.id,
        name: course.name.clone(),
        code: course.course_code.clone().unwrap_or_default(),
        term: course
            .term
            .as_ref()
            .map(|t| t.name.clone())
            .unwrap_or_default(),
    }
}

fn assignment_to_payload(a: &CanvasAssignment) -> AssignmentPayload {
    let sub = a.submission.as_ref();
    let ws = sub
        .and_then(|s| s.workflow_state.as_deref())
        .unwrap_or("");
    let submission_state = match ws {
        "graded" => "graded",
        "submitted" => "submitted",
        _ => "pending",
    }
    .to_string();

    AssignmentPayload {
        id: a.id,
        name: a.name.clone(),
        due_at: a.due_at.clone(),
        points_possible: a.points_possible,
        submission_state,
        score: sub.and_then(|s| s.score),
        grade: sub.and_then(|s| s.grade.clone()),
        html_url: a.html_url.clone(),
    }
}

fn announcement_to_payload(a: &CanvasAnnouncement) -> AnnouncementPayload {
    AnnouncementPayload {
        id: a.id,
        title: a.title.clone(),
        posted_at: a.posted_at.clone().or_else(|| a.created_at.clone()),
        message: strip_html(a.message.as_deref().unwrap_or("")),
        html_url: a.html_url.clone(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// run_sync — Orquestador principal
// ─────────────────────────────────────────────────────────────────────────────

/// Orquesta la sincronización completa con Canvas LMS.
///
/// # Argumentos
/// - `canvas_url`: URL base de Canvas (con o sin https://)
/// - `token`: Token de la API de Canvas
/// - `modo`: "metadata" | "download"
/// - `course_id`: ID del curso (solo para download de un curso específico)
/// - `since`: Timestamp ISO8601 opcional para sync incremental (ej: "2026-04-08T00:00:00Z")
/// - `base_dir`: Directorio base para descargas
/// - `window`: Ventana Tauri para emitir eventos
pub async fn run_sync(
    canvas_url: String,
    token: String,
    modo: String,
    course_id: Option<i64>,
    since: Option<String>,
    base_dir: PathBuf,
    window: tauri::Window,
) -> Result<(), String> {
    // Crear cliente
    let client = CanvasClient::new(&canvas_url, &token)
        .map_err(|e| format!("Error al crear cliente Canvas: {e}"))?;

    match modo.as_str() {
        "metadata" => {
            run_metadata_sync(&client, &window, since.as_deref()).await?;
        }
        "download" => {
            run_download_sync(&client, &window, course_id, &base_dir).await?;
        }
        other => {
            return Err(format!(
                "Modo inválido: '{}'. Debe ser 'metadata' o 'download'.",
                other
            ));
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Modo metadata
// ─────────────────────────────────────────────────────────────────────────────

async fn run_metadata_sync(
    client: &CanvasClient,
    window: &tauri::Window,
    since: Option<&str>,
) -> Result<(), String> {
    let incremental = since.is_some();
    emit_event(window, &SyncEvent::Start {
        mode: "metadata".to_string(),
        incremental,
        since: since.map(|s| s.to_string()),
    });

    // 1. Fetch courses
    eprintln!("[canvas::sync] Obteniendo cursos...");
    let courses = match fetch_courses_with_retry(client, window).await {
        Ok(c) => c,
        Err(e) => {
            emit_event(window, &SyncEvent::Error {
                fatal: true,
                message: e.clone(),
            });
            return Err(e);
        }
    };

    if courses.is_empty() {
        let msg = "No se encontraron cursos activos. Verificá el token o el ciclo académico."
            .to_string();
        emit_event(window, &SyncEvent::Error {
            fatal: true,
            message: msg.clone(),
        });
        return Err(msg);
    }

    let course_payloads: Vec<CoursePayload> = courses.iter().map(course_to_payload).collect();
    emit_event(window, &SyncEvent::Courses {
        data: course_payloads,
    });

    let total = courses.len();
    let mut stats = SyncStats {
        courses: total,
        assignments: 0,
        announcements: 0,
        files_auto: 0,
        files_skipped: 0,
        mb_downloaded: 0.0,
    };

    // 2. Per-course data
    for (idx, course) in courses.iter().enumerate() {
        let cid = course.id;
        let cname = &course.name;

        emit_event(window, &SyncEvent::Progress {
            current: idx + 1,
            total,
            label: format!("Procesando {}...", cname),
        });
        eprintln!(
            "[canvas::sync] Procesando curso {}/{}: {} (id={})",
            idx + 1,
            total,
            cname,
            cid
        );

        // Assignments (con sync incremental si since está presente)
        let assignments = fetch_with_retry(|| fetch_assignments(client, cid, since), client, window).await;
        let assignment_payloads: Vec<AssignmentPayload> = assignments
            .iter()
            .map(assignment_to_payload)
            .collect();
        stats.assignments += assignment_payloads.len();
        emit_event(window, &SyncEvent::Assignments {
            course_id: cid,
            data: assignment_payloads,
        });

        // Announcements (con sync incremental si since está presente)
        let announcements =
            fetch_with_retry(|| fetch_announcements(client, cid, since), client, window).await;
        let announcement_payloads: Vec<AnnouncementPayload> = announcements
            .iter()
            .map(announcement_to_payload)
            .collect();
        stats.announcements += announcement_payloads.len();
        emit_event(window, &SyncEvent::Announcements {
            course_id: cid,
            data: announcement_payloads,
        });

        // Files metadata — siempre completo (Canvas no soporta updated_since para módulos)
        let (auto_files, manual_files) =
            fetch_files_with_retry(client, cid, window).await;

        // Emitir todos los archivos (auto + manual) en files_meta
        let all_files: Vec<FileMetaPayload> = auto_files
            .iter()
            .cloned()
            .chain(manual_files.iter().cloned())
            .collect();

        if !all_files.is_empty() {
            emit_event(window, &SyncEvent::FilesMeta {
                course_id: cid,
                data: all_files,
            });
        }

        // Emitir file_skipped para archivos manuales
        for f in &manual_files {
            let classification = classify_file(&f.name, &f.content_type, f.size_bytes);
            emit_event(window, &SyncEvent::FileSkipped {
                data: FileSkippedPayload {
                    file_id: f.id,
                    name: f.name.clone(),
                    size_bytes: f.size_bytes,
                    reason: classification
                        .reason_key
                        .unwrap_or_else(|| "manual".to_string()),
                    reason_human: classification
                        .reason
                        .unwrap_or_else(|| "No se descarga automáticamente".to_string()),
                },
            });
        }

        stats.files_auto += auto_files.len();
        stats.files_skipped += manual_files.len();
    }

    // Detección de deleciones en sync incremental.
    //
    // Canvas API `updated_since` retorna SOLO ítems actualizados, nunca
    // deleciones. Si un instructor borra una tarea o anuncio entre dos
    // syncs incrementales, la copia local persiste indefinidamente.
    //
    // Implementación completa (soft-delete con columna `deleted_at` en
    // assignments/announcements) está planeada en Bloque F (migración de
    // schema). Por ahora, en modo incremental emitimos una Warning no
    // fatal para que el frontend avise al usuario y sepa que debe correr
    // un sync completo (sin `since`) de forma periódica.
    //
    // TODO(Bloque F): una vez agregada la columna `deleted_at`, reemplazar
    // esta Warning por un fetch completo de IDs por curso y marcar como
    // eliminados los registros locales que no aparezcan en la respuesta.
    if incremental {
        emit_event(window, &SyncEvent::Warning {
            code: "incremental_no_deletion_detection".to_string(),
            message: "Sync incremental: las deleciones no se reconcilian en este modo. Ejecutá un sync completo periódicamente para limpiar tareas o anuncios eliminados en Canvas.".to_string(),
            course_id: None,
            file_id: None,
        });
    }

    emit_event(window, &SyncEvent::Done { stats });
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Modo download
// ─────────────────────────────────────────────────────────────────────────────

/// Lee un valor de settings desde la DB usando el app handle de la ventana.
fn read_setting(window: &tauri::Window, key: &str) -> Option<String> {
    let app = window.app_handle();
    let db_path = app
        .path()
        .app_data_dir()
        .ok()?
        .join("studyai.db");
    let conn = rusqlite::Connection::open(&db_path).ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    ).ok().filter(|v| !v.is_empty())
}

/// Espera hasta 60s a que el usuario elija una preferencia de almacenamiento.
/// Devuelve la preferencia elegida o error si expira el timeout.
async fn wait_for_storage_preference(window: &tauri::Window) -> Result<String, String> {
    const POLL_INTERVAL_MS: u64 = 200;
    const MAX_WAIT_MS: u64 = 60_000;
    let mut elapsed_ms: u64 = 0;

    while elapsed_ms < MAX_WAIT_MS {
        tokio::time::sleep(tokio::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
        elapsed_ms += POLL_INTERVAL_MS;

        if let Some(pref) = read_setting(window, "storage_preference") {
            if pref == "db_only" || pref == "local_folder" {
                eprintln!("[canvas::sync] Preferencia elegida: {}", pref);
                return Ok(pref);
            }
        }
    }

    Err("El usuario no eligió una preferencia de almacenamiento en 60 segundos. Sync abortado.".to_string())
}

async fn run_download_sync(
    client: &CanvasClient,
    window: &tauri::Window,
    course_id: Option<i64>,
    base_dir: &PathBuf,
) -> Result<(), String> {
    emit_event(window, &SyncEvent::Start {
        mode: "download".to_string(),
        incremental: false,
        since: None,
    });

    // 1. Fetch courses
    eprintln!("[canvas::sync] Obteniendo lista de cursos...");
    let all_courses = match fetch_courses_with_retry(client, window).await {
        Ok(c) => c,
        Err(e) => {
            emit_event(window, &SyncEvent::Error {
                fatal: true,
                message: e.clone(),
            });
            return Err(e);
        }
    };

    // Filtrar por course_id si se especificó
    let courses: Vec<CanvasCourse> = if let Some(cid) = course_id {
        all_courses.into_iter().filter(|c| c.id == cid).collect()
    } else {
        all_courses
    };

    if courses.is_empty() {
        let msg = "No se encontraron los cursos especificados.".to_string();
        emit_event(window, &SyncEvent::Error {
            fatal: true,
            message: msg.clone(),
        });
        return Err(msg);
    }

    let course_payloads: Vec<CoursePayload> = courses.iter().map(course_to_payload).collect();
    emit_event(window, &SyncEvent::Courses {
        data: course_payloads,
    });

    let total = courses.len();
    let mut stats = SyncStats {
        courses: total,
        assignments: 0,
        announcements: 0,
        files_auto: 0,
        files_skipped: 0,
        mb_downloaded: 0.0,
    };

    for (idx, course) in courses.iter().enumerate() {
        let cid = course.id;
        let cname = &course.name;
        let safe_course_name = sanitize_name(cname);

        emit_event(window, &SyncEvent::Progress {
            current: idx + 1,
            total,
            label: format!("Procesando {}...", cname),
        });
        eprintln!(
            "[canvas::sync] Procesando curso {}/{}: {} (id={})",
            idx + 1,
            total,
            cname,
            cid
        );

        // Assignments (download mode siempre completo — sin incremental)
        let assignments = fetch_with_retry(|| fetch_assignments(client, cid, None), client, window).await;
        let assignment_payloads: Vec<AssignmentPayload> = assignments
            .iter()
            .map(assignment_to_payload)
            .collect();
        stats.assignments += assignment_payloads.len();
        emit_event(window, &SyncEvent::Assignments {
            course_id: cid,
            data: assignment_payloads,
        });

        // Announcements (download mode siempre completo — sin incremental)
        let announcements =
            fetch_with_retry(|| fetch_announcements(client, cid, None), client, window).await;
        let announcement_payloads: Vec<AnnouncementPayload> = announcements
            .iter()
            .map(announcement_to_payload)
            .collect();
        stats.announcements += announcement_payloads.len();
        emit_event(window, &SyncEvent::Announcements {
            course_id: cid,
            data: announcement_payloads,
        });

        // Files metadata
        let (auto_files, manual_files) =
            fetch_files_with_retry(client, cid, window).await;

        // Emitir files_meta
        let all_files: Vec<FileMetaPayload> = auto_files
            .iter()
            .cloned()
            .chain(manual_files.iter().cloned())
            .collect();

        if !all_files.is_empty() {
            emit_event(window, &SyncEvent::FilesMeta {
                course_id: cid,
                data: all_files,
            });
        }

        // Emitir file_skipped para archivos manuales
        for f in &manual_files {
            let classification = classify_file(&f.name, &f.content_type, f.size_bytes);
            emit_event(window, &SyncEvent::FileSkipped {
                data: FileSkippedPayload {
                    file_id: f.id,
                    name: f.name.clone(),
                    size_bytes: f.size_bytes,
                    reason: classification
                        .reason_key
                        .unwrap_or_else(|| "manual".to_string()),
                    reason_human: classification
                        .reason
                        .unwrap_or_else(|| "No se descarga automáticamente".to_string()),
                },
            });
        }

        stats.files_skipped += manual_files.len();
        stats.files_auto += auto_files.len();

        // Descargar archivos tier=auto
        // Recolectar canvas_file_ids del sync actual para cleanup_orphans
        let current_canvas_file_ids: Vec<i64> = auto_files
            .iter()
            .chain(manual_files.iter())
            .map(|f| f.id)
            .collect();

        // ── Leer preferencia de almacenamiento ──────────────────────────
        // Si no está configurada y hay archivos para descargar, emitir evento
        // y esperar hasta 60s a que el usuario elija.
        let storage_pref = if auto_files.is_empty() {
            // Sin archivos para descargar — no necesitamos preferencia
            "db_only".to_string()
        } else {
            match read_setting(window, "storage_preference") {
                Some(p) if p == "db_only" || p == "local_folder" => p,
                _ => {
                    // No configurada — emitir evento y esperar
                    eprintln!(
                        "[canvas::sync] storage_preference no configurada, emitiendo evento con {} archivos",
                        auto_files.len()
                    );
                    if let Err(e) = window.emit("canvas-storage-preference-required", serde_json::json!({
                        "file_count": auto_files.len()
                    })) {
                        eprintln!("[canvas::sync] Error emitiendo canvas-storage-preference-required: {e}");
                    }

                    match wait_for_storage_preference(window).await {
                        Ok(pref) => pref,
                        Err(e) => {
                            emit_event(window, &SyncEvent::Error {
                                fatal: true,
                                message: e.clone(),
                            });
                            return Err(e);
                        }
                    }
                }
            }
        };

        // Determinar directorio base de descarga según preferencia
        let effective_base_dir = if storage_pref == "local_folder" {
            match read_setting(window, "download_path") {
                Some(p) if !p.is_empty() => PathBuf::from(p),
                _ => {
                    // Fallback: app_data_dir/downloads/
                    window.app_handle()
                        .path()
                        .app_data_dir()
                        .unwrap_or_else(|_| base_dir.clone())
                        .join("downloads")
                }
            }
        } else {
            base_dir.clone()
        };

        let effective_course_dir = effective_base_dir.join(&safe_course_name);

        for f in &auto_files {
            if f.url.is_empty() {
                eprintln!(
                    "[canvas::sync] Sin URL de descarga para archivo '{}'",
                    f.name
                );
                continue;
            }

            if storage_pref == "db_only" {
                // Modo db_only: solo registrar metadata, no descargar binario.
                // El indexer usa download_url directamente para extraer texto.
                eprintln!("[canvas::sync] db_only: omitiendo descarga binaria de '{}'", f.name);
                emit_event(window, &SyncEvent::DownloadDone {
                    data: DownloadDonePayload {
                        file_id: f.id,
                        local_path: String::new(), // file_path = NULL
                        cached: Some(false),
                    },
                });
                continue;
            }

            // Modo local_folder: descarga normal
            let safe_name = sanitize_name(&f.name);
            // Incluir canvas_file_id en el nombre para evitar colisiones entre
            // dos archivos distintos con el mismo nombre sanitizado en el mismo
            // curso. Ej: "lecture.pdf" (id=123) y "lecture.pdf" (id=456) deben
            // resolverse como "123_lecture.pdf" y "456_lecture.pdf".
            let prefixed_name = format!("{}_{}", f.id, safe_name);
            let dest_path = effective_course_dir.join(&prefixed_name);

            if dest_path.exists() {
                // Ya descargado — emitir done sin re-descargar
                emit_event(window, &SyncEvent::DownloadDone {
                    data: DownloadDonePayload {
                        file_id: f.id,
                        local_path: dest_path.display().to_string(),
                        cached: Some(true),
                    },
                });
                continue;
            }

            let mb = f.size_bytes as f64 / (1024.0 * 1024.0);
            stats.mb_downloaded += mb;

            download_file(client, f, &dest_path, window).await;
        }

        // Limpieza post-sync: duplicados y huérfanos
        // Errores no abortan el sync — solo warn!
        let app_handle = window.app_handle();
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| base_dir.clone());

        let db_path = app_data_dir.join("studyai.db");
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let dup_count = cleanup::cleanup_duplicates(&conn, cid, &app_data_dir)
                .unwrap_or_else(|e| {
                    log::warn!("[canvas::sync] Error cleanup duplicados (curso {}): {}", cid, e);
                    0
                });
            let orphan_count = cleanup::cleanup_orphans(
                &conn,
                cid,
                &current_canvas_file_ids,
                &app_data_dir,
            )
            .unwrap_or_else(|e| {
                log::warn!("[canvas::sync] Error cleanup huérfanos (curso {}): {}", cid, e);
                0
            });

            // Emitir evento de cleanup al frontend
            emit_event(window, &SyncEvent::CleanupDone {
                duplicates_removed: dup_count,
                orphans_removed: orphan_count,
            });
        } else {
            log::warn!("[canvas::sync] No se pudo abrir DB para cleanup (curso {})", cid);
        }
    }

    emit_event(window, &SyncEvent::Done { stats });
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Download de archivos
// ─────────────────────────────────────────────────────────────────────────────

async fn download_file(
    client: &CanvasClient,
    file: &FileMetaPayload,
    dest_path: &PathBuf,
    window: &tauri::Window,
) {
    emit_event(window, &SyncEvent::DownloadStarted {
        data: DownloadStartedPayload {
            file_id: file.id,
            name: file.name.clone(),
            size_bytes: file.size_bytes,
        },
    });

    // Crear directorio padre
    if let Some(parent) = dest_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "[canvas::sync] Error creando directorio {:?}: {}",
                parent, e
            );
            emit_event(window, &SyncEvent::DownloadError {
                data: DownloadErrorPayload {
                    file_id: file.id,
                    error: format!("Error al crear directorio: {e}"),
                },
            });
            return;
        }
    }

    // Archivo temporal para escritura atómica
    let tmp_path = dest_path.with_extension(
        dest_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{}.tmp", e))
            .unwrap_or_else(|| "tmp".to_string()),
    );

    // Realizar la descarga con streaming
    let result = async {
        use tokio::io::AsyncWriteExt;

        let response = client
            .get_raw_stream(&file.url)
            .await
            .map_err(|e| format!("Error iniciando descarga: {e}"))?;

        let mut file_handle = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("Error creando archivo temporal: {e}"))?;

        let mut stream = response;
        while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
            let bytes = chunk.map_err(|e| format!("Error en stream de descarga: {e}"))?;
            file_handle
                .write_all(&bytes)
                .await
                .map_err(|e| format!("Error escribiendo chunk: {e}"))?;
        }

        file_handle
            .flush()
            .await
            .map_err(|e| format!("Error flusheando archivo: {e}"))?;
        drop(file_handle);

        // Rename atómico
        tokio::fs::rename(&tmp_path, dest_path)
            .await
            .map_err(|e| format!("Error al mover archivo a destino: {e}"))?;

        Ok::<(), String>(())
    }
    .await;

    match result {
        Ok(()) => {
            emit_event(window, &SyncEvent::DownloadDone {
                data: DownloadDonePayload {
                    file_id: file.id,
                    local_path: dest_path.display().to_string(),
                    cached: None,
                },
            });
        }
        Err(e) => {
            // Limpiar archivo temporal si existe
            let _ = std::fs::remove_file(&tmp_path);
            eprintln!(
                "[canvas::sync] Error al descargar '{}': {}",
                file.name, e
            );
            emit_event(window, &SyncEvent::DownloadError {
                data: DownloadErrorPayload {
                    file_id: file.id,
                    error: e,
                },
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de retry para rate limiting
// ─────────────────────────────────────────────────────────────────────────────

/// Fetch de courses con manejo de errores fatales y backoff exponencial.
///
/// Reintenta hasta `max_retries` veces en caso de rate limit, con backoff
/// exponencial (1s, 2s, 4s, 8s, 16s) o honrando `Retry-After` del servidor.
async fn fetch_courses_with_retry(
    client: &CanvasClient,
    window: &tauri::Window,
) -> Result<Vec<CanvasCourse>, String> {
    let max_retries: u32 = 5;
    let mut attempt: u32 = 0;
    loop {
        match fetch_courses(client).await {
            Ok(courses) => return Ok(courses),
            Err(CanvasError::Unauthorized) | Err(CanvasError::Forbidden) => {
                emit_token_expired(window);
                return Err("Token inválido o expirado".to_string());
            }
            Err(CanvasError::RateLimited(secs)) => {
                attempt += 1;
                if attempt >= max_retries {
                    return Err(format!(
                        "Rate limit de Canvas persistente tras {} reintentos",
                        max_retries
                    ));
                }
                let backoff = 2u64.pow(attempt - 1);
                let wait_secs = secs.max(backoff);
                eprintln!(
                    "[canvas::sync] Rate limited (intento {}/{}). Esperando {}s...",
                    attempt, max_retries, wait_secs
                );
                emit_event(window, &SyncEvent::RateLimited { retry_after: wait_secs });
                sleep(Duration::from_secs(wait_secs)).await;
                // retry
            }
            Err(e) => {
                return Err(format!("Error obteniendo cursos: {e}"));
            }
        }
    }
}

/// Fetch genérico con manejo de rate limit y backoff exponencial.
/// Retorna Vec vacío en error no-fatal.
async fn fetch_with_retry<T, F, Fut>(
    mut f: F,
    _client: &CanvasClient,
    window: &tauri::Window,
) -> Vec<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<T>, CanvasError>>,
{
    let max_retries: u32 = 5;
    let mut attempt: u32 = 0;
    loop {
        match f().await {
            Ok(data) => return data,
            Err(CanvasError::Unauthorized) | Err(CanvasError::Forbidden) => {
                emit_token_expired(window);
                emit_event(window, &SyncEvent::Error {
                    fatal: true,
                    message: "Token inválido o expirado".to_string(),
                });
                return vec![];
            }
            Err(CanvasError::RateLimited(secs)) => {
                attempt += 1;
                if attempt >= max_retries {
                    let msg = format!(
                        "Rate limit de Canvas persistente tras {} reintentos",
                        max_retries
                    );
                    eprintln!("[canvas::sync] {}", msg);
                    emit_event(window, &SyncEvent::Error {
                        fatal: false,
                        message: msg,
                    });
                    return vec![];
                }
                let backoff = 2u64.pow(attempt - 1);
                let wait_secs = secs.max(backoff);
                eprintln!(
                    "[canvas::sync] Rate limited (intento {}/{}). Esperando {}s...",
                    attempt, max_retries, wait_secs
                );
                emit_event(window, &SyncEvent::RateLimited { retry_after: wait_secs });
                sleep(Duration::from_secs(wait_secs)).await;
                // retry
            }
            Err(e) => {
                eprintln!("[canvas::sync] Error (no fatal): {e}");
                return vec![];
            }
        }
    }
}

/// Fetch de archivos con manejo de rate limit y backoff exponencial
async fn fetch_files_with_retry(
    client: &CanvasClient,
    course_id: i64,
    window: &tauri::Window,
) -> (Vec<FileMetaPayload>, Vec<FileMetaPayload>) {
    let max_retries: u32 = 5;
    let mut attempt: u32 = 0;
    loop {
        match fetch_files_meta(client, course_id, window).await {
            Ok(result) => return result,
            Err(CanvasError::Unauthorized) | Err(CanvasError::Forbidden) => {
                emit_token_expired(window);
                emit_event(window, &SyncEvent::Error {
                    fatal: true,
                    message: "Token inválido o expirado".to_string(),
                });
                return (vec![], vec![]);
            }
            Err(CanvasError::RateLimited(secs)) => {
                attempt += 1;
                if attempt >= max_retries {
                    let msg = format!(
                        "Rate limit persistente al obtener archivos del curso {} tras {} reintentos",
                        course_id, max_retries
                    );
                    eprintln!("[canvas::sync] {}", msg);
                    emit_event(window, &SyncEvent::Error {
                        fatal: false,
                        message: msg,
                    });
                    return (vec![], vec![]);
                }
                // Honrar Retry-After del servidor, con un mínimo por backoff
                // exponencial (1s, 2s, 4s, 8s, 16s) por si Canvas devuelve 0.
                let backoff = 2u64.pow(attempt - 1);
                let wait_secs = secs.max(backoff);
                eprintln!(
                    "[canvas::sync] Rate limited (intento {}/{}). Esperando {}s...",
                    attempt, max_retries, wait_secs
                );
                emit_event(window, &SyncEvent::RateLimited { retry_after: wait_secs });
                sleep(Duration::from_secs(wait_secs)).await;
                // retry
            }
            Err(e) => {
                eprintln!("[canvas::sync] Error obteniendo archivos (curso {}): {e}", course_id);
                return (vec![], vec![]);
            }
        }
    }
}
