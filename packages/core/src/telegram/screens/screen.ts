/**
 * Declaring screens: `tg.screen(path).load(…).action(…).on(…).view(…)`, and
 * groups that share a path, params and a load.
 *
 * Every step narrows the types the next one sees, the way a Hono route or an
 * Elysia handler does: the path names the params, `load` names the data, each
 * `action` adds a typed button factory to `act`. `load` comes first or not at
 * all — actions and input run after it and read what it returned — and `view`
 * ends the declaration.
 *
 * A group is where access is checked once for everything under it:
 * `tg.group('/bot/:botId', { params }).load(ownedBot)` runs its params schema and
 * its load before every screen of the group — before its load, its actions and
 * its input — and hands the screen what it loaded as `c.data`. Params arrive
 * from a button, so they are user input; a screen with params and no load
 * anywhere above it is refused when the bot is composed.
 *
 * What the runtime receives is a {@link ScreenDefinition}: closures over the
 * typed declaration that take raw params and raw button input, validate them,
 * and only then call the application's functions.
 */
import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { z } from 'zod';
import { joinRoutePath } from '../../internal/route-pattern';
import { isRecord, transportResult } from '../../internal/typed';
import { type ActionValue, assertCallbackName } from './callback-codec';
import type { TelegramText } from './html';
import { outcomeBuilders, ScreenOutcome } from './outcome';
import { derivedScreenId, parseScreenPath, type ScreenPathParams } from './path';
import type {
  MaybePromise,
  NoActionInput,
  ResolvedScreen,
  ResolvedScreenInput,
  ScreenActionButtons,
  ScreenActionContext,
  ScreenActions,
  ScreenHandlerResult,
  ScreenInputContext,
  ScreenInputKind,
  ScreenInputOptions,
  ScreenLoadContext,
  ScreenParams,
  ScreenViewContext,
} from './screen-types';
import { TelegramScreen } from './screen-types';
import { type ButtonLabel, ScreenButton, type ScreenViewResult } from './view';

/** A schema for an action's input: an object whose fields a button can carry. */
export type ActionInputSchema = z.ZodType<
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, ActionValue | undefined>>
>;

/** A schema for the params a path segment adds: one field per `:name`. */
export type ParamsSchemaFor<TPath extends string> = z.ZodType<
  { readonly [K in keyof ScreenPathParams<TPath>]: string | number },
  { readonly [K in keyof ScreenPathParams<TPath>]: unknown }
>;

/**
 * `S` when it accepts what it produces, else `never`. A button carries the
 * parsed params, and the schema parses them again when it is pressed: a
 * transform whose output its own input refuses — `z.string().transform(Number)`
 * — would make every link to the screen stale. `z.coerce.number()` accepts it.
 */
export type AcceptsOwnOutput<S> =
  S extends z.ZodType<infer O, infer I> ? ([O] extends [I] ? S : never) : never;

export interface ScopeOptions<TSchema> {
  /** Validates (and may coerce) the params this path adds — they come from a button. */
  readonly params?: TSchema;
}

export interface ScreenOptions<TSchema> extends ScopeOptions<TSchema> {
  /**
   * The id buttons carry instead of the path. Set it to keep buttons already
   * sent working after the path is renamed. Default: derived from the path.
   */
  readonly id?: string;
}

/** What a scope — the root, or a group — hands the screens declared in it. */
export interface ScopeCore<C extends Context, P extends ScreenParams, D> {
  readonly prefix: string;
  readonly paramNames: readonly string[];
  readonly parseParams: (raw: Readonly<Record<string, ActionValue>>) => P | undefined;
  readonly load: (ctx: C, params: P) => Promise<D | ScreenOutcome>;
  readonly guarded: boolean;
}

interface HandlerBase<C extends Context, P extends ScreenParams, D> {
  readonly ctx: C;
  readonly params: P;
  readonly data: D;
}

type ActionEntry<C extends Context, P extends ScreenParams, D> = (
  base: HandlerBase<C, P, D>,
  input: Readonly<Record<string, ActionValue>> | undefined,
) => Promise<ScreenOutcome | undefined | 'invalid-input'>;

type InputEntry<C extends Context, P extends ScreenParams, D> = {
  readonly keepMessage: boolean;
  readonly handler: (c: ScreenInputContext<C, P, D>) => ScreenHandlerResult;
};

function outcomeOf(result: unknown): ScreenOutcome | undefined {
  return ScreenOutcome.is(result) ? result : undefined;
}

