// MainLayout.tsx — Layout principal de 3 columnas de StudiAI
// Rail (64px) | Sidebar (240px, expandible) | ChatPanel (flex-1)

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Database from "@tauri-apps/plugin-sql";
import { BookOpen } from "lucide-react";
import { Rail } from "../components/Rail";
import { Sidebar } from "../components/Sidebar";
import { ChatPanel } from "../components/ChatPanel";
import { TasksPanel } from "../components/TasksPanel";
import { SettingsModal } from "../components/SettingsModal";
import { ToastContainer, useToasts } from "../components/Toast";
import { useCourses, useCourseDetail, useChatSessions, cleanCourseName } from "../hooks/useCanvasData";
import type { Document } from "../hooks/useCanvasData";
import type { Curso } from "../components/Rail";
import type { Archivo, ChatReciente } from "../components/Sidebar";
import type { Mensaje, ErrorType, ToolInvocation } from "../components/ChatPanel";
import type { PendingImage } from "../components/ChatInput";

// ─── Helpers de mapeo ─────────────────────────────────────────────────────────

/**
 * Convierte un tipo de archivo (MIME o extensión) al tipo que espera el Sidebar.
 * Ej: "application/pdf" → "pdf", "video/mp4" → "otro"
 */
function mapFileType(fileType: string | null): Archivo["tipo"] {
  if (!fileType) return "otro";
  const t = fileType.toLowerCase();
  if (t.includes("pdf")) return "pdf";
  if (t.includes("word") || t.includes("docx") || t.endsWith(".docx")) return "docx";
  if (t.includes("excel") || t.includes("xlsx") || t.endsWith(".xlsx")) return "xlsx";
  if (
    t.includes("powerpoint") ||
    t.includes("pptx") ||
    t.endsWith(".pptx") ||
    t.includes("presentation")
  )
    return "pptx";
  if (t.includes("image") || t.includes("png") || t.includes("jpg") || t.includes("jpeg"))
    return "img";
  return "otro";
}

/**
 * Formatea una fecha ISO a texto relativo legible.
 * Ej: "2024-04-05T10:00:00" → "3 días", "hoy", "ayer"
 */
function formatFechaRelativa(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return "hoy";
    if (diffDays === 1) return "ayer";
    if (diffDays < 30) return `hace ${diffDays} días`;
    const diffMonths = Math.floor(diffDays / 30);
    return `hace ${diffMonths} mes${diffMonths !== 1 ? "es" : ""}`;
  } catch {
    return "reciente";
  }
}

// ─── Componente: Estado vacío sin cursos ──────────────────────────────────────

interface EmptyCursosProps {
  onGoToSettings: () => void;
}

