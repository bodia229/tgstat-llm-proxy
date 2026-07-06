// TGStat LLM Proxy — Cloudflare Workers edition.
//
// Env vars (Settings → Variables and Secrets):
//   LLM_PROVIDERS  — JSON-массив провайдеров
//   ACCESS_TOKENS  — csv токенов, допущенных клиентов
//   ADMIN_TOKEN    — секрет для /admin/* эндпоинтов
//
// KV binding "STATS" — учёт использования по каждому access_token'у.
//
// Endpoints:
//   POST /v1/chat/completions   — OpenAI-совместимый (auth: Bearer <access_token>)
//   GET  /health                — публичный, слоты и статус
//   GET  /                      — то же что /health
//   GET  /admin/stats           — кто пользуется прокси (auth: Bearer <ADMIN_TOKEN>)
//   GET  /admin/config          — текущие провайдеры + токены (masked)

function parseProviders(raw) {
  if (!raw) return [];
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

function extractBearer(request) {
  const h = request.headers.get("authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim();
}

function isAuthOK(token, tokens) {
  if (!tokens.size) return true;
  return token && tokens.has(token);
}

function isAdmin(token, adminToken) {
  return adminToken && token === adminToken;
}

function mask(s, prefix = 6, suffix = 4) {
  if (!s) return "";
  if (s.length <= prefix + suffix + 3) return s;
  return `${s.slice(0, prefix)}…${s.slice(-suffix)}`;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function bumpStats(env, ctx, token) {
  if (!env.STATS || !token) return;
  const key = `t:${token}`;
  ctx.waitUntil((async () => {
    try {
      const prev = await env.STATS.get(key, { type: "json" });
      const now = Date.now();
      const cur = prev || { count: 0, first_seen: now, last_seen: 0 };
      cur.count = (cur.count | 0) + 1;
      cur.last_seen = now;
      await env.STATS.put(key, JSON.stringify(cur));
    } catch (e) { /* KV лимит — игнор */ }
  })());
}

async function listStats(env) {
  if (!env.STATS) return [];
  const list = await env.STATS.list({ prefix: "t:", limit: 1000 });
  const rows = await Promise.all(list.keys.map(async k => {
    const v = await env.STATS.get(k.name, { type: "json" });
    return {
      token: k.name.slice(2),
      token_masked: mask(k.name.slice(2), 8, 4),
      count: v?.count || 0,
      first_seen: v?.first_seen || 0,
      last_seen: v?.last_seen || 0,
    };
  }));
  rows.sort((a, b) => b.last_seen - a.last_seen);
  return rows;
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

async function handleAdminConfig(env, providers, tokens) {
  const provsView = providers.map(p => ({
    name: p.name,
    base_url: p.base_url,
    models: p.models || [],
    keys: (p.keys || []).map(k => mask(k, 8, 4)),
    keys_count: (p.keys || []).length,
    headers_keys: Object.keys(p.headers || {}),
  }));
  const accessView = [...tokens].map(t => mask(t, 10, 4));
  return json(200, {
    providers: provsView,
    access_tokens: accessView,
    access_tokens_count: tokens.size,
  });
}

async function handleAdminStats(env) {
  const rows = await listStats(env);
  return json(200, {
    total_users: rows.length,
    users: rows,
    generated_at: Date.now(),
  });
}

async function handleChat(request, env, ctx, slots, token) {
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

    // Специальный upstream: Cloudflare Workers AI через AI binding
    // (не HTTP, а прямой env.AI.run) — 10K Neurons/день бесплатно, без токена.
    // Провайдер помечается name="cloudflare-ai" в LLM_PROVIDERS, keys=["binding"].
    if (s.provider === "cloudflare-ai" && env.AI) {
      try {
        const aiResp = await env.AI.run(s.model, {
          messages: reqBody.messages,
          temperature: reqBody.temperature ?? 0,
          max_tokens: reqBody.max_tokens ?? 512,
          response_format: reqBody.response_format,
        });
        // aiResp: { response: "text" } или совместимый OpenAI формат
        const content = aiResp.response ?? aiResp.choices?.[0]?.message?.content ?? "";
        await bumpStats(env, ctx, token);
        return json(200, {
          id: `cfai-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: s.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          }],
          usage: aiResp.usage ?? {},
        });
      } catch (e) {
        lastErr = `cloudflare-ai ${s.model}: ${e.message || e}`;
        lastStatus = 503;
        continue;
      }
    }

    const headers = {
      "authorization": `Bearer ${s.key}`,
      "content-type": "application/json",
      ...(s.headers || {}),
    };
    let upstream;
    try {
      upstream = await fetch(`${s.baseUrl}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(reqBody),
      });
    } catch (e) {
      lastErr = `network on ${s.provider}/key${s.ki + 1}: ${e.message || e}`;
      continue;
    }
    if (upstream.status === 200) {
      await bumpStats(env, ctx, token);
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

// ---- getChat: авторитетная проверка чата пулом bot-токенов (env.BOT_TOKENS) ----
function classifyChat(result) {
  const t = result.type;
  if (t === "channel") return { bucket: "REJECT", reason: "channel" };
  if (t === "bot" || t === "private") return { bucket: "REJECT", reason: "type=" + t };
  // Форум-чат с топиками — нельзя писать в общий поток (только в топики) → режем
  if (result.is_forum) return { bucket: "REJECT", reason: "forum" };
  const perms = result.permissions || {};
  if (perms.can_send_messages === false) return { bucket: "REJECT", reason: "no_send_perm" };
  // Чат по заявке (нужно одобрение админа) → режем
  if (result.join_by_request) return { bucket: "REJECT", reason: "join_by_request" };
  const paid = result.paid_message_star_count || 0;
  if (paid >= 1) return { bucket: "REJECT", reason: "paid_stars=" + paid };
  const slow = result.slow_mode_delay || 0;
  if (slow >= 3600) return { bucket: "REJECT", reason: "slow_mode=" + slow };
  return { bucket: "KEEP", reason: "type=" + t + " slow=" + slow };
}

async function getChatOne(username, pool, idx) {
  // до 2 попыток разными токенами: при 429 не бросаем чат, а пробуем другой бот
  for (let att = 0; att < 2; att++) {
    const tok = pool[(idx + att) % pool.length];
    let r;
    try {
      r = await fetch("https://api.telegram.org/bot" + tok +
        "/getChat?chat_id=@" + encodeURIComponent(username));
    } catch (e) { if (att) return { bucket: "GREY", reason: "net" }; continue; }
    let d;
    try { d = await r.json(); } catch (e) { if (att) return { bucket: "GREY", reason: "parse" }; continue; }
    if (!d.ok) {
      const err = (d.description || "").toLowerCase();
      if (err.includes("chat not found")) return { bucket: "REJECT", reason: "not_found" };
      if (r.status === 429 || err.includes("too many")) continue; // retry другим токеном
      return { bucket: "GREY", reason: "err" };
    }
    return finishGetChat(d.result);
  }
  return { bucket: "GREY", reason: "ratelimit" };
}

function finishGetChat(result) {
  const d = { result };
  const cls = classifyChat(d.result);
  // Для НЕ-отсеянных отдаём авторитетные поля, которые LLM из сэмплов не узнает.
  if (cls.bucket !== "REJECT") {
    const R = d.result, p = R.permissions || {};
    cls.info = {
      slow: R.slow_mode_delay || 0,
      media: p.can_send_media_messages !== false,
      history: R.has_visible_history !== false,
      join_to_send: !!R.join_to_send_messages,
      desc: (R.description || "").slice(0, 300),
      title: R.title || "",
    };
  }
  return cls;
}

// Пул bot-токенов = seed из split-секретов (BOT_TOKENS..12) + пополнения друзей в KV.
function secretsPool(env) {
  const parts = [env.BOT_TOKENS];
  for (let i = 2; i <= 12; i++) parts.push(env["BOT_TOKENS" + i]);
  return parts.filter(Boolean).join(",");
}
async function loadPool(env) {
  let kv = "";
  const store = env.POOL || env.STATS;
  if (store) { try { kv = (await store.get("bot_tokens")) || ""; } catch (e) {} }
  const set = new Set();
  for (const t of (kv + "," + secretsPool(env)).split(/[,\s]+/)) {
    const x = t.trim();
    if (x) set.add(x);
  }
  return [...set];
}

const TOK_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;

// Друзья шлют СВОИ созданные bot-токены в общий пул (пополнение в KV).
async function handleContribute(request, env) {
  const store = env.POOL || env.STATS;
  if (!store) return json(503, { error: { message: "no store" } });
  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: { message: "bad json" } }); }
  let toks = Array.isArray(body.tokens) ? body.tokens : [];
  toks = toks.map(t => String(t).trim()).filter(t => TOK_RE.test(t)).slice(0, 500);
  if (!toks.length) return json(200, { added: 0, pool: 0 });
  let cur = "";
  try { cur = (await store.get("bot_tokens")) || ""; } catch (e) {}
  const set = new Set(cur.split(/[,\s]+/).map(t => t.trim()).filter(Boolean));
  let added = 0;
  for (const t of toks) if (!set.has(t)) { set.add(t); added++; }
  if (added) {
    try { await store.put("bot_tokens", [...set].join(",")); }
    catch (e) { return json(503, { error: { message: "kv write: " + (e.message || e) } }); }
  }
  return json(200, { added, pool: set.size });
}

async function handleGetChat(request, env) {
  const all = await loadPool(env);
  if (!all.length) return json(503, { error: { message: "no bot tokens" } });
  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: { message: "bad json" } }); }
  let usernames = Array.isArray(body.usernames) ? body.usernames : [];
  // до 25 юзернеймов × 2 попытки = ≤50 субзапросов (лимит free-воркера)
  usernames = usernames.slice(0, 25).map(u => String(u).replace(/^@/, "").toLowerCase());
  // rest/work ротация: активна ~40% пула, окно сдвигается каждые 3 минуты —
  // отработавшие токены отдыхают, остальные работают → флуд-вейт реже.
  let pool = all;
  if (all.length > 50) {
    const WORK = Math.max(30, Math.ceil(all.length * 0.4));
    const shift = Math.floor(Date.now() / (3 * 60 * 1000)) % all.length;
    pool = [];
    for (let i = 0; i < WORK; i++) pool.push(all[(shift + i) % all.length]);
  }
  const start = pickStartIdx(pool.length);
  const results = {};
  await Promise.all(usernames.map((u, k) =>
    getChatOne(u, pool, (start + k * 2) % pool.length).then(v => { results[u] = v; })
  ));
  return json(200, { results, pool: all.length, active: pool.length });
}

export default {
  async fetch(request, env, ctx) {
    let providers, slots, tokens;
    try {
      providers = parseProviders(env.LLM_PROVIDERS || "");
      slots = buildSlots(providers);
      tokens = new Set(
        (env.ACCESS_TOKENS || "").split(",").map(t => t.trim()).filter(Boolean),
      );
    } catch (e) {
      return json(500, { error: { message: `config parse: ${e.message || e}` } });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const bearer = extractBearer(request);
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return handleHealth(env, slots);
    }
    if (path.startsWith("/admin/")) {
      if (!isAdmin(bearer, env.ADMIN_TOKEN)) {
        return json(401, { error: { message: "admin auth required" } });
      }
      if (request.method === "GET" && path === "/admin/stats") return handleAdminStats(env);
      if (request.method === "GET" && path === "/admin/config") return handleAdminConfig(env, providers, tokens);
      return json(404, { error: { message: "unknown admin endpoint" } });
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      if (!isAuthOK(bearer, tokens)) {
        return json(401, { error: { message: "unauthorized" } });
      }
      return handleChat(request, env, ctx, slots, bearer);
    }
    if (request.method === "POST" && path === "/getchat") {
      if (!isAuthOK(bearer, tokens)) {
        return json(401, { error: { message: "unauthorized" } });
      }
      return handleGetChat(request, env);
    }
    if (request.method === "POST" && path === "/contribute") {
      if (!isAuthOK(bearer, tokens)) {
        return json(401, { error: { message: "unauthorized" } });
      }
      return handleContribute(request, env);
    }
    return json(404, { error: { message: "not found" } });
  },
};
