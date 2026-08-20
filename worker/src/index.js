import { neon } from "@neondatabase/serverless";

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: {
    "content-type": "application/json",
    ...(init.headers || {})
  }
});

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  if (!origin || (allowed.length && !allowed.includes(origin))) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin"
  };
}

async function ensureStore(env) {
  const sql = neon(env.DATABASE_URL);
  await sql`
    create table if not exists lims_store (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `;
  return sql;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") {
        const sql = await ensureStore(env);
        await sql`select 1`;
        return json({
          ok: true,
          service: "Plasma Lab LIMS Worker API",
          database: "Neon PostgreSQL",
          frontend: env.FRONTEND_PUBLIC_URL || ""
        }, { headers: cors });
      }

      return json({
        error: "Worker API scaffold is running. Full LIMS endpoints still need migration from server.js."
      }, { status: 501, headers: cors });
    } catch (error) {
      return json({ error: error.message || "Worker error" }, { status: 500, headers: cors });
    }
  }
};
