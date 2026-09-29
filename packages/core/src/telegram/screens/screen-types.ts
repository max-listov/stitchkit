/**
 * The types a screen is declared with, and the loose shape the runtime drives.
 *
 * A declared screen is typed end to end — its params come from its path (or a
 * params schema), its data from its loads, its action buttons from its
 * actions — and the runtime sees none of that. It holds a
 * {@link ScreenDefinition}: closures over the typed declaration that take raw,
 * untrusted params and input, validate them, and only then call the
 * application. The one crossing from raw to typed is the params schema, which
 * runs on every resolution.
 */
import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { ActionValue } from './callback-codec';
import type { TelegramText } from './html';
import type { ScreenOutcome, ScreenOutcomeBuilders } from './outcome';
import type { ScreenPath } from './path';
import type { ButtonLabel, ScreenButton, ScreenViewResult } from './view';

/** A param value after its schema: text, or a number a schema produced. */
export type ScreenParamValue = string | number;
export type ScreenParams = Readonly<Record<string, ScreenParamValue>>;

declare const noInput: unique symbol;
/** An action declared without an input schema. */
export type NoActionInput = typeof noInput;

/** Action name → what its button takes (`NoActionInput` when nothing). */
export type ScreenActions = Readonly<Record<string, unknown>>;

export type MaybePromise<TValue> = TValue | Promise<TValue>;

/** What a handler may answer with; nothing — a body with no `return` — is `stay()`. */
export type ScreenHandlerResult = MaybePromise<ScreenOutcome | undefined> | MaybePromise<void>;

export interface ScreenLoadContext<C extends Context, P extends ScreenParams, D>
  extends ScreenOutcomeBuilders {
  /** The grammY context of the update being answered. */
  readonly ctx: C;
  /** Params from the button that was pressed — user input, validated by the params schema. */
  readonly params: P;
  /** What the enclosing group loaded; `undefined` outside a group. */
  readonly data: D;
}

export interface ScreenActionContext<C extends Context, P extends ScreenParams, D, I>
  extends ScreenOutcomeBuilders {
  readonly ctx: C;
  readonly params: P;
  /** What this screen's loads returned for this press. */
  readonly data: D;
  /** The button's input, parsed by the action's schema. */
  readonly input: I;
}

/** An outcome after a message: there is no press to answer, so no toast. */
export type ScreenInputOutcomeBuilders = Omit<ScreenOutcomeBuilders, 'toast'>;

export interface ScreenInputContext<C extends Context, P extends ScreenParams, D>
  extends ScreenInputOutcomeBuilders {
  readonly ctx: C;
  readonly params: P;
  readonly data: D;
  /** The message as Telegram sent it. It is never stored. */
  readonly message: Message;
  /** Its text, or its caption, or `''`. */
  readonly text: string;
  /** Show a "working on it" message; it is removed when the handler ends, however it ends. */
  pending(content: TelegramText): Promise<void>;
}

/** The action buttons of a screen, one factory per declared action. */
export type ScreenActionButtons<A extends ScreenActions> = {
  readonly [K in keyof A]: A[K] extends NoActionInput
    ? (label: ButtonLabel) => ScreenButton
    : (label: ButtonLabel, input: A[K]) => ScreenButton;
};

export interface ScreenViewContext<
  C extends Context,
  P extends ScreenParams,
  D,
  A extends ScreenActions,
> {
  readonly ctx: C;
  readonly params: P;
  readonly data: D;
  readonly act: ScreenActionButtons<A>;
}

/** Message kinds a screen can take as input. */
export type ScreenInputKind =
  | 'text'
  | 'rich'
  | 'photo'
  | 'video'
  | 'animation'
  | 'document'
  | 'audio'
  | 'voice'
  | 'video_note'
  | 'sticker'
  | 'location'
  | 'contact';

export interface ScreenInputOptions {
  /** Leave the user's message in the chat. Default: removed before the handler runs. */
  readonly keepMessage?: boolean;
}

/** Why raw params or input did not become a screen. */
export type ScreenRefusal = 'invalid-params' | 'unknown-action' | 'invalid-input';

/** A screen resolved for one update: params parsed, data loaded. */
export interface ResolvedScreen {
  readonly params: ScreenParams;
  render(): ScreenViewResult;
  runAction(
    action: string,
    input: Readonly<Record<string, ActionValue>> | undefined,
  ): Promise<ScreenOutcome | undefined | ScreenRefusal>;
  input(kind: ScreenInputKind): ResolvedScreenInput | undefined;
}

export interface ResolvedScreenInput {
  readonly keepMessage: boolean;
  handle(
    message: Message,
    pending: (content: TelegramText) => Promise<void>,
  ): Promise<ScreenOutcome | undefined>;
}

/** The loose screen the runtime drives. Methods, so a narrower context still assigns. */
export interface ScreenDefinition<C extends Context> {
  readonly path: ScreenPath;
  readonly id: string;
  readonly explicitId: boolean;
  /** Some load — the screen's own or a group's — runs before it: its params are checked. */
  readonly guarded: boolean;
  readonly actions: readonly string[];
  readonly inputKinds: readonly ScreenInputKind[];
  /** The screen takes this kind and leaves the user's message in the chat. */
  keepsInput(kind: ScreenInputKind): boolean;
  /** The params pass the schemas — no load runs. */
  acceptsParams(params: Readonly<Record<string, ActionValue>>): boolean;
  resolve(
    ctx: C,
    params: Readonly<Record<string, ActionValue>>,
  ): Promise<ResolvedScreen | ScreenOutcome | 'invalid-params'>;
}

/** A declared screen. The type parameters exist for the declaration's callers. */
export class TelegramScreen<
  C extends Context,
  P extends ScreenParams,
  D,
  A extends ScreenActions,
> {
  declare readonly '~types'?: {
    readonly ctx: C;
    readonly params: P;
    readonly data: D;
    readonly actions: A;
  };

  constructor(readonly definition: ScreenDefinition<C>) {}

  get path(): string {
    return this.definition.path.path;
  }
}

/** Any declared screen, whatever its context, params, data and actions. */
export type AnyTelegramScreen = TelegramScreen<Context, ScreenParams, unknown, ScreenActions>;

/**
 * The params argument of a link or a `go`: required exactly when the path has
 * params, and refused when it has none — a param the path does not name would
 * make the button unreadable.
 */
export type ScreenLinkArgs<TScreen> = TScreen extends {
  readonly '~types'?: { readonly params: infer P };
}
  ? keyof P extends never
    ? [params?: { readonly [name: string]: never }]
    : [params: P]
  : never;
