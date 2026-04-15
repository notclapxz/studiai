// CanvasSection.tsx — Sección de configuración de Canvas en SettingsModal

import { useState, useEffect } from "react";
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
  AlertTriangle,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
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

interface StoragePreferenceInfo {
  preference: string; // "db_only" | "local_folder" | ""
  path?: string | null;
}

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
  /** Indica que el guardado detectó un cambio de usuario Canvas — muestra banner de limpieza */
  userChanged?: boolean;
  /** Callback para abrir el StoragePreferenceModal desde MainLayout */
  onChangeStoragePreference?: () => void;
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
  userChanged = false,
  onChangeStoragePreference,
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
  const [showUserChangedBanner, setShowUserChangedBanner] = useState(false);
  const [storageInfo, setStorageInfo] = useState<StoragePreferenceInfo | null>(null);

  // Mostrar banner de cambio de usuario durante 5s cuando userChanged pasa a true
  useEffect(() => {
    if (userChanged) {
      setShowUserChangedBanner(true);
      const timer = setTimeout(() => setShowUserChangedBanner(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [userChanged]);

  // Cargar preferencia de almacenamiento al montar
  useEffect(() => {
    invoke<{ preference: string; path?: string | null }>("get_storage_preference")
      .then((info) => setStorageInfo(info))
      .catch((err: unknown) => {
        console.warn("[CanvasSection] Error leyendo storage_preference:", err);
      });
  }, []);

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

      {/* Banner: cambio de usuario detectado */}
      {showUserChangedBanner && (
        <div
          className="rounded-xl p-3 flex items-start gap-2"
          style={{
            background: "var(--warning-subtle, rgba(255,180,0,0.12))",
            border: "1px solid rgba(255,180,0,0.3)",
          }}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: "var(--warning, #f59e0b)" }} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium" style={{ color: "var(--warning, #f59e0b)" }}>
              Usuario cambiado
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-weak)" }}>
              Los datos del usuario anterior fueron eliminados
            </p>
          </div>
          <button
            onClick={() => setShowUserChangedBanner(false)}
            className="shrink-0 text-[10px] transition-opacity duration-150"
            style={{ color: "var(--text-ghost)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
            aria-label="Cerrar aviso"
          >
            ✕
          </button>
        </div>
      )}

      {/* Last sync banner */}
      {hasExistingSync && (
        <div
          className="rounded-xl p-3 flex items-center justify-between gap-3"
          style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
        >
          <div>
            <p className="text-xs font-medium" style={{ color: "var(--text-strong)" }}>
              Canvas conectado
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-weak)" }}>
              Ultima sync: {formatLastSync(lastSyncAt ?? "")}
            </p>
          </div>
          <button
            onClick={onResync}
            className="flex items-center gap-1 text-[11px] shrink-0 transition-opacity duration-150"
            style={{ color: "var(--accent)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
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
          <label className="block text-xs font-medium" style={{ color: "var(--text-strong)" }}>
            URL de Canvas
          </label>
          <input
            type="text"
            value={canvasUrl}
            onChange={(e) => onCanvasUrlChange(e.target.value)}
            placeholder="usil.instructure.com"
            className="w-full rounded-lg px-3 py-2 text-xs outline-none transition-colors duration-150"
            style={{
              background: "var(--bg-modal-nav)",
              border: "1px solid var(--border-ui)",
              color: "var(--text-strong)",
            }}
            onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-warm)"; }}
            onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-ui)"; }}
          />
          <p className="text-[11px]" style={{ color: "var(--text-weak)" }}>
            Solo el dominio, sin https:// — ej: <code style={{ color: "var(--accent)" }}>canvas.upc.edu.pe</code>
          </p>
        </div>

        {/* Token */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium" style={{ color: "var(--text-strong)" }}>
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
                background: "var(--bg-modal-nav)",
                border: "1px solid var(--border-ui)",
                color: "var(--text-strong)",
              }}
              onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-warm)"; }}
              onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-ui)"; }}
            />
            <button
              type="button"
              onClick={() => onShowTokenChange(!showToken)}
              className="absolute right-2 top-1/2 -translate-y-1/2 transition-colors duration-100"
              style={{ color: "var(--text-weak)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-strong)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-weak)"; }}
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
          className="w-full py-2 rounded-lg text-xs font-semibold transition-opacity duration-150 flex items-center justify-center gap-1.5 disabled:opacity-40"
          style={{ background: "var(--accent)", color: "var(--text-strong)" }}
          onMouseEnter={(e) => {
            if (!(e.currentTarget as HTMLButtonElement).disabled) {
              (e.currentTarget as HTMLElement).style.opacity = "0.85";
            }
          }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
        >
          {verificationStatus === "loading" || isSaving ? (
            <><Loader2 size={13} className="animate-spin" />Verificando...</>
          ) : "Guardar y verificar"}
        </button>

        {/* Success message */}
        {verificationStatus === "success" && userInfo && !isSyncing && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg p-3"
            style={{ background: "var(--success-subtle)", border: "1px solid rgba(127,216,143,0.25)" }}
          >
            <div className="flex items-start gap-2 min-w-0">
              <CheckCircle size={14} className="mt-0.5 shrink-0" style={{ color: "var(--success)" }} />
              <div className="min-w-0">
                <p className="text-xs font-medium" style={{ color: "var(--success)" }}>
                  Conectado exitosamente
                </p>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--success)", opacity: 0.8 }}>
                  {userInfo.name ?? userInfo.display_name ?? userInfo.short_name}
                </p>
              </div>
            </div>
            {/* Botón siempre visible para forzar re-sync después de verificar */}
            <button
              onClick={onResync}
              className="flex items-center gap-1 text-[11px] shrink-0 transition-opacity duration-150"
              style={{ color: "var(--success)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
            >
              <RefreshCw size={12} strokeWidth={1.5} />
              {hasExistingSync ? "Re-sincronizar" : "Sincronizar"}
            </button>
          </div>
        )}

        {/* Error message */}
        {verificationStatus === "error" && errorMessage && (
          <div
            className="flex items-start gap-2 rounded-lg p-3"
            style={{ background: "var(--error-subtle)", border: "1px solid rgba(224,108,117,0.25)" }}
          >
            <XCircle size={14} className="mt-0.5 shrink-0" style={{ color: "var(--error)" }} />
            <div>
              <p className="text-xs font-medium" style={{ color: "var(--error)" }}>
                Error de verificacion
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--error)", opacity: 0.8 }}>
                {errorMessage}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Instructions collapsible */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
      >
        <button
          onClick={() => setShowInstructions(!showInstructions)}
          className="flex items-center justify-between w-full px-3 py-2.5 text-xs font-medium transition-colors duration-100"
          style={{ color: "var(--text-strong)" }}
        >
          <span>Como obtener el token de Canvas?</span>
          {showInstructions ? (
            <ChevronUp size={14} style={{ color: "var(--text-weak)" }} />
          ) : (
            <ChevronDown size={14} style={{ color: "var(--text-weak)" }} />
          )}
        </button>

        {showInstructions && (
          <div className="px-3 pb-3 animate-fade-in">
            <ol className="space-y-1.5 text-[11px]" style={{ color: "var(--text-weak)" }}>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "var(--border-ui)" }}>1.</span>
                <span>
                  Inicia sesion en Canvas y ve a{" "}
                  <strong style={{ color: "var(--text-strong)" }}>Cuenta</strong> →{" "}
                  <strong style={{ color: "var(--text-strong)" }}>Configuracion</strong>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "var(--border-ui)" }}>2.</span>
                <span>
                  Busca la seccion{" "}
                  <strong style={{ color: "var(--text-strong)" }}>Tokens de Acceso Aprobados</strong>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "var(--border-ui)" }}>3.</span>
                <span>
                  Haz clic en{" "}
                  <strong style={{ color: "var(--text-strong)" }}>+ Nuevo Token de Acceso</strong>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "var(--border-ui)" }}>4.</span>
                <span>Asigna un proposito (ej: &quot;StudyAI&quot;) y genera el token</span>
              </li>
              <li className="flex gap-1.5">
                <span className="shrink-0" style={{ color: "var(--border-ui)" }}>5.</span>
                <span>Copia el token generado — solo se muestra una vez</span>
              </li>
            </ol>

            {canvasUrl && (
              <a
                href={`https://${normalizeCanvasUrl(canvasUrl)}/profile/settings`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] mt-2 transition-opacity duration-150"
                style={{ color: "var(--accent)" }}
              >
                Abrir configuracion de Canvas
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        )}
      </div>

      {/* Sección: Almacenamiento de materiales */}
      <div
        className="rounded-xl p-3"
        style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium" style={{ color: "var(--text-strong)" }}>
              Almacenamiento de materiales
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--text-weak)" }}>
              {storageInfo?.preference === "db_only" && "Solo base de datos"}
              {storageInfo?.preference === "local_folder" && (
                storageInfo.path
                  ? <span title={storageInfo.path} style={{ wordBreak: "break-all" }}>
                      Carpeta local: {storageInfo.path}
                    </span>
                  : "Carpeta predeterminada de la app"
              )}
              {(!storageInfo?.preference || storageInfo.preference === "") &&
                "No configurado aún"}
            </p>
            {storageInfo?.preference === "local_folder" && storageInfo.path && (
              <p className="text-[10px] mt-0.5" style={{ color: "var(--text-ghost)" }}>
                Los archivos nuevos se guardan aquí. Los existentes no se mueven.
              </p>
            )}
            {storageInfo?.preference === "db_only" && (
              <p className="text-[10px] mt-0.5" style={{ color: "var(--text-ghost)" }}>
                Aplica a descargas futuras
              </p>
            )}
          </div>
          {onChangeStoragePreference && (
            <button
              onClick={onChangeStoragePreference}
              className="text-[11px] transition-opacity duration-150 shrink-0"
              style={{ color: "var(--accent)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.7"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
            >
              Cambiar
            </button>
          )}
        </div>
      </div>

      {/* Privacy note */}
      <p className="text-center text-[10px]" style={{ color: "var(--text-ghost)" }}>
        Tu token se guarda localmente y nunca se envia a servidores externos
      </p>
    </div>
  );
}
