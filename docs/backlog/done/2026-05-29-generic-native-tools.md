---
title: "Generic native MCP tools — mountWait / mountDownload / mountUpload"
description: "Вынести императивные нативные тулы (poll-wait, download, upload) в стич как generic-оболочки; убить дубль poll-loop и прямой SDK-импорт у потребителя."
type: task
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29 15:22
related: docs/decisions/0019-generic-native-tools.md
---

# Generic native MCP tools

## Зачем

Императивные тулы (ждать async-джоб, скачать URL, загрузить файл) контракт не
выражает. Потребитель раньше хардкодил их на сыром `McpServer`: прямой
`import @modelcontextprotocol/sdk` + **свой** poll-loop, дублирующий CLI-шный
`pollUntilDone`. Стич уже возит generic `mountViewFile` — те же по природе тулы
должны жить там же. → [ADR 0019](../../decisions/0019-generic-native-tools.md).

## Что сделано

### Core (stitchkit)
- [x] `pollUntil` — единый backoff/timeout poll-loop (домен-free) — `packages/core/src/tools/wait-core.ts`
- [x] `mountWait(server, config)` — generic poll-до-готовности — `tools/mount-wait.ts`
- [x] `mountDownload(server, config)` — resolveUrl → fetch → запись на диск — `tools/mount-download.ts`
- [x] `mountUpload(server, config)` — локальный path → `config.upload` — `tools/mount-upload.ts`
- [x] `textResult` общий хелпер MCP-вывода — `tools/native-result.ts`
- [x] `pollUntilDone` (CLI `--wait`) переведён на `pollUntil` → **один loop** на CLI и MCP — `tools/cli-wait.ts`
- [x] реэкспорт `type McpServer` из `stitchkit/tools` (нативный тул без прямого SDK-импорта) — `tools.ts`

### Результат для потребителя
- [x] Нативные тулы собираются **конфигом** над генериками (poll/done, resolveUrl, upload) — потребитель не пишет MCP-SDK-обвязку и не дублирует poll-loop.
- [x] **0 прямых `@modelcontextprotocol/sdk`-импортов** в коде потребителя (адаптация на стороне приложения; в backlog приложения).

### Что НЕ делалось
- Batch-режим в poll-тулах — упрощено до одиночной цели.
- Тесты на `mountWait/Download/Upload` — TODO (follow-up).
