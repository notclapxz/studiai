// DocumentosSection.tsx — Sección "Documentos" del SettingsModal.
// Container: carga el estilo persistido (get_document_style) y AUTO-GUARDA cada
// cambio (set_document_style) sin botón explícito (design decision: "guardado
// auto, sin boton"). La UI de campos vive en StyleFields (presentacional).

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, Check } from "lucide-react";
import { StyleFields } from "./StyleFields";
import { type StyleConfig, STYLE_DEFAULTS } from "../../lib/documentStyle";

export function DocumentosSection() {
  const [config, setConfig] = useState<StyleConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState(0); // timestamp para feedback "guardado"

  // Carga inicial del estilo persistido.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<StyleConfig>("get_document_style");
        if (!cancelled) setConfig(result);
      } catch (err: unknown) {
        console.error("Error cargando estilo de documento:", err);
        if (!cancelled) setConfig(STYLE_DEFAULTS); // degradación: defaults editables
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Optimistic update + persistencia. Si el backend rechaza (validación de
  // enums), revertimos al valor previo para no mentir sobre lo guardado.
  async function handleChange(patch: Partial<StyleConfig>) {
    if (!config) return;
    const previous = config;
    const updated = { ...config, ...patch };
    setConfig(updated);
    try {
      await invoke("set_document_style", { config: updated });
      setSavedAt(Date.now());
    } catch (err: unknown) {
      console.error("Error guardando estilo de documento:", err);
      setConfig(previous); // rollback
    }
  }

  if (loading || !config) {
    return (
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Cargando…
      </p>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Encabezado */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={15} strokeWidth={1.5} style={{ color: "var(--accent-warm)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
            Estilo por defecto
          </p>
        </div>
        {savedAt > 0 && (
          <span
            className="flex items-center gap-1 text-xs"
            style={{ color: "var(--success)" }}
          >
            <Check size={12} strokeWidth={2} />
            Guardado
          </span>
        )}
      </div>

      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Se aplica a todos los documentos que generes. Puedes cambiarlo solo para un
        documento concreto desde el botón "Crear documento" en el chat.
      </p>

      <StyleFields config={config} onChange={handleChange} />
    </div>
  );
}
