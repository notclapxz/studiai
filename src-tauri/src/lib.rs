// lib.rs — Punto de entrada de la lógica Tauri para StudyAI
// Inicializa plugins, base de datos y comandos disponibles desde el frontend

mod canvas;
mod db;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

// ─── CWD tracking per session para bash tool ───────────────────────────────
// Persiste el directorio de trabajo entre invocaciones de run_bash, keyeado
// por sesión (label de la ventana Tauri) para que sesiones concurrentes de
// chat no compitan por el mismo `cd`. Cada comando termina con `pwd -P` y el
// resultado se guarda en el entry de la sesión actual.
static CURRENT_CWD: std::sync::LazyLock<Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use sha2::{Sha256, Digest};

// Re-export pdf_extract para que el compilador encuentre el crate (pdf-extract → pdf_extract)
extern crate pdf_extract;

// ── API Key de Gemini embebida en build time ──────────────────────────────────
// env!() es una macro de Rust: lee la variable en COMPILE TIME y la embebe
// en el binario. Si no existe al compilar → error de build inmediato.
// Nunca aparece en texto plano en el código fuente ni en el bundle JS.
const GEMINI_API_KEY: &str = env!("GEMINI_API_KEY");

// ─── Prompts modulares (cargados en compile-time) ────────────────────────────
// Secciones ordenadas 01..07 — se concatenan en ese orden en build_system_prompt()
const PROMPT_BASE: &str = include_str!("prompts/sections/01-base.txt");
const PROMPT_COMPORTAMIENTO: &str = include_str!("prompts/sections/02-comportamiento.txt");
const PROMPT_CAPACIDADES: &str = include_str!("prompts/sections/03-capacidades.txt");
const PROMPT_HERRAMIENTAS: &str = include_str!("prompts/sections/04-herramientas.txt");
const PROMPT_FORMATO: &str = include_str!("prompts/sections/05-formato.txt");
const PROMPT_ESTILO: &str = include_str!("prompts/sections/06-estilo.txt");
// Reglas pedagógicas: tareas (completar + ofrecer), comprensión (cambiar enfoque), modo examen
// Spec: sdd/prompts-coach — topic_key sdd/prompts-coach/spec
const PROMPT_COACHING: &str = include_str!("prompts/sections/07-coaching.txt");

// Few-shot examples (se concatenan al final del system prompt)
const EXAMPLE_PDF_GENERATION: &str = include_str!("prompts/examples/pdf-generation.txt");
const EXAMPLE_TOOL_USE: &str = include_str!("prompts/examples/tool-use.txt");
const EXAMPLE_FORMAT_HIERARCHY: &str = include_str!("prompts/examples/format-hierarchy.txt");

// ─── Runtime context y detección de intent ──────────────────────────────────
// Se computa una vez por request en send_chat_message() y se pasa tanto al
// builder del system prompt (para inyectar la fecha/OS/curso activo) como al
// builder del toolConfig de Gemini (para promover `mode: "ANY"` cuando el
// mensaje del usuario implica obviamente un tool específico).

/// Intents detectados por keyword matching en el mensaje del usuario.
/// Orden de evaluación: WebSearch → ExamPrep → TaskHelp → Motivation → ConceptLearn → Conversational
/// Spec: sdd/prompts-coach/spec — Domain 3
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MessageIntent {
    /// Fallback — sin keywords reconocidos
    Conversational,
    /// Búsqueda web: "busca en internet", "googlea", etc.
    WebSearch,
    /// Tarea académica: "hazme", "resolvé", "completá", etc.
    TaskHelp,
    /// Preparación para examen: "modo examen", "quiz", etc.
    ExamPrep,
    /// Aprendizaje de conceptos: "explicame", "qué es", etc.
    ConceptLearn,
    /// Motivación / bloqueo emocional: "no puedo", "me rindo", etc.
    Motivation,
}

#[derive(Debug, Clone)]
struct RuntimeContext {
    os: String,
    datetime_peru: String,
    home_dir: String,
    downloads_dir: String,
    #[allow(dead_code)]
    active_course_id: Option<i64>,
    #[allow(dead_code)]
    active_course_name: Option<String>,
    course_context: Option<String>,
    user_message_intent: MessageIntent,
}

/// Detecta el intent del mensaje del usuario por keyword matching en español.
///
/// Orden de evaluación (spec sdd/prompts-coach/spec — Domain 3):
///   WebSearch → ExamPrep → TaskHelp → Motivation → ConceptLearn → Conversational
///
/// La normalización a lowercase ocurre primero para que variantes como
/// "MODO EXAMEN" o "Hazme" sean reconocidas correctamente.
///
/// El resultado se usa para dos fines:
///   1. `build_tool_config()` — promover mode="ANY" para WebSearch
///   2. `build_system_prompt()` — inyectar mini-prompt pedagógico por intent
fn detect_intent(user_message: &str) -> MessageIntent {
    let msg = user_message.to_lowercase();

    // 1. WebSearch — búsqueda explícita en internet
    const WEB_KEYWORDS: &[&str] = &[
        "busca en internet", "busca en la web", "search online",
        "googlea", "investiga en internet", "busca", "buscar",
        "noticias", "última información", "search",
    ];
    if WEB_KEYWORDS.iter().any(|kw| msg.contains(kw)) {
        return MessageIntent::WebSearch;
    }

    // 2. ExamPrep — modo examen o preparación para prueba
    const EXAM_KEYWORDS: &[&str] = &[
        "modo examen", "examen mode", "prepárame para el examen",
        "prepárame para examen", "quiero repasar", "tengo examen",
        "practicar para", "preparar examen", "quiz", "pruébame",
        "parcial", "repaso de",
    ];
    if EXAM_KEYWORDS.iter().any(|kw| msg.contains(kw)) {
        return MessageIntent::ExamPrep;
    }

    // 3. TaskHelp — el estudiante pide que se complete una tarea
    const TASK_KEYWORDS: &[&str] = &[
        "hazme", "haceme", "hacé", "haz ", "haz\t",
        "escríbeme", "escribime", "resolvé", "resuelve", "resolver",
        "completá", "completa", "dame ", "dame\t",
        "necesito que", "necesito que hagas", "ayúdame con",
        "tengo que entregar", "no entiendo el enunciado",
    ];
    if TASK_KEYWORDS.iter().any(|kw| msg.contains(kw)) {
        return MessageIntent::TaskHelp;
    }

    // 4. Motivation — bloqueo emocional o frustración
    const MOTIVATION_KEYWORDS: &[&str] = &[
        "motivación", "motivacion", "no puedo", "me rindo",
        "estoy agotado", "ayúdame a motivarme", "no entiendo nada",
        "me voy a jalar", "estoy perdido", "estoy mal",
    ];
    if MOTIVATION_KEYWORDS.iter().any(|kw| msg.contains(kw)) {
        return MessageIntent::Motivation;
    }

    // 5. ConceptLearn — quiere entender o aprender un concepto
    const CONCEPT_KEYWORDS: &[&str] = &[
        "explícame", "explicame", "explicá", "explica",
        "qué es", "que es", "cómo funciona", "como funciona",
        "define", "qué significa", "que significa",
        "entender", "aprendo",
    ];
    if CONCEPT_KEYWORDS.iter().any(|kw| msg.contains(kw)) {
        return MessageIntent::ConceptLearn;
    }

    // 6. Conversational — fallback
    MessageIntent::Conversational
}

/// Ensambla el system prompt final a partir de las 7 secciones + ejemplos
/// few-shot + contexto runtime (fecha, OS, curso activo) + mini-prompt por intent.
///
/// El intent ya viene resuelto en `ctx.user_message_intent` (calculado en
/// `send_chat_message()` antes de construir el prompt). Inyectamos un bloque
/// breve (max 3 líneas) según el tipo de consulta detectado. No se agrega
/// bloque extra para `Conversational` para evitar overhead innecesario.
/// Spec: sdd/prompts-coach/spec — Domain 4
fn build_system_prompt(ctx: &RuntimeContext) -> String {
    let mut out = String::with_capacity(16 * 1024);

    // 1. Secciones principales en orden (01–07)
    out.push_str(PROMPT_BASE);
    out.push_str("\n\n");
    out.push_str(PROMPT_COMPORTAMIENTO);
    out.push_str("\n\n");
    out.push_str(PROMPT_CAPACIDADES);
    out.push_str("\n\n");
    out.push_str(PROMPT_HERRAMIENTAS);
    out.push_str("\n\n");
    out.push_str(PROMPT_FORMATO);
    out.push_str("\n\n");
    out.push_str(PROMPT_ESTILO);
    out.push_str("\n\n");
    out.push_str(PROMPT_COACHING);

    // 2. Few-shot examples
    out.push_str("\n\n---\n\n# EJEMPLOS FEW-SHOT\n\n");
    out.push_str(EXAMPLE_PDF_GENERATION);
    out.push_str("\n\n---\n\n");
    out.push_str(EXAMPLE_TOOL_USE);
    out.push_str("\n\n---\n\n");
    out.push_str(EXAMPLE_FORMAT_HIERARCHY);

    // 3. Runtime context
    out.push_str("\n\n---\n\n# CONTEXTO DE ESTA SESIÓN\n\n");
    out.push_str(&format!("SISTEMA: OS={}. Fecha={}.\n", ctx.os, ctx.datetime_peru));
    out.push_str(&format!("HOME: {}\n", ctx.home_dir));
    out.push_str(&format!(
        "DOWNLOADS: {} (usá ESTE path absoluto para guardar PDFs y archivos descargables. NO preguntes el nombre de usuario — usá este path tal como está)\n",
        ctx.downloads_dir
    ));
    out.push_str("Las fechas de entrega en la DB están en UTC — convierte a UTC-5 (hora Perú) antes de mostrarlas al estudiante.\n");
    out.push_str("DATOS DEL ESTUDIANTE: NUNCA inventes datos. Usa las herramientas para consultar tareas, anuncios, materiales.\n");

    if let Some(course_ctx) = &ctx.course_context {
        out.push_str("\n## Curso activo\n\n");
        out.push_str(course_ctx);
    }

    // 4. Mini-prompt pedagógico según intent detectado en este turno
    // Conversational no agrega bloque extra — sin overhead innecesario
    let mini_prompt = match ctx.user_message_intent {
        MessageIntent::WebSearch => Some(
            "El usuario quiere que busques información. Proporciona datos actuales y cita fuentes si es posible."
        ),
        MessageIntent::ExamPrep => Some(
            "Estás en modo examen. Solo hacé preguntas. No des respuestas directas. Evaluá cada respuesta del estudiante brevemente antes de continuar."
        ),
        MessageIntent::TaskHelp => Some(
            "El estudiante necesita ayuda con una tarea. Completá la tarea sin negarte. Al terminar, ofrecé una vez enseñar cómo lo hiciste."
        ),
        MessageIntent::Motivation => Some(
            "El estudiante está frustrado. Validá brevemente (sin dramatizar) y redirigí hacia una acción concreta."
        ),
        MessageIntent::ConceptLearn => Some(
            "El estudiante quiere aprender un concepto. Explicá con claridad y, si no entiende, cambiá el enfoque completamente."
        ),
        MessageIntent::Conversational => None,
    };

    if let Some(block) = mini_prompt {
        out.push_str("\n\n---\n\n# CONTEXTO DE ESTA CONSULTA\n\n");
        out.push_str(block);
        out.push('\n');
    }

    out
}

// ─── Gemini toolConfig (forced function calling) ────────────────────────────
// Mapea la shape REST de Gemini: `toolConfig.functionCallingConfig.mode`.
// Ver: https://ai.google.dev/gemini-api/docs/function-calling#function_calling_mode
//
// mode:
//   "AUTO" — modelo decide (default, omitimos el campo entonces)
//   "ANY"  — OBLIGA al modelo a llamar alguna función (la lista la podemos restringir)
//   "NONE" — prohíbe tools
//
// Usamos "ANY" + allowed_function_names para turnos donde el user message
// implica un tool específico (fix del bug de narración de HTML en generate_pdf).

#[derive(Debug, Clone, serde::Serialize)]
struct ToolConfig {
    #[serde(rename = "functionCallingConfig")]
    function_calling_config: FunctionCallingConfig,
}

#[derive(Debug, Clone, serde::Serialize)]
struct FunctionCallingConfig {
    mode: String,
    #[serde(
        rename = "allowedFunctionNames",
        skip_serializing_if = "Option::is_none"
    )]
    allowed_function_names: Option<Vec<String>>,
}

/// Construye el `toolConfig` para Gemini según el intent detectado.
/// Retorna `None` cuando el modo es AUTO (el campo se omite entonces del body
/// del request, preservando la semántica default de Gemini).
/// Solo WebSearch promueve ANY mode — el resto usa AUTO para máxima flexibilidad.
fn build_tool_config(intent: MessageIntent) -> Option<ToolConfig> {
    match intent {
        MessageIntent::WebSearch => Some(ToolConfig {
            function_calling_config: FunctionCallingConfig {
                mode: "ANY".to_string(),
                allowed_function_names: Some(vec!["web_search".to_string()]),
            },
        }),
        // Todos los demás intents usan AUTO mode (None = campo omitido en request)
        MessageIntent::Conversational
        | MessageIntent::TaskHelp
        | MessageIntent::ExamPrep
        | MessageIntent::ConceptLearn
        | MessageIntent::Motivation => None,
    }
}

/// Handle de la tarea de sync activa.
/// Evita que se lancen múltiples sincronizaciones en paralelo.
struct SyncState {
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Estado compartido para el loop de indexado background.
/// cancel: señal para detener el loop completamente.
/// paused: señal para pausar/reanudar sin detener.
pub struct IndexState {
    pub handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub cancel: std::sync::Arc<AtomicBool>,
    pub paused: std::sync::Arc<AtomicBool>,
}

impl Default for IndexState {
    fn default() -> Self {
        Self {
            handle: std::sync::Mutex::new(None),
            cancel: std::sync::Arc::new(AtomicBool::new(false)),
            paused: std::sync::Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, serde::Serialize, Default)]
pub struct IndexStats {
    pub total: u32,
    pub done: u32,
    pub failed: u32,
    pub running: bool,
    pub session_bytes: u64,
}

// ─── Tipos para el chat ───────────────────────────────────────────────────────

/// Un mensaje del historial de chat.
/// `role` puede ser "user" o "assistant" desde el frontend.
/// En Gemini el rol "assistant" se convierte a "model" antes de enviar.
#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct ChatMessage {
    pub role: String,    // "user" | "assistant" (frontend) → "user" | "model" (Gemini)
    pub content: String,
}

/// Datos de una imagen adjunta enviada desde el frontend.
/// Se incluye como `inlineData` en la request a Gemini.
#[derive(serde::Deserialize, Debug, Clone)]
pub struct ImageData {
    pub base64: String,
    #[serde(rename = "mediaType")]
    pub media_type: String,
}

// ─── Comandos Tauri ───────────────────────────────────────────────────────────

/// Redimensiona y comprime una imagen base64 antes de enviarla a Gemini.
/// - Max 1024px en cualquier dimensión (sweet spot para tokens Gemini)
/// - Max 2MB de tamaño
/// - Convierte a JPEG al redimensionar (mejor compresión)
/// - Si no necesita resize, retorna los datos originales sin modificar
#[tauri::command]
fn resize_image_base64(base64_data: String, media_type: String) -> Result<serde_json::Value, String> {
    use base64::Engine;
    use image::GenericImageView;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Invalid image: {}", e))?;

    let (width, height) = img.dimensions();

    const MAX_DIMENSION: u32 = 1024;
    const MAX_BYTES: usize = 2 * 1024 * 1024; // 2MB

    let needs_resize = width > MAX_DIMENSION || height > MAX_DIMENSION || bytes.len() > MAX_BYTES;

    if !needs_resize {
        return Ok(serde_json::json!({
            "base64": base64_data,
            "mediaType": media_type,
            "width": width,
            "height": height,
            "resized": false
        }));
    }

    // Resize manteniendo aspect ratio
    let resized = img.resize(MAX_DIMENSION, MAX_DIMENSION, image::imageops::FilterType::Lanczos3);
    let (new_w, new_h) = resized.dimensions();

    // Codificar como JPEG (mejor compresión)
    let mut output = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut output);
    resized.write_to(&mut cursor, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Error encoding: {}", e))?;

    let new_base64 = base64::engine::general_purpose::STANDARD.encode(&output);

    eprintln!("[image] Resized {}x{} ({} bytes) → {}x{} ({} bytes)",
        width, height, bytes.len(), new_w, new_h, output.len());

    Ok(serde_json::json!({
        "base64": new_base64,
        "mediaType": "image/jpeg",
        "width": new_w,
        "height": new_h,
        "originalWidth": width,
        "originalHeight": height,
        "resized": true
    }))
}

/// Genera un fingerprint unico del dispositivo basado en el UUID de la maquina.
/// En macOS: lee IOPlatformUUID via ioreg
/// En Windows: lee UUID via wmic
/// Retorna un hash SHA-256 del identificador.
#[tauri::command]
fn get_device_fingerprint() -> Result<String, String> {
    let raw_id = get_machine_id()?;
    let mut hasher = Sha256::new();
    hasher.update(raw_id.trim().as_bytes());
    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

/// Consulta el estado del modo confianza desde la base de datos.
/// Retorna true si trust_mode está activado (o si no existe el setting, default ON).
#[tauri::command]
async fn get_trust_mode(app: tauri::AppHandle) -> Result<bool, String> {
    let conn = open_db(&app).map_err(|e| e.to_string())?;
    let result: Result<String, _> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'trust_mode'",
        [],
        |row| row.get(0),
    );
    Ok(result.map(|v| v == "true").unwrap_or(true))
}

#[cfg(target_os = "macos")]
fn get_machine_id() -> Result<String, String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| format!("Error ejecutando ioreg: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            // Formato: "IOPlatformUUID" = "XXXXXXXX-XXXX-..."
            if let Some(uuid) = line.split('"').nth(3) {
                return Ok(uuid.to_string());
            }
        }
    }
    Err("No se encontro IOPlatformUUID".to_string())
}

