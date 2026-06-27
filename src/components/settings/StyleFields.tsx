// StyleFields.tsx — Presentacional puro: renderiza todos los dropdowns/radios
// de un `StyleConfig`. NO persiste nada; emite parches via `onChange`.
// Lo reutilizan DocumentosSection (auto-save) y DocumentModal (override local).

import type { ReactNode } from "react";
import {
  type StyleConfig,
  type Option,
  FORMAT_OPTIONS,
  FONT_OPTIONS,
  SIZE_OPTIONS,
  LINE_HEIGHT_OPTIONS,
  MARGINS_OPTIONS,
  ORIENTATION_OPTIONS,
  LOGO_OPTIONS,
  COVER_THEME_OPTIONS,
  ACCENT_OPTIONS,
  RATIO_OPTIONS,
  PRES_THEME_OPTIONS,
} from "../../lib/documentStyle";

interface StyleFieldsProps {
  config: StyleConfig;
  onChange: (patch: Partial<StyleConfig>) => void;
  /** Modo compacto para el panel de override del modal (menos secciones/títulos). */
  compact?: boolean;
}

// ─── Átomos ──────────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
      {children}
    </label>
  );
}

interface SelectProps<V extends string | number> {
  label: string;
  value: V;
  options: Option<V>[];
  onSelect: (value: V) => void;
}

function Select<V extends string | number>({ label, value, options, onSelect }: SelectProps<V>) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={String(value)}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onSelect(opt.value);
        }}
        className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors duration-150"
        style={{
          background: "var(--bg-surface-active)",
          border: "1px solid var(--border-ui)",
          color: "var(--text-strong)",
        }}
        onFocus={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-warm)";
        }}
        onBlur={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = "var(--border-ui)";
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface RadioRowProps<V extends string> {
  label: string;
  name: string;
  value: V;
  options: Option<V>[];
  onSelect: (value: V) => void;
}

function RadioRow<V extends string>({ label, name, value, options, onSelect }: RadioRowProps<V>) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-2 flex-wrap">
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onSelect(o.value)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-100"
              style={
                selected
                  ? { background: "var(--accent-warm)", color: "var(--bg-modal)" }
                  : {
                      background: "var(--bg-surface-active)",
                      color: "var(--text-strong)",
                      border: "1px solid var(--border-ui)",
                    }
              }
              role="radio"
              aria-checked={selected}
              aria-label={`${name}: ${o.label}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm font-semibold mb-3" style={{ color: "var(--text-strong)" }}>
      {children}
    </p>
  );
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function StyleFields({ config, onChange, compact = false }: StyleFieldsProps) {
  return (
    <div className={compact ? "space-y-3" : "space-y-6"}>
      {/* Formato de cita */}
      <div>
        {!compact && <SectionTitle>Formato de documento</SectionTitle>}
        <Select
          label="Formato de cita"
          value={config.format}
          options={FORMAT_OPTIONS}
          onSelect={(v) => onChange({ format: v })}
        />
      </div>

      {/* Tipografía */}
      <div className="space-y-3">
        {!compact && <SectionTitle>Tipografía</SectionTitle>}
        <Select
          label="Fuente"
          value={config.font_family}
          options={FONT_OPTIONS}
          onSelect={(v) => onChange({ font_family: v })}
        />
        <Select
          label="Tamaño"
          value={config.font_size}
          options={SIZE_OPTIONS}
          onSelect={(v) => onChange({ font_size: v })}
        />
        <Select
          label="Interlineado"
          value={config.line_height}
          options={LINE_HEIGHT_OPTIONS}
          onSelect={(v) => onChange({ line_height: v })}
        />
      </div>

      {/* Carátula */}
      <div className="space-y-3">
        {!compact && <SectionTitle>Carátula</SectionTitle>}
        <RadioRow
          label="Logo"
          name="logo"
          value={config.logo}
          options={LOGO_OPTIONS}
          onSelect={(v) => onChange({ logo: v })}
        />
        <Select
          label="Tema de carátula"
          value={config.cover_theme}
          options={COVER_THEME_OPTIONS}
          onSelect={(v) => onChange({ cover_theme: v })}
        />
        <Select
          label="Color de acento"
          value={config.accent_color}
          options={ACCENT_OPTIONS}
          onSelect={(v) => onChange({ accent_color: v })}
        />
      </div>

      {/* Márgenes y orientación */}
      <div className="space-y-3">
        {!compact && <SectionTitle>Márgenes y orientación</SectionTitle>}
        <Select
          label="Márgenes"
          value={config.margins_cm}
          options={MARGINS_OPTIONS}
          onSelect={(v) => onChange({ margins_cm: v })}
        />
        <RadioRow
          label="Orientación"
          name="orientation"
          value={config.orientation}
          options={ORIENTATION_OPTIONS}
          onSelect={(v) => onChange({ orientation: v })}
        />
      </div>

      {/* Presentaciones */}
      <div className="space-y-3">
        {!compact && <SectionTitle>Presentaciones</SectionTitle>}
        <Select
          label="Proporción (ratio)"
          value={config.presentation_ratio}
          options={RATIO_OPTIONS}
          onSelect={(v) => onChange({ presentation_ratio: v })}
        />
        <Select
          label="Tema de presentación"
          value={config.presentation_theme}
          options={PRES_THEME_OPTIONS}
          onSelect={(v) => onChange({ presentation_theme: v })}
        />
      </div>
    </div>
  );
}
