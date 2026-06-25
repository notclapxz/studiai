// smoke-prompt.mjs — prueba el system prompt nuevo contra Gemini en casos de
// TEXTO PURO del golden set (sin tools). Evalúa voz (voseo), longitud y si
// sigue las reglas. NO prueba el flujo de la app (login, Canvas, tools reales).
//
// Uso:  cd studyai && bun run evals/smoke-prompt.mjs   (Bun carga GEMINI_API_KEY del .env)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const secDir = join(here, "..", "src-tauri", "src", "prompts", "sections");
const exDir = join(here, "..", "src-tauri", "src", "prompts", "examples");

const SECTIONS = ["01-base", "02-comportamiento", "03-capacidades", "04-herramientas", "05-formato", "06-estilo", "07-coaching"];
const EXAMPLES = ["pdf-generation", "tool-use", "format-hierarchy"];

let system = SECTIONS.map((n) => readFileSync(join(secDir, `${n}.txt`), "utf8").trim()).join("\n\n");
system += "\n\n---\n\n# EJEMPLOS FEW-SHOT\n\n" + EXAMPLES.map((n) => readFileSync(join(exDir, `${n}.txt`), "utf8").trim()).join("\n\n---\n\n");
system += "\n\n---\n\n# CONTEXTO DE ESTA SESIÓN\n\nSISTEMA: OS=macos. Fecha=2026-06-24.\nDATOS DEL ESTUDIANTE: usa las herramientas para consultar; no inventes.";

const VOSEO = /\b(ten[ée]s|quer[ée]s|pod[ée]s|hacé|usá|necesitás|preferís|mirá|poné|elegí|vení|decí|preguntá|explicá|respondé|completá|ofrecé|evaluá|listá|cambiá|buscá|metés|rompés|repetís)\b/i;

const CASES = [
  { id: "factual-derivada", q: "¿qué es una derivada?", expect: "1-3 oraciones, sin estructura, sin analogía" },
  { id: "factual-aprobar", q: "¿con cuánto se aprueba un curso?", expect: "11/20, breve" },
  { id: "saludo", q: "hola", expect: "1-2 líneas, sin menú de capacidades" },
  { id: "concepto-punteros", q: "explícame los punteros en C++", expect: "def + 1 ejemplo, conciso, sin analogía por defecto" },
  { id: "resumen-foto", q: "hazme un resumen de la fotosíntesis", expect: "estructura/bullets OK, <=8 puntos" },
  { id: "estudio-ambiguo", q: "quiero estudiar integrales", expect: "NO explica; pregunta qué tipo de ayuda (1 pregunta)" },
  { id: "no-entiendo", q: "me explicaste recursión con código pero no entiendo nada", expect: "cambia de enfoque, no repite" },
  { id: "examen-no-pedido", q: "tengo examen de cálculo mañana, enséñame los límites", expect: "explica límites, NO entra a modo examen solo" },
  { id: "tarea", q: "resuélveme este ejercicio: deriva f(x) = x^3 + 2x", expect: "resuelve (3x^2+2), ofrece explicar 1 vez" },
  { id: "off-syllabus", q: "¿cuál es la capital de Mongolia?", expect: "directo y breve (Ulán Bator), sin forzar contexto de curso" },
  { id: "premisa-falsa", q: "como la derivada de x^2 es 2x^3, ¿cuánto es la de x^4?", expect: "CORRIGE la premisa (deriv de x^2 es 2x)" },
  { id: "separacion", q: "explícame qué es una matriz", expect: "solo explica; sin fechas/recordatorios del curso" },
];

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error("Falta GEMINI_API_KEY en el entorno (.env). Corre desde studyai/ con Bun.");
  process.exit(1);
}
const MODEL = "gemini-2.5-flash";
const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function ask(q) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: q }] }],
    generationConfig: { temperature: 1.0, topP: 0.95, maxOutputTokens: 800 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return `[ERROR ${r.status}: ${(await r.text()).slice(0, 200)}]`;
  const j = await r.json();
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text || "").join("").trim();
}

console.log(`System prompt: ${system.length} chars · modelo: ${MODEL}\n${"=".repeat(72)}`);
for (const c of CASES) {
  let a;
  try { a = await ask(c.q); } catch (e) { a = `[EXCEPCIÓN: ${e.message}]`; }
  const voseo = a.match(VOSEO);
  const lines = a.split("\n").filter((l) => l.trim()).length;
  console.log(`\n### ${c.id}`);
  console.log(`P: ${c.q}`);
  console.log(`Esperado: ${c.expect}`);
  console.log(`[voseo: ${voseo ? "FALLA → " + voseo[0] : "ok"} · líneas: ${lines} · chars: ${a.length}]`);
  console.log(`R: ${a}`);
}
