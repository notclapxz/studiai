// MainLayout.tsx — Layout principal de 3 columnas de StudiAI
// Rail (64px) | Sidebar (240px, expandible) | ChatPanel (flex-1)

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Database from "@tauri-apps/plugin-sql";
import { BookOpen } from "lucide-react";
import { Rail } from "../components/Rail";
import { Sidebar } from "../components/Sidebar";
import { ChatPanel } from "../components/ChatPanel";
import { TasksPanel } from "../components/TasksPanel";
import { SettingsModal } from "../components/SettingsModal";
import { PomodoroWidget } from "../components/PomodoroWidget";
import { ToastContainer, useToasts } from "../components/Toast";
import { useTimerStore } from "../store/timerStore";
import { useCourses, useCourseDetail, useChatSessions, cleanCourseName } from "../hooks/useCanvasData";
import { useChat } from "../hooks/useChat";
import type { Document } from "../hooks/useCanvasData";
import type { Curso } from "../components/Rail";
import type { Archivo, ChatReciente } from "../components/Sidebar";

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

interface MainLayoutProps {
  /** Abre el ChangelogModal desde Settings → Acerca de */
  onOpenChangelog?: () => void;
  /** Fuerza la navegación al onboarding (bypasea checks de cursos) */
  onForceOnboarding?: () => void;
}

