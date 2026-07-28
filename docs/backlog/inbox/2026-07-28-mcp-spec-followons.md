---
title: MCP 2026-07-28 — followons (MRTR/elicitation, cacheable list, extensions framework, CIMD, header-routing)
description: Остаток спеки 2026-07-28 после auth-hardening и stateless-миграции. Всё опционально и гейтится либо SDK v2, либо реальным запросом потребителя. Держим списком, чтобы не потерять и не делать «на всякий случай».
type: task
status: inbox
created: 2026-07-28
updated: 2026-07-28
---

# MCP 2026-07-28 — followons

Что осталось от спеки после двух основных тасков
(`oauth-hardening-mcp-spec`, `mcp-stateless-core-migration`). Ничего из этого
**не** делать «на всякий случай» — только под реальный запрос или как дешёвый
довесок к миграции.

## 1. MRTR — «тул спрашивает пользователя посреди вызова»

**Что это (по SEP-2322, сверено через context7):** сервер не держит стрим и не
«звонит» клиенту. Он возвращает **result** с
`resultType: "input_required"`, полем `inputRequests` (например
`elicitation/create` со схемой формы) и **opaque** `requestState`. Клиент
**повторяет исходный вызов**, приложив `inputResponses` + вернув `requestState`
**байт-в-байт** (клиенту ЗАПРЕЩЕНО его парсить/менять). Состояние зависшего тула
уезжает клиенту и возвращается → ретрай может обработать **любой** инстанс.
Сервер вправе инициировать запрос **только пока обрабатывает клиентский**.

**Нам сейчас не нужно** — наши тулы чистый contract-first request/response,
`sampling`/`elicitation` не используем. **Но** это открывает то, чего в
stateless-мире раньше не было: подтверждение перед деструктивной/дорогой
операцией (кейс Supabase из анонса: «подтвердить стоимость до создания
проекта»). Кандидаты у нас: `mountDownload` (пишет на диск по пути из аргументов
модели), любые destructive-аннотированные тулы.

**Гейт:** SDK v2 + реальный запрос. Дизайн-вопрос заранее: как это ложится на
`ToolLifecycle` (сейчас `beforeHandle`/`afterHandle` — синхронный гейт, а MRTR
это «вернуть управление и ждать повтора»).

## 2. Cacheable list results (SEP-2549)

`tools/list`, `prompts/list`, `resources/list`, `resources/read` теперь несут
`ttlMs` и `cacheScope` + детерминированный порядок → клиент кэширует каталог и
держит upstream prompt-cache стабильным между реконнектами.

**Хорошо ложится:** наш tool-каталог **детерминирован из контрактов** — меняется
только при деплое. Значит длинный `ttlMs` — честный. Плюс детерминированный
порядок у нас уже есть (`listToolNames` сортирует; проверить, что `mountMcp`
отдаёт стабильный порядок).

**Гейт:** SDK v2 должен дать API для этих полей. Дёшево — сделать вместе с миграцией.

## 3. Extensions framework + MCP Apps + Tasks

Спека формализовала расширения: `io.modelcontextprotocol/tasks`, **MCP Apps**,
Enterprise Managed Authorization (EMA).

- **MCP Apps — у нас уже есть** (`mountMcpResource`, `inlineMcpAppBundle`,
  `RESOURCE_MIME_TYPE`). Задача: привести к формализованному extension-виду,
  если SDK v2 меняет форму объявления. Проверить наш legacy flat `ui`/`resourceUri`
  ключ (`mcp.ts:284-290`) — он и так помечен как совместимость с внешними хостами.
- **Tasks** (`tasks/get`, `tasks/update`, poll-based; нотификации переехали на
  `subscriptions/listen`) — это **не** наш `mountWait`. Потенциально новая фича
  «долгоиграющая операция как first-class», но строить только под запрос.

## 4. CIMD вместо DCR (deprecation)

Dynamic Client Registration (RFC 7591), которую мы реализуем
(`oauth-provider.ts` `/register`), **формально deprecated** в пользу
**Client ID Metadata Documents (CIMD)**. DCR продолжает работать (≥12 мес), но
новый вектор — CIMD.

**Задача:** изучить CIMD-требования и добавить поддержку в провайдер **рядом** с
DCR (не вместо — окно 12 мес). Не срочно; сначала hardening DCR (см. отдельный таск).

## 5. Header-based routing (SEP-2243)

`Mcp-Method` и `Mcp-Name` в заголовках Streamable-HTTP — чтобы шлюз/WAF/rate-limiter
роутил и метрил, не парся JSON-тело.

**Для нас низкий приоритет:** заголовки проставляет **клиент**, потребляет —
внешний шлюз. На нашей стороне tool identity уже известна хуку
(`endpoint.serviceName`/`.key`, ADR 0022). Возможный дешёвый бонус: если SDK v2
их прокидывает — прокинуть в `ToolCallContext` для логов/метрик.

## 6. Deprecations, за которыми просто следим

`Roots`, `Sampling`, `Logging` — deprecated (работают ≥12 мес, новым не
пользоваться). Мы их и не используем. Legacy HTTP+SSE транспорт — уходит вместе
со stateless-миграцией (см. соседний таск).

## Общий гейт

Всё выше **не начинать**, пока не сделан `mcp-stateless-core-migration`
(он гейтится SDK v2) — кроме пункта 4 (CIMD), который автономен, но не срочен.
