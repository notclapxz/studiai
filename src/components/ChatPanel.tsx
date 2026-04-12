// ChatPanel.tsx — Panel principal del chat
// Muestra mensajes del historial, streaming de respuestas, y el input

import { useRef, useState } from "react";
import { BookOpen, Link, MessageSquare, Lock, AlertTriangle, Copy, Check, Search, Calendar, Bell, Sparkles, Loader2, ChevronDown, ChevronUp, Image as ImageIcon, Brain } from "lucide-react";
import "katex/dist/katex.min.css";
import { ChatInput, type PendingImage } from "./ChatInput";
import { useAuthStore } from "../store/authStore";
import { MarkdownContent } from "./MarkdownContent";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ErrorType = "sin_internet" | "token_expirado" | "rate_limit" | "generico";

/** Registro de una invocación de herramienta durante el streaming */
export interface ToolInvocation {
  /** Texto descriptivo de la herramienta (ej. "Buscando en tus materiales...") */
  label: string;
  /** Timestamp de cuándo se invocó */
  timestamp: number;
}

export interface Mensaje {
  id: string;
  rol: "usuario" | "asistente";
  contenido: string;
  timestamp: Date;
  /** Si true, el mensaje se está generando progresivamente (streaming) */
  streaming?: boolean;
  /** Texto de estado mientras el agente ejecuta tools (ej. "Buscando tus tareas...") */
  thinkingStatus?: string;
  /** Lista de herramientas invocadas durante la generación de este mensaje */
  toolInvocations?: ToolInvocation[];
  /**
   * Resúmenes del razonamiento del modelo (thinking-visible 2026-04-10).
   * Se llenan desde el evento `chat-stream-thought` durante el streaming.
   * Decisión: EFÍMEROS — no se persisten en SQLite (pueden ser muy largos,
   * rara vez se revisan después, evita migración de DB). Al recargar la página,
   * los mensajes antiguos no tendrán thoughts.
   */
  thoughts?: string[];
  /** Si presente, el mensaje es un error y se renderiza con estilo especial */
  errorType?: ErrorType;
  /** Imagenes adjuntas al mensaje (solo para mensajes de usuario) */
  images?: { base64: string; mediaType: string }[];
}

