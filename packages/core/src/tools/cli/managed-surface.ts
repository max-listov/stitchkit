import type { ZodObject, z } from 'zod';
import { type ToolResult, toolErrorFromResult, toolResultFromError } from '../execute';
import type { MountableTool } from '../mount';
import { buildCliSurface } from './invoke';
import type { CliCommandPresentation } from './policy';
import { assertCommandShape, type CliSession } from './session';

/**
 * The managed surface, or the reason there isn't one.
 *
 * A CLI whose command set comes from a running server cannot list those
 * commands when the server is unreachable — but it still HAS native commands,
 * and it knows why the rest are missing. Letting the rejection escape printed
 * neither, and answering `Unknown command` would be a lie: the name is not
 * unknown, it is unresolvable. Only identity resolution is caught here; a
 * configuration fault in the surface itself is still a startup error.
 */
export type ManagedSurface<TAuth> =
  | {
      resolved: true;
      auth: Awaited<TAuth> | undefined;
      help: Map<string, CliCommandPresentation>;
      tools: Map<string, MountableTool>;
    }
  | {
      resolved: false;
      failure: Extract<ToolResult, { ok: false }>;
      reason: string;
      help: Map<string, CliCommandPresentation>;
    };

export async function buildManagedSurface<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  typedGlobals: z.output<TGlobals>,
  forExecution: boolean,
): Promise<ManagedSurface<TAuth>> {
  const { config, nativeHelp, applicationGlobalNames } = session;
  let authPromise: Promise<Awaited<TAuth> | undefined> | undefined;
  const resolveIdentity = (): Promise<Awaited<TAuth> | undefined> => {
    // An async IIFE, not `Promise.resolve(...)`: a `resolveAuth` that throws
    // SYNCHRONOUSLY would otherwise escape before the memo is assigned, and the
    // next caller would run it a second time.
    authPromise ??= (async (): Promise<Awaited<TAuth> | undefined> =>
      config.resolveAuth ? await config.resolveAuth(typedGlobals) : await config.auth)();
    return authPromise;
  };
  const dynamicSurface =
    typeof config.services === 'function' || typeof config.runtimeTools === 'function';
  let auth: Awaited<TAuth> | undefined;
  if (dynamicSurface || forExecution) {
    try {
      auth = await resolveIdentity();
    } catch (error) {
      const failure = toolResultFromError(error);
      const normalized = toolErrorFromResult(failure);
      return {
        resolved: false,
        failure,
        reason: `${normalized.code}: ${normalized.message}`,
        help: new Map(nativeHelp),
      };
    }
  }
  // The same walk the in-process invoker does, from the same function: if the
  // two ever built the surface separately, a line of a stream and the same
  // call typed at a prompt could resolve to different tools.
  const { tools, help } = buildCliSurface(
    config,
    auth,
    nativeHelp,
    applicationGlobalNames,
    assertCommandShape,
  );
  return { resolved: true, auth, help, tools };
}
