import { apiClient } from '@client/api';
import type { ClientToServerEvents, Note, ServerToClientEvents } from '@shared/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createMutation, createQuery } from 'react-query-kit';
import { createSocketIOClient } from 'stitchkit';

/** Notes list — a `react-query-kit` query over the typed contract client. */
const useNotesList = createQuery({
  queryKey: ['notes'],
  fetcher: () => apiClient.list({}),
});

const useCreateNote = createMutation({ mutationFn: apiClient.create });
const useDeleteNote = createMutation({ mutationFn: apiClient.delete });

/** Live-reload socket — one shared Socket.IO client. */
const socket = createSocketIOClient<ServerToClientEvents, ClientToServerEvents>({
  url: window.location.origin,
});

/**
 * Notes screen state — list + create + delete, plus a Socket.IO `data:updated`
 * subscription that refetches when the JSON file changes on disk.
 */
export function useNotes() {
  const qc = useQueryClient();
  const list = useNotesList();

  const createMut = useCreateNote({
    onSuccess: (created) => {
      qc.setQueryData<Note[]>(useNotesList.getKey(), (old = []) => [created, ...old]);
    },
  });

  const deleteMut = useDeleteNote({
    onSuccess: (_data, variables) => {
      qc.setQueryData<Note[]>(useNotesList.getKey(), (old = []) =>
        old.filter((n) => n.id !== variables.id),
      );
    },
  });

  useEffect(() => {
    socket.connect();
    const off = socket.on('data:updated', () => {
      qc.invalidateQueries({ queryKey: useNotesList.getKey() });
    });
    return () => {
      off();
      socket.disconnect();
    };
  }, [qc]);

  return {
    notes: list.data ?? [],
    loading: list.isLoading,
    create: (input: { title: string; content: string }) => createMut.mutate(input),
    remove: (id: string) => deleteMut.mutate({ id }),
  };
}