function EmptyCursos({ onGoToSettings }: EmptyCursosProps) {
  return (
    <div
      className="flex flex-col items-center justify-center flex-1 p-8 text-center"
      style={{ background: "var(--bg-base)" }}
    >
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border-base)" }}
      >
        <BookOpen className="w-8 h-8 text-gray-500" />
      </div>
      <h2 className="text-base font-semibold mb-1" style={{ color: "var(--text-strong)" }}>
        No hay cursos aún
      </h2>
      <p className="text-sm mb-4" style={{ color: "var(--text-weak)" }}>
        Conecta Canvas para ver tus materiales
      </p>
      <button
        onClick={onGoToSettings}
        className="px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-150 outline-none"
        style={{ background: "var(--accent)", color: "white" }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--accent-hover)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--accent)";
        }}
      >
        Ir a Configuración
      </button>
    </div>
  );
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function MainLayout() {
  // ── Estado del layout ────────────────────────────────────────
  const [sidebarExpandido, setSidebarExpandido] = useState(true);
  /**
   * ID del curso seleccionado como string (para compatibilidad con Rail/Sidebar).
   * Almacena el `id` numérico del curso convertido a string.
   */
  const [cursoSeleccionadoId, setCursoSeleccionadoId] = useState<string | null>(null);
  const [chatActivoId, setChatActivoId] = useState<string | null>(null);

  /** true cuando el panel de tareas del calendario está abierto */
  const [tareasAbierto, setTareasAbierto] = useState(false);

  /** true cuando el modal de settings está abierto */
  const [showSettings, setShowSettings] = useState(false);

  /** Sección inicial del modal de settings (para abrir directamente en "planes", etc.) */
  const [settingsSection, setSettingsSection] = useState<"cuenta" | "planes" | "canvas" | "acerca" | undefined>(undefined);

  // ── Estado del chat ──────────────────────────────────────────
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [cargando, setCargando] = useState(false);

  /**
   * ID de la sesión de chat activa en SQLite (null = sesión aún no creada).
   * Se crea al primer mensaje del usuario y se persiste en chat_sessions.
   */
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);

  /**
   * Ref para acceder al currentSessionId actual dentro de callbacks async
   * sin capturar stale values.
   */
  const currentSessionIdRef = useRef<number | null>(null);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // ── Estado de descarga de archivos ───────────────────────────
  /** ID local del documento que se está descargando/abriendo (null = ninguno) */
  const [downloadingDocId, setDownloadingDocId] = useState<number | null>(null);

  // ── Toast notifications ─────────────────────────────────────
  const { toasts, addToast, dismissToast } = useToasts();

  /** Guard: solo mostrar toast de indexación completa una vez por sesión de indexado */
  const indexToastShown = useRef(false);

  // ── Listener de progreso de indexado ────────────────────────
  // Recibe eventos del backend durante el indexado/OCR de PDFs
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<string>("index-progress", (e) => {
      if (e.payload) {
        console.log("[index]", e.payload);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  // ── Listener: canvas-token-expired → toast de token expirado ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen("canvas-token-expired", () => {
      addToast({
        variant: "error",
        message: "Tu token de Canvas ha expirado. Actualizalo en Ajustes > Canvas.",
        duration: 8000,
      });
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [addToast]);

  // ── Listener: index-bg-complete → toast de indexacion completa ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<{ total: number; done: number; failed: number }>(
      "index-bg-complete",
      (e) => {
        const { done, failed } = e.payload;
        if (done === 0 && failed === 0) return; // nothing happened
        if (indexToastShown.current) return; // already shown this indexing session
        indexToastShown.current = true;

        if (failed > 0) {
          addToast({
            variant: "warning",
            message: `Indexacion completa: ${done} procesados, ${failed} con errores`,
            duration: 5000,
          });
        } else {
          addToast({
            variant: "success",
            message: `Indexacion completa: ${done} archivos procesados`,
            duration: 5000,
          });
        }
      }
    ).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [addToast]);

  // ── Listener: canvas-sync-event → toast en warnings no fatales ──
  // Bloque E agregó SyncEvent::Warning en el backend para eventos no
  // fatales (ej: fallo al leer metadata de un archivo). Los mostramos
  // como toast no bloqueante para que el usuario sepa que pasó algo
  // pero la sincronización continúa.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<{ type: string; code?: string; message?: string }>(
      "canvas-sync-event",
      (e) => {
        if (e.payload?.type !== "warning") return;
        const mensaje = e.payload.message || "Advertencia durante la sincronización";
        addToast({
          variant: "warning",
          message: mensaje,
          duration: 6000,
        });
      }
    ).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [addToast]);

  // ── Queries a SQLite ─────────────────────────────────────────

  const { courses, loading: loadingCursos } = useCourses();

  /**
   * Convertir el ID seleccionado de string a number para el hook de detalle.
   * null si no hay selección o si el valor no es un número válido.
   */
  const cursoSeleccionadoNumId = useMemo<number | null>(() => {
    if (!cursoSeleccionadoId) return null;
    const n = parseInt(cursoSeleccionadoId, 10);
    return isNaN(n) ? null : n;
  }, [cursoSeleccionadoId]);

  const { documents, loading: loadingDetalle } = useCourseDetail(cursoSeleccionadoNumId);

  const { sessions: chatSessions, refetch: refetchSessions } = useChatSessions(cursoSeleccionadoNumId);

  // ── Listener de auto-start de indexado background ────────
  // El backend emite 'index-bg-autostart' ~5s después de arrancar.
  // El frontend responde llamando start_background_index con el curso activo.
  useEffect(() => {
    let unlistenAutostart: (() => void) | undefined;

    listen("index-bg-autostart", () => {
      indexToastShown.current = false; // reset for new indexing session
      invoke("start_background_index", {
        activeCourseId: cursoSeleccionadoNumId ?? null,
      }).catch(console.error);
    }).then((fn) => {
      unlistenAutostart = fn;
    });

    return () => {
      unlistenAutostart?.();
    };
  }, [cursoSeleccionadoNumId]);

  // ── Seleccionar primer curso al cargar ───────────────────────
  // Cuando los cursos cargan y no hay selección, seleccionamos el primero
  const cursos = useMemo<Curso[]>(
    () =>
      courses.map((c) => ({
        id: String(c.id),
        nombre: cleanCourseName(c.code, c.name),
      })),
    [courses]
  );

  // Auto-seleccionar el primer curso cuando cargan
  const firstCourseId = cursos.length > 0 ? cursos[0].id : null;
  if (!cursoSeleccionadoId && firstCourseId && !loadingCursos) {
    setCursoSeleccionadoId(firstCourseId);
  }

  // Canvas está conectado si hay al menos un curso sincronizado
  const canvasConectado = courses.length > 0;

  // ── Mapeo: documentos DB → Archivo (Sidebar) ─────────────────
  const archivos = useMemo<Archivo[]>(() => {
    if (loadingDetalle) return [];
    return documents.map((doc) => ({
      id: String(doc.id),
      nombre: doc.title,
      tipo: mapFileType(doc.file_type),
      carpeta: doc.file_type ? categorizeDocument(doc.file_type) : "Sin carpeta",
      isLoading: downloadingDocId === doc.id,
    }));
  }, [documents, loadingDetalle, downloadingDocId]);

  /** Mapa id (string) → Document para lookup rápido al abrir un archivo */
  const docById = useMemo<Map<string, Document>>(() => {
    const map = new Map<string, Document>();
    for (const doc of documents) {
      map.set(String(doc.id), doc);
    }
    return map;
  }, [documents]);

  // ── Mapeo: chat sessions DB → ChatReciente (Sidebar) ─────────
  const chatsRecientes = useMemo<ChatReciente[]>(() => {
    return chatSessions.map((s) => ({
      id: String(s.id),
      titulo: s.title ?? "Sin título",
      fechaRelativa: formatFechaRelativa(s.updated_at ?? s.created_at),
    }));
  }, [chatSessions]);

  // ── Curso seleccionado (objeto Curso) ────────────────────────
  const cursoSeleccionado = useMemo(
    () => cursos.find((c) => c.id === cursoSeleccionadoId) ?? null,
    [cursos, cursoSeleccionadoId]
  );

  // ── Callbacks ────────────────────────────────────────────────

  const handleSelectCurso = useCallback((id: string) => {
    // Fire-and-forget: generar resumen de la sesión que se abandona
    const prevId = currentSessionIdRef.current;
    if (prevId) {
      invoke("generate_session_summary", { sessionId: prevId }).catch(console.error);
    }
    setCursoSeleccionadoId(id);
    setSidebarExpandido(true);
    // Al cambiar de curso, empezar sesión nueva
    setCurrentSessionId(null);
    setMensajes([]);
    setChatActivoId(null);
    setTareasAbierto(false);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarExpandido((prev) => !prev);
  }, []);

  const handleSelectChat = useCallback(async (id: string) => {
    // Fire-and-forget: generar resumen de la sesión que se abandona
    const prevId = currentSessionIdRef.current;
    if (prevId) {
      invoke("generate_session_summary", { sessionId: prevId }).catch(console.error);
    }
    setChatActivoId(id);
    setTareasAbierto(false);
    const sessionNumId = parseInt(id, 10);
    if (isNaN(sessionNumId)) return;

    try {
      const db = await Database.load("sqlite:studyai.db");
      const rows = await db.select<{
        id: number;
        role: string;
        content: string;
        created_at: string;
      }[]>(
        "SELECT id, role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
        [sessionNumId]
      );

      const mensajesCargados: Mensaje[] = rows.map((row) => ({
        id: `db-${row.id}`,
        rol: row.role === "user" ? "usuario" : "asistente",
        contenido: row.content,
        timestamp: new Date(row.created_at),
      }));

      setMensajes(mensajesCargados);
      setCurrentSessionId(sessionNumId);
    } catch (err) {
      console.error("[MainLayout] Error al cargar mensajes de la sesión:", err);
    }
  }, []);

  const handleDeleteChat = useCallback(async (id: string) => {
    const sessionNumId = parseInt(id, 10);
    if (isNaN(sessionNumId)) return;

    try {
      const db = await Database.load("sqlite:studyai.db");
      await db.execute("DELETE FROM chat_messages WHERE session_id = $1", [sessionNumId]);
      await db.execute("DELETE FROM chat_sessions WHERE id = $1", [sessionNumId]);
    } catch (err) {
      console.error("[MainLayout] Error al eliminar chat:", err);
    }

    // If the deleted chat is currently active, clear the chat panel
    if (chatActivoId === id) {
      setChatActivoId(null);
      setMensajes([]);
      setCurrentSessionId(null);
    }

    // Refresh the sidebar chat list
    refetchSessions();
  }, [chatActivoId, refetchSessions]);

  const handleNuevaSession = useCallback(() => {
    // Fire-and-forget: generar resumen de la sesión que se abandona
    const prevId = currentSessionIdRef.current;
    if (prevId) {
      invoke("generate_session_summary", { sessionId: prevId }).catch(console.error);
    }
    setChatActivoId(null);
    setMensajes([]);
    setCurrentSessionId(null);
    setTareasAbierto(false);
  }, []);

  const handleOpenArchivo = useCallback(async (archivo: Archivo) => {
    // Evitar descargas concurrentes
    if (downloadingDocId !== null) return;

    const doc = docById.get(archivo.id);
    if (!doc) {
      console.warn("[MainLayout] Documento no encontrado en mapa:", archivo.id);
      return;
    }

    // Si no hay URL y no hay path local, el archivo no puede descargarse
    if (!doc.download_url && !doc.file_path) {
      console.warn("[MainLayout] Sin URL de descarga para:", doc.title, "— re-sincroniza Canvas");
      return;
    }

    setDownloadingDocId(doc.id);
    try {
      const localPath = await invoke<string>("open_or_download_file", {
        canvasFileId: doc.canvas_file_id ?? 0,
        title: doc.title,
        downloadUrl: doc.download_url ?? null,
        filePath: doc.file_path ?? null,
      });

      // Guardar el path local en SQLite para no volver a descargar
      const db = await Database.load("sqlite:studyai.db");
      await db.execute(
        "UPDATE documents SET file_path = $1 WHERE id = $2",
        [localPath, doc.id]
      );

      // Indexar el documento para búsqueda FTS5 (fire-and-forget)
      // Solo indexar PDFs — otros tipos no tienen texto extraíble
      if (doc.file_type?.toLowerCase().includes("pdf")) {
        invoke("index_document", {
          documentId: doc.id,
          filePath: localPath,
        })
          .then((result) => {
            if (result === "scanned") {
              console.log("[index] PDF escaneado (sin texto extraíble):", doc.title);
            } else {
              console.log("[index] PDF indexado:", result, doc.title);
            }
          })
          .catch((err) => console.error("[index] Error al indexar PDF:", err));
      }
    } catch (err) {
      console.error("[MainLayout] Error al abrir archivo:", err);
      // TODO: mostrar toast de error cuando se implemente el sistema de notificaciones
    } finally {
      setDownloadingDocId(null);
    }
  }, [downloadingDocId, docById]);

  /** Envía un mensaje al backend Rust y recibe la respuesta con streaming */
  const handleEnviarMensaje = useCallback(
    async (texto: string, images?: PendingImage[]) => {
      if (cargando) return;

      // ── 1. Agregar mensaje del usuario al historial ──────────────────────
      const mensajeUsuario: Mensaje = {
        id: `msg-${Date.now()}`,
        rol: "usuario",
        contenido: texto,
        timestamp: new Date(),
        images: images?.map((img) => ({ base64: img.base64, mediaType: img.mediaType })),
      };

      // ID estable del mensaje de la IA — lo usamos para actualizar en streaming
      const iaId = `msg-${Date.now()}-ia`;
      let primerTokenRecibido = false;

      // Guard contra doble manejo de errores: el backend emite chat-stream-error
      // Y además retorna Err (lo que dispara .catch). Solo el primero debe actuar.
      let errorHandled = false;

      // Solo agregamos el mensaje del usuario por ahora — el de IA se agrega con el primer token
      setMensajes((prev) => [...prev, mensajeUsuario]);
      setCargando(true);

      // ── 1b. Persistir sesión y mensaje del usuario ─────────────────────
      // AWAIT para que el sessionId esté listo antes de que llegue la respuesta.
      // Si falla, seguimos — el chat funciona sin persistencia.
      const courseIdParaSesion = cursoSeleccionadoNumId;

      // `sesionIdStream` es el ID de la sesión a la que pertenece ESTE mensaje.
      // Se captura al inicio del turno y no cambia durante el streaming, incluso
      // si el usuario cambia de curso/sesión antes de que llegue la respuesta.
      // Esto evita una carrera: usar currentSessionIdRef en el listener de
      // chat-stream-done escribiría la respuesta en la sesión equivocada.
      let sesionIdStream: number | null = currentSessionIdRef.current;

      try {
        const db = await Database.load("sqlite:studyai.db");

        if (sesionIdStream === null) {
          // Crear nueva sesión — fallback si columnas nuevas no existen
          const titulo = texto.trim().slice(0, 50);
          let result;
          try {
            result = await db.execute(
              "INSERT INTO chat_sessions (course_id, title, message_count, updated_at) VALUES ($1, $2, 0, datetime('now'))",
              [courseIdParaSesion ?? null, titulo]
            );
          } catch {
            // Fallback: columnas nuevas no existen
            result = await db.execute(
              "INSERT INTO chat_sessions (course_id, title) VALUES ($1, $2)",
              [courseIdParaSesion ?? null, titulo]
            );
          }
          sesionIdStream = result.lastInsertId as number;
          // Sync: actualizar ref inmediatamente para que otros callbacks
          // que lean currentSessionIdRef.current lo vean sin esperar al effect.
          currentSessionIdRef.current = sesionIdStream;
          setCurrentSessionId(sesionIdStream);
          refetchSessions();
        }

        // Persistir mensaje del usuario
        await db.execute(
          "INSERT INTO chat_messages (session_id, role, content, model_used) VALUES ($1, $2, $3, $4)",
          [sesionIdStream, "user", texto, "gemini-2.5-flash"]
        );
        // Intentar actualizar metadata (ignorar si columnas no existen)
        try {
          await db.execute(
            "UPDATE chat_sessions SET message_count = message_count + 1, updated_at = datetime('now') WHERE id = $1",
            [sesionIdStream]
          );
        } catch { /* columnas no disponibles */ }
      } catch (err) {
        console.error("[MainLayout] Error al persistir mensaje del usuario:", err);
      }

      // ── 2. Suscribirse a eventos de streaming ANTES de invocar ───────────
      // Capturamos el snapshot del historial actual (sin el mensaje nuevo)
      // para enviarlo al backend como contexto
      const historialParaBackend = mensajes.map((m) => ({
        role: m.rol === "usuario" ? "user" : "assistant",
        content: m.contenido,
      }));

      // Obtener contexto del curso activo (nombre del curso seleccionado)
      const courseContext = cursoSeleccionado
        ? `Curso: ${cursoSeleccionado.nombre}`
        : null;

      // Helper para limpiar TODOS los listeners de una vez
      let cleanup: (() => void) | null = null;

      // Registrar TODOS los listeners en paralelo antes de invocar
      const [unlistenChunk, unlistenThought, unlistenThinking, unlistenDone, unlistenError] = await Promise.all([
        listen<string>("chat-stream-chunk", (e) => {
          if (!primerTokenRecibido) {
            // Primer token — agregar el mensaje IA al array por primera vez
            primerTokenRecibido = true;
            setMensajes((prev) => [
              ...prev,
              {
                id: iaId,
                rol: "asistente" as const,
                contenido: e.payload,
                timestamp: new Date(),
                streaming: true,
              },
            ]);
          } else {
            // Tokens siguientes — acumular contenido
            setMensajes((prev) =>
              prev.map((m) =>
                m.id === iaId ? { ...m, contenido: m.contenido + e.payload } : m
              )
            );
          }
        }),

        // Thought summary (thinking-visible 2026-04-10) — Gemini 2.5 Flash emite
        // resúmenes de su razonamiento cuando `thinkingConfig.includeThoughts=true`.
        // Se acumulan en `thoughts[]` del mensaje en curso y se renderizan aparte
        // del contenido principal. EFÍMEROS: no se persisten a SQLite.
        listen<string>("chat-stream-thought", (e) => {
          if (!primerTokenRecibido) {
            // Thought llegó antes que cualquier texto — crear el mensaje IA placeholder
            primerTokenRecibido = true;
            setMensajes((prev) => [
              ...prev,
              {
                id: iaId,
                rol: "asistente" as const,
                contenido: "",
                timestamp: new Date(),
                streaming: true,
                thoughts: [e.payload],
              },
            ]);
          } else {
            setMensajes((prev) =>
              prev.map((m) =>
                m.id === iaId
                  ? { ...m, thoughts: [...(m.thoughts ?? []), e.payload] }
                  : m
              )
            );
          }
        }),

        // Thinking status — el agente ejecuta tools y notifica al frontend
        // También acumula cada invocación en toolInvocations para mostrar indicadores inline
        listen<string>("chat-stream-thinking", (e) => {
          setMensajes((prev) =>
            prev.map((m) => {
              if (m.id !== iaId || !m.streaming) return m;
              const newInvocation: ToolInvocation = {
                label: e.payload,
                timestamp: Date.now(),
              };
              // Evitar duplicados (mismo label)
              const existing = m.toolInvocations ?? [];
              const alreadyExists = existing.some((inv) => inv.label === e.payload);
              return {
                ...m,
                thinkingStatus: e.payload,
                toolInvocations: alreadyExists ? existing : [...existing, newInvocation],
              };
            })
          );
        }),

        listen("chat-stream-done", () => {
          // Limpiar thinkingStatus al terminar
          setMensajes((prev) => {
            const updated = prev.map((m) =>
              m.id === iaId
                ? { ...m, streaming: false, thinkingStatus: undefined }
                : m
            );

            // Persistir respuesta del asistente y actualizar metadatos de sesión.
            // Usamos `sesionIdStream` (capturado en el closure del turno) — NO
            // currentSessionIdRef, porque el usuario puede haber cambiado de
            // sesión mientras la respuesta streameaba.
            const mensajeIA = updated.find((m) => m.id === iaId);
            if (mensajeIA && mensajeIA.contenido) {
              const sesionId = sesionIdStream;
              if (sesionId !== null) {
                Database.load("sqlite:studyai.db")
                  .then(async (db) => {
                    // Guardar mensaje del asistente
                    await db.execute(
                      "INSERT INTO chat_messages (session_id, role, content, model_used) VALUES ($1, $2, $3, $4)",
                      [sesionId, "assistant", mensajeIA.contenido, "gemini-2.5-flash"]
                    );
                    // Incrementar message_count y actualizar updated_at
                    await db.execute(
                      "UPDATE chat_sessions SET message_count = message_count + 1, updated_at = datetime('now') WHERE id = $1",
                      [sesionId]
                    );
                    // Auto-título: solo si es la primera respuesta IA (message_count <= 2 = 1 user + 1 assistant)
                    const sessionRows = await db.select<{ message_count: number; title: string | null }[]>(
                      "SELECT message_count, title FROM chat_sessions WHERE id = $1",
                      [sesionId]
                    );
                    if (sessionRows.length > 0 && sessionRows[0].message_count <= 2) {
                      // Generar título desde la respuesta IA: primera oración o primeros 60 chars
                      const respuesta = mensajeIA.contenido.replace(/^[\s#*_`>-]+/, "").trim();
                      let autoTitle: string;
                      // Buscar primera oración terminada en . ! o ?
                      const sentenceMatch = respuesta.match(/^(.+?[.!?])\s/);
                      if (sentenceMatch && sentenceMatch[1].length <= 80) {
                        autoTitle = sentenceMatch[1];
                      } else {
                        // Cortar en límite de palabra cercano a 60 chars
                        const truncated = respuesta.slice(0, 60);
                        const lastSpace = truncated.lastIndexOf(" ");
                        autoTitle = lastSpace > 20 ? truncated.slice(0, lastSpace) + "…" : truncated + "…";
                      }
                      await db.execute(
                        "UPDATE chat_sessions SET title = $1 WHERE id = $2",
                        [autoTitle, sesionId]
                      );
                      // Refrescar sidebar para mostrar el nuevo título
                      refetchSessions();
                    }
                  })
                  .catch((err) =>
                    console.error("[MainLayout] Error al persistir respuesta del asistente:", err)
                  );
              }
            }

            return updated;
          });
          setCargando(false);
          cleanup?.();
        }),

        listen<string>("chat-stream-error", (e) => {
          console.error("[chat] Error de streaming:", e.payload);
          errorHandled = true;
          const raw = (e.payload ?? "").toLowerCase();

          // Clasificar el error
          let errorType: ErrorType;
          let errorMsg: string;

          if (raw.includes("network") || raw.includes("dns") || raw.includes("connect") ||
              raw.includes("offline") || raw.includes("failed to connect") || raw.includes("no internet") ||
              raw.includes("error al conectar")) {
            errorType = "sin_internet";
            errorMsg = "Sin conexion a internet. Verifica tu red e intenta de nuevo.";
          } else if (raw.includes("429") || raw.includes("rate limit") || raw.includes("too many") ||
                     raw.includes("resource_exhausted") || raw.includes("quota")) {
            errorType = "rate_limit";
            errorMsg = "Demasiadas solicitudes. Espera un momento e intenta de nuevo.";
          } else if (raw.includes("401") || raw.includes("403") || raw.includes("token") ||
                     raw.includes("auth") || raw.includes("unauthorized") || raw.includes("forbidden")) {
            errorType = "token_expirado";
            errorMsg = "Tu token de Canvas ha expirado. Actualízalo en Ajustes > Canvas.";
          } else {
            errorType = "generico";
            errorMsg = "Hubo un error al procesar tu mensaje. Intenta de nuevo.";
          }

          const errorId = `error-${Date.now()}`;
          setMensajes((prev) => {
            // Remove the IA placeholder if it exists and is empty
            const cleaned = prev.filter((m) => !(m.id === iaId && !m.contenido));
            // Mark any streaming IA message as done
            const updated = cleaned.map((m) =>
              m.id === iaId ? { ...m, streaming: false, thinkingStatus: undefined } : m
            );
            return [
              ...updated,
              {
                id: errorId,
                rol: "asistente" as const,
                contenido: errorMsg,
                timestamp: new Date(),
                streaming: false,
                errorType,
              },
            ];
          });
          setCargando(false);
          cleanup?.();
        }),
      ]);

      // Asignar cleanup después de que todos los listeners estén registrados
      cleanup = () => {
        unlistenChunk();
        unlistenThought();
        unlistenThinking();
        unlistenDone();
        unlistenError();
      };

      // ── 2b. Resize imagenes si existen (reduce tokens en Gemini) ──────────
      let imagesPayload: { base64: string; mediaType: string }[] | null = null;
      if (images && images.length > 0) {
        imagesPayload = [];
        for (const image of images) {
          try {
            const resized = await invoke<{ base64: string; mediaType: string; resized: boolean }>(
              "resize_image_base64",
              { base64Data: image.base64, mediaType: image.mediaType }
            );
            imagesPayload.push({ base64: resized.base64, mediaType: resized.mediaType });
          } catch (e) {
            console.warn("[image] Resize failed, sending original:", e);
            imagesPayload.push({ base64: image.base64, mediaType: image.mediaType });
          }
        }
      }

      // ── 3. Invocar el comando Rust ───────────────────────────────────────
      // El backend emite chat-stream-error Y retorna Err en caso de error.
      // Usamos errorHandled para evitar mostrar el error dos veces.
      invoke("send_chat_message", {
        messages: [
          ...historialParaBackend,
          { role: "user", content: texto },
        ],
        courseContext,
        activeCourseId: cursoSeleccionadoNumId ?? null,
        images: imagesPayload ?? [],
      }).catch((err: unknown) => {
        // Si el error ya fue manejado por el listener de chat-stream-error, no duplicar
        if (errorHandled) return;

        console.error("[chat] Error al invocar send_chat_message:", err);
        const errStr = String(err).toLowerCase();

        let errorType: ErrorType;
        let errorMsg: string;

        if (errStr.includes("network") || errStr.includes("connect") || errStr.includes("offline")) {
          errorType = "sin_internet";
          errorMsg = "Sin conexion a internet. Verifica tu red e intenta de nuevo.";
        } else {
          errorType = "generico";
          errorMsg = "Hubo un error al procesar tu mensaje. Intenta de nuevo.";
        }

        const catchErrorId = `error-${Date.now()}`;
        setMensajes((prev) => {
          const cleaned = prev.filter((m) => !(m.id === iaId && !m.contenido));
          const updated = cleaned.map((m) =>
            m.id === iaId ? { ...m, streaming: false, thinkingStatus: undefined } : m
          );
          return [
            ...updated,
            {
              id: catchErrorId,
              rol: "asistente" as const,
              contenido: errorMsg,
              timestamp: new Date(),
              streaming: false,
              errorType,
            },
          ];
        });
        setCargando(false);
        cleanup?.();
      });
    },
    [cargando, mensajes, cursoSeleccionado, cursoSeleccionadoNumId, refetchSessions]
  );

  // ── Render ───────────────────────────────────────────────────

  return (
    <div
      className="flex h-screen overflow-hidden"
      style={{ background: "var(--bg-base)" }}
    >
      {/* ── 1. Rail — columna ultra-fina ──────────────────────── */}
      <Rail
        cursos={loadingCursos ? [] : cursos}
        cursoSeleccionadoId={cursoSeleccionadoId}
        onSelectCurso={handleSelectCurso}
        onOpenSettings={() => setShowSettings(true)}
        onOpenTareas={() => setTareasAbierto((prev) => !prev)}
      />

      {/* ── 2. Sidebar — segunda columna ──────────────────────── */}
      <Sidebar
        expandido={sidebarExpandido}
        onToggle={handleToggleSidebar}
        cursoSeleccionado={cursoSeleccionado}
        archivos={archivos}
        chatsRecientes={chatsRecientes}
        chatActivoId={chatActivoId}
        onSelectChat={handleSelectChat}
        onDeleteChat={handleDeleteChat}
        onNuevaSession={handleNuevaSession}
        onOpenArchivo={handleOpenArchivo}
      />

      {/* ── 3. Panel central — vacío si no hay cursos ─────────── */}
      {!loadingCursos && cursos.length === 0 ? (
        <EmptyCursos onGoToSettings={() => setShowSettings(true)} />
      ) : tareasAbierto ? (
        /* ── 4a. TasksPanel — panel de tareas próximas ───────── */
        <TasksPanel onClose={() => setTareasAbierto(false)} />
      ) : (
        /* ── 4b. ChatPanel — panel principal flex-1 ─────────── */
        <ChatPanel
          mensajes={mensajes}
          cargando={cargando}
          canvasConectado={canvasConectado}
          onEnviarMensaje={handleEnviarMensaje}
          onConectarCanvas={() => setShowSettings(true)}
          onVerPlanes={() => {
            setSettingsSection("planes");
            setShowSettings(true);
          }}
        />
      )}

      {/* ── 5. Settings Modal overlay ─────────────────────────── */}
      <SettingsModal
        open={showSettings}
        onClose={() => {
          setShowSettings(false);
          setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />

      {/* ── 6. Toast notifications ────────────────────────────── */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Categoriza un documento en una carpeta basada en su tipo de archivo.
 * Usado para agrupar documentos en el Sidebar.
 */
function categorizeDocument(fileType: string): string {
  const t = fileType.toLowerCase();
  if (t.includes("pdf")) return "PDFs";
  if (t.includes("word") || t.includes("docx")) return "Documentos";
  if (t.includes("excel") || t.includes("xlsx")) return "Hojas de cálculo";
  if (t.includes("powerpoint") || t.includes("pptx") || t.includes("presentation"))
    return "Presentaciones";
  if (t.includes("image") || t.includes("png") || t.includes("jpg")) return "Imágenes";
  return "Archivos";
}

export default MainLayout;
