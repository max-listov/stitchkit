import type { ApplicationHandle } from 'stitchkit/application';
import type { Log } from './log';

/**
 * Something outside the bot that follows its application state — a deployment
 * platform publishing readiness for its supervisor, a metrics exporter. It
 * starts before the application and closes after it.
 */
export interface RuntimeBinding {
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The one place such a binding is attached. The template binds nothing: a
 * platform's own package supplies the binding, for example
 *
 *   return [bindReleasedApplication(app, { onError: (error) => log.error('…', { error }) })];
 *
 * and nothing else in the bot changes.
 */
export function runtimeBindings(_app: ApplicationHandle, _log: Log): RuntimeBinding[] {
  return [];
}