#[cfg(target_os = "windows")]
fn get_machine_id() -> Result<String, String> {
    let output = std::process::Command::new("wmic")
        .args(["csproduct", "get", "uuid"])
        .output()
        .map_err(|e| format!("Error ejecutando wmic: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // La salida tiene un header "UUID" y luego el valor en la siguiente linea
    for line in stdout.lines().skip(1) {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Err("No se encontro UUID del dispositivo".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn get_machine_id() -> Result<String, String> {
    // Linux fallback: leer /etc/machine-id
    std::fs::read_to_string("/etc/machine-id")
        .map_err(|e| format!("Error leyendo /etc/machine-id: {e}"))
}

/// Construye las declaraciones de las 3 tools disponibles para Gemini.
fn build_tools() -> serde_json::Value {
    serde_json::json!([{
        "functionDeclarations": [
            {
                "name": "get_upcoming_deadlines",
                "description": "Obtiene las tareas y entregas próximas del estudiante con fechas límite. Úsala cuando el estudiante pregunta por sus tareas, fechas de entrega, exámenes próximos o deadlines.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "days_ahead": {
                            "type": "integer",
                            "description": "Cuántos días a futuro buscar (default 7, máximo 90)"
                        }
                    },
                    "required": []
                }
            },
            {
                "name": "get_announcements",
                "description": "Obtiene los anuncios recientes de los cursos del estudiante. Úsala cuando pregunta por novedades, avisos o comunicados de sus profesores.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "Número de anuncios a recuperar (default 10, máximo 50)"
                        }
                    },
                    "required": []
                }
            },
            {
                "name": "create_flashcards",
                "description": "Genera flashcards de estudio sobre un tema. Úsala cuando el estudiante pide crear flashcards, tarjetas de repaso o material de estudio.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "Tema sobre el que generar las flashcards"
                        },
                        "count": {
                            "type": "integer",
                            "description": "Número de flashcards a generar (default 10)"
                        }
                    },
                    "required": ["topic"]
                }
            },
            {
                "name": "search_notes",
                "description": "Busca en el contenido de los PDFs y materiales del estudiante indexados. Por defecto filtra al curso activo del chat para evitar cruzar contenido entre cursos. Usar cuando el estudiante pregunta sobre contenido específico de sus materiales.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Términos de búsqueda en los materiales"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Número máximo de fragmentos a retornar (default 5)"
                        },
                        "course_id": {
                            "type": "integer",
                            "description": "Opcional. ID numérico de un curso específico. Por defecto se usa el curso activo del chat. Sólo pásalo si el estudiante pide explícitamente buscar en otro curso o en todos los cursos (en cuyo caso déjalo omitido y el backend hará el filtrado)."
                        }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "list_documents",
                "description": "Lista los documentos (PDFs) indexados del estudiante. SIEMPRE usa esto ANTES de read_document. Filtra por curso activo y por semana/nombre.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "filter": {
                            "type": "string",
                            "description": "Filtro por nombre de archivo (ej: 'S1' para semana 1, 'Sesion' para sesiones, 'Lectura')"
                        },
                        "course": {
                            "type": "string",
                            "description": "Filtro por nombre del curso (ej: 'matematica', 'fisica'). Usa el curso activo del contexto."
                        }
                    }
                }
            },
            {
                "name": "read_document",
                "description": "Lee el contenido de un documento indexado. Usa el id del documento (obtenido de list_documents) o un query por nombre. Lee el primer match sin preguntar.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Nombre o parte del nombre del documento"
                        },
                        "id": {
                            "type": "number",
                            "description": "ID del documento (de list_documents). Preferido sobre query."
                        }
                    }
                }
            },
            {
                "name": "run_bash",
                "description": "Ejecuta un comando bash en la terminal del usuario. Usa esto para: instalar paquetes, ejecutar scripts, compilar código, manipular archivos via terminal, etc. Siempre muestra al usuario qué comando vas a ejecutar.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "El comando bash a ejecutar"
                        }
                    },
                    "required": ["command"]
                }
            },
            {
                "name": "get_cwd",
                "description": "Obtiene el directorio de trabajo actual del bash. Úsala para saber en qué directorio se ejecutarán los próximos comandos.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            },
            {
                "name": "create_file",
                "description": "Crea un nuevo archivo o sobrescribe uno existente. Usa esto para crear scripts, documentos, código, etc. El archivo se guarda en la ruta especificada.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Ruta completa del archivo a crear (ej: ~/Desktop/script.py, ~/Downloads/reporte.html)"
                        },
                        "content": {
                            "type": "string",
                            "description": "Contenido del archivo"
                        }
                    },
                    "required": ["path", "content"]
                }
            },
            {
                "name": "read_file",
                "description": "Lee el contenido de un archivo del sistema. Usa esto para leer scripts, documentos, código, etc.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Ruta completa del archivo a leer"
                        }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "list_directory",
                "description": "Lista los archivos y carpetas en un directorio.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Ruta del directorio a listar (ej: ~/Desktop, ~/Documents)"
                        }
                    },
                    "required": ["path"]
                }
            },
            // REMOVED 2026-04-10 (pdf-flow-fix): se eliminó `generate_pdf` del
            // schema de tools. En su lugar, el agente usa el flow Unix:
            // create_file + run_bash weasyprint + run_bash open.
            // Razón: forzar mode=ANY sobre generate_pdf causaba que Gemini
            // llamara el tool ANTES de hacer research, generando PDFs con
            // datos inventados. El flow Unix permite research natural con
            // AUTO mode, y es más componible (cualquier converter, no solo
            // weasyprint hardcoded).
            //
            // La función `tool_generate_pdf` y el dispatch case siguen
            // presentes por rollback safety: si Gemini llama `generate_pdf`
            // desde historia de chat vieja, todavía funciona.
            //
            // {
            //     "name": "generate_pdf",
            //     "description": "Genera un archivo PDF a partir de contenido HTML con CSS. Ideal para crear reportes, resumenes, presentaciones, documentos formales, etc. El PDF se guarda en la carpeta de Descargas del usuario.",
            //     "parameters": {
            //         "type": "object",
            //         "properties": {
            //             "filename": {
            //                 "type": "string",
            //                 "description": "Nombre del archivo PDF (sin extension, ej: 'reporte-matematicas')"
            //             },
            //             "html_content": {
            //                 "type": "string",
            //                 "description": "Contenido HTML completo con estilos CSS inline o en <style> tag. Debe ser un documento HTML valido con <html>, <head>, <body>."
            //             }
            //         },
            //         "required": ["filename", "html_content"]
            //     }
            // },
            {
                "name": "web_search",
                "description": "Busca informacion en internet. Usa esto cuando necesites informacion actualizada, datos que no conoces, o cuando el usuario pida buscar algo online.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "La consulta de busqueda"
                        }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "web_fetch",
                "description": "Lee el contenido de una pagina web. Usa esto para obtener informacion detallada de una URL especifica.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "La URL de la pagina web a leer"
                        }
                    },
                    "required": ["url"]
                }
            },
            {
                "name": "get_study_history",
                "description": "Obtiene el historial de sesiones de estudio anteriores del estudiante. Usa esto para recordar que temas ha estudiado antes, que dificultades tuvo, y que deberia repasar.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "number",
                            "description": "Numero de sesiones recientes a obtener (default: 5)"
                        }
                    }
                }
            }
        ]
    }])
}

// ─── Ejecución de tools ───────────────────────────────────────────────────────

/// Abre la base de datos SQLite de la app.
/// Parsea ISO8601 "2026-04-09T04:59:59" o "2026-04-09 04:59:59" → segundos Unix
fn chrono_parse_iso(s: &str) -> Result<i64, ()> {
    let s = s.replace('T', " ");
    let parts: Vec<&str> = s.split(' ').collect();
    if parts.len() < 2 { return Err(()); }
    let date_parts: Vec<i64> = parts[0].split('-').filter_map(|p| p.parse().ok()).collect();
    let time_parts: Vec<i64> = parts[1].split(':').filter_map(|p| p.parse().ok()).collect();
    if date_parts.len() < 3 || time_parts.len() < 2 { return Err(()); }
    let (y, m, d) = (date_parts[0], date_parts[1], date_parts[2]);
    let (h, min, sec) = (time_parts[0], time_parts[1], time_parts.get(2).copied().unwrap_or(0));
    // Calcular días desde epoch
    let m_adj = if m <= 2 { m + 9 } else { m - 3 };
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let doy = (153 * m_adj + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe/4 - yoe/100 + doy;
    let days = era * 146097 + doe - 719468;
    Ok(days * 86400 + h * 3600 + min * 60 + sec)
}

/// Formatea segundos Unix → "jue 10/04/2026 23:59 (hora Perú)"
fn format_peru_datetime(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let time_secs = secs.rem_euclid(86400);
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let (y, mo, d) = epoch_days_to_date(days);
    let days_es = ["dom","lun","mar","mié","jue","vie","sáb"];
    let wd = ((days + 4).rem_euclid(7)) as usize;
    format!("{} {:02}/{:02}/{} {:02}:{:02} hora Perú", days_es[wd], d, mo, y, h, m)
}

/// Convierte días desde epoch Unix (1970-01-01) a (año, mes, día)
fn epoch_days_to_date(days: i64) -> (i64, i64, i64) {
    // Algoritmo de Richards
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2) / 153;
    let d = doy - (153*mp + 2)/5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn open_db(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No se pudo resolver el directorio de datos: {e}"))?
        .join("studyai.db");

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("No se pudo abrir la base de datos en {}: {e}", db_path.display()))?;

    // Enforce declared foreign key constraints and switch to WAL journaling.
    // These PRAGMAs are per-connection in SQLite and MUST run on every open.
    // `query` is used (not `execute_batch`) because `PRAGMA journal_mode = WAL`
    // returns a result row and errors if executed via the batch API in some
    // rusqlite versions. We ignore the returned row on purpose.
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("No se pudo habilitar foreign_keys: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("No se pudo habilitar WAL: {e}"))?;

    Ok(conn)
}

// ─── Inicialización de FTS5 ───────────────────────────────────────────────────

/// Crea las tablas FTS5 y los triggers de sincronización si no existen.
/// Se llama al iniciar la app, después de que las migraciones del plugin SQL ya corrieron.
fn setup_fts5(app: &tauri::AppHandle) {
    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[fts5] No se pudo abrir DB para FTS5: {e}");
            return;
        }
    };

    // FTS5 virtual table — no soportada por tauri-plugin-sql (solo DDL estándar)
    let _ = conn.execute_batch("
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content,
            content=document_chunks,
            content_rowid=id,
            tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON document_chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
        END;
    ");
}

// ─── Extracción de texto de PDFs ──────────────────────────────────────────────

/// Extrae el texto de un PDF dado su path en disco.
/// Filtra caracteres de control excepto newlines y tabs.
fn extract_text_from_pdf(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    match pdf_extract::extract_text_from_mem(&bytes) {
        Ok(text) => {
            // Limpiar caracteres de control excepto newlines y tabs
            let clean: String = text.chars()
                .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                .collect();
            Ok(clean)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Codifica bytes en base64 usando el engine estándar.
fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Envía un PDF a Gemini Vision API y retorna el texto extraído por OCR.
/// Se usa como fallback cuando `pdf-extract` no puede obtener texto (PDFs escaneados).
async fn ocr_pdf_with_gemini(pdf_path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(pdf_path).map_err(|e| e.to_string())?;
    let base64_pdf = base64_encode(&bytes);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "contents": [{
            "parts": [
                {
                    "inline_data": {
                        "mime_type": "application/pdf",
                        "data": base64_pdf
                    }
                },
                {
                    "text": "Extrae todo el texto de este documento PDF. Mantén la estructura con párrafos y saltos de línea. Solo retorna el texto extraído, sin comentarios adicionales."
                }
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192
        }
    });

    let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    let response = client
        .post(url)
        .header("x-goog-api-key", GEMINI_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Error al llamar Gemini Vision: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let err = response.text().await.unwrap_or_default();
        return Err(format!("Gemini Vision error {status}: {err}"));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

    let text = json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    if text.trim().is_empty() {
        return Err("Gemini Vision no pudo extraer texto".to_string());
    }

    Ok(text)
}

/// Divide texto en chunks con solapamiento.
/// chunk_size: tamaño máximo en caracteres
/// overlap: solapamiento entre chunks consecutivos
fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let mut start = 0;

    while start < total {
        let end = (start + chunk_size).min(total);
        let chunk: String = chars[start..end].iter().collect();
        let chunk = chunk.trim().to_string();

        // Descartar chunks muy cortos (solo headers o números de página)
        // y chunks vacíos / solo whitespace (por si `trim()` dejó una cadena vacía).
        if !chunk.trim().is_empty() && chunk.len() >= 200 {
            chunks.push(chunk);
        }

        if end >= total {
            break;
        }
        start += chunk_size - overlap;
    }
    chunks
}

// ─── Helpers de indexado background ──────────────────────────────────────────

/// Recupera jobs que quedaron en estado 'running' tras un crash anterior.
fn recover_crashed_jobs(app: &tauri::AppHandle) {
    if let Ok(conn) = open_db(app) {
        // Marcar running → failed (crash recovery)
        let _ = conn.execute(
            "UPDATE index_jobs SET status='failed', error_message='Crash recovery', updated_at=datetime('now') WHERE status='running'",
            []
        );
        // Limpiar jobs de semestres anteriores (pending/failed de ciclos viejos)
        let _ = conn.execute(
            "DELETE FROM index_jobs WHERE document_id IN (
                SELECT d.id FROM documents d
                JOIN courses c ON c.id = d.course_id
                WHERE c.semester NOT IN (
                    SELECT MAX(semester) FROM courses
                    WHERE semester LIKE '%20__-0%' OR semester LIKE '%20__-1%'
                )
            ) AND status IN ('pending', 'failed')",
            []
        );
    }
}

/// Encola documentos elegibles que aún no tienen embeddings.
/// Prioriza documentos del curso activo (prioridad 10) sobre el resto (prioridad 100).
fn queue_pending_documents(app: &tauri::AppHandle, active_course_id: Option<i64>) -> u32 {
    let Ok(conn) = open_db(app) else { return 0 };

    // Parameterized query — ?1 = active_course_id (NULL if none). The CASE WHEN uses
    // IS NOT DISTINCT FROM via the NULL-safe `IS` operator so a NULL ?1 never matches.
    let sql = "INSERT OR IGNORE INTO index_jobs (document_id, priority)
         SELECT d.id, CASE WHEN ?1 IS NOT NULL AND d.course_id = ?1 THEN 10 ELSE 100 END
         FROM documents d
         JOIN courses c ON c.id = d.course_id
         WHERE d.has_embeddings = 0
           AND d.is_scanned = 0
           AND d.download_url IS NOT NULL
           AND (d.file_type LIKE '%pdf%' OR d.file_type LIKE '%word%' OR d.file_type LIKE '%document%')
           AND c.semester IN (
             SELECT MAX(semester) FROM courses
             WHERE semester LIKE '%20__-0%' OR semester LIKE '%20__-1%'
           )
           AND NOT EXISTS (
             SELECT 1 FROM index_jobs j
             WHERE j.document_id = d.id
               AND j.status IN ('pending', 'running', 'done')
           )";

    conn.execute(sql, rusqlite::params![active_course_id]).unwrap_or(0) as u32
}

/// Obtiene el siguiente job pendiente con su información de documento asociada.
fn fetch_next_pending(app: &tauri::AppHandle) -> Option<(i64, i64, Option<String>, Option<String>, String)> {
    let conn = open_db(app).ok()?;
    conn.query_row(
        "SELECT j.id, j.document_id, d.file_path, d.download_url, COALESCE(d.title, 'archivo')
         FROM index_jobs j
         JOIN documents d ON d.id = j.document_id
         WHERE j.status = 'pending'
         ORDER BY j.priority ASC, j.created_at ASC
         LIMIT 1",
        [],
        |row| Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
        ))
    ).ok()
}

/// Cuenta los jobs totales, completados y fallidos para reportar progreso.
fn count_pending_and_done(app: &tauri::AppHandle) -> (u32, u32, u32) {
    let Ok(conn) = open_db(app) else { return (0, 0, 0) };
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM index_jobs", [], |r| r.get(0)).unwrap_or(0);
    let done: i64 = conn.query_row("SELECT COUNT(*) FROM index_jobs WHERE status='done'", [], |r| r.get(0)).unwrap_or(0);
    let failed: i64 = conn.query_row("SELECT COUNT(*) FROM index_jobs WHERE status='failed'", [], |r| r.get(0)).unwrap_or(0);
    (total as u32, done as u32, failed as u32)
}

// ─── Loop de indexado background ─────────────────────────────────────────────

/// Loop principal del indexado background.
/// Procesa la cola de index_jobs con semáforo de concurrencia (MAX_CONCURRENT=2).
/// Salvaguardas: cancelación, pausa, límite de bytes por sesión (500MB), espacio en disco (1GB).
async fn background_index_loop(
    app: tauri::AppHandle,
    cancel: std::sync::Arc<AtomicBool>,
    paused: std::sync::Arc<AtomicBool>,
) {
    const MAX_CONCURRENT: usize = 2;
    const DELAY_MS: u64 = 300;
    const MAX_SESSION_BYTES: u64 = 500 * 1024 * 1024; // 500MB
    const MIN_DISK_FREE_BYTES: u64 = 1 * 1024 * 1024 * 1024; // 1GB
    const MAX_RETRIES: i64 = 2;

    recover_crashed_jobs(&app);

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT));
    let session_bytes = std::sync::Arc::new(AtomicU64::new(0));
    let session_jobs_processed = std::sync::Arc::new(AtomicU64::new(0));

    loop {
        // Salvaguarda: cancelación
        if cancel.load(Ordering::Relaxed) { break; }

        // Salvaguarda: pausa
        if paused.load(Ordering::Relaxed) {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            continue;
        }

        // Salvaguarda: límite de bytes por sesión
        if session_bytes.load(Ordering::Relaxed) >= MAX_SESSION_BYTES {
            let _ = app.emit("index-bg-complete", serde_json::json!({"reason": "session_limit"}));
            break;
        }

        // Salvaguarda: espacio en disco
        let downloads_dir = app.path().app_data_dir()
            .map(|p| p.join("downloads"))
            .unwrap_or_default();
        if let Ok(space) = fs4::available_space(&downloads_dir) {
            if space < MIN_DISK_FREE_BYTES {
                let _ = app.emit("index-bg-error", serde_json::json!({
                    "error": "Espacio en disco bajo (< 1GB libre). Indexado pausado."
                }));
                tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
                continue;
            }
        }

        // Obtener siguiente job
        let Some((job_id, doc_id, file_path, download_url, title)) = fetch_next_pending(&app) else {
            // Cola vacía — terminamos
            let processed = session_jobs_processed.load(Ordering::Relaxed);
            if processed > 0 {
                // Solo reportar totales si procesamos algo esta sesión
                let (total, done, failed) = count_pending_and_done(&app);
                let _ = app.emit("index-bg-complete", serde_json::json!({
                    "total": total, "done": done, "failed": failed
                }));
            }
            // Si no procesamos nada, no emitimos — evita toast espurio al abrir la app
            break;
        };

        // Marcar como running
        if let Ok(conn) = open_db(&app) {
            let _ = conn.execute(
                "UPDATE index_jobs SET status='running', started_at=datetime('now'), updated_at=datetime('now') WHERE id=?1",
                rusqlite::params![job_id]
            );
        }

        let (total_now, done_now, _) = count_pending_and_done(&app);
        let _ = app.emit("index-bg-started", serde_json::json!({
            "title": title,
            "total": total_now,
            "done": done_now
        }));

        let permit = match std::sync::Arc::clone(&sem).acquire_owned().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[index] semáforo cerrado: {e}");
                return;
            }
        };
        let (app2, cancel2) = (app.clone(), cancel.clone());
        let session_bytes2 = session_bytes.clone();
        let session_jobs2 = session_jobs_processed.clone();

        // Timeout global por job: 90s (descarga 60s + indexado 30s de margen)
        const JOB_TIMEOUT_SECS: u64 = 90;

        tokio::spawn(async move {
            let _permit = permit;

            if cancel2.load(Ordering::Relaxed) {
                // Devolver a pending si se canceló antes de empezar
                if let Ok(conn) = open_db(&app2) {
                    let _ = conn.execute(
                        "UPDATE index_jobs SET status='pending', updated_at=datetime('now') WHERE id=?1",
                        rusqlite::params![job_id]
                    );
                }
                return;
            }

            // Timeout global por job para evitar bloqueos indefinidos
            let result = tokio::time::timeout(
                tokio::time::Duration::from_secs(JOB_TIMEOUT_SECS),
                process_single_document(&app2, doc_id, file_path, download_url, &title)
            ).await;

            let result = match result {
                Ok(inner) => inner,
                Err(_) => Err(format!(
                    "Timeout global: procesamiento de '{}' excedió {}s",
                    title, JOB_TIMEOUT_SECS
                )),
            };

            match result {
                Ok(bytes) => {
                    session_bytes2.fetch_add(bytes, Ordering::Relaxed);
                    session_jobs2.fetch_add(1, Ordering::Relaxed);
                    if let Ok(conn) = open_db(&app2) {
                        let _ = conn.execute(
                            "UPDATE index_jobs SET status='done', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?1",
                            rusqlite::params![job_id]
                        );
                    }
                    let (total, done, failed) = count_pending_and_done(&app2);
                    let _ = app2.emit("index-bg-progress", serde_json::json!({
                        "total": total, "done": done, "failed": failed,
                        "running": true, "sessionBytes": session_bytes2.load(Ordering::Relaxed),
                        "currentTitle": title
                    }));
                }
                Err(e) => {
                    eprintln!("[indexer] Error procesando doc_id={} '{}': {}", doc_id, title, e);
                    // Verificar intentos
                    let attempts: i64 = open_db(&app2)
                        .ok()
                        .and_then(|conn| conn.query_row(
                            "SELECT attempt_count FROM index_jobs WHERE id=?1",
                            rusqlite::params![job_id],
                            |r| r.get(0)
                        ).ok())
                        .unwrap_or(0);

                    if attempts + 1 >= MAX_RETRIES {
                        session_jobs2.fetch_add(1, Ordering::Relaxed);
                        if let Ok(conn) = open_db(&app2) {
                            let _ = conn.execute(
                                "UPDATE index_jobs SET status='failed', attempt_count=attempt_count+1, error_message=?1, updated_at=datetime('now') WHERE id=?2",
                                rusqlite::params![e, job_id]
                            );
                        }
                        let _ = app2.emit("index-bg-error", serde_json::json!({
                            "documentId": doc_id, "title": title, "error": e
                        }));
                    } else {
                        // Reintentar — devolver a pending
                        if let Ok(conn) = open_db(&app2) {
                            let _ = conn.execute(
                                "UPDATE index_jobs SET status='pending', attempt_count=attempt_count+1, error_message=?1, updated_at=datetime('now') WHERE id=?2",
                                rusqlite::params![e, job_id]
                            );
                        }
                    }
                }
            }
        });

        // Rate limiting entre descargas
        tokio::time::sleep(tokio::time::Duration::from_millis(DELAY_MS)).await;
    }
}