interface ChatPanelProps {
  mensajes: Mensaje[];
  /** Si true, la IA está generando una respuesta (muestra indicador) */
  cargando?: boolean;
  /** Si false, muestra card de "Conectar Canvas" */
  canvasConectado?: boolean;
  onEnviarMensaje: (texto: string, images?: PendingImage[]) => void;
  onConectarCanvas?: () => void;
  /** Callback para abrir la sección de Planes en Settings */
  onVerPlanes?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Formatea el timestamp de un mensaje a hora HH:MM */
function formatearHora(fecha: Date): string {
  return fecha.toLocaleTimeString("es-PE", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Helper: Mapear texto de tool a icono ───────────────────────────────────

function getToolIcon(label: string) {
  const l = label.toLowerCase();
  if (l.includes("materiales") || l.includes("buscando en")) return Search;
  if (l.includes("tareas") || l.includes("deadlines") || l.includes("próximas")) return Calendar;
  if (l.includes("anuncios") || l.includes("leyendo anuncios")) return Bell;
  if (l.includes("flashcards") || l.includes("preparando")) return Sparkles;
  return Loader2;
}

// ─── Subcomponente: Indicadores de herramientas (collapsible) ───────────────

interface ToolIndicatorsProps {
  invocations: ToolInvocation[];
  /** Si true, el mensaje aún está en streaming — mostrar expandido */
  streaming: boolean;
}

function ToolIndicators({ invocations, streaming }: ToolIndicatorsProps) {
  const [expanded, setExpanded] = useState(false);

  // Mientras está en streaming, siempre mostrar expandido
  const showExpanded = streaming || expanded;

  if (invocations.length === 0) return null;

  return (
    <div className="mt-1.5 mb-1">
      {showExpanded ? (
        <div className="flex flex-col gap-1">
          {invocations.map((inv, i) => {
            const Icon = getToolIcon(inv.label);
            // Only animate spinner while actively streaming — once done, show static icon
            const isSpinning = streaming && Icon === Loader2;
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md"
                style={{
                  background: "rgba(250,178,131,0.08)",
                  width: "fit-content",
                }}
              >
                <Icon
                  size={12}
                  strokeWidth={1.5}
                  style={{ color: "#fab283" }}
                  className={isSpinning ? "animate-spin" : ""}
                />
                <span
                  style={{
                    color: "#fab283",
                    fontSize: "11px",
                    lineHeight: "16px",
                  }}
                >
                  {inv.label}
                </span>
              </div>
            );
          })}
          {/* Botón para colapsar (solo cuando no está en streaming) */}
          {!streaming && (
            <button
              onClick={() => setExpanded(false)}
              className="flex items-center gap-1 mt-0.5 outline-none"
              style={{ background: "transparent", border: "none", cursor: "pointer" }}
            >
              <ChevronUp size={12} strokeWidth={1.5} style={{ color: "#6a6a6a" }} />
              <span style={{ color: "#6a6a6a", fontSize: "11px" }}>Ocultar</span>
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md outline-none"
          style={{
            background: "rgba(250,178,131,0.08)",
            border: "none",
            cursor: "pointer",
          }}
        >
          <Search size={12} strokeWidth={1.5} style={{ color: "#fab283" }} />
          <span style={{ color: "#fab283", fontSize: "11px" }}>
            {invocations.length === 1
              ? `Consultó 1 herramienta`
              : `Consultó ${invocations.length} herramientas`}
          </span>
          <ChevronDown size={12} strokeWidth={1.5} style={{ color: "#6a6a6a" }} />
        </button>
      )}
    </div>
  );
}

// ─── Subcomponente: Burbuja de mensaje ───────────────────────────────────────

interface BurbujaMensajeProps {
  mensaje: Mensaje;
}

function BurbujaMensaje({ mensaje }: BurbujaMensajeProps) {
  const esUsuario = mensaje.rol === "usuario";
  const [copiado, setCopiado] = useState(false);

  const copiarMensaje = async () => {
    try {
      await navigator.clipboard.writeText(mensaje.contenido);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Silently fail if clipboard API is not available
    }
  };

  // ── Burbuja de error ────────────────────────────────────────────────────────
  if (mensaje.errorType) {
    const isWarning = mensaje.errorType === "rate_limit";
    return (
      <div className="flex gap-2 mb-4 animate-fade-in flex-row">
        {/* Avatar de error */}
        <div
          className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center mt-0.5"
          style={{
            background: isWarning ? "rgba(250,178,131,0.15)" : "rgba(224,108,117,0.15)",
            color: isWarning ? "#fab283" : "#e06c75",
          }}
        >
          <AlertTriangle size={14} strokeWidth={1.5} />
        </div>

        {/* Burbuja de error */}
        <div
          className="max-w-[75%] rounded-2xl rounded-tl-sm px-4 py-2.5"
          style={{
            background: "rgba(224,108,117,0.1)",
            border: "1px solid rgba(224,108,117,0.2)",
          }}
        >
          <p
            className="text-sm leading-relaxed"
            style={{ color: isWarning ? "#fab283" : "#e06c75" }}
          >
            {mensaje.contenido}
          </p>
          <p
            className="mt-1 text-right"
            style={{ fontSize: "10px", color: "var(--text-weak)" }}
          >
            {formatearHora(mensaje.timestamp)}
          </p>
        </div>
      </div>
    );
  }

  // Helper: render thoughts block (thinking-visible) — usado en placeholder y burbuja final
  const renderThoughts = () => {
    if (!mensaje.thoughts || mensaje.thoughts.length === 0) return null;
    return (
      <details className="message-thoughts" open={!!mensaje.streaming}>
        <summary className="thoughts-header">
          <Brain size={12} strokeWidth={1.5} style={{ display: "inline", marginRight: 4, verticalAlign: "middle" }} />
          Razonamiento <span className="thoughts-disclaimer">(en ingles)</span> ({mensaje.thoughts.length} {mensaje.thoughts.length === 1 ? "paso" : "pasos"})
        </summary>
        <div className="thoughts-body">
          <MarkdownContent content={mensaje.thoughts.join("\n\n---\n\n")} />
        </div>
      </details>
    );
  };

  // No renderizar burbuja AI vacía — esperar el primer token
  // Excepción: si ya hay thoughts en streaming, mostrar el placeholder con thoughts visibles
  if (!esUsuario && !mensaje.contenido && mensaje.streaming) {
    const ThinkingIcon = mensaje.thinkingStatus ? getToolIcon(mensaje.thinkingStatus) : Loader2;
    const isSpinning = ThinkingIcon === Loader2;
    return (
      <div className="flex gap-2 mb-4 flex-row animate-fade-in">
        <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-bold mt-0.5"
          style={{ background: "var(--bg-surface-active)", color: "var(--text-base)" }}>
          AI
        </div>
        <div
          className="px-4 py-3 rounded-2xl rounded-tl-sm flex flex-col items-start gap-2"
          style={{ background: "#252525", border: "1px solid var(--border-base)" }}
        >
          {/* Razonamiento visible (thinking-visible) — aparece durante el stream */}
          {renderThoughts()}
          <div className="flex items-center gap-1.5">
            <span className="thinking-dot" style={{ animationDelay: "0ms" }} />
            <span className="thinking-dot" style={{ animationDelay: "160ms" }} />
            <span className="thinking-dot" style={{ animationDelay: "320ms" }} />
          </div>
          {/* Tool invocations acumuladas */}
          {mensaje.toolInvocations && mensaje.toolInvocations.length > 0 && (
            <ToolIndicators invocations={mensaje.toolInvocations} streaming={true} />
          )}
          <div className="flex items-center gap-1.5">
            <ThinkingIcon
              size={12}
              strokeWidth={1.5}
              style={{ color: "#fab283" }}
              className={isSpinning ? "animate-spin" : ""}
            />
            <p className="text-xs" style={{ color: "#6a6a6a", margin: 0 }}>
              {mensaje.thinkingStatus || "Pensando..."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex gap-2 mb-4 animate-fade-in ${esUsuario ? "flex-row-reverse" : "flex-row"}`}
    >
      {/* Avatar del rol */}
      <div
        className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-bold mt-0.5"
        style={{
          background: esUsuario
            ? "var(--accent)"
            : "var(--bg-surface-active)",
          color: esUsuario ? "white" : "var(--text-base)",
        }}
      >
        {esUsuario ? "Tú" : "AI"}
      </div>

      {/* Burbuja */}
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-2.5 relative group ${
          esUsuario ? "rounded-tr-sm" : "rounded-tl-sm"
        }`}
        style={{
          background: esUsuario
            ? "var(--accent)"
            : "var(--bg-surface-hover)",
          border: esUsuario ? "none" : "1px solid var(--border-base)",
        }}
      >
        {/* Botón copiar — solo en mensajes de asistente */}
        {!esUsuario && !mensaje.errorType && (
          <button
            onClick={copiarMensaje}
            className="absolute top-2 right-2 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-150 outline-none"
            style={{ background: "transparent" }}
            title="Copiar mensaje"
          >
            {copiado ? (
              <Check size={14} strokeWidth={1.5} style={{ color: "#7fd88f" }} />
            ) : (
              <Copy
                size={14}
                strokeWidth={1.5}
                className="chat-copy-icon"
                style={{ color: "#6a6a6a" }}
              />
            )}
          </button>
        )}
        {/* Contenido del mensaje */}
        {esUsuario ? (
          <>
            {mensaje.images && mensaje.images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {mensaje.images.map((img, idx) => (
                  <img
                    key={idx}
                    src={`data:${img.mediaType};base64,${img.base64}`}
                    className="h-16 w-16 object-cover rounded"
                    alt="Imagen enviada"
                  />
                ))}
              </div>
            )}
            <p
              className="text-sm leading-relaxed whitespace-pre-wrap"
              style={{ color: "white" }}
            >
              {mensaje.contenido}
            </p>
          </>
        ) : (
          <div
            className="text-sm leading-relaxed prose prose-sm prose-invert max-w-none"
            style={{ color: "var(--text-base)" }}
          >
            {/* Razonamiento visible (thinking-visible) — collapsible, arriba del contenido */}
            {renderThoughts()}
            <MarkdownContent content={mensaje.contenido} />
            {/* Tool invocations — collapsible cuando no está en streaming */}
            {mensaje.toolInvocations && mensaje.toolInvocations.length > 0 && (
              <ToolIndicators
                invocations={mensaje.toolInvocations}
                streaming={!!mensaje.streaming}
              />
            )}
            {/* Estado del agente mientras ejecuta tools — visible y claro */}
            {mensaje.streaming && mensaje.thinkingStatus && (() => {
              const StatusIcon = getToolIcon(mensaje.thinkingStatus!);
              const spinning = StatusIcon === Loader2;
              return (
                <div
                  className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg"
                  style={{ background: "rgba(250,178,131,0.08)", border: "1px solid rgba(250,178,131,0.15)" }}
                >
                  <StatusIcon
                    size={14}
                    strokeWidth={1.5}
                    style={{ color: "#fab283" }}
                    className={spinning ? "animate-spin" : ""}
                  />
                  <p className="text-xs font-medium" style={{ color: "#fab283", margin: 0 }}>
                    {mensaje.thinkingStatus}
                  </p>
                  <div className="flex items-center gap-1 ml-1">
                    <span className="thinking-dot" style={{ animationDelay: "0ms" }} />
                    <span className="thinking-dot" style={{ animationDelay: "160ms" }} />
                    <span className="thinking-dot" style={{ animationDelay: "320ms" }} />
                  </div>
                </div>
              );
            })()}
            {/* Cursor animado durante streaming (sin thinking activo) */}
            {mensaje.streaming && !mensaje.thinkingStatus && (
              <span
                className="inline-block w-0.5 h-4 ml-0.5 align-middle animate-pulse"
                style={{ background: "var(--text-base)" }}
              />
            )}
          </div>
        )}

        {/* Hora */}
        <p
          className="mt-1 text-right"
          style={{
            fontSize: "10px",
            color: esUsuario ? "rgba(255,255,255,0.5)" : "var(--text-weak)",
          }}
        >
          {formatearHora(mensaje.timestamp)}
        </p>
      </div>
    </div>
  );
}

// ─── Subcomponente: Card de bienvenida (sin Canvas) ──────────────────────────

interface CardBienvenidaProps {
  onConectarCanvas?: () => void;
}

function CardBienvenida({ onConectarCanvas }: CardBienvenidaProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div
        className="text-center max-w-sm space-y-4 p-8 rounded-2xl"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-base)",
        }}
      >
        <div className="flex justify-center" style={{ color: "var(--accent)" }}>
          <BookOpen size={40} strokeWidth={1} />
        </div>
        <div>
          <h2
            className="text-lg font-semibold mb-1"
            style={{ color: "var(--text-strong)" }}
          >
            Bienvenido a StudiAI
          </h2>
          <p className="text-sm" style={{ color: "var(--text-weak)" }}>
            Hola! Soy tu asistente de estudio. Para comenzar, conecta tu cuenta
            de Canvas.
          </p>
        </div>

        <button
          onClick={onConectarCanvas}
          className="flex items-center gap-2 mx-auto px-5 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150 outline-none"
          style={{
            background: "var(--accent)",
            color: "white",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background =
              "var(--accent-hover)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--accent)";
          }}
        >
          <Link size={16} strokeWidth={1.5} />
          Conectar Canvas
        </button>

        <p className="text-xs" style={{ color: "var(--text-ghost)" }}>
          O selecciona un curso del panel izquierdo para empezar
        </p>
      </div>
    </div>
  );
}

