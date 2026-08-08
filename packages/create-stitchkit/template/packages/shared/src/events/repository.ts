import type { RepositorySnapshot } from '../schemas/repository';

export interface ServerToClientEvents {
  'repository:refreshed': (snapshot: RepositorySnapshot) => void;
}

export interface ClientToServerEvents {
  'repository:watch': () => void;
}
