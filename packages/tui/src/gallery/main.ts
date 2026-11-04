#!/usr/bin/env bun
// The gallery runs React's production build unless asked otherwise; React is
// loaded only after this line (see cli.ts for why a long-lived screen needs it).
process.env.NODE_ENV ??= 'production';

export {};

const { createCliRenderer } = await import('@opentui/core');
const { createRoot } = await import('@opentui/react');
const { createElement } = await import('react');
const { TerminalGallery } = await import('./app');

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  createElement(TerminalGallery, {
    onExit: () => {
      renderer.destroy();
      process.exit(0);
    },
  }),
);
