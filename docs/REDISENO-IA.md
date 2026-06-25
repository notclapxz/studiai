# Rediseño del motor de IA — referencia y decisiones (jun 2026)

Doc de referencia del rediseño de prompts/modelo de StudiAI hecho el 2026-06-24.
Guarda el **porqué** (con fuentes) para no re-investigar ni revertir decisiones por
olvido. Estado operativo y commits: ver `../../DONDE_NOS_QUEDAMOS.md` y `../../PENDIENTES.md`.

---

## Principio rector

El system prompt **no enseña conocimiento al modelo** (qué es una derivada, markdown
básico — eso lo infiere). Existe para imponer dos cosas que el modelo NO puede adivinar:

1. **Decisiones de producto** (el modelo por defecto haría otra cosa): "corto por
   defecto" (los LLM son verbosos), separación del contexto del curso, citar "Fuentes:",
   política de analogías, coaching.
2. **La API de tools custom**: sintaxis Typst, los `doc_type`, filtros con underscore,
   formato UTC-5.

Corolario para futuros recortes: recorta conocimiento y redundancia; **conserva las
decisiones y la spec de tools**. Si las quitas, el modelo revierte a su comportamiento
default (verboso, mezcla contextos, no conoce tu Typst) → peor producto.

---

## Hallazgos del research (LLM-tutor architecture, jun 2026)

Investigación multi-fuente. Las tres guías oficiales coinciden:

- **Prompt corto y de alta señal.** Un prompt largo sufre "context rot" (menos precisión
  a más tokens). Anthropic: *"the smallest possible set of high-signal tokens"*; Google:
  *"un prompt por instrucción"*.
  - [Effective context engineering (Anthropic)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  - [Prompt design strategies (Gemini)](https://ai.google.dev/gemini-api/docs/prompting-strategies)
- **Framing positivo > prohibiciones.** Las MAYÚSCULAS / `NEVER` / `CERO` hacen
  *over-trigger* en modelos frontier; y por el "efecto elefante rosa", prohibir X tiende a
  invocar X. Mejor: instrucción afirmativa + su razón.
  - [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
  - [Negation: A Pink Elephant in the LLMs' Room (arXiv 2503.22395)](https://arxiv.org/html/2503.22395v2)
- **Contradicciones se resuelven por recencia** (gana la regla más cercana al final), en
  silencio. En un prompt largo son casi seguras → hay que eliminarlas.
  - [GPT-4.1 Prompting Guide (OpenAI)](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide)
- **Pedagogía con evidencia** (RCTs: Sierra Leona +0.26 SD; Harvard ~2×): retener la
  respuesta por defecto cuando se aprende, una pregunta guía a la vez, **desvanecer el
  andamiaje según sube la competencia**. ⚠️ Socrático mal calibrado frustra y no sube
  notas (Wharton: IA sin guardrails deja al alumno peor al quitarla).
  - [LearnLM (arXiv 2412.16429)](https://arxiv.org/html/2412.16429v1) · [Sierra Leona RCT (DeepMind)](https://deepmind.google/blog/measuring-the-impact-of-learning-with-ai-in-sierra-leone-and-beyond/)
- **Intent routing por keywords que reescribe el comportamiento por turno = anti-pattern.**
  Un agente + tools (AUTO) es lo recomendado; routing solo si las categorías son
  distintas y la clasificación es fiable.
  - [Building Effective Agents (Anthropic)](https://www.anthropic.com/engineering/building-effective-agents)
- **Caching e modelos (Gemini 2.5):** el *implicit caching* es automático (75% off en el
  prefijo repetido, sin código, sin storage; mín. 1024 tokens). El `maxOutputTokens` es un
  techo, NO un costo. Flash-Lite (`gemini-2.5-flash-lite`) es el tier barato para tareas
  triviales.
  - [Gemini implicit caching](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/) · [Context caching docs](https://ai.google.dev/gemini-api/docs/caching)

(El reporte completo del research, con la tabla de precios de modelos 2026 verificada,
quedó en engram: `studiai/llm-tutor-research`.)

---

## Qué se cambió (plan #1–#5)

- **#1 Prompt recortado**: secciones 446→267 líneas + few-shot 149→86 (~40% menos).
  Contradicciones resueltas, prohibiciones → afirmaciones con su razón, redundancia
  eliminada (cada tema en un archivo; regla "no pegues salida cruda" hoisteada de ~9 tools
  a una global en `04`).
- **#2 Keyword-routing eliminado** (`detect_intent`, `MessageIntent`, mini-prompts por
  intent, `build_tool_config`/`ToolConfig` — ~190 líneas de Rust borradas). Un solo prompt
  adaptativo; tools en **AUTO siempre** (sin forzar `web_search`).
- **#3 Caching**: implicit caching ya activo; se agregó log `[gemini:usage]` del cache-hit
  por request. NO se tocó `maxOutputTokens` (alto a propósito para `create_file`/`create_pdf`).
- **#4 Ruteo de modelos estructural** (por función, no por contenido del mensaje):
  `GEMINI_MODEL_CHAT = gemini-2.5-flash` (chat + OCR) · `GEMINI_MODEL_UTILITY =
  gemini-2.5-flash-lite` (resumen de sesión + compactación). NO multi-provider (frágil).
- **#5 Golden set de evals**: `evals/` con 18 casos + promptfoo (anti-voseo + llm-rubric).

---

## Decisiones de producto (validar con datos de beta)

- **Analogías**: off por defecto; solo cuando el estudiante no engancha ("no entiendo") o
  la pide. (Era una contradicción en 5 lugares.)
- **Pedagogía**: se MANTUVO la identidad "compañero eficiente" (responde directo, completa
  tareas, coaching solo cuando se pide). NO se giró a tutor Socrático puro — es decisión de
  producto y el Socrático mal calibrado frustra. Reevaluar con datos.
- **Modelo del chat**: sigue `gemini-2.5-flash`. Subirlo a uno más nuevo es decisión de
  calidad a validar con el golden set, no a ciegas.

---

## Verificación hecha (smoke test contra Gemini)

Runners en `evals/smoke-prompt.mjs` (12 casos texto) y `evals/smoke-tools.mjs` (alucinación
con tools). Resultado: voz, coaching, correcciones y separación de contexto funcionan. La
"alucinación de deadlines" que apareció sin tools **NO ocurre con tools** (el modelo llama
`get_upcoming_deadlines` o calla) → era artefacto de la prueba, no un bug del prompt.
Falta el smoke test de la APP real (GUI, tools ejecutándose, Canvas) y el A/B del golden set.

---

## Memoria local del estudiante — FEATURE POST-BETA #1

Decidido (no construir hasta validar retención). Persistente, **por usuario, local** (no en
servidor). En **Rust sobre el SQLite existente**; modelo inspirado en engram pero SIN
embeber el binario Go (es un MCP server pensado para devs; embeberlo en Tauri sería
sobre-ingeniería). MVP: tabla `student_memory(kind, content, embedding)` + tool
`remember()` + recall automático al prompt por embeddings (infra ya existe en `search_notes`).
Resolvería casos como la nota de aprobación, que varía por estudiante.
