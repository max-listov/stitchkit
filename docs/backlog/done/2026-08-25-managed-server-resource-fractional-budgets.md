---
title: managedServerResource передаёт серверу дробные бюджеты и падает на каждой фазе
description: Адаптер считает gracePeriodMs/forceTimeoutMs из performance.now(), а ShutdownOptionsSchema требует целых миллисекунд — валидация падает в stopAdmission, close и force, shutdown завершается forced.
type: task
status: done
tags: [application, server, shutdown]
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 09:56 +0000
---

# managedServerResource передаёт серверу дробные бюджеты и падает на каждой фазе

## Зачем

`managedServerResource` в 0.60.1 нельзя использовать: он падает на валидации в каждой фазе, где
участвует, и приложение всегда завершает остановку как `forced`, ни разу не остановив сервер
штатно.

Причина в двух строках, которые противоречат друг другу.

`ManagedResourceContext.now()` — это `performance.now()`
(`packages/core/src/application/kernel.ts`, `contextFor`), то есть
**дробное** число миллисекунд. Адаптер строит из него бюджеты вычитанием:

```js
const now = context.now();
const gracePeriodMs = phase === 'force' ? 0 : Math.max(0, (context.deadlineAt ?? now) - now);
const forceTimeoutMs = /* та же арифметика */;
shutdownPromise = getServer().shutdown({ gracePeriodMs, forceTimeoutMs, ... });
```

А `ShutdownOptionsSchema` объявляет их целыми, и `shutdown()` валидирует вход. Дробное значение
отвергается всегда — не в краевом случае, а при каждом вызове.

## Воспроизведение

Двадцать строк, только публичные экспорты, никакого прикладного кода:

```ts
import { defineContract } from 'stitchkit';
import { createApplication, managedServerResource } from 'stitchkit/application';
import { createServer, implement } from 'stitchkit/server';
import { z } from 'zod';

const contract = defineContract({ prefix: 'x' }, {
  ping: { method: 'GET', path: '/', desc: 'ping', output: z.object({ ok: z.boolean() }) },
});
const server = createServer({ services: [implement(contract, { ping: () => ({ ok: true }) })], port: 19099 });

const failures = [];
const app = createApplication({
  id: 'repro',
  resources: [managedServerResource({ id: 'http', server })],
  onResourceFailure: ({ phase, error }) => failures.push({ phase, error: String(error).slice(0, 80) }),
});
await app.start();
const result = await app.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 500 });
console.log(JSON.stringify({ outcome: result.outcome, failures }, null, 1));
```

Вывод на 0.60.1, Bun 1.3.14:

```json
{
 "outcome": "forced",
 "failures": [
  { "phase": "admission", "error": "[{ \"expected\": \"int\", \"format\": \"safeint\", \"code\": \"invalid_type\", \"path\": [\"gracePeriodMs\"] }]" },
  { "phase": "force",     "error": "[{ \"expected\": \"int\", \"format\": \"safeint\", \"code\": \"invalid_type\", \"path\": [\"forceTimeoutMs\"] }]" }
 ]
}
```

## Почему это стоит починить, а не обойти

Гайд по ядру прямо велит не копировать машину остановки сервера, а брать адаптер. Сегодня совет
ведёт в состояние хуже исходного: потребитель, послушавшийся гайда, получает `forced` вместо
штатной остановки, а причину видит только если подключил `onResourceFailure` — иначе она
проглатывается вместе с фазой. То есть отказ тихий, и он делает ровно то, чего адаптер должен был
избежать.

Обойти это у потребителя нечем: и `now()`, и арифметика, и вызов `shutdown()` — внутри адаптера.

## Результат

- `managedServerResource` останавливает сервер штатно; `outcome` — `clean`, если уложились в грейс.
- Бюджеты, переданные серверу, — целые миллисекунды при любом источнике времени.
- Регрессия: приложение с одним `managedServerResource` останавливается без единого
  `onResourceFailure`.

## Заметка про соседнюю границу

Стоит проверить, нет ли той же арифметики где-то ещё: любое место, где дедлайн ядра
(`performance.now()`) превращается в опцию, объявленную целой, ломается одинаково. Если такая
проверка типов возможна на границе, она дешевле, чем ловить это в каждом адаптере отдельно.

## Что сделано

### Воспроизведено до правки
- [x] Точно как в отчёте: `outcome: "forced"`, две проглоченные ошибки валидации
      (`admission`, `force`), сервер ни разу не остановлен штатно.

### Code
- [x] `packages/core/src/application/server-resource.ts`: бюджеты приводятся к
      целым. Grace — **вниз** (это обещание об оставшемся времени, и `0`
      означает «без грейса»). Force — **вверх**, потому что там `0` не малый
      бюджет, а невозможный: сервер выполняет
      `withTimeout(forceStop(), forceTimeoutMs)` и падает с «did not complete
      within 0ms», а округление вниз остатка меньше миллисекунды порождало
      ровно это.
- [x] Нефинитное значение **пропускается насквозь**: `Infinity`/`NaN` в дедлайне
      — ошибка программиста, схема отвергает её громко, а тихое превращение в
      `0` сделало бы из неё немедленный force без следа.
- [x] **`retryAfterSeconds` — то же поле того же дефекта, найдено валидатором.**
      Оно объявлено `int()` той же схемой, тип в конфиге — голый `number`, а
      гайд апгрейда прямо велит переносить его на этот адаптер, где вычисление
      из длительности (`timeoutMs / 1000`) попадает на дробь. Отказ был
      байт-в-байт тем же, и хуже: сервер не закрывается и процесс **виснет**.

### Ответ на вопрос «нет ли той же арифметики где-то ещё»
- [x] Прочёсано. Остальные вычитания `performance.now()` — `kernel.ts` (дважды),
      `schedule.ts` (дважды), `tools/wait-core.ts` (дважды) — кормят
      `setTimeout`/`clock.schedule`, которые дроби принимают. Больше ничего не
      сломано. Проверка на границе типов невозможна: обе величины — `number`.
      Схема оставлена строгой намеренно: именно её строгость этот дефект и
      поймала.

### Tests
- [x] `packages/core/tests/application-reported-health.test.ts` — «shutting down
      through managedServerResource is clean, not forced», «the third integer
      field is a budget too» (дробный `retryAfterSeconds`), «a force budget is
      never rounded to an impossible zero» (полноценный `ManagedServerHandle`,
      без каста, ловит округление вниз).
- [x] Фальсифицировано: возврат дробных бюджетов роняет первый тест.

### Осталось отдельной таской
- [x] Откат неудачного старта зовёт `close` без дедлайнов, то есть с нулевыми
      бюджетами. Предшествует этой пачке, но правка про `reportHealth` сделала
      этот путь достижимым намного чаще →
      `docs/backlog/inbox/2026-08-25-startup-rollback-shuts-a-server-down-with-no-budget.md`.
