// Onboarding.tsx — Flujo de bienvenida para nuevos usuarios (3 pasos)
// Se muestra después del login, antes del MainLayout, solo una vez.
// Al completar, guarda 'onboarding_completed = 1' en SQLite settings.

import { useState } from "react";
import Database from "@tauri-apps/plugin-sql";
import { BookOpen, Zap, Brain, ArrowRight, CheckCircle2 } from "lucide-react";

// ─── Props ────────────────────────────────────────────────────────────────────

interface OnboardingProps {
  /** Llamado cuando el usuario completa el onboarding y quiere entrar a la app */
  onComplete: () => void;
  /** Llamado cuando el usuario quiere ir a configurar Canvas (Paso 2) */
  onGoToSettings: () => void;
}

// ─── Tipos internos ──────────────────────────────────────────────────────────

type StepIndex = 0 | 1 | 2;

interface CourseStats {
  courses: number;
  assignments: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Guarda en SQLite que el onboarding ya fue completado */
async function markOnboardingCompleted(): Promise<void> {
  try {
    const db = await Database.load("sqlite:studyai.db");
    await db.execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', '1')"
    );
  } catch (err) {
    console.error("[Onboarding] Error guardando onboarding_completed:", err);
  }
}

/** Lee las estadísticas de cursos y tareas desde SQLite */
async function loadStats(): Promise<CourseStats> {
  try {
    const db = await Database.load("sqlite:studyai.db");
    const courseRows = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM courses"
    );
    const assignmentRows = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) as count FROM assignments"
    );
    return {
      courses: courseRows[0]?.count ?? 0,
      assignments: assignmentRows[0]?.count ?? 0,
    };
  } catch {
    return { courses: 0, assignments: 0 };
  }
}

// ─── Sub-componentes de cada paso ────────────────────────────────────────────

