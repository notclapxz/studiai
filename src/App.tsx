// App.tsx — Punto de entrada de la UI de StudiAI USIL
// Routing: Login (sin sesion) -> MainLayout (con sesion) -> Settings (si se necesita)
// Auth: Supabase + Google OAuth.
//   - Dev (tauri dev): callback via http://localhost:1420/auth/callback
//     Supabase detecta el hash fragment automaticamente (detectSessionInUrl: true).
//   - Produccion (app empaquetada): callback via deep link studiai://auth/callback

import { useEffect, useState } from "react";
import { Login } from "./pages/Login";
import { MainLayout } from "./pages/MainLayout";
import { Onboarding } from "./pages/Onboarding";
import { Paywall } from "./pages/Paywall";
import { supabase } from "./lib/supabase";
import { useAuthStore } from "./store/authStore";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import Database from "@tauri-apps/plugin-sql";
import { AlertTriangle } from "lucide-react";
import { checkForUpdates } from "./lib/updater";
import { useToasts, ToastContainer } from "./components/Toast";
import { UpdateProgressOverlay, type UpdatePhase } from "./components/UpdateProgressOverlay";
import { ChangelogModal } from "./components/ChangelogModal";
import "./App.css";

// ─── Tipos auxiliares ─────────────────────────────────────────────────────────

/** Estados posibles de la app (rutas internas) */
type AppState = "login" | "onboarding" | "main" | "paywall";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determina si el usuario debe ver el onboarding.
 * Retorna true si onboarding_completed no esta en settings Y no tiene cursos.
 */
async function shouldShowOnboarding(): Promise<boolean> {
  try {
    const db = await Database.load("sqlite:studyai.db");

    // Verificar el flag de onboarding completado
    const settingRows = await db.select<{ value: string }[]>(
      "SELECT value FROM settings WHERE key = 'onboarding_completed' LIMIT 1"
    );
    if (settingRows.length > 0 && settingRows[0].value === "1") {
      return false; // Ya completo el onboarding
    }

    // Si no hay flag, verificar si ya tiene cursos
    const courseRows = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM courses"
    );
    if ((courseRows[0]?.count ?? 0) > 0) {
      return false; // Ya tiene datos — saltar onboarding
    }

    return true; // Nuevo usuario, mostrar onboarding
  } catch (err: unknown) {
    console.error("[Onboarding] Error verificando estado:", err);
    return false; // Ante error, no bloquear al usuario
  }
}

/**
 * Promise en vuelo para la llamada atomica de signup + fingerprint.
 *
 * La atomicidad real (ensure_user + register_fingerprint en una sola
 * transaccion con `pg_advisory_xact_lock` sobre el hash del fingerprint)
 * esta garantizada server-side por `studiai_signup_with_fingerprint`. Este
 * lock client-side es solo para deduplicar multiples eventos SIGNED_IN
 * emitidos por Supabase en la misma sesion de cliente (p. ej. cuando el
 * listener `onAuthStateChange` y `verificarSesionInicial` corren en
 * paralelo al detectar la sesion del hash fragment).
 */
let signupInFlightPromise: Promise<void> | null = null;

/**
 * Llama a la RPC atomica `studiai_signup_with_fingerprint` que combina
 * `ensure_user_exists` + `register_device_fingerprint` en una sola
 * transaccion server-side, y ademas devuelve el estado de licencia para
 * ahorrarnos un roundtrip extra a `check_license`.
 *
 * Idempotente por sesion de cliente: llamadas concurrentes reutilizan la
 * promesa en vuelo; llamadas posteriores re-ejecutan normalmente (para que
 * re-logins despues de un signOut funcionen).
 */
