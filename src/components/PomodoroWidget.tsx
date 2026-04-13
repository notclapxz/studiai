// PomodoroWidget.tsx — Modal compacto del timer Pomodoro
// Muestra MM:SS, botones Start/Pause/Reset y contador de ciclos completados

import { useTimerStore } from "../store/timerStore";
import { cn } from "../lib/cn";
import { Timer, X, Play, Pause, RotateCcw } from "lucide-react";

interface PomodoroWidgetProps {
  onClose: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function PomodoroWidget({ onClose }: PomodoroWidgetProps) {
  const { phase, secondsLeft, cycles, isRunning, start, pause, reset } = useTimerStore();

  const phaseLabel =
    phase === "focus" ? "Enfoque" : phase === "break" ? "Descanso" : "Listo";

  const phaseColor =
    phase === "focus"
      ? "text-red-400"
      : phase === "break"
        ? "text-emerald-400"
        : "text-zinc-400";

  const ringColor =
    phase === "focus"
      ? "border-red-500/40"
      : phase === "break"
        ? "border-emerald-500/40"
        : "border-zinc-600/40";

  return (
    // Overlay con fondo semitransparente
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => {
        // Cerrar al hacer click fuera del modal
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel central */}
      <div
        className={cn(
          "relative bg-zinc-900 border rounded-2xl p-8 flex flex-col items-center gap-6 shadow-2xl w-72",
          ringColor
        )}
        style={{ minWidth: 280 }}
      >
        {/* Botón cerrar */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors"
          aria-label="Cerrar Pomodoro"
        >
          <X size={18} />
        </button>

        {/* Icono + título */}
        <div className="flex items-center gap-2">
          <Timer size={18} className={phaseColor} />
          <span className="text-sm font-medium text-zinc-400">Pomodoro</span>
        </div>

        {/* Fase actual */}
        <span className={cn("text-xs font-semibold uppercase tracking-widest", phaseColor)}>
          {phaseLabel}
        </span>

        {/* Tiempo */}
        <span className="text-6xl font-mono font-bold text-white tabular-nums">
          {formatTime(secondsLeft)}
        </span>

        {/* Ciclos completados */}
        <span className="text-xs text-zinc-500">
          {cycles === 0
            ? "Sin ciclos completados"
            : `${cycles} ciclo${cycles !== 1 ? "s" : ""} completado${cycles !== 1 ? "s" : ""}`}
        </span>

        {/* Controles */}
        <div className="flex items-center gap-3">
          {/* Reset */}
          <button
            onClick={reset}
            className="p-2 rounded-full text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            aria-label="Reiniciar"
          >
            <RotateCcw size={18} />
          </button>

          {/* Start / Pause */}
          <button
            onClick={isRunning ? pause : start}
            className={cn(
              "px-6 py-2.5 rounded-full text-sm font-semibold transition-colors",
              isRunning
                ? "bg-zinc-700 hover:bg-zinc-600 text-white"
                : phase === "focus" || phase === "idle"
                  ? "bg-red-600 hover:bg-red-500 text-white"
                  : "bg-emerald-600 hover:bg-emerald-500 text-white"
            )}
          >
            {isRunning ? (
              <span className="flex items-center gap-1.5">
                <Pause size={14} /> Pausar
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Play size={14} /> {phase === "idle" ? "Iniciar" : "Continuar"}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
