// authStore.ts — Estado global de autenticacion con Zustand
// Maneja usuario, loading, sesion de Supabase y estado de licencia

import { create } from "zustand";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

// ─── Tipos ────────────────────────────────────────────────────────────────────

// `unknown` = no se pudo verificar online y no hay cache utilizable (fail-secure:
//   la UI debe gatear features premium y mostrar un banner "Verificando licencia").
// `loading` = verificacion en curso al iniciar la app.
export type LicenseStatus =
  | "trial"
  | "pro"
  | "expired"
  | "loading"
  | "unknown";

interface AuthStore {
  /** Usuario autenticado actualmente, o null si no hay sesion */
  user: User | null;
  /** true mientras se verifica la sesion inicial o se procesa el login */
  loading: boolean;
  /** Estado de la licencia del usuario */
  licenseStatus: LicenseStatus;
  /** Dias restantes de la prueba gratuita */
  daysRemaining: number;
  /** Timestamp (ms) de la ultima verificacion exitosa online */
  lastCheckedAt: number;
  /**
   * Timestamp (ms) de la ultima verificacion ONLINE exitosa contra el servidor.
   * Distinto de `lastCheckedAt`: este solo avanza en checks online ok, nunca al
   * leer del cache. Se usa para mostrar un banner "verificacion pendiente" si
   * la app lleva mucho tiempo sin poder contactar al servidor.
   */
  licenseVerifiedAt: number | null;
  /**
   * true cuando el status mostrado proviene de cache offline (no verificado
   * online en esta sesion). La UI puede mostrar un banner "sin conexion".
   */
  licenseFromCache: boolean;
  /** true mientras se procesa un pago con Culqi */
  paymentLoading: boolean;
  /** Actualiza el usuario en el store */
  setUser: (user: User | null) => void;
  /** Actualiza el estado de carga */
  setLoading: (loading: boolean) => void;
  /** Verifica el estado de la licencia (online con fallback offline) */
  checkLicense: () => Promise<void>;
  /**
   * Actualiza el estado de licencia en el store directamente desde una
   * respuesta RPC (p. ej. `studiai_signup_with_fingerprint.license`).
   * Evita un roundtrip extra a `check_license` cuando ya recibimos el
   * payload de licencia en la misma llamada atomica del servidor.
   */
  setLicenseFromRpc: (license: {
    plan: string;
    is_active: boolean;
    expires_at: string | null;
    days_remaining: number;
  }) => void;
  /**
   * Intenta recuperar el acceso para un usuario legitimo cuyo fingerprint
   * cambio (reinstalacion del SO, cambio de disco, etc.). Llama a la RPC
   * `studiai_recover_fingerprint` y, si tiene exito, refresca la licencia.
   */
  recoverFingerprint: () => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Limpia todo el estado de licencia en el store y el cache de SQLite.
   * Debe llamarse antes/despues de `supabase.auth.signOut()` para que el
   * proximo usuario no vea el estado del anterior.
   */
  resetLicenseCache: () => Promise<void>;
  /**
   * Procesa un pago con Culqi. Recibe el token generado por el widget
   * client-side y el plan seleccionado. Llama a la edge function
   * `culqi-charge`, y en caso de exito refresca la licencia via checkLicense().
   */
  processPago: (
    plan: "mensual" | "trimestral",
    culqiToken: string
  ) => Promise<{ ok: boolean; error?: string }>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  loading: true, // Inicia en true hasta verificar sesion
  licenseStatus: "loading",
  daysRemaining: 14,
  lastCheckedAt: 0,
  licenseVerifiedAt: null,
  licenseFromCache: false,
  paymentLoading: false,
  setUser: (user) => set({ user }),
  setLoading: (loading) => set({ loading }),

