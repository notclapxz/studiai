// smoke-tools.mjs — confirma si la "alucinación de deadlines" era por falta de
// tools. Pasa las tool definitions reales (datos de curso) SIN ejecutarlas, y
// observa si el modelo INTENTA llamar get_upcoming_deadlines/search_notes en vez
// de inventar. Corre los casos problemáticos varias veces (temp 1.0 = variable).
//
// Uso:  cd studyai && bun run evals/smoke-tools.mjs

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

// Tool defs de DATOS DE CURSO, verbatim de build_tools() en lib.rs.
const TOOLS = [{
  functionDeclarations: [
    { name: "get_upcoming_deadlines", description: "Obtiene las tareas y entregas próximas del estudiante con fechas límite. Úsala cuando el estudiante pregunta por sus tareas, fechas de entrega, exámenes próximos o deadlines.", parameters: { type: "object", properties: { days_ahead: { type: "integer", description: "Cuántos días a futuro buscar (default 7, máximo 90)" } }, required: [] } },
    { name: "get_announcements", description: "Obtiene los anuncios recientes de los cursos del estudiante. Úsala cuando pregunta por novedades, avisos o comunicados de sus profesores.", parameters: { type: "object", properties: { limit: { type: "integer", description: "Número de anuncios a recuperar (default 10, máximo 50)" } }, required: [] } },
    { name: "search_notes", description: "Busca en el contenido de los PDFs y materiales del estudiante indexados. Por defecto filtra al curso activo del chat. Usar cuando el estudiante pregunta sobre contenido específico de sus materiales.", parameters: { type: "object", properties: { query: { type: "string", description: "Términos de búsqueda en los materiales" } }, required: ["query"] } },
    { name: "list_documents", description: "Lista los documentos (PDFs) indexados del estudiante. SIEMPRE usa esto ANTES de read_document.", parameters: { type: "object", properties: { filter: { type: "string", description: "Filtro por nombre de archivo" } } } },
  ],
}];

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("Falta GEMINI_API_KEY"); process.exit(1); }
const MODEL = "gemini-2.5-flash";
const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function ask(q) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: q }] }],
    tools: TOOLS,
    generationConfig: { temperature: 1.0, topP: 0.95, maxOutputTokens: 800 },
  };
  const r = await fetch(url, { method: "POST", headers: { "x-goog-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return { calls: [], text: `[ERROR ${r.status}: ${(await r.text()).slice(0, 160)}]` };
  const j = await r.json();
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall.name);
  const text = parts.filter((p) => p.text).map((p) => p.text).join("").trim();
  return { calls, text };
}

// Heurística: ¿el texto afirma un deadline/fecha concreta sin haber consultado?
const DATE = /\b\d{1,2}\/\d{1,2}\b|\bvence\b|\bentrega\b.*\b\d|\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i;

const RUNS = [
  { id: "saludo", q: "hola", n: 3 },
  { id: "aprobar", q: "¿con cuánto se aprueba un curso?", n: 3 },
  { id: "deadlines-directo (control +)", q: "¿qué tareas tengo esta semana?", n: 2 },
  { id: "separacion (control -)", q: "explícame qué es una matriz", n: 2 },
  { id: "off-syllabus (control -)", q: "¿cuál es la capital de Mongolia?", n: 1 },
];

console.log(`Con tools de curso · modelo: ${MODEL}\n${"=".repeat(72)}`);
for (const run of RUNS) {
  console.log(`\n### ${run.id}  —  "${run.q}"`);
  for (let i = 1; i <= run.n; i++) {
    const { calls, text } = await ask(run.q);
    const toolStr = calls.length ? `TOOL→ ${calls.join(", ")}` : "(solo texto)";
    const inventa = !calls.length && DATE.test(text) ? "  ⚠️ AFIRMA FECHA SIN CONSULTAR" : "";
    console.log(`  [${i}] ${toolStr}${inventa}`);
    if (!calls.length) console.log(`       texto: ${text.replace(/\n+/g, " ").slice(0, 180)}`);
  }
}
