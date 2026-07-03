# TGStat LLM Proxy

Прокси-сервер перед пулом API-ключей от Groq / Cerebras / OpenRouter /
SambaNova / NVIDIA. Все клиенты бьются в него одним токеном, сервер сам
роутит запросы, ротирует ключи и держит бан-листы.

## Зачем

Без прокси у каждого пользователя приложения — свой локальный `SlotPool`
с зашитыми ключами в `ai_filter_config.json`. Проблемы:

- Ключи утекают вместе с инсталлятором.
- Каждый пользователь пожирает свою квоту в изоляции.
- Добавить/ротировать ключ = пересобрать exe и раздать заново.

Прокси решает всё разом:

- Ключи только на сервере (в env vars Render).
- Один общий пул на всех пользователей → нагрузка балансируется.
- Ключ добавил — все клиенты сразу пользуются, без переустановки.
- Клиент шлёт только `access_token`, ничего секретного локально не хранится.

## Быстрый деплой на Render (Free)

1. **Форкни репозиторий с этой папкой на GitHub** (публичный или приватный
   — Render умеет и то и другое).
2. Заходи на [render.com](https://render.com) → New → Blueprint.
3. Укажи свой репо. Render подхватит `render.yaml`.
4. В **Environment** вставь два секрета:

   **`LLM_PROVIDERS`** — JSON со списком провайдеров. Формат такой же,
   как в `ai_filter_config.json`:

   ```json
   [
     {
       "name": "cerebras",
       "base_url": "https://api.cerebras.ai/v1",
       "keys": ["csk-...", "csk-...", "csk-..."],
       "models": ["llama-3.3-70b", "llama-3.1-8b"]
     },
     {
       "name": "groq",
       "base_url": "https://api.groq.com/openai/v1",
       "keys": ["gsk_...", "gsk_..."],
       "models": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
     },
     {
       "name": "openrouter",
       "base_url": "https://openrouter.ai/api/v1",
       "keys": ["sk-or-v1-..."],
       "models": ["meta-llama/llama-3.3-70b-instruct:free"],
       "headers": {
         "HTTP-Referer": "https://tgstat-direct.local",
         "X-Title": "TGStat Direct"
       }
     }
   ]
   ```

   > В UI Render вставляй одной строкой без переносов (можно через
   > `jq -c . < providers.json` предварительно сжать).

   **`ACCESS_TOKENS`** — csv-список токенов, которые ты выдаёшь клиентам:

   ```
   friend-alice-a7f2c9,friend-bob-b8e3d0,friend-carol-c9d1e4
   ```

   Каждому другу — свой токен, чтобы можно было отозвать один без
   переиздачи остальных.

5. Deploy. Через 3–5 минут получишь URL типа
   `https://tgstat-llm-proxy-xxx.onrender.com`.

## Тест

```bash
# health-check (не требует токена)
curl https://tgstat-llm-proxy-xxx.onrender.com/health

# chat
curl -X POST https://tgstat-llm-proxy-xxx.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer friend-alice-a7f2c9" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
```

## Настройка клиента

1. Открой в приложении **🔑 API ключи** → вкладку **🌐 Прокси-сервер**.
2. В поле `base_url` — впиши URL с Render.
3. В поле ключей — вставь свой `access_token`.
4. Всё, теперь клиент не ходит напрямую в Groq/Cerebras/OpenRouter,
   а всё через сервер. Другие вкладки можно очистить.

Или руками в `ai_filter_config.json`:

```json
{
  "providers": [
    {
      "name": "proxy",
      "base_url": "https://tgstat-llm-proxy-xxx.onrender.com/v1",
      "keys": ["friend-alice-a7f2c9"],
      "models": ["auto"]
    }
  ]
}
```

## Ограничения Free плана Render

- Сервис засыпает через **15 минут неактивности**. Первый запрос после
  сна — 30–60 сек (пока контейнер поднимается).
  - Мitigation: cron-job pings (UptimeRobot, cron-job.org) каждые 10 мин.
- 512 МБ RAM, 0.1 CPU. Прокси — I/O bound, хватает с запасом.
- 750 часов/месяц бесплатных → одна инстанция крутится 24/7 в пределах.

## Логи

`Render Dashboard → Logs`. Каждый запрос — одна строка типа
`POST /v1/chat/completions 200 1250ms`.

Если видишь много 429/503 в логах — проверь env `LLM_PROVIDERS`, скорее
всего суточная квота ключей закончилась.

## Ротация ключей

Просто отредактируй `LLM_PROVIDERS` в Environment на Render → Save.
Сервис пересоздастся, старый пул выгружается, новый строится.
Клиентам менять ничего не нужно.

## Безопасность

- Не публикуй `ACCESS_TOKENS` и `LLM_PROVIDERS` в git.
- Используй **приватный** репозиторий для Render Blueprint (если можешь).
- Отзывай токен друга — просто убрать его из `ACCESS_TOKENS` csv.
- Логи Render могут храниться до 7 дней — не логируй тела запросов
  (сейчас не логируем).
