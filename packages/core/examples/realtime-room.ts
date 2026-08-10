import { z } from 'zod';
import { defineRealtimeContract } from '../src/realtime';

const NoteSchema = z.object({ id: z.string(), text: z.string() });

export const exampleRealtimeContract = defineRealtimeContract({
  serverToClient: {
    'note:created': { args: z.tuple([NoteSchema]) },
  },
  clientToServer: {},
});

type ExampleRealtimePublisher = {
  to(room: string): {
    emit(event: 'note:created', note: z.infer<typeof NoteSchema>): void;
  };
};

// canonical-example:start
export function publishExampleNote(realtime: ExampleRealtimePublisher): void {
  const note = { id: 'note-1', text: 'Ready' };
  realtime.to('general').emit('note:created', note);
}
// canonical-example:end