/// Procesa un documento individual: descarga si necesario, indexa si es PDF con texto.
///
/// Salvaguardas:
/// - Timeout de 60s por descarga (evita bloqueos en archivos lentos/grandes)
/// - Límite de 50MB por archivo (skip si Content-Length excede)
/// - Catch de panics en extracción de PDF (corrupt PDFs no crashean el loop)
async fn process_single_document(
    app: &tauri::AppHandle,
    doc_id: i64,
    file_path: Option<String>,
    download_url: Option<String>,
    title: &str,
) -> Result<u64, String> {
    const DOWNLOAD_TIMEOUT_SECS: u64 = 60;
    const MAX_FILE_SIZE_BYTES: u64 = 50 * 1024 * 1024; // 50MB

    let downloads_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("downloads");

    // Si ya está en disco, solo indexar
    if let Some(ref path) = file_path {
        let p = std::path::Path::new(path);
        if p.exists() {
            // Solo indexar si es PDF y no tiene embeddings
            if path.to_lowercase().ends_with(".pdf") {
                // Catch panic en PDF corrupto
                let path_clone = path.clone();
                let app_clone = app.clone();
                let result = tokio::task::spawn_blocking(move || {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        extract_text_from_pdf(std::path::Path::new(&path_clone))
                    }))
                }).await;

                match result {
                    Ok(Ok(Ok(text))) if text.trim().len() >= 100 => {
                        index_document_internal(app, doc_id, path.clone()).await?;
                    }
                    Ok(Ok(Err(e))) => {
                        eprintln!("[indexer] Error extrayendo texto de PDF doc_id={}: {}", doc_id, e);
                    }
                    _ => {
                        eprintln!("[indexer] Panic o error al procesar PDF doc_id={}, marcando como escaneado", doc_id);
                        if let Ok(conn) = open_db(&app_clone) {
                            let _ = conn.execute(
                                "UPDATE documents SET is_scanned=1 WHERE id=?1",
                                rusqlite::params![doc_id]
                            );
                        }
                    }
                }
            }
            return Ok(0);
        }
    }

    // Necesita descarga
    let url = download_url.ok_or_else(|| "Sin URL de descarga".to_string())?;

    // Sanitizar nombre de archivo
    let safe_name: String = title.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect::<String>()
        .chars().take(100).collect();
    let filename = format!("{}_{}", doc_id, safe_name);
    let local_path = downloads_dir.join(&filename);

    // Descargar con timeout de 60s para toda la operación
    let client = reqwest::Client::builder()
        .connect_timeout(tokio::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let download_future = async {
        let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }

        // Salvaguarda: verificar Content-Length antes de descargar
        if let Some(content_length) = response.content_length() {
            if content_length > MAX_FILE_SIZE_BYTES {
                return Err(format!(
                    "Archivo demasiado grande ({:.1} MB > {:.0} MB límite). Saltando.",
                    content_length as f64 / (1024.0 * 1024.0),
                    MAX_FILE_SIZE_BYTES as f64 / (1024.0 * 1024.0)
                ));
            }
        }

        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        let byte_count = bytes.len() as u64;

        // Salvaguarda post-descarga: verificar tamaño real
        if byte_count > MAX_FILE_SIZE_BYTES {
            return Err(format!(
                "Archivo descargado demasiado grande ({:.1} MB). Descartando.",
                byte_count as f64 / (1024.0 * 1024.0)
            ));
        }

        Ok((bytes, byte_count))
    };

    // Aplicar timeout de 60s a toda la descarga
    let (bytes, byte_count) = match tokio::time::timeout(
        tokio::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS),
        download_future
    ).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(format!(
            "Timeout: descarga excedió {}s. Archivo probablemente demasiado grande o conexión lenta.",
            DOWNLOAD_TIMEOUT_SECS
        )),
    };

    std::fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string())?;
    std::fs::write(&local_path, &bytes).map_err(|e| e.to_string())?;

    let local_path_str = local_path.display().to_string();

    // Actualizar file_path en documents
    if let Ok(conn) = open_db(app) {
        let _ = conn.execute(
            "UPDATE documents SET file_path=?1 WHERE id=?2",
            rusqlite::params![local_path_str, doc_id]
        );
    }

    // Indexar si es PDF (sin OCR en background)
    // Catch panic en PDF corrupto + timeout de 20s para evitar bloqueos
    if safe_name.to_lowercase().ends_with(".pdf") {
        let local_path_for_extract = local_path.clone();
        let extract_future = tokio::task::spawn_blocking(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                extract_text_from_pdf(&local_path_for_extract)
            }))
        });

        let extract_result = tokio::time::timeout(
            tokio::time::Duration::from_secs(20),
            extract_future
        ).await;

        match extract_result {
            Ok(Ok(Ok(Ok(text)))) => {
                if text.trim().len() >= 100 {
                    let _ = index_document_internal(app, doc_id, local_path_str).await;
                } else {
                    // Escaneado — marcar y saltar
                    if let Ok(conn) = open_db(app) {
                        let _ = conn.execute(
                            "UPDATE documents SET is_scanned=1 WHERE id=?1",
                            rusqlite::params![doc_id]
                        );
                    }
                }
            }
            Ok(Ok(Ok(Err(e)))) => {
                eprintln!("[indexer] Error extrayendo texto de PDF '{}': {}", title, e);
            }
            Err(_) => {
                eprintln!("[indexer] Timeout (20s) extrayendo PDF '{}' (doc_id={}). Saltando.", title, doc_id);
                if let Ok(conn) = open_db(app) {
                    let _ = conn.execute(
                        "UPDATE documents SET is_scanned=1 WHERE id=?1",
                        rusqlite::params![doc_id]
                    );
                }
            }
            _ => {
                eprintln!("[indexer] Panic al procesar PDF '{}' (doc_id={}). PDF posiblemente corrupto.", title, doc_id);
                if let Ok(conn) = open_db(app) {
                    let _ = conn.execute(
                        "UPDATE documents SET is_scanned=1 WHERE id=?1",
                        rusqlite::params![doc_id]
                    );
                }
            }
        }
    }

    Ok(byte_count)
}

/// Helper interno para indexar un documento sin ser command Tauri.
/// Reutiliza la lógica de chunking y FTS5.
async fn index_document_internal(
    app: &tauri::AppHandle,
    doc_id: i64,
    file_path: String,
) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    let text = extract_text_from_pdf(path)?;
    if text.trim().len() < 100 {
        // Marcar como escaneado para que el camino de OCR/re-index lo recoja.
        // Sin este flag el documento queda en purgatorio (ni indexado ni escaneado).
        let conn = open_db(app)?;
        conn.execute(
            "UPDATE documents SET is_scanned = 1 WHERE id = ?1",
            rusqlite::params![doc_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let chunks = chunk_text(&text, 1600, 400);
    let conn = open_db(app)?;
    conn.execute("DELETE FROM document_chunks WHERE document_id=?1", rusqlite::params![doc_id])
        .map_err(|e| e.to_string())?;
    for (i, chunk) in chunks.iter().enumerate() {
        conn.execute(
            "INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?1, ?2, ?3)",
            rusqlite::params![doc_id, i as i64, chunk]
        ).map_err(|e| e.to_string())?;
    }
    conn.execute(
        "UPDATE documents SET has_embeddings=1 WHERE id=?1",
        rusqlite::params![doc_id]
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Comandos Tauri: indexado background ──────────────────────────────────────

/// Inicia el loop de indexado background.
/// Si ya hay uno corriendo, retorna Ok(0) sin lanzar otro.
/// Retorna el número de documentos encolados.
#[tauri::command]
async fn start_background_index(
    active_course_id: Option<i64>,
    app: tauri::AppHandle,
    index_state: tauri::State<'_, IndexState>,
) -> Result<u32, String> {
    // Evitar doble inicio
    {
        let lock = index_state.handle.lock().map_err(|e| e.to_string())?;
        if let Some(ref h) = *lock {
            if !h.is_finished() {
                return Ok(0); // Ya está corriendo
            }
        }
    }

    index_state.cancel.store(false, Ordering::Relaxed);
    index_state.paused.store(false, Ordering::Relaxed);

    let queued = queue_pending_documents(&app, active_course_id);

    let (cancel, paused) = (
        std::sync::Arc::clone(&index_state.cancel),
        std::sync::Arc::clone(&index_state.paused),
    );

    let handle = tokio::spawn(background_index_loop(app, cancel, paused));
    *index_state.handle.lock().map_err(|e| e.to_string())? = Some(handle);

    Ok(queued)
}

/// Pausa o reanuda el indexado background.
/// Retorna el nuevo estado: true = pausado, false = reanudado.
#[tauri::command]
async fn pause_background_index(
    index_state: tauri::State<'_, IndexState>,
) -> Result<bool, String> {
    let current = index_state.paused.load(Ordering::Relaxed);
    index_state.paused.store(!current, Ordering::Relaxed);
    Ok(!current)
}

/// Cancela el indexado background completamente.
#[tauri::command]
async fn cancel_background_index(
    index_state: tauri::State<'_, IndexState>,
) -> Result<(), String> {
    index_state.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

/// Retorna el estado actual de la cola de indexado.
#[tauri::command]
async fn get_index_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (total, done, failed) = count_pending_and_done(&app);
    // Contar pending + running como "trabajo activo"
    let pending: i64 = open_db(&app).ok()
        .and_then(|conn| conn.query_row(
            "SELECT COUNT(*) FROM index_jobs WHERE status IN ('pending', 'running')",
            [], |r| r.get(0)
        ).ok())
        .unwrap_or(0);
    Ok(serde_json::json!({
        "total": total,
        "done": done,
        "failed": failed,
        "pending": pending,
    }))
}

/// Comando Tauri: extrae texto de un PDF, lo chunkea y lo indexa en FTS5.
/// Si el PDF es escaneado (sin texto extraíble), intenta OCR con Gemini Vision.
/// Retorna "scanned" si el PDF no contiene texto extraíble incluso tras OCR,
/// o "indexed:N" con el número de chunks indexados.
#[tauri::command]
async fn index_document(
    document_id: i64,
    file_path: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let path = std::path::Path::new(&file_path);

    // 1. Extraer texto del PDF
    app.emit("index-progress", "Extrayendo texto del PDF...").ok();
    let mut text = match extract_text_from_pdf(path) {
        Ok(t) => t,
        Err(e) => return Err(format!("Error al leer PDF: {e}")),
    };

    let conn = open_db(&app)?;

    // 2. Detectar PDF escaneado (sin texto extraíble) — intentar OCR con Gemini Vision
    if text.trim().len() < 100 {
        app.emit("index-progress", "Procesando PDF escaneado con OCR...").ok();

        match ocr_pdf_with_gemini(path).await {
            Ok(ocr_text) if ocr_text.trim().len() > 100 => {
                // OCR exitoso — usar el texto del OCR y continuar con el pipeline normal
                text = ocr_text;
            }
            Ok(_) | Err(_) => {
                // OCR falló o retornó muy poco texto — marcar como escaneado
                conn.execute(
                    "UPDATE documents SET is_scanned = 1 WHERE id = ?1",
                    rusqlite::params![document_id],
                )
                .map_err(|e| e.to_string())?;
                app.emit("index-progress", "").ok();
                return Ok("scanned".to_string());
            }
        }
    }

    // 3. Chunkear el texto (1600 chars, 400 de solapamiento)
    let chunks = chunk_text(&text, 1600, 400);

    // 4. Borrar chunks anteriores si los hay (triggers FTS5 se encargan del índice)
    conn.execute(
        "DELETE FROM document_chunks WHERE document_id = ?1",
        rusqlite::params![document_id],
    )
    .map_err(|e| e.to_string())?;

    // 5. Insertar chunks (los triggers mantienen chunks_fts sincronizado)
    for (i, chunk) in chunks.iter().enumerate() {
        conn.execute(
            "INSERT INTO document_chunks (document_id, chunk_index, content) VALUES (?1, ?2, ?3)",
            rusqlite::params![document_id, i as i64, chunk],
        )
        .map_err(|e| e.to_string())?;
    }

    // 6. Actualizar documento: guardar preview y marcar como indexado
    let preview = &text[..text.len().min(500)];
    conn.execute(
        "UPDATE documents SET content_text = ?1, has_embeddings = 1 WHERE id = ?2",
        rusqlite::params![preview, document_id],
    )
    .map_err(|e| e.to_string())?;

    // 7. Limpiar estado de progreso
    app.emit("index-progress", "").ok();

    Ok(format!("indexed:{}", chunks.len()))
}

/// Sanitiza un query del usuario para que sea seguro en una MATCH FTS5.
///
/// Caracteres especiales de FTS5 ("*", "(", ")", "-", ":", "+", "~", "|",
/// "&", "^", ",") son reemplazados por espacios, y cada token resultante se
/// envuelve en comillas dobles. Acentos, ñ y caracteres no-ASCII se
/// preservan tal cual (FTS5 los trata como texto normal).
fn sanitize_fts5_query(input: &str) -> String {
    const FTS5_SPECIAL: &str = "\"*()-:+~|&^,";
    let cleaned: String = input
        .chars()
        .map(|c| if FTS5_SPECIAL.contains(c) { ' ' } else { c })
        .collect();
    cleaned
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"", w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Tool search_notes: busca en el contenido de los PDFs indexados mediante FTS5.
///
/// `active_course_id` es el curso activo del chat (si lo hay). Cuando está
/// presente, los resultados se filtran a ese curso para evitar fuga de
/// contenido cross-course. Si el modelo pasa explícitamente `course_id` en los
/// args, ese valor tiene prioridad sobre el curso activo (permite búsquedas
/// cross-course intencionales).
fn tool_search_notes(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
    active_course_id: Option<i64>,
) -> serde_json::Value {
    let query = args["query"].as_str().unwrap_or("").trim().to_string();
    let limit = args["limit"].as_i64().unwrap_or(5).max(1).min(20);

    // Permitir override explícito desde el modelo.
    let explicit_course_id = args["course_id"].as_i64();
    // Precedencia: arg explícito > curso activo del chat.
    let course_filter: Option<i64> = explicit_course_id.or(active_course_id);

    if query.is_empty() {
        return serde_json::json!({ "error": "query no puede estar vacío" });
    }

    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e }),
    };

    // Escapar query para FTS5: eliminar todos los caracteres especiales del
    // parser y envolver cada palabra en comillas. Sin esta limpieza, queries
    // con *, (, ), -, :, +, ~, |, &, ^ rompen el parser y abortan la query.
    let fts_query = sanitize_fts5_query(&query);

    // Fallback: si el sanitizer quedó vacío (query sólo tenía caracteres
    // especiales), usamos una búsqueda vacía que retorna vec vacío.
    let results = if fts_query.is_empty() {
        Vec::new()
    } else {
        try_fts_query(&conn, &fts_query, limit, course_filter).unwrap_or_default()
    };

    let count = results.len();
    serde_json::json!({
        "results": results,
        "count": count,
        "query": query,
        "course_filter": course_filter
    })
}

/// Ejecuta una consulta FTS5 y retorna los fragmentos encontrados.
/// Si `course_id` es Some, filtra por ese curso; si es None, busca en todos.
fn try_fts_query(
    conn: &rusqlite::Connection,
    fts_query: &str,
    limit: i64,
    course_id: Option<i64>,
) -> Result<Vec<serde_json::Value>, rusqlite::Error> {
    // Filtro NULL-safe: cuando ?3 es NULL la condición es (NULL IS NULL OR ...) = TRUE
    // → equivale a "sin filtro". Cuando ?3 tiene valor, exige match exacto.
    let mut stmt = conn.prepare(
        "SELECT dc.content, d.title, d.course_id, dc.chunk_index
         FROM chunks_fts
         JOIN document_chunks dc ON dc.id = chunks_fts.rowid
         JOIN documents d ON dc.document_id = d.id
         WHERE chunks_fts MATCH ?1
           AND (?3 IS NULL OR d.course_id = ?3)
         ORDER BY rank
         LIMIT ?2",
    )?;

    let rows: Vec<serde_json::Value> = stmt
        .query_map(rusqlite::params![fts_query, limit, course_id], |row| {
            Ok(serde_json::json!({
                "content": row.get::<_, String>(0)?,
                "document_title": row.get::<_, String>(1)?,
                "chunk_index": row.get::<_, i64>(3)?
            }))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Tool read_document: lee el contenido completo de un documento indexado.
fn tool_list_documents(app: &tauri::AppHandle, args: &serde_json::Value) -> serde_json::Value {
    let filter = args["filter"].as_str().unwrap_or("").trim().to_lowercase();
    let course_filter = args["course"].as_str().unwrap_or("").trim().to_lowercase();
    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": e}),
    };
    let mut stmt = match conn.prepare(
        "SELECT d.id, d.title, c.name as course_name, d.course_id FROM documents d LEFT JOIN courses c ON d.course_id = c.id ORDER BY c.name, d.title"
    ) {
        Ok(s) => s,
        Err(e) => return serde_json::json!({"error": format!("{}", e)}),
    };
    let docs: Vec<serde_json::Value> = match stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "id": row.get::<_, i64>(0)?,
            "title": row.get::<_, String>(1).unwrap_or_default(),
            "course": row.get::<_, String>(2).unwrap_or("Sin curso".to_string()),
        }))
    }) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }.into_iter()
    .filter(|d| {
        let title = d["title"].as_str().unwrap_or("").to_lowercase();
        let course = d["course"].as_str().unwrap_or("").to_lowercase();
        // Filtrar por curso si se especifica
        if !course_filter.is_empty() && !course.contains(&course_filter) {
            return false;
        }
        // Filtrar por nombre — con boundary check para semanas (S1 no matchea S11)
        if !filter.is_empty() {
            // Si el filtro ya tiene underscore/guion (ej: "S1_", "M_S1"), usar match directo
            if filter.contains('_') || filter.contains('-') {
                if !title.contains(&filter) {
                    return false;
                }
            } else {
                // Sin underscore: agregar boundary check (S1 -> S1_ o S1- para no matchear S11)
                let with_underscore = format!("{}_", filter);
                let with_dash = format!("{}-", filter);
                let with_dot = format!("{}.", filter);
                if !title.contains(&with_underscore) && !title.contains(&with_dash) && !title.contains(&with_dot) && !title.contains(&filter) {
                    return false;
                }
                // Extra: si matchea pero es parte de un numero mayor (S1 in S11), rechazar
                if let Some(pos) = title.find(&filter) {
                    let after = title.as_bytes().get(pos + filter.len());
                    if let Some(&ch) = after {
                        if ch.is_ascii_digit() {
                            return false; // S1 + digit = S11, S13, etc -> reject
                        }
                    }
                }
            }
        }
        true
    })
    .collect();
    serde_json::json!({"documents": docs, "count": docs.len()})
}

fn tool_read_document(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
) -> serde_json::Value {
    let query = args["query"].as_str().unwrap_or("").trim().to_string();
    let doc_id = args["id"].as_i64();

    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e }),
    };

    // Si se pasa un ID directo, usarlo
    let (target_id, target_title) = if let Some(id) = doc_id {
        let title: String = conn.query_row(
            "SELECT title FROM documents WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        ).unwrap_or_else(|_| format!("doc_{}", id));
        (id, title)
    } else if !query.is_empty() {
        // Buscar por titulo — tomar el PRIMERO sin preguntar
        let search_pattern = format!("%{}%", query);
        let result: Result<(i64, String), _> = conn.query_row(
            "SELECT id, title FROM documents WHERE title LIKE ?1 ORDER BY title LIMIT 1",
            rusqlite::params![search_pattern],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );
        match result {
            Ok((id, title)) => (id, title),
            Err(_) => return serde_json::json!({
                "error": format!("No se encontro documento con '{}'", query),
                "suggestion": "Usa list_documents para ver los nombres disponibles"
            }),
        }
    } else {
        return serde_json::json!({ "error": "Necesito query o id del documento" });
    };

    // Leer chunks del documento
    // Leer todos los chunks del documento encontrado
    let doc_id = target_id;
    let doc_title = target_title;

    let mut chunk_stmt = match conn.prepare(
        "SELECT content FROM document_chunks WHERE document_id = ?1 ORDER BY chunk_index",
    ) {
        Ok(s) => s,
        Err(e) => return serde_json::json!({ "error": format!("Error preparando query de chunks: {e}") }),
    };

    let chunks: Vec<String> = match chunk_stmt.query_map(rusqlite::params![doc_id], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(e) => return serde_json::json!({ "error": format!("Error leyendo chunks: {e}") }),
    };

    let full_text = chunks.join("\n\n");

    // Truncar a 30KB para no desbordar el contexto.
    // Safe UTF-8 truncation: retrocede hasta el char boundary más cercano
    // para no panicar con caracteres multi-byte (ñ, á, emojis, etc).
    let truncated = if full_text.len() > 30_000 {
        let mut cut = 30_000usize;
        while cut > 0 && !full_text.is_char_boundary(cut) {
            cut -= 1;
        }
        format!(
            "{}...\n\n[Documento truncado. Se muestran los primeros 30KB de {} bytes totales]",
            &full_text[..cut],
            full_text.len()
        )
    } else {
        full_text.clone()
    };

    serde_json::json!({
        "title": doc_title,
        "content": truncated,
        "chunks": chunks.len(),
        "total_bytes": full_text.len()
    })
}

