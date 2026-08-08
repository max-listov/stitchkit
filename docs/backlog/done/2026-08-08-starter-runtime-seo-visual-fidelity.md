---
title: Starter runtime, SEO and visual fidelity
description: Align the generated starter with production process supervision, complete typed metadata and the canonical status palette.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 07:59 +00:00
---

## Цель

Довести starter до production-shaped эталона в трёх связанных местах: PM2 должен запускать
пакеты через прямые entrypoints, каждая публичная страница должна получать полную SEO-модель из
типизированного реестра, а status-цвета должны использовать канонические semantic tokens.

## План

- [x] Перевести API и web dev-конфигурации PM2 с package-script wrappers на прямые runtime entrypoints.
- [x] Синхронизировать прямой template dev runtime с тем же PM2-паттерном и покрыть конфигурацию тестами.
- [x] Ввести единый типизированный locale-aware реестр публичных страниц и metadata builder.
- [x] Сделать page-level metadata обязательной для home и всех UI stories: title, description, canonical, hreflang, Open Graph и Twitter.
- [x] Генерировать locale/page-aware OG-карточки из того же реестра и убрать старый generic endpoint.
- [x] Добавить sitemap и robots из канонического SEO surface.
- [x] Обновить видимые тексты starter: продукт — Stitchkit starter, а не developer cockpit.
- [x] Вернуть канонические success/destructive tokens и варианты компонентов без локальных цветовых костылей.
- [x] Обновить документацию и changelog публичного starter surface.
- [x] Прогнать targeted tests и полный `bun run verify`.

## Acceptance

- [x] В dev PM2 нет `bun run dev`; API стартует через Bun watcher, web — через Next CLI.
- [x] У каждой индексируемой страницы есть уникальная локализованная metadata и рабочая OG-картинка.
- [x] Canonical, language alternatives, sitemap и OG выводятся из одного закрытого реестра.
- [x] Неизвестные locale/page для OG fail-first и не создают ложную карточку.
- [x] Зелёные и красные состояния используют каноническую палитру с WCAG-контрастом в light/dark themes.
- [x] Прямой template dev runtime сохраняет HMR на стабильных портах.
- [x] Все repository gates зелёные.

## Что сделано

- [x] **Runtime:** `template/ecosystem.dev.config.cjs` и `template/ecosystem.config.cjs`
  запускают Bun API и Next CLI напрямую; PM2 видит реальные RSS
  API и web вместо памяти package-script wrappers.
- [x] **API:** `template/packages/backend/src/index.ts` имеет обычный async bootstrap без top-level
  await, поэтому прямой Bun entrypoint одинаково работает из CLI и PM2.
- [x] **SEO:** `template/packages/frontend/src/lib/seo/pages.ts` — закрытый типизированный реестр всех
  EN/RU страниц; `metadata.ts`, page layouts, sitemap, robots и locale/page OG route выводятся
  из него.
- [x] **UI:** публичный продукт называется Stitchkit Starter; success/destructive tokens
  восстановлены, а status foreground сохраняет исходный hue и проходит WCAG AA.
- [x] **Tests:** scaffold/runtime tests фиксируют прямые PM2 entrypoints; SEO unit test
  проверяет полноту реестра; E2E проверяет metadata, доступную PNG OG-картинку, навигацию,
  accessibility и responsive surface в Chromium, mobile Chromium и WebKit.
- [x] **Docs:** обновлены README и `packages/create-stitchkit/CHANGELOG.md`.
- [x] **Validation:** `bun run starter-lane` и корневой `bun run verify` завершились зелёными;
  direct template отвечает `200`, OG route отдаёт `image/png`, HMR остаётся на стабильном web-порту.
- [x] **Не делалось:** commit, release и deploy не выполнялись.
