// gemini-proxy — Cloudflare Worker que protege la GEMINI_API_KEY.
//
// La app StudiAI ya NO embebe la key en el binario: llama a este Worker con el
// JWT de Supabase del usuario. El Worker:
//   1. Valida la FIRMA del JWT localmente vía JWKS (ES256) — sin round-trip por
//      request, sin acoplar el chat al uptime del Auth de Supabase.
//   2. Exige licencia ACTIVA (check_license RPC, cacheada por usuario en KV) —
//      un JWT válido no basta: cualquier signup de Google daría uno.
//   3. Rate-limita por usuario (binding nativo) para acotar abuso de cuota.
//   4. Reenvía el body TAL CUAL a Gemini con la key server-side, haciendo
//      pass-through del stream SSE del chat sin bufferizar.
//
// Diseño y revisión: ver cloudflare/gemini-proxy/README.md.

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface Env {
  GEMINI_API_KEY: string; // secret
  SUPABASE_ANON_KEY: string; // secret (apikey para el RPC; es público pero lo tratamos como secret)
  SUPABASE_URL: string; // var, p.ej. https://<ref>.supabase.co
  ENTITLEMENT: KVNamespace; // cache licencia por usuario
  RL?: RateLimit; // binding de rate limiting (opcional; requiere Workers Paid)
}

const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
const ALLOWED_ACTIONS = new Set(["generateContent", "streamGenerateContent"]);
const MAX_BODY_BYTES = 8 * 1024 * 1024; // imágenes inline (≤4MB) + contexto; techo de seguridad
const GEMINI_HOST = "https://generativelanguage.googleapis.com";

// JWKS cacheado a nivel de módulo (vida del isolate): createRemoteJWKSet maneja
// el fetch, el cache y la rotación por `kid`. No usa KV.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(env: Env) {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    // Ruta: /v1beta/models/{model}:{action} — allowlist estricta (no open proxy).
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/v1beta\/models\/([^:]+):([A-Za-z]+)$/);
    if (!match) return json(404, { error: "not_found" });
    const [, model, action] = match;
    if (!ALLOWED_MODELS.has(model) || !ALLOWED_ACTIONS.has(action)) {
      return json(403, { error: "model_or_action_not_allowed" });
    }

    // ── Auth: validar la firma del JWT localmente (ES256 vía JWKS) ──
    const authz = req.headers.get("Authorization") ?? "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
    if (!token) return json(401, { error: "missing_token" });

    let sub: string;
    try {
      const { payload } = await jwtVerify(token, getJwks(env), {
        issuer: `${env.SUPABASE_URL}/auth/v1`,
        audience: "authenticated",
        algorithms: ["ES256"], // pin: nunca aceptar el alg del token (alg-confusion)
      });
      if (!payload.sub) return json(401, { error: "no_sub" });
      sub = payload.sub;
    } catch {
      return json(401, { error: "invalid_token" });
    }

    // ── Rate limit por usuario (OPCIONAL) ──
    // Requiere el binding de Rate Limiting (disponible al activar Workers Paid).
    // En Free se omite: el gate de entitlement ya exige una cuenta con licencia
    // ACTIVA, que es el control principal contra el abuso de cuota.
    if (env.RL) {
      const rl = await env.RL.limit({ key: sub });
      if (!rl.success) return json(429, { error: "rate_limited" });
    }

    // ── Entitlement: licencia activa (cache KV por usuario) ──
    if (!(await isEntitled(env, sub, token))) {
      return json(403, { error: "not_entitled" });
    }

    // ── Body cap ──
    const declared = Number(req.headers.get("Content-Length") ?? "0");
    if (declared > MAX_BODY_BYTES) return json(413, { error: "body_too_large" });
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json(413, { error: "body_too_large" });

    // ── Reenvío a Gemini con la key server-side ──
    const target = `${GEMINI_HOST}/v1beta/models/${model}:${action}${url.search}`;
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body,
      });
    } catch {
      return json(502, { error: "upstream_unreachable" });
    }

    // Pass-through del stream (incluye SSE). Forward SOLO Content-Type + body:
    // copiar Content-Encoding/Content-Length de un cuerpo ya des-gzipeado por
    // fetch() corrompería/estancaría el stream.
    const headers = new Headers();
    const ct = upstream.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);
    headers.set("Cache-Control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
} satisfies ExportedHandler<Env>;

/**
 * ¿El usuario tiene licencia activa? Cachea el resultado por usuario en KV
 * (TTL corto). check_license es SECURITY DEFINER → lo llamamos con el JWT del
 * propio usuario (sin service-role en el edge). p_user_id = sub VERIFICADO del
 * token (no input del cliente).
 *
 * fail-open ante error de red del RPC: no romper el chat de usuarios legítimos
 * por un hipo de Supabase; el JWT válido + el rate-limit ya acotan el daño.
 */
async function isEntitled(env: Env, sub: string, token: string): Promise<boolean> {
  const cacheKey = `ent:${sub}`;
  const cached = await env.ENTITLEMENT.get(cacheKey);
  if (cached !== null) return cached === "1";

  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/check_license`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ p_user_id: sub }),
    });
    if (!r.ok) return true; // RPC caído → fail-open (acotado por rate-limit)
    const data = (await r.json()) as { is_active?: boolean };
    const active = data?.is_active === true;
    // Activo: cache 60s. Inactivo: 30s (corta rápido tras renovar/pagar).
    await env.ENTITLEMENT.put(cacheKey, active ? "1" : "0", {
      expirationTtl: active ? 60 : 30,
    });
    return active;
  } catch {
    return true; // error de red → fail-open
  }
}
