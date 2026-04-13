// AcercaSection.tsx — Sección "Acerca de" en SettingsModal

import { open as openExternal } from "@tauri-apps/plugin-shell";
import { BookOpen, ExternalLink, RefreshCw, Sparkles } from "lucide-react";

// ─── Props ──────────────────────────────────────────────────────────────────

interface AcercaSectionProps {
  appVersion: string;
  onOpenChangelog?: () => void;
  onClose: () => void;
  onForceOnboarding?: () => void;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function AcercaSection({
  appVersion,
  onOpenChangelog,
  onClose,
  onForceOnboarding,
}: AcercaSectionProps) {
  return (
    <div className="space-y-5 animate-fade-in">
      {/* App info */}
      <div className="flex items-center gap-3">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "rgba(250,178,131,0.15)" }}
        >
          <BookOpen size={20} strokeWidth={1.5} style={{ color: "#fab283" }} />
        </div>
        <div>
          <p className="text-sm font-bold" style={{ color: "#e0e0e0" }}>
            StudyAI
          </p>
          {/* Versión dinámica — placeholder "—" mientras carga */}
          <p className="text-xs" style={{ color: "#6a6a6a" }}>
            {appVersion ? `Versión ${appVersion}` : "—"}
          </p>
        </div>
      </div>

      <div
        className="rounded-xl p-4 space-y-3"
        style={{ background: "#252525", border: "1px solid #4b4c5c" }}
      >
        <p className="text-xs" style={{ color: "#e0e0e0" }}>
          Hecho para estudiantes de USIL
        </p>
        <p className="text-[11px] leading-relaxed" style={{ color: "#6a6a6a" }}>
          StudyAI conecta tu cuenta de Canvas para ayudarte a estudiar de forma
          mas eficiente con inteligencia artificial. Tus datos se almacenan
          localmente en tu computadora.
        </p>
      </div>

      {/* Links y acciones */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => void openExternal("mailto:feedback@studyai.app")}
          className="flex items-center gap-2 text-xs transition-colors duration-150 bg-transparent border-0 p-0 cursor-pointer"
          style={{ color: "#5c9cf5" }}
        >
          <ExternalLink size={13} strokeWidth={1.5} />
          Enviar feedback
        </button>

        {/* Link externo al sitio del autor */}
        <button
          type="button"
          onClick={() => void openExternal("https://clapxz.com")}
          className="flex items-center gap-2 text-xs transition-colors duration-150 bg-transparent border-0 p-0 cursor-pointer"
          style={{ color: "#5c9cf5" }}
        >
          <ExternalLink size={13} strokeWidth={1.5} />
          clapxz.com
        </button>

        {/* Abrir ChangelogModal manualmente */}
        {onOpenChangelog && (
          <button
            type="button"
            onClick={onOpenChangelog}
            className="flex items-center gap-2 text-xs transition-colors duration-150 bg-transparent border-0 p-0 cursor-pointer"
            style={{ color: "#5c9cf5" }}
          >
            <Sparkles size={13} strokeWidth={1.5} />
            ¿Qué hay de nuevo?
          </button>
        )}
      </div>

      {/* Botón Repetir tutorial */}
      <div>
        <button
          type="button"
          onClick={() => {
            onClose();
            onForceOnboarding?.();
          }}
          className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-medium transition-colors duration-150"
          style={{
            background: "#252525",
            border: "1px solid #4b4c5c",
            color: "#e0e0e0",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "#2e2e2e";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "#252525";
          }}
        >
          <RefreshCw size={13} strokeWidth={1.5} />
          Repetir tutorial
        </button>
      </div>

      {/* Build info */}
      <p className="text-[10px]" style={{ color: "#4b4c5c" }}>
        Tauri 2 · React 19 · Rust
      </p>
    </div>
  );
}
