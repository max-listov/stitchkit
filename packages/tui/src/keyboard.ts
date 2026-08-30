export interface AgentTuiKey {
  name?: string;
  ctrl?: boolean;
}

/** Raw terminal mode consumes SIGINT, so Ctrl+C must be handled as a key too. */
export function isAgentTuiExitKey(key: AgentTuiKey): boolean {
  return key.ctrl === true && key.name?.toLowerCase() === 'c';
}
