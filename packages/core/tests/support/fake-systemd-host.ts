import { basename, dirname } from 'node:path';
import type {
  SystemdCommandResult,
  SystemdHostAdapter,
} from '../../src/entrypoints/service-host';
import { canonicalHostPath } from '../../src/service-host/host-adapter';

/**
 * Stand a symbolic link at `path` pointing at `target`, listed in its directory and that
 * directory in its parent — what `systemctl enable` makes in `<dir>/<target>.wants/`.
 */
export function linkOnFakeHost(state: FakeSystemdState, path: string, target: string): void {
  state.links.set(path, target);
  for (const [dir, name] of [
    [dirname(path), basename(path)],
    [dirname(dirname(path)), basename(dirname(path))],
  ] as const) {
    const entries = state.dirs.get(dir) ?? [];
    if (!entries.includes(name)) state.dirs.set(dir, [...entries, name]);
  }
}

/** What a fake systemd host holds: unit files, drop-in listings, the commands it ran, a clock. */
export interface FakeSystemdState {
  files: Map<string, string>;
  /** The mode each file was written with; a file set directly has `0o644`. */
  modes: Map<string, number>;
  /** A symbolic link standing at a path, with its target. */
  links: Map<string, string>;
  dirs: Map<string, string[]>;
  commands: Array<{ executable: string; args: readonly string[] }>;
  timeMs: number;
  handler: (executable: string, args: readonly string[]) => SystemdCommandResult;
}

/** A systemd host adapter over memory: `handler` answers every command it is asked to run. */
export function createFakeSystemdAdapter(
  handler: (
    executable: string,
    args: readonly string[],
    state: FakeSystemdState,
  ) => SystemdCommandResult,
): { adapter: SystemdHostAdapter; state: FakeSystemdState } {
  const state: FakeSystemdState = {
    files: new Map(),
    modes: new Map(),
    links: new Map(),
    dirs: new Map(),
    commands: [],
    timeMs: 1_000,
    handler: (executable, args) => handler(executable, args, state),
  };
  const adapter: SystemdHostAdapter = {
    async runCommand(executable, args) {
      state.commands.push({ executable, args: [...args] });
      return state.handler(executable, args);
    },
    async readFile(path) {
      const value = state.files.get(path);
      return value === undefined ? null : new TextEncoder().encode(value);
    },
    async writeFileAtomic(path, content, options) {
      state.modes.set(path, options?.mode ?? 0o644);
      state.files.set(
        path,
        typeof content === 'string' ? content : new TextDecoder().decode(content),
      );
    },
    async removeFile(path) {
      state.files.delete(path);
      if (state.links.delete(path)) {
        const dir = dirname(path);
        state.dirs.set(
          dir,
          (state.dirs.get(dir) ?? []).filter((name) => name !== basename(path)),
        );
      }
    },
    // Real resolution: a fake path whose directory does not exist is left as it is.
    canonicalPath: canonicalHostPath,
    async inspectPath(path) {
      const target = state.links.get(path);
      if (target !== undefined) return { kind: 'symlink', target };
      if (!state.files.has(path)) return { kind: 'missing' };
      return { kind: 'file', mode: state.modes.get(path) ?? 0o644 };
    },
    async listDir(path) {
      return state.dirs.get(path) ?? null;
    },
    now() {
      return state.timeMs;
    },
    async sleep(ms) {
      state.timeMs += ms;
    },
  };
  return { adapter, state };
}

/** `systemctl show` for a name systemd finds nowhere. */
export const NOT_FOUND_SHOW =
  'LoadState=not-found\nFragmentPath=\nDropInPaths=\nActiveState=inactive\nSubState=dead\nMainPID=0\n';

/**
 * `systemctl show` as a host answers it: a unit file that stands at `unitPath` is loaded
 * from there, and a name with no file is not found.
 */
export function showFor(
  state: FakeSystemdState,
  unitPath: string,
  activeState = 'active',
  unitFileState = 'disabled',
): string {
  if (!state.files.has(unitPath)) return NOT_FOUND_SHOW;
  return `LoadState=loaded\nFragmentPath=${unitPath}\nDropInPaths=\nActiveState=${activeState}\nSubState=running\nMainPID=0\nUnitFileState=${unitFileState}\n`;
}
