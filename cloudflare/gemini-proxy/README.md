# gemini-proxy

Cloudflare Worker que protege la `GEMINI_API_KEY` de StudiAI. La app ya no embebe
la key en el binario: llama a este Worker con el JWT de Supabase del usuario.

## Qué hace

1. **Auth**: valida la firma del JWT de Supabase localmente vía JWKS (ES256), sin
   round-trip por request. Pin de `issuer`, `audience=authenticated`, `alg=ES256`.
2. **Entitlement**: exige licencia activa (`check_license` RPC, cacheado por
   usuario en KV 30-60s). Un JWT válido no basta — cualquier signup daría uno.
3. **Rate limit** por usuario (`sub`) con el binding nativo (~100 req/min).
4. **Proxy**: reenvía a `generativelanguage.googleapis.com` con la key
   server-side; pass-through del stream SSE del chat. Allowlist de modelos y
   acciones + tope de tamaño de body (no es un open proxy).

## Requisitos

- **Plan FREE de Cloudflare Workers — $0.** El límite de 10ms de CPU no afecta:
  esperar en `fetch`/streaming no cuenta como CPU (docs CF), el body grande se
  reenvía sin parsear, y verificar el JWT (ES256/WebCrypto) es sub-ms. Free da
  **100k requests/día**, de sobra para la beta. El rate-limit por usuario queda
  desactivado en Free (el gate de licencia activa es el control contra abuso).
  Pasar a **Workers Paid ($5/mo)** solo si superas 100k req/día — es un toggle, no
  un rediseño (descomenta `ratelimits` en `wrangler.jsonc`).
- Node/Bun + `wrangler` (`bunx wrangler` o `npx wrangler`).

## Deploy

```bash
cd cloudflare/gemini-proxy
bun install                      # o npm install

# 1. Crear el KV namespace y pegar el id en wrangler.jsonc → kv_namespaces[0].id
bunx wrangler kv namespace create ENTITLEMENT

# 2. Secrets (NO van en wrangler.jsonc)
bunx wrangler secret put GEMINI_API_KEY      # la key que hoy está en el .env del build
bunx wrangler secret put SUPABASE_ANON_KEY   # anon key del proyecto Supabase

# 3. Verificar que SUPABASE_URL en wrangler.jsonc → vars apunta a tu proyecto
#    (https://szysukwkumphvltaiwpn.supabase.co)

# 4. Deploy
bunx wrangler deploy
```

Tras el deploy, `wrangler` imprime la URL pública (p.ej.
`https://gemini-proxy.<tu-subdominio>.workers.dev`). Esa URL va en:

- `src-tauri/src/lib.rs` → `const PROXY_BASE`.
- `src-tauri/tauri.conf.json` → CSP `connect-src` (y se quita
  `generativelanguage.googleapis.com`, que ya no se llama directo).

Opcional: mapear un dominio propio (`api.studiai.clapxz.com`) en el dashboard de
Cloudflare para no depender de `*.workers.dev`.

## Verificar

```bash
# Sin token → 401
curl -i -X POST https://<worker>/v1beta/models/gemini-2.5-flash:generateContent

# Modelo no permitido → 403
curl -i -X POST https://<worker>/v1beta/models/gpt-4:generateContent \
  -H "Authorization: Bearer <jwt>"
```

## Dev local

```bash
bunx wrangler dev          # corre en http://localhost:8787
```
Para que `tauri dev` apunte aquí, exporta `STUDIAI_PROXY_BASE=http://localhost:8787`
(la app usa esa env var en debug; en release usa el `PROXY_BASE` compilado).

## Notas de seguridad

- `check_license` es `SECURITY DEFINER`; se llama con el JWT del propio usuario
  (no service-role) → no hay credenciales de alto privilegio en el edge.
- Entitlement hace **fail-open** ante caída del RPC (no romper a usuarios
  legítimos); el rate-limit + JWT válido acotan el daño en ese caso.
- Pendiente (v2): métricas de uso por `sub` para forensics de abuso.