export function MainLayout({ onOpenChangelog, onForceOnboarding }: MainLayoutProps) {
  // ── Estado del layout ────────────────────────────────────────
  const [sidebarExpandido, setSidebarExpandido] = useState(true);
  /**
   * ID del curso seleccionado como string (para compatibilidad con Rail/Sidebar).
   * Almacena el `id` numérico del curso convertido a string.
   */
  const [cursoSeleccionadoId, setCursoSeleccionadoId] = useState<string | null>(null);

  /** true cuando el panel de tareas del calendario está abierto */
  const [tareasAbierto, setTareasAbierto] = useState(false);

  /** true cuando el modal de settings está abierto */
  const [showSettings, setShowSettings] = useState(false);

  /** Sección inicial del modal de settings (para abrir directamente en "planes", etc.) */
  const [settingsSection, setSettingsSection] = useState<"cuenta" | "planes" | "canvas" | "productividad" | "acerca" | undefined>(undefined);

  /** true cuando el widget de Pomodoro está visible */
  const [showPomodoro, setShowPomodoro] = useState(false);

  const { loadSettings } = useTimerStore();

  // ── Estado de descarga de archivos ───────────────────────────
  /** ID local del documento que se está descargando/abriendo (null = ninguno) */
  const [downloadingDocId, setDownloadingDocId] = useState<number | null>(null);

  // ── Toast notifications ─────────────────────────────────────
  const { toasts, addToast, dismissToast } = useToasts();

  /** Guard: solo mostrar toast de indexación completa una vez por sesión de indexado */
  const indexToastShown = useRef(false);

  // ── Cargar settings del Pomodoro al montar ───────────────────
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // ── Verificar deadlines próximos al montar ───────────────────
  useEffect(() => {
    invoke<number>("check_upcoming_deadlines")
      .then((count) => {
        if (count > 0) {
          console.log(`[Deadlines] ${count} notificacion(es) enviadas`);
        }
      })
      .catch((err: unknown) => {
        // No bloquear al usuario — es una feature de conveniencia
        console.warn("[Deadlines] Error verificando deadlines:", err);
      });
  }, []);

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
  const cursoSeleccionadoNumId: number | null = (() => {
    if (!cursoSeleccionadoId) return null;
    const n = parseInt(cursoSeleccionadoId, 10);
    return isNaN(n) ? null : n;
  })();

  const { documents, loading: loadingDetalle } = useCourseDetail(cursoSeleccionadoNumId);

  const { sessions: chatSessions, refetch: refetchSessions } = useChatSessions(cursoSeleccionadoNumId);

  // ── Seleccionar primer curso al cargar ───────────────────────
  // Cuando los cursos cargan y no hay selección, seleccionamos el primero
  const cursos: Curso[] = courses.map((c) => ({
    id: String(c.id),
    nombre: cleanCourseName(c.code, c.name),
  }));

  // Auto-seleccionar el primer curso cuando cargan
  const firstCourseId = cursos.length > 0 ? cursos[0].id : null;
  if (!cursoSeleccionadoId && firstCourseId && !loadingCursos) {
    setCursoSeleccionadoId(firstCourseId);
  }

  // ── Curso seleccionado (objeto Curso) ────────────────────────
  const cursoSeleccionado = cursos.find((c) => c.id === cursoSeleccionadoId) ?? null;

  // ── Hook de chat ─────────────────────────────────────────────
  const {
    mensajes,
    setMensajes,
    cargando,
    currentSessionIdRef,
    chatActivoId,
    setChatActivoId,
    handleEnviarMensaje,
    handleSelectChat: handleSelectChatBase,
    handleDeleteChat,
    handleNuevaSession: handleNuevaSessionBase,
  } = useChat({
    cursoSeleccionadoNumId,
    cursoSeleccionado,
    refetchSessions,
  });

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

  // Canvas está conectado si hay al menos un curso sincronizado
  const canvasConectado = courses.length > 0;

  // ── Mapeo: documentos DB → Archivo (Sidebar) ─────────────────
  const archivos: Archivo[] = loadingDetalle
    ? []
    : documents.map((doc) => ({
        id: String(doc.id),
        nombre: doc.title,
        tipo: mapFileType(doc.file_type),
        carpeta: doc.file_type ? categorizeDocument(doc.file_type) : "Sin carpeta",
        isLoading: downloadingDocId === doc.id,
      }));

  const docById: Map<string, Document> = new Map(
    documents.map((doc) => [String(doc.id), doc])
  );

  // ── Mapeo: chat sessions DB → ChatReciente (Sidebar) ─────────
  const chatsRecientes: ChatReciente[] = chatSessions.map((s) => ({
    id: String(s.id),
    titulo: s.title ?? "Sin título",
    fechaRelativa: formatFechaRelativa(s.updated_at ?? s.created_at),
  }));

  // ── Callbacks ────────────────────────────────────────────────

  function handleSelectCurso(id: string) {
    // Fire-and-forget: generar resumen de la sesión que se abandona
    const prevId = currentSessionIdRef.current;
    if (prevId) {
      invoke("generate_session_summary", { sessionId: prevId }).catch(console.error);
    }
    setCursoSeleccionadoId(id);
    setSidebarExpandido(true);
    // Al cambiar de curso, empezar sesión nueva
    setMensajes([]);
    setChatActivoId(null);
    setTareasAbierto(false);
  }

  function handleToggleSidebar() {
    setSidebarExpandido((prev) => !prev);
  }

  async function handleSelectChat(id: string) {
    setTareasAbierto(false);
    await handleSelectChatBase(id);
  }

  function handleNuevaSession() {
    setTareasAbierto(false);
    handleNuevaSessionBase();
  }

  async function handleOpenArchivo(archivo: Archivo) {
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
          .catch((err: unknown) => console.error("[index] Error al indexar PDF:", err));
      }
    } catch (err) {
      console.error("[MainLayout] Error al abrir archivo:", err);
      // TODO: mostrar toast de error cuando se implemente el sistema de notificaciones
    } finally {
      setDownloadingDocId(null);
    }
  }

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
        onPomodoroClick={() => setShowPomodoro((prev) => !prev)}
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
        onOpenChangelog={onOpenChangelog}
        onForceOnboarding={onForceOnboarding}
      />

      {/* ── 6. Toast notifications ────────────────────────────── */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* ── 7. Pomodoro Widget ─────────────────────────────────── */}
      {showPomodoro && <PomodoroWidget onClose={() => setShowPomodoro(false)} />}
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