/// Ejecuta la tool `get_upcoming_deadlines`: consulta SQLite y retorna las
/// tareas próximas como JSON.
fn tool_get_upcoming_deadlines(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
) -> serde_json::Value {
    let days_ahead = args["days_ahead"].as_i64().unwrap_or(7).max(1).min(90);

    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e }),
    };

    // Incluir tareas vencidas en las últimas 24h + próximas N días (en UTC-5 Perú)
    let mut stmt = match conn.prepare(
        "SELECT a.title, a.due_at, c.name AS course_name, a.points_possible
         FROM assignments a
         JOIN courses c ON a.course_id = c.id
         WHERE a.due_at > datetime('now', '-1 day')
           AND a.due_at < datetime('now', '+' || ?1 || ' days')
         ORDER BY a.due_at ASC
         LIMIT 20",
    ) {
        Ok(s) => s,
        Err(e) => return serde_json::json!({ "error": format!("Error preparando query: {e}") }),
    };

    let rows: Vec<serde_json::Value> = match stmt.query_map(
        rusqlite::params![days_ahead.to_string()],
        |row| {
            let due_at_utc: Option<String> = row.get(1)?;
            // Convertir UTC → hora Perú (UTC-5) para mostrar al usuario
            let due_at_peru = due_at_utc.as_deref().map(|s| {
                // Parsear "2026-04-09T04:59:59Z" o "2026-04-09 04:59:59"
                let s = s.trim_end_matches('Z');
                if let Ok(dt) = chrono_parse_iso(s) {
                    let peru = dt - 5 * 3600; // restar 5 horas
                    format_peru_datetime(peru)
                } else {
                    s.to_string()
                }
            }).unwrap_or_default();

            Ok(serde_json::json!({
                "title":          row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                "due_at_utc":     due_at_utc.unwrap_or_default(),
                "due_at_peru":    due_at_peru,
                "course_name":    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "points_possible": row.get::<_, Option<f64>>(3)?.unwrap_or(0.0)
            }))
        },
    ) {
        Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
        Err(e) => return serde_json::json!({ "error": format!("Error ejecutando query: {e}") }),
    };

    serde_json::json!({
        "days_ahead": days_ahead,
        "count": rows.len(),
        "assignments": rows
    })
}

/// Ejecuta la tool `get_announcements`: consulta SQLite y retorna anuncios
/// recientes como JSON.
fn tool_get_announcements(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
) -> serde_json::Value {
    let limit = args["limit"].as_i64().unwrap_or(10).max(1).min(50);

    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e }),
    };

    let mut stmt = match conn.prepare(
        "SELECT a.title, a.content, a.posted_at, c.name AS course_name
         FROM announcements a
         JOIN courses c ON a.course_id = c.id
         ORDER BY a.posted_at DESC
         LIMIT ?1",
    ) {
        Ok(s) => s,
        Err(e) => return serde_json::json!({ "error": format!("Error preparando query: {e}") }),
    };

    let rows: Vec<serde_json::Value> = match stmt.query_map(rusqlite::params![limit], |row| {
        Ok(serde_json::json!({
            "title":       row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            "content":     row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            "posted_at":   row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            "course_name": row.get::<_, Option<String>>(3)?.unwrap_or_default()
        }))
    }) {
        Ok(mapped) => mapped.filter_map(|r| r.ok()).collect(),
        Err(e) => return serde_json::json!({ "error": format!("Error ejecutando query: {e}") }),
    };

    serde_json::json!({
        "limit": limit,
        "count": rows.len(),
        "announcements": rows
    })
}

/// Ejecuta la tool `create_flashcards`: no consulta SQLite — le dice a Gemini
/// que genere las flashcards en su respuesta de texto.
fn tool_create_flashcards(args: &serde_json::Value) -> serde_json::Value {
    let topic = args["topic"].as_str().unwrap_or("tema no especificado");
    let count = args["count"].as_i64().unwrap_or(10).max(1).min(50);

    serde_json::json!({
        "status": "ok",
        "message": format!(
            "Genera exactamente {} flashcards sobre '{}' en tu próxima respuesta de texto. \
             Cada flashcard debe tener formato:\n\
             **Pregunta:** [pregunta]\n**Respuesta:** [respuesta]\n\n\
             Numera cada flashcard del 1 al {}.",
            count, topic, count
        )
    })
}

// ─── Helper: expandir ~ a home directory ────────────────────────────────────

/// Expande ~ al directorio home del usuario.
fn expand_tilde(path: &str) -> std::path::PathBuf {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]);
        }
    } else if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    std::path::PathBuf::from(path)
}

// ─── Tools de sistema (bash, archivos) ──────────────────────────────────────

/// Crea un Command con PATH extendido para que funcione dentro del .app empaquetado.
/// Prepende directorios comunes del sistema sin descartar el PATH del usuario,
/// de forma cross-platform (macOS/Linux/Windows).
fn system_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);

    // Inherit existing PATH and PREPEND common locations per platform.
    let existing_path = std::env::var("PATH").unwrap_or_default();

    #[cfg(target_os = "macos")]
    let extra_paths = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

    #[cfg(target_os = "linux")]
    let extra_paths = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/snap/bin";

    #[cfg(target_os = "windows")]
    let extra_paths = ""; // Windows: confía en el PATH heredado (PATHEXT, separador distinto).

    let separator = if cfg!(windows) { ";" } else { ":" };

    let new_path = if existing_path.is_empty() {
        extra_paths.to_string()
    } else if extra_paths.is_empty() {
        existing_path
    } else {
        format!("{}{}{}", extra_paths, separator, existing_path)
    };

    cmd.env("PATH", new_path);
    cmd
}

/// Valida un comando contra patrones peligrosos conocidos.
/// Retorna Some(razón) si el comando debe bloquearse, None si es seguro.
// ─── Clasificación de comandos para modo confianza ──────────────────────────

#[derive(Debug, PartialEq, Clone, Copy)]
enum CommandType {
    ReadOnly,    // ls, cat, head, grep, find, etc. — safe, no permission needed
    Install,     // brew install, pip install, npm install — generally safe
    Write,       // cp, mv, touch, mkdir — modifies files
    Destructive, // rm, rmdir, chmod — potentially dangerous
    Execute,     // python, node, bash script — runs code
    Network,     // curl, wget — network access
    Unknown,     // can't classify
}

impl CommandType {
    fn as_str(&self) -> &'static str {
        match self {
            CommandType::ReadOnly => "read_only",
            CommandType::Install => "install",
            CommandType::Write => "write",
            CommandType::Destructive => "destructive",
            CommandType::Execute => "execute",
            CommandType::Network => "network",
            CommandType::Unknown => "unknown",
        }
    }
}

/// Classifies a bash command into a category to determine permission level.
/// Parses only the first command in a pipeline (before |, &&, ;).
/// Strips path prefixes so /usr/bin/ls is classified the same as ls.
fn classify_command(command: &str) -> CommandType {
    // Parse the first command in a pipeline (before |, &&, ;)
    let first_cmd = command
        .split(&['|', '&', ';'][..])
        .next()
        .unwrap_or("")
        .trim();

    let base_cmd_owned = first_cmd
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();

    // Strip path prefix (e.g., /usr/bin/ls -> ls)
    let base_cmd = base_cmd_owned.rsplit('/').next().unwrap_or(&base_cmd_owned);

    match base_cmd {
        // Read-only commands
        "ls" | "tree" | "du" | "df" | "cat" | "head" | "tail" | "less" | "more"
        | "wc" | "stat" | "file" | "which" | "whereis" | "whoami" | "pwd"
        | "echo" | "date" | "uname" | "env" | "printenv" | "hostname"
        | "find" | "grep" | "rg" | "ag" | "ack" | "locate" | "fd"
        | "jq" | "yq" | "awk" | "sed"
        | "diff" | "cmp" | "sort" | "uniq" | "tr" | "cut" | "paste"
        | "man" | "help" | "info" | "type"
        | "bat" | "exa" | "eza" | "realpath" | "dirname" | "basename"
        | "id" | "groups" | "where"
        | "open" | "xdg-open" | "start" => CommandType::ReadOnly,

        // Git: subcommand determines classification
        "git" => {
            let subcmd = first_cmd.split_whitespace().nth(1).unwrap_or("");
            match subcmd {
                "status" | "log" | "diff" | "show" | "branch" | "remote" | "tag"
                | "stash" | "blame" | "shortlog" => CommandType::ReadOnly,
                _ => CommandType::Write,
            }
        }

        // Install commands
        "brew" | "pip" | "pip3" | "npm" | "npx" | "yarn" | "pnpm" | "cargo"
        | "apt" | "apt-get" | "dnf" | "yum" | "pacman"
        | "gem" | "conda" => CommandType::Install,

        // Write commands (modify files but not destructive)
        "cp" | "mv" | "touch" | "mkdir" | "mktemp" | "tee" | "ln"
        | "cd" | "code" => CommandType::Write,

        // Destructive commands
        "rm" | "rmdir" | "chmod" | "chown" | "chgrp" | "shred"
        | "sudo" | "kill" | "killall" | "pkill"
        | "shutdown" | "reboot" | "dd" | "mkfs" => CommandType::Destructive,

        // Execute commands
        "python" | "python3" | "node" | "bun" | "deno" | "ruby" | "perl"
        | "php" | "java" | "javac" | "gcc" | "g++" | "clang" | "rustc" | "go"
        | "make" | "cmake" | "swift" | "swiftc"
        | "sh" | "bash" | "zsh" => CommandType::Execute,

        // Network commands
        "curl" | "wget" | "http" | "ssh" | "scp" | "rsync" | "ftp"
        | "nc" | "netcat" | "ping" | "traceroute" | "dig" | "nslookup"
        | "host" => CommandType::Network,

        _ => CommandType::Unknown,
    }
}

/// Lee el valor de trust_mode desde SQLite. Default: true (confianza activada).
fn get_trust_mode_sync(app: &tauri::AppHandle) -> bool {
    open_db(app).ok()
        .and_then(|conn| conn.query_row(
            "SELECT value FROM settings WHERE key = 'trust_mode'",
            [],
            |row| row.get::<_, String>(0),
        ).ok())
        .map(|v| v == "true")
        .unwrap_or(true)
}

/// Lee un setting booleano arbitrario desde SQLite. Retorna None si:
/// - no se puede abrir la DB,
/// - la tabla settings no existe aún,
/// - la clave no existe,
/// - el valor no es parseable como booleano.
///
/// Se llama en cada turn del chat (desde `call_gemini_streaming`), por lo que
/// NUNCA debe hacer panic: todos los errores de SQLite se degradan a None y
/// el caller decide el default. Si SQLite está bloqueada temporalmente (WAL
/// checkpoint, etc.), retorna None y el caller usa el default seguro.
fn read_setting_bool(app: &tauri::AppHandle, key: &str) -> Option<bool> {
    let conn = open_db(app).ok()?;
    let value: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()?;
    match value.to_lowercase().as_str() {
        "true" | "1" | "yes" => Some(true),
        "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

fn check_command_security(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    let blocked_patterns: &[(&str, &str)] = &[
        ("rm -rf /", "Eliminacion recursiva del sistema"),
        ("rm -rf ~", "Eliminacion del directorio home"),
        ("mkfs", "Formateo de disco"),
        ("dd if=/dev/zero", "Escritura destructiva al disco"),
        (":()", "Fork bomb detectada"),
        ("sudo rm", "Eliminacion con sudo"),
        ("chmod 777 /", "Cambio de permisos del sistema"),
    ];
    for &(pattern, reason) in blocked_patterns {
        if lower.contains(pattern) {
            return Some(reason);
        }
    }
    // Permitir sudo solo para brew y pip (necesidades comunes de estudiantes)
    if lower.contains("sudo") && !lower.contains("brew") && !lower.contains("pip") {
        return Some("sudo no permitido. Usa brew install sin sudo.");
    }
    None
}

/// Mata el arbol de procesos completo dado un PID.
/// Envia SIGTERM primero, espera 500ms, luego SIGKILL.
#[cfg(unix)]
fn kill_process_tree(pid: u32) {
    // OpenCode pattern: SIGTERM → 5s espera → SIGKILL
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    eprintln!("[bash] Sent SIGTERM to PGID -{}, waiting 5s for graceful shutdown...", pid);
    std::thread::sleep(std::time::Duration::from_secs(5));
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    eprintln!("[bash] Sent SIGKILL to PGID -{}", pid);
}

/// Ejecuta un comando bash y retorna stdout, stderr y exit code.
/// Timeout configurable (default 30s). Mata el arbol de procesos al expirar.
/// Valida seguridad basica y trunca salidas a 100KB.
/// `session_key` identifica la sesión de chat (window label) para aislar el
/// CWD persistido entre sesiones concurrentes.
fn run_bash_once(session_key: &str, command: &str, timeout_secs: u64) -> serde_json::Value {
    const CWD_MARKER: &str = "___STUDYAI_CWD___";

    // Wrap command to capture the final CWD after execution
    let wrapped_command = format!("{}; echo '{}'; pwd -P", command, CWD_MARKER);

    let mut cmd = system_command("bash");
    cmd.arg("-c").arg(&wrapped_command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Heredar env del proceso parent EXCEPTO PATH — el PATH custom de system_command()
    // ya tiene /opt/homebrew/bin prependeado y NO debe ser sobrescrito por el PATH limitado
    // que hereda un Tauri packaged app desde Finder/launchd.
    for (k, v) in std::env::vars() {
        if k != "PATH" {
            cmd.env(k, v);
        }
    }

    // Apply persisted CWD (if any) para ESTA sesión.
    if let Ok(guard) = CURRENT_CWD.lock() {
        if let Some(cwd) = guard.get(session_key) {
            let path = std::path::Path::new(cwd);
            if path.is_dir() {
                cmd.current_dir(cwd);
            }
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({ "error": format!("Error al ejecutar: {}", e) });
        }
    };

    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(Ok(output)) => {
            let _ = handle.join();
            let raw_stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);

            // Extract CWD from the marker appended to stdout
            let stdout = if let Some(marker_pos) = raw_stdout.find(CWD_MARKER) {
                let after_marker = &raw_stdout[marker_pos + CWD_MARKER.len()..];
                let new_cwd = after_marker.trim().to_string();
                if !new_cwd.is_empty() {
                    if let Ok(mut guard) = CURRENT_CWD.lock() {
                        guard.insert(session_key.to_string(), new_cwd);
                    }
                }
                // Return only the part before the marker (strip trailing newline before marker)
                let before = &raw_stdout[..marker_pos];
                before.strip_suffix('\n').unwrap_or(before).to_string()
            } else {
                raw_stdout
            };

            let max_len = 100_000;
            // Safe UTF-8 truncation: retrocede hasta el char boundary más cercano
            // para no panicar con caracteres multi-byte (ñ, á, emojis, etc).
            let stdout_t = if stdout.len() > max_len {
                let mut cut = max_len;
                while cut > 0 && !stdout.is_char_boundary(cut) {
                    cut -= 1;
                }
                format!("{}...\n[TRUNCADO: {} bytes]", &stdout[..cut], stdout.len())
            } else { stdout };
            let stderr_t = if stderr.len() > max_len {
                let mut cut = max_len;
                while cut > 0 && !stderr.is_char_boundary(cut) {
                    cut -= 1;
                }
                format!("{}...\n[TRUNCADO: {} bytes]", &stderr[..cut], stderr.len())
            } else { stderr };

            serde_json::json!({
                "stdout": stdout_t,
                "stderr": stderr_t,
                "exit_code": exit_code
            })
        }
        Ok(Err(e)) => {
            let _ = handle.join();
            serde_json::json!({ "error": format!("Error: {e}") })
        }
        Err(_) => {
            eprintln!("[bash] Timeout {}s, killing PID {}", timeout_secs, pid);
            #[cfg(unix)]
            kill_process_tree(pid);
            #[cfg(not(unix))]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(&["/PID", &pid.to_string(), "/T", "/F"])
                    .output();
            }
            let _ = handle.join();
            serde_json::json!({
                "stdout": "",
                "stderr": format!("Timeout: comando excedio {}s y fue terminado", timeout_secs),
                "exit_code": 124,
                "timed_out": true
            })
        }
    }
}

/// Ejecuta un comando bash con reintentos (max 3, patron OpenCode).
/// Timeout configurable (default 30s). SIGTERM → 5s → SIGKILL.
/// Seguridad basica + truncado 100KB. Env heredado completo.
/// `session_key` aisla el CWD entre sesiones de chat concurrentes.
fn tool_run_bash(
    app: &tauri::AppHandle,
    session_key: &str,
    args: &serde_json::Value,
) -> serde_json::Value {
    let command = args["command"].as_str().unwrap_or("");
    if command.is_empty() {
        return serde_json::json!({ "error": "No se proporciono un comando" });
    }

    // ── Classify command before anything else ──
    let cmd_type = classify_command(command);
    eprintln!("[bash] Command classified as: {:?}", cmd_type);

    // Adjust timeout based on classification:
    // - Install commands get 120s (downloads can be slow)
    // - Everything else uses the provided timeout or default 30s
    let default_timeout = match cmd_type {
        CommandType::Install => 120,
        _ => 30,
    };
    let timeout_secs = args["timeout"].as_u64().unwrap_or(default_timeout);

    // Determine retry behavior based on classification:
    // - ReadOnly: no retries needed (idempotent reads)
    // - Destructive: no retries (dangerous to repeat)
    // - Everything else: up to 3 retries
    let max_retries: u8 = match cmd_type {
        CommandType::ReadOnly | CommandType::Destructive => 1,
        _ => 3,
    };

    eprintln!("[bash] Ejecutando (timeout {}s, max_retries {}): {}", timeout_secs, max_retries, command);

    // Log warning for destructive commands
    if cmd_type == CommandType::Destructive {
        eprintln!("[bash] WARNING: Destructive command detected — {}", command);
    }

    if let Some(reason) = check_command_security(command) {
        eprintln!("[bash] Bloqueado: {}", reason);
        return serde_json::json!({ "error": format!("Comando bloqueado: {}", reason) });
    }

    // ── Modo confianza: bloquear destructivos/desconocidos si está desactivado ──
    if !get_trust_mode_sync(app) {
        match cmd_type {
            CommandType::Destructive | CommandType::Unknown => {
                eprintln!("[bash] Bloqueado por modo confianza: {:?}", cmd_type);
                return serde_json::json!({
                    "error": "Comando bloqueado (modo confianza desactivado). Activa el modo confianza en Ajustes > Cuenta para ejecutar este tipo de comandos.",
                    "command_type": cmd_type.as_str()
                });
            }
            _ => {} // ReadOnly, Install, Write, Execute, Network → permitidos
        }
    }

    // Reintentos (patron OpenCode: max 3, or 1 for ReadOnly/Destructive)
    for attempt in 1..=max_retries {
        let result = run_bash_once(session_key, command, timeout_secs);

        // Si fue exitoso o timeout, retornar inmediatamente
        let exit_code = result["exit_code"].as_i64().unwrap_or(-1);
        let has_error = result.get("error").is_some();
        let timed_out = result["timed_out"].as_bool().unwrap_or(false);

        if exit_code == 0 || timed_out || attempt == max_retries {
            if attempt > 1 && exit_code == 0 {
                eprintln!("[bash] Exitoso en intento {}/{}", attempt, max_retries);
            }
            // Inject command_type into the result
            if let serde_json::Value::Object(ref map) = result {
                let mut enriched = map.clone();
                enriched.insert("command_type".to_string(), serde_json::json!(cmd_type.as_str()));
                return serde_json::Value::Object(enriched);
            }
            return result;
        }

        if has_error || exit_code != 0 {
            eprintln!("[bash] Intento {}/{} fallo (exit {}), reintentando...", attempt, max_retries, exit_code);
            // Backoff exponencial: 1s, 2s entre reintentos
            std::thread::sleep(std::time::Duration::from_secs(attempt as u64));
        }
    }

    serde_json::json!({ "error": "Agotados los reintentos" })
}

/// Crea o sobrescribe un archivo en la ruta especificada.
fn tool_create_file(args: &serde_json::Value) -> serde_json::Value {
    let path_str = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");

    if path_str.is_empty() {
        return serde_json::json!({ "error": "No se proporcionó una ruta" });
    }

    let path = expand_tilde(path_str);
    eprintln!("[tool:create_file] Creando: {}", path.display());

    // Crear directorios padre si no existen
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return serde_json::json!({
                "error": format!("No se pudo crear el directorio {}: {e}", parent.display())
            });
        }
    }

    match std::fs::write(&path, content) {
        Ok(()) => {
            let bytes = content.len();
            serde_json::json!({
                "success": true,
                "path": path.display().to_string(),
                "bytes": bytes
            })
        }
        Err(e) => {
            eprintln!("[tool:create_file] Error: {}", e);
            serde_json::json!({
                "error": format!("No se pudo escribir el archivo {}: {e}", path.display())
            })
        }
    }
}

