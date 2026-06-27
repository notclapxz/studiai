# Proxy de Gemini (Cloudflare Worker) — arquitectura y runbook

Doc de referencia del proxy que saca la `GEMINI_API_KEY` del binario distribuido.
Estado: **código completo y compilando; FALTA el deploy (acción del usuario).**
Creado el 2026-06-25. Código del Worker en `cloudflare/gemini-proxy/`.

---

## Por qué

Hoy `src-tauri/src/lib.rs` embebía la key con `env!("GEMINI_API_KEY")` (vía
`build.rs` leyendo el `.env` en build). El binario distribuido (`.app`/`.exe`)
contiene la key en texto → `strings binario | grep AIza` la extrae. No es robo de
datos de usuarios (cada uno es local), es **robo de tu cuota de Gemini**: bajo a
escala beta, serio en público.

Solución: las llamadas a Gemini pasan por un Cloudflare Worker que tiene la key
como secret server-side y exige un JWT de Supabase válido + licencia activa.

## Decisión de plataforma y costo

- **Cloudflare Worker en plan FREE ($0).** Verificado contra docs CF 2026: el
  límite de 10ms de CPU NO afecta porque esperar en `fetch`/streaming no cuenta
  como CPU, el body grande se reenvía sin parsear, y verificar el JWT
  (ES256/WebCrypto) es sub-ms. Free da 100k req/día (de sobra para la beta).
- **Pasar a Workers Paid ($5/mo) solo si se supera 100k req/día** — es un toggle
  (descomentar `ratelimits` en `wrangler.jsonc`), NO un rediseño.
- Descartados: **Supabase Edge Function** (válido y free, pero requiere portar a
  Deno; innecesario); **Ubuntu + Cloudflare Tunnel** (cloudflared BUFFEREA los
  SSE → rompería el streaming del chat; bug conocido abierto; además SPOF de
  oficina).

## Diseño (revisado por panel de 3 agentes, verificado con docs 2026)

El Worker (`cloudflare/gemini-proxy/src/index.ts`) hace por request:
1. **Auth**: valida la firma del JWT de Supabase LOCALMENTE vía JWKS (ES256, con
   `jose`). El proyecto usa ES256 asimétrico (confirmado: `jwks.json` no vacío en
   `https://szysukwkumphvltaiwpn.supabase.co/auth/v1/.well-known/jwks.json`). Pin
   de `issuer`, `audience=authenticated`, `alg=ES256` (anti alg-confusion). JWKS
   cacheado en global del isolate (sin round-trip por request).
2. **Entitlement** (el control clave): exige licencia ACTIVA. "JWT válido" no
   basta — cualquier signup de Google da uno. Llama al RPC `check_license` con el
   JWT del propio usuario (es `SECURITY DEFINER` → sin service-role en el edge),
   cacheado en KV 30-60s. Contrato: `check_license(uuid) → json {is_active, plan,
   days_remaining, ...}`; el gate es `is_active === true`.
3. **Rate-limit** por usuario (`sub`) — OPCIONAL, solo si el binding existe
   (requiere Paid). En Free se omite; el entitlement es el control anti-abuso.
4. **Proxy**: reenvía a `generativelanguage.googleapis.com` con la key como
   secret; pass-through del SSE (`new Response(upstream.body)`). Allowlist de
   modelos (`gemini-2.5-flash`, `gemini-2.5-flash-lite`) y acciones
   (`generateContent`, `streamGenerateContent`) + tope de body → no es open proxy.

`isEntitled` hace **fail-open** ante caída del RPC (no romper usuarios legítimos
por un hipo de Supabase; el JWT válido acota el daño).

## Cambios en la app (ya aplicados, compilando)

- `src-tauri/src/lib.rs`:
  - Quitado `const GEMINI_API_KEY = env!(...)`.
  - `DEFAULT_PROXY_BASE` (⚠️ PLACEHOLDER — reemplazar tras deploy) + `proxy_base()`
    (en debug acepta env `STUDIAI_PROXY_BASE`, p.ej. `http://localhost:8787`).
  - `AUTH_TOKEN` global (`LazyLock<Mutex<Option<String>>>`) + `current_auth_token()`
    (clona el token, no sostiene el guard a través de `.await`) + comando
    `set_auth_token`. Global (no Tauri State) porque el OCR background no recibe
    `AppHandle`.
  - Las 4 call sites (chat streaming, OCR, compaction, session summary) → URL del
    proxy + header `Authorization: Bearer {token}`.
