// StoragePreferenceModal.tsx — Modal de primera vez para elegir dónde guardar PDFs
// No puede cerrarse sin elegir una opción — bloquea la fase de descarga de Canvas.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "../lib/cn";

// ─── Props ────────────────────────────────────────────────────────────────────

interface StoragePreferenceModalProps {
  open: boolean;
  fileCount: number;
  onChooseDb: () => Promise<void>;
  onChooseFolder: () => Promise<void>;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function StoragePreferenceModal({
  open: isOpen,
  fileCount,
  onChooseDb,
  onChooseFolder,
}: StoragePreferenceModalProps) {
  const [loadingDb, setLoadingDb] = useState(false);
  const [loadingFolder, setLoadingFolder] = useState(false);

  if (!isOpen) return null;

  async function handleChooseDb() {
    setLoadingDb(true);
    try {
      await onChooseDb();
    } finally {
      setLoadingDb(false);
    }
  }

  async function handleChooseFolder() {
    setLoadingFolder(true);
    try {
      // Abrir selector de directorio nativo
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Elegir carpeta para guardar materiales",
      });

      if (!selected) {
        // Usuario canceló — modal permanece abierto
        setLoadingFolder(false);
        return;
      }

      const folderPath = typeof selected === "string" ? selected : selected[0];
      if (!folderPath) {
        setLoadingFolder(false);
        return;
      }

      // Guardar preferencia en backend
      await invoke("set_storage_preference", {
        preference: "local_folder",
        path: folderPath,
      });

      await onChooseFolder();
    } catch (err) {
      console.error("[StoragePreferenceModal] Error eligiendo carpeta:", err);
      setLoadingFolder(false);
    }
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] flex items-center justify-center settings-modal-backdrop"
      )}
    >
      <div
        className="settings-modal-content flex flex-col"
        style={{
          background: "var(--bg-modal)",
          borderRadius: "var(--radius-xl)",
          border: "1px solid var(--border-ui)",
          maxWidth: 540,
          width: "92vw",
          boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
          padding: "24px",
        }}
      >
        {/* Header */}
        <div className="mb-5">
          <h2
            className="text-base font-semibold mb-1"
            style={{ color: "var(--text-strong)" }}
          >
            ¿Dónde querés guardar tus materiales?
          </h2>
          <p className="text-xs" style={{ color: "var(--text-weak)" }}>
            Solo necesitás elegir una vez. Podés cambiarlo en Configuración →
            Canvas.
          </p>
        </div>

        {/* Cards */}
        <div className="flex gap-3 mb-5">
          {/* Card: Solo base de datos (RECOMENDADO) */}
          <div
            className="flex-1 flex flex-col rounded-xl p-4"
            style={{
              border: "2px solid var(--accent-warm)",
              background: "var(--accent-warm-subtle)",
            }}
          >
            {/* Badge recomendado */}
            <span
              className="self-start text-[10px] font-semibold px-2 py-0.5 rounded-full mb-3"
              style={{
                background: "var(--accent-warm)",
                color: "var(--bg-modal)",
              }}
            >
              Recomendado
            </span>

            <div className="text-xl mb-2">💾</div>
            <h3
              className="text-xs font-semibold mb-3"
              style={{ color: "var(--text-strong)" }}
            >
              Solo base de datos
            </h3>

            <ul className="space-y-1.5 mb-4 flex-1">
              <li className="flex items-start gap-1.5 text-[11px]" style={{ color: "var(--text-base)" }}>
                <span style={{ color: "var(--success)" }}>✓</span>
                Menos espacio en disco
              </li>
              <li className="flex items-start gap-1.5 text-[11px]" style={{ color: "var(--text-base)" }}>
                <span style={{ color: "var(--success)" }}>✓</span>
                Todo en la app
              </li>
              <li className="flex items-start gap-1.5 text-[11px]" style={{ color: "var(--text-weak)" }}>
                <span style={{ color: "var(--error)" }}>✗</span>
                Sin acceso manual al PDF
              </li>
              <li
                className="flex items-start gap-1.5 text-[11px] rounded-lg p-2 mt-2"
                style={{
                  background: "var(--accent-warm-subtle)",
                  border: "1px solid var(--accent-warm-border)",
                  color: "var(--text-weak)",
                }}
              >
                <span>⚡</span>
                <span>
                  Después de indexar, el PDF no se usa para el chat con IA
                </span>
              </li>
            </ul>

            <button
              onClick={handleChooseDb}
              disabled={loadingDb || loadingFolder}
              className="w-full py-2 rounded-lg text-xs font-semibold transition-opacity duration-150 disabled:opacity-50"
              style={{
                background: "var(--accent-warm)",
                color: "var(--bg-modal)",
              }}
              onMouseEnter={(e) => {
                if (!(e.currentTarget as HTMLButtonElement).disabled) {
                  (e.currentTarget as HTMLElement).style.opacity = "0.85";
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = "1";
              }}
            >
              {loadingDb ? "Guardando..." : "Usar base de datos"}
            </button>
          </div>

          {/* Card: Carpeta local */}
          <div
            className="flex-1 flex flex-col rounded-xl p-4"
            style={{
              border: "1px solid var(--border-ui)",
              background: "var(--bg-modal-nav)",
            }}
          >
            <div className="text-xl mb-2 mt-5">📁</div>
            <h3
              className="text-xs font-semibold mb-3"
              style={{ color: "var(--text-strong)" }}
            >
              Carpeta local
            </h3>

            <ul className="space-y-1.5 mb-4 flex-1">
              <li className="flex items-start gap-1.5 text-[11px]" style={{ color: "var(--text-base)" }}>
                <span style={{ color: "var(--success)" }}>✓</span>
                Acceso a PDFs desde el sistema
              </li>
              <li className="flex items-start gap-1.5 text-[11px]" style={{ color: "var(--text-base)" }}>
                <span style={{ color: "var(--success)" }}>✓</span>
                Backup propio de tus archivos
              </li>
              <li className="flex items-start gap-1.5 text-[11px]" style={{ color: "var(--text-weak)" }}>
                <span style={{ color: "var(--error)" }}>✗</span>
                Más espacio en disco
              </li>
              <li className="flex items-start gap-1.5 text-[11px]" style={{ color: "var(--text-weak)" }}>
                <span style={{ color: "var(--error)" }}>✗</span>
                El PDF no se usa para el chat
              </li>
            </ul>

            <button
              onClick={handleChooseFolder}
              disabled={loadingDb || loadingFolder}
              className="w-full py-2 rounded-lg text-xs font-semibold transition-opacity duration-150 disabled:opacity-50"
              style={{
                background: "var(--bg-surface-active)",
                color: "var(--text-strong)",
                border: "1px solid var(--border-ui)",
              }}
              onMouseEnter={(e) => {
                if (!(e.currentTarget as HTMLButtonElement).disabled) {
                  (e.currentTarget as HTMLElement).style.opacity = "0.85";
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = "1";
              }}
            >
              {loadingFolder ? "Eligiendo..." : "Elegir carpeta..."}
            </button>
          </div>
        </div>

        {/* Footer: file count */}
        {fileCount > 0 && (
          <p
            className="text-center text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            {fileCount} archivo{fileCount !== 1 ? "s" : ""} para descargar
          </p>
        )}
      </div>
    </div>
  );
}

export default StoragePreferenceModal;
