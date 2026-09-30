import { useSyncExternalStore } from 'react';
import type { AgentController, AgentControllerState } from './browser-controller';

/** Observe an application-owned controller; unmount never closes a shared connection or agent. */
export function useAgent(controller: AgentController): AgentControllerState {
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
}