/// Lee el contenido de un archivo (máximo 1MB).
fn tool_read_file(args: &serde_json::Value) -> serde_json::Value {
    let path_str = args["path"].as_str().unwrap_or("");

    if path_str.is_empty() {
        return serde_json::json!({ "error": "No se proporcionó una ruta" });
    }

    let path = expand_tilde(path_str);
    eprintln!("[tool:read_file] Leyendo: {}", path.display());

    // Verificar tamaño antes de leer
    let metadata = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            return serde_json::json!({
                "error": format!("No se pudo acceder al archivo {}: {e}", path.display())
            });
        }
    };

    let max_size: u64 = 1_048_576; // 1MB
    let file_size = metadata.len();

    if file_size > max_size {
        // Leer solo el primer MB
        match std::fs::File::open(&path) {
            Ok(mut file) => {
                use std::io::Read;
                let mut buffer = vec![0u8; max_size as usize];
                match file.read(&mut buffer) {
                    Ok(n) => {
                        let content = String::from_utf8_lossy(&buffer[..n]).to_string();
                        return serde_json::json!({
                            "content": content,
                            "path": path.display().to_string(),
                            "bytes": file_size,
                            "truncated": true,
                            "notice": format!("Archivo truncado: se leyó 1MB de {} bytes totales", file_size)
                        });
                    }
                    Err(e) => {
                        return serde_json::json!({
                            "error": format!("Error al leer el archivo: {e}")
                        });
                    }
                }
            }
            Err(e) => {
                return serde_json::json!({
                    "error": format!("No se pudo abrir el archivo: {e}")
                });
            }
        }
    }

    match std::fs::read_to_string(&path) {
        Ok(content) => {
            serde_json::json!({
                "content": content,
                "path": path.display().to_string(),
                "bytes": file_size
            })
        }
        Err(e) => {
            eprintln!("[tool:read_file] Error: {}", e);
            serde_json::json!({
                "error": format!("No se pudo leer el archivo {}: {e}", path.display())
            })
        }
    }
}

/// Lista los archivos y carpetas en un directorio.
fn tool_list_directory(args: &serde_json::Value) -> serde_json::Value {
    let path_str = args["path"].as_str().unwrap_or("");

    if path_str.is_empty() {
        return serde_json::json!({ "error": "No se proporcionó una ruta" });
    }

    let path = expand_tilde(path_str);
    eprintln!("[tool:list_directory] Listando: {}", path.display());

    let entries_iter = match std::fs::read_dir(&path) {
        Ok(iter) => iter,
        Err(e) => {
            return serde_json::json!({
                "error": format!("No se pudo listar el directorio {}: {e}", path.display())
            });
        }
    };

    let mut entries = Vec::new();
    for entry_result in entries_iter {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = entry.metadata();

        let (entry_type, size) = match metadata {
            Ok(m) => {
                let t = if m.is_dir() { "directory" } else if m.is_symlink() { "symlink" } else { "file" };
                (t, m.len())
            }
            Err(_) => ("unknown", 0),
        };

        entries.push(serde_json::json!({
            "name": name,
            "type": entry_type,
            "size": size
        }));
    }

    // Ordenar: directorios primero, luego por nombre
    entries.sort_by(|a, b| {
        let a_is_dir = a["type"].as_str() == Some("directory");
        let b_is_dir = b["type"].as_str() == Some("directory");
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let a_name = a["name"].as_str().unwrap_or("");
                let b_name = b["name"].as_str().unwrap_or("");
                a_name.to_lowercase().cmp(&b_name.to_lowercase())
            }
        }
    });

    serde_json::json!({
        "path": path.display().to_string(),
        "entries": entries,
        "count": entries.len()
    })
}

/// Genera un PDF a partir de contenido HTML.
/// Intenta wkhtmltopdf → weasyprint → fallback a HTML.
fn open_pdf_file(pdf_path: &std::path::Path) {
    let pdf_path_str = pdf_path.to_str().unwrap_or("");
    if pdf_path_str.is_empty() {
        return;
    }

    eprintln!("[pdf] opening PDF: {}", pdf_path.display());

    let result = if std::env::consts::OS == "macos" {
        system_command("open")
            .arg(pdf_path)
            .spawn()
    } else if std::env::consts::OS == "windows" {
        system_command("cmd")
            .args(&["/C", "start", "", pdf_path_str])
            .spawn()
    } else {
        system_command("xdg-open")
            .arg(pdf_path)
            .spawn()
    };

    match result {
        Ok(_) => eprintln!("[pdf] opened PDF successfully"),
        Err(e) => eprintln!("[pdf] failed to open PDF: {}", e),
    }
}

fn tool_generate_pdf(args: &serde_json::Value) -> serde_json::Value {
    let filename = args["filename"].as_str().unwrap_or("documento");
    let html = args["html_content"].as_str().unwrap_or("");

    if html.is_empty() {
        return serde_json::json!({ "error": "No se proporciono contenido HTML" });
    }

    let downloads = dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads"));

    let safe_name: String = filename
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect();
    let safe_name = if safe_name.is_empty() { "documento".to_string() } else { safe_name };

    let html_path = downloads.join(format!(".{}_temp.html", safe_name));
    let pdf_path = downloads.join(format!("{}.pdf", safe_name));

    eprintln!("[pdf] generating PDF via WeasyPrint: {}", pdf_path.display());

    // Asegurar que el HTML tenga charset UTF-8
    let html_with_charset = if html.contains("charset") {
        html.to_string()
    } else if html.contains("<head>") {
        html.replace("<head>", "<head><meta charset=\"UTF-8\">")
    } else {
        format!("<!DOCTYPE html><html><head><meta charset=\"UTF-8\"></head><body>{}</body></html>", html)
    };

    if let Err(e) = std::fs::write(&html_path, &html_with_charset) {
        return serde_json::json!({ "error": format!("Error escribiendo HTML: {}", e) });
    }

    // WeasyPrint: HTML+CSS directo a PDF con calidad profesional
    let python_script = format!(
        "from weasyprint import HTML; HTML(filename=r'{}', encoding='utf-8').write_pdf(r'{}'); import os; os.remove(r'{}'); print('OK')",
        html_path.display(), pdf_path.display(), html_path.display()
    );

    let output = system_command("python3")
        .args(&["-c", &python_script])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if out.status.success() && stdout.trim() == "OK" {
                open_pdf_file(&pdf_path);
                serde_json::json!({
                    "success": true,
                    "path": pdf_path.display().to_string(),
                    "format": "pdf"
                })
            } else {
                let _ = std::fs::remove_file(&html_path);
                eprintln!("[pdf] WeasyPrint error: {}", stderr);
                serde_json::json!({
                    "error": format!("Error generando PDF: {}. Instala dependencias: brew install pango && pip3 install weasyprint", stderr)
                })
            }
        }
        Err(e) => {
            let _ = std::fs::remove_file(&html_path);
            serde_json::json!({"error": format!("python3 no disponible: {}", e)})
        }
    }
}

// ─── Web search & fetch tools ────────────────────────────────────────────────

/// Decodifica entidades HTML básicas.
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&#x2F;", "/")
        .replace("&nbsp;", " ")
}

/// Elimina tags HTML y colapsa whitespace.
fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;
    let lower = html.to_lowercase();
    let chars: Vec<char> = html.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Detectar apertura de <script o <style
        if i + 7 < len && lower_chars[i] == '<' {
            let ahead: String = lower_chars[i..std::cmp::min(i + 8, len)].iter().collect();
            if ahead.starts_with("<script") {
                in_script = true;
                in_tag = true;
                i += 1;
                continue;
            }
            if ahead.starts_with("<style") {
                in_style = true;
                in_tag = true;
                i += 1;
                continue;
            }
        }
        // Detectar cierre </script> o </style>
        if i + 8 < len && lower_chars[i] == '<' && lower_chars[i + 1] == '/' {
            let ahead: String = lower_chars[i..std::cmp::min(i + 10, len)].iter().collect();
            if ahead.starts_with("</script") {
                in_script = false;
                // Saltar hasta >
                while i < len && chars[i] != '>' { i += 1; }
                i += 1;
                continue;
            }
            if ahead.starts_with("</style") {
                in_style = false;
                while i < len && chars[i] != '>' { i += 1; }
                i += 1;
                continue;
            }
        }

        if in_script || in_style {
            i += 1;
            continue;
        }

        if chars[i] == '<' {
            in_tag = true;
            i += 1;
            continue;
        }
        if chars[i] == '>' {
            in_tag = false;
            out.push(' ');
            i += 1;
            continue;
        }
        if !in_tag {
            out.push(chars[i]);
        }
        i += 1;
    }

    // Decodificar entidades y colapsar whitespace
    let decoded = decode_html_entities(&out);
    let mut result = String::with_capacity(decoded.len());
    let mut prev_ws = false;
    for ch in decoded.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                result.push(' ');
                prev_ws = true;
            }
        } else {
            result.push(ch);
            prev_ws = false;
        }
    }
    result.trim().to_string()
}

/// Parsea resultados de DuckDuckGo HTML search.
fn parse_ddg_results(html: &str) -> Vec<serde_json::Value> {
    let mut results = Vec::new();
    let mut search_pos = 0;
    let marker = "class=\"result__a\"";

    while let Some(pos) = html[search_pos..].find(marker) {
        let abs_pos = search_pos + pos;

        // Buscar href antes del marker (retroceder hasta <a)
        let tag_start = html[..abs_pos].rfind("<a").unwrap_or(abs_pos);
        let href = if let Some(href_pos) = html[tag_start..abs_pos + marker.len() + 50].find("href=\"") {
            let href_start = tag_start + href_pos + 6;
            if let Some(href_end) = html[href_start..].find('"') {
                let raw_url = &html[href_start..href_start + href_end];
                // DuckDuckGo wraps URLs — extract actual URL from uddg= param
                if let Some(uddg_pos) = raw_url.find("uddg=") {
                    let url_start = uddg_pos + 5;
                    let url_encoded = if let Some(amp) = raw_url[url_start..].find('&') {
                        &raw_url[url_start..url_start + amp]
                    } else {
                        &raw_url[url_start..]
                    };
                    // Simple URL decode for %XX sequences
                    simple_url_decode(url_encoded)
                } else {
                    raw_url.to_string()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Extraer título: texto entre > y </a> después del marker
        let after_marker = abs_pos + marker.len();
        let title = if let Some(gt) = html[after_marker..].find('>') {
            let text_start = after_marker + gt + 1;
            if let Some(end_a) = html[text_start..].find("</a>") {
                let raw = &html[text_start..text_start + end_a];
                strip_html_tags(raw)
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Buscar snippet
        let snippet_marker = "class=\"result__snippet\"";
        let snippet = if let Some(spos) = html[after_marker..].find(snippet_marker) {
            let snip_abs = after_marker + spos + snippet_marker.len();
            if let Some(gt) = html[snip_abs..].find('>') {
                let text_start = snip_abs + gt + 1;
                // Buscar cierre del tag (</a> o </td> o </div>)
                let end = html[text_start..].find("</a>")
                    .or_else(|| html[text_start..].find("</td>"))
                    .or_else(|| html[text_start..].find("</div>"))
                    .unwrap_or(200.min(html.len() - text_start));
                let raw = &html[text_start..text_start + end];
                strip_html_tags(raw)
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        if !title.is_empty() && !href.is_empty() {
            results.push(serde_json::json!({
                "title": title,
                "url": href,
                "snippet": snippet
            }));
        }

        if results.len() >= 8 {
            break;
        }

        search_pos = after_marker + 1;
        if search_pos >= html.len() {
            break;
        }
    }

    results
}

/// Decodificación URL simple (%XX → char).
fn simple_url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(val) = u8::from_str_radix(
                &s[i + 1..i + 3], 16
            ) {
                result.push(val as char);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

/// Busca en internet usando DuckDuckGo HTML (sin API key).
/// Reintenta hasta 3 veces con backoff exponencial ante fallos transitorios.
fn tool_web_search(args: &serde_json::Value) -> serde_json::Value {
    let query = args["query"].as_str().unwrap_or("");
    if query.is_empty() {
        return serde_json::json!({"error": "Query vacía"});
    }
    let url = format!("https://html.duckduckgo.com/html/?q={}", query.replace(' ', "+"));

    eprintln!("[tool:web_search] query={}", query);

    let mut attempts: u8 = 0;
    let max_attempts: u8 = 3;
    let body: String = loop {
        attempts += 1;
        let curl_result = system_command("curl")
            .args(&[
                "-sL",
                "--max-time", "30",
                "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                &url,
            ])
            .output();

        match curl_result {
            Ok(out) if out.status.success() && !out.stdout.is_empty() => {
                break String::from_utf8_lossy(&out.stdout).to_string();
            }
            _ if attempts < max_attempts => {
                // Backoff exponencial: 500ms, 1500ms, 4500ms
                let delay_ms = 500u64 * 3u64.pow(attempts as u32 - 1);
                eprintln!(
                    "[tool:web_search] intento {}/{} falló, reintentando en {}ms",
                    attempts, max_attempts, delay_ms
                );
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                continue;
            }
            _ => {
                eprintln!("[tool:web_search] agotados {} intentos", max_attempts);
                return serde_json::json!({
                    "error": "La búsqueda web no está disponible temporalmente. Intenta de nuevo en unos segundos.",
                    "results": []
                });
            }
        }
    };

    let results = parse_ddg_results(&body);
    eprintln!("[tool:web_search] found {} results", results.len());

    if results.is_empty() {
        return serde_json::json!({
            "error": "No se encontraron resultados para la búsqueda. Prueba con otras palabras clave o intenta más tarde.",
            "results": [],
            "query": query
        });
    }

    serde_json::json!({"results": results, "query": query})
}

/// Lee el contenido de una página web.
fn tool_web_fetch(args: &serde_json::Value) -> serde_json::Value {
    let url_str = args["url"].as_str().unwrap_or("");
    if url_str.is_empty() {
        return serde_json::json!({"error": "URL vacía"});
    }

    // SSRF guard — reject non-http(s) schemes, localhost, private/link-local IPs,
    // and loopback addresses so the agent cannot pivot into the host's internal
    // network (e.g. 169.254.169.254 metadata, 127.0.0.1, 10/8, 192.168/16).
    let parsed = match reqwest::Url::parse(url_str) {
        Ok(u) => u,
        Err(e) => return serde_json::json!({"error": format!("Invalid URL: {}", e)}),
    };
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return serde_json::json!({
                "error": format!("Only http/https schemes are allowed (got {})", other)
            });
        }
    }
    let host = match parsed.host_str() {
        Some(h) => h,
        None => return serde_json::json!({"error": "URL has no host"}),
    };
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".localhost") {
        return serde_json::json!({"error": "Localhost URLs are not allowed"});
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
            return serde_json::json!({"error": "Restricted IP not allowed"});
        }
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_private() || v4.is_link_local() || v4.is_broadcast() {
                    return serde_json::json!({"error": "Private/link-local IP not allowed"});
                }
            }
            std::net::IpAddr::V6(v6) => {
                // Reject IPv6 loopback, link-local (fe80::/10) and unique-local (fc00::/7).
                let segs = v6.segments();
                let is_link_local = (segs[0] & 0xffc0) == 0xfe80;
                let is_unique_local = (segs[0] & 0xfe00) == 0xfc00;
                if v6.is_loopback() || is_link_local || is_unique_local {
                    return serde_json::json!({"error": "Restricted IPv6 not allowed"});
                }
            }
        }
    }

    let url = url_str;
    eprintln!("[tool:web_fetch] url={}", url);

    let output = system_command("curl")
        .args(&["-sL", "--max-time", "30", "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", url])
        .output();

    match output {
        Ok(out) => {
            let body = String::from_utf8_lossy(&out.stdout).to_string();
            let text = strip_html_tags(&body);
            let total_bytes = text.len();
            // Safe UTF-8 truncation: retrocede hasta el char boundary más cercano.
            let max_bytes = 30_000usize;
            let truncated = if text.len() > max_bytes {
                let mut cut = max_bytes;
                while cut > 0 && !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text[..cut].to_string()
            } else {
                text
            };
            serde_json::json!({"content": truncated, "url": url, "bytes": total_bytes})
        }
        Err(e) => serde_json::json!({"error": format!("Error fetching: {}", e)})
    }
}

/// Retorna el directorio de trabajo actual persistido entre invocaciones de bash
/// para la sesión indicada (`session_key`).
fn tool_get_cwd(session_key: &str, _args: &serde_json::Value) -> serde_json::Value {
    let cwd = CURRENT_CWD
        .lock()
        .ok()
        .and_then(|guard| guard.get(session_key).cloned())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });
    serde_json::json!({ "cwd": cwd })
}

/// Obtiene el historial de sesiones de estudio con resúmenes generados previamente.
fn tool_get_study_history(app: &tauri::AppHandle, args: &serde_json::Value) -> serde_json::Value {
    let limit = args["limit"].as_i64().unwrap_or(5);
    let conn = match open_db(app) {
        Ok(c) => c,
        Err(e) => return serde_json::json!({"error": e}),
    };

    let mut stmt = match conn.prepare(
        "SELECT id, title, summary, created_at FROM chat_sessions \
         WHERE summary IS NOT NULL AND summary != '' \
         ORDER BY created_at DESC LIMIT ?1"
    ) {
        Ok(s) => s,
        Err(e) => return serde_json::json!({"error": e.to_string()}),
    };

    let sessions: Vec<serde_json::Value> = match stmt.query_map(
        rusqlite::params![limit],
        |row| {
            Ok(serde_json::json!({
                "session_id": row.get::<_, i64>(0)?,
                "title": row.get::<_, String>(1).unwrap_or_default(),
                "summary": row.get::<_, String>(2).unwrap_or_default(),
                "date": row.get::<_, String>(3).unwrap_or_default(),
            }))
        }
    ) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    };

    let count = sessions.len();
    serde_json::json!({"sessions": sessions, "count": count})
}

// ─── Hooks: pre/post tool execution ─────────────────────────────────────────
// Adaptado del concepto de hooks de Claude Code.
// En StudyAI (Tauri app), los hooks son funciones Rust que emiten eventos
// al frontend y registran ejecución de tools para debugging/auditoría.

/// Hook que se ejecuta ANTES de cada tool call.
/// Emite un evento al frontend para UI en tiempo real y logea al stderr.
fn pre_tool_hook(
    window: &tauri::Window,
    tool_name: &str,
    args: &serde_json::Value,
) {
    eprintln!("[hook:pre] {} args={}", tool_name, args);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    window.emit("tool-execution-start", serde_json::json!({
        "tool": tool_name,
        "args": args,
        "timestamp": timestamp,
    })).ok();
}

/// Hook que se ejecuta DESPUÉS de cada tool call.
/// Emite evento de completado, logea duración, y persiste en tool_log para auditoría.
fn post_tool_hook(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    tool_name: &str,
    args: &serde_json::Value,
    result: &serde_json::Value,
    duration_ms: u128,
) {
    let is_error = result.get("error").is_some();

    eprintln!("[hook:post] {} completed in {}ms (error={})", tool_name, duration_ms, is_error);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    window.emit("tool-execution-complete", serde_json::json!({
        "tool": tool_name,
        "duration_ms": duration_ms,
        "is_error": is_error,
        "timestamp": timestamp,
    })).ok();

    // Auto-open created files (log only, don't actually open)
    if tool_name == "create_file" && !is_error {
        if let Some(path) = result.get("path").and_then(|p| p.as_str()) {
            eprintln!("[hook:post] Auto-opening created file: {}", path);
        }
    }

    // Persist tool execution to tool_log for debugging/auditing
    if let Ok(conn) = open_db(app) {
        let result_summary = if is_error {
            result.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("error")
                .to_string()
        } else {
            "success".to_string()
        };

        let _ = conn.execute(
            "INSERT INTO tool_log (tool_name, args, result_summary, duration_ms) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                tool_name,
                args.to_string(),
                result_summary,
                duration_ms as i64,
            ],
        );
    }
}

/// Despacha una llamada a tool y retorna el resultado como JSON.
/// `session_key` identifica la sesión de chat para aislar estado como CWD.
/// `active_course_id` es el curso actualmente seleccionado en el chat; se usa
/// para aislar búsquedas por curso (evita fuga de datos cross-course).
fn dispatch_tool(
    app: &tauri::AppHandle,
    session_key: &str,
    name: &str,
    args: &serde_json::Value,
    active_course_id: Option<i64>,
) -> serde_json::Value {
    match name {
        "get_upcoming_deadlines" => tool_get_upcoming_deadlines(app, args),
        "get_announcements" => tool_get_announcements(app, args),
        "create_flashcards" => tool_create_flashcards(args),
        "search_notes" => tool_search_notes(app, args, active_course_id),
        "list_documents" => tool_list_documents(app, args),
        "read_document" => tool_read_document(app, args),
        "run_bash" => tool_run_bash(app, session_key, args),
        "get_cwd" => tool_get_cwd(session_key, args),
        "create_file" => tool_create_file(args),
        "read_file" => tool_read_file(args),
        "list_directory" => tool_list_directory(args),
        "generate_pdf" => tool_generate_pdf(args),
        "web_search" => tool_web_search(args),
        "web_fetch" => tool_web_fetch(args),
        "get_study_history" => tool_get_study_history(app, args),
        other => serde_json::json!({
            "error": format!("Tool desconocida: '{other}'")
        }),
    }
}

