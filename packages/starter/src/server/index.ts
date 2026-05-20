import { watch } from 'node:fs';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/contracts';
import { notes } from '@shared/contracts';
import { createServer, createSocketIOServer, implement, notFound } from 'stitchkit/server';
import { createNote, DATA_DIR, deleteNote, getNote, listNotes, updateNote } from './data';

const PORT = Number(process.env.PORT ?? 3461);

// ─── Contract → handlers (one source of truth) ────────

const notesService = implement(notes, {
  list: (ctx) => listNotes(ctx.input?.search),
  create: (ctx) => createNote(ctx.input),
  get: (ctx) => {
    const note = getNote(ctx.params.id);
    if (!note) notFound('Note not found');
    return note;
  },
  update: (ctx) => {
    const note = updateNote(ctx.params.id, ctx.input);
    if (!note) notFound('Note not found');
    return note;
  },
  delete: (ctx) => {
    deleteNote(ctx.params.id);
  },
});

// ─── Socket.IO — file watcher → live reload ───────────

const socket = createSocketIOServer<ServerToClientEvents, ClientToServerEvents>({
  cors: { origin: '*' },
});

let debounce: ReturnType<typeof setTimeout> | null = null;
watch(DATA_DIR, { recursive: true }, (_e, file) => {
  if (!file?.endsWith('.json')) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => socket.io.emit('data:updated', { file }), 50);
});

// ─── Server — pure API + Socket.IO ────────────────────
// The SPA is served separately: Vite dev server in dev, a static host
// (nginx / CDN) in prod. The backend never serves static files.

createServer({
  groups: [{ pathPrefix: '/api', services: [notesService] }],
  port: PORT,
  cors: { origin: '*' },
  logging: true,
  websocket: socket.websocket,
  rawRoutes: [
    socket.route,
    {
      method: 'GET',
      path: '/api/health',
      handler: () => Response.json({ status: 'ok', uptime: process.uptime() }),
    },
  ],
});

console.log(`  backend → http://localhost:${PORT}`);
