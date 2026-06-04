---
title: "CLI — четвёртый транспорт"
description: "createCli() — полноценная CLI-поверхность из контракта. Один defineContract → HTTP + MCP + Agent + CLI."
type: task
status: done
created: 2026-05-26
updated: 2026-05-29
completed: 2026-05-29 15:22
---

# CLI — четвёртый транспорт

## Зачем

stitchkit даёт три поверхности из одного контракта: HTTP API, MCP tools, AI-agent tools. Четвёртая — CLI — закрывает два кейса, которые ни один из трёх не покрывает:

1. **Background-friendly generation.** MCP tool call блокирует клиент — LLM не может делать другое пока `wait_for_generation` поллит. CLI-команда запускается через `Bash(run_in_background=true)` → LLM свободен → notification когда done.

2. **Skills-friendly.** Паттерн Skills: markdown SKILL.md вызывает CLI через Bash. Одна команда `myapp generate create --prompt "..." --wait` вместо JSON-RPC roundtrip. Claude Code / Cursor / Codex подхватывают Skills нативно.

3. **Human-friendly terminal.** Разработчик: `myapp models list`, `myapp generate "a fox" --wait`. Без Postman, без MCP клиента.

4. **Scriptable / pipeable.** `myapp models list --json | jq '.[] | select(.type=="IMAGE")'`.

## Референс

Изучили референсный AI-media стек (официальный MCP + Skills + CLI):
- Remote HTTP MCP — для claude.ai web
- npm CLI-бинарник — все Skills вызывают его через Bash
- публичный skills-репо — несколько скиллов (generate, и т.п.)
- CLI делает: auth, upload, polling (`--wait`), schema validation, auto-upload local files
- Skills = markdown SKILL.md с model picking decision tree, workflow, UX rules

Референс-материалы изучены отдельно (несколько community MCP + 1 official skills repo).

## Подход: полноценный транспорт, не thin wrapper

### Рассмотренные варианты

**A. Thin wrapper** — CLI = `createClient()` + arg parser. CLI стучит в бэкенд по HTTP.
- Плюс: ~300 строк, не трогает core
- Минус: нет `source: 'cli'`, нет parity с другими транспортами, нет auth gate на стороне CLI, CLI-specific фичи (--wait, --output-dir, positional args) — руками в потребителе

**B. Полноценный транспорт** — CLI = четвёртая поверхность наравне с MCP/Agent.
- `Transport = 'HTTP' | 'MCP' | 'AGENT' | 'CLI'`
- `collectTools(service, 'CLI')` → `executeToolMethod()` → `ToolResult`
- Shared pipeline: validation, auth gate, error model, hooks
- CLI-specific: `--wait`, `--json`, positional args, pipe, output formatter

**Выбран B** — parity, vision alignment ("one contract, four surfaces"), reuse 90% existing code.

## Архитектура

### Transport type
```typescript
// contract/define.ts
export const ALL_TRANSPORTS = ['HTTP', 'MCP', 'AGENT', 'CLI'] as const;
export type TransportSource = 'http' | 'mcp' | 'agent' | 'cli';
```

### Execution flow
```
CLI argv
  ↓ parse (Zod schema → flags)
  ↓ collectTools(service, 'CLI')
  ↓ executeToolMethod(method, name, args, { source: 'cli' })
  ↓ ToolResult
  ↓ format (--json | --table | human text)
  ↓ stdout + exit code
```

### Новые файлы
```
packages/core/src/tools/
├── cli.ts              ← createCli() entry point
├── cli-args.ts         ← Zod schema → argv parser (zero deps, ~150 строк)
├── cli-format.ts       ← ToolResult → stdout formatter
└── cli-wait.ts         ← --wait polling logic
```

### Entrypoint
```json
{ "./cli": "dist/tools/cli.js" }
```
Import: `import { createCli } from 'stitchkit/cli'`

### API surface

```typescript
interface CliConfig {
  name: string;
  version: string;
  services: ServiceDef[];
  auth?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  context?: Record<string, unknown>;
  lifecycle?: ToolLifecycle;
  hooks?: ToolCallHooks;
  wait?: CliWaitConfig;
  format?: { default?: 'json' | 'text'; json?: boolean };
}

interface CliWaitConfig {
  poll: (result: unknown) => string | null;  // extract ID from generate response
  check: string;                             // endpoint key for polling (e.g. 'getGeneration')
  statusField: string;                       // 'status'
  terminalStatuses: string[];                // ['COMPLETED', 'FAILED']
  backoff?: number[];                        // [2, 4, 6, 8, 10, 12, 15]
  defaultTimeout?: number;                   // 600
}

function createCli(config: CliConfig): void  // parses process.argv, runs, exits
```

### CLI-unique фичи (нет у HTTP/MCP/Agent)

| Фича | Описание |
|------|----------|
| `--wait` | Blocking poll после async endpoint. Background-safe через Bash |
| `--wait-timeout N` | Configurable timeout (seconds) |
| `--output-dir ./out` | Download результат на диск |
| `--json` | Raw JSON stdout для pipe/scripting |
| `--quiet` | Минимальный output |
| Positional args | `myapp generate "prompt"` вместо `--prompt "prompt"` |
| Pipe stdin | `echo "prompt" \| myapp generate` |
| `--dry-run` | Показать что будет вызвано |
| Auto help | `myapp generate --help` из Zod desc |
| `myapp auth login` | Interactive device-flow (потребитель реализует) |

