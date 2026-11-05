/** The README's catalogue home screen (importing the source instead of the package), kept compiling: `bun examples/catalogue-home.tsx`. */
import { useTerminalDimensions } from '@opentui/react';
import { useReducer } from 'react';
import { createTerminalList, reduceTerminalList, terminalLabelsRu } from '../src/core';
import {
  runTerminalApp,
  TerminalAppShell,
  TerminalList,
  terminalListKeymap,
} from '../src/widgets';

function Home() {
  const { width, height } = useTerminalDimensions();
  const [list, dispatch] = useReducer(reduceTerminalList, undefined, () =>
    createTerminalList({
      sections: [{ id: 'methods', title: 'Методы' }],
      items: [
        {
          key: 'search',
          title: 'Поиск по всем методам',
          description: 'Найти метод по имени и описанию',
        },
        {
          key: 'docs_read',
          title: 'docs_read',
          section: 'methods',
          meta: 'content',
        },
      ],
    }),
  );
  return (
    <TerminalAppShell
      breadcrumbs={['Каталог', 'Главная']}
      status={[[{ text: 'Каталог загружен' }, { text: '42 метода' }]]}
      bindings={terminalListKeymap(terminalLabelsRu, { searchable: true })}
      width={width}
      height={height}
    >
      <TerminalList
        state={list}
        onAction={dispatch}
        searchable
        width={width}
        height={height - 4}
      />
    </TerminalAppShell>
  );
}

await runTerminalApp(<Home />, { labels: terminalLabelsRu });
