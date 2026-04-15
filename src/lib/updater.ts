// updater.ts — Sistema de auto-actualización de StudiAI

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import type { UpdatePhase } from "../components/UpdateProgressOverlay";

export const UPDATER_ENABLED = !import.meta.env.DEV;

export interface UpdaterProgressCallbacks {
  onPhaseChange: (phase: UpdatePhase) => void;
  onProgress: (percent: number) => void;
}

export interface UpdaterCallback {
  (opts: {
    version: string;
    /** Llama cuando el usuario confirma. Reporta progreso via callbacks. */
    onInstall: (progress: UpdaterProgressCallbacks) => Promise<void>;
  }): void;
}

export async function checkForUpdates(onUpdate: UpdaterCallback): Promise<void> {
  if (!UPDATER_ENABLED) return;

  try {
    const update = await check();
    if (!update?.available) return;

    onUpdate({
      version: update.version,
      onInstall: async ({ onPhaseChange, onProgress }) => {
        // Guardar changelog body para mostrarlo post-relaunch
        try {
          await invoke("set_setting", {
            key: "pending_changelog_body",
            value: update.body ?? "",
          });
        } catch (err: unknown) {
          console.warn("[Updater] No se pudo guardar el changelog body:", err);
        }

        // Fase 1: descarga con progreso
        onPhaseChange("downloading");

        let contentLength = 0;
        let downloaded = 0;

        await update.download((event) => {
          if (event.event === "Started") {
            contentLength = event.data.contentLength ?? 0;
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              onProgress(Math.round((downloaded / contentLength) * 100));
            }
          }
          // "Finished" → pasamos a la siguiente fase
        });

        // Fase 2: instalación
        onPhaseChange("installing");
        await update.install();

        // Fase 3: relaunch
        onPhaseChange("relaunching");
        // Pequeña pausa para que el usuario vea el estado "Reiniciando..."
        await new Promise((r) => setTimeout(r, 800));
        await relaunch();
      },
    });
  } catch (err: unknown) {
    console.warn("[Updater] Error chequeando actualizaciones:", err);
  }
}
