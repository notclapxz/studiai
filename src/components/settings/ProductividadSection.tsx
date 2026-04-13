// ProductividadSection.tsx — Sección de productividad en SettingsModal

import { invoke } from "@tauri-apps/api/core";
import { Timer, Clock } from "lucide-react";

// ─── Props ──────────────────────────────────────────────────────────────────

interface ProductividadSectionProps {
  pomodoroFocusMinutes: number;
  pomodoroBreakMinutes: number;
  deadlineNotificationsEnabled: boolean;
  deadlineLookaheadHours: number;
  isSavingProductivity: boolean;
  productivitySaveOk: boolean;
  onPomodoroFocusChange: (value: number) => void;
  onPomodoroBreakChange: (value: number) => void;
  onDeadlineNotificationsChange: (value: boolean) => void;
  onDeadlineLookaheadChange: (value: number) => void;
  onSavingChange: (value: boolean) => void;
  onSaveOkChange: (value: boolean) => void;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function ProductividadSection({
  pomodoroFocusMinutes,
  pomodoroBreakMinutes,
  deadlineNotificationsEnabled,
  deadlineLookaheadHours,
  isSavingProductivity,
  productivitySaveOk,
  onPomodoroFocusChange,
  onPomodoroBreakChange,
  onDeadlineNotificationsChange,
  onDeadlineLookaheadChange,
  onSavingChange,
  onSaveOkChange,
}: ProductividadSectionProps) {
  async function handleSave() {
    onSavingChange(true);
    try {
      await Promise.all([
        invoke("set_setting", { key: "pomodoro_focus_minutes", value: String(pomodoroFocusMinutes) }),
        invoke("set_setting", { key: "pomodoro_break_minutes", value: String(pomodoroBreakMinutes) }),
        invoke("set_setting", { key: "deadline_notifications_enabled", value: String(deadlineNotificationsEnabled) }),
        invoke("set_setting", { key: "deadline_lookahead_hours", value: String(deadlineLookaheadHours) }),
      ]);
      onSaveOkChange(true);
      setTimeout(() => onSaveOkChange(false), 2000);
    } catch (err: unknown) {
      console.error("Error guardando configuración de productividad:", err);
    } finally {
      onSavingChange(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Pomodoro */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Timer size={15} strokeWidth={1.5} style={{ color: "#fab283" }} />
          <p className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
            Timer Pomodoro
          </p>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "#9a9aaa" }}>
              Minutos de enfoque
            </label>
            <input
              type="number"
              min={1}
              max={120}
              value={pomodoroFocusMinutes}
              onChange={(e) => onPomodoroFocusChange(Math.max(1, parseInt(e.target.value, 10) || 25))}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "#2a2a2a",
                border: "1px solid #4b4c5c",
                color: "#e0e0e0",
              }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1.5" style={{ color: "#9a9aaa" }}>
              Minutos de descanso
            </label>
            <input
              type="number"
              min={1}
              max={60}
              value={pomodoroBreakMinutes}
              onChange={(e) => onPomodoroBreakChange(Math.max(1, parseInt(e.target.value, 10) || 5))}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: "#2a2a2a",
                border: "1px solid #4b4c5c",
                color: "#e0e0e0",
              }}
            />
          </div>
        </div>
      </div>

      {/* Notificaciones de deadlines */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Clock size={15} strokeWidth={1.5} style={{ color: "#fab283" }} />
          <p className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
            Notificaciones de entregas
          </p>
        </div>
        <div className="space-y-3">
          {/* Toggle habilitado */}
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "#9a9aaa" }}>
              Notificar próximas entregas
            </span>
            <button
              onClick={() => onDeadlineNotificationsChange(!deadlineNotificationsEnabled)}
              className="relative rounded-full transition-colors duration-200"
              style={{
                width: 40,
                height: 22,
                background: deadlineNotificationsEnabled ? "#2563eb" : "#3a3a3a",
              }}
              aria-label="Activar notificaciones de entregas"
            >
              <span
                className="absolute top-0.5 rounded-full transition-transform duration-200 bg-white"
                style={{
                  width: 18,
                  height: 18,
                  left: 2,
                  transform: deadlineNotificationsEnabled ? "translateX(18px)" : "translateX(0)",
                }}
              />
            </button>
          </div>

          {/* Lookahead horas */}
          {deadlineNotificationsEnabled && (
            <div>
              <label className="block text-xs mb-1.5" style={{ color: "#9a9aaa" }}>
                Avisar con cuántas horas de anticipación
              </label>
              <input
                type="number"
                min={1}
                max={168}
                value={deadlineLookaheadHours}
                onChange={(e) => onDeadlineLookaheadChange(Math.max(1, parseInt(e.target.value, 10) || 24))}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{
                  background: "#2a2a2a",
                  border: "1px solid #4b4c5c",
                  color: "#e0e0e0",
                }}
              />
            </div>
          )}

          {/* Aviso de permisos macOS */}
          <p className="text-xs rounded-lg px-3 py-2" style={{ background: "#1a1a1a", color: "#9a9aaa" }}>
            En macOS puede aparecer un diálogo de permisos la primera vez. Si no ves notificaciones, ve a{" "}
            <span style={{ color: "#e0e0e0" }}>Preferencias del Sistema → Notificaciones</span> y activa StudyAI.
          </p>
        </div>
      </div>

      {/* Botón guardar */}
      <button
        onClick={handleSave}
        disabled={isSavingProductivity}
        className="w-full py-2 rounded-lg text-sm font-medium transition-colors"
        style={{
          background: productivitySaveOk ? "#16a34a" : "#2563eb",
          color: "#fff",
          opacity: isSavingProductivity ? 0.7 : 1,
        }}
      >
        {isSavingProductivity
          ? "Guardando..."
          : productivitySaveOk
            ? "✓ Guardado"
            : "Guardar cambios"}
      </button>
    </div>
  );
}
