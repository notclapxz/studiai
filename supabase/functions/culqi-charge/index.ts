import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CULQI_SECRET_KEY = Deno.env.get("CULQI_SECRET_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PLAN_CONFIG = {
  mensual: { amount: 2900, days: 30, description: "StudiAI Pro - Plan Mensual" },
  trimestral: { amount: 7500, days: 90, description: "StudiAI Pro - Plan Trimestral" },
} as const;

type Plan = keyof typeof PLAN_CONFIG;

interface ChargeRequestBody {
  token_id: string;
  plan: Plan;
  email: string;
}

interface CulqiChargeResponse {
  id?: string;
  object?: string;
  outcome?: { type?: string };
  user_message?: string;
  merchant_message?: string;
}

interface UserRecord {
  plan: string | null;
  plan_expires_at: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    // 1. Verify Supabase JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "unauthorized" }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ error: "unauthorized" }, 401);

    // 2. Parse body
    const { token_id, plan, email } = await req.json() as ChargeRequestBody;

    if (!token_id || !plan || !PLAN_CONFIG[plan]) {
      return json({ error: "invalid_params" }, 400);
    }

    const config = PLAN_CONFIG[plan];

    // 3. Idempotency: check if user already has active pro plan
    const { data: existing } = await supabase
      .schema("studiai")
      .from("users")
      .select("plan, plan_expires_at")
      .eq("id", user.id)
      .single<UserRecord>();

    if (existing?.plan === "pro" && existing?.plan_expires_at) {
      const expiresAt = new Date(existing.plan_expires_at);
      if (expiresAt > new Date()) {
        return json({
          ok: true,
          plan: "pro",
          expires_at: existing.plan_expires_at,
          already_active: true,
        });
      }
    }

    // 4. Charge via Culqi API
    const culqiRes = await fetch("https://api.culqi.com/v2/charges", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CULQI_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_id: token_id,
        currency_code: "PEN",
        amount: config.amount,
        email: email,
        description: config.description,
        metadata: { user_id: user.id, plan },
      }),
    });

    const charge = await culqiRes.json() as CulqiChargeResponse;

    if (!culqiRes.ok || charge.object !== "charge") {
      const msg = charge.user_message ?? charge.merchant_message ?? "Pago rechazado";
      return json({ ok: false, error: msg }, 402);
    }

    // 5. Update user plan in DB
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + config.days);

    const { error: updateError } = await supabase
      .schema("studiai")
      .from("users")
      .update({
        plan: "pro",
        plan_expires_at: expiresAt.toISOString(),
        culqi_customer_id: charge.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateError) {
      console.error("[culqi-charge] DB update error:", updateError);
      return json({ ok: false, error: "db_error" }, 500);
    }

    return json({ ok: true, plan: "pro", expires_at: expiresAt.toISOString() });

  } catch (err) {
    console.error("[culqi-charge] Unexpected error:", err);
    return json({ ok: false, error: "server_error" }, 500);
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
