/** A failing observer must not replace the call it observes. */
export async function observed(hook: string, call: () => unknown): Promise<void> {
  try {
    await call();
  } catch (hookError) {
    try {
      console.error(`[stitchkit] ${hook} hook failed:`, hookError);
    } catch {
      // Even a throwing console must not reach the observed call.
    }
  }
}