async function ensureUserExists(
  userId: string,
  email: string,
  nombre: string
) {
  if (signupInFlightPromise) {
    return signupInFlightPromise;
  }

  signupInFlightPromise = (async () => {
    try {
      const fingerprint = await invoke<string>("get_device_fingerprint").catch(
        (err) => {
          console.warn("[Auth] No se pudo obtener fingerprint:", err);
          return "";
        }
      );

      // RPC atomica (SECURITY DEFINER): crea el usuario si no existe,
      // registra el fingerprint bajo un advisory lock y devuelve la licencia.
      const { data, error } = await supabase.rpc(
        "studiai_signup_with_fingerprint",
        {
          p_user_id: userId,
          p_email: email,
          p_full_name: nombre,
          p_fingerprint: fingerprint,
        }
      );

      if (error) {
        console.error(
          "[Auth] Error en studiai_signup_with_fingerprint RPC:",
          error.message
        );
        return;
      }

      const result = typeof data === "string" ? JSON.parse(data) : data;
      if (result?.blocked) {
        // Multi-cuenta detectada server-side — la UI lo reflejara cuando
        // el checkLicense posterior devuelva "expired".
        console.warn("[Auth] Signup bloqueado:", result.reason);
      }

      // Actualizar el store directamente con la licencia que vino en la
      // misma respuesta RPC (ahorra un roundtrip extra a check_license).
      if (result?.license) {
        useAuthStore.getState().setLicenseFromRpc(result.license);
      }
    } catch (err: unknown) {
      console.error("[Auth] Excepcion en ensureUserExists:", err);
    }
  })();

  try {
    await signupInFlightPromise;
  } finally {
    // Liberamos el lock al finalizar para permitir re-login posterior
    // (por ejemplo, logout + login del mismo usuario en la misma instancia).
    signupInFlightPromise = null;
  }
}

/**
 * Parsea los tokens de auth desde una URL de callback.
 * Supabase puede enviar los tokens como hash fragment (#) o query params (?).
 * Ejemplo: studiai://auth/callback#access_token=xxx&refresh_token=yyy
 */
function parseAuthTokensFromUrl(url: string): {
  accessToken: string | null;
  refreshToken: string | null;
} {
  // Intentar con hash fragment primero (flujo implicito de OAuth)
  const hashIdx = url.indexOf("#");
  const queryIdx = url.indexOf("?");

  let paramStr = "";
  if (hashIdx !== -1) {
    paramStr = url.slice(hashIdx + 1);
  } else if (queryIdx !== -1) {
    paramStr = url.slice(queryIdx + 1);
  }

  const params = new URLSearchParams(paramStr);
  return {
    accessToken: params.get("access_token"),
    refreshToken: params.get("refresh_token"),
  };
}

// ─── Componente: Banner de advertencia de trial ──────────────────────────────

interface TrialWarningBannerProps {
  daysRemaining: number;
  onVerPlanes: () => void;
}

function TrialWarningBanner({ daysRemaining, onVerPlanes }: TrialWarningBannerProps) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2 text-sm shrink-0"
      style={{
        background: "rgba(250,178,131,0.08)",
        borderBottom: "1px solid rgba(250,178,131,0.2)",
      }}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle
          size={16}
          strokeWidth={1.5}
          style={{ color: "#fab283" }}
        />
        <span style={{ color: "#fab283" }}>
          Tu prueba gratuita vence en{" "}
          {daysRemaining === 1
            ? "1 dia"
            : daysRemaining === 0
              ? "menos de 1 dia"
              : `${daysRemaining} dias`}
        </span>
      </div>
      <button
        onClick={onVerPlanes}
        className="px-3 py-1 rounded-lg text-xs font-medium transition-colors duration-150"
        style={{
          background: "#fab283",
          color: "#1a1a1a",
        }}
      >
        Ver planes
      </button>
    </div>
  );
}

// ─── Componente: Banner cuando no podemos verificar la licencia ──────────────
//
// Se muestra cuando:
//   - `licenseStatus === "unknown"` (sin red y sin cache utilizable), o
//   - `licenseFromCache === true` (operando desde cache, verificacion pendiente).
//
// No bloquea la UI general — las features offline (cursos, tareas, calendario)
// siguen funcionando. El chat con IA se bloquea aparte en ChatPanel cuando el
// status es "unknown".