// ─── Loop agéntico ────────────────────────────────────────────────────────────

/// Hace UNA llamada a Gemini con streaming.
///
/// Retorna `(parts_del_modelo, tiene_tool_calls)`.
/// - `parts_del_modelo`: las parts acumuladas de la respuesta del modelo
///   (puede mezclar texto y functionCall)
/// - `tiene_tool_calls`: true si hay al menos un functionCall en las parts
///
/// Emite `chat-stream-chunk` durante el streaming de texto.
/// Resultado de una llamada streaming a Gemini.
struct GeminiStreamResult {
    /// Parts del modelo (text y/o functionCalls)
    model_parts: Vec<serde_json::Value>,
    /// true si hay al menos un functionCall
    has_tool_calls: bool,
    /// true si la respuesta fue cortada por max tokens (finishReason MAX_TOKENS o LENGTH)
    was_cut_off: bool,
    /// Si el stream falló después de recibir texto parcial, contiene el error
    stream_error: Option<String>,
}

// ─── Context compaction ──────────────────────────────────────────────────────
// When a conversation gets too long, automatically summarize old messages
// to keep the context window manageable for Gemini.

// ── Compaction constants ───────────────────────────────────────────────────
// Based on Claude Code's compaction architecture (Tengu).
// Gemini 2.5 Flash has a 1M token context window, but we compact much earlier
// to keep latency low and avoid hitting limits on the summary call itself.
//
// Formula: contextWindow=1_048_576, reservedForOutput=min(contextWindow*0.1, 20_000)=20_000
// effectiveWindow = 1_048_576 - 20_000 = 1_028_576
// autoCompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER = 1_028_576 - 13_000 = 1_015_576
//
// However, in practice Gemini's latency degrades well before 1M tokens,
// and our rough char/4 estimator is imprecise, so we use a pragmatic threshold
// that balances context preservation vs performance.
const GEMINI_CONTEXT_WINDOW: usize = 1_048_576;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY: usize = 20_000;
const AUTOCOMPACT_BUFFER_TOKENS: usize = 13_000;
const COMPACTION_KEEP_RECENT: usize = 6; // Keep last 6 messages (3 turns) uncompacted
const MAX_CONSECUTIVE_COMPACT_FAILURES: u8 = 3; // Circuit breaker
const MAX_PTL_RETRIES: u8 = 3; // Max retries when compact itself is too long

fn get_auto_compact_threshold() -> usize {
    let effective_window = GEMINI_CONTEXT_WINDOW - MAX_OUTPUT_TOKENS_FOR_SUMMARY;
    effective_window - AUTOCOMPACT_BUFFER_TOKENS
}

fn estimate_tokens(text: &str) -> usize {
    // Rough approximation: 1 token ~= 4 chars for English/Spanish
    text.len() / 4
}

fn estimate_messages_tokens(messages: &[serde_json::Value]) -> usize {
    messages.iter().map(|m| {
        let parts = m["parts"].as_array();
        parts.map(|p| p.iter().map(|part| {
            part["text"].as_str().map(|t| estimate_tokens(t)).unwrap_or(0)
        }).sum::<usize>()).unwrap_or(0)
    }).sum()
}

/// Extract the <summary> block from a compaction response, discarding <analysis>.
fn extract_compact_summary(raw: &str) -> String {
    // Try to extract <summary>...</summary>
    if let Some(start) = raw.find("<summary>") {
        if let Some(end) = raw.find("</summary>") {
            let inner = &raw[start + "<summary>".len()..end];
            return inner.trim().to_string();
        }
    }
    // Fallback: strip <analysis> block if present and return the rest
    let mut result = raw.to_string();
    if let Some(a_start) = result.find("<analysis>") {
        if let Some(a_end) = result.find("</analysis>") {
            result = format!(
                "{}{}",
                &result[..a_start],
                &result[a_end + "</analysis>".len()..]
            );
        }
    }
    result.trim().to_string()
}

/// The structured 9-section compaction prompt, adapted from Claude Code's Tengu system.
fn build_compact_prompt() -> String {
    r#"CRITICAL: Respond with TEXT ONLY. Do NOT call any tools or functions.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and a summary of why each file/edit is important.
4. Errors and fixes: List all errors encountered and how you fixed them. Include user feedback on errors.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks you have been explicitly asked to work on.
8. Current Work: Describe precisely what was being worked on immediately before this summary request. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step related to the most recent work. IMPORTANT: ensure this step is DIRECTLY in line with the user's most recent explicit requests. Include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off.

Format your response as:
<analysis>
[Your analysis]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [...]

3. Files and Code Sections:
   - [File]: [summary + code snippet]

4. Errors and fixes:
   - [Error]: [fix + user feedback]

5. Problem Solving:
   [Description]

6. All user messages:
   - [Message 1]
   - [...]

7. Pending Tasks:
   - [Task 1]
   - [...]

8. Current Work:
   [Precise description]

9. Optional Next Step:
   [Next step with direct quotes]
</summary>

REMINDER: Respond with plain text only — an <analysis> block followed by a <summary> block. Do NOT call any tools or functions."#.to_string()
}

/// Call Gemini to generate a compaction summary. Returns the raw response text.
async fn call_compact_api(messages_to_summarize: &[serde_json::Value]) -> Result<String, String> {
    let compact_prompt = build_compact_prompt();

    let mut summary_contents = messages_to_summarize.to_vec();
    summary_contents.push(serde_json::json!({
        "role": "user",
        "parts": [{"text": compact_prompt}]
    }));

    let body = serde_json::json!({
        "system_instruction": {
            "parts": [{"text": "You are a summarization assistant. Your only job is to produce a structured summary of the conversation. Never call tools or functions. Respond only with text."}]
        },
        "contents": summary_contents,
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192
        }
    });

    let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Error: {}", e))?;

    let response = client
        .post(url)
        .header("x-goog-api-key", GEMINI_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Compaction API error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        // Check for prompt_too_long specifically
        if body_text.contains("prompt_too_long") || body_text.contains("RESOURCE_EXHAUSTED") || status.as_u16() == 413 {
            return Err(format!("prompt_too_long: {}", body_text));
        }
        return Err(format!("Compaction API error {}: {}", status, body_text));
    }

    let response_json: serde_json::Value = response.json().await
        .map_err(|e| format!("Compaction parse error: {}", e))?;

    let summary_text = response_json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("(resumen no disponible)");

    Ok(summary_text.to_string())
}

/// Compact the conversation context using the structured 9-section prompt.
/// Implements circuit breaker pattern and PTL (prompt-too-long) retry logic.
///
/// `consecutive_failures` is tracked by the caller (agentic_loop) across steps.
async fn compact_context(
    window: &tauri::Window,
    contents: &mut Vec<serde_json::Value>,
    _system_text: &str,
    consecutive_failures: &mut u8,
) -> Result<(), String> {
    // Circuit breaker: stop trying after N consecutive failures
    if *consecutive_failures >= MAX_CONSECUTIVE_COMPACT_FAILURES {
        return Ok(());
    }

    let total_tokens = estimate_messages_tokens(contents);
    let threshold = get_auto_compact_threshold();

    if total_tokens < threshold {
        return Ok(());
    }

    eprintln!(
        "[compact] Context has ~{} tokens (threshold: {}), compacting...",
        total_tokens, threshold
    );
    window
        .emit("chat-stream-thinking", "Compactando contexto (resumen estructurado)...")
        .ok();

    // Split: old messages to compact + recent messages to keep verbatim
    let keep_count = COMPACTION_KEEP_RECENT.min(contents.len());
    let split_point = contents.len() - keep_count;
    let mut messages_to_summarize: Vec<serde_json::Value> = contents[..split_point].to_vec();
    let to_keep: Vec<serde_json::Value> = contents[split_point..].to_vec();

    // PTL retry loop: if the compaction call itself is too long, truncate and retry
    let mut ptl_attempts: u8 = 0;
    let summary_raw = loop {
        match call_compact_api(&messages_to_summarize).await {
            Ok(text) => break text,
            Err(e) if e.starts_with("prompt_too_long") => {
                ptl_attempts += 1;
                if ptl_attempts > MAX_PTL_RETRIES {
                    eprintln!(
                        "[compact] PTL retry exhausted after {} attempts, giving up",
                        ptl_attempts
                    );
                    *consecutive_failures += 1;
                    return Err("Conversation too long to compact even after truncation".into());
                }
                // Drop 20% of the oldest messages and retry
                let drop_count = (messages_to_summarize.len() / 5).max(1);
                eprintln!(
                    "[compact] PTL retry {}: dropping {} oldest messages, {} remaining",
                    ptl_attempts,
                    drop_count,
                    messages_to_summarize.len() - drop_count
                );
                messages_to_summarize = messages_to_summarize[drop_count..].to_vec();
                // Ensure the first message is a user message (Gemini requires it)
                if messages_to_summarize.first()
                    .and_then(|m| m["role"].as_str())
                    != Some("user")
                {
                    messages_to_summarize.insert(0, serde_json::json!({
                        "role": "user",
                        "parts": [{"text": "[earlier conversation truncated for compaction retry]"}]
                    }));
                }
                if messages_to_summarize.len() < 2 {
                    *consecutive_failures += 1;
                    return Err("Not enough messages left to compact after truncation".into());
                }
            }
            Err(e) => {
                eprintln!("[compact] API error: {}", e);
                *consecutive_failures += 1;
                return Err(e);
            }
        }
    };

    // Extract the structured summary, discarding the <analysis> scratchpad
    let summary_text = extract_compact_summary(&summary_raw);
    eprintln!("[compact] Summary extracted: {} chars", summary_text.len());

    if summary_text.is_empty() || summary_text == "(resumen no disponible)" {
        eprintln!("[compact] Empty summary, aborting compaction");
        *consecutive_failures += 1;
        return Err("Empty compaction summary".into());
    }

    // Build the continuation message (adapted from Claude Code's pattern)
    let continuation_text = format!(
        "This session is being continued from a previous conversation that ran out of context. \
The summary below covers the earlier portion of the conversation.\n\n\
Summary:\n{}\n\n\
Recent messages are preserved verbatim.\n\n\
Continue the conversation from where it left off without asking the user any further questions. \
Resume directly -- do not acknowledge the summary, do not recap what was happening, \
do not preface with \"I'll continue\" or similar. \
Pick up the last task as if the break never happened.",
        summary_text
    );

    let summary_message = serde_json::json!({
        "role": "user",
        "parts": [{"text": continuation_text}]
    });

    let summary_ack = serde_json::json!({
        "role": "model",
        "parts": [{"text": "Understood. I have the full context from the summary and the recent messages. Continuing where we left off."}]
    });

    // New contents: summary + ack + recent messages preserved verbatim
    *contents = vec![summary_message, summary_ack];
    contents.extend(to_keep);

    let new_tokens = estimate_messages_tokens(contents);
    eprintln!(
        "[compact] Compacted from ~{} to ~{} tokens (saved ~{})",
        total_tokens,
        new_tokens,
        total_tokens.saturating_sub(new_tokens)
    );

    // Success: reset circuit breaker
    *consecutive_failures = 0;

    Ok(())
}

async fn call_gemini_streaming(
    window: &tauri::Window,
    contents: &[serde_json::Value],
    system_text: &str,
    tool_config: Option<&ToolConfig>,
) -> Result<GeminiStreamResult, String> {
    use futures_util::StreamExt;

    // generationConfig (pdf-flow-fix 2026-04-10):
    // - maxOutputTokens=32768 para soportar HTML grande en `create_file` y
    //   respuestas largas con research+PDF en el mismo turno (antes 8192).
    // - thinkingBudget ya NO se setea a 0. El workaround del bug multi-turn
    //   `thought_signature` solo era necesario cuando forzábamos mode=ANY
    //   sobre generate_pdf. Ahora que PDFs van via flow Unix con AUTO mode,
    //   dejamos que Gemini use thinking default — es safe en AUTO.
    //
    // thinkingConfig (thinking-visible-toggle 2026-04-10):
    // - includeThoughts: true → Gemini emite parts con `thought: true` flag
    //   conteniendo el reasoning del modelo. Se renderizan separados del texto final
    //   en la UI (estilo Claude Code).
    // - thinkingBudget: 8192 → presupuesto razonable para razonamiento sin
    //   sobrecargar latencia. Range 0-24576 para 2.5 Flash.
    //
    // El bloque thinkingConfig es CONDICIONAL según el setting
    // `show_thinking_reasoning` en SQLite (default false). Oculto por defecto
    // porque Gemini 2.5 Flash emite el razonamiento SIEMPRE en inglés, incluso
    // cuando el system_instruction está en español (limitación del modelo,
    // ver adk-python#1312). Los power-users que aceptan esa limitación pueden
    // habilitarlo en Settings → Avanzado.
    //
    // Cuando `show_thinking` es false omitimos `thinkingConfig` por completo;
    // Gemini entonces no emite parts `thought: true` y el SSE parser existente
    // simplemente no entra en la rama de thought.
    let show_thinking = read_setting_bool(window.app_handle(), "show_thinking_reasoning")
        .unwrap_or(false);

    let mut generation_config_value = serde_json::json!({
        "temperature": 1.0,
        "topP": 0.95,
        "topK": 64,
        "maxOutputTokens": 32768
    });

    if show_thinking {
        generation_config_value["thinkingConfig"] = serde_json::json!({
            "includeThoughts": true,
            "thinkingBudget": 8192
        });
    }

    let generation_config = generation_config_value;

    let mut body = serde_json::json!({
        "system_instruction": {
            "parts": [{"text": system_text}]
        },
        "contents": contents,
        "tools": build_tools(),
        "generationConfig": generation_config
    });

    // toolConfig solo va en el body cuando promovemos a ANY.
    // Cuando es None (AUTO), Gemini aplica su default sin el campo.
    if let Some(tc) = tool_config {
        body["toolConfig"] = serde_json::to_value(tc)
            .map_err(|e| format!("Error serializando toolConfig: {e}"))?;
    }

    let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Error al crear cliente HTTP: {e}"))?;

    let response = client
        .post(url)
        .header("x-goog-api-key", GEMINI_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Error al conectar con Gemini: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("Gemini devolvió error {status}: {body_text}"));
    }

    // Acumulamos todas las parts que lleguen en este turn del modelo.
    // Gemini puede entregar partes del mismo text en múltiples chunks SSE,
    // así que agrupamos los textos en una sola part al final.
    let mut accumulated_text = String::new();
    let mut function_calls: Vec<serde_json::Value> = Vec::new();
    let mut has_tool_calls = false;
    let mut was_cut_off = false;

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    let mut stream_error: Option<String> = None;

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                // Task 2: Si ya acumulamos texto, no fallar inmediatamente — guardar error para retry
                if !accumulated_text.is_empty() {
                    eprintln!("[gemini] Error en stream después de acumular {} bytes de texto, intentará retry", accumulated_text.len());
                    stream_error = Some(format!("Error al leer stream: {e}"));
                    break;
                }
                return Err(format!("Error al leer stream: {e}"));
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line[6..];
            if data == "[" || data == "]" || data == "," {
                continue;
            }

            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };

            // Detectar errores inline de Gemini (ej. safety block, quota, etc.)
            if let Some(err) = json.get("error") {
                let msg = err["message"].as_str().unwrap_or("Error desconocido de Gemini");
                return Err(format!("Gemini API error: {msg}"));
            }

            // Detectar promptFeedback.blockReason (safety filter)
            if let Some(reason) = json["promptFeedback"]["blockReason"].as_str() {
                return Err(format!(
                    "Gemini bloqueó la solicitud (razón: {reason}). Intenta reformular tu pregunta."
                ));
            }

            // Inspeccionar parts[] — detectar functionCall AQUÍ, no solo por finishReason
            let parts = &json["candidates"][0]["content"]["parts"];
            if let Some(arr) = parts.as_array() {
                for part in arr {
                    let is_thought = part["thought"].as_bool().unwrap_or(false);
                    if let Some(text) = part["text"].as_str() {
                        if !text.is_empty() {
                            if is_thought {
                                // Thought summary (thinking-visible 2026-04-10):
                                // Emitimos el resumen del razonamiento al frontend
                                // como evento separado. NO se acumula en
                                // `accumulated_text` porque ese string se convierte
                                // en el text-part del historial del modelo — los
                                // thoughts son efímeros y no deben re-enviarse en
                                // el próximo turn (evita confundir al modelo y
                                // ahorra tokens).
                                window.emit("chat-stream-thought", text).ok();
                            } else {
                                // Respuesta regular: streaming al frontend + accumulate
                                window.emit("chat-stream-chunk", text).ok();
                                accumulated_text.push_str(text);
                            }
                        }
                    }
                    if part["functionCall"].is_object() {
                        has_tool_calls = true;
                        function_calls.push(part["functionCall"].clone());
                    }
                }
            }

            // Detectar finishReason anómalo (SAFETY, RECITATION, etc.)
            if let Some(reason) = json["candidates"][0]["finishReason"].as_str() {
                match reason {
                    "STOP" => {} // normal
                    "MAX_TOKENS" | "LENGTH" => {
                        eprintln!("[gemini] finishReason={reason} — respuesta cortada por max tokens");
                        was_cut_off = true;
                    }
                    "SAFETY" => {
                        return Err(
                            "Gemini detuvo la respuesta por filtro de seguridad. Intenta reformular tu pregunta.".into()
                        );
                    }
                    other => {
                        eprintln!("[gemini] finishReason inesperado: {other}");
                    }
                }
            }
        }
    }

    // Procesar datos restantes en el buffer (última línea sin newline final)
    let remaining = buffer.trim().to_string();
    if remaining.starts_with("data: ") {
        let data = &remaining[6..];
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            let parts = &json["candidates"][0]["content"]["parts"];
            if let Some(arr) = parts.as_array() {
                for part in arr {
                    let is_thought = part["thought"].as_bool().unwrap_or(false);
                    if let Some(text) = part["text"].as_str() {
                        if !text.is_empty() {
                            if is_thought {
                                // Thought summary — efímero, no accumulate (ver A.2 arriba)
                                window.emit("chat-stream-thought", text).ok();
                            } else {
                                window.emit("chat-stream-chunk", text).ok();
                                accumulated_text.push_str(text);
                            }
                        }
                    }
                    if part["functionCall"].is_object() {
                        has_tool_calls = true;
                        function_calls.push(part["functionCall"].clone());
                    }
                }
            }
        }
    }

    // Construir las parts del modelo para agregar a contents
    let mut model_parts: Vec<serde_json::Value> = Vec::new();
    if !accumulated_text.is_empty() {
        model_parts.push(serde_json::json!({ "text": accumulated_text }));
    }
    for fc in function_calls {
        model_parts.push(serde_json::json!({ "functionCall": fc }));
    }

    Ok(GeminiStreamResult {
        model_parts,
        has_tool_calls,
        was_cut_off,
        stream_error,
    })
}

/// Guard que garantiza que `chat-stream-done` se emita exactamente una vez
/// al salir del `agentic_loop`, sin importar el path de salida (return, error,
/// panic, fall-through por iteration limit). Patrón defer/RAII.
struct StreamDoneGuard<'a> {
    window: &'a tauri::Window,
    reason: std::cell::Cell<&'static str>,
    fired: std::cell::Cell<bool>,
}

impl<'a> StreamDoneGuard<'a> {
    fn new(window: &'a tauri::Window) -> Self {
        Self {
            window,
            reason: std::cell::Cell::new("error"),
            fired: std::cell::Cell::new(false),
        }
    }
    fn set_reason(&self, reason: &'static str) {
        self.reason.set(reason);
    }
}

impl<'a> Drop for StreamDoneGuard<'a> {
    fn drop(&mut self) {
        if !self.fired.get() {
            self.fired.set(true);
            let reason = self.reason.get();
            let _ = self.window.emit(
                "chat-stream-done",
                serde_json::json!({ "reason": reason }),
            );
        }
    }
}

