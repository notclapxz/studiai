// Sidebar.tsx — Segunda columna con archivos del curso y chats recientes
// 240px fijo, expandible/colapsable con Cmd+B

import { useEffect } from "react";
import { RefreshCw, Sparkles, BookOpen, Folder, FileText, Paperclip, MessageSquare, Loader2, Trash2, Plus, X } from "lucide-react";
import type { Curso } from "./Rail";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface Archivo {
  id: string;
  nombre: string;
  tipo: "pdf" | "docx" | "xlsx" | "pptx" | "img" | "otro";
  carpeta?: string;
  /** true mientras se descarga/abre este archivo */
  isLoading?: boolean;
  /** null = documento manual; número = archivo de Canvas */
  canvasFileId?: number | null;
}

export interface ChatReciente {
  id: string;
  titulo: string;
  fechaRelativa: string; // ej: "hoy", "ayer", "3 días"
}

interface SidebarProps {
  expandido: boolean;
  onToggle: () => void;
  cursoSeleccionado: Curso | null;
  archivos: Archivo[];
  chatsRecientes: ChatReciente[];
  chatActivoId: string | null;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onNuevaSession: () => void;
  onOpenArchivo: (archivo: Archivo) => void;
  onSync: () => void;
  /** Abre el file picker para subir PDFs manualmente */
  onAddManualPdf?: () => void;
  /** Elimina un documento manual por su id numérico */
  onDeleteManualDocument?: (docId: number) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Devuelve el icono Lucide correspondiente al tipo de archivo.
 *  Documentos manuales (canvasFileId === null) usan Paperclip para distinguirlos visualmente. */
function IconoArchivo({ tipo, esManual }: { tipo: Archivo["tipo"]; esManual?: boolean }) {
  if (esManual) return <Paperclip size={14} strokeWidth={1.5} />;
  if (tipo === "otro") return <Folder size={14} strokeWidth={1.5} />;
  return <FileText size={14} strokeWidth={1.5} />;
}

// ─── Subcomponente: Ítem de archivo ──────────────────────────────────────────

interface ItemArchivoProps {
  archivo: Archivo;
  onOpen: (archivo: Archivo) => void;
  onDelete?: (docId: number) => void;
}

function ItemArchivo({ archivo, onOpen, onDelete }: ItemArchivoProps) {
  const isLoading = archivo.isLoading ?? false;
  const esManual = archivo.canvasFileId === null;

  return (
    <div
      className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md group transition-colors duration-100"
      onMouseEnter={(e) => {
        if (!isLoading) {
          (e.currentTarget as HTMLElement).style.background = "var(--bg-surface-hover)";
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {/* Zona clickeable para abrir */}
      <button
        onClick={() => !isLoading && onOpen(archivo)}
        disabled={isLoading}
        className="flex-1 flex items-center gap-2 text-left outline-none disabled:opacity-60 disabled:cursor-wait min-w-0"
        title={isLoading ? "Descargando…" : archivo.nombre}
      >
        <span className="shrink-0" style={{ color: esManual ? "var(--accent-warm)" : "var(--text-weak)" }}>
          {isLoading ? (
            <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
          ) : (
            <IconoArchivo tipo={archivo.tipo} esManual={esManual} />
          )}
        </span>
        <span
          className="text-xs truncate"
          style={{ color: "var(--text-base)" }}
          title={archivo.nombre}
        >
          {archivo.nombre}
        </span>
      </button>

      {/* Botón eliminar — solo en documentos manuales */}
      {esManual && onDelete && (
        <button
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-100 outline-none"
          style={{ color: "var(--text-weak)" }}
          title="Eliminar documento"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(parseInt(archivo.id, 10));
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--error)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
          }}
        >
          <X size={12} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

// ─── Subcomponente: Ítem de chat reciente ─────────────────────────────────────

interface ItemChatProps {
  chat: ChatReciente;
  activo: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function ItemChat({ chat, activo, onSelect, onDelete }: ItemChatProps) {
  return (
    <button
      onClick={() => onSelect(chat.id)}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors duration-100 outline-none group"
      style={{
        background: activo ? "var(--bg-surface-active)" : "transparent",
        color: activo ? "var(--text-strong)" : "var(--text-base)",
      }}
      onMouseEnter={(e) => {
        if (!activo) {
          (e.currentTarget as HTMLElement).style.background =
            "var(--bg-surface-hover)";
        }
      }}
      onMouseLeave={(e) => {
        if (!activo) {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }
      }}
    >
      <span className="text-xs shrink-0" style={{ color: "var(--text-weak)" }}>
        —
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs truncate">{chat.titulo}</p>
        <p
          className="text-xs"
          style={{ color: "var(--text-weak)", fontSize: "11px" }}
        >
          {chat.fechaRelativa}
        </p>
      </div>
      <span
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-100 cursor-pointer"
        style={{ color: "var(--text-weak)" }}
        title="Eliminar chat"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(chat.id);
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--error)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
        }}
      >
        <Trash2 size={14} strokeWidth={1.5} />
      </span>
    </button>
  );
}

// ─── Subcomponente: Encabezado de sección ─────────────────────────────────────

function SectionHeader({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div
      className="px-3 py-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider"
      style={{ color: "var(--text-weak)", fontSize: "11px" }}
    >
      <span style={{ color: "var(--text-weak)" }}>{icon}</span>
      {label}
    </div>
  );
}

// ─── Componente principal: Sidebar ────────────────────────────────────────────

export function Sidebar({
  expandido,
  onToggle,
  cursoSeleccionado,
  archivos,
  chatsRecientes,
  chatActivoId,
  onSelectChat,
  onDeleteChat,
  onNuevaSession,
  onOpenArchivo,
  onSync,
  onAddManualPdf,
  onDeleteManualDocument,
}: SidebarProps) {
  // ── Atajo Cmd+B para expandir/colapsar ───────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        onToggle();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggle]);

  // Agrupar archivos por carpeta
  const carpetas = archivos.reduce<Record<string, Archivo[]>>((acc, archivo) => {
    const carpeta = archivo.carpeta ?? "Sin carpeta";
    if (!acc[carpeta]) acc[carpeta] = [];
    acc[carpeta].push(archivo);
    return acc;
  }, {});

  return (
    <aside
      className="flex flex-col overflow-hidden shrink-0 transition-all duration-200"
      style={{
        width: expandido ? "var(--sidebar-width, 240px)" : "0px",
        opacity: expandido ? 1 : 0,
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border-base)",
        minWidth: expandido ? "var(--sidebar-width, 240px)" : "0px",
      }}
    >
      {/* Contenido (invisible cuando está colapsado) */}
      <div className="flex flex-col h-full" style={{ width: "240px" }}>
        {/* ── Header: nombre del curso ──────────────────── */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: "1px solid var(--border-base)" }}
        >
          <div className="flex-1 min-w-0">
            <p
              className="text-sm font-semibold truncate"
              style={{ color: "var(--text-strong)" }}
            >
              {cursoSeleccionado?.nombre ?? "Sin curso seleccionado"}
            </p>
          </div>
          {/* Botón sync */}
          <button
            onClick={onSync}
            className="w-6 h-6 rounded flex items-center justify-center shrink-0 transition-colors duration-100 outline-none"
            style={{ color: "var(--text-weak)" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--text-base)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
            }}
            title="Sincronizar con Canvas"
          >
            <RefreshCw size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* ── Botón nueva sesión ────────────────────────── */}
        <div className="px-3 pt-3 pb-2 shrink-0">
          <button
            onClick={onNuevaSession}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md text-xs font-medium transition-colors duration-100 outline-none"
            style={{
              background: "var(--accent-subtle, rgba(37,99,235,0.12))",
              color: "var(--accent)",
              border: "1px solid rgba(37,99,235,0.2)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "rgba(37,99,235,0.2)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "rgba(37,99,235,0.12)";
            }}
          >
            <Sparkles size={14} strokeWidth={1.5} />
            Nueva sesión
          </button>
        </div>

