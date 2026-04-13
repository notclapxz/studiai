// useChat.ts — Custom hook para el estado y lógica del chat
// Extrae handleEnviarMensaje, handleSelectChat, handleDeleteChat,
// handleNuevaSession y el estado de chat de MainLayout.

import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Database from "@tauri-apps/plugin-sql";
import type { Mensaje, ErrorType, ToolInvocation } from "../components/ChatPanel";
import type { PendingImage } from "../components/ChatInput";
import type { Curso } from "../components/Rail";

// Re-exportar tipos relevantes para uso externo

interface UseChatParams {
  cursoSeleccionadoNumId: number | null;
  cursoSeleccionado: Curso | null;
  refetchSessions: () => void;
}

interface UseChatReturn {
  mensajes: Mensaje[];
  setMensajes: React.Dispatch<React.SetStateAction<Mensaje[]>>;
  cargando: boolean;
  currentSessionId: number | null;
  currentSessionIdRef: React.RefObject<number | null>;
  chatActivoId: string | null;
  setChatActivoId: React.Dispatch<React.SetStateAction<string | null>>;
  handleEnviarMensaje: (texto: string, images?: PendingImage[]) => Promise<void>;
  handleSelectChat: (id: string) => Promise<void>;
  handleDeleteChat: (id: string) => Promise<void>;
  handleNuevaSession: () => void;
}

export function useChat({
  cursoSeleccionadoNumId,
  cursoSeleccionado,
  refetchSessions,
}: UseChatParams): UseChatReturn {
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

  const [chatActivoId, setChatActivoId] = useState<string | null>(null);

  // ── handleSelectChat ─────────────────────────────────────────

  async function handleSelectChat(id: string) {
    // Fire-and-forget: generar resumen de la sesión que se abandona
    const prevId = currentSessionIdRef.current;
    if (prevId) {
      invoke("generate_session_summary", { sessionId: prevId }).catch(console.error);
    }
    setChatActivoId(id);
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
    } catch (err: unknown) {
      console.error("[useChat] Error al cargar mensajes de la sesión:", err);
    }
  }

  // ── handleDeleteChat ─────────────────────────────────────────

  async function handleDeleteChat(id: string) {
    const sessionNumId = parseInt(id, 10);
    if (isNaN(sessionNumId)) return;

    try {
      const db = await Database.load("sqlite:studyai.db");
      await db.execute("DELETE FROM chat_messages WHERE session_id = $1", [sessionNumId]);
      await db.execute("DELETE FROM chat_sessions WHERE id = $1", [sessionNumId]);
    } catch (err: unknown) {
      console.error("[useChat] Error al eliminar chat:", err);
    }

    // Si el chat eliminado está activo, limpiar el panel
    if (chatActivoId === id) {
      setChatActivoId(null);
      setMensajes([]);
      setCurrentSessionId(null);
    }

    // Refrescar la lista de chats del sidebar
    refetchSessions();
  }

  // ── handleNuevaSession ───────────────────────────────────────

  function handleNuevaSession() {
    // Fire-and-forget: generar resumen de la sesión que se abandona
    const prevId = currentSessionIdRef.current;
    if (prevId) {
      invoke("generate_session_summary", { sessionId: prevId }).catch(console.error);
    }
    setChatActivoId(null);
    setMensajes([]);
    setCurrentSessionId(null);
  }

  // ── handleEnviarMensaje ──────────────────────────────────────

  /** Envía un mensaje al backend Rust y recibe la respuesta con streaming */
  async function handleEnviarMensaje(texto: string, images?: PendingImage[]) {
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
    } catch (err: unknown) {
      console.error("[useChat] Error al persistir mensaje del usuario:", err);
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
                .catch((err: unknown) =>
                  console.error("[useChat] Error al persistir respuesta del asistente:", err)
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
        } catch (err: unknown) {
          console.warn("[image] Resize failed, sending original:", err);
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
  }

  return {
    mensajes,
    setMensajes,
    cargando,
    currentSessionId,
    currentSessionIdRef,
    chatActivoId,
    setChatActivoId,
    handleEnviarMensaje,
    handleSelectChat,
    handleDeleteChat,
    handleNuevaSession,
  };
}
