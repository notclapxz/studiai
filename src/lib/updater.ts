// updater.ts — Auto-update silencioso al iniciar la app
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";

export interface UpdaterCallback {
  (opts: { version: string; onInstall: () => Promise<void> }): void;
}

export async function checkForUpdates(onUpdate: UpdaterCallback): Promise<void> {
  try {
    const update = await check();
    if (!update?.available) return;

    onUpdate({
      version: update.version,
      onInstall: async () => {
        await update.downloadAndInstall();

        // Guardar el cuerpo del changelog antes del relaunch para mostrarlo post-actualización
        try {
          await invoke("set_setting", {
            key: "pending_changelog_body",
            value: update.body ?? "",
          });
        } catch (err: unknown) {
          // Fallo no crítico — el modal usará el fallback text si no hay body guardado
          console.warn("[Updater] No se pudo guardar el changelog body:", err);
        }

        await relaunch();
      },
    });
  } catch (err: unknown) {
    console.warn("[Updater] Error chequeando actualizaciones:", err);
  }
}
