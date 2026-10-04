---
title: Universal companion selects one runtime target
description: Один plugin и runtime loader для JS artifact с несколькими Darwin addons.
status: active
created: 2026-10-04 22:33 +07:00
updated: 2026-10-04 22:33 +07:00
type: decision
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-10-04 22:33 +07:00
---

# Universal companion выбирает одну runtime архитектуру

## Контекст

Один JS artifact может обслуживать Darwin arm64, x64 и Linux. Два single-target plugins
конкурируют за один owning loader: первый onLoad заменяет файл целиком. Cross-build не
доказывает работу native identity на другой архитектуре.

## Решение

Existing `createNativePackaging` принимает architecture array и точную assetPath map для
companion delivery. Single-target строковый вход и его тип результата сохраняются;
embedded compile принимает одну архитектуру. Один metadata graph и generator создают
один lazy loader. В runtime выбирается только matching process.arch, без попытки другого
addon при отказе. До package IO проверяются уникальность targets, полнота map, traversal
и пересечения всех output paths. Packaging остаётся build-only и не добавляет peers.

## Проверка и последствия

Qualification собирает один архив из обоих native addons. Обе реальные Darwin runners
скачивают этот общий artifact, проверяют исходные hashes и исполняют тот же JS SHA через
Node и Bun offline. Проверяются self/child identity, live-owner refusal, dead-owner recovery,
missing selected addon и substituted opposite addon при сохранённом valid counterpart.
Single-target отрицательный контроль обязан показать точную причину unsupported loader
architecture. Linux исполняет тот же bundle с удалёнными Darwin addons.

Owning fixture изменяет metadata, package import map, loader и оба addon paths; consumer
recipe не меняется. Integrity digest не заменяет signature/trust приложения. CI evidence
requires shared build и обе native execution cells до сборки release tarballs и публикации.
Непроверенная архитектура не становится supported из-за сборки на другой машине.

Инварианты I8, I13, I14.