  checkLicense: async () => {
    const { user } = get();
    if (!user) {
      // Sin usuario no hay licencia que verificar. No marcamos "expired"
      // porque eso mezcla "sesion cerrada" con "trial vencido".
      set({
        licenseStatus: "unknown",
        daysRemaining: 0,
        licenseFromCache: false,
      });
      return;
    }

    try {
      // Intentar verificar online via RPC
      const { data, error } = await supabase.rpc("check_license", {
        p_user_id: user.id,
      });

      if (!error && data) {
        const result = typeof data === "string" ? JSON.parse(data) : data;
        const status: LicenseStatus = result.plan as LicenseStatus;
        const days: number = result.days_remaining ?? 0;
        const now = Date.now();

        set({
          licenseStatus: status,
          daysRemaining: days,
          lastCheckedAt: now,
          licenseVerifiedAt: now,
          licenseFromCache: false,
        });

        // Cachear en SQLite para uso offline
        try {
          const db = await Database.load("sqlite:studyai.db");
          await db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('license_status', $1)",
            [status]
          );
          await db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('license_checked_at', $1)",
            [new Date(now).toISOString()]
          );
          await db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('days_remaining', $1)",
            [String(days)]
          );
        } catch (cacheErr) {
          console.warn("[License] Error cacheando en SQLite:", cacheErr);
        }