/// Loop agéntico principal — ejecuta hasta 5 pasos de razonamiento con tools.
///
/// Emite al frontend:
/// - `chat-stream-chunk`    → fragmentos de texto en streaming
/// - `chat-stream-thinking` → estado mientras ejecuta tools
/// - `chat-stream-done`     → señal de fin (emitido por `StreamDoneGuard` en Drop)
/// - `chat-stream-error`    → error con mensaje descriptivo
async fn agentic_loop(
    window: &tauri::Window,
    app: &tauri::AppHandle,
    mut contents: Vec<serde_json::Value>,
    system_text: &str,
    active_course_id: Option<i64>,
    initial_tool_config: Option<ToolConfig>,
) -> Result<(), String> {
    // Guard RAII: garantiza que `chat-stream-done` se emita en TODOS los paths
    // de salida (return temprano, ?, error propagado, panic, fall-through).
    // Por defecto reporta "error"; cada salida exitosa debe llamar set_reason antes.
    let done_guard = StreamDoneGuard::new(window);

    let mut auto_continue_count: u8 = 0;
    const MAX_AUTO_CONTINUES: u8 = 3;
    let mut compact_failures: u8 = 0; // Circuit breaker for compaction

    // Up to ~15 tool steps + up to 3 auto-continues + retries = 20 max iterations.
    // Higher than 10 because Unix PDF flow (research + create_file + run_bash + weasyprint
    // install fallback + open) can consume 10+ steps on its own.
    for step in 0..20_u8 {
        // ── 0. Compact context if too large (with circuit breaker) ─────────
        compact_context(window, &mut contents, system_text, &mut compact_failures).await.ok();

        // ── 1. Llamar Gemini con streaming ──────────────────────────────────
        // toolConfig con mode="ANY" SOLO aplica en el primer step. Después del
        // primer tool call, Gemini debe estar libre para responder texto
        // (si no, el loop se quedaría forzando tool calls indefinidamente).
        let active_tool_config = if step == 0 { initial_tool_config.as_ref() } else { None };
        eprintln!("[agentic] step={step} — llamando Gemini (contents: {} turns, forced_tool={})",
            contents.len(),
            active_tool_config.is_some()
        );
        let result = match call_gemini_streaming(window, &contents, system_text, active_tool_config).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[agentic] step={step} — error en call_gemini_streaming: {e}");
                return Err(e);
            }
        };

        let GeminiStreamResult { model_parts, has_tool_calls, was_cut_off, stream_error } = result;

        // ── 1b. Task 2: Si hubo error de stream con texto parcial, retry una vez ──
        if let Some(err_msg) = stream_error {
            if !model_parts.is_empty() {
                eprintln!("[agentic] step={step} — stream falló con texto parcial, reintentando una vez");
                // Agregar lo que ya se acumuló como turn del modelo
                contents.push(serde_json::json!({
                    "role": "model",
                    "parts": model_parts
                }));
                // Pedir que continúe
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [{"text": "Continúa"}]
                }));
                // Reintentar una vez (sin forced tool_config — ya estamos en retry)
                match call_gemini_streaming(window, &contents, system_text, None).await {
                    Ok(retry_result) => {
                        if !retry_result.model_parts.is_empty() {
                            contents.push(serde_json::json!({
                                "role": "model",
                                "parts": retry_result.model_parts
                            }));
                        }
                        if !retry_result.has_tool_calls {
                            eprintln!("[agentic] step={step} — retry exitoso, emitiendo done");
                            done_guard.set_reason("ok");
                            return Ok(());
                        }
                        // Si el retry tiene tool calls, continúa el loop normalmente
                        // (el turn del modelo ya se agregó arriba)
                        eprintln!("[agentic] step={step} — retry exitoso con tool calls, continuando loop");
                        continue;
                    }
                    Err(retry_err) => {
                        eprintln!("[agentic] step={step} — retry también falló: {retry_err}");
                        return Err(format!("Error en stream (original: {err_msg}, retry: {retry_err})"));
                    }
                }
            } else {
                return Err(err_msg);
            }
        }

        // ── 2. Si no llegaron parts (respuesta vacía), terminar ─────────────
        if model_parts.is_empty() && !has_tool_calls {
            eprintln!("[agentic] step={step} — respuesta vacía, terminando loop");
            done_guard.set_reason("empty");
            break;
        }

        // ── 3. Agregar turn del modelo a contents ───────────────────────────
        contents.push(serde_json::json!({
            "role": "model",
            "parts": model_parts
        }));

        // ── 3b. Task 1: Auto-continue si la respuesta fue cortada por max tokens ──
        if was_cut_off && !has_tool_calls {
            if auto_continue_count < MAX_AUTO_CONTINUES {
                auto_continue_count += 1;
                eprintln!("[chat] Auto-continue #{} (max tokens reached)", auto_continue_count);
                // Agregar mensaje de usuario pidiendo que continúe
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [{"text": "Continúa desde donde te quedaste."}]
                }));
                // NO emitir chat-stream-done — el frontend lo ve como una respuesta continua
                continue;
            } else {
                // Se agotaron los auto-continues: emitir un fragmento visible al
                // usuario para que sepa por qué la respuesta quedó cortada, y
                // salir del loop con estado "truncated".
                eprintln!("[chat] Auto-continues exhausted ({}); emitiendo mensaje final al usuario", MAX_AUTO_CONTINUES);
                let truncation_notice = "\n\n[Respuesta truncada: se alcanzó el límite de continuaciones automáticas. Pídeme que continúe si necesitas más detalle.]";
                window.emit("chat-stream-chunk", truncation_notice).ok();
                done_guard.set_reason("truncated");
                return Ok(());
            }
        }

        // ── 4. Sin tool calls → fin del loop ────────────────────────────────
        if !has_tool_calls {
            eprintln!("[agentic] step={step} — sin tool calls, emitiendo done");
            done_guard.set_reason("ok");
            return Ok(());
        }
        eprintln!("[agentic] step={step} — detectadas tool calls, ejecutando tools");

        // ── 5. Hay tool calls — ejecutar TODOS los functionCalls del turn ───
        // Notificar al frontend que el agente está consultando datos
        window.emit("chat-stream-thinking", "Consultando tus datos...").ok();

        // Recoger los functionCalls del último turn del modelo
        let last_model_turn = match contents.last() {
            Some(c) => c,
            None => {
                eprintln!("[agentic loop] contents vacío al intentar obtener último mensaje");
                break;
            }
        };
        let parts = last_model_turn["parts"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        // Recoger todos los tool calls primero
        let tool_calls: Vec<(String, serde_json::Value)> = parts.iter()
            .filter_map(|part| {
                part["functionCall"].as_object().map(|fc| {
                    let name = fc.get("name").and_then(|n| n.as_str()).unwrap_or("unknown").to_string();
                    let args = fc.get("args").cloned().unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                    (name, args)
                })
            })
            .collect();

        if tool_calls.len() > 1 {
            eprintln!("[agentic] step={step} — ejecutando {} tools en paralelo", tool_calls.len());
        }

        // Emitir thinking messages antes de ejecutar
        for (tool_name, tool_args) in &tool_calls {
            let thinking_msg = match tool_name.as_str() {
                "get_upcoming_deadlines" => "Buscando tus tareas próximas...".to_string(),
                "get_announcements"      => "Leyendo anuncios de tus cursos...".to_string(),
                "create_flashcards"      => "Preparando flashcards...".to_string(),
                "search_notes"           => "Buscando en tus materiales...".to_string(),
                "list_documents" => "Buscando tus documentos...".to_string(),
                "read_document" => {
                    // El tool acepta `query` (nombre/parte del nombre) o `id` (numérico).
                    // Mostramos lo primero que tengamos, con fallback a "documento".
                    let label = tool_args["query"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                        .or_else(|| tool_args["name"].as_str().map(|s| s.to_string()))
                        .or_else(|| tool_args["filename"].as_str().map(|s| s.to_string()))
                        .or_else(|| tool_args["id"].as_i64().map(|n| format!("#{}", n)))
                        .or_else(|| tool_args["id"].as_str().map(|s| s.to_string()))
                        .unwrap_or_else(|| "documento".to_string());
                    format!("Leyendo documento: {}", label)
                },
                "run_bash" => {
                    let cmd = tool_args["command"].as_str().unwrap_or("");
                    format!("Ejecutando: {}", cmd)
                },
                "create_file" => {
                    let path = tool_args["path"].as_str().unwrap_or("");
                    format!("Creando archivo: {}", path)
                },
                "read_file" => {
                    let path = tool_args["path"].as_str().unwrap_or("");
                    format!("Leyendo: {}", path)
                },
                "generate_pdf" => {
                    let filename = tool_args["filename"].as_str().unwrap_or("documento");
                    format!("Generando PDF: {}", filename)
                },
                "list_directory" => {
                    let path = tool_args["path"].as_str().unwrap_or(".");
                    format!("Listando: {}", path)
                },
                "web_search" => {
                    let q = tool_args["query"].as_str().unwrap_or("");
                    format!("Buscando: {}", q)
                },
                "web_fetch" => {
                    let u = tool_args["url"].as_str().unwrap_or("");
                    format!("Leyendo: {}", u)
                },
                "get_study_history" => "Revisando tu historial de estudio...".to_string(),
                _ => "Consultando tus datos...".to_string(),
            };
            window.emit("chat-stream-thinking", &thinking_msg).ok();
        }

        // Ejecutar tools en paralelo usando thread::scope (con hooks pre/post)
        let app_handle = app.clone();
        let window_ref = window.clone();
        // Session key para aislar CWD per-chat (usa el label de la ventana).
        let session_key = window_ref.label().to_string();
        let results: Vec<(String, serde_json::Value)> = std::thread::scope(|s| {
            let handles: Vec<_> = tool_calls.iter().map(|(name, args)| {
                let name = name.clone();
                let args = args.clone();
                let app_ref = &app_handle;
                let win = &window_ref;
                let sess_key = session_key.as_str();
                s.spawn(move || {
                    // Pre-tool hook
                    pre_tool_hook(win, &name, &args);
                    let start_time = std::time::Instant::now();

                    // Execute tool
                    let result = dispatch_tool(app_ref, sess_key, &name, &args, active_course_id);

                    // Post-tool hook
                    let duration_ms = start_time.elapsed().as_millis();
                    post_tool_hook(win, app_ref, &name, &args, &result, duration_ms);

                    (name, result)
                })
            }).collect();

            handles.into_iter().map(|h| {
                match h.join() {
                    Ok(result) => result,
                    Err(panic_info) => {
                        let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                            s.to_string()
                        } else if let Some(s) = panic_info.downcast_ref::<String>() {
                            s.clone()
                        } else {
                            "unknown panic".to_string()
                        };
                        eprintln!("[agentic] Tool thread panicked: {}", panic_msg);
                        ("panicked_tool".to_string(), serde_json::json!({"error": format!("Tool panicked: {}", panic_msg)}))
                    }
                }
            }).collect()
        });

        // Construir tool_response_parts con detección de is_error
        let mut tool_response_parts: Vec<serde_json::Value> = Vec::new();
        for (tool_name, result) in results {
            let result_str = result.to_string();
            eprintln!("[agentic] step={step} — tool '{}' ejecutada, resultado: {} bytes",
                tool_name, result_str.len());

            // Detectar si el resultado es un error
            let is_error = result.get("error").is_some();
            if is_error {
                eprintln!("[tool] {} returned error: {}", tool_name, result["error"]);
            }

            // Truncar resultados muy largos para evitar exceder el contexto de Gemini.
            // Importante: NUNCA cortar a mitad de un codepoint UTF-8 ni producir
            // JSON inválido. Si el resultado ya es JSON válido se pasa tal cual;
            // solo se reemplaza por un placeholder si excede el límite.
            const MAX_TOOL_RESULT_BYTES: usize = 30_000;
            let truncated_result = if result_str.len() <= MAX_TOOL_RESULT_BYTES {
                result
            } else {
                eprintln!(
                    "[agentic] step={step} — truncando resultado de '{}' de {} a {} bytes",
                    tool_name,
                    result_str.len(),
                    MAX_TOOL_RESULT_BYTES
                );
                // `result` ya es serde_json::Value (válido). Generamos un preview
                // textual truncado en un borde UTF-8 seguro.
                let mut cut = MAX_TOOL_RESULT_BYTES;
                while cut > 0 && !result_str.is_char_boundary(cut) {
                    cut -= 1;
                }
                serde_json::json!({
                    "truncated": true,
                    "original_size": result_str.len(),
                    "preview": &result_str[..cut],
                    "note": "Resultado truncado por exceder el límite de contexto."
                })
            };

            // Construir response con marcado de error si aplica
            let response_value = if is_error {
                serde_json::json!({
                    "error": true,
                    "message": truncated_result["error"].as_str().unwrap_or("Error desconocido"),
                    "details": truncated_result
                })
            } else {
                truncated_result
            };

            // CRÍTICO: role "user" para functionResponse (no "function" ni "tool")
            tool_response_parts.push(serde_json::json!({
                "functionResponse": {
                    "name": tool_name,
                    "response": response_value
                }
            }));
        }

        // ── 6. Agregar resultados de tools como turn "user" ─────────────────
        if !tool_response_parts.is_empty() {
            contents.push(serde_json::json!({
                "role": "user",
                "parts": tool_response_parts
            }));
        }

        eprintln!("[agentic] step={step} — tool responses agregadas, continuando loop");

        // Pausa breve entre steps para no saturar la API
        if step < 19 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    // Fin natural del loop (límite de iteraciones alcanzado o respuesta vacía).
    // El StreamDoneGuard se encargará de emitir `chat-stream-done` al salir;
    // aquí solo marcamos el motivo y avisamos al usuario.
    eprintln!("[agentic] loop terminado (iteration limit), emitiendo done vía guard");
    let iteration_notice = "\n\n[Respuesta incompleta: se alcanzó el límite de iteraciones del agente. Pídeme que continúe si necesitas más detalle.]";
    window.emit("chat-stream-chunk", iteration_notice).ok();
    done_guard.set_reason("iteration_limit");
    Ok(())
}

/// Lee un valor de la tabla `settings` por clave.
/// Retorna `None` si la clave no existe o si la tabla aún no está inicializada.
/// Usado por el frontend para leer flags de onboarding, versiones vistas, etc.
#[tauri::command]
fn get_setting(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let conn = open_db(&app)?;
    let result: rusqlite::Result<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get(0),
    );
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Error leyendo setting '{key}': {e}")),
    }
}

/// Escribe (upsert) un valor en la tabla `settings`.
/// Si la clave ya existe, actualiza el valor; si no, inserta una fila nueva.
/// Usado por el frontend para persistir flags de onboarding, versiones, changelogs, etc.
#[tauri::command]
fn set_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("Error escribiendo setting '{key}': {e}"))?;
    Ok(())
}

/// Genera un resumen automático de una sesión de estudio usando Gemini.
/// Se llama al cambiar de sesión o cerrar la app (fire-and-forget desde el frontend).
#[tauri::command]
async fn generate_session_summary(
    app: tauri::AppHandle,
    session_id: i64,
) -> Result<String, String> {
    // 1. Load all messages from the session (scoped so conn is dropped before await)
    let body = {
        let conn = open_db(&app).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT role, content FROM chat_messages WHERE session_id = ?1 ORDER BY created_at"
        ).map_err(|e| e.to_string())?;

        let messages_db: Vec<(String, String)> = stmt.query_map(
            rusqlite::params![session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        ).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

        if messages_db.len() < 3 { return Ok(String::new()); } // Too short to summarize

        // 2. Build context for summary
        let conversation = messages_db.iter()
            .map(|(role, content)| format!("{}: {}", role, content))
            .collect::<Vec<_>>()
            .join("\n");

        // Truncate to ~20K bytes (safe UTF-8 boundary retreat).
        let conv_truncated = if conversation.len() > 20000 {
            let mut cut = 20000usize;
            while cut > 0 && !conversation.is_char_boundary(cut) {
                cut -= 1;
            }
            conversation[..cut].to_string()
        } else {
            conversation
        };

        // 3. Build Gemini request body
        serde_json::json!({
            "contents": [{
                "role": "user",
                "parts": [{"text": format!(
                    "Analiza esta sesion de estudio y genera un resumen estructurado.\n\n\
                    Conversacion:\n{}\n\n\
                    Genera un resumen con EXACTAMENTE este formato:\n\
                    TEMAS: [lista de temas estudiados]\n\
                    EJERCICIOS: [ejercicios resueltos o practicados]\n\
                    DIFICULTADES: [conceptos donde el estudiante tuvo problemas]\n\
                    LOGROS: [que aprendio o completo]\n\
                    SIGUIENTE: [que deberia estudiar despues]\n\
                    \nResponde SOLO con el resumen, sin introduccion.",
                    conv_truncated
                )}]
            }],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 512
            }
        })
    }; // conn and stmt dropped here — safe to await below

    let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;

    let response = client.post(url)
        .header("x-goog-api-key", GEMINI_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send().await.map_err(|e| e.to_string())?;

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let summary = json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str().unwrap_or("").to_string();

    // 4. Save summary to session (new connection after await)
    let conn = open_db(&app).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE chat_sessions SET summary = ?1 WHERE id = ?2",
        rusqlite::params![summary, session_id],
    ).map_err(|e| e.to_string())?;

    eprintln!("[memory] Session {} summary: {} chars", session_id, summary.len());

    Ok(summary)
}

/// Envía mensajes al modelo Gemini 2.5 Flash con loop agéntico en Rust.
///
/// Implementa un loop de hasta 5 pasos: el modelo puede llamar tools reales
/// (consultas SQLite) y continuar generando texto con los resultados.
///
/// # Eventos emitidos al frontend
/// - `chat-stream-chunk`    → payload: String (fragmento de texto en streaming)
/// - `chat-stream-thought`  → payload: String (resumen del razonamiento del modelo, NO va al historial)
/// - `chat-stream-thinking` → payload: String (estado mientras ejecuta tools)
/// - `chat-stream-done`     → señal de fin de respuesta
/// - `chat-stream-error`    → payload: String (mensaje de error)
///
/// # Argumentos
// ─── Async Attachments ───────────────────────────────────────────────────────
// Acumula contexto relevante entre turnos e inyecta al inicio de cada turno.
// Patrón inspirado en Claude Code (LSP async attachments) adaptado para StudyAI:
//   1. Resúmenes de sesiones de estudio recientes
//   2. Tareas próximas (deadlines en los próximos 7 días)
//   3. Anuncios recientes de Canvas (últimos 3 días)

async fn gather_async_attachments(app: &tauri::AppHandle) -> String {
    let mut attachments: Vec<String> = Vec::new();

    if let Ok(conn) = open_db(app) {
        // 1. Resúmenes de sesiones de estudio recientes (últimas 2 con summary)
        if let Ok(mut stmt) = conn.prepare(
            "SELECT title, summary FROM chat_sessions \
             WHERE summary IS NOT NULL AND summary != '' \
             ORDER BY updated_at DESC LIMIT 2",
        ) {
            let summaries: Vec<String> = stmt
                .query_map([], |row| {
                    let title: String = row.get(0).unwrap_or_default();
                    let summary: String = row.get(1).unwrap_or_default();
                    Ok(format!("- {}: {}", title, summary))
                })
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();

            if !summaries.is_empty() {
                attachments.push(format!(
                    "[Sesiones de estudio recientes]\n{}",
                    summaries.join("\n")
                ));
            }
        }

        // 2. Tareas próximas (próximos 7 días)
        if let Ok(mut stmt) = conn.prepare(
            "SELECT title, due_at, course_id FROM assignments \
             WHERE due_at > datetime('now') AND due_at < datetime('now', '+7 days') \
             ORDER BY due_at LIMIT 5",
        ) {
            let deadlines: Vec<String> = stmt
                .query_map([], |row| {
                    let name: String = row.get(0).unwrap_or_default();
                    let due: String = row.get(1).unwrap_or_default();
                    Ok(format!("- {} (vence: {})", name, due))
                })
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();

            if !deadlines.is_empty() {
                attachments.push(format!(
                    "[Tareas proximas (7 dias)]\n{}",
                    deadlines.join("\n")
                ));
            }
        }

        // 3. Anuncios recientes (últimos 3 días)
        if let Ok(mut stmt) = conn.prepare(
            "SELECT title, posted_at FROM announcements \
             WHERE posted_at > datetime('now', '-3 days') \
             ORDER BY posted_at DESC LIMIT 3",
        ) {
            let announcements: Vec<String> = stmt
                .query_map([], |row| {
                    let title: String = row.get(0).unwrap_or_default();
                    let posted: String = row.get(1).unwrap_or_default();
                    Ok(format!("- {} ({})", title, posted))
                })
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();

            if !announcements.is_empty() {
                attachments.push(format!(
                    "[Anuncios recientes de Canvas]\n{}",
                    announcements.join("\n")
                ));
            }
        }
    }

    if attachments.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nCONTEXTO AUTOMATICO:\n{}",
            attachments.join("\n\n")
        )
    }
}

