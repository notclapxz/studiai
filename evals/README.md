# Evals — golden set del tutor StudiAI

Harness mínimo para medir la calidad del prompt **antes/después** de cada cambio.
Nace del research de rediseño (junio 2026): no toques el prompt a ciegas, mídelo.

## Qué mide

Por cada caso del `golden-set.yaml`, sobre la respuesta del modelo:

- **Anti-voseo** (`asserts/no-voseo.js`) — determinista, $0. Falla si aparece voseo rioplatense.
- **Español neutro / registro** — juez LLM.
- **Pedagogía / formato / longitud** — juez LLM, criterio por caso (definido en cada test).

## Cómo correr

Necesitas una API key de Gemini (la misma que usa la app, en `studyai/.env`):

```bash
cd evals
GEMINI_API_KEY=tu_key bunx promptfoo@latest eval
bunx promptfoo@latest view     # abre el reporte en el navegador
```

> `GOOGLE_API_KEY` también funciona. No se instala nada global: `bunx` lo corre efímero.

## A/B test (rediseño o cambio de modelo)

En `promptfooconfig.yaml`, descomenta el segundo provider (p. ej. `gemini-3.5-flash`)
y vuelve a correr `eval`: promptfoo muestra ambos lado a lado por caso. Así comparas
el prompt viejo vs el nuevo, o un modelo vs otro, con los mismos 18 casos.

## Estructura

- `golden-set.yaml` — los casos (el activo durable; amplíalo con preguntas reales tuyas).
- `build-system-prompt.mjs` — ensambla el system prompt real desde `src-tauri/src/prompts/sections/`.
- `asserts/no-voseo.js` — assert determinista de voz.
- `promptfooconfig.yaml` — providers, asserts globales, modelo juez.

## Límites (a propósito)

- Evalúa el **núcleo estático** del prompt (las 7 secciones), no el contexto de
  runtime (fecha, curso activo, mini-prompt por intent) que se inyecta en Rust.
  Suficiente para voz, formato y pedagogía; no cubre el comportamiento con tools reales.
- No ejecuta las herramientas (Canvas, PDF). Para eso, prueba manual en la app.
- 18 casos es el piso. La guía es "volumen sobre perfección": cada bug real que
  veas en la beta → un caso nuevo aquí.
