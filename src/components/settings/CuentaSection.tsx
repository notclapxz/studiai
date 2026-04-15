// CuentaSection.tsx — Sección de cuenta de usuario en SettingsModal

import { useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { LogOut } from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { supabase } from "../../lib/supabase";

// ─── Props ──────────────────────────────────────────────────────────────────

interface CuentaSectionProps {
  userName: string;
  userEmail: string;
  userAvatar: string | undefined;
  licenseStatus: string;
  daysRemaining: number;
  trialTotalDays: number;
  trialUsedDays: number;
  trialPercent: number;
  trustMode: boolean;
  showThinkingReasoning: boolean;
  onTrustModeChange: (value: boolean) => void;
  onShowThinkingReasoningChange: (value: boolean) => void;
  onNavigateToPlanes: () => void;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function CuentaSection({
  userName,
  userEmail,
  userAvatar,
  licenseStatus,
  daysRemaining,
  trialTotalDays,
  trialUsedDays,
  trialPercent,
  trustMode,
  showThinkingReasoning,
  onTrustModeChange,
  onShowThinkingReasoningChange,
  onNavigateToPlanes,
}: CuentaSectionProps) {
  const [trustPending, setTrustPending] = useState(false);
  const [thinkingPending, setThinkingPending] = useState(false);

  async function handleTrustModeToggle() {
    if (trustPending) return;
    const next = !trustMode;
    onTrustModeChange(next);
    setTrustPending(true);
    try {
      const db = await Database.load("sqlite:studyai.db");
      await db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('trust_mode', $1)",
        [next ? "true" : "false"]
      );
    } catch (err: unknown) {
      console.error("[settings] Error al guardar trust_mode:", err);
    } finally {
      setTrustPending(false);
    }
  }

  async function handleThinkingToggle() {
    if (thinkingPending) return;
    const next = !showThinkingReasoning;
    onShowThinkingReasoningChange(next);
    setThinkingPending(true);
    try {
      const db = await Database.load("sqlite:studyai.db");
      await db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('show_thinking_reasoning', $1)",
        [next ? "true" : "false"]
      );
    } catch (err: unknown) {
      console.error("[settings] Error al guardar show_thinking_reasoning:", err);
    } finally {
      setThinkingPending(false);
    }
  }

  async function handleLogout() {
    try {
      await useAuthStore.getState().resetLicenseCache();
    } catch (err: unknown) {
      console.warn("[Logout] Error limpiando cache de licencia:", err);
    }
    await supabase.auth.signOut();
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* User info */}
      <div className="flex items-center gap-3">
        {userAvatar ? (
          <img
            src={userAvatar}
            alt={userName}
            className="w-11 h-11 rounded-full shrink-0"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-sm font-bold"
            style={{ background: "var(--accent-warm)", color: "var(--bg-modal)" }}
          >
            {userName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-strong)" }}>
            {userName}
          </p>
          <p className="text-xs truncate" style={{ color: "var(--text-weak)" }}>
            {userEmail}
          </p>
        </div>
      </div>

      {/* Plan badge */}
      <div
        className="rounded-xl p-4 space-y-3"
        style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
      >
        {licenseStatus === "trial" && (
          <>
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                style={{ background: "var(--accent-warm-subtle)", color: "var(--accent-warm)" }}
              >
                Trial · {daysRemaining} dia{daysRemaining !== 1 ? "s" : ""} restante{daysRemaining !== 1 ? "s" : ""}
              </span>
            </div>
            <div>
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ background: "var(--bg-modal-nav)" }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${trialPercent}%`,
                    background: trialPercent > 75 ? "var(--error)" : "var(--accent-warm)",
                  }}
                />
              </div>
              <p className="text-[11px] mt-1.5" style={{ color: "var(--text-weak)" }}>
                {trialUsedDays} de {trialTotalDays} dias usados
              </p>
            </div>
          </>
        )}

        {licenseStatus === "pro" && (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{ background: "var(--success-subtle)", color: "var(--success)" }}
          >
            Plan Pro
          </span>
        )}

        {licenseStatus === "expired" && (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{ background: "var(--error-subtle)", color: "var(--error)" }}
          >
            Trial expirado
          </span>
        )}

        {(licenseStatus === "unknown" || licenseStatus === "loading") && (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{ background: "var(--accent-warm-subtle)", color: "var(--accent-warm)" }}
          >
            Verificando licencia...
          </span>
        )}

        {licenseStatus !== "pro" && licenseStatus !== "loading" && (
          <button
            onClick={onNavigateToPlanes}
            className="w-full py-2 rounded-lg text-xs font-semibold transition-opacity duration-150"
            style={{ background: "var(--accent-warm)", color: "var(--bg-modal)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.85"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
          >
            Ver planes
          </button>
        )}
      </div>

      {/* Trust mode toggle */}
      <div
        className="rounded-xl p-4 space-y-2"
        style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0 mr-3">
            <p className="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
              Modo confianza
            </p>
            <p className="text-[11px] leading-relaxed mt-0.5" style={{ color: "var(--text-weak)" }}>
              Permitir al asistente ejecutar comandos sin confirmacion
            </p>
          </div>
          <button
            role="switch"
            aria-checked={trustMode}
            onClick={handleTrustModeToggle}
            className="relative shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none"
            style={{ background: trustMode ? "var(--accent-warm)" : "var(--border-ui)" }}
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200"
              style={{ transform: trustMode ? "translateX(18px)" : "translateX(3px)" }}
            />
          </button>
        </div>
        {trustMode && (
          <p className="text-[11px]" style={{ color: "var(--accent-warm)" }}>
            El asistente puede ejecutar comandos en tu terminal
          </p>
        )}
      </div>

      {/* Mostrar razonamiento toggle */}
      <div
        className="rounded-xl p-4 space-y-2"
        style={{ background: "var(--bg-surface-active)", border: "1px solid var(--border-ui)" }}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0 mr-3">
            <p className="text-sm font-medium" style={{ color: "var(--text-strong)" }}>
              Mostrar razonamiento del asistente
            </p>
            <p className="text-[11px] leading-relaxed mt-0.5" style={{ color: "var(--text-weak)" }}>
              Muestra un resumen del proceso interno antes de responder.
              Este detalle puede aparecer en ingles segun el contenido.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={showThinkingReasoning}
            onClick={handleThinkingToggle}
            className="relative shrink-0 inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none"
            style={{ background: showThinkingReasoning ? "var(--accent-warm)" : "var(--border-ui)" }}
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200"
              style={{ transform: showThinkingReasoning ? "translateX(18px)" : "translateX(3px)" }}
            />
          </button>
        </div>
      </div>

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="flex items-center gap-2 text-xs transition-colors duration-150 py-1"
        style={{ color: "var(--text-weak)" }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--error)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-weak)"; }}
      >
        <LogOut size={14} strokeWidth={1.5} />
        Cerrar sesion
      </button>
    </div>
  );
}