/// - `messages`: historial completo de mensajes (incluye el nuevo mensaje del usuario)
///   Los roles vienen como "user"/"assistant" del frontend; "assistant" se convierte a "model".
/// - `course_context`: contexto opcional del curso activo (nombre, descripción, etc.)
/// - `window`: ventana Tauri que recibirá los eventos de streaming
/// - `app`: handle de la aplicación (para resolver el path de SQLite)
#[tauri::command]
async fn send_chat_message(
    messages: Vec<ChatMessage>,
    course_context: Option<String>,
    active_course_id: Option<i64>,
    images: Vec<ImageData>,
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // ── 1. Construir system prompt ────────────────────────────────────────────
    // Fecha y hora actual en zona horaria de Perú (UTC-5)
    let now_utc = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let now_peru = now_utc as i64 - 5 * 3600; // UTC-5
    let peru_secs = now_peru % 86400;
    let peru_days = now_peru / 86400;
    let hour = peru_secs / 3600;
    let minute = (peru_secs % 3600) / 60;
    // Calcular fecha a partir de epoch
    let days_since_epoch = peru_days;
    let (year, month, day) = epoch_days_to_date(days_since_epoch);
    let days_es = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
    let weekday = ((days_since_epoch + 4) % 7) as usize; // 1970-01-01 fue jueves
    let fecha_peru = format!(
        "{}, {:02}/{:02}/{} {:02}:{:02} (hora Perú, UTC-5)",
        days_es[weekday], day, month, year, hour, minute
    );

    // Detectar intent del último mensaje del usuario (para forzar tool calls)
    let last_user_text = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .unwrap_or("");
    let intent = detect_intent(last_user_text);

    let home_dir = std::env::var("HOME").unwrap_or_else(|_| "/Users".to_string());
    let downloads_dir = format!("{}/Downloads", home_dir);

    let runtime_ctx = RuntimeContext {
        os: std::env::consts::OS.to_string(),
        datetime_peru: fecha_peru,
        home_dir,
        downloads_dir,
        active_course_id,
        active_course_name: None,
        course_context: course_context.clone(),
        user_message_intent: intent,
    };
    let system_text = build_system_prompt(&runtime_ctx);
    let tool_config = build_tool_config(runtime_ctx.user_message_intent);

    // ── 1b. Validar imagenes si existen ────────────────────────────────────────
    for img in &images {
        if img.base64.len() > 4 * 1024 * 1024 {
            return Err("Una imagen es demasiado grande. El tamaño maximo es 4MB.".to_string());
        }
    }

    // ── 2. Convertir mensajes al formato Gemini ───────────────────────────────
    // Gemini usa "model" donde el frontend usa "assistant"
    let last_idx = messages.len().saturating_sub(1);
    let contents: Vec<serde_json::Value> = messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let gemini_role = if m.role == "assistant" { "model" } else { &m.role };
            let mut parts = vec![serde_json::json!({"text": m.content})];

            // Adjuntar imagenes al último mensaje del usuario
            if i == last_idx && m.role == "user" && !images.is_empty() {
                for img in &images {
                    parts.push(serde_json::json!({
                        "inlineData": {
                            "mimeType": img.media_type,
                            "data": img.base64
                        }
                    }));
                }
            }

            serde_json::json!({
                "role": gemini_role,
                "parts": parts
            })
        })
        .collect();

    // ── 3. Async attachments — inyectar contexto automático ─────────────────
    let attachments = gather_async_attachments(&app).await;
    let system_text = format!("{}{}", system_text, attachments);

    // ── 4. Ejecutar el loop agéntico ──────────────────────────────────────────
    eprintln!("[chat] Starting agentic loop with {} turns, system_text: {} chars", contents.len(), system_text.len());

    match agentic_loop(&window, &app, contents, &system_text, active_course_id, tool_config).await {
        Ok(()) => {
            eprintln!("[chat] Agentic loop completed successfully");
        }
        Err(e) => {
            eprintln!("[chat] Agentic loop ERROR: {}", e);
            window.emit("chat-stream-error", &e).ok();
        }
    }

    Ok(())
}

/// Lanza la sincronización Canvas usando el módulo Rust nativo.
///
/// # Argumentos
/// - `canvas_url`: URL base de la instancia Canvas (ej. https://usil.instructure.com)
/// - `token`: Token de acceso a la API de Canvas
/// - `modo`: "metadata" | "download"
/// - `course_id`: ID de curso (solo para modo download — pasa None para all-courses)
/// - `since`: Timestamp ISO8601 para sync incremental (ej. "2026-04-08T00:00:00Z"); None = sync completo
/// - `window`: ventana Tauri que recibirá los eventos "canvas-sync-event"
/// - `app`: handle de la aplicación (para resolver paths)
/// - `sync_state`: estado compartido para evitar sincronizaciones concurrentes
#[tauri::command]
async fn start_canvas_sync(
    canvas_url: String,
    token: String,
    modo: String,
    course_id: Option<i64>,
    since: Option<String>,
    window: tauri::Window,
    app: tauri::AppHandle,
    sync_state: State<'_, SyncState>,
) -> Result<(), String> {
    // ── 1. Evitar sincronizaciones concurrentes ──────────────────────────────
    {
        let mut lock = sync_state
            .handle
            .lock()
            .map_err(|e| format!("Error al obtener lock de sync: {e}"))?;

        if let Some(ref handle) = *lock {
            if !handle.is_finished() {
                return Err("Ya hay una sincronización en curso. Esperá a que termine.".to_string());
            }
        }

        *lock = None;
    }

    // ── 2. Resolver directorio base de descargas ─────────────────────────────
    let base_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.join("downloads"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./studyai-downloads"));

    // ── 3. Lanzar la sincronización en background ────────────────────────────
    let window_clone = window.clone();
    let join_handle = tokio::spawn(async move {
        if let Err(e) = canvas::sync::run_sync(
            canvas_url,
            token,
            modo,
            course_id,
            since,
            base_dir,
            window_clone,
        )
        .await
        {
            eprintln!("[canvas::sync] Error fatal: {e}");
        }
    });

    // ── 4. Guardar el handle para control de concurrencia ───────────────────
    {
        let mut lock = sync_state.handle.lock().unwrap_or_else(|p| p.into_inner());
        *lock = Some(join_handle);
    }

    Ok(())
}

/// Valida un token de Canvas, detecta cambio de usuario, limpia datos si es necesario,
/// y guarda canvas_url, canvas_token y canvas_user_id en settings.
///
/// Lógica:
/// 1. Llama GET /api/v1/users/self → obtiene canvas_user_id
/// 2. Lee canvas_user_id previo de settings
/// 3. Si usuario cambió (prev != "" && prev != nuevo): borra archivos físicos PRIMERO, luego limpia DB
/// 4. Guarda canvas_url, canvas_token, canvas_user_id en settings
/// 5. Retorna { ok, user_changed, canvas_user_id }
#[tauri::command]
async fn validate_and_save_canvas_token(
    app: tauri::AppHandle,
    canvas_url: String,
    canvas_token: String,
) -> Result<serde_json::Value, String> {
    // 1. Validar token contra Canvas API y obtener user JSON
    let user_json = canvas::client::get_current_user(&canvas_url, &canvas_token).await?;

    // Extraer canvas_user_id del campo "id"
    let new_user_id = user_json["id"]
        .as_i64()
        .map(|id| id.to_string())
        .or_else(|| user_json["id"].as_str().map(|s| s.to_string()))
        .ok_or_else(|| "Canvas no retornó un user ID válido".to_string())?;

    // 2. Leer canvas_user_id previo de settings (vacío si no existe)
    let prev_user_id: String = {
        let conn = open_db(&app)?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = 'canvas_user_id'",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap_or_default()
    };

    // 3. Detectar cambio de usuario
    let user_changed = !prev_user_id.is_empty() && prev_user_id != new_user_id;

    if user_changed {
        // PRIMERO: borrar archivos físicos en downloads/ (archivos del usuario anterior)
        let downloads_dir = app
            .path()
            .app_data_dir()
            .map(|p| p.join("downloads"))
            .map_err(|e| format!("No se pudo resolver app_data_dir: {e}"))?;

        if downloads_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&downloads_dir) {
                // No abortar — solo loguear y continuar
                log::warn!("Error borrando downloads al cambiar usuario: {}", e);
            }
        }

        // DESPUÉS: limpiar DB en orden correcto (hijos antes que padres)
        // Deshabilitamos FK constraints durante el cleanup para evitar errores
        // de FK al borrar en lote — los rehabilitamos al terminar.
        let conn = open_db(&app)?;
        conn.execute("PRAGMA foreign_keys = OFF", [])
            .map_err(|e| format!("Error deshabilitando FK: {e}"))?;
        // Tablas hijas primero
        conn.execute("DELETE FROM index_jobs", [])
            .map_err(|e| format!("Error limpiando index_jobs: {e}"))?;
        conn.execute("DELETE FROM document_chunks", [])
            .map_err(|e| format!("Error limpiando document_chunks: {e}"))?;
        conn.execute("DELETE FROM documents", [])
            .map_err(|e| format!("Error limpiando documents: {e}"))?;
        conn.execute("DELETE FROM assignments", [])
            .map_err(|e| format!("Error limpiando assignments: {e}"))?;
        conn.execute("DELETE FROM announcements", [])
            .map_err(|e| format!("Error limpiando announcements: {e}"))?;
        conn.execute("DELETE FROM chat_messages", [])
            .map_err(|e| format!("Error limpiando chat_messages: {e}"))?;
        conn.execute("DELETE FROM chat_sessions", [])
            .map_err(|e| format!("Error limpiando chat_sessions: {e}"))?;
        conn.execute("DELETE FROM student_memory", [])
            .map_err(|e| format!("Error limpiando student_memory: {e}"))?;
        conn.execute("DELETE FROM tool_log", [])
            .map_err(|e| format!("Error limpiando tool_log: {e}"))?;
        conn.execute("DELETE FROM sync_jobs", [])
            .map_err(|e| format!("Error limpiando sync_jobs: {e}"))?;
        // Tabla padre al final
        conn.execute("DELETE FROM courses", [])
            .map_err(|e| format!("Error limpiando courses: {e}"))?;
        conn.execute("PRAGMA foreign_keys = ON", [])
            .map_err(|e| format!("Error rehabilitando FK: {e}"))?;
    }

    // 4. Normalizar URL y guardar settings
    let normalized_url = canvas_url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();

    let conn = open_db(&app)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('canvas_url', ?1)",
        rusqlite::params![normalized_url],
    ).map_err(|e| format!("Error guardando canvas_url: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('canvas_token', ?1)",
        rusqlite::params![canvas_token.trim()],
    ).map_err(|e| format!("Error guardando canvas_token: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('canvas_user_id', ?1)",
        rusqlite::params![new_user_id],
    ).map_err(|e| format!("Error guardando canvas_user_id: {e}"))?;

    // 5. Retornar resultado
    Ok(serde_json::json!({
        "ok": true,
        "user_changed": user_changed,
        "canvas_user_id": new_user_id,
        "user": user_json
    }))
}

/// Verifica un token de Canvas haciendo un request HTTP desde Rust (no desde el webview).
///
/// Necesario porque Tauri 2 bloquea `fetch()` a dominios externos desde el webview por defecto.
///
/// # Argumentos
/// - `canvas_url`: URL base de la instancia Canvas (ej. "usil.instructure.com" o "https://usil.instructure.com")
/// - `token`: Token de acceso personal de Canvas
///
/// # Retorna
/// El objeto JSON del usuario de Canvas (`/api/v1/users/self`) en caso de éxito,
/// o un error descriptivo en caso de fallo.
#[tauri::command]
async fn verify_canvas_token(
    canvas_url: String,
    token: String,
) -> Result<serde_json::Value, String> {
    // Normalizar URL — quitar protocolo y trailing slash
    let base = canvas_url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');

    let url = format!("https://{}/api/v1/users/self", base);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if response.status() == 401 {
        return Err("Token inválido o expirado".to_string());
    }

    if !response.status().is_success() {
        return Err(format!("Error del servidor: {}", response.status()));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

/// Abre un archivo del curso: si ya está en disco lo abre directamente,
/// si no lo descarga primero al directorio de datos de la app y luego lo abre.
///
/// # Retorna
/// El path local del archivo (para que el frontend lo guarde en SQLite).
#[tauri::command]
async fn open_or_download_file(
    canvas_file_id: i64,
    title: String,
    download_url: Option<String>,
    file_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    // ── 1. Si ya hay path local y el archivo existe → abrir directamente ──
    if let Some(ref path_str) = file_path {
        let path = std::path::Path::new(path_str);
        if path.exists() {
            app.opener()
                .open_path(path_str, None::<&str>)
                .map_err(|e| format!("No se pudo abrir el archivo: {e}"))?;
            return Ok(path_str.clone());
        }
    }

    // ── 2. Necesita descargar — verificar que tenemos URL ─────────────────
    let url = download_url.ok_or_else(|| {
        "No hay URL de descarga disponible. Re-sincroniza para obtenerla.".to_string()
    })?;

    // ── 3. Construir path de destino ──────────────────────────────────────
    let downloads_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.join("downloads"))
        .map_err(|e| format!("No se pudo resolver el directorio de datos: {e}"))?;

    std::fs::create_dir_all(&downloads_dir)
        .map_err(|e| format!("No se pudo crear el directorio de descargas: {e}"))?;

    // Sanitizar el nombre de archivo: reemplazar caracteres problemáticos
    let safe_name = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect::<String>();

    // Añadir canvas_file_id como prefijo para evitar colisiones de nombres
    let filename = format!("{}_{}", canvas_file_id, safe_name);
    let dest_path = downloads_dir.join(&filename);

    // ── 4. Descargar el archivo con reqwest ───────────────────────────────
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Error al descargar el archivo: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Error HTTP al descargar: {}",
            response.status()
        ));
    }

    // Obtener tamaño total para calcular progreso (puede ser None si no hay Content-Length)
    let total_bytes = response.content_length();

    // Escribir el archivo en disco usando streaming para no cargar todo en memoria
    let mut file = std::fs::File::create(&dest_path)
        .map_err(|e| format!("No se pudo crear el archivo en disco: {e}"))?;

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Error al leer chunk de descarga: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Error al escribir en disco: {e}"))?;
        downloaded += chunk.len() as u64;

        // Emitir progreso si conocemos el tamaño total
        if let Some(total) = total_bytes {
            if total > 0 {
                let _percent = (downloaded * 100 / total) as u32;
                // Progreso disponible para futura integración de eventos
            }
        }
    }

    // ── 5. Abrir el archivo con la app del sistema ────────────────────────
    let dest_str = dest_path
        .to_str()
        .ok_or_else(|| "El path del archivo contiene caracteres inválidos".to_string())?
        .to_string();

    app.opener()
        .open_path(&dest_str, None::<&str>)
        .map_err(|e| format!("Archivo descargado pero no se pudo abrir: {e}"))?;

    Ok(dest_str)
}

/// Verifica assignments de Canvas con due_at próximo y envía notificaciones nativas.
/// - Solo notifica si `deadline_notifications_enabled` = "true" en settings.
/// - El lookahead en horas se lee de `deadline_lookahead_hours` (default 24h).
/// - Marca `notified = 1` en la fila para evitar notificaciones repetidas.
/// - Retorna la cantidad de notificaciones enviadas.
#[tauri::command]
fn check_upcoming_deadlines(app: tauri::AppHandle) -> Result<u32, String> {
    use tauri_plugin_notification::NotificationExt;

    let conn = open_db(&app)?;

    // Leer si las notificaciones están habilitadas
    let enabled: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'deadline_notifications_enabled'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "true".to_string());

    if enabled != "true" {
        return Ok(0);
    }

    // Leer lookahead en horas
    let lookahead_hours: i64 = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'deadline_lookahead_hours'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "24".to_string())
        .parse()
        .unwrap_or(24);

    // Buscar assignments no notificados con due_at dentro del lookahead
    let mut stmt = conn
        .prepare(
            "SELECT id, title, due_at FROM assignments
             WHERE due_at IS NOT NULL
               AND notified = 0
               AND deleted_at IS NULL
               AND datetime(due_at) > datetime('now')
               AND datetime(due_at) <= datetime('now', ?1)",
        )
        .map_err(|e| format!("Error preparando query de deadlines: {e}"))?;

    let lookahead_param = format!("+{} hours", lookahead_hours);

    struct AssignmentRow {
        id: i64,
        title: String,
        due_at: String,
    }

    let rows: Vec<AssignmentRow> = stmt
        .query_map(rusqlite::params![lookahead_param], |row| {
            Ok(AssignmentRow {
                id: row.get(0)?,
                title: row.get(1)?,
                due_at: row.get(2)?,
            })
        })
        .map_err(|e| format!("Error ejecutando query de deadlines: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut sent: u32 = 0;

    for assignment in &rows {
        // Formatear la fecha para el cuerpo de la notificación
        let body = format!("Entrega: {}", assignment.due_at);

        let result = app
            .notification()
            .builder()
            .title(&assignment.title)
            .body(&body)
            .show();

        if result.is_ok() {
            // Marcar como notificado para no repetir
            let _ = conn.execute(
                "UPDATE assignments SET notified = 1 WHERE id = ?1",
                rusqlite::params![assignment.id],
            );
            sent += 1;
        }
    }

    Ok(sent)
}

/// Lee la preferencia de almacenamiento de PDFs desde settings.
/// Retorna { preference: "db_only" | "local_folder" | "", path: Option<String> }
#[tauri::command]
async fn get_storage_preference(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let conn = open_db(&app)?;

    let preference: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'storage_preference'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_default();

    let path: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'download_path'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .filter(|v| !v.is_empty());

    Ok(serde_json::json!({
        "preference": preference,
        "path": path
    }))
}

/// Guarda la preferencia de almacenamiento de PDFs en settings.
/// preference: "db_only" | "local_folder"
/// path: requerido si preference == "local_folder"
#[tauri::command]
async fn set_storage_preference(
    app: tauri::AppHandle,
    preference: String,
    path: Option<String>,
) -> Result<(), String> {
    if preference != "db_only" && preference != "local_folder" {
        return Err(format!(
            "Preferencia inválida: '{}'. Debe ser 'db_only' o 'local_folder'.",
            preference
        ));
    }

    if preference == "local_folder" && path.as_deref().unwrap_or("").is_empty() {
        return Err("Se requiere 'path' cuando la preferencia es 'local_folder'.".to_string());
    }

    let conn = open_db(&app)?;

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('storage_preference', ?1)",
        rusqlite::params![preference],
    )
    .map_err(|e| format!("Error guardando storage_preference: {e}"))?;

    if preference == "local_folder" {
        if let Some(ref p) = path {
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('download_path', ?1)",
                rusqlite::params![p],
            )
            .map_err(|e| format!("Error guardando download_path: {e}"))?;
        }
    }

    eprintln!("[storage] Preferencia guardada: {} / path={:?}", preference, path);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Plugin para abrir URLs y archivos en el sistema operativo
        .plugin(tauri_plugin_opener::init())
        // Plugin Store — almacenamiento clave-valor persistente
        .plugin(tauri_plugin_store::Builder::default().build())
        // Plugin Deep Link — intercepta studiai://auth/callback del OAuth de Google
        .plugin(tauri_plugin_deep_link::init())
        // Plugin Updater — auto-update con firma criptográfica
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Plugin Process — relaunch después de instalar update
        .plugin(tauri_plugin_process::init())
        // Plugin Notification — notificaciones nativas del SO (Pomodoro + deadlines)
        .plugin(tauri_plugin_notification::init())
        // Plugin Dialog — selector de archivos/carpetas nativo del SO
        .plugin(tauri_plugin_dialog::init())
        // Plugin SQL — SQLite con migraciones automáticas al iniciar
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:studyai.db", db::get_migrations())
                .build(),
        )
        // Estado compartido para control de concurrencia del sync
        .manage(SyncState {
            handle: Mutex::new(None),
        })
        // Estado compartido para el loop de indexado background
        .manage(IndexState::default())
        // Configurar FTS5 una vez que la app arrancó (las migraciones del plugin SQL ya corrieron)
        .setup(|app| {
            setup_fts5(&app.handle());
            // Crash recovery al inicio — limpiar jobs "running" de sesiones anteriores
            recover_crashed_jobs(&app.handle());
            // Auto-iniciar indexado background con delay de 5s para que el frontend esté listo
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                // Notificar al frontend para que llame start_background_index con activeCourseId
                let _ = handle2.emit("index-bg-autostart", ());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_device_fingerprint,
            get_trust_mode,
            get_setting,
            set_setting,
            start_canvas_sync,
            verify_canvas_token,
            validate_and_save_canvas_token,
            open_or_download_file,
            send_chat_message,
            resize_image_base64,
            index_document,
            start_background_index,
            pause_background_index,
            cancel_background_index,
            get_index_status,
            generate_session_summary,
            check_upcoming_deadlines,
            get_storage_preference,
            set_storage_preference
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar la aplicación tauri");
}
