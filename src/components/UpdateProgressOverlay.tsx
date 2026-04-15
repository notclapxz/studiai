// UpdateProgressOverlay.tsx — Overlay de progreso de instalación de update
// Cubre toda la pantalla, no se puede cerrar, persiste hasta que la app se reinicia.

import { useEffect, useState } from "react";
import { Loader2, Download, CheckCircle } from "lucide-react";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type UpdatePhase =
  | "downloading"   // descargando el binario
  | "installing"    // instalando (post-descarga)
  | "relaunching";  // relaunch() llamado — app a punto de cerrar

interface UpdateProgressOverlayProps {
  /** Si true, el overlay es visible */
  visible: boolean;
  phase: UpdatePhase;
  /** Progreso de descarga 0–100, undefined si no disponible */
  downloadPercent?: number;
  version: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function phaseLabel(phase: UpdatePhase, percent?: number): string {
  switch (phase) {
    case "downloading":
      return percent != null && percent > 0
        ? `Descargando actualización... ${percent}%`
        : "Descargando actualización...";
    case "installing":
      return "Instalando actualización...";
    case "relaunching":
      return "Reiniciando la aplicación...";
  }
}

function phaseSubLabel(phase: UpdatePhase): string {
  switch (phase) {
    case "downloading":
      return "Esto puede tardar unos segundos según tu conexión.";
    case "installing":
      return "No cierres la aplicación manualmente.";
    case "relaunching":
      return "La app se reiniciará en un momento con la nueva versión.";
  }
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function UpdateProgressOverlay({
  visible,
  phase,
  downloadPercent,
  version,
}: UpdateProgressOverlayProps) {
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => setOpacity(1));
    } else {
      setOpacity(0);
    }
  }, [visible]);

  if (!visible) return null;

  const isRelaunching = phase === "relaunching";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(13,13,13,0.92)",
        backdropFilter: "blur(8px)",
        opacity,
        transition: "opacity 0.3s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
          padding: "40px 48px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-ui)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
          minWidth: 320,
          maxWidth: 400,
          textAlign: "center",
        }}
      >
        {/* Icono animado */}
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: isRelaunching ? "var(--success-subtle)" : "var(--accent-warm-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isRelaunching ? (
            <CheckCircle
              size={28}
              strokeWidth={1.5}
              style={{ color: "var(--success)" }}
            />
          ) : phase === "downloading" ? (
            <Download
              size={28}
              strokeWidth={1.5}
              style={{ color: "var(--accent-warm)" }}
            />
          ) : (
            <Loader2
              size={28}
              strokeWidth={1.5}
              className="animate-spin"
              style={{ color: "var(--accent-warm)" }}
            />
          )}
        </div>

        {/* Versión */}
        <span
          style={{
            fontSize: 11,
            color: "var(--accent-warm)",
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            background: "var(--accent-warm-subtle)",
            padding: "2px 10px",
            borderRadius: "var(--radius-full)",
          }}
        >
          v{version}
        </span>

        {/* Label principal */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p
            style={{
              color: "var(--text-strong)",
              fontSize: 15,
              fontWeight: 600,
              margin: 0,
              lineHeight: 1.4,
            }}
          >
            {phaseLabel(phase, downloadPercent)}
          </p>
          <p
            style={{
              color: "var(--text-weak)",
              fontSize: 12,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {phaseSubLabel(phase)}
          </p>
        </div>

        {/* Barra de progreso — solo durante descarga */}
        {phase === "downloading" && (
          <div
            style={{
              width: "100%",
              height: 4,
              borderRadius: 2,
              background: "var(--border-ui)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                borderRadius: 2,
                background: "var(--accent-warm)",
                width: downloadPercent != null && downloadPercent > 0
                  ? `${downloadPercent}%`
                  : "100%",
                transition: downloadPercent != null ? "width 0.3s ease" : "none",
                // Si no hay porcentaje, animación indeterminada
                animation: downloadPercent == null || downloadPercent === 0
                  ? "indeterminate-progress 1.4s ease-in-out infinite"
                  : "none",
              }}
            />
          </div>
        )}

        {/* Spinner de 3 puntos durante installing/relaunching */}
        {(phase === "installing" || phase === "relaunching") && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Loader2
              size={14}
              strokeWidth={1.5}
              className="animate-spin"
              style={{ color: "var(--text-weak)" }}
            />
            <span style={{ fontSize: 12, color: "var(--text-weak)" }}>
              {phase === "relaunching" ? "Cerrando app..." : "Un momento..."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
