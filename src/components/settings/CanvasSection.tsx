// CanvasSection.tsx — Sección de configuración de Canvas en SettingsModal

import { useState } from "react";
import {
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { SyncProgressPanel } from "../SyncProgress";
import type { SyncProgress } from "../SyncProgress";

// ─── Tipos ──────────────────────────────────────────────────────────────────

interface CanvasUserInfo {
  name?: string;
  display_name?: string;
  short_name?: string;
  primary_email?: string;
}

type VerificationStatus = "idle" | "loading" | "success" | "error";

// ─── Props ──────────────────────────────────────────────────────────────────

interface CanvasSectionProps {
  canvasUrl: string;
  canvasToken: string;
  showToken: boolean;
  verificationStatus: VerificationStatus;
  userInfo: CanvasUserInfo | null;
  errorMessage: string;
  isSaving: boolean;
  syncProgress: SyncProgress;
  lastSyncAt: string | null;
  showSyncPanel: boolean;
  hasExistingSync: boolean;
  isSyncing: boolean;
  onCanvasUrlChange: (value: string) => void;
  onCanvasTokenChange: (value: string) => void;
  onShowTokenChange: (value: boolean) => void;
  onVerifyAndSave: () => void;
  onResync: () => void;
  onClose: () => void;
  normalizeCanvasUrl: (url: string) => string;
  formatLastSync: (isoDate: string) => string;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function CanvasSection({
  canvasUrl,
  canvasToken,
  showToken,
  verificationStatus,
  userInfo,
  errorMessage,
  isSaving,
  syncProgress,
  lastSyncAt,
  showSyncPanel,
  hasExistingSync,
  isSyncing,
  onCanvasUrlChange,
  onCanvasTokenChange,
  onShowTokenChange,
  onVerifyAndSave,
  onResync,
  onClose,
  normalizeCanvasUrl,
  formatLastSync,
}: CanvasSectionProps) {
  const [showInstructions, setShowInstructions] = useState(false);

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Sync panel */}
      {showSyncPanel && (
        <SyncProgressPanel
          progress={syncProgress}
          userName={
            userInfo?.name ??
            userInfo?.display_name ??
            userInfo?.short_name ??
            (canvasUrl ? normalizeCanvasUrl(canvasUrl) : "tu cuenta")
          }
          onGoToCourses={onClose}
          onRetry={onResync}
        />
      )}

      {/* Last sync banner */}
      {hasExistingSync && (
        <div
          className="rounded-xl p-3 flex items-center justify-between gap-3"
          style={{ background: "#252525", border: "1px solid #4b4c5c" }}
        >
          <div>
            <p className="text-xs font-medium" style={{ color: "#e0e0e0" }}>
              Canvas conectado
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: "#6a6a6a" }}>
              Ultima sync: {formatLastSync(lastSyncAt ?? "")}
            </p>
          </div>
          <button
            onClick={onResync}
            className="flex items-center gap-1 text-[11px] shrink-0 transition-colors duration-150"
            style={{ color: "#5c9cf5" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "0.7";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "1";
            }}
          >
            <RefreshCw size={12} strokeWidth={1.5} />
            Re-sincronizar
          </button>
        </div>
      )}

      {/* Form */}
      <div className="space-y-3">
        {/* Canvas URL */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium" style={{ color: "#e0e0e0" }}>
            URL de Canvas
          </label>
          <input
            type="text"
            value={canvasUrl}
            onChange={(e) => onCanvasUrlChange(e.target.value)}
            placeholder="usil.instructure.com"
            className="w-full rounded-lg px-3 py-2 text-xs outline-none transition-colors duration-150"
            style={{
              background: "#1a1a1a",
              border: "1px solid #4b4c5c",
              color: "#e0e0e0",
            }}
            onFocus={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "#fab283";
            }}
            onBlur={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "#4b4c5c";
            }}
          />
          <p className="text-[11px]" style={{ color: "#6a6a6a" }}>
            Solo el dominio, sin https:// — ej: <code style={{ color: "#9d7cd8" }}>canvas.upc.edu.pe</code>
          </p>
        </div>

        {/* Token */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium" style={{ color: "#e0e0e0" }}>
            Token de Acceso Personal
          </label>
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={canvasToken}
              onChange={(e) => onCanvasTokenChange(e.target.value)}
              placeholder="Token generado en Canvas"
              className="w-full rounded-lg px-3 py-2 pr-10 text-xs outline-none transition-colors duration-150 font-mono"
              style={{
                background: "#1a1a1a",
                border: "1px solid #4b4c5c",
                color: "#e0e0e0",
              }}
              onFocus={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "#fab283";
              }}
              onBlur={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = "#4b4c5c";
              }}
            />
            <button
              type="button"
              onClick={() => onShowTokenChange(!showToken)}
              className="absolute right-2 top-1/2 -translate-y-1/2 transition-colors duration-100"
              style={{ color: "#6a6a6a" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#e0e0e0";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "#6a6a6a";
              }}
              aria-label={showToken ? "Ocultar token" : "Mostrar token"}
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* Save button */}
        <button
          onClick={onVerifyAndSave}
          disabled={verificationStatus === "loading" || isSaving || syncProgress.phase === "syncing"}
          className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-1.5 disabled:opacity-40"
          style={{ background: "#5c9cf5", color: "#fff" }}
          onMouseEnter={(e) => {
            if (!(e.currentTarget as HTMLButtonElement).disabled) {
              (e.currentTarget as HTMLElement).style.opacity = "0.85";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
        >
          {verificationStatus === "loading" || isSaving ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              Verificando...
            </>
          ) : (
            "Guardar y verificar"
          )}
        </button>

        {/* Success message */}
        {verificationStatus === "success" && userInfo && !isSyncing && (
          <div
            className="flex items-start gap-2 rounded-lg p-3"
            style={{ background: "rgba(127,216,143,0.1)", border: "1px solid rgba(127,216,143,0.25)" }}
          >
            <CheckCircle size={14} className="mt-0.5 shrink-0" style={{ color: "#7fd88f" }} />
            <div>
              <p className="text-xs font-medium" style={{ color: "#7fd88f" }}>
                Conectado exitosamente
              </p>
              <p className="text-xs mt-0.5" style={{ color: "#7fd88f", opacity: 0.8 }}>
                {userInfo.name ?? userInfo.display_name ?? userInfo.short_name}
              </p>
            </div>
          </div>
        )}

        {/* Error message */}
        {verificationStatus === "error" && errorMessage && (
          <div
            className="flex items-start gap-2 rounded-lg p-3"
            style={{ background: "rgba(224,108,117,0.1)", border: "1px solid rgba(224,108,117,0.25)" }}
          >
            <XCircle size={14} className="mt-0.5 shrink-0" style={{ color: "#e06c75" }} />
            <div>
              <p className="text-xs font-medium" style={{ color: "#e06c75" }}>
                Error de verificacion
              </p>
              <p className="text-xs mt-0.5" style={{ color: "#e06c75", opacity: 0.8 }}>
                {errorMessage}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Instructions collapsible */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: "#252525", border: "1px solid #4b4c5c" }}
      >
        <button
          onClick={() => setShowInstructions(!showInstructions)}
          className="flex items-center justify-between w-full px-3 py-2.5 text-xs font-medium transition-colors duration-100"
          style={{ color: "#e0e0e0" }}
        >
          <span>Como obtener el token de Canvas?</span>
          {showInstructions ? (
            <ChevronUp size={14} style={{ color: "#6a6a6a" }} />
          ) : (
            <ChevronDown size={14} style={{ color: "#6a6a6a" }} />
          )}
        </button>

        {showInstructions && (
          <div className="px-3 pb-3 animate-fade-in">
            <ol className="space-y-1.5 text-[11px]" style={{ color: "#6a6a6a" }}>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "#4b4c5c" }}>1.</span>
                <span>
                  Inicia sesion en Canvas y ve a{" "}
                  <strong style={{ color: "#e0e0e0" }}>Cuenta</strong> →{" "}
                  <strong style={{ color: "#e0e0e0" }}>Configuracion</strong>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "#4b4c5c" }}>2.</span>
                <span>
                  Busca la seccion{" "}
                  <strong style={{ color: "#e0e0e0" }}>Tokens de Acceso Aprobados</strong>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "#4b4c5c" }}>3.</span>
                <span>
                  Haz clic en{" "}
                  <strong style={{ color: "#e0e0e0" }}>+ Nuevo Token de Acceso</strong>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "#4b4c5c" }}>4.</span>
                <span>
                  Asigna un proposito (ej: &quot;StudyAI&quot;) y genera el token
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "#4b4c5c" }}>5.</span>
                <span>Copia el token generado — solo se muestra una vez</span>
              </li>
            </ol>

            {canvasUrl && (
              <a
                href={`https://${normalizeCanvasUrl(canvasUrl)}/profile/settings`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] mt-2 transition-colors duration-150"
                style={{ color: "#5c9cf5" }}
              >
                Abrir configuracion de Canvas
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        )}
      </div>

      {/* Privacy note */}
      <p className="text-center text-[10px]" style={{ color: "#4b4c5c" }}>
        Tu token se guarda localmente y nunca se envia a servidores externos
      </p>
    </div>
  );
}
