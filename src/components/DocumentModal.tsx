// DocumentModal.tsx — Modal emergente "Crear documento".
// Pre-rellena con los defaults persistidos (get_document_style) y permite un
// override OPCIONAL por-documento. Al generar:
//   1. Si hay override y hay sesión activa → set_pending_style_override (DB).
//      El backend lo consume one-shot dentro de create_pdf (merge + clear).
//   2. Notifica al chat (onGenerate) con una instrucción para que el AGENTE
//      llame create_pdf — create_pdf es invocado por el modelo, no por el front.
// El modal NO muta los defaults; el override vive en la fila transitoria.

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { StyleFields } from "./settings/StyleFields";
import { type StyleConfig, STYLE_DEFAULTS } from "../lib/documentStyle";

type DocType = "informe" | "presentacion" | "tarea";

const DOC_TYPE_LABELS: Record<DocType, string> = {
  informe: "Informe",
  presentacion: "Presentación",
  tarea: "Tarea",
};

interface DocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Sesión de chat activa; null si aún no se ha enviado el primer mensaje. */
  sessionId: number | null;
  /** Curso activo para pre-rellenar el campo (opcional). */
  defaultCourse?: string;
  /**
   * Inyecta una instrucción en el chat para que el agente genere el documento.
   * El front NO llama create_pdf directamente (decisión de diseño #3).
   */
  onGenerate?: (instruction: string) => void;
}

export function DocumentModal({
  isOpen,
  onClose,
  sessionId,
  defaultCourse = "",
  onGenerate,
}: DocumentModalProps) {
  const [defaults, setDefaults] = useState<StyleConfig>(STYLE_DEFAULTS);
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState(defaultCourse);
  const [docType, setDocType] = useState<DocType>("informe");
  const [override, setOverride] = useState(false);
  const [overrideConfig, setOverrideConfig] = useState<StyleConfig>(STYLE_DEFAULTS);
  const [generating, setGenerating] = useState(false);

  // Al abrir: cargar defaults persistidos y resetear el formulario.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setTitle("");
    setCourse(defaultCourse);
    setDocType("informe");
    setOverride(false);
    (async () => {
      try {
        const result = await invoke<StyleConfig>("get_document_style");
        if (!cancelled) {
          setDefaults(result);
          setOverrideConfig(result); // override parte de los defaults
        }
      } catch (err: unknown) {
        console.error("Error cargando estilo de documento:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, defaultCourse]);

  async function handleGenerate() {
    setGenerating(true);
    try {
      // 1. Persistir override transitorio (solo si hay sesión: el scope es
      //    per-chat-session). Sin sesión activa el override no se ancla y se
      //    usan los defaults (limitación conocida del primer mensaje).
      if (override && sessionId !== null) {
        await invoke("set_pending_style_override", { sessionId, config: overrideConfig });
      }

      // 2. Pedir al agente que genere (él llama create_pdf y consume el override).
      const tipo = DOC_TYPE_LABELS[docType].toLowerCase();
      const partes = [`Genera ${tipo === "informe" ? "un informe" : tipo === "tarea" ? "una tarea" : "una presentación"}`];
      if (title.trim()) partes.push(`titulado "${title.trim()}"`);
      if (course.trim()) partes.push(`para el curso "${course.trim()}"`);
      const instruction = `${partes.join(" ")}.`;
      onGenerate?.(instruction);

      onClose();
    } catch (err: unknown) {
      console.error("Error preparando documento:", err);
    } finally {
      setGenerating(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          background: "var(--bg-modal)",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--border-ui)",
          maxWidth: 440,
          width: "92vw",
          maxHeight: "82vh",
          boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderBottom: "1px solid var(--border-ui)" }}
        >
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
            Crear documento
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-100"
            style={{ color: "var(--text-weak)" }}
            aria-label="Cerrar"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Body scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Título */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
              Título
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej. Introducción a la termodinámica"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "var(--bg-surface-active)",
                border: "1px solid var(--border-ui)",
                color: "var(--text-strong)",
              }}
            />
          </div>

          {/* Curso */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
              Curso
            </label>
            <input
              type="text"
              value={course}
              onChange={(e) => setCourse(e.target.value)}
              placeholder="Ej. Física II"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "var(--bg-surface-active)",
                border: "1px solid var(--border-ui)",
                color: "var(--text-strong)",
              }}
            />
          </div>

          {/* Tipo de documento */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
              Tipo de documento
            </label>
            <div className="flex gap-2">
              {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => {
                const selected = docType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setDocType(t)}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-100"
                    style={
                      selected
                        ? { background: "var(--accent-warm)", color: "var(--bg-modal)" }
                        : {
                            background: "var(--bg-surface-active)",
                            color: "var(--text-strong)",
                            border: "1px solid var(--border-ui)",
                          }
                    }
                    aria-pressed={selected}
                  >
                    {DOC_TYPE_LABELS[t]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Resumen del estilo en uso */}
          <div
            className="text-xs rounded-lg px-3 py-2"
            style={{ background: "var(--bg-modal-nav)", color: "var(--text-muted)" }}
          >
            Estilo: <strong>{defaults.format.toUpperCase()}</strong> · {defaults.font_family} ·{" "}
            {defaults.font_size}pt · márgenes {defaults.margins_cm}cm
          </div>

          {/* Toggle override */}
          <label
            className="flex items-center gap-2 text-sm cursor-pointer"
            style={{ color: "var(--text-strong)" }}
          >
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            Cambiar estilo para este documento
          </label>

          {/* Panel de override (compact) */}
          {override && (
            <div
              className="pl-3 pt-1"
              style={{ borderLeft: "2px solid var(--accent-warm)" }}
            >
              <StyleFields config={overrideConfig} onChange={(patch) => setOverrideConfig((prev) => ({ ...prev, ...patch }))} compact />
            </div>
          )}
        </div>

        {/* Footer acciones */}
        <div
          className="flex gap-2 px-5 py-3 shrink-0"
          style={{ borderTop: "1px solid var(--border-ui)" }}
        >
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: "var(--bg-surface-active)", color: "var(--text-strong)" }}
          >
            Cancelar
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: "var(--accent)", color: "white", opacity: generating ? 0.7 : 1 }}
          >
            {generating ? "Generando…" : "Generar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DocumentModal;
