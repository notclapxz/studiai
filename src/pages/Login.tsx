// Login.tsx — Pantalla de bienvenida con Google Sign In real via Supabase
// Usa OAuth con localhost:1420/auth/callback como redirectTo en desarrollo.
// En producción (app empaquetada) se usaría el deep link studiai://.
// El browser externo del sistema (Chrome/Safari/Firefox) maneja el flujo OAuth,
// NO la WebView de Tauri — esto evita conflictos con el sandbox de Google.

import { useState, useEffect } from "react";
import { BookOpen } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { supabase } from "../lib/supabase";

interface LoginProps {
  /** Callback que se llama cuando el usuario completa el login (no se usa
   *  directamente aquí — el callback de auth en App.tsx maneja la navegación) */
  onLogin: () => void;
}

export function Login({ onLogin: _onLogin }: LoginProps) {
  // Estado local: loading del botón y mensaje de error
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {/* silencioso si falla en dev */});
  }, []);

  // ── Handler de Google Sign In ─────────────────────────────────────────────

  async function handleGoogleLogin() {
    try {
      setCargando(true);
      setError(null);

      // skipBrowserRedirect: true → Supabase devuelve la URL sin redirigir.
      // Así evitamos que la WebView de Tauri intente abrir el flujo OAuth
      // internamente (Google bloquea OAuth embebido en WebViews).
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          // En desarrollo (tauri dev): usar localhost porque el scheme studiai://
          // no está registrado en el OS hasta que la app esté empaquetada.
          // Vite corre en :1420, así que el browser puede volver a esa URL
          // y Supabase detecta el hash con los tokens automáticamente.
          redirectTo: "https://studiai.clapxz.com/auth/callback",
          // Pedir scopes mínimos necesarios
          scopes: "openid email profile",
          // CLAVE: no redirigir dentro de la WebView — solo obtener la URL
          skipBrowserRedirect: true,
        },
      });

      if (error) {
        setError("No se pudo iniciar sesión con Google. Intentá de nuevo.");
        console.error("[Auth] Error OAuth:", error.message);
        return;
      }

      if (data?.url) {
        // Abrir la URL de OAuth en el browser externo del sistema
        // (Chrome, Safari, Firefox) usando el plugin-shell de Tauri.
        // El flujo continúa en App.tsx cuando Google redirige al deep link.
        console.log("[Auth] Abriendo OAuth en browser externo…");
        await openUrl(data.url);
      } else {
        setError("No se pudo obtener la URL de autenticación. Intentá de nuevo.");
        console.error("[Auth] Supabase no devolvió URL de OAuth");
      }
    } catch (err) {
      setError("Error inesperado. Verificá tu conexión a internet.");
      console.error("[Auth] Excepción:", err);
    } finally {
      setCargando(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--bg-base)" }}
    >
      {/* Gradiente sutil de fondo */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(37,99,235,0.08) 0%, transparent 70%)",
        }}
      />

      {/* Tarjeta de login */}
      <div
        className="relative z-10 w-full max-w-sm mx-auto px-6 py-10 rounded-2xl flex flex-col items-center gap-6"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-base)",
        }}
      >
        {/* Logo / ícono de la app */}
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-2"
          style={{
            background: "var(--accent-subtle, rgba(37,99,235,0.15))",
            color: "var(--accent)",
          }}
        >
          <BookOpen size={40} strokeWidth={1} />
        </div>

        {/* Nombre y tagline */}
        <div className="text-center space-y-1">
          <h1
            className="text-2xl font-bold"
            style={{ color: "var(--text-strong)" }}
          >
            StudiAI USIL
          </h1>
          <p className="text-sm" style={{ color: "var(--text-weak)" }}>
            Tu asistente de estudio universitario
          </p>
        </div>

        {/* Separador */}
        <div
          className="w-full h-px"
          style={{ background: "var(--border-base)" }}
        />

        {/* Mensaje de error (si hay) */}
        {error && (
          <div
            className="w-full px-4 py-3 rounded-xl text-sm text-center"
            style={{
              background: "var(--error-subtle)",
              border: "1px solid rgba(239,68,68,0.2)",
              color: "var(--error)",
            }}
          >
            {error}
          </div>
        )}

        {/* Botón de Google Sign In */}
        <button
          onClick={handleGoogleLogin}
          disabled={cargando}
          className="w-full flex items-center justify-center gap-3 py-3 px-5 rounded-xl font-medium text-sm transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: "var(--bg-surface-hover)",
            border: "1px solid var(--border-base)",
            color: "var(--text-strong)",
          }}
          onMouseEnter={(e) => {
            if (!cargando) {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--bg-surface-active)";
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                "var(--border-strong)";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "var(--bg-surface-hover)";
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "var(--border-base)";
          }}
        >
          {cargando ? (
            /* Spinner de carga */
            <svg
              className="animate-spin"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
                strokeOpacity="0.2"
              />
              <path
                d="M12 2a10 10 0 0 1 10 10"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            /* Ícono oficial de Google */
            <svg
              width="18"
              height="18"
              viewBox="0 0 48 48"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M47.532 24.552c0-1.636-.132-3.2-.396-4.704H24v9.048h13.196c-.576 3.024-2.268 5.604-4.824 7.32l7.788 6.036c4.548-4.188 7.372-10.356 7.372-17.7z"
                fill="#4285F4"
              />
              <path
                d="M24 48c6.6 0 12.132-2.184 16.164-5.94l-7.788-6.036c-2.16 1.452-4.92 2.316-8.376 2.316-6.444 0-11.904-4.344-13.86-10.188L2.076 34.26C6.084 42.18 14.46 48 24 48z"
                fill="#34A853"
              />
              <path
                d="M10.14 28.152A14.73 14.73 0 019.384 24c0-1.452.252-2.868.708-4.152L2.076 13.74A23.9 23.9 0 000 24c0 3.876.936 7.548 2.076 10.26l8.064-6.108z"
                fill="#FBBC05"
              />
              <path
                d="M24 9.516c3.624 0 6.864 1.248 9.42 3.672l7.02-7.02C36.12 2.148 30.588 0 24 0 14.46 0 6.084 5.82 2.076 13.74l8.064 6.108C12.096 13.86 17.556 9.516 24 9.516z"
                fill="#EA4335"
              />
            </svg>
          )}
          {cargando ? "Abriendo Google…" : "Continuar con Google"}
        </button>

        {/* Nota informativa sobre el flujo OAuth */}
        <p className="text-xs text-center leading-relaxed" style={{ color: "var(--text-ghost)" }}>
          Se abrirá el navegador para autenticarte con Google.
          Luego volvés automáticamente a la app.
        </p>

        {/* Nota de términos */}
        <p
          className="text-xs text-center leading-relaxed"
          style={{ color: "var(--text-weak)" }}
        >
          Al continuar, aceptás los{" "}
          <span
            className="underline cursor-pointer"
            style={{ color: "var(--text-base)" }}
          >
            términos de uso
          </span>{" "}
          y la{" "}
          <span
            className="underline cursor-pointer"
            style={{ color: "var(--text-base)" }}
          >
            política de privacidad
          </span>
        </p>
      </div>

      {/* Versión en esquina */}
      <span
        className="absolute bottom-4 right-6 text-xs"
        style={{ color: "var(--text-ghost, rgba(255,255,255,0.18))" }}
      >
        v{appVersion || "—"}
      </span>
    </div>
  );
}

export default Login;