// Paso 1: Bienvenida
function Step1Welcome({ onNext }: { onNext: () => void }) {
  const features = [
    {
      icon: <BookOpen size={20} strokeWidth={1.5} />,
      title: "Sincroniza tus cursos",
      description: "Importa cursos, tareas y materiales directamente desde Canvas LMS",
    },
    {
      icon: <Brain size={20} strokeWidth={1.5} />,
      title: "Asistente IA personalizado",
      description: "Chatea con un asistente que conoce el contenido de tus PDFs y materiales",
    },
    {
      icon: <Zap size={20} strokeWidth={1.5} />,
      title: "Todo en un solo lugar",
      description: "Tareas, anuncios, documentos y notas organizadas para que estudies mejor",
    },
  ];

  return (
    <div className="flex flex-col items-center gap-8 text-center">
      {/* Logo */}
      <div
        className="w-20 h-20 rounded-3xl flex items-center justify-center"
        style={{
          background: "var(--accent-subtle, rgba(37,99,235,0.15))",
          color: "var(--accent)",
        }}
      >
        <BookOpen size={44} strokeWidth={1} />
      </div>

      {/* Textos */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold" style={{ color: "var(--text-strong)" }}>
          Bienvenido a StudyAI
        </h1>
        <p className="text-base" style={{ color: "var(--text-weak)" }}>
          Tu asistente de estudio personal
        </p>
      </div>

      {/* Features */}
      <div className="w-full space-y-3 text-left">
        {features.map((feature, i) => (
          <div
            key={i}
            className="flex items-start gap-4 px-4 py-3 rounded-xl"
            style={{
              background: "var(--bg-surface-hover)",
              border: "1px solid var(--border-base)",
            }}
          >
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
              style={{
                background: "var(--accent-subtle, rgba(37,99,235,0.12))",
                color: "var(--accent)",
              }}
            >
              {feature.icon}
            </div>
            <div>
              <p className="font-medium text-sm" style={{ color: "var(--text-strong)" }}>
                {feature.title}
              </p>
              <p className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--text-weak)" }}>
                {feature.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <button
        onClick={onNext}
        className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-semibold text-sm transition-all duration-150"
        style={{
          background: "var(--accent)",
          color: "#fff",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "0.88";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "1";
        }}
      >
        Comenzar
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

// Paso 2: Conectar Canvas
function Step2Canvas({
  onNext,
  onGoToSettings,
}: {
  onNext: () => void;
  onGoToSettings: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      {/* Icono */}
      <div
        className="w-20 h-20 rounded-3xl flex items-center justify-center"
        style={{
          background: "rgba(16,185,129,0.12)",
          color: "rgb(16,185,129)",
        }}
      >
        <svg
          width="44"
          height="44"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </div>

      {/* Textos */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold" style={{ color: "var(--text-strong)" }}>
          Conecta tu Canvas
        </h1>
        <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: "var(--text-weak)" }}>
          Ingresa tus credenciales de Canvas LMS para sincronizar tus cursos, tareas y materiales automaticamente.
        </p>
      </div>

      {/* Pasos visuales */}
      <div
        className="w-full rounded-2xl p-5 space-y-3 text-left"
        style={{
          background: "var(--bg-surface-hover)",
          border: "1px solid var(--border-base)",
        }}
      >
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-ghost)" }}>
          Para conectar necesitas:
        </p>
        {[
          "La URL de tu institución en Canvas (ej: canvas.upc.edu.pe)",
          "Un Token de Acceso Personal generado desde Canvas",
          "Conexion a internet para la primera sincronizacion",
        ].map((item, i) => (
          <div key={i} className="flex items-start gap-3">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold"
              style={{
                background: "var(--accent-subtle, rgba(37,99,235,0.15))",
                color: "var(--accent)",
              }}
            >
              {i + 1}
            </div>
            <p className="text-sm leading-relaxed" style={{ color: "var(--text-base)" }}>
              {item}
            </p>
          </div>
        ))}
      </div>

      {/* Botones */}
      <div className="w-full space-y-3">
        <button
          onClick={onGoToSettings}
          className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-semibold text-sm transition-all duration-150"
          style={{
            background: "var(--accent)",
            color: "#fff",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = "0.88";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = "1";
          }}
        >
          Ir a configurar Canvas
          <ArrowRight size={16} />
        </button>

        <button
          onClick={onNext}
          className="w-full py-2.5 px-6 rounded-xl text-sm transition-all duration-150"
          style={{
            color: "var(--text-weak)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-base)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-weak)";
          }}
        >
          Ya conecte Canvas — Continuar
        </button>
      </div>
    </div>
  );
}

// Paso 3: Listo
function Step3Ready({
  stats,
  onComplete,
}: {
  stats: CourseStats;
  onComplete: () => void;
}) {
  const hasSynced = stats.courses > 0;

  return (
    <div className="flex flex-col items-center gap-8 text-center">
      {/* Icono */}
      <div
        className="w-20 h-20 rounded-3xl flex items-center justify-center"
        style={{
          background: "rgba(16,185,129,0.12)",
          color: "rgb(16,185,129)",
        }}
      >
        <CheckCircle2 size={44} strokeWidth={1} />
      </div>

      {/* Textos */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold" style={{ color: "var(--text-strong)" }}>
          Todo listo
        </h1>
        <p className="text-sm leading-relaxed max-w-xs mx-auto" style={{ color: "var(--text-weak)" }}>
          {hasSynced
            ? "Tus datos de Canvas estan sincronizados y listos para usar."
            : "Puedes configurar Canvas en cualquier momento desde Ajustes."}
        </p>
      </div>

      {/* Stats si hay datos */}
      {hasSynced && (
        <div className="w-full grid grid-cols-2 gap-3">
          <div
            className="rounded-xl py-4 px-3 text-center"
            style={{
              background: "var(--bg-surface-hover)",
              border: "1px solid var(--border-base)",
            }}
          >
            <p
              className="text-2xl font-bold tabular-nums"
              style={{ color: "var(--accent)" }}
            >
              {stats.courses}
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
              {stats.courses === 1 ? "Curso" : "Cursos"}
            </p>
          </div>
          <div
            className="rounded-xl py-4 px-3 text-center"
            style={{
              background: "var(--bg-surface-hover)",
              border: "1px solid var(--border-base)",
            }}
          >
            <p
              className="text-2xl font-bold tabular-nums"
              style={{ color: "rgb(16,185,129)" }}
            >
              {stats.assignments}
            </p>
            <p className="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
              {stats.assignments === 1 ? "Tarea" : "Tareas"}
            </p>
          </div>
        </div>
      )}

      {/* CTA */}
      <button
        onClick={onComplete}
        className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-semibold text-sm transition-all duration-150"
        style={{
          background: "var(--accent)",
          color: "#fff",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "0.88";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "1";
        }}
      >
        Empezar a estudiar
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function Onboarding({ onComplete, onGoToSettings }: OnboardingProps) {
  const [step, setStep] = useState<StepIndex>(0);
  const [stats, setStats] = useState<CourseStats>({ courses: 0, assignments: 0 });

  // Avanzar al Paso 3: cargar stats actuales de SQLite
  async function handleGoToStep3() {
    const currentStats = await loadStats();
    setStats(currentStats);
    setStep(2);
  }

  // Completar onboarding: persistir en SQLite y notificar al padre
  async function handleComplete() {
    await markOnboardingCompleted();
    onComplete();
  }

  // Handler para "Ir a configurar" — guarda que llegó al paso 2 y navega a Settings
  function handleGoToSettings() {
    onGoToSettings();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--bg-base)" }}
    >
      {/* Gradiente de fondo */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(37,99,235,0.08) 0%, transparent 70%)",
        }}
      />

      {/* Tarjeta principal */}
      <div
        className="relative z-10 w-full max-w-sm mx-auto px-6 py-10 rounded-2xl flex flex-col gap-0"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-base)",
        }}
      >
        {/* Contenido del paso actual */}
        <div className="flex-1">
          {step === 0 && (
            <Step1Welcome onNext={() => setStep(1)} />
          )}
          {step === 1 && (
            <Step2Canvas
              onNext={handleGoToStep3}
              onGoToSettings={handleGoToSettings}
            />
          )}
          {step === 2 && (
            <Step3Ready stats={stats} onComplete={handleComplete} />
          )}
        </div>

        {/* Indicador de pasos: 3 dots */}
        <div className="flex items-center justify-center gap-2 mt-8">
          {([0, 1, 2] as StepIndex[]).map((i) => (
            <div
              key={i}
              className="rounded-full transition-all duration-300"
              style={{
                width: step === i ? "20px" : "8px",
                height: "8px",
                background:
                  step === i
                    ? "var(--accent)"
                    : step > i
                    ? "rgba(255,255,255,0.35)"
                    : "rgba(255,255,255,0.18)",
              }}
            />
          ))}
        </div>
      </div>

      {/* Versión */}
      <span
        className="absolute bottom-4 right-6 text-xs"
        style={{ color: "var(--text-ghost, rgba(255,255,255,0.18))" }}
      >
        v0.1.0-alpha
      </span>
    </div>
  );
}

export default Onboarding;