function isActionInput(
  value: unknown,
): value is Readonly<Record<string, ActionValue | undefined>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (field) =>
        field === undefined ||
        field === null ||
        typeof field === 'string' ||
        typeof field === 'boolean' ||
        (typeof field === 'number' && Number.isFinite(field)),
    )
  );
}

/**
 * `value` is known not to be an outcome — `ScreenOutcome.is` just said so —
 * but a brand check does not narrow a generic type parameter.
 */
function excludeOutcome<R>(value: R): Exclude<R, ScreenOutcome> {
  return transportResult<Exclude<R, ScreenOutcome>>(value);
}

function chainLoad<C extends Context, P extends ScreenParams, D, R>(
  load: (ctx: C, params: P) => Promise<D | ScreenOutcome>,
  fetch: (c: ScreenLoadContext<C, P, D>) => MaybePromise<R>,
): (ctx: C, params: P) => Promise<Exclude<R, ScreenOutcome> | ScreenOutcome> {
  return async (ctx, params) => {
    const data = await load(ctx, params);
    if (ScreenOutcome.is(data)) return data;
    const value = await fetch({ ctx, params, data, ...outcomeBuilders() });
    return ScreenOutcome.is(value) ? value : excludeOutcome(value);
  };
}

/**
 * The params a path adds to its scope's, validated by the declared schema or
 * as strings. The default schema is built from the path, so its output is the
 * path's params by construction — TypeScript cannot see through that.
 */
function ownParamsParser<O extends ScreenParams>(
  path: string,
  inherited: readonly string[],
  schema: z.ZodType<O> | undefined,
): {
  names: readonly string[];
  parse: (raw: Readonly<Record<string, ActionValue>>) => O | undefined;
} {
  const names = parseScreenPath(path).params.filter((name) => !inherited.includes(name));
  if (schema) {
    const shape =
      z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }).properties ?? {};
    for (const name of names) {
      if (!(name in shape)) {
        throw new Error(
          `[stitchkit] telegram screens: the params schema of "${path}" is missing "${name}".`,
        );
      }
    }
  }
  const effective =
    schema ??
    transportResult<z.ZodType<O>>(
      z.object(Object.fromEntries(names.map((name) => [name, z.string()]))).strict(),
    );
  return {
    names,
    parse: (raw) => {
      const own: Record<string, ActionValue> = {};
      for (const name of names) {
        const value = raw[name];
        if (value !== undefined) own[name] = value;
      }
      const parsed = effective.safeParse(own);
      return parsed.success ? parsed.data : undefined;
    },
  };
}

function scopeFor<C extends Context, P extends ScreenParams, D, O extends ScreenParams>(
  scope: ScopeCore<C, P, D>,
  sub: string,
  schema: z.ZodType<O> | undefined,
): ScopeCore<C, P & O, D> {
  const prefix = joinRoutePath(scope.prefix, sub);
  const own = ownParamsParser<O>(prefix, scope.paramNames, schema);
  return {
    prefix,
    paramNames: [...scope.paramNames, ...own.names],
    parseParams: (raw) => {
      const inherited = scope.parseParams(raw);
      const added = own.parse(raw);
      return inherited && added ? { ...inherited, ...added } : undefined;
    },
    load: scope.load,
    // A load above checked the params it saw; a param added below it is
    // unchecked until a load of its own runs.
    guarded: scope.guarded && own.names.length === 0,
  };
}

/** A screen after `load` (or without one): actions, input and the view. */
export class ScreenBodyBuilder<
  C extends Context,
  P extends ScreenParams,
  D,
  A extends ScreenActions,
