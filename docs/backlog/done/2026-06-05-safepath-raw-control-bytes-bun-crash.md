---
title: safePath regex — сырые control-байты (robustness, не краш-баг либы)
description: server/logger.ts safePath() — regex-литерал с literal control-байтами. Падал не из-за stitchkit, а из-за СТАРОГО bun 1.3.5 у потребителя; bun 1.3.14 (как на сервере) парсит ОК. Низкий приоритет — escape ради version-независимости.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 01:00
---

# safePath regex — сырые control-байты (robustness)

> ⚠️ ПЕРЕОЦЕНКА: это НЕ краш-баг stitchkit. Падение было из-за **устаревшего локального bun 1.3.5** у потребителя. После `bun upgrade` → 1.3.14 (версия с сервера) импорт stitchkit 0.5.0 проходит, backend бутится. Прод цел и так. Оставляю как **низкоприоритетный robustness-нит**, а не баг.

## Что именно
`packages/core/src/server/logger.ts` → `safePath(pathname)`:
```
return pathname.replace(/[ «NUL»-«US»«DEL» ]/g, "");
```
В исходнике regex-литерал содержит **literal control-байты** (0x00, 0x1f, 0x7f), не escape:
- hexdump source: `2f 5b 00 2d 1f 7f 5d 2f` = `/[\x00-\x1f\x7f]/`
- `grep` метит `logger.ts` как «binary file matches».

## Поведение по версиям bun
- **bun 1.3.5** (старый локальный) — THROW на парсе: `Invalid regular expression: range out of order in character class` → любой `import 'stitchkit'` падает.
- **bun 1.3.14** (сервер + после upgrade) — парсит ОК.
- Node — ОК.

Т.е. поведение зависит от версии bun-регекс-парсера; сырые control-байты в литерале — хрупко.

## Предложение (опционально, version-proof)
Заменить literal-байтовый литерал на escape/RegExp-из-строки, чтобы не зависеть от толерантности конкретного bun:
```ts
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
export function safePath(pathname: string): string {
  return pathname.replace(CONTROL_CHARS, "");
}
```
Проверено: `new RegExp("[\\u0000-\\u001f\\u007f]","g")` парсится и в старом, и в новом bun.

## Заметка потребителям
Держать локальный bun ≥ версии сервера (1.3.14). Старый bun ловит этот регекс на парсе.

---

## Что сделано (2026-06-05, реализовано в дереве)

Фикс **пошёл дальше** предложенного `new RegExp("...")` — он спотыкается о Biome
`useRegexLiterals` (требует regex-литерал), а `\u`-escaped литерал всё равно
требует `biome-ignore noControlCharactersInRegex`. Чище всего — **без regex
вообще**: char-code фильтр (ноль escape'ов, ноль regex-литерала, ноль сырых
байтов, неуязвим к bundler/Bun-парсеру/линтеру).

- [x] `packages/core/src/server/logger.ts` — `safePath` переписан char-code
  циклом (drop 0x00–0x1f и 0x7f), `CONTROL_CHARS`-regex удалён.
- [x] Регресс-тест `packages/core/tests/no-raw-control-bytes.test.ts` — скан всех
  `src/**/*.ts` на сырые control-байты (TAB/LF/CR разрешены). CI ловит рецидив
  (баг был невидим — «binary file», уехал в 0.4.0 и 0.5.0).
- [x] Проверено: **src + dist чисты** от сырых control-байтов; `bun run verify`
  зелёный (360 tests).

### Оценка: фикс нужен? — ДА, но не аврал
- **Нужен:** stitchkit декларирует `engines.bun >= 1.2.0`; на bun-версиях из этого
  диапазона (≤1.3.5) raw-byte regex отвергается → 0.4.0/0.5.0 реально не
  импортятся там. Это честный гэп против собственного supported-range + плохая
  гигиена (невидимые байты, «binary» файл).
- **Не аврал:** конкретный потребитель уже разблокирован (`bun upgrade` → 1.3.14);
  никто прямо сейчас не заблокирован. → едет в **батч 0.6.0** (пауза держится).
  Опционально — ранний **0.5.1** hotfix, если хотим, чтобы опубликованные
  0.4.0/0.5.0 импортились на старых bun.