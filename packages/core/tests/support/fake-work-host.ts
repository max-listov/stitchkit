import type {
  ProcessInstance,
  ProcessInstanceObservation,
} from '../../src/internal/process-instance';
import type { WorkHost, WorkProcessLineage } from '../../src/service-host/work/host';

/** One process of a fake process table. */
export interface FakeWorkProcess {
  /** The text of `/proc/<pid>/cgroup`; `null` hides the entry while the process stays alive. */
  cgroup?: string | null;
  /** An ended process its parent has not reaped: its entry and cgroup stay readable. */
  ended?: boolean;
  lineage?: WorkProcessLineage;
  instance?: ProcessInstance;
}

/** What a fake work host holds: its process table, files, and every manager command it ran. */
export interface FakeWorkHostState {
  platform: NodeJS.Platform;
  uid: number | null;
  env: Record<string, string | undefined>;
  canReplaceProcess: boolean;
  processes: Map<number, FakeWorkProcess>;
  files: Map<string, string>;
  directories: Map<string, number>;
  commands: Array<{
    executable: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  }>;
  answer: (
    executable: string,
    args: readonly string[],
  ) => { exitCode: number; stdout: string; stderr: string };
}

export const FAKE_INSTANCE: ProcessInstance = {
  platform: 'linux',
  bootId: 'boot-1',
  namespace: 'pid:[1];time:[1]',
  startId: '100',
};

/** A work host over memory: a process table and manager answers a test writes out. */
export function createFakeWorkHost(overrides: Partial<FakeWorkHostState> = {}): {
  host: WorkHost;
  state: FakeWorkHostState;
} {
  const state: FakeWorkHostState = {
    platform: 'linux',
    uid: 1000,
    env: {},
    canReplaceProcess: true,
    processes: new Map(),
    files: new Map(),
    directories: new Map(),
    commands: [],
    answer: (_executable, args) =>
      args.includes('--version')
        ? { exitCode: 0, stdout: 'systemd 259 (259.9-0ubuntu0.1)\n+PAM\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    ...overrides,
  };
  const host: WorkHost = {
    get platform() {
      return state.platform;
    },
    get uid() {
      return state.uid;
    },
    get env() {
      return state.env;
    },
    get canReplaceProcess() {
      return state.canReplaceProcess;
    },
    async runCommand(executable, args, options) {
      state.commands.push({ executable, args: [...args], env: { ...options?.env } });
      return state.answer(executable, args);
    },
    async readText(path) {
      const own = /^\/proc\/(\d+)\/cgroup$/.exec(path);
      if (own) return state.processes.get(Number(own[1]))?.cgroup ?? null;
      return state.files.get(path) ?? null;
    },
    async directoryOwner(path) {
      return state.directories.get(path) ?? null;
    },
    async observeInstance(pid): Promise<ProcessInstanceObservation> {
      const instance = state.processes.get(pid)?.instance;
      return instance === undefined
        ? { state: 'unavailable', cause: new Error(`no instance for ${pid}`) }
        : { state: 'observed', instance };
    },
    async liveness(pid) {
      const process = state.processes.get(pid);
      return process === undefined || process.ended === true ? 'gone' : 'alive';
    },
    async lineage(pid) {
      return state.processes.get(pid)?.lineage ?? null;
    },
  };
  return { host, state };
}
