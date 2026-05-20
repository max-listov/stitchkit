import { notes } from '@shared/contracts';
import { createClient, createHttpClient } from 'stitchkit';

const http = createHttpClient({ baseUrl: '/api' });

/**
 * Typed contract client — `apiClient.list()`, `apiClient.create({ … })`, …
 * Method names equal contract endpoint keys. React Query hooks (built with
 * `react-query-kit`) wrap these methods — see `hooks/useNotes.ts`.
 */
export const apiClient = createClient(notes, http);
