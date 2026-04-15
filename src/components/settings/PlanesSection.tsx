// PlanesSection.tsx — Sección de planes y pagos en SettingsModal

import { useState, useEffect } from "react";
import { Clock, Sparkles, Loader2, CheckCircle, ArrowUpCircle } from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import type { User } from "@supabase/supabase-js";

// ─── Constantes de planes ────────────────────────────────────────────────────

const PLAN_MENSUAL_PRECIO  = 29;
const PLAN_MENSUAL_DIAS    = 30;
const PLAN_TRIMESTRAL_PRECIO = 75;
const PLAN_TRIMESTRAL_DIAS   = 90;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatFecha(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function calcUpgradePrice(daysRemaining: number): number {
  const valorDiasRestantes = (daysRemaining / PLAN_MENSUAL_DIAS) * PLAN_MENSUAL_PRECIO;
  const precio = PLAN_TRIMESTRAL_PRECIO - valorDiasRestantes;
  return Math.max(1, Math.round(precio * 100) / 100);
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface PlanesSectionProps {
  licenseStatus: string;
  daysRemaining: number;
  trialTotalDays: number;
  trialUsedDays: number;
  trialPercent: number;
  user: User | null;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function PlanesSection({
  licenseStatus,
  daysRemaining,
  trialTotalDays,
  trialUsedDays,
  trialPercent,
  user,
}: PlanesSectionProps) {
  const { recoverFingerprint, processPago, planType, planExpiresAt } = useAuthStore();

  const [isPaying, setIsPaying] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<"mensual" | "trimestral" | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  const [recoverState, setRecoverState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const isPro         = licenseStatus === "pro";
  const isMensual     = isPro && planType === "mensual";
  const isTrimestral  = isPro && planType === "trimestral";
  const upgradePrice  = isMensual ? calcUpgradePrice(daysRemaining) : null;

  useEffect(() => {
    const existing = document.querySelector('script[src="https://checkout.culqi.com/js/v4"]');
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://checkout.culqi.com/js/v4";
    script.async = true;
    document.head.appendChild(script);
  }, []);

  function handlePagar(plan: "mensual" | "trimestral", amountOverride?: number) {
    if (isPaying) return;
    setPaymentError(null);
    setPaymentSuccess(false);

    if (!window.Culqi) {
      setPaymentError("El módulo de pago no está listo. Intenta de nuevo.");
      return;
    }

    setSelectedPlan(plan);

    const amount = amountOverride != null
      ? Math.round(amountOverride * 100)
      : plan === "mensual" ? 2900 : 7500;

    const description = plan === "mensual"
      ? "Plan Mensual"
      : amountOverride != null
        ? `Upgrade a Trimestral (precio prorrateado)`
        : "Plan Trimestral";

    window.Culqi.publicKey = import.meta.env.VITE_CULQI_PUBLIC_KEY as string;
    window.Culqi.settings({ title: "StudiAI Pro", currency: "PEN", description, amount, order: "" });

    window.culqi = async () => {
      const token = window.Culqi.token;
      if (!token?.id) {
        setPaymentError(window.Culqi.error?.user_message ?? "Error al procesar la tarjeta.");
        return;
      }
      window.Culqi.close();
      setIsPaying(true);
      try {
        const result = await processPago(plan, token.id);
        if (!result.ok) {
          setPaymentError(result.error ?? "Pago fallido. Intenta de nuevo.");
        } else {
          setPaymentSuccess(true);
        }
      } finally {
        setIsPaying(false);
        setSelectedPlan(null);
      }
    };

    window.Culqi.open();
  }

  async function handleRecoverFingerprint() {
    setRecoverState({ kind: "loading" });
    const result = await recoverFingerprint();
    if (result.ok) {
      setRecoverState({ kind: "ok", message: "Acceso recuperado" });
    } else if (result.reason === "forbidden") {
      setRecoverState({ kind: "error", message: "No autorizado" });
    } else if (result.reason === "fingerprint_in_use") {
      setRecoverState({ kind: "error", message: "Este dispositivo ya esta asociado a otra cuenta" });
    } else {
      setRecoverState({ kind: "error", message: "No se pudo recuperar el acceso" });
    }
    setTimeout(() => setRecoverState({ kind: "idle" }), 5000);
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* ── Estado del plan actual ── */}
      <div
        className="rounded-xl p-4 border"
        style={{ background: "var(--bg-surface-active)", borderColor: "var(--border-ui)" }}
      >
        <div className="flex items-center gap-2 mb-2">
          {licenseStatus === "trial" && (
            <>
              <Clock size={16} style={{ color: "var(--accent-warm)" }} />
              <span className="text-sm font-semibold" style={{ color: "var(--accent-warm)" }}>
                Trial activo · {daysRemaining} dias restantes
              </span>
            </>
          )}
          {isPro && (
            <>
              <Sparkles size={16} style={{ color: "var(--success)" }} />
              <span className="text-sm font-semibold" style={{ color: "var(--success)" }}>
                Plan Pro activo
                {planType === "mensual" && " · Mensual"}
                {planType === "trimestral" && " · Trimestral"}
              </span>
            </>
          )}
          {licenseStatus === "expired" && (
            <>
              <Clock size={16} style={{ color: "var(--error)" }} />
              <span className="text-sm font-semibold" style={{ color: "var(--error)" }}>
                Trial expirado
              </span>
            </>
          )}
        </div>

        {isPro && (
          <div className="mt-1 space-y-0.5">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {daysRemaining > 0
                ? `${daysRemaining} día${daysRemaining !== 1 ? "s" : ""} restante${daysRemaining !== 1 ? "s" : ""}`
                : "Vence hoy"}
              {planExpiresAt && (
                <> · Vence el <span style={{ color: "var(--text-strong)" }}>{formatFecha(planExpiresAt)}</span></>
              )}
            </p>
            {daysRemaining > 0 && planExpiresAt && (
              <div
                className="w-full h-1.5 rounded-full mt-2"
                style={{ background: "var(--bg-modal-nav)" }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, (daysRemaining / (planType === "trimestral" ? PLAN_TRIMESTRAL_DIAS : PLAN_MENSUAL_DIAS)) * 100)}%`,
                    background: "var(--success)",
                  }}
                />
              </div>
            )}
          </div>
        )}

        {licenseStatus === "trial" && (
          <>
            <div
              className="w-full h-1.5 rounded-full mt-2"
              style={{ background: "var(--bg-modal-nav)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${trialPercent}%`, background: "var(--accent-warm)" }}
              />
            </div>
            <p className="text-xs mt-1.5" style={{ color: "var(--text-weak)" }}>
              {trialUsedDays} de {trialTotalDays} dias usados
            </p>
          </>
        )}

        {licenseStatus === "expired" && (
          <>
            <p className="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
              El chat con IA requiere una suscripcion. Tus tareas, calendario y datos de Canvas siguen disponibles.
            </p>
            {user && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={handleRecoverFingerprint}
                  disabled={recoverState.kind === "loading"}
                  className="text-xs underline disabled:opacity-50"
                  style={{ color: "var(--accent-warm)" }}
                >
                  {recoverState.kind === "loading"
                    ? "Verificando..."
                    : "¿Cambiaste de computadora? Recuperar acceso"}
                </button>
                {recoverState.kind === "ok" && (
                  <p className="text-[11px] mt-1" style={{ color: "var(--success)" }}>
                    {recoverState.message}
                  </p>
                )}
                {recoverState.kind === "error" && (
                  <p className="text-[11px] mt-1" style={{ color: "var(--error)" }}>
                    {recoverState.message}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Tarjetas de planes ── */}
      <div className="space-y-3">
        {/* Plan Mensual */}
        <div
          className="rounded-xl p-4 border transition-colors duration-150"
          style={{
            background: "var(--bg-surface-active)",
            borderColor: isMensual ? "var(--success)" : "var(--border-ui)",
          }}
        >
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Clock size={16} style={{ color: isMensual ? "var(--success)" : "var(--text-strong)" }} />
              <span className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
                Plan Mensual
              </span>
            </div>
            <div className="text-right">
              <span className="text-lg font-bold" style={{ color: "var(--text-strong)" }}>S/.29</span>
              <span className="text-xs" style={{ color: "var(--text-weak)" }}> /mes</span>
            </div>
          </div>
          <p className="text-xs mb-3" style={{ color: "var(--text-weak)" }}>
            Chat con IA ilimitado, acceso a todas las funciones
          </p>

          {isMensual ? (
            <div
              className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5"
              style={{ background: "var(--success-subtle)", color: "var(--success)" }}
            >
              <CheckCircle size={12} />
              Plan activo
            </div>
          ) : isTrimestral ? (
            <div
              className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5"
              style={{ background: "var(--bg-modal-nav)", color: "var(--text-weak)" }}
            >
              Incluido en tu plan Trimestral
            </div>
          ) : (
            <button
              onClick={() => handlePagar("mensual")}
              disabled={isPaying}
              className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
              style={isPaying
                ? { background: "var(--bg-modal-nav)", color: "var(--text-weak)", cursor: "not-allowed" }
                : { background: "var(--border-ui)", color: "var(--text-strong)", cursor: "pointer" }}
            >
              {isPaying && selectedPlan === "mensual" ? (
                <><Loader2 size={12} className="animate-spin" />Procesando...</>
              ) : "Suscribirse — S/.29/mes"}
            </button>
          )}
        </div>

        {/* Plan Trimestral */}
        <div className="relative">
          <div
            className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full text-[10px] font-bold z-10"
            style={{ background: "var(--accent)", color: "var(--text-strong)" }}
          >
            Ahorra 14%
          </div>
          <div
            className="rounded-xl p-4 border-2 transition-colors duration-150"
            style={{
              background: "var(--bg-surface-active)",
              borderColor: isTrimestral ? "var(--success)" : "var(--accent)",
            }}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Sparkles size={16} style={{ color: isTrimestral ? "var(--success)" : "var(--accent)" }} />
                <span className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
                  Plan Trimestral
                </span>
              </div>
              <div className="text-right">
                <span className="text-lg font-bold" style={{ color: "var(--text-strong)" }}>S/.75</span>
                <span className="text-xs" style={{ color: "var(--text-weak)" }}> /3 meses</span>
              </div>
            </div>
            <p className="text-xs mb-3" style={{ color: "var(--text-weak)" }}>
              Todo del plan mensual + precio preferencial
            </p>

            {isTrimestral ? (
              <div
                className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5"
                style={{ background: "var(--success-subtle)", color: "var(--success)" }}
              >
                <CheckCircle size={12} />
                Plan activo
              </div>
            ) : isMensual ? (
              <div className="space-y-2">
                <div
                  className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: "var(--accent-subtle)", border: "1px solid var(--accent)" }}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <ArrowUpCircle size={12} style={{ color: "var(--accent)" }} />
                    <span style={{ color: "var(--accent)" }} className="font-semibold">
                      Upgrade disponible
                    </span>
                  </div>
                  <p style={{ color: "var(--text-muted)" }}>
                    S/.75 − valor de {daysRemaining} días restantes ={" "}
                    <span className="font-bold" style={{ color: "var(--text-strong)" }}>
                      S/.{upgradePrice?.toFixed(2)}
                    </span>
                  </p>
                </div>
                <button
                  onClick={() => handlePagar("trimestral", upgradePrice ?? undefined)}
                  disabled={isPaying}
                  className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
                  style={isPaying
                    ? { background: "var(--accent-subtle)", color: "var(--text-weak)", cursor: "not-allowed" }
                    : { background: "var(--accent)", color: "var(--text-strong)", cursor: "pointer" }}
                >
                  {isPaying && selectedPlan === "trimestral" ? (
                    <><Loader2 size={12} className="animate-spin" />Procesando...</>
                  ) : (
                    <><ArrowUpCircle size={12} />Upgrade — S/.{upgradePrice?.toFixed(2)}</>
                  )}
                </button>
              </div>
            ) : (
              <button
                onClick={() => handlePagar("trimestral")}
                disabled={isPaying}
                className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
                style={isPaying
                  ? { background: "var(--accent-subtle)", color: "var(--text-weak)", cursor: "not-allowed" }
                  : { background: "var(--accent)", color: "var(--text-strong)", cursor: "pointer" }}
              >
                {isPaying && selectedPlan === "trimestral" ? (
                  <><Loader2 size={12} className="animate-spin" />Procesando...</>
                ) : "Suscribirse — S/.75/3 meses"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Feedback pago */}
      {paymentError && (
        <p className="text-xs text-center" style={{ color: "var(--error)" }}>{paymentError}</p>
      )}
      {paymentSuccess && (
        <p className="text-xs text-center" style={{ color: "var(--success)" }}>¡Pago exitoso! Tu plan Pro está activo.</p>
      )}

      {/* Features list */}
      <div
        className="rounded-xl p-4 border"
        style={{ background: "var(--bg-surface-active)", borderColor: "var(--border-ui)" }}
      >
        <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-strong)" }}>
          Incluido en todos los planes
        </p>
        <ul className="space-y-1.5">
          {[
            "Chat con IA ilimitado",
            "Sincronizacion de Canvas automatica",
            "Busqueda inteligente en tus materiales",
            "Flashcards generadas por IA",
            "Acceso a tareas y calendario",
          ].map((feature) => (
            <li key={feature} className="flex items-center gap-2 text-xs" style={{ color: "var(--text-weak)" }}>
              <CheckCircle size={12} style={{ color: "var(--success)" }} />
              {feature}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
