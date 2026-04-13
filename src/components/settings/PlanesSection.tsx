// PlanesSection.tsx — Sección de planes y pagos en SettingsModal

import { useState, useEffect } from "react";
import { Clock, Sparkles, Loader2, CheckCircle } from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import type { User } from "@supabase/supabase-js";

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
  const { recoverFingerprint, processPago } = useAuthStore();

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

  // Cargar script Culqi v4 al montar
  useEffect(() => {
    const existing = document.querySelector('script[src="https://checkout.culqi.com/js/v4"]');
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://checkout.culqi.com/js/v4";
    script.async = true;
    document.head.appendChild(script);
  }, []);

  function handlePagar(plan: "mensual" | "trimestral") {
    if (isPaying) return;
    setPaymentError(null);
    setPaymentSuccess(false);

    if (!window.Culqi) {
      setPaymentError("El módulo de pago no está listo. Intenta de nuevo.");
      return;
    }

    setSelectedPlan(plan);

    window.Culqi.publicKey = import.meta.env.VITE_CULQI_PUBLIC_KEY as string;
    window.Culqi.settings({
      title: "StudiAI Pro",
      currency: "PEN",
      description: plan === "mensual" ? "Plan Mensual" : "Plan Trimestral",
      amount: plan === "mensual" ? 2900 : 7500,
      order: "",
    });

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
      setRecoverState({
        kind: "error",
        message: "Este dispositivo ya esta asociado a otra cuenta",
      });
    } else {
      setRecoverState({
        kind: "error",
        message: "No se pudo recuperar el acceso",
      });
    }
    // Auto-ocultar despues de 5s
    setTimeout(() => setRecoverState({ kind: "idle" }), 5000);
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Current plan status */}
      <div
        className="rounded-xl p-4 border"
        style={{ background: "#252525", borderColor: "#4b4c5c" }}
      >
        <div className="flex items-center gap-2 mb-2">
          {licenseStatus === "trial" && (
            <>
              <Clock size={16} style={{ color: "#fab283" }} />
              <span className="text-sm font-semibold" style={{ color: "#fab283" }}>
                Trial activo · {daysRemaining} dias restantes
              </span>
            </>
          )}
          {licenseStatus === "pro" && (
            <>
              <Sparkles size={16} style={{ color: "#7fd88f" }} />
              <span className="text-sm font-semibold" style={{ color: "#7fd88f" }}>
                Plan Pro activo
              </span>
            </>
          )}
          {licenseStatus === "expired" && (
            <>
              <Clock size={16} style={{ color: "#e06c75" }} />
              <span className="text-sm font-semibold" style={{ color: "#e06c75" }}>
                Trial expirado
              </span>
            </>
          )}
        </div>
        {licenseStatus === "trial" && (
          <>
            <div
              className="w-full h-1.5 rounded-full mt-2"
              style={{ background: "#3a3a3a" }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${trialPercent}%`,
                  background: "#fab283",
                }}
              />
            </div>
            <p className="text-xs mt-1.5" style={{ color: "#6a6a6a" }}>
              {trialUsedDays} de {trialTotalDays} dias usados
            </p>
          </>
        )}
        {licenseStatus === "expired" && (
          <>
            <p className="text-xs mt-1" style={{ color: "#6a6a6a" }}>
              El chat con IA requiere una suscripcion. Tus tareas, calendario y datos de Canvas siguen disponibles.
            </p>
            {user && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={handleRecoverFingerprint}
                  disabled={recoverState.kind === "loading"}
                  className="text-xs underline disabled:opacity-50"
                  style={{ color: "#fab283" }}
                >
                  {recoverState.kind === "loading"
                    ? "Verificando..."
                    : "¿Cambiaste de computadora? Recuperar acceso"}
                </button>
                {recoverState.kind === "ok" && (
                  <p
                    className="text-[11px] mt-1"
                    style={{ color: "#7fd88f" }}
                  >
                    {recoverState.message}
                  </p>
                )}
                {recoverState.kind === "error" && (
                  <p
                    className="text-[11px] mt-1"
                    style={{ color: "#e06c75" }}
                  >
                    {recoverState.message}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Plan cards */}
      <div className="space-y-3">
        {/* Monthly plan */}
        <div
          className="rounded-xl p-4 border transition-colors duration-150"
          style={{ background: "#252525", borderColor: "#4b4c5c" }}
        >
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Clock size={16} style={{ color: "#e0e0e0" }} />
              <span className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
                Plan Mensual
              </span>
            </div>
            <div className="text-right">
              <span className="text-lg font-bold" style={{ color: "#e0e0e0" }}>
                S/.29
              </span>
              <span className="text-xs" style={{ color: "#6a6a6a" }}>
                {" "}/mes
              </span>
            </div>
          </div>
          <p className="text-xs mb-3" style={{ color: "#6a6a6a" }}>
            Chat con IA ilimitado, acceso a todas las funciones
          </p>
          <button
            onClick={() => handlePagar("mensual")}
            disabled={isPaying}
            className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
            style={isPaying ? { background: "#3a3a3a", color: "#6a6a6a", cursor: "not-allowed" } : { background: "#4b4c5c", color: "#e0e0e0", cursor: "pointer" }}
          >
            {isPaying && selectedPlan === "mensual" ? (
              <><Loader2 size={12} className="animate-spin" />Procesando...</>
            ) : "Suscribirse — S/.29/mes"}
          </button>
        </div>

        {/* Quarterly plan */}
        <div className="relative">
          <div
            className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full text-[10px] font-bold z-10"
            style={{ background: "#5c9cf5", color: "#121212" }}
          >
            Ahorra 14%
          </div>
          <div
            className="rounded-xl p-4 border-2 transition-colors duration-150"
            style={{ background: "#252525", borderColor: "#5c9cf5" }}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Sparkles size={16} style={{ color: "#5c9cf5" }} />
                <span className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
                  Plan Trimestral
                </span>
              </div>
              <div className="text-right">
                <span className="text-lg font-bold" style={{ color: "#e0e0e0" }}>
                  S/.75
                </span>
                <span className="text-xs" style={{ color: "#6a6a6a" }}>
                  {" "}/3 meses
                </span>
              </div>
            </div>
            <p className="text-xs mb-3" style={{ color: "#6a6a6a" }}>
              Todo del plan mensual + precio preferencial
            </p>
            <button
              onClick={() => handlePagar("trimestral")}
              disabled={isPaying}
              className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
              style={isPaying ? { background: "#3a4a6b", color: "#6a6a6a", cursor: "not-allowed" } : { background: "#5c9cf5", color: "#121212", cursor: "pointer" }}
            >
              {isPaying && selectedPlan === "trimestral" ? (
                <><Loader2 size={12} className="animate-spin" />Procesando...</>
              ) : "Suscribirse — S/.75/3 meses"}
            </button>
          </div>
        </div>
      </div>

      {/* Feedback pago */}
      {paymentError && (
        <p className="text-xs text-center" style={{ color: "#e06c75" }}>{paymentError}</p>
      )}
      {paymentSuccess && (
        <p className="text-xs text-center" style={{ color: "#7fd88f" }}>¡Pago exitoso! Tu plan Pro está activo.</p>
      )}

      {/* Features list */}
      <div
        className="rounded-xl p-4 border"
        style={{ background: "#252525", borderColor: "#4b4c5c" }}
      >
        <p className="text-xs font-semibold mb-2" style={{ color: "#e0e0e0" }}>
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
            <li key={feature} className="flex items-center gap-2 text-xs" style={{ color: "#6a6a6a" }}>
              <CheckCircle size={12} style={{ color: "#7fd88f" }} />
              {feature}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