interface LicenseOfflineBannerProps {
  licenseVerifiedAt: number | null;
  onReintentar: () => void;
}

function LicenseOfflineBanner({ licenseVerifiedAt, onReintentar }: LicenseOfflineBannerProps) {
  // Dias desde la ultima verificacion exitosa online (si hay).
  let mensaje = "Sin conexion — no pudimos verificar tu licencia.";
  if (licenseVerifiedAt !== null) {
    const diasSinVerificar = Math.floor(
      (Date.now() - licenseVerifiedAt) / (24 * 60 * 60 * 1000)
    );
    if (diasSinVerificar <= 0) {
      mensaje = "Sin conexion — usando datos cacheados.";
    } else if (diasSinVerificar === 1) {
      mensaje = "Sin conexion hace 1 dia — verificacion pendiente.";
    } else {
      mensaje = `Sin conexion hace ${diasSinVerificar} dias — verificacion pendiente.`;
    }
  }

  return (
    <div
      className="flex items-center justify-between px-4 py-2 text-sm shrink-0"
      style={{
        background: "rgba(250,178,131,0.08)",
        borderBottom: "1px solid rgba(250,178,131,0.2)",
      }}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle
          size={16}
          strokeWidth={1.5}
          style={{ color: "#fab283" }}
        />
        <span style={{ color: "#fab283" }}>{mensaje}</span>
      </div>
      <button
        onClick={onReintentar}
        className="px-3 py-1 rounded-lg text-xs font-medium transition-colors duration-150"
        style={{
          background: "#fab283",
          color: "#1a1a1a",
        }}
      >
        Reintentar
      </button>
    </div>
  );
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function App() {
  const {
    user,
    loading,
    setUser,
    setLoading,
    licenseStatus,
    daysRemaining,
    licenseVerifiedAt,
    licenseFromCache,
    checkLicense,
  } = useAuthStore();
  const [appState, setAppState] = useState<AppState>("login");
  const { toasts, addToast, dismissToast } = useToasts();

  // ── Estado: ChangelogModal ────────────────────────────────────────────────
  // showChangelog: true → modal visible automáticamente (nueva versión detectada)
  // changelogSkipVersionUpdate: true → abierto manualmente desde Settings (no re-escribe last_seen_version)
  const [showChangelog, setShowChangelog] = useState(false);
  const [changelogSkipVersionUpdate, setChangelogSkipVersionUpdate] = useState(false);

  // ── Estado del overlay de progreso de update ─────────────────────────────
  const [updateOverlay, setUpdateOverlay] = useState<{
    visible: boolean;
    phase: UpdatePhase;
    percent: number;
    version: string;
  }>({ visible: false, phase: "downloading", percent: 0, version: "" });

  // ── Efecto: chequear actualizaciones al montar (una sola vez) ────────────

  useEffect(() => {
    checkForUpdates(({ version, onInstall }) => {
      addToast({
        variant: "success",
        message: `Nueva versión ${version} disponible.`,
        duration: 0,
        action: {
          label: "Instalar",
          onClick: () => {
            // Mostrar overlay inmediatamente — no desaparece hasta el relaunch
            setUpdateOverlay({ visible: true, phase: "downloading", percent: 0, version });
            onInstall({
              onPhaseChange: (phase) =>
                setUpdateOverlay((prev) => ({ ...prev, phase })),
              onProgress: (percent) =>
                setUpdateOverlay((prev) => ({ ...prev, percent })),
            }).catch((err: unknown) => {
              console.error("[Updater] Error instalando update:", err);
              setUpdateOverlay((prev) => ({ ...prev, visible: false }));
              addToast({
                variant: "error",
                message: "Error al instalar la actualización. Reintenta más tarde.",
                duration: 5000,
              });
            });
          },
        },
      });
    });
  }, []);

  // ── Efecto: verificar sesion al montar + listener de cambios de auth ──────

  useEffect(() => {
    // Registrar el listener ANTES de verificar la sesion para no perder
    // el evento SIGNED_IN que dispara Supabase al detectar el hash fragment
    // en la URL (flujo localhost:1420/auth/callback#access_token=...).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("[Auth] Evento de auth:", event);

      if (event === "SIGNED_IN" && session?.user) {
        setUser(session.user);
        await ensureUserExists(
          session.user.id,
          session.user.email ?? "",
          session.user.user_metadata?.full_name ?? session.user.email ?? ""
        );

        // Verificar licencia despues de asegurar que el usuario existe
        await checkLicense();

        // Determinar si el usuario debe ver el onboarding
        const showOnboarding = await shouldShowOnboarding();

        // Si la licencia expiro, ir al paywall. Si no, flujo normal.
        const currentLicense = useAuthStore.getState().licenseStatus;
        if (currentLicense === "expired") {
          setAppState("paywall");
        } else {
          setAppState(showOnboarding ? "onboarding" : "main");
        }

        // Limpiar el hash fragment de la URL para que no quede visible
        if (
          window.location.hash.includes("access_token") ||
          window.location.pathname === "/auth/callback"
        ) {
          window.history.replaceState(null, "", "/");
        }
      } else if (event === "SIGNED_OUT") {
        setUser(null);
        setAppState("login");
      } else if (event === "TOKEN_REFRESHED" && session?.user) {
        setUser(session.user);
      }
    });

    // Verificar si ya hay una sesion activa al arrancar.
    async function verificarSesionInicial() {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) {
          console.error("[Auth] Error obteniendo sesion:", error.message);
          setLoading(false);
          return;
        }

        if (session?.user) {
          setUser(session.user);
          await ensureUserExists(
            session.user.id,
            session.user.email ?? "",
            session.user.user_metadata?.full_name ?? session.user.email ?? ""
          );

          // Verificar licencia
          await checkLicense();

          const currentLicense = useAuthStore.getState().licenseStatus;

          // Determinar si el usuario debe ver el onboarding
          const showOnboarding = await shouldShowOnboarding();

          if (currentLicense === "expired") {
            setAppState("paywall");
          } else {
            setAppState(showOnboarding ? "onboarding" : "main");
          }
        }
      } catch (err: unknown) {
        console.error("[Auth] Error en verificacion inicial:", err);
      } finally {
        setLoading(false);
      }
    }

    verificarSesionInicial();

    // Cleanup: desuscribirse al desmontar
    return () => {
      subscription.unsubscribe();
    };
  }, [setUser, setLoading, checkLicense]);

  // ── Efecto: interceptar deep link studiai://auth/callback (produccion) ──────

  useEffect(() => {
    if (window.location.pathname === "/auth/callback") {
      console.log(
        "[Auth] Callback de localhost detectado — deep link listener omitido"
      );
      return;
    }

    let cleanupFn: (() => void) | undefined;

    async function setupDeepLinkListener() {
      try {
        const deepLink = await import("@tauri-apps/plugin-deep-link");

        const unlisten = await deepLink.onOpenUrl(async (urls: string[]) => {
          for (const url of urls) {
            await handleDeepLinkUrl(url);
          }
        });

        cleanupFn = unlisten;
        console.log("[Auth] Deep link listener activo (plugin-deep-link)");
      } catch {
        try {
          const { listen } = await import("@tauri-apps/api/event");

          const unlisten = await listen<string>(
            "deep-link://new-url",
            async (event) => {
              await handleDeepLinkUrl(event.payload);
            }
          );

          cleanupFn = unlisten;
          console.log("[Auth] Deep link listener activo (fallback event)");
        } catch (err: unknown) {
          console.warn(
            "[Auth] No se pudo configurar el deep link listener:",
            err
          );
        }
      }
    }

    async function handleDeepLinkUrl(url: string) {
      console.log("[Auth] Deep link recibido:", url);

      if (!url.startsWith("studiai://auth/callback")) return;

      const { accessToken, refreshToken } = parseAuthTokensFromUrl(url);

      if (!accessToken || !refreshToken) {
        console.error("[Auth] No se encontraron tokens en el callback URL");
        return;
      }

      try {
        const { data, error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });

        if (error) {
          console.error("[Auth] Error estableciendo sesion:", error.message);
          return;
        }

        if (data.user) {
          console.log("[Auth] Sesion establecida para:", data.user.email);
        }
      } catch (err: unknown) {
        console.error("[Auth] Error procesando callback de auth:", err);
      }
    }

    setupDeepLinkListener();

    return () => {
      if (cleanupFn) cleanupFn();
    };
  }, []);

  // ── Efecto: re-verificar licencia cuando la app vuelve a primer plano ──────

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;

      const {
        lastCheckedAt,
        user: currentUser,
        licenseStatus: currentStatus,
      } = useAuthStore.getState();
      if (!currentUser) return;

      // Umbral dependiente del plan (fix G.4):
      // - trial: 15 min — un trial puede vencer mid-sesion, hay que cerrarlo
      //   rapido para no dar uso gratuito adicional.
      // - expired: 5 min — el usuario acaba de pagar, queremos desbloquear ASAP.
      // - unknown: 5 min — idem, necesitamos confirmar licencia cuanto antes.
      // - pro / loading: 1 hora — comportamiento original, pro es estable.
      const FIFTEEN_MIN = 15 * 60 * 1000;
      const FIVE_MIN = 5 * 60 * 1000;
      const ONE_HOUR = 60 * 60 * 1000;

      let threshold: number;
      if (currentStatus === "trial") {
        threshold = FIFTEEN_MIN;
      } else if (currentStatus === "expired" || currentStatus === "unknown") {
        threshold = FIVE_MIN;
      } else {
        threshold = ONE_HOUR;
      }

      if (Date.now() - lastCheckedAt > threshold) {
        console.log(
          `[License] Re-verificando licencia (status=${currentStatus}, umbral=${threshold}ms)`
        );
        checkLicense();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkLicense]);

  // ── Handlers de navegacion ───────────────────────────────────

  // ── Efecto: detectar nueva versión y mostrar ChangelogModal ──────────────
  // Guard: solo ejecutar cuando el usuario está autenticado y terminó el onboarding
  // (appState === "main" es el proxy correcto — se llega ahí solo si ambas condiciones se cumplen)
  useEffect(() => {
    if (appState !== "main" || !user) return;

    async function checkVersionChangelog() {
      try {
        const [currentVersion, lastSeenVersion] = await Promise.all([
          getVersion(),
          invoke<string | null>("get_setting", { key: "last_seen_version" }),
        ]);

        if (currentVersion !== lastSeenVersion) {
          setChangelogSkipVersionUpdate(false);
          setShowChangelog(true);
        }
      } catch (err: unknown) {
        // Fallo no crítico — no bloquear la app si no se puede comparar versiones
        console.warn("[Changelog] Error comparando versiones:", err);
      }
    }

    void checkVersionChangelog();
  }, [appState, user]);

  // ── Efecto: verificar deadlines próximos al entrar al layout principal ──
  useEffect(() => {
    if (appState !== "main" || !user) return;

    // Lanzar sin await — las notificaciones son best-effort
    invoke("check_upcoming_deadlines").catch((err: unknown) => {
      console.warn("[Deadlines] Error verificando deadlines:", err);
    });
  }, [appState, user]);

  /** Contador que fuerza remount de MainLayout */
  const [mainLayoutKey, setMainLayoutKey] = useState(0);

  /** El usuario completa el onboarding */
  function handleOnboardingComplete() {
    setMainLayoutKey((k) => k + 1);
    setAppState("main");
  }

  /**
   * El usuario va a Settings desde el onboarding (Paso 2).
   * Now goes to main (settings is a modal inside MainLayout).
   */
  function handleOnboardingGoToSettings() {
    setAppState("main");
  }

  /** El usuario elige "Seguir sin IA" desde el paywall */
  function handleContinuarSinIA() {
    setAppState("main");
  }

  /** El usuario quiere ver los planes (trial warning banner) */
  function handleVerPlanes() {
    // Plans are shown inside the Settings modal in MainLayout.
    // The banner just gives a visual nudge — clicking opens the app
    // where users can access Settings > Planes.
    setAppState("main");
  }

  // ── Pantalla de carga inicial ─────────────────────────────────

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--bg-base)" }}
      >
        <div className="flex flex-col items-center gap-4">
          {/* Spinner */}
          <svg
            className="animate-spin"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="rgba(255,255,255,0.1)"
              strokeWidth="3"
            />
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke="var(--accent)"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          <p className="text-sm" style={{ color: "var(--text-weak)" }}>
            Verificando sesion...
          </p>
        </div>
      </div>
    );
  }

  // ── Render segun estado ──────────────────────────────────────

  if (appState === "login" || !user) {
    return (
      <>
        <Login onLogin={() => setAppState("main")} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  if (appState === "paywall") {
    return (
      <>
        <Paywall onContinuarSinIA={handleContinuarSinIA} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  if (appState === "onboarding") {
    return (
      <>
        <Onboarding
          onComplete={handleOnboardingComplete}
          onGoToSettings={handleOnboardingGoToSettings}
        />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  // Main layout con banner de advertencia de trial si aplica
  const showTrialWarning =
    licenseStatus === "trial" && daysRemaining <= 3;
  // Banner "sin conexion / verificando licencia":
  //   - licenseStatus === "unknown": no se pudo verificar online y no hay cache.
  //   - licenseFromCache === true: operando desde cache, pendiente re-verificar.
  const showOfflineBanner =
    licenseStatus === "unknown" || licenseFromCache;

  /** Abre el ChangelogModal en modo manual (sin actualizar last_seen_version al cerrar) */
  function handleOpenChangelogManual() {
    setChangelogSkipVersionUpdate(true);
    setShowChangelog(true);
  }

  /** Fragmento compartido: ChangelogModal flotante sobre cualquier variante del layout */
  const changelogOverlay = showChangelog && (
    <ChangelogModal
      skipVersionUpdate={changelogSkipVersionUpdate}
      onClose={() => setShowChangelog(false)}
    />
  );

  /** Overlay de progreso de update — z-index máximo, no se puede cerrar */
  const updateOverlayEl = (
    <UpdateProgressOverlay
      visible={updateOverlay.visible}
      phase={updateOverlay.phase}
      downloadPercent={updateOverlay.percent > 0 ? updateOverlay.percent : undefined}
      version={updateOverlay.version}
    />
  );

  if (showOfflineBanner) {
    return (
      <div className="flex flex-col h-screen">
        <LicenseOfflineBanner
          licenseVerifiedAt={licenseVerifiedAt}
          onReintentar={() => {
            void checkLicense();
          }}
        />
        <div className="flex-1 min-h-0 [&>div]:!h-full">
          <MainLayout key={mainLayoutKey} onOpenChangelog={handleOpenChangelogManual} onForceOnboarding={() => setAppState("onboarding")} />
        </div>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        {changelogOverlay}
        {updateOverlayEl}
      </div>
    );
  }

  if (showTrialWarning) {
    return (
      <div className="flex flex-col h-screen">
        <TrialWarningBanner
          daysRemaining={daysRemaining}
          onVerPlanes={handleVerPlanes}
        />
        {/* flex-1 min-h-0 overrides MainLayout's h-screen */}
        <div className="flex-1 min-h-0 [&>div]:!h-full">
          <MainLayout key={mainLayoutKey} onOpenChangelog={handleOpenChangelogManual} onForceOnboarding={() => setAppState("onboarding")} />
        </div>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        {changelogOverlay}
        {updateOverlayEl}
      </div>
    );
  }

  return (
    <>
      <MainLayout key={mainLayoutKey} onOpenChangelog={handleOpenChangelogManual} onForceOnboarding={() => setAppState("onboarding")} />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {changelogOverlay}
      {updateOverlayEl}
    </>
  );
}

export default App;
