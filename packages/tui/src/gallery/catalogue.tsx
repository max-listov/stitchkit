import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  createTerminalForm,
  reduceTerminalForm,
  type TerminalFormAction,
  type TerminalFormState,
  terminalFormFieldsFromJsonSchema,
} from '../core/form';
import { defineTerminalKeymap, type TerminalKeyBinding } from '../core/key-hints';
import {
  createTerminalList,
  reduceTerminalList,
  type TerminalListAction,
  type TerminalListItemInput,
} from '../core/list';
import type { TerminalAsyncState } from '../core/progress';
import { useTerminalLabels } from '../widgets/context';
import { TerminalDialog, TerminalSpinner } from '../widgets/feedback';
import { TerminalForm, terminalFormKeymap } from '../widgets/form';
import { TerminalList, terminalListKeymap } from '../widgets/list';
import { TerminalJsonView, terminalTextViewKeymap } from '../widgets/text-view';

/** A method catalogue, the shape of a CLI front-end: pick, fill, confirm, run, read. */
interface Method {
  name: string;
  section: string;
  description: string;
  destructive: boolean;
  schema: unknown;
}

const SECTIONS = [
  { id: 'docs', title: 'Documents' },
  { id: 'repo', title: 'Repositories' },
  { id: 'hosts', title: 'Hosts' },
];

const METHODS: Method[] = [
  ...['read', 'search', 'projects', 'tasks', 'watch'].map((name) => ({
    name: `docs_${name}`,
    section: 'docs',
    description: `Documents: ${name} across every project, with provenance and scope.`,
    destructive: false,
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id, owner/repo' },
        query: { type: 'string' },
        limit: { type: 'integer', default: 20 },
      },
      required: ['project'],
    },
  })),
  ...['query_issues', 'portfolio', 'transfer', 'release_status'].map((name) => ({
    name: `repo_${name}`,
    section: 'repo',
    description: `Repositories: ${name.replace('_', ' ')} across every repository.`,
    destructive: name === 'transfer',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string', enum: ['inbox', 'planned', 'in-progress', 'done'] },
        dryRun: { type: 'boolean', default: true },
        filter: { type: 'object' },
      },
      required: ['project', 'status'],
    },
  })),
  ...['state', 'quota', 'restart', 'logs'].map((name) => ({
    name: `hosts_${name}`,
    section: 'hosts',
    description: `Hosts: ${name} for one machine or all of them.`,
    destructive: name === 'restart',
    schema: {
      type: 'object',
      properties: {
        machine: { type: 'string', enum: ['alpha', 'beta', 'gamma'] },
        token: { type: 'string', format: 'password' },
      },
      required: ['machine'],
    },
  })),
];

function methodItems(): TerminalListItemInput[] {
  return METHODS.map((method) => ({
    key: method.name,
    title: method.name,
    meta: method.section,
    section: method.section,
    description: method.description,
    ...(method.destructive && { tone: 'warning' as const, badge: '!' }),
  }));
}

/** Values as they may be shown: a secret field stays hidden after the form, too. */
function masked(method: Method, values: Record<string, unknown>): Record<string, unknown> {
  const secrets = new Set(
    terminalFormFieldsFromJsonSchema(method.schema)
      .filter(({ kind }) => kind === 'secret')
      .map(({ name }) => name),
  );
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, secrets.has(name) ? '••••' : value]),
  );
}

type Screen =
  | { kind: 'list' }
  | { kind: 'form'; method: Method }
  | { kind: 'confirm'; method: Method; values: Record<string, unknown> }
  | { kind: 'result'; method: Method; result: TerminalAsyncState<unknown> };

export interface CatalogueProps {
  width: number;
  height: number;
  active: boolean;
  clock: () => number;
  onScreen(breadcrumbs: string[], bindings: TerminalKeyBinding[]): void;
  onNotice(text: string, tone: 'success' | 'danger' | 'warning'): void;
}