- `src-tauri/build.rs`: ya no lee `GEMINI_API_KEY`.
- `src/App.tsx`: `onAuthStateChange` + `verificarSesionInicial` → `invoke
  set_auth_token` (empuja el JWT; fresco en cada `TOKEN_REFRESHED`).
- `src/hooks/useChat.ts`: clasificador de error — `not_entitled` → mensaje de
  licencia; `401` → mensaje de sesión (ya no "token de Canvas").
- `src-tauri/tauri.conf.json`: quitado `generativelanguage` de la CSP (las
  llamadas son server-side desde Rust, la CSP del WebView no aplica).
- `.github/workflows/release.yml`: quitado `GEMINI_API_KEY` del `.env` del build.

## RUNBOOK de deploy (próxima sesión) — ORDEN IMPORTANTE

> ⚠️ **NO taggear `v0.14.0` hasta completar y probar estos pasos.** Al quitar la
> key embebida, el chat NO funciona hasta que el Worker esté arriba + la URL real
> esté en `lib.rs`. Un release antes = chat roto para todos.

1. **Instalar y validar el Worker** (esto valida el TS, que no se compiló local):
   ```bash
   cd cloudflare/gemini-proxy
   bun install
   bunx wrangler types        # genera tipos de Env
   bunx tsc --noEmit          # confirma que compila (jose + workers-types)
   ```
2. **Crear el KV namespace** y pegar el `id` en `wrangler.jsonc` →
   `kv_namespaces[0].id`:
   ```bash
   bunx wrangler kv namespace create ENTITLEMENT
   ```
3. **Secrets**:
   ```bash
   bunx wrangler secret put GEMINI_API_KEY      # la key actual del .env
   bunx wrangler secret put SUPABASE_ANON_KEY   # anon key del proyecto
   ```
4. **Verificar** `SUPABASE_URL` en `wrangler.jsonc → vars`
   (`https://szysukwkumphvltaiwpn.supabase.co`).
5. **Deploy** (plan Free, sin tarjeta):
   ```bash
   bunx wrangler deploy
   ```
   Copiar la URL que imprime (p.ej. `https://gemini-proxy.<sub>.workers.dev`).
6. **Reemplazar** `DEFAULT_PROXY_BASE` en `src-tauri/src/lib.rs` con esa URL.
7. **Smoke test en dev**:
   ```bash
   cd studyai && bun run tauri dev
   ```
   - Login → mandar un mensaje → confirmar que el chat responde (vía proxy).
   - Probar también la **memoria** (pendiente desde antes): que el modelo llame
     `remember`, que aparezca el bloque inyectado, y la sección Settings → Memoria.
   - Verificar OCR (subir/indexar un PDF escaneado) y un resumen de sesión.
8. **Recién entonces**: commit + actualizar `CHANGELOG.md` si hace falta + `git
   tag v0.14.0 && git push --tags` (dispara el release con la key ya fuera del
   binario).

## Troubleshooting esperado

- **`wrangler` se queja del binding `ratelimits`**: en Free puede no estar
  disponible. Está comentado en `wrangler.jsonc` y el código lo usa solo si
  existe (`if (env.RL)`), así que el deploy Free debería funcionar sin él.
- **401 al chatear**: el JWT no llegó a Rust (revisar que `set_auth_token` se
  invoca en `onAuthStateChange`) o expiró. El front lo re-empuja en
  `TOKEN_REFRESHED`.
- **403 `not_entitled`**: licencia inactiva (trial/pro vencido) — es el
  comportamiento esperado; el usuario debería ver el mensaje de renovar plan.
- **El chat no responde y `DEFAULT_PROXY_BASE` sigue en `REEMPLAZAR`**: falta el
  paso 6.

## Pendiente futuro (no bloquea la beta)
- Rate-limit por usuario (al pasar a Paid).
- Métricas de uso por `sub` (forensics de abuso).
- Manejo de 401 con refresh+retry automático (hoy el front re-empuja el token en
  cada refresh, lo que hace los 401 raros; un retry explícito sería más robusto).
