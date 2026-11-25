import type { AgentRuntimeRunContext } from './runtime';

/**
 * Run contexts this process's runtimes handed to `tools()`.
 *
 * The built-in tools act for a conversation, and the address of a live
 * conversation is authority. A factory that took a free `conversationId` let
 * the host name any conversation, unrelated to the run the tools serve; one
 * that takes the run context reads the conversation from the run itself. The
 * set closes the remaining gap: an object built by hand to look like a run
 * context is not one, and the factory says so instead of acting for whatever
 * conversation it names.
 */
const issued = new WeakSet<object>();

export function issueRunContext<CONTEXT extends object>(context: CONTEXT): CONTEXT {
  issued.add(context);
  return context;
}

/** The conversation a run context's tools act for; refuses a context no runtime issued. */
export function conversationOfRun(
  run: AgentRuntimeRunContext<unknown>,
  factory: string,
): string {
  if (!issued.has(run)) {
    throw new TypeError(
      `${factory} takes the run context the runtime passes to tools(); this one was not issued by a runtime`,
    );
  }
  return run.run.conversationId;
}
