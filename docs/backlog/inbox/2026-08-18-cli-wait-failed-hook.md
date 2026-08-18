---
title: "CliWaitConfig.failed — терминальный FAILED в --wait не должен давать exit 0"
description: Запрос потребителя (CLI поверх implementRemote): --wait на терминальном FAILED-статусе завершается exit 0 — агент принимает провал за успех. Нужен хук failed?(result) или эквивалент.
type: task
status: inbox
created: 2026-08-18
---

# `CliWaitConfig.failed?(result)`

## Зачем

Потребительский CLI с `--wait`: терминальный `FAILED` результата ожидания
сегодня неотличим от успеха — exit 0, агент-вызыватель принимает провал за
успех. Запрошен хук вида `failed?(result)` в `CliWaitConfig`, чтобы CLI мог
маппить терминальный провал в ненулевой exit.

## Результат

- Проработать форму (хук/предикат) по факту текущего `CliWaitConfig`;
  реализация по конвейеру после команды.
