---
title: "ADR 0219: Повреждение journal — данные, отказ IO — ошибка"
description: "Общий bounded reader сохраняет валидные кадры и явно выдаёт аномалии; startup writer восстанавливает диагностику из сохранённых поколений."
status: active
created: 2026-09-30 17:41 +07:00
updated: 2026-09-30 17:41 +07:00
type: decision
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-09-30 17:41 +07:00
---

# ADR 0219 — Повреждение journal — данные, отказ IO — ошибка

## Контекст

Writer уже ротирует незавершённый active-файл целиком. Но сохранённый NUL-хвост
в архиве ломает consumer, который вызывает `JSON.parse` на каждой строке.
Счётчик `partialTails` описывает только текущий запуск и не объясняет архивные
повреждения. Причина появления NUL неизвестна; `flush()` не обещает `fsync`.

## Решение

Один `readDiagnosticJournal` в filesystem leaf читает конечные snapshots с
bounded line buffer. Общая схема кадра и schema-backed результаты остаются
в pure application. Валидные frames проходят owner `eventSchema`; повреждённые
строки дают отдельные anomalies с причиной, файлом, byte offset/line и объёмом
пропуска. Ошибки доступа, небезопасный тип файла и truncation бросают исключение.
Валидный кадр без LF остаётся доступен вместе с предупреждением.

Startup writer использует тот же reader под эксклюзивным lock. Проверка
исторических событий ограничивается JSON/frame-контрактом. Recovery status
хранит counts и first/last anomaly; повторный старт восстанавливает его из
сохранённых файлов. Повреждённый active ротируется целиком с обычной finite
retention. `maxFiles: 1` отказывает до удаления данных и освобождает lock.

## Альтернативы и проверка

Молчаливое игнорирование invalid rows скрывает потерю доказательств. Отдельные
consumer parsers раздваивают правила. Обрезка хвоста уничтожает исходные байты;
новый quarantine/sidecar registry добавляет собственный lifecycle и хранение.
Общий reader и восстановимая диагностика дают проверяемый результат без них.

Real-file tests проверяют NUL в active/.1/.7, restart/append, сохранность байтов,
oversized/interior rows, torn UTF-8/JSON, schema refusals, настоящий EACCES,
symlink, truncation и cleanup при отмене. Recovery не становится durable replay
и не отправляется рекурсивно в повреждённый writer. Решение служит I3, I8, I10 и I13.