> {
  constructor(
    protected readonly core: ScopeCore<C, P, D>,
    protected readonly id: { readonly value: string; readonly explicit: boolean },
    protected readonly actions: ReadonlyMap<string, ActionEntry<C, P, D>>,
    protected readonly inputs: ReadonlyMap<ScreenInputKind, InputEntry<C, P, D>>,
  ) {}

  /** A button handler. Its button is `act.<name>(label)`. */
  action<N extends string>(
    name: N,
    handler: (c: ScreenActionContext<C, P, D, undefined>) => ScreenHandlerResult,
  ): ScreenBodyBuilder<C, P, D, A & { readonly [K in N]: NoActionInput }>;
  /** A button handler with typed input. Its button is `act.<name>(label, input)`. */
  action<N extends string, S extends ActionInputSchema>(
    name: N,
    schema: S,
    handler: (c: ScreenActionContext<C, P, D, z.output<S>>) => ScreenHandlerResult,
  ): ScreenBodyBuilder<C, P, D, A & { readonly [K in N]: z.input<S> }>;
  action<N extends string, S extends ActionInputSchema>(
    name: N,
    ...args:
      | [handler: (c: ScreenActionContext<C, P, D, undefined>) => ScreenHandlerResult]
      | [
          schema: S,
          handler: (c: ScreenActionContext<C, P, D, z.output<S>>) => ScreenHandlerResult,
        ]
  ): unknown {
    assertCallbackName('action', name);
    if (this.actions.has(name)) {
      throw new Error(
        `[stitchkit] telegram screens: "${this.core.prefix}" declares action "${name}" twice.`,
      );
    }
    let entry: ActionEntry<C, P, D>;
    if (args.length === 1) {
      const [handler] = args;
      entry = async (base) =>
        outcomeOf(await handler({ ...base, ...outcomeBuilders(), input: undefined }));
    } else {
      const [schema, handler] = args;
      entry = async (base, raw) => {
        const parsed = schema.safeParse(raw ?? {});
        if (!parsed.success) return 'invalid-input';
        return outcomeOf(await handler({ ...base, ...outcomeBuilders(), input: parsed.data }));
      };
    }
    return new ScreenBodyBuilder(
      this.core,
      this.id,
      new Map([...this.actions, [name, entry]]),
      this.inputs,
    );
  }

  /**
   * Messages of these kinds, while this screen is shown. Other kinds, and
   * commands, go to the next handler.
   */
  on(
    kinds: ScreenInputKind | readonly ScreenInputKind[],
    handler: (c: ScreenInputContext<C, P, D>) => ScreenHandlerResult,
    options: ScreenInputOptions = {},
  ): ScreenBodyBuilder<C, P, D, A> {
    const list: readonly ScreenInputKind[] = typeof kinds === 'string' ? [kinds] : kinds;
    if (list.length === 0) {
      throw new Error(
        `[stitchkit] telegram screens: "${this.core.prefix}" takes input of no kind.`,
      );
    }
    const inputs = new Map(this.inputs);
    for (const kind of list) {
      if (inputs.has(kind)) {
        throw new Error(
          `[stitchkit] telegram screens: "${this.core.prefix}" takes "${kind}" input twice.`,
        );
      }
      inputs.set(kind, { keepMessage: options.keepMessage ?? false, handler });
    }
    return new ScreenBodyBuilder(this.core, this.id, this.actions, inputs);
  }

  /** What the chat shows. Ends the declaration. */
  view(
    render: (c: ScreenViewContext<C, P, D, A>) => ScreenViewResult,
  ): TelegramScreen<C, P, D, A> {
    const { core, id, actions, inputs } = this;
    const screen: TelegramScreen<C, P, D, A> = new TelegramScreen({
      path: parseScreenPath(core.prefix),
      id: id.value,
      explicitId: id.explicit,
      guarded: core.guarded,
      actions: [...actions.keys()],
      inputKinds: [...inputs.keys()],
      keepsInput: (kind) => inputs.get(kind)?.keepMessage ?? false,
      acceptsParams: (raw) => core.parseParams(raw) !== undefined,
      resolve: async (ctx, raw) => {
        const params = core.parseParams(raw);
        if (params === undefined) return 'invalid-params';
        const data = await core.load(ctx, params);
        if (ScreenOutcome.is(data)) return data;
        return resolvedScreen(screen, { ctx, params, data }, render, actions, inputs);
      },
    });
    return screen;
  }
}

function resolvedScreen<C extends Context, P extends ScreenParams, D, A extends ScreenActions>(
  screen: TelegramScreen<C, P, D, A>,
  base: HandlerBase<C, P, D>,
  render: (c: ScreenViewContext<C, P, D, A>) => ScreenViewResult,
  actions: ReadonlyMap<string, ActionEntry<C, P, D>>,
  inputs: ReadonlyMap<ScreenInputKind, InputEntry<C, P, D>>,
): ResolvedScreen {
  const buttons: Record<string, (label: ButtonLabel, input?: unknown) => ScreenButton> = {};
  for (const action of actions.keys()) {
    buttons[action] = (label, input) => {
      if (input !== undefined && !isActionInput(input)) {
        throw new Error(
          `[stitchkit] telegram screens: the input of action "${action}" must be a flat object of strings, finite numbers, booleans and null.`,
        );
      }
      return new ScreenButton(label, {
        kind: 'action',
        screen,
        params: base.params,
        action,
        input,
      });
    };
  }
  // One factory per declared action name — exactly the mapped type the
  // declaration promised; TypeScript cannot follow a key-wise construction.
  const act = transportResult<ScreenActionButtons<A>>(buttons);
  return {
    params: base.params,
    render: () => render({ ...base, act }),
    runAction: async (action, raw) => {
      const entry = actions.get(action);
      return entry ? entry(base, raw) : 'unknown-action';
    },
    input: (kind): ResolvedScreenInput | undefined => {
      const entry = inputs.get(kind);
      if (!entry) return undefined;
      return {
        keepMessage: entry.keepMessage,
        handle: async (
          message: Message,
          pending: (content: TelegramText) => Promise<void>,
        ) => {
          const { toast: _toast, ...builders } = outcomeBuilders();
          const text = message.text ?? message.caption ?? '';
          return outcomeOf(
            await entry.handler({ ...base, ...builders, message, text, pending }),
          );
        },
      };
    },
  };
}

