"""
TGStat Direct LLM Proxy.

Простой OpenAI-совместимый прокси перед пулом ключей от разных провайдеров
(Groq, Cerebras, OpenRouter, SambaNova, NVIDIA). Клиенты бьют сюда своим
access-token'ом, сервер выбирает свободный слот и проксирует запрос в реальный
LLM API. Ключи хранятся только в env vars сервера.

Endpoints
---------
POST /v1/chat/completions   — OpenAI-совместимый
GET  /health                — {"status","slots","providers","banned"}
GET  /                      — то же что /health, для Render health-check

Env vars (задаются на Render → Environment)
-------------------------------------------
LLM_PROVIDERS  JSON, список: [{"name","base_url","keys","models","headers"?}]
ACCESS_TOKENS  запятая-список client-token'ов, которые допущены слать запросы.
               Если пусто — auth отключён (для локальной отладки).
FALLBACK_MODEL название модели по умолчанию, если клиент прислал незнакомое.
PORT           стандартный Render var, слушаем на нём.
"""

import itertools
import json
import os
import threading
import time

import requests
from flask import Flask, jsonify, request


# --- Загрузка конфига ---------------------------------------------------

def _load_providers():
    raw = (os.environ.get("LLM_PROVIDERS") or "").strip()
    if not raw:
        return []
    # Render UI при вставке длинного JSON может добавить переносы строк
    # (\n, \r) прямо внутрь ключа (визуально ключ разбивается на строки).
    # JSON.loads строгий и падает; при этом заменять на пробел нельзя —
    # это сломает ключ ('csk-abc def' → 401 auth). Полностью удаляем C0
    # control chars: \n между JSON-элементами исчезнет без последствий,
    # \n внутри разорванной строки восстановит её.
    import re
    raw = re.sub(r"[\x00-\x08\x0a-\x1f]+", "", raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"[fatal] LLM_PROVIDERS не парсится как JSON: {e}")
    if not isinstance(data, list):
        raise SystemExit("[fatal] LLM_PROVIDERS должен быть JSON-массивом")
    return data


def _load_tokens():
    raw = (os.environ.get("ACCESS_TOKENS") or "").strip()
    return {t.strip() for t in raw.split(",") if t.strip()}


PROVIDERS = _load_providers()
ACCESS_TOKENS = _load_tokens()


# --- Слоты (provider, key, model) ---------------------------------------

def _build_slots(providers):
    slots = []
    for pi, p in enumerate(providers):
        base_url = (p.get("base_url") or "").rstrip("/")
        name = p.get("name") or f"prov{pi+1}"
        keys = [k for k in (p.get("keys") or []) if k]
        models = [m for m in (p.get("models") or []) if m]
        headers = p.get("headers") or {}
        if not base_url or not keys or not models:
            continue
        for ki, k in enumerate(keys):
            for mi, m in enumerate(models):
                slots.append({
                    "provider": name, "base_url": base_url,
                    "key": k, "model": m,
                    "pi": pi, "ki": ki, "mi": mi,
                    "headers": headers,
                })
    return slots


SLOTS = _build_slots(PROVIDERS)

if not SLOTS:
    print("[warn] нет валидных слотов — сервер ответит 503 на любой запрос")


_idx_cycle = itertools.cycle(range(len(SLOTS))) if SLOTS else None
_banned = {}
_lock = threading.Lock()


def try_acquire():
    if not SLOTS:
        return None
    with _lock:
        now = time.time()
        for k, ts in list(_banned.items()):
            if ts <= now:
                del _banned[k]
        for _ in range(len(SLOTS)):
            i = next(_idx_cycle)
            if i not in _banned:
                return i, SLOTS[i]
        return None


def ban(idx, seconds):
    with _lock:
        _banned[idx] = time.time() + seconds


def label(slot):
    return f"{slot['provider']}/key{slot['ki']+1}/{slot['model']}"


# --- Flask ---------------------------------------------------------------

