// ChangelogModal.tsx — Muestra release notes después de una actualización
// Se abre automáticamente si la versión actual difiere de last_seen_version.
// También puede abrirse manualmente desde Settings → Acerca de.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { X, Sparkles } from "lucide-react";
import { marked } from "marked";

// Texto de fallback cuando no hay release notes guardadas
const FALLBACK_BODY = "Mejoras de rendimiento y corrección de errores.";

interface ChangelogModalProps {
  /** Si true, al cerrar NO actualiza last_seen_version (modo "ver de nuevo" manual) */
  skipVersionUpdate?: boolean;
  onClose: () => void;
}

export function ChangelogModal({ skipVersionUpdate = false, onClose }: ChangelogModalProps) {
  const [contentHtml, setContentHtml] = useState<string>("");
  const [version, setVersion] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadContent() {
      try {
        const [currentVersion, rawBody] = await Promise.all([
          getVersion(),
          invoke<string | null>("get_setting", { key: "pending_changelog_body" }),
        ]);

        setVersion(currentVersion);

        const body = rawBody && rawBody.trim() !== "" ? rawBody : null;
        if (body) {
          // Parsear Markdown usando marked.parse (API de marked v7+)
          const html = await marked.parse(body);
          setContentHtml(typeof html === "string" ? html : FALLBACK_BODY);
        } else {
          setContentHtml(`<p>${FALLBACK_BODY}</p>`);
        }
      } catch (err: unknown) {
        console.warn("[ChangelogModal] Error cargando contenido:", err);
        setContentHtml(`<p>${FALLBACK_BODY}</p>`);
      } finally {
        setLoading(false);
      }
    }

    void loadContent();
  }, []);

  async function handleClose() {
    if (!skipVersionUpdate && version) {
      try {
        await invoke("set_setting", { key: "last_seen_version", value: version });
      } catch (err: unknown) {
        console.warn("[ChangelogModal] No se pudo guardar last_seen_version:", err);
      }
    }
    onClose();
  }

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) void handleClose();
      }}
    >
      {/* Modal */}
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl overflow-hidden"
        style={{
          background: "#1a1a1a",
          border: "1px solid #2e2e2e",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid #2e2e2e" }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "rgba(250,178,131,0.15)" }}
            >
              <Sparkles size={16} strokeWidth={1.5} style={{ color: "#fab283" }} />
            </div>
            <div>
              <p className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
                ¿Qué hay de nuevo?
              </p>
              {version && (
                <p className="text-[11px]" style={{ color: "#6a6a6a" }}>
                  Versión {version}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={() => void handleClose()}
            className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors duration-100"
            style={{ color: "#6a6a6a" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "#252525";
              (e.currentTarget as HTMLButtonElement).style.color = "#e0e0e0";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "#6a6a6a";
            }}
            aria-label="Cerrar"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-96 overflow-y-auto">
          {loading ? (
            // Skeleton placeholder mientras carga
            <div className="space-y-2">
              {[80, 60, 90, 50].map((w) => (
                <div
                  key={w}
                  className="h-3 rounded animate-pulse"
                  style={{ width: `${w}%`, background: "#2e2e2e" }}
                />
              ))}
            </div>
          ) : (
            <div
              className="changelog-body text-sm leading-relaxed"
              style={{ color: "#c0c0c0" }}
              // Markdown parseado por `marked` — contenido propio de la app, no user input
              // biome-ignore lint/security/noDangerouslySetInnerHtml: source is app's own update body
              dangerouslySetInnerHTML={{ __html: contentHtml }}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-4 flex justify-end"
          style={{ borderTop: "1px solid #2e2e2e" }}
        >
          <button
            onClick={() => void handleClose()}
            className="px-4 py-2 rounded-xl text-sm font-medium transition-colors duration-150"
            style={{ background: "#fab283", color: "#1a1a1a" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "#f9a26e";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "#fab283";
            }}
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