        return;
      }

      // Si hay error de red, usar cache offline
      throw new Error(error?.message ?? "RPC failed");
    } catch (err) {
      console.warn("[License] Error online, intentando cache offline:", err);

      try {
        const db = await Database.load("sqlite:studyai.db");

        const checkedAtRows = await db.select<{ value: string }[]>(
          "SELECT value FROM settings WHERE key = 'license_checked_at' LIMIT 1"
        );
        const statusRows = await db.select<{ value: string }[]>(
          "SELECT value FROM settings WHERE key = 'license_status' LIMIT 1"
        );
        const daysRows = await db.select<{ value: string }[]>(
          "SELECT value FROM settings WHERE key = 'days_remaining' LIMIT 1"
        );

        const checkedAt = checkedAtRows[0]?.value;
        const cachedStatus = statusRows[0]?.value as LicenseStatus | undefined;
        const cachedDays = parseInt(daysRows[0]?.value ?? "0", 10);

        if (checkedAt && cachedStatus) {
          const verifiedAtMs = new Date(checkedAt).getTime();

          // SOFT FALLBACK:
          // Ya NO marcamos "expired" duro por tener el cache viejo. El servidor
          // es la fuente de verdad del estado "expired", no el reloj local.
          //
          // Si la ultima verificacion conocida era "expired", respetamos eso
          // (bloqueo permanece). Para cualquier otro status cacheado (trial/pro)
          // mostramos el estado cacheado y dejamos que la UI indique "sin
          // conexion, verificacion pendiente" via `licenseFromCache` +
          // `licenseVerifiedAt`. El usuario no queda bloqueado por estar offline.
          if (cachedStatus === "expired") {
            set({
              licenseStatus: "expired",
              daysRemaining: 0,
              licenseVerifiedAt: verifiedAtMs,
              licenseFromCache: true,
            });
          } else {
            set({
              licenseStatus: cachedStatus,
              daysRemaining: cachedDays,
              licenseVerifiedAt: verifiedAtMs,
              licenseFromCache: true,
            });
          }
          return;
        }

        // Sin cache y sin red: FAIL-SECURE.
        // Antes defaulteaba a { trial, 14 dias } — permisivo, permitia spoofear
        // un trial fresco indefinidamente rompiendo red + cache. Ahora marcamos
        // "unknown" y la UI gatea las features de IA hasta que el check online
        // resuelva. Lectura offline (cursos, tareas, calendario) sigue disponible.
        set({
          licenseStatus: "unknown",
          daysRemaining: 0,
          licenseVerifiedAt: null,
          licenseFromCache: false,
        });
      } catch (dbErr) {
        console.error("[License] Error leyendo cache SQLite:", dbErr);
        // Fallo total de cache + red: igual que arriba, fail-secure.
        set({
          licenseStatus: "unknown",
          daysRemaining: 0,
          licenseVerifiedAt: null,
          licenseFromCache: false,
        });
      }
    }
  },

  setLicenseFromRpc: (license) => {
    // Mapear `plan` al tipo LicenseStatus. El servidor puede devolver
    // "trial" | "pro" | "expired" (alineado con studiai.check_license).
    const plan = license?.plan as LicenseStatus | undefined;
    const status: LicenseStatus =
      plan === "trial" || plan === "pro" || plan === "expired"
        ? plan
        : "unknown";
    const days = Math.max(0, Math.floor(license?.days_remaining ?? 0));
    const now = Date.now();

    set({
      licenseStatus: status,
      daysRemaining: days,
      lastCheckedAt: now,
      licenseVerifiedAt: now,
      licenseFromCache: false,
    });

    // Cachear en SQLite para mantener consistencia con checkLicense().
    // Best-effort: no bloqueamos si falla.
    void (async () => {
      try {
        const db = await Database.load("sqlite:studyai.db");
        await db.execute(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('license_status', $1)",
          [status]
        );
        await db.execute(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('license_checked_at', $1)",
          [new Date(now).toISOString()]
        );
        await db.execute(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('days_remaining', $1)",
          [String(days)]
        );
      } catch (cacheErr) {
        console.warn("[License] Error cacheando RPC license en SQLite:", cacheErr);
      }
    })();
  },

  recoverFingerprint: async () => {
    const { user, checkLicense } = get();
    if (!user) {
      return { ok: false, reason: "no_session" };
    }

    try {
      const fingerprint = await invoke<string>("get_device_fingerprint");
      if (!fingerprint) {
        return { ok: false, reason: "no_fingerprint" };
      }

      const { data, error } = await supabase.rpc(
        "studiai_recover_fingerprint",
        {
          p_user_id: user.id,
          p_new_fingerprint: fingerprint,
        }
      );

      if (error) {
        console.warn(
          "[Auth] Error en studiai_recover_fingerprint:",
          error.message
        );
        return { ok: false, reason: "rpc_error" };
      }

      const result = typeof data === "string" ? JSON.parse(data) : data;
      if (result?.ok) {
        // Refrescar licencia para reflejar el acceso recuperado.
        await checkLicense();
        return { ok: true };
      }

      return { ok: false, reason: result?.reason ?? "unknown" };
    } catch (err) {
      console.error("[Auth] Excepcion en recoverFingerprint:", err);
      return { ok: false, reason: "exception" };
    }
  },

  resetLicenseCache: async () => {
    // Limpiar estado en memoria inmediatamente para evitar flash del estado
    // del usuario anterior mientras el signOut se procesa.
    set({
      licenseStatus: "loading",
      daysRemaining: 0,
      lastCheckedAt: 0,
      licenseVerifiedAt: null,
      licenseFromCache: false,
    });

    // Limpiar cache SQLite (best-effort: si falla no bloquea el logout).
    try {
      const db = await Database.load("sqlite:studyai.db");
      await db.execute(
        "DELETE FROM settings WHERE key IN ('license_status', 'license_checked_at', 'days_remaining')"
      );
    } catch (err) {
      console.warn("[License] Error limpiando cache SQLite en logout:", err);
    }
  },

  processPago: async (plan, culqiToken) => {
    const { user } = get();
    if (!user) return { ok: false, error: "no_session" };

    set({ paymentLoading: true });

    try {
      const session = await supabase.auth.getSession();
      const accessToken = session.data.session?.access_token;
      if (!accessToken) return { ok: false, error: "no_session" };

      const { data, error } = await supabase.functions.invoke("culqi-charge", {
        body: {
          token_id: culqiToken,
          plan,
          email: user.email,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (error || !data?.ok) {
        return { ok: false, error: data?.error ?? "payment_failed" };
      }

      await get().checkLicense();
      return { ok: true };
    } catch (err) {
      console.error("[Auth] processPago error:", err);
      return { ok: false, error: "network_error" };
    } finally {
      set({ paymentLoading: false });
    }
  },
}));
