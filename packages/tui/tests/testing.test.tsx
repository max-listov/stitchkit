import { describe, expect, test } from 'bun:test';
import { useReducer, useState } from 'react';
import {
  createTerminalForm,
  reduceTerminalForm,
  type TerminalFormAction,
  type TerminalFormState,
} from '../src/core/form';
import { terminalLabelsRu } from '../src/core/labels';
import { TerminalGallery } from '../src/gallery/app';
import { renderTerminalTest } from '../src/testing';
import { TerminalForm } from '../src/widgets/form';

function Broken(): never {
  throw new Error('catalogue unavailable');
}

function NoFields({ onSubmit }: { onSubmit(values: Record<string, unknown>): void }) {
  const [state, dispatch] = useReducer(
    (current: TerminalFormState, action: TerminalFormAction) =>
      reduceTerminalForm(current, action),
    createTerminalForm([]),
  );
  const [left, setLeft] = useState(false);
  return left ? (
    <text>left</text>
  ) : (
    <TerminalForm
      state={state}
      onAction={dispatch}
      onSubmit={onSubmit}
      onCancel={() => setLeft(true)}
      width={40}
    />
  );
}

// No `act` and no sleeps below: the helper owns both, which is what it is for.
describe('renderTerminalTest', () => {
  test('Enter opens a screen, typing reaches its field, Esc goes back', async () => {
    const screen = await renderTerminalTest(
      <TerminalGallery clock={() => 1_000_000} onExit={() => undefined} />,
      { width: 100, height: 34 },
    );
    try {
      expect(await screen.type('qissues')).toContain('› repo_query_issues');
      expect(await screen.press('RETURN')).toContain('Catalogue › repo_query_issues');
      expect(await screen.type('alpha')).toContain('alpha');
      // A lone Esc reaches the screen only after the parser's escape timeout.
      const back = await screen.press('ESCAPE');
      expect(back).not.toContain('Catalogue › repo_query_issues');
      expect(back).toContain('› repo_query_issues');
    } finally {
      await screen.close();
    }
  }, 30_000);

  test('a screen that throws while rendering shows its cause instead of a blank terminal', async () => {
    const screen = await renderTerminalTest(<Broken />, { labels: terminalLabelsRu });
    try {
      const frame = await screen.frame();
      expect(frame).toContain('Приложение остановилось из-за ошибки');
      expect(frame).toContain('Error: catalogue unavailable');
    } finally {
      await screen.close();
    }
  });
});

describe('a form without fields', () => {
  test('says it has no parameters and submits {} on Enter', async () => {
    const submitted: Record<string, unknown>[] = [];
    const screen = await renderTerminalTest(
      <NoFields onSubmit={(values) => submitted.push(values)} />,
      { labels: terminalLabelsRu },
    );
    try {
      expect(await screen.frame()).toContain('Параметров нет · Enter — выполнить');
      await screen.press('RETURN');
      expect(submitted).toEqual([{}]);
      // Negative control: a key the form does not bind submits nothing.
      await screen.press('x');
      expect(submitted).toEqual([{}]);
      expect(await screen.press('ESCAPE')).toContain('left');
    } finally {
      await screen.close();
    }
  });
});
