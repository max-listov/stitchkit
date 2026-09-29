/**
 * The screens a bot declared, by id and by object, with the tree between them.
 *
 * Checked once, when the bot is composed: two screens with one path or one id
 * would make a button mean two things, and a screen whose id collides with
 * another's derived id would do so silently on the next release.
 */
import type { Context } from 'grammy';
import { isAncestorPath } from './path';
import type { ButtonResolver } from './render';
import type {
  AnyTelegramScreen,
  ScreenActions,
  ScreenDefinition,
  ScreenParams,
  TelegramScreen,
} from './screen-types';

export type DeclaredScreen<C extends Context> = TelegramScreen<
  C,
  ScreenParams,
  unknown,
  ScreenActions
>;

export interface RegisteredScreen<C extends Context> {
  readonly screen: DeclaredScreen<C>;
  readonly definition: ScreenDefinition<C>;
  readonly parent: RegisteredScreen<C> | undefined;
}

export interface ScreenRegistry<C extends Context> {
  byId(id: string): RegisteredScreen<C> | undefined;
  entryOf(screen: AnyTelegramScreen): RegisteredScreen<C>;
  resolverFor(entry: RegisteredScreen<C>): ButtonResolver;
}

export function createScreenRegistry<C extends Context>(
  screens: readonly DeclaredScreen<C>[],
): ScreenRegistry<C> {
  if (screens.length === 0) {
    throw new Error('[stitchkit] telegram screens: declare at least one screen.');
  }
  const byPath = new Map<string, DeclaredScreen<C>>();
  const byId = new Map<string, DeclaredScreen<C>>();
  for (const screen of screens) {
    const { path, id } = screen.definition;
    const samePath = byPath.get(path.path);
    if (samePath) {
      throw new Error(
        `[stitchkit] telegram screens: two screens are declared at "${path.path}".`,
      );
    }
    const sameId = byId.get(id);
    if (sameId) {
      throw new Error(
        `[stitchkit] telegram screens: "${path.path}" and "${sameId.definition.path.path}" share the id "${id}"; give one of them an explicit id.`,
      );
    }
    if (path.params.length > 0 && !screen.definition.guarded) {
      throw new Error(
        `[stitchkit] telegram screens: "${path.path}" takes params but nothing loads before it. Params arrive from a button and are user input: give the screen or its group a load that checks them.`,
      );
    }
    byPath.set(path.path, screen);
    byId.set(id, screen);
  }

  const entries = new Map<object, RegisteredScreen<C>>();
  const register = (screen: DeclaredScreen<C>): RegisteredScreen<C> => {
    const known = entries.get(screen);
    if (known) return known;
    const own = screen.definition.path;
    let parentScreen: DeclaredScreen<C> | undefined;
    for (const candidate of screens) {
      const path = candidate.definition.path;
      if (!isAncestorPath(path, own)) continue;
      if (
        !parentScreen ||
        path.segments.length > parentScreen.definition.path.segments.length
      ) {
        parentScreen = candidate;
      }
    }
    const entry: RegisteredScreen<C> = {
      screen,
      definition: screen.definition,
      parent: parentScreen ? register(parentScreen) : undefined,
    };
    entries.set(screen, entry);
    return entry;
  };
  for (const screen of screens) register(screen);

  const entryOf = (screen: AnyTelegramScreen): RegisteredScreen<C> => {
    const entry = entries.get(screen);
    if (!entry) {
      throw new Error(
        `[stitchkit] telegram screens: "${screen.path}" is linked to but not among the declared screens.`,
      );
    }
    return entry;
  };

  return {
    byId: (id) => {
      const screen = byId.get(id);
      return screen ? entries.get(screen) : undefined;
    },
    entryOf,
    resolverFor: (entry) => ({
      path: entry.definition.path.path,
      parent: entry.parent
        ? { id: entry.parent.definition.id, params: entry.parent.definition.path.params }
        : undefined,
      addressOf: (screen) => {
        const target = entryOf(screen).definition;
        return { id: target.id, params: target.path.params };
      },
    }),
  };
}
