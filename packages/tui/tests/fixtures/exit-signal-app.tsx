// A terminal application that keeps a timer, as real screens do (spinners, polls).
// `kit` starts through runTerminalApp; `bare` is OpenTUI alone, the negative control.
import { writeFileSync } from 'node:fs';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { runTerminalApp } from '../../src/widgets/app';

const [mode, pidFile] = process.argv.slice(2);
if (!pidFile) throw new Error('usage: exit-signal-app.tsx kit|bare PID_FILE');
setInterval(() => undefined, 1000);
if (mode === 'kit') {
  await runTerminalApp(<text>alive</text>, { themeMode: 'dark' });
} else {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<text>alive</text>);
}
writeFileSync(pidFile, String(process.pid));
