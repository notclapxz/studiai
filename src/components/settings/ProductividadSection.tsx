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

// ─── Subcomponente: input numérico reutilizable ──────────────────────────────

interface NumberInputProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  defaultValue: number;
}

function NumberInput({ label, value, min, max, onChange, defaultValue }: NumberInputProps) {
  return (
    <div>
      <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
        {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, parseInt(e.target.value, 10) || defaultValue))}
        className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors duration-150"
        style={{
          background: "var(--bg-surface-active)",
          border: "1px solid var(--border-ui)",
          color: "var(--text-strong)",
        }}
        onFocus={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-warm)"; }}
        onBlur={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-ui)"; }}
      />
    </div>
  );
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
          <Timer size={15} strokeWidth={1.5} style={{ color: "var(--accent-warm)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
            Timer Pomodoro
          </p>
        </div>
        <div className="space-y-3">
          <NumberInput
            label="Minutos de enfoque"
            value={pomodoroFocusMinutes}
            min={1}
            max={120}
            defaultValue={25}
            onChange={onPomodoroFocusChange}
          />
          <NumberInput
            label="Minutos de descanso"
            value={pomodoroBreakMinutes}
            min={1}
            max={60}
            defaultValue={5}
            onChange={onPomodoroBreakChange}
          />
        </div>
      </div>

      {/* Notificaciones de deadlines */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Clock size={15} strokeWidth={1.5} style={{ color: "var(--accent-warm)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
            Notificaciones de entregas
          </p>
        </div>
        <div className="space-y-3">
          {/* Toggle habilitado */}
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Notificar próximas entregas
            </span>
            <button
              onClick={() => onDeadlineNotificationsChange(!deadlineNotificationsEnabled)}
              className="relative rounded-full transition-colors duration-200 focus:outline-none"
              style={{
                width: 40,
                height: 22,
                background: deadlineNotificationsEnabled ? "var(--accent)" : "var(--border-ui)",
              }}
              aria-label="Activar notificaciones de entregas"
              role="switch"
              aria-checked={deadlineNotificationsEnabled}
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
            <NumberInput
              label="Avisar con cuántas horas de anticipación"
              value={deadlineLookaheadHours}
              min={1}
              max={168}
              defaultValue={24}
              onChange={onDeadlineLookaheadChange}
            />
          )}

          {/* Aviso de permisos macOS */}
          <p
            className="text-xs rounded-lg px-3 py-2"
            style={{ background: "var(--bg-modal-nav)", color: "var(--text-muted)" }}
          >
            En macOS puede aparecer un diálogo de permisos la primera vez. Si no ves notificaciones, ve a{" "}
            <span style={{ color: "var(--text-strong)" }}>Preferencias del Sistema → Notificaciones</span> y activa StudyAI.
          </p>
        </div>
      </div>

      {/* Botón guardar */}
      <button
        onClick={handleSave}
        disabled={isSavingProductivity}
        className="w-full py-2 rounded-lg text-sm font-medium transition-all duration-150"
        style={{
          background: productivitySaveOk ? "var(--success)" : "var(--accent)",
          color: "var(--text-strong)",
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
