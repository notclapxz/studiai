// Paywall.tsx — Pantalla de suscripcion cuando el trial expira
// Muestra planes y opciones. Integra Culqi Checkout JS v4 para pagos reales.

import { useState, useEffect } from "react";
import { Lock, Clock, Sparkles, ArrowRight, CheckCircle, Loader2 } from "lucide-react";
import { useAuthStore } from "../store/authStore";
import { useToasts, ToastContainer } from "../components/Toast";

// ─── Window type declarations para Culqi v4 ──────────────────────────────────

interface CulqiToken {
  id: string;
  email?: string;
  [key: string]: unknown;
}

interface CulqiError {
  user_message?: string;
  merchant_message?: string;
  [key: string]: unknown;
}

interface CulqiCheckout {
  open: () => void;
  close: () => void;
  settings: (options: {
    title: string;
    currency: string;
    description: string;
    amount: number;
    order?: string;
  }) => void;
  publicKey: string;
  token: CulqiToken | null;
  error: CulqiError | null;
  getOrder?: () => CulqiToken | null;
}

declare global {
  interface Window {
    Culqi: CulqiCheckout;
    culqi: () => void;
  }
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface PaywallProps {
  /** Callback para continuar sin IA (acceso limitado) */
  onContinuarSinIA: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Paywall({ onContinuarSinIA }: PaywallProps) {
  const processPago = useAuthStore((s) => s.processPago);
  const { toasts, addToast, dismissToast } = useToasts();

  const [selectedPlan, setSelectedPlan] = useState<"mensual" | "trimestral" | null>(null);
  const [isPaying, setIsPaying] = useState(false);

  // ── Task 4.1: Cargar script Culqi v4 dinámicamente ──────────────────────────
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.culqi.com/js/v4";
    script.async = true;
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, []);

  // ── Task 4.3 + 5.1 + 5.2: Handler que abre el widget Culqi ─────────────────
  const handlePagar = (plan: "mensual" | "trimestral") => {
    if (isPaying) return;
    if (!window.Culqi) {
      addToast({ variant: "error", message: "El módulo de pago no está listo. Intenta de nuevo." });
      return;
    }

    setSelectedPlan(plan);

    // Configurar el widget
    window.Culqi.publicKey = import.meta.env.VITE_CULQI_PUBLIC_KEY as string;
    window.Culqi.settings({
      title: "StudiAI Pro",
      currency: "PEN",
      description: plan === "mensual" ? "Plan Mensual" : "Plan Trimestral",
      amount: plan === "mensual" ? 2900 : 7500,
      order: "",
    });

    // Task 5.1 + 5.2: Callback ANTES de open()
    window.culqi = async () => {
      const token = window.Culqi.token;

      // Error de tokenización
      if (!token?.id) {
        const msg = window.Culqi.error?.user_message ?? "Error al procesar la tarjeta";
        addToast({ variant: "error", message: msg });
        return;
      }

      window.Culqi.close();
      setIsPaying(true);

      try {
        const result = await processPago(plan, token.id);
        if (!result.ok) {
          addToast({ variant: "error", message: result.error ?? "Pago fallido. Intenta de nuevo." });
        } else {
          addToast({ variant: "success", message: "¡Pago exitoso! Tu plan está activo." });
        }
      } finally {
        setIsPaying(false);
        setSelectedPlan(null);
      }
    };

    window.Culqi.open();
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "#212121" }}
    >
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-3">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto"
            style={{
              background: "rgba(224, 108, 117, 0.12)",
              border: "1px solid rgba(224, 108, 117, 0.25)",
            }}
          >
            <Lock size={28} strokeWidth={1.5} style={{ color: "#e06c75" }} />
          </div>
          <h1
            className="text-2xl font-bold"
            style={{ color: "#e0e0e0" }}
          >
            Tu prueba gratuita ha terminado
          </h1>
          <p className="text-sm" style={{ color: "#6a6a6a" }}>
            El chat con IA requiere una suscripcion. Tus tareas, calendario y
            datos de Canvas siguen disponibles.
          </p>
        </div>

        {/* Plan cards */}
        <div className="space-y-3">
          {/* Plan Mensual */}
          <div
            className="rounded-xl p-4 border transition-colors duration-150"
            style={{ background: "#252525", borderColor: "#4b4c5c" }}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Clock size={16} style={{ color: "#e0e0e0" }} />
                <span
                  className="text-sm font-semibold"
                  style={{ color: "#e0e0e0" }}
                >
                  Plan Mensual
                </span>
              </div>
              <div className="text-right">
                <span
                  className="text-lg font-bold"
                  style={{ color: "#e0e0e0" }}
                >
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
            {/* Task 4.3 + 4.4 */}
            <button
              onClick={() => handlePagar("mensual")}
              disabled={isPaying}
              className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
              style={
                isPaying && selectedPlan === "mensual"
                  ? { background: "#3a3a3a", color: "#6a6a6a", cursor: "not-allowed" }
                  : isPaying
                  ? { background: "#3a3a3a", color: "#6a6a6a", cursor: "not-allowed" }
                  : { background: "#4b4c5c", color: "#e0e0e0", cursor: "pointer" }
              }
            >
              {isPaying && selectedPlan === "mensual" ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Procesando...
                </>
              ) : (
                "Suscribirse — S/.29/mes"
              )}
            </button>
          </div>

          {/* Plan Trimestral */}
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
                  <span
                    className="text-sm font-semibold"
                    style={{ color: "#e0e0e0" }}
                  >
                    Plan Trimestral
                  </span>
                </div>
                <div className="text-right">
                  <span
                    className="text-lg font-bold"
                    style={{ color: "#e0e0e0" }}
                  >
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
              {/* Task 4.3 + 4.4 */}
              <button
                onClick={() => handlePagar("trimestral")}
                disabled={isPaying}
                className="w-full py-2 rounded-lg text-xs font-semibold transition-colors duration-150 flex items-center justify-center gap-2"
                style={
                  isPaying && selectedPlan === "trimestral"
                    ? { background: "#3a4a6b", color: "#6a6a6a", cursor: "not-allowed" }
                    : isPaying
                    ? { background: "#3a4a6b", color: "#6a6a6a", cursor: "not-allowed" }
                    : { background: "#5c9cf5", color: "#121212", cursor: "pointer" }
                }
              >
                {isPaying && selectedPlan === "trimestral" ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Procesando...
                  </>
                ) : (
                  "Suscribirse — S/.75/3 meses"
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Features list */}
        <div
          className="rounded-xl p-4 border"
          style={{ background: "#252525", borderColor: "#4b4c5c" }}
        >
          <p
            className="text-xs font-semibold mb-2"
            style={{ color: "#e0e0e0" }}
          >
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
              <li
                key={feature}
                className="flex items-center gap-2 text-xs"
                style={{ color: "#6a6a6a" }}
              >
                <CheckCircle size={12} style={{ color: "#7fd88f" }} />
                {feature}
              </li>
            ))}
          </ul>
        </div>

        {/* Boton continuar sin IA */}
        <div className="text-center">
          <button
            onClick={onContinuarSinIA}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150"
            style={{
              background: "transparent",
              color: "#6a6a6a",
              border: "1px solid #4b4c5c",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "#6a6a6a";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = "#4b4c5c";
            }}
          >
            Seguir sin IA
            <ArrowRight size={16} strokeWidth={1.5} />
          </button>
          <p className="text-xs mt-2" style={{ color: "#6a6a6a" }}>
            Podras usar tareas, calendario y datos de Canvas
          </p>
        </div>
      </div>

      {/* Task 5.3: Toast container */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default Paywall;
