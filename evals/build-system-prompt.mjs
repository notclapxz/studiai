// build-system-prompt.mjs — ensambla el system prompt REAL desde las secciones
// 01-07 para que promptfoo evalúe lo mismo que corre en producción.
//
// Refleja build_system_prompt() de src-tauri/src/lib.rs en su parte ESTÁTICA
// (las 7 secciones + few-shot). El contexto de runtime (fecha, curso activo,
// mini-prompt por intent) es dinámico y no se evalúa aquí: el golden set mide
// la voz, el formato y la pedagogía del núcleo del prompt.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sectionsDir = join(here, "..", "src-tauri", "src", "prompts", "sections");

const ORDER = [
  "01-base",
  "02-comportamiento",
  "03-capacidades",
  "04-herramientas",
  "05-formato",
  "06-estilo",
  "07-coaching",
];

const SYSTEM = ORDER
  .map((name) => readFileSync(join(sectionsDir, `${name}.txt`), "utf8").trim())
  .join("\n\n");

// promptfoo llama esta función por test, inyectando vars.pregunta.
export default function ({ vars }) {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: vars.pregunta },
  ];
}
