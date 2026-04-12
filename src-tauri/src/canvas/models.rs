// canvas/models.rs — Structs para deserializar respuestas de la API de Canvas LMS

/// Campos deserializados desde la API de Canvas LMS. Algunos no son leídos
/// por el código Rust pero deben existir en la struct para preservar la shape del JSON.
#[allow(dead_code)]
#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasTerm {
    pub id: i64,
    pub name: String,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasCourse {
    pub id: i64,
    pub name: String,
    pub course_code: Option<String>,
    pub term: Option<CanvasTerm>,
}

/// Campos deserializados desde la API de Canvas LMS. Algunos no son leídos
/// por el código Rust pero deben existir en la struct para preservar la shape del JSON.
#[allow(dead_code)]
#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasAssignment {
    pub id: i64,
    pub name: String,
    pub due_at: Option<String>,
    pub points_possible: Option<f64>,
    #[serde(default)]
    pub submission_types: Vec<String>,
    pub html_url: Option<String>,
    pub submission: Option<CanvasSubmission>,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasSubmission {
    pub workflow_state: Option<String>,
    pub score: Option<f64>,
    pub grade: Option<String>,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasAnnouncement {
    pub id: i64,
    pub title: String,
    pub message: Option<String>,
    pub posted_at: Option<String>,
    pub created_at: Option<String>,
    pub html_url: Option<String>,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasModule {
    pub id: i64,
    pub name: String,
    pub items: Option<Vec<CanvasModuleItem>>,
}

/// Campos deserializados desde la API de Canvas LMS. Algunos no son leídos
/// por el código Rust pero deben existir en la struct para preservar la shape del JSON.
#[allow(dead_code)]
#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasModuleItem {
    pub id: i64,
    pub title: String,
    /// Renombrado desde el campo JSON "type"
    #[serde(rename = "type")]
    pub item_type: String,
    pub url: Option<String>,
    pub content_id: Option<i64>,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct CanvasFile {
    pub id: i64,
    pub display_name: Option<String>,
    pub filename: Option<String>,
    pub size: Option<u64>,
    #[serde(rename = "content-type")]
    pub content_type: Option<String>,
    pub url: Option<String>,
}