### Arg parser: Zod → flags (zero deps)

| Zod type | CLI flag |
|----------|---------|
| `z.string()` | `--flag "value"` |
| `z.number()` | `--flag 123` |
| `z.boolean()` | `--flag` (presence) |
| `z.enum([...])` | `--flag value` с validation |
| `z.array(z.string())` | `--flag a --flag b` (repeated) |
| `z.object()` nested | `--flag '{"key":"val"}'` (JSON string) |
| `.optional()` | Не required |
| `.default(x)` | В help, не required |

### Command routing

```
<app> <prefix> <toolName-action> [positional] [--flags]
```

Из `collectTools()` — tool name разбирается на subcommand:
- `generate` → `myapp generate [prompt] [--flags]`
- `get_generation` → `myapp generate get <id>`
- `list_models` → `myapp models list [--type IMAGE]`
- `get_model` → `myapp models get <identifier>`

### Parity testing

Расширить `parity.test.ts`:
```typescript
async function cliCall(command: string, args: Record<string, unknown>) {
  const method = service.methods[command];
  return executeToolMethod(method, command, args, { source: 'cli' });
}
// HTTP ≡ MCP ≡ Agent ≡ CLI
```

## Что переиспользуется из existing code

| Слой | Файл | Reuse |
|------|------|-------|
| Contract | `contract/define.ts` | Контракт не меняется (кроме Transport union) |
| Tool mounting | `tools/mount.ts` | `collectTools(service, 'CLI')` |
| Tool names | `tools/names.ts` | `toToolName()` |
| Schema merge | `tools/schema.ts` | `mergeSchemas()` |
| Execution | `tools/execute.ts` | `executeToolMethod()` |
| Error model | `contract/errors.ts` | `AppError`, `ToolResult` |
| Auth | `server/middleware/auth.ts` | `createAuthHook` + `resolveFromContext` |
| Hooks | `tools/execute.ts` | `ToolCallHooks` |

## Edge cases

1. **Multipart** — `collectTools` уже скипает multipart. CLI-upload — отдельная нативная команда (`upload create`).
2. **Nested objects** — `parameters: Record<string, unknown>` → `--parameters '{"prompt":"..."}'` как JSON string.
3. **Auth storage** — вне scope stitchkit core. Потребитель: `~/.config/<app>/credentials.json`.
4. **Streaming (SSE)** — не приоритет для v1. CLI может pipe SSE → stdout later.
5. **Zero deps** — arg parser свой (~150 строк из Zod schema). Без yargs/commander.

## Порядок

1. Расширить `Transport` / `TransportSource` в `contract/define.ts`
2. `cli-args.ts` — Zod → argv parser
3. `cli-format.ts` — ToolResult → stdout
4. `cli-wait.ts` — `--wait` polling
5. `cli.ts` — `createCli()` orchestrator
6. Entrypoint `./cli` в `package.json`
7. Тесты: parity + CLI-specific
8. Docs: guide/cli.md + API reference update
9. ADR: "CLI as fourth transport"

## Vision update

```
One defineContract() → HTTP API + MCP tools + AI-agent tools + CLI + typed client
```

## Что сделано

Вариант B реализован — CLI полноценный транспорт через `executeToolMethod`
(HTTP ≡ MCP ≡ agent ≡ CLI). Решения: opt-in `expose`, export-only (нет `bin`),
generic `--wait`, multipart out-of-scope v1.

### Contract / shared
- [x] `ALL_TRANSPORTS += 'CLI'`, `TransportSource += 'cli'` — `packages/core/src/contract/define.ts`
- [x] `collectTools` — CLI **opt-in** (команда только при `expose:['CLI']`; MCP/AGENT остаются default-on) — `packages/core/src/tools/mount.ts`

### Core (stitchkit)
- [x] `createCli()` оркестратор (auth-once как `createStdioMcpServer`, routing, help, dry-run) — `tools/cli.ts`
- [x] argv → typed + schema-aware coercion + positional + dotted + `--no-flag` — `tools/cli-args.ts`
- [x] **passthrough** неизвестных флагов в freeform-поле (`generate <model> --prompt … --aspect_ratio …`) — `tools/cli.ts` (`CliConfig.passthrough`)
- [x] вывод = **pretty JSON** (дефолт) / `--json` компакт + exit-codes по `ToolResult.code` — `tools/cli-format.ts`
- [x] `--wait` generic poller, `--output-dir` download, `--quiet`, терсный хелп — `tools/cli.ts` + `tools/cli-wait.ts`
- [x] entry `./cli` (без MCP SDK / `ai`) + `build:js` + реэкспорт из `tools.ts` — `src/cli.ts`, `package.json`

### Decisions / tests / docs
- [x] ADR 0016 — `docs/decisions/0016-cli-transport.md`
- [x] parity-тест `cliCall` (HTTP ≡ tool ≡ CLI) + `tests/cli.test.ts`
- [x] `docs/guide/cli.md` + `docs/api/reference.md` (`stitchkit/cli`)

### Что НЕ делалось
- `bin` в core (export-only — bin пишет потребитель), цветной вывод, `--table` — вне v1.
- multipart/upload на CLI — исключён (как MCP/agent).
