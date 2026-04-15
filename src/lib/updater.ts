// updater.ts — Sistema de auto-actualización de StudiAI
//
// Guard: solo corre en builds empaquetados (window.__TAURI_INTERNALS__ siempre
// existe en Tauri, pero `__TAURI_INTERNALS__.metadata` solo existe en builds
// reales — en tauri dev el plugin updater lanza un error porque no hay endpoint
// al que conectarse. Usamos invoke("tauri_is_packaged") no está disponible, así
// que la guarda más simple y robusta es capturar el error del check() y silenciarlo
// como ya hace el try/catch, pero ADEMÁS detectar si estamos en modo dev via
// import.meta.env.DEV (Vite lo inyecta en build time).

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";

// Guard: en dev (tauri dev) el updater no tiene endpoint real — skip silencioso.
// En producción (tauri build) esta constante es false y el updater corre normal.
export const UPDATER_ENABLED = !import.meta.env.DEV;

export interface UpdaterCallback {
  (opts: {
    version: string;
    /** Llama a esta función cuando el usuario confirme que quiere instalar */
    onInstall: () => Promise<void>;
  }): void;
}

/**
 * Chequea si hay una nueva versión disponible.
 * Si la hay, llama a `onUpdate` con la versión y un callback `onInstall`.
 *
 * El caller decide cuándo instalar (botón explícito del usuario).
 * Esta función NO instala automáticamente.
 *
 * Guard: no hace nada en tauri dev (UPDATER_ENABLED = false).
 */
export async function checkForUpdates(onUpdate: UpdaterCallback): Promise<void> {
  if (!UPDATER_ENABLED) return;

  try {
    const update = await check();
    if (!update?.available) return;

    onUpdate({
      version: update.version,
      onInstall: async () => {
        // Guardar el changelog body ANTES de descargar/instalar para mostrarlo
        // en el ChangelogModal post-relaunch. Fallo no crítico → warn y seguir.
        try {
          await invoke("set_setting", {
            key: "pending_changelog_body",
            value: update.body ?? "",
          });
        } catch (err: unknown) {
          console.warn("[Updater] No se pudo guardar el changelog body:", err);
        }

        // Descargar primero (sin bloquear la UI — no hay progreso granular aquí,
        // pero separarlo de install() permite que el toast de "instalando" aparezca
        // solo cuando el usuario lo confirma, y la descarga ya terminó).
        await update.downloadAndInstall();

        // relaunch() reinicia la app con la versión instalada
        await relaunch();
      },
    });
  } catch (err: unknown) {
    // Silenciar errores de red o de endpoint inaccesible (builds de dev, offline, etc.)
    console.warn("[Updater] Error chequeando actualizaciones:", err);
  }
}