// ─── Subcomponente: Estado vacío (Canvas conectado pero sin mensajes) ─────────

function EstadoVacio() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center space-y-3">
        <div className="flex justify-center" style={{ color: "var(--text-weak)" }}>
          <MessageSquare size={32} strokeWidth={1} />
        </div>
        <p
          className="text-sm font-medium"
          style={{ color: "var(--text-base)" }}
        >
          Hola! Soy tu asistente de estudio
        </p>
        <p className="text-sm" style={{ color: "var(--text-weak)" }}>
          ¿En qué te ayudo hoy?
        </p>
      </div>
    </div>
  );
}

// ─── Subcomponente: Indicador de escritura ───────────────────────────────────

function IndicadorEscritura() {
  return (
    <div className="flex gap-2 mb-4 animate-fade-in">
      <div
        className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-bold"
        style={{ background: "var(--bg-surface-active)", color: "var(--text-base)" }}
      >
        AI
      </div>
      <div
        className="px-4 py-3 rounded-2xl rounded-tl-sm flex flex-col items-start gap-2"
        style={{
          background: "#252525",
          border: "1px solid var(--border-base)",
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="thinking-dot" style={{ animationDelay: "0ms" }} />
          <span className="thinking-dot" style={{ animationDelay: "160ms" }} />
          <span className="thinking-dot" style={{ animationDelay: "320ms" }} />
        </div>
        <p className="text-xs" style={{ color: "#6a6a6a", margin: 0 }}>
          Pensando...
        </p>
      </div>
    </div>
  );
}

// ─── Subcomponente: Chat bloqueado por licencia expirada o no verificada ────

interface ChatBloqueadoProps {
  onVerPlanes?: () => void;
  /**
   * "expired"  → trial vencido, usuario debe suscribirse.
   * "unknown"  → no se pudo verificar online y no hay cache utilizable;
   *              mostramos boton "Reintentar" en vez de "Ver planes".
   */
  motivo?: "expired" | "unknown";
}

function ChatBloqueado({ onVerPlanes, motivo = "expired" }: ChatBloqueadoProps) {
  const esUnknown = motivo === "unknown";
  const titulo = esUnknown
    ? "Verificando tu licencia..."
    : "Tu prueba gratuita ha terminado";
  const subtitulo = esUnknown
    ? "No pudimos confirmar tu licencia. Revisa tu conexion y reintenta."
    : "Suscribete para seguir usando el chat con IA";
  const cta = esUnknown ? "Reintentar" : "Ver planes";

  const handleClick = () => {
    if (esUnknown) {
      // Fuerza una nueva verificacion online; si tiene exito el chat se
      // desbloquea solo via el store.
      useAuthStore.getState().checkLicense();
    } else {
      onVerPlanes?.();
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div
        className="text-center max-w-sm space-y-4 p-8 rounded-2xl"
        style={{
          background: "#252525",
          border: "1px solid var(--border-base)",
        }}
      >
        {/* Lock icon */}
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto"
          style={{ background: "rgba(250,178,131,0.1)" }}
        >
          <Lock size={28} strokeWidth={1.5} style={{ color: "#fab283" }} />
        </div>

        {/* Title */}
        <h2
          className="text-lg font-semibold"
          style={{ color: "var(--text-strong)" }}
        >
          {titulo}
        </h2>

        {/* Subtitle */}
        <p className="text-sm" style={{ color: "var(--text-weak)" }}>
          {subtitulo}
        </p>

        {/* CTA button */}
        <button
          onClick={handleClick}
          className="flex items-center gap-2 mx-auto px-6 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150 outline-none"
          style={{
            background: "#fab283",
            color: "#212121",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "#fbc49e";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "#fab283";
          }}
        >
          {cta}
        </button>
      </div>
    </div>
  );
}

// ─── Componente principal: ChatPanel ─────────────────────────────────────────

export function ChatPanel({
  mensajes,
  cargando = false,
  canvasConectado = false,
  onEnviarMensaje,
  onConectarCanvas,
  onVerPlanes,
}: ChatPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { licenseStatus } = useAuthStore();
  // Gateamos el chat en cualquier estado que no sea claramente valido.
  // `unknown` (fail-secure: no pudimos verificar online y no hay cache utilizable)
  // tambien bloquea, asi un atacante que rompa red + cache no obtiene chat gratis.
  const chatBloqueado =
    licenseStatus === "expired" || licenseStatus === "unknown";
  const motivoBloqueo: "expired" | "unknown" =
    licenseStatus === "unknown" ? "unknown" : "expired";
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [droppedImage, setDroppedImage] = useState<PendingImage | null>(null);

  // Auto-scroll desactivado por preferencia del usuario

  // Drag & drop handlers a nivel de todo el panel
  function handlePanelDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      setIsDraggingOver(true);
    }
  }
  function handlePanelDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Solo ocultar si sale del section completo
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      setIsDraggingOver(false);
    }
  }
  function handlePanelDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/") && file.size <= 4 * 1024 * 1024) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setDroppedImage({ base64, mediaType: file.type, name: file.name || "imagen.png" });
      };
      reader.readAsDataURL(file);
    }
  }

  return (
    <section
      className="flex flex-col flex-1 min-w-0 overflow-hidden relative"
      style={{ background: "var(--bg-base)" }}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      {/* Overlay de drag & drop */}
      {isDraggingOver && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center"
          style={{ background: "rgba(250,178,131,0.08)", border: "3px dashed #fab283", borderRadius: "12px" }}
        >
          <div className="flex flex-col items-center gap-2">
            <ImageIcon size={40} strokeWidth={1} style={{ color: "#fab283" }} />
            <p className="text-sm font-medium" style={{ color: "#fab283" }}>Suelta la imagen aqui</p>
          </div>
        </div>
      )}
      {/* ── Área de mensajes (o estado vacío / sin Canvas) ─── */}
      {!canvasConectado ? (
        <>
          <CardBienvenida onConectarCanvas={onConectarCanvas} />
          {chatBloqueado ? (
            <ChatBloqueado onVerPlanes={onVerPlanes} motivo={motivoBloqueo} />
          ) : (
            <ChatInput
              onEnviar={onEnviarMensaje}
              deshabilitado={false}
              placeholder="Escribe un mensaje..."
              externalImage={droppedImage}
              onExternalImageClear={() => setDroppedImage(null)}
            />
          )}
        </>
      ) : mensajes.length === 0 && !cargando ? (
        <>
          <EstadoVacio />
          {chatBloqueado ? (
            <ChatBloqueado onVerPlanes={onVerPlanes} motivo={motivoBloqueo} />
          ) : (
            <ChatInput
              onEnviar={onEnviarMensaje}
              placeholder="Escribe un mensaje..."
              externalImage={droppedImage}
              onExternalImageClear={() => setDroppedImage(null)}
            />
          )}
        </>
      ) : (
        <>
          {/* Lista de mensajes con scroll */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {mensajes.map((mensaje) => (
              <BurbujaMensaje key={mensaje.id} mensaje={mensaje} />
            ))}

            {/* Indicador de escritura de la IA */}
            {cargando && <IndicadorEscritura />}

            {/* Anchor para auto-scroll */}
            <div ref={bottomRef} />
          </div>

          {/* Input del chat o mensaje de bloqueo */}
          {chatBloqueado ? (
            <ChatBloqueado onVerPlanes={onVerPlanes} motivo={motivoBloqueo} />
          ) : (
            <ChatInput
              onEnviar={onEnviarMensaje}
              deshabilitado={cargando}
              placeholder={
                cargando ? "Esperando respuesta..." : "Escribe un mensaje..."
              }
              externalImage={droppedImage}
              onExternalImageClear={() => setDroppedImage(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

export default ChatPanel;
