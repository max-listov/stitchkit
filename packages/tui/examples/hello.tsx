/**
 * The smallest kit application: one panel, the palette of the terminal it runs
 * in, and an exit on q, Ctrl-C or a closed window. Compile it for any platform:
 *
 *   bun -e "import { compileTerminalApp } from 'stitchkit-tui/build';
 *     await compileTerminalApp({ entry: 'hello.tsx', outfile: 'hello', target: 'bun-linux-x64' })"
 */
import { runTerminalApp, TerminalPanel, useTerminalKeyboard } from '../src/widgets';

function Hello({ onQuit }: { onQuit(): void }) {
  useTerminalKeyboard((key) => {
    if (key.name !== 'q') return false;
    onQuit();
    return true;
  });
  return (
    <TerminalPanel title='stitchkit-tui'>
      <text>Hello from a compiled terminal application · q quits</text>
    </TerminalPanel>
  );
}

await runTerminalApp(({ close }) => (
  <Hello onQuit={() => void close().then(() => process.exit(0))} />
));