export function CatalogueDemo({
  width,
  height,
  active,
  clock,
  onScreen,
  onNotice,
}: CatalogueProps) {
  const labels = useTerminalLabels();
  const [list, listDispatch] = useReducer(reduceTerminalList, undefined, () =>
    createTerminalList({ items: methodItems(), sections: SECTIONS }),
  );
  const [form, setForm] = useState<TerminalFormState | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const onList = useCallback((action: TerminalListAction) => listDispatch(action), []);
  const onForm = useCallback(
    (action: TerminalFormAction) =>
      setForm((current) =>
        current ? reduceTerminalForm(current, action, labels.form) : current,
      ),
    [labels.form],
  );

  // A run outliving the page must not report into a screen that is gone.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  const run = useCallback(
    (method: Method, values: Record<string, unknown>) => {
      const startedAt = clock();
      setScreen({
        kind: 'result',
        method,
        result: { status: 'loading', startedAt, label: method.name },
      });
      pending.current = setTimeout(() => {
        pending.current = null;
        const failed = values.project === 'fail';
        setScreen({
          kind: 'result',
          method,
          result: failed
            ? {
                status: 'error',
                message: `${method.name}: project "fail" does not exist`,
                retryable: true,
              }
            : {
                status: 'ready',
                data: {
                  ok: true,
                  method: method.name,
                  input: masked(method, values),
                  items: [
                    { id: 1, title: 'First' },
                    { id: 2, title: 'Second', tags: ['a', 'b'] },
                  ],
                  tookMs: 1180,
                },
              },
        });
        onNotice(
          failed ? `${method.name} failed` : `${method.name} done`,
          failed ? 'danger' : 'success',
        );
      }, 1200);
    },
    [clock, onNotice],
  );

  useEffect(() => {
    if (!active) return;
    const crumbs = ['Catalogue'];
    if (screen.kind === 'list')
      onScreen(crumbs, terminalListKeymap(labels, { searchable: true }));
    else if (screen.kind === 'form')
      onScreen([...crumbs, screen.method.name], terminalFormKeymap(labels));
    else if (screen.kind === 'confirm')
      onScreen(
        [...crumbs, screen.method.name],
        defineTerminalKeymap([
          { id: 'y', keys: ['y'], display: 'y', label: labels.yes },
          { id: 'n', keys: ['n', 'escape'], display: 'n/Esc', label: labels.no },
        ]),
      );
    else onScreen([...crumbs, screen.method.name, 'result'], terminalTextViewKeymap(labels));
  }, [active, screen, labels, onScreen]);

  if (screen.kind === 'list') {
    return (
      <TerminalList
        state={list}
        onAction={onList}
        searchable
        width={width}
        height={height}
        focused={active}
        onActivate={(item) => {
          const method = METHODS.find(({ name }) => name === item.key);
          if (!method) return;
          setForm(createTerminalForm(terminalFormFieldsFromJsonSchema(method.schema)));
          setScreen({ kind: 'form', method });
        }}
      />
    );
  }
  if (screen.kind === 'form' && form) {
    return (
      <TerminalForm
        state={form}
        onAction={onForm}
        width={width}
        focused={active}
        onCancel={() => setScreen({ kind: 'list' })}
        onSubmit={(values) =>
          screen.method.destructive
            ? setScreen({ kind: 'confirm', method: screen.method, values })
            : run(screen.method, values)
        }
      />
    );
  }
  if (screen.kind === 'confirm') {
    return (
      <box style={{ alignItems: 'center', justifyContent: 'center', height }}>
        <TerminalDialog
          title={screen.method.name}
          message={`This method changes state. Run ${screen.method.name} with ${JSON.stringify(masked(screen.method, screen.values))}?`}
          focused={active}
          onConfirm={() => run(screen.method, screen.values)}
          onCancel={() => setScreen({ kind: 'form', method: screen.method })}
        />
      </box>
    );
  }
  if (screen.kind === 'result') {
    const back = () => setScreen({ kind: 'list' });
    const { result } = screen;
    if (result.status === 'loading')
      return (
        <TerminalSpinner
          label={result.label ?? labels.loading}
          startedAt={result.startedAt}
          clock={clock}
        />
      );
    return (
      <TerminalJsonView
        value={
          result.status === 'ready'
            ? result.data
            : { ok: false, error: result.status === 'error' ? result.message : null }
        }
        width={width}
        height={height}
        focused={active}
        onBack={back}
      />
    );
  }
  return null;
}