app = Flask(__name__)


def _auth_ok(req):
    if not ACCESS_TOKENS:
        return True  # auth отключён явно
    a = req.headers.get("Authorization", "")
    if not a.startswith("Bearer "):
        return False
    return a[7:].strip() in ACCESS_TOKENS


@app.route("/", methods=["GET"])
@app.route("/health", methods=["GET"])
def health():
    with _lock:
        banned_count = len(_banned)
    provs = {}
    for s in SLOTS:
        provs.setdefault(s["provider"], 0)
        provs[s["provider"]] += 1
    return jsonify({
        "status": "ok",
        "slots_total": len(SLOTS),
        "slots_banned": banned_count,
        "providers": provs,
        "auth_required": bool(ACCESS_TOKENS),
    })


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    if not _auth_ok(request):
        return jsonify({"error": {"message": "unauthorized",
                                  "type": "auth"}}), 401
    if not SLOTS:
        return jsonify({"error": {"message": "no slots configured",
                                  "type": "config"}}), 503

    body = request.get_json(force=True, silent=True) or {}
    # Клиент может присылать любую model — на прокси мы её игнорируем и
    # подставляем модель слота. Это OpenAI-совместимо: ответ всё равно
    # в формате {"choices":[...], ...}.

    max_tries = min(len(SLOTS) * 2, 40)
    last_err = None
    last_status = 502
    for _ in range(max_tries):
        got = try_acquire()
        if got is None:
            # Все слоты в бане. Быстро выходим — клиент повторит.
            last_err = "все слоты в бане, повтори через 30-60с"
            last_status = 503
            break
        idx, slot = got

        req_body = dict(body)
        req_body["model"] = slot["model"]

        headers = {
            "Authorization": f"Bearer {slot['key']}",
            "Content-Type": "application/json",
        }
        for k, v in (slot.get("headers") or {}).items():
            headers[k] = v

        url = slot["base_url"] + "/chat/completions"
        try:
            r = requests.post(url, headers=headers, json=req_body,
                              timeout=90)
        except requests.RequestException as e:
            last_err = f"network on {label(slot)}: {e}"
            ban(idx, 15)
            continue

        if r.status_code == 200:
            try:
                data = r.json()
            except ValueError:
                last_err = f"bad json from {label(slot)}"
                ban(idx, 30)
                continue
            # Пробрасываем как есть.
            return jsonify(data)

        if r.status_code == 429:
            ra = 60.0
            try:
                ra = float(r.headers.get("retry-after") or 60)
            except (TypeError, ValueError):
                pass
            ban(idx, ra)
            last_err = f"429 {label(slot)}, retry-after={int(ra)}s"
            last_status = 429
            continue
        if r.status_code in (401, 403):
            # ключ мёртв — баним ВСЕ слоты с этим ключом на час
            with _lock:
                for j, s in enumerate(SLOTS):
                    if s["key"] == slot["key"]:
                        _banned[j] = time.time() + 3600
            last_err = f"auth {r.status_code} {label(slot)}"
            last_status = r.status_code
            continue
        if r.status_code == 404:
            # модель не поддерживается — надолго
            with _lock:
                for j, s in enumerate(SLOTS):
                    if s["model"] == slot["model"] and s["provider"] == slot["provider"]:
                        _banned[j] = time.time() + 86400
            last_err = f"404 model {label(slot)}"
            last_status = 404
            continue
        if r.status_code >= 500:
            ban(idx, 20)
            last_err = f"5xx {label(slot)}: {r.status_code}"
            last_status = r.status_code
            continue

        # Прочие 4xx — прокидываем клиенту (это не наша проблема).
        try:
            return jsonify(r.json()), r.status_code
        except ValueError:
            return jsonify({"error": {"message": r.text[:500],
                                      "type": "upstream"}}), r.status_code

    return jsonify({"error": {"message": last_err or "no upstream succeeded",
                              "type": "exhausted"}}), last_status


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, threaded=True)
