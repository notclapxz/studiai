// documentStyle.ts — Tipos y catálogo de opciones del estilo de documento.
// Espeja el `StyleConfig` de Rust (src-tauri/src/pdf/mod.rs). Los enums textuales
// se validan en el backend (`StyleConfig::validate`); aquí los acotamos con
// uniones literales para que el dropdown nunca emita un valor fuera de dominio.

export interface StyleConfig {
  format: "apa" | "harvard" | "ieee" | "mla";
  font_family: "inter" | "lora" | "mono";
  font_size: number; // 10..=14 (i64 en Rust)
  line_height: number; // 1.0 | 1.15 | 1.5 | 2.0
  margins_cm: number; // 2.0 | 2.5 | 3.0
  orientation: "portrait" | "landscape";
  logo: "usil" | "utec" | "none";
  cover_theme: "light" | "dark" | "minimal";
  accent_color: "blue" | "red" | "green" | "purple";
  presentation_ratio: "16:9" | "4:3";
  presentation_theme: "light" | "dark" | "colorful";
}

/** Defaults idénticos a los del backend (migración 17 + `StyleConfig::default`). */
export const STYLE_DEFAULTS: StyleConfig = {
  format: "apa",
  font_family: "inter",
  font_size: 12,
  line_height: 1.5,
  margins_cm: 2.5,
  orientation: "portrait",
  logo: "none",
  cover_theme: "light",
  accent_color: "blue",
  presentation_ratio: "16:9",
  presentation_theme: "light",
};

// ─── Catálogo de opciones (label en español, value = dominio backend) ────────

export interface Option<V> {
  value: V;
  label: string;
}

export const FORMAT_OPTIONS: Option<StyleConfig["format"]>[] = [
  { value: "apa", label: "APA" },
  { value: "harvard", label: "Harvard" },
  { value: "ieee", label: "IEEE" },
  { value: "mla", label: "MLA" },
];

export const FONT_OPTIONS: Option<StyleConfig["font_family"]>[] = [
  { value: "inter", label: "Inter (Sans)" },
  { value: "lora", label: "Lora (Serif)" },
  { value: "mono", label: "JetBrains Mono" },
];

export const SIZE_OPTIONS: Option<number>[] = [10, 11, 12, 13, 14].map((n) => ({
  value: n,
  label: `${n}pt`,
}));

export const LINE_HEIGHT_OPTIONS: Option<number>[] = [
  { value: 1.0, label: "1.0" },
  { value: 1.15, label: "1.15" },
  { value: 1.5, label: "1.5" },
  { value: 2.0, label: "2.0" },
];

export const MARGINS_OPTIONS: Option<number>[] = [
  { value: 2.0, label: "2.0 cm" },
  { value: 2.5, label: "2.5 cm" },
  { value: 3.0, label: "3.0 cm" },
];

export const ORIENTATION_OPTIONS: Option<StyleConfig["orientation"]>[] = [
  { value: "portrait", label: "Vertical" },
  { value: "landscape", label: "Apaisado" },
];

export const LOGO_OPTIONS: Option<StyleConfig["logo"]>[] = [
  { value: "usil", label: "USIL" },
  { value: "utec", label: "UTEC" },
  { value: "none", label: "Ninguno" },
];

export const COVER_THEME_OPTIONS: Option<StyleConfig["cover_theme"]>[] = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Oscuro" },
  { value: "minimal", label: "Minimal" },
];

export const ACCENT_OPTIONS: Option<StyleConfig["accent_color"]>[] = [
  { value: "blue", label: "Azul" },
  { value: "red", label: "Rojo" },
  { value: "green", label: "Verde" },
  { value: "purple", label: "Púrpura" },
];

export const RATIO_OPTIONS: Option<StyleConfig["presentation_ratio"]>[] = [
  { value: "16:9", label: "16:9" },
  { value: "4:3", label: "4:3" },
];

export const PRES_THEME_OPTIONS: Option<StyleConfig["presentation_theme"]>[] = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Oscuro" },
  { value: "colorful", label: "Colorido" },
];
