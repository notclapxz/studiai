// db.rs — Inicialización de la base de datos SQLite para StudyAI
// Se encarga de crear todas las tablas necesarias al iniciar la aplicación

use tauri_plugin_sql::{Migration, MigrationKind};

/// Retorna todas las migraciones de la base de datos.
/// Tauri SQL plugin ejecuta estas migraciones en orden al iniciar la app.
pub fn get_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "crear_tablas_iniciales",
            sql: "
                -- Configuración de la app (canvas_url, canvas_token, etc.)
                CREATE TABLE IF NOT EXISTS settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                -- Cursos sincronizados desde Canvas LMS
                CREATE TABLE IF NOT EXISTS courses (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  canvas_id INTEGER UNIQUE NOT NULL,
                  name TEXT NOT NULL,
                  code TEXT,
                  semester TEXT,
                  synced_at TEXT
                );

                -- Documentos/PDFs descargados de Canvas
                CREATE TABLE IF NOT EXISTS documents (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  course_id INTEGER REFERENCES courses(id),
                  canvas_file_id INTEGER,
                  title TEXT NOT NULL,
                  file_path TEXT,
                  file_type TEXT,
                  content_text TEXT,
                  has_embeddings INTEGER DEFAULT 0,
                  synced_at TEXT,
                  created_at TEXT DEFAULT (datetime('now'))
                );

                -- Chunks de texto para RAG (embeddings guardados como JSON)
                CREATE TABLE IF NOT EXISTS document_chunks (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
                  chunk_index INTEGER,
                  content TEXT NOT NULL,
                  embedding TEXT,
                  created_at TEXT DEFAULT (datetime('now'))
                );

                -- Tareas/entregas de Canvas
                CREATE TABLE IF NOT EXISTS assignments (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  course_id INTEGER REFERENCES courses(id),
                  canvas_id INTEGER UNIQUE NOT NULL,
                  title TEXT NOT NULL,
                  description TEXT,
                  due_at TEXT,
                  points_possible REAL,
                  submitted INTEGER DEFAULT 0,
                  score REAL,
                  grade TEXT,
                  workflow_state TEXT,
                  created_at TEXT DEFAULT (datetime('now'))
                );

                -- Anuncios del curso en Canvas
                CREATE TABLE IF NOT EXISTS announcements (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  course_id INTEGER REFERENCES courses(id),
                  canvas_id INTEGER UNIQUE NOT NULL,
                  title TEXT NOT NULL,
                  content TEXT,
                  posted_at TEXT,
                  seen INTEGER DEFAULT 0,
                  created_at TEXT DEFAULT (datetime('now'))
                );

                -- Sesiones de chat con el asistente IA
                CREATE TABLE IF NOT EXISTS chat_sessions (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  course_id INTEGER REFERENCES courses(id),
                  title TEXT,
                  created_at TEXT DEFAULT (datetime('now'))
                );

                -- Mensajes individuales dentro de una sesión de chat
                CREATE TABLE IF NOT EXISTS chat_messages (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
                  role TEXT NOT NULL,
                  content TEXT NOT NULL,
                  tokens_used INTEGER,
                  model_used TEXT,
                  created_at TEXT DEFAULT (datetime('now'))
                );

                -- Memoria persistente del agente IA sobre el estudiante
                CREATE TABLE IF NOT EXISTS student_memory (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  memory_type TEXT NOT NULL,
                  content TEXT NOT NULL,
                  updated_at TEXT DEFAULT (datetime('now'))
                );

                -- Registro de trabajos de sincronización con Canvas
                CREATE TABLE IF NOT EXISTS sync_jobs (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  status TEXT DEFAULT 'pending',
                  job_type TEXT,
                  started_at TEXT,
                  completed_at TEXT,
                  error_message TEXT,
                  items_processed INTEGER DEFAULT 0,
                  created_at TEXT DEFAULT (datetime('now'))
                );
            ",
            kind: MigrationKind::Up,
        },
        // Migración 2: agregar download_url a documents
        // ALTER TABLE ADD COLUMN es safe en SQLite — no afecta datos existentes
        Migration {
            version: 2,
            description: "agregar_download_url_a_documents",
            sql: "ALTER TABLE documents ADD COLUMN download_url TEXT;",
            kind: MigrationKind::Up,
        },
        // Migración 3: FTS5 para búsqueda de contenido de PDFs indexados
        Migration {
            version: 3,
            description: "fts5_pdf_search",
            sql: "
                -- Columna para detectar PDFs escaneados (sin texto extraíble)
                -- Ignorar error si ya existe (SQLite no tiene IF NOT EXISTS en ALTER TABLE)
                ALTER TABLE documents ADD COLUMN is_scanned INTEGER DEFAULT 0;
            ",
            kind: MigrationKind::Up,
        },
        // Migración 4: Cola de trabajos de indexado background
        Migration {
            version: 4,
            description: "index_jobs_queue",
            sql: "
                CREATE TABLE IF NOT EXISTS index_jobs (
                  id              INTEGER PRIMARY KEY AUTOINCREMENT,
                  document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                  status          TEXT NOT NULL DEFAULT 'pending',
                  priority        INTEGER NOT NULL DEFAULT 100,
                  attempt_count   INTEGER NOT NULL DEFAULT 0,
                  error_message   TEXT,
                  created_at      TEXT DEFAULT (datetime('now')),
                  updated_at      TEXT DEFAULT (datetime('now')),
                  started_at      TEXT,
                  completed_at    TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_index_jobs_queue
                  ON index_jobs (status, priority ASC, created_at ASC);

                CREATE INDEX IF NOT EXISTS idx_index_jobs_document_id
                  ON index_jobs (document_id);
            ",
            kind: MigrationKind::Up,
        },
        // Migracion 5: Cache de licencia para modo offline
        Migration {
            version: 5,
            description: "license_cache_settings",
            sql: "
                INSERT OR IGNORE INTO settings (key, value) VALUES ('license_status', 'trial');
                INSERT OR IGNORE INTO settings (key, value) VALUES ('license_checked_at', '');
                INSERT OR IGNORE INTO settings (key, value) VALUES ('days_remaining', '14');
            ",
            kind: MigrationKind::Up,
        },
        // Migración 6: Metadatos de sesión — message_count, token_count, updated_at
        // Permite mostrar mejor info en el sidebar y ordenar por actividad reciente
        Migration {
            version: 6,
            description: "session_metadata_columns",
            sql: "
                ALTER TABLE chat_sessions ADD COLUMN message_count INTEGER DEFAULT 0;
                ALTER TABLE chat_sessions ADD COLUMN token_count INTEGER DEFAULT 0;
                ALTER TABLE chat_sessions ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));
            ",
            kind: MigrationKind::Up,
        },
        // Migración 7: Columna summary en chat_sessions para memoria de sesiones de estudio
        // Almacena un resumen generado por IA al finalizar cada sesión
        Migration {
            version: 7,
            description: "session_summary_column",
            sql: "ALTER TABLE chat_sessions ADD COLUMN summary TEXT;",
            kind: MigrationKind::Up,
        },
        // Migración 8: Log de ejecución de tools del loop agéntico
        // Para debugging, auditoría y monitoreo de performance de herramientas
        Migration {
            version: 8,
            description: "tool_execution_log",
            sql: "
                CREATE TABLE IF NOT EXISTS tool_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool_name TEXT NOT NULL,
                    args TEXT,
                    result_summary TEXT,
                    duration_ms INTEGER,
                    created_at TEXT DEFAULT (datetime('now'))
                );
            ",
            kind: MigrationKind::Up,
        },
        // Migración 9: Deduplicar documentos y re-indexar PDFs escaneados sin chunks
        Migration {
            version: 9,
            description: "dedup_documents_and_reindex_scanned",
            sql: "
                -- 1. Eliminar chunks huérfanos de documentos duplicados (conservar el de menor ID por title+course_id)
                DELETE FROM document_chunks WHERE document_id IN (
                    SELECT d.id FROM documents d
                    WHERE d.id NOT IN (
                        SELECT MIN(d2.id) FROM documents d2 GROUP BY d2.title, d2.course_id
                    )
                );

                -- 2. Eliminar index_jobs huérfanos de documentos duplicados
                DELETE FROM index_jobs WHERE document_id IN (
                    SELECT d.id FROM documents d
                    WHERE d.id NOT IN (
                        SELECT MIN(d2.id) FROM documents d2 GROUP BY d2.title, d2.course_id
                    )
                );

                -- 3. Eliminar los documentos duplicados
                DELETE FROM documents WHERE id NOT IN (
                    SELECT MIN(id) FROM documents GROUP BY title, course_id
                );

                -- 4. Agregar índice UNIQUE para prevenir futuros duplicados
                CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_title_course
                    ON documents (title, course_id);

                -- 5. Re-indexar PDFs escaneados que tienen 0 chunks (OCR pendiente)
                UPDATE index_jobs SET status='pending', attempt_count=0, error_message=NULL, updated_at=datetime('now')
                WHERE document_id IN (
                    SELECT d.id FROM documents d
                    WHERE d.is_scanned = 1
                    AND (SELECT COUNT(*) FROM document_chunks dc WHERE dc.document_id = d.id) = 0
                )
                AND status IN ('done', 'failed');
            ",
            kind: MigrationKind::Up,
        },
        // Migración 10: Encolar PDFs escaneados sin fila en index_jobs
        // La migración 9 sólo actualizaba filas EXISTENTES en index_jobs para los scanned.
        // Documentos marcados is_scanned=1 antes de que existiera la cola (o que crasharon
        // antes de insertar su job) nunca volvían a encolarse. Este INSERT OR IGNORE es
        // idempotente y sólo inserta para documentos escaneados con 0 chunks y sin job.
        Migration {
            version: 10,
            description: "queue_scanned_pdfs_without_jobs",
            sql: "
                INSERT OR IGNORE INTO index_jobs (document_id, status, priority, created_at, updated_at)
                SELECT d.id, 'pending', 100, datetime('now'), datetime('now')
                FROM documents d
                LEFT JOIN index_jobs j ON j.document_id = d.id
                WHERE d.is_scanned = 1
                  AND (SELECT COUNT(*) FROM document_chunks dc WHERE dc.document_id = d.id) = 0
                  AND j.id IS NULL;
            ",
            kind: MigrationKind::Up,
        },
        // Migración 11 — Bloque F del audit-fixes-2026-04: DB integrity consolidada
        //
        // Esta migración consolida los siguientes fixes del audit:
        //   F.1 — Índices faltantes para columnas consultadas con frecuencia
        //   F.2 — ON DELETE CASCADE en FKs de course_id (documents, assignments,
        //         announcements, chat_sessions). SQLite no permite ALTER TABLE para
        //         agregar constraints → requiere rebuild completo de cada tabla.
        //   F.3 — Columna `deleted_at TEXT NULL` en assignments y announcements
        //         (carry-over del Bloque E para soft-delete de Canvas sync).
        //   F.4 — UNIQUE parcial en documents.canvas_file_id (dedupe antes del índice).
        //   F.5 — Cleanup one-time de sync_jobs y tool_log > 30 días (TTL).
        //
        // GOTCHA DE TRANSACCIÓN + PRAGMA foreign_keys:
        // tauri-plugin-sql envuelve cada migración en una transacción. SQLite ignora
        // silenciosamente `PRAGMA foreign_keys = OFF` dentro de una transacción.
        // Para rebuild de tablas con FKs pendientes durante el proceso usamos
        // `PRAGMA defer_foreign_keys = ON` que SÍ funciona dentro de transacción:
        // difiere la verificación de FKs hasta el COMMIT. Al final de la migración
        // todas las FKs deben quedar satisfechas porque DROP + CREATE mantiene los
        // mismos nombres de tabla y los mismos IDs (INSERT ... SELECT * copia todo).
        //
        // TRIGGERS FTS5: los triggers en document_chunks (chunks_fts_*) NO referencian
        // ninguna de las tablas que se reconstruyen aquí, por lo que no requieren
        // recreación. La tabla document_chunks queda intacta.
        Migration {
            version: 11,
            description: "db_integrity_fixes_cascade_indexes_ttl",
            sql: "
                -- ─── Defer FK checks hasta commit (funciona dentro de transacción) ───
                PRAGMA defer_foreign_keys = ON;

                -- ══════════════════════════════════════════════════════════════════
                -- F.2 — Rebuild `documents` con ON DELETE CASCADE en course_id
                -- ══════════════════════════════════════════════════════════════════
                -- Preserva TODAS las columnas de migraciones 1, 2, 3 en orden exacto.
                CREATE TABLE documents_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER,
                    canvas_file_id INTEGER,
                    title TEXT NOT NULL,
                    file_path TEXT,
                    file_type TEXT,
                    content_text TEXT,
                    has_embeddings INTEGER DEFAULT 0,
                    synced_at TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    download_url TEXT,
                    is_scanned INTEGER DEFAULT 0,
                    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
                );

                INSERT INTO documents_new (
                    id, course_id, canvas_file_id, title, file_path, file_type,
                    content_text, has_embeddings, synced_at, created_at,
                    download_url, is_scanned
                )
                SELECT
                    id, course_id, canvas_file_id, title, file_path, file_type,
                    content_text, has_embeddings, synced_at, created_at,
                    download_url, is_scanned
                FROM documents;

                DROP TABLE documents;
                ALTER TABLE documents_new RENAME TO documents;

                -- Recrear el índice UNIQUE que fue creado en migración 9
                CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_title_course
                    ON documents (title, course_id);

                -- ══════════════════════════════════════════════════════════════════
                -- F.2 + F.3 — Rebuild `assignments` con CASCADE + deleted_at
                -- ══════════════════════════════════════════════════════════════════
                CREATE TABLE assignments_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER,
                    canvas_id INTEGER UNIQUE NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    due_at TEXT,
                    points_possible REAL,
                    submitted INTEGER DEFAULT 0,
                    score REAL,
                    grade TEXT,
                    workflow_state TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    deleted_at TEXT,
                    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
                );

                INSERT INTO assignments_new (
                    id, course_id, canvas_id, title, description, due_at,
                    points_possible, submitted, score, grade, workflow_state, created_at
                )
                SELECT
                    id, course_id, canvas_id, title, description, due_at,
                    points_possible, submitted, score, grade, workflow_state, created_at
                FROM assignments;

                DROP TABLE assignments;
                ALTER TABLE assignments_new RENAME TO assignments;

                -- ══════════════════════════════════════════════════════════════════
                -- F.2 + F.3 — Rebuild `announcements` con CASCADE + deleted_at
                -- ══════════════════════════════════════════════════════════════════
                CREATE TABLE announcements_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER,
                    canvas_id INTEGER UNIQUE NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT,
                    posted_at TEXT,
                    seen INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now')),
                    deleted_at TEXT,
                    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
                );

                INSERT INTO announcements_new (
                    id, course_id, canvas_id, title, content, posted_at, seen, created_at
                )
                SELECT
                    id, course_id, canvas_id, title, content, posted_at, seen, created_at
                FROM announcements;

                DROP TABLE announcements;
                ALTER TABLE announcements_new RENAME TO announcements;

                -- ══════════════════════════════════════════════════════════════════
                -- F.2 — Rebuild `chat_sessions` con CASCADE en course_id
                -- ══════════════════════════════════════════════════════════════════
                -- Preserva columnas de migraciones 1, 6 y 7.
                CREATE TABLE chat_sessions_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER,
                    title TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    message_count INTEGER DEFAULT 0,
                    token_count INTEGER DEFAULT 0,
                    updated_at TEXT DEFAULT (datetime('now')),
                    summary TEXT,
                    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
                );

                INSERT INTO chat_sessions_new (
                    id, course_id, title, created_at,
                    message_count, token_count, updated_at, summary
                )
                SELECT
                    id, course_id, title, created_at,
                    message_count, token_count, updated_at, summary
                FROM chat_sessions;

                DROP TABLE chat_sessions;
                ALTER TABLE chat_sessions_new RENAME TO chat_sessions;

                -- ══════════════════════════════════════════════════════════════════
                -- F.1 — Índices faltantes para columnas de consulta frecuente
                -- ══════════════════════════════════════════════════════════════════
                CREATE INDEX IF NOT EXISTS idx_documents_course_id
                    ON documents(course_id);
                CREATE INDEX IF NOT EXISTS idx_chat_sessions_course_id
                    ON chat_sessions(course_id);
                CREATE INDEX IF NOT EXISTS idx_index_jobs_status
                    ON index_jobs(status);
                CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
                    ON chat_messages(session_id);
                CREATE INDEX IF NOT EXISTS idx_assignments_course_id
                    ON assignments(course_id);
                CREATE INDEX IF NOT EXISTS idx_announcements_course_id
                    ON announcements(course_id);

                -- ══════════════════════════════════════════════════════════════════
                -- F.4 — UNIQUE parcial en documents.canvas_file_id
                -- ══════════════════════════════════════════════════════════════════
                -- 1. Dedupe: conservar el row con MIN(id) por canvas_file_id.
                --    Los orphan chunks e index_jobs se limpian por CASCADE
                --    (document_chunks y index_jobs tienen ON DELETE CASCADE en document_id).
                DELETE FROM documents
                WHERE canvas_file_id IS NOT NULL
                  AND id NOT IN (
                      SELECT MIN(id) FROM documents
                      WHERE canvas_file_id IS NOT NULL
                      GROUP BY canvas_file_id
                  );

                -- 2. Índice parcial UNIQUE (solo filas con canvas_file_id no nulo)
                CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_canvas_file_id
                    ON documents(canvas_file_id)
                    WHERE canvas_file_id IS NOT NULL;

                -- ══════════════════════════════════════════════════════════════════
                -- F.5 — Cleanup one-time: sync_jobs y tool_log > 30 días
                -- ══════════════════════════════════════════════════════════════════
                -- NOTA: esto es un cleanup ONE-TIME. El runtime debería correr estos
                -- DELETE periódicamente (TODO para un bloque futuro).
                DELETE FROM sync_jobs
                WHERE created_at < datetime('now', '-30 days');

                DELETE FROM tool_log
                WHERE created_at < datetime('now', '-30 days');
            ",
            kind: MigrationKind::Up,
        },
        // Migración 12 — Productividad: columna notified en assignments + defaults de settings
        Migration {
            version: 12,
            description: "productivity_notified_and_settings_defaults",
            sql: "
                -- Columna para marcar assignments ya notificados (evita notificaciones repetidas)
                ALTER TABLE assignments ADD COLUMN notified INTEGER DEFAULT 0;

                -- Defaults de configuración del Pomodoro y deadline notifications
                INSERT OR IGNORE INTO settings (key, value) VALUES ('pomodoro_focus_minutes', '25');
                INSERT OR IGNORE INTO settings (key, value) VALUES ('pomodoro_break_minutes', '5');
                INSERT OR IGNORE INTO settings (key, value) VALUES ('deadline_notifications_enabled', 'true');
                INSERT OR IGNORE INTO settings (key, value) VALUES ('deadline_lookahead_hours', '24');
            ",
            kind: MigrationKind::Up,
        },
        // Migración 13 — Canvas user ID para detectar cambio de usuario
        // Permite comparar el usuario actual con el guardado y limpiar datos al cambiar
        Migration {
            version: 13,
            description: "add_canvas_user_id_setting",
            sql: "INSERT OR IGNORE INTO settings (key, value) VALUES ('canvas_user_id', '');",
            kind: MigrationKind::Up,
        },
        // Migración 14 — Storage preference: dónde guardar los PDFs descargados de Canvas
        // storage_preference: "db_only" | "local_folder" | "" (no elegido aún)
        // download_path: path absoluto de la carpeta local (solo si storage_preference = "local_folder")
        Migration {
            version: 14,
            description: "storage_preference_settings",
            sql: "
                INSERT OR IGNORE INTO settings (key, value) VALUES ('storage_preference', '');
                INSERT OR IGNORE INTO settings (key, value) VALUES ('download_path', '');
            ",
            kind: MigrationKind::Up,
        },
        // Migración 15 — Soporte de documentos cargados manualmente (upload manual de PDFs)
        // content_hash: SHA-256 de los primeros 64KB del archivo — para detectar duplicados
        // sin depender de canvas_file_id (que es NULL en docs manuales).
        // El índice compuesto (content_hash, course_id) permite la query de dedup en O(log n).
        Migration {
            version: 15,
            description: "content_hash_for_manual_uploads",
            sql: "
                ALTER TABLE documents ADD COLUMN content_hash TEXT;
                CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash, course_id);
            ",
            kind: MigrationKind::Up,
        },
        // Migración 16 — Memoria local del estudiante (perfil + preferencias)
        //
        // Recrea la tabla `student_memory` (de migración 1) que estaba sin uso:
        // su esquema viejo (memory_type, content, updated_at) nunca se leyó ni
        // escribió en ningún lado del código, así que el DROP+CREATE no pierde
        // datos. El esquema nuevo soporta el tool `remember` + recall automático.
        //
        // Diseño (un solo canal `always`, sin embeddings ni FTS5 — ver debate):
        //   - kind: 'profile' (contexto académico) | 'preference' (cómo quiere la
        //     interacción). CHECK constraint para que el modelo no rompa el ruteo.
        //   - mem_key: slug estable opcional → UPSERT/corrección de un dato sin
        //     duplicar. Índice UNIQUE parcial (solo filas vivas).
        //   - deleted_at: soft-delete (la UI de transparencia borra suave; el wipe
        //     por cambio de usuario en lib.rs hace hard DELETE).
        //
        // FTS5 se cortó del MVP: el volumen por estudiante es de decenas de items,
        // se inyectan TODOS (cap 8) al prompt. Por eso esta migración es DDL
        // estándar puro (tauri-plugin-sql NO soporta DDL de FTS5).
        Migration {
            version: 16,
            description: "student_memory_profile_preferences",
            sql: "
                DROP TABLE IF EXISTS student_memory;
                CREATE TABLE student_memory (
                  id          INTEGER PRIMARY KEY AUTOINCREMENT,
                  kind        TEXT NOT NULL CHECK (kind IN ('profile','preference')),
                  mem_key     TEXT,
                  content     TEXT NOT NULL,
                  course_id   INTEGER,
                  pinned      INTEGER NOT NULL DEFAULT 0,
                  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
                  deleted_at  TEXT
                );

                -- UNIQUE parcial: garantiza un único registro VIVO por mem_key,
                -- permitiendo que queden filas borradas con el mismo key.
                CREATE UNIQUE INDEX idx_sm_memkey
                  ON student_memory(mem_key)
                  WHERE mem_key IS NOT NULL AND deleted_at IS NULL;

                -- Cubre el SELECT de recall (filtra vivas, ordena por pinned + recencia).
                CREATE INDEX idx_sm_active
                  ON student_memory(deleted_at, pinned, updated_at);
            ",
            kind: MigrationKind::Up,
        },
        // Migración 17 — Estilo de documento configurable (tabla single-row id=1)
        //
        // Persiste los DEFAULTS de estilo que `create_pdf` lee en runtime (mismo
        // patrón que `detect_university`). Un único row con CHECK(id=1) garantiza
        // que nunca haya más de una configuración base. Los DEFAULT de cada columna
        // reproducen EXACTAMENTE el comportamiento hardcoded actual de los templates
        // (apa/inter/12/1.5/2.5/portrait/none/light/blue/16:9/light), por lo que la
        // migración es aditiva y no cambia ningún PDF hasta que el usuario edite algo.
        //
        // El `INSERT OR IGNORE ... VALUES (1)` se apoya en los DEFAULT de columna para
        // materializar la fila de defaults: aunque `read_document_style` ya cae a
        // defaults si la fila falta, tener la fila presente simplifica el UPSERT del
        // comando `set_document_style` y hace el estado observable en la DB.
        Migration {
            version: 17,
            description: "document_style_single_row",
            sql: "
                CREATE TABLE IF NOT EXISTS document_style (
                  id                  INTEGER PRIMARY KEY CHECK (id = 1),
                  format              TEXT NOT NULL DEFAULT 'apa',
                  font_family         TEXT NOT NULL DEFAULT 'inter',
                  font_size           INTEGER NOT NULL DEFAULT 12,
                  line_height         REAL NOT NULL DEFAULT 1.5,
                  margins_cm          REAL NOT NULL DEFAULT 2.5,
                  orientation         TEXT NOT NULL DEFAULT 'portrait',
                  logo                TEXT NOT NULL DEFAULT 'none',
                  cover_theme         TEXT NOT NULL DEFAULT 'light',
                  accent_color        TEXT NOT NULL DEFAULT 'blue',
                  presentation_ratio  TEXT NOT NULL DEFAULT '16:9',
                  presentation_theme  TEXT NOT NULL DEFAULT 'light'
                );

                INSERT OR IGNORE INTO document_style (id) VALUES (1);
            ",
            kind: MigrationKind::Up,
        },
        // Migración 18 — Override de estilo transitorio por sesión de chat
        //
        // El modal de creación opcional escribe aquí un override de estilo asociado a
        // la `session_id` activa. `create_pdf` lo consume one-shot (merge + clear) en
        // Fase 4. Scope per-chat-session (decisión aprobada): `session_id` es PRIMARY
        // KEY → a lo sumo un override pendiente por sesión; un nuevo override sobre la
        // misma sesión hace UPSERT. Todos los campos NOT NULL porque el modal
        // pre-rellena con los defaults persistidos y envía un StyleConfig completo.
        //
        // No declaramos FK a chat_sessions(id) para no acoplar la limpieza por CASCADE:
        // la fila es efímera y se borra explícitamente al consumirse en create_pdf.
        Migration {
            version: 18,
            description: "pending_style_override_per_session",
            sql: "
                CREATE TABLE IF NOT EXISTS pending_style_override (
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
                );
            ",
            kind: MigrationKind::Up,
        },
    ]
}