        {/* ── Scroll area ──────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {/* Sección: Archivos del curso */}
          <div className="pb-2">
            {/* Header con botón "+" para agregar PDF manual */}
            <div className="flex items-center justify-between px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                <span style={{ color: "var(--text-weak)" }}>
                  <BookOpen size={12} strokeWidth={1.5} />
                </span>
                <span
                  className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-weak)", fontSize: "11px" }}
                >
                  Materiales
                </span>
              </div>
              {onAddManualPdf && (
                <button
                  onClick={onAddManualPdf}
                  title="Agregar PDF"
                  className="w-5 h-5 rounded flex items-center justify-center transition-colors duration-100 outline-none"
                  style={{ color: "var(--text-weak)" }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "var(--text-base)";
                    (e.currentTarget as HTMLElement).style.background = "var(--bg-surface-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = "var(--text-weak)";
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                >
                  <Plus size={12} strokeWidth={2} />
                </button>
              )}
            </div>

            {Object.entries(carpetas).map(([carpeta, archivosEnCarpeta]) => (
              <div key={carpeta} className="mb-1">
                {/* Nombre de carpeta */}
                <div
                  className="flex items-center gap-1.5 px-3 py-1 text-xs"
                  style={{ color: "var(--text-weak)" }}
                >
                  <Folder size={12} strokeWidth={1.5} />
                  <span className="truncate">{carpeta}</span>
                </div>

                {/* Archivos dentro de la carpeta */}
                <div className="pl-3">
                  {archivosEnCarpeta.map((archivo) => (
                    <ItemArchivo
                      key={archivo.id}
                      archivo={archivo}
                      onOpen={onOpenArchivo}
                      onDelete={onDeleteManualDocument}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Estado vacío */}
            {archivos.length === 0 && (
              <div className="px-3 py-4 flex flex-col items-center gap-2">
                <p className="text-xs text-center" style={{ color: "var(--text-weak)" }}>
                  No hay materiales en este curso
                </p>
                {onAddManualPdf && (
                  <button
                    onClick={onAddManualPdf}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors duration-100 outline-none"
                    style={{
                      color: "var(--accent)",
                      background: "var(--accent-subtle)",
                      border: "1px dashed var(--accent-warm-border, var(--border-base))",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "var(--accent-warm-subtle, var(--accent-subtle))";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = "var(--accent-subtle)";
                    }}
                  >
                    <Plus size={12} strokeWidth={2} />
                    Agregar PDF
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Separador */}
          <div
            className="mx-3 my-2"
            style={{ height: "1px", background: "var(--border-base)" }}
          />

          {/* Sección: Chats recientes */}
          <div className="pb-3">
            <SectionHeader
              label="Chats recientes"
              icon={<MessageSquare size={12} strokeWidth={1.5} />}
            />

            {chatsRecientes.map((chat) => (
              <ItemChat
                key={chat.id}
                chat={chat}
                activo={chatActivoId === chat.id}
                onSelect={onSelectChat}
                onDelete={onDeleteChat}
              />
            ))}

            {/* Estado vacío */}
            {chatsRecientes.length === 0 && (
              <div
                className="px-3 py-3 text-xs text-center"
                style={{ color: "var(--text-weak)" }}
              >
                Sin chats recientes
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