/** A screen before `load`: it may still load data. */
export class ScreenBuilder<
  C extends Context,
  P extends ScreenParams,
  D,
> extends ScreenBodyBuilder<C, P, D, Record<never, never>> {
  /**
   * The data this screen shows and its actions act on. Runs before every show,
   * every action and every input, after the group's load, whose data it reads
   * as `c.data`. Return an outcome instead of data to go somewhere else.
   */
  load<R>(
    fetch: (c: ScreenLoadContext<C, P, D>) => MaybePromise<R>,
  ): ScreenBodyBuilder<C, P, Exclude<R, ScreenOutcome>, Record<never, never>> {
    return new ScreenBodyBuilder(
      { ...this.core, load: chainLoad(this.core.load, fetch), guarded: true },
      this.id,
      new Map(),
      new Map(),
    );
  }
}

/** Where screens are declared: the root, or a group of them. */
export class ScreenScope<C extends Context, P extends ScreenParams, D> {
  constructor(protected readonly core: ScopeCore<C, P, D>) {}

  /** A screen at `path`, relative to this scope. */
  screen<TPath extends string>(
    path: TPath,
    options?: ScreenOptions<undefined>,
  ): ScreenBuilder<C, P & ScreenPathParams<TPath>, D>;
  screen<TPath extends string, S extends ParamsSchemaFor<TPath>>(
    path: TPath,
    options: ScreenOptions<S> & { readonly params: S & AcceptsOwnOutput<S> },
  ): ScreenBuilder<C, P & z.output<S>, D>;
  screen<O extends ScreenParams>(
    path: string,
    options: ScreenOptions<z.ZodType<O> | undefined> = {},
  ): ScreenBuilder<C, P & O, D> {
    const core = scopeFor<C, P, D, O>(this.core, path, options.params);
    const id = options.id ?? derivedScreenId(core.prefix);
    assertCallbackName('screen id', id);
    return new ScreenBuilder(
      core,
      { value: id, explicit: options.id !== undefined },
      new Map(),
      new Map(),
    );
  }

  /** Screens that share a path prefix, its params and — once `load` is called — a load. */
  group<TPath extends string>(
    path: TPath,
    options?: ScopeOptions<undefined>,
  ): ScreenGroupBuilder<C, P & ScreenPathParams<TPath>, D>;
  group<TPath extends string, S extends ParamsSchemaFor<TPath>>(
    path: TPath,
    options: ScopeOptions<S> & { readonly params: S & AcceptsOwnOutput<S> },
  ): ScreenGroupBuilder<C, P & z.output<S>, D>;
  group<O extends ScreenParams>(
    path: string,
    options: ScopeOptions<z.ZodType<O> | undefined> = {},
  ): ScreenGroupBuilder<C, P & O, D> {
    return new ScreenGroupBuilder(scopeFor<C, P, D, O>(this.core, path, options.params));
  }
}

/** A group before `load`. */
export class ScreenGroupBuilder<
  C extends Context,
  P extends ScreenParams,
  D,
> extends ScreenScope<C, P, D> {
  /**
   * Runs before every screen of the group — before its load, its actions and
   * its input. The place to check that the params are the user's to use.
   */
  load<R>(
    fetch: (c: ScreenLoadContext<C, P, D>) => MaybePromise<R>,
  ): ScreenScope<C, P, Exclude<R, ScreenOutcome>> {
    return new ScreenScope({
      ...this.core,
      load: chainLoad(this.core.load, fetch),
      guarded: true,
    });
  }
}

/** The root: no prefix, no params, nothing loaded. */
export function rootScopeCore<C extends Context>(): ScopeCore<
  C,
  Record<never, never>,
  undefined
> {
  return {
    prefix: '/',
    paramNames: [],
    parseParams: () => ({}),
    load: async () => undefined,
    guarded: false,
  };
}
