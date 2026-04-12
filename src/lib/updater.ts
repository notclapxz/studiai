// updater.ts — Auto-update silencioso al iniciar la app
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterCallback = (opts: {
  version: string;
  onInstall: () => Promise<void>;
}) => void;

export async function checkForUpdates(onUpdate: UpdaterCallback): Promise<void> {
  try {
    const update = await check();
    if (!update?.available) return;

    onUpdate({
      version: update.version,
      onInstall: async () => {
        await update.downloadAndInstall();
        await relaunch();
      },
    });
  } catch (err) {
    console.warn("[Updater] Error chequeando actualizaciones:", err);
  }
}
