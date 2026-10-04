---
title: Public build-time native packaging
description: Один граф native assets и lazy loader для custom companion layout и embedded delivery.
status: active
created: 2026-10-04 18:29 +07:00
updated: 2026-10-04 18:56 +07:00
type: decision
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-10-04 18:29 +07:00
---

# Публичная упаковка native assets во время сборки

## Контекст

Native capability должна сохраняться после сборки и переноса приложения. Installer,
разбирающий private import literals loader’а, зависит от внутреннего layout даже при
проверке hashes и успешной загрузке текущего addon. Обычный JS bundle содержит companion
assets; Bun compiled executable встраивает addon своей архитектуры.

## Решение

`stitchkit/files/packaging` — evolving build-only leaf. `createNativePackaging` возвращает
version/target установленного пакета, source/output paths и исходный SHA256 addon, а также
структурно типизированный Bun plugin. Его declarations не требуют Bun runtime или ambient types.
Один package-owned metadata graph и generator создают lazy loader для package imports,
custom companion output и embedded compile. Runtime leaves не импортируют packaging.
Companion recipe требует фиксированный entry path без splitting; relative addon edge
остаётся external для bundler. Embedded mode передаёт Bun compile настоящий addon.
Неподдерживаемый target и отсутствующий asset имеют явный отказ; повреждённая metadata
и прочие IO failures бросают ошибку. Consumer не разбирает private loader text.

## Следствия

Приложение выбирает формат архива, storage root, signature/trust и install policy.
Оно сохраняет полный output graph и сверяет исходные hashes после archive roundtrip.
Равенство digest подтверждает integrity, но не authenticity. Потерянный или испорченный
runtime addon сохраняет unavailable identity и безопасную диагностику; упаковка не
выдумывает process evidence и не ослабляет guards. Maturity остаётся evolving до
квалификации публичного контракта у двух независимых потребителей.

Инварианты I7, I8, I13, I14. Qualification меняет private addon paths при сохранении metadata,
проверяет отказ прежнего hardcoded recipe и успешный public recipe, затем исполняет
архивные artifacts на соответствующем Darwin runtime. Portable проверки не заменяют Darwin.
