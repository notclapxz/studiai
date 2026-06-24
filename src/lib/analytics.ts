// analytics.ts — Telemetría mínima de uso para medir RETENCIÓN de la beta.
//
// Registra un evento "app_open" por arranque autenticado de la app. Con eso
// basta para calcular días activos por usuario y cohortes de retención
// (¿el usuario vuelve a la semana N?).
//
// Exclusión del uso propio: NO se filtra en el cliente. La verdad de "quién es
// interno" vive en la DB (studiai.users.is_internal) y se aplica en las
// consultas de métricas. El cliente siempre inserta; las métricas excluyen a
// los internos. Así no hay que mantener una lista de emails en el código.
//
// Privacidad: solo se registra user_id + versión + plataforma + timestamp.
// Cero contenido del usuario (ni chats, ni cursos, ni archivos).

import { studiai } from "./supabase";
import { getVersion } from "@tauri-apps/api/app";

// Dedupe: un solo app_open por proceso. Evita contar de más cuando el
// listener de auth y la verificación inicial de sesión corren en paralelo,
// o ante TOKEN_REFRESHED.
let appOpenLogged = false;

/** Heurístico de plataforma sin dependencias (el WebView siempre expone navigator). */
function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "unknown";
}

/**
 * Registra que la app se abrió con sesión activa. Idempotente por proceso.
 * Fire-and-forget: cualquier fallo se loguea en consola y NUNCA bloquea la UI
 * (la telemetría jamás debe romper la experiencia del usuario).
 */
export async function logAppOpen(userId: string): Promise<void> {
  if (appOpenLogged || !userId) return;
  appOpenLogged = true;

  try {
    let appVersion: string | null = null;
    try {
      appVersion = await getVersion();
    } catch {
      /* best-effort: la versión es opcional */
    }

    const { error } = await studiai().from("usage_events").insert({
      user_id: userId,
      event: "app_open",
      app_version: appVersion,
      platform: detectPlatform(),
    });

    if (error) {
      // Permitir un reintento en el próximo trigger si falló (red caída, etc.)
      appOpenLogged = false;
      console.warn("[Analytics] No se pudo registrar app_open:", error.message);
    }
  } catch (err) {
    appOpenLogged = false;
    console.warn("[Analytics] Excepción en logAppOpen:", err);
  }
}
