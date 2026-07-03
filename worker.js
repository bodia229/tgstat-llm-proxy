// TGStat LLM Proxy — Cloudflare Workers edition.
//
// Env vars (Settings → Variables and Secrets в Cloudflare Dashboard):
//   LLM_PROVIDERS  — JSON-массив провайдеров (тот же формат что у Python-версии)
//   ACCESS_TOKENS  — csv токенов, допущенных клиентов
//
// Endpoints:
//   POST /v1/chat/completions   — OpenAI-совместимый
//   GET  /health                — статус + слоты
//   GET  /                      — то же что /health
//
// Особенность Workers: инстанс изолирован, ban-state не шарится между
// запросами. Делаем перебор слотов на каждый запрос со случайного места
// (round-robin с random-start): при 429/401/5xx пробуем следующий слот
// до первого 200.

function parseProviders(raw) {
  if (!raw) return [];
  // Чистим C0 control chars (могут прилететь при копипасте JSON).
  const cleaned = raw.replace(/[\x00-\x08\x0a-\x1f]+/g, "");
  const arr = JSON.parse(cleaned);
  if (!Array.isArray(arr)) throw new Error("LLM_PROVIDERS must be array");
  return arr;
}

function buildSlots(providers) {
  const slots = [];
  for (const p of providers) {
    const baseUrl = (p.base_url || "").replace(/\/+$/, "");
    const name = p.name || "provider";
    const keys = (p.keys || []).filter(Boolean);
    const models = (p.models || []).filter(Boolean);
    const headers = p.headers || {};
    if (!baseUrl || !keys.length || !models.length) continue;
    for (let ki = 0; ki < keys.length; ki++) {
      for (let mi = 0; mi < models.length; mi++) {
        slots.push({
          provider: name, baseUrl, key: keys[ki], model: models[mi],
          ki, mi, headers,
        });
      }
    }
  }
  return slots;
}

function pickStartIdx(len) {
  return Math.floor(Math.random() * len);
}

function isAuthOK(request, tokens) {
  if (!tokens.size) return true;
  const h = request.headers.get("authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return false;
  return tokens.has(h.slice(7).trim());
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleHealth(env, slots) {
  const provs = {};
  for (const s of slots) provs[s.provider] = (provs[s.provider] || 0) + 1;
  return json(200, {
    status: "ok",
    slots_total: slots.length,
    slots_banned: 0,
    providers: provs,
    auth_required: !!(env.ACCESS_TOKENS && env.ACCESS_TOKENS.trim()),
    runtime: "cloudflare-workers",
  });
}

async function handleChat(request, slots) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: { message: "invalid JSON body" } });
  }

  const n = slots.length;
  if (!n) return json(503, { error: { message: "no slots" } });

  const start = pickStartIdx(n);
  let lastErr = "no upstream";
  let lastStatus = 502;

  for (let step = 0; step < n; step++) {
    const idx = (start + step) % n;
    const s = slots[idx];

    const reqBody = { ...body, model: s.model };
    const headers = {
      "authorization": `Bearer ${s.key}`,
      "content-type": "application/json",
      ...(s.headers || {}),
    };

    let upstream;
    try {
      upstream = await fetch(`${s.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(reqBody),
      });
    } catch (e) {
      lastErr = `network on ${s.provider}/key${s.ki + 1}: ${e.message || e}`;
      continue;
    }

    if (upstream.status === 200) {
      const buf = await upstream.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if ([429, 401, 403, 404, 500, 502, 503, 504].includes(upstream.status)) {
      lastStatus = upstream.status;
      const text = await upstream.text();
      lastErr = `${upstream.status} ${s.provider}/key${s.ki + 1}/${s.model}: ${text.slice(0, 200)}`;
      continue;
    }

    const txt = await upstream.text();
    return new Response(txt, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return json(lastStatus, { error: { message: lastErr, type: "exhausted" } });
}

export default {
  async fetch(request, env, ctx) {
    let providers, slots, tokens;
    try {
      providers = parseProviders(env.LLM_PROVIDERS || "");
      slots = buildSlots(providers);
      tokens = new Set(
        (env.ACCESS_TOKENS || "")
          .split(",").map(t => t.trim()).filter(Boolean),
      );
    } catch (e) {
      return json(500, {
        error: { message: `config parse: ${e.message || e}` },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return handleHealth(env, slots);
    }

    if (request.method === "POST" && path === "/v1/chat/completions") {
      if (!isAuthOK(request, tokens)) {
        return json(401, { error: { message: "unauthorized" } });
      }
      return handleChat(request, slots);
    }

    return json(404, { error: { message: "not found" } });
  },
};
