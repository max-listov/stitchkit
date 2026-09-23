/**
 * The types a client is inferred with: every endpoint's arguments and output, multipart files, and the scoped and URL-building variants.
 */
import type { ZodType, z } from 'zod';
import type { PathParams } from '../internal/route-pattern';
import type { EndpointDef, Transport } from './define';

// ─── Type Inference (for createClient) ──────────────────

type Prop<T, K extends string> = K extends keyof T ? T[K] : undefined;

// Endpoint args are what the CLIENT sends → the schema INPUT type (pre-parse).
// `.default()` / `.coerce` / `.transform()` make input and output differ: a
// `.default()` field is required in the parsed output but optional in the
// input. The typed client must use the input type, otherwise every caller is
// forced to pass server-defaulted fields. The handler's `ctx.input` keeps the
// output (post-parse) type — see `EndpointOutput`.
//
// Empty case is `unknown` (not `Record<string, never>`): `unknown & X = X`,
// whereas `Record<string, never>` carries an index signature that poisons
// every intersected field to `never`.
type InferInput<S> = S extends ZodType ? z.input<S> : unknown;

/**
 * A platform file descriptor accepted by the typed client's multipart methods
 * where a file is not a `Blob`. React Native / Expo represent a file as
 * `{ uri, name, type }` and their `FormData.append` streams it from disk by
 * `uri`; reading it into a `Blob` first (`fetch(uri).blob()`) would load the
 * whole media into memory. The web / Bun path still uses `Blob`.
 */
export interface FileDescriptor {
  /** Local file URI the platform streams from (e.g. `file:///…`). */
  uri: string;
  /** File name for the multipart part. */
  name: string;
  /** MIME type for the multipart part. */
  type: string;
}

/**
 * What a `multipart` endpoint's file field accepts on the typed client — a
 * `Blob` (web / Bun) or a platform {@link FileDescriptor} (React Native / Expo).
 * Exported so a consumer can type its own upload helpers without a cast.
 */
export type MultipartFile = Blob | FileDescriptor;

/** A single named file policy within a multipart request. */
export type MultipartFilePolicy =
  | {
      required?: boolean;
      multiple?: false;
      maxFiles?: never;
      maxBytes?: number;
      contentTypes?: readonly string[];
    }
  | {
      required?: boolean;
      multiple: true;
      maxFiles?: number;
      maxBytes?: number;
      contentTypes?: readonly string[];
    };

/** One source of truth for multipart cardinality, delivery and byte policy. */
export interface MultipartDescriptor {
  delivery?: 'buffer' | 'stream';
  maxRequestBytes?: number;
  maxFieldBytes?: number;
  files: Record<string, MultipartFilePolicy>;
}

type MultipartClientValue<P> = P extends { multiple: true } ? MultipartFile[] : MultipartFile;

type RequiredMultipartKeys<F> = {
  [K in keyof F]: F[K] extends { required: false } ? never : K;
}[keyof F];

type OptionalMultipartKeys<F> = {
  [K in keyof F]: F[K] extends { required: false } ? K : never;
}[keyof F];

type MultipartArgs<E> = E extends { multipart: { files: infer F } }
  ? { [K in RequiredMultipartKeys<F>]: MultipartClientValue<F[K]> } & {
      [K in OptionalMultipartKeys<F>]?: MultipartClientValue<F[K]>;
    }
  : unknown;

/** Buffered server-side file values inferred from a multipart descriptor. */
export type MultipartBufferedFiles<M> = M extends { files: infer F }
  ? {
      [K in keyof F]: F[K] extends { multiple: true }
        ? File[]
        : F[K] extends { required: false }
          ? File | undefined
          : File;
    }
  : never;

/** Public per-call options accepted by every typed HTTP endpoint's `withOptions` method. */
export interface ClientRequestOptions {
  signal?: AbortSignal;
}

type ClientEndpointWithArgs<Args, Output> = {
  (args: Args): Promise<Output>;
  withOptions(args: Args, options: ClientRequestOptions): Promise<Output>;
};

type ClientEndpointWithoutArgs<Output> = {
  (): Promise<Output>;
  withOptions(options: ClientRequestOptions): Promise<Output>;
};

type InferredPathParams<E> = E extends { path: infer TPath extends string }
  ? keyof PathParams<TPath> extends never
    ? unknown
    : PathParams<TPath>
  : unknown;

type EndpointParamsInput<E> =
  Prop<E, 'params'> extends ZodType ? InferInput<Prop<E, 'params'>> : InferredPathParams<E>;

type EndpointArgs<E> = EndpointParamsInput<E> &
  InferInput<Prop<E, 'input'>> &
  MultipartArgs<E>;

/**
 * What the typed client resolves to. A `raw` endpoint hands back the untouched
 * `Response` — its body is bytes, and the headers carry what the caller needs
 * (`Content-Disposition`, `Content-Range`, `ETag`). → ADR 0038.
 */
type EndpointOutput<E> = E extends { rawResponse: true }
  ? Response
  : Prop<E, 'stream'> extends { item: ZodType<infer O> }
    ? AsyncIterableIterator<O>
    : Prop<E, 'output'> extends ZodType<infer O>
      ? O
      : undefined;

export type EndpointFn<E> = [keyof EndpointArgs<E>] extends [never]
  ? ClientEndpointWithoutArgs<EndpointOutput<E>>
  : ClientEndpointWithArgs<EndpointArgs<E>, EndpointOutput<E>>;

export type TypedClient<C extends Record<string, EndpointDef>> = {
  [K in keyof C]: EndpointFn<C[K]>;
};

type ExposesHttp<E> = E extends { expose: readonly Transport[] }
  ? 'HTTP' extends E['expose'][number]
    ? true
    : false
  : true;

// ─── Scoped client (keys a `pathPrefix` consumes become required args) ────────
//
// A per-tenant / resource-scoped client built with `createClient(c, http, {
// pathPrefix, stripPrefixKeys })` needs the consumed keys (e.g. `tenantId`) in
// every method's args even though they are not in the endpoint schemas. `Extra`
// is `{ [K in consumed]: string }`, or `unknown` for a plain client (so
// `EndpointArgs<E> & unknown = EndpointArgs<E>` — identical to `EndpointFn`).
type ArgsWith<E, Extra> = EndpointArgs<E> & Extra;

export type ScopedEndpointFn<E, Extra> = [keyof ArgsWith<E, Extra>] extends [never]
  ? ClientEndpointWithoutArgs<EndpointOutput<E>>
  : ClientEndpointWithArgs<ArgsWith<E, Extra>, EndpointOutput<E>>;

export type ScopedHttpClient<C extends Record<string, EndpointDef>, Extra> = {
  [K in keyof C as ExposesHttp<C[K]> extends true ? K : never]: ScopedEndpointFn<C[K], Extra>;
};

// A plain client is the scoped client with no extra keys (`unknown`), so
// `ScopedEndpointFn<E, unknown>` collapses to `EndpointFn<E>`.
export type TypedHttpClient<C extends Record<string, EndpointDef>> = ScopedHttpClient<
  C,
  unknown
>;

type IsUrlBuildable<E> = ExposesHttp<E>;

type EndpointUrlArgs<E> = EndpointParamsInput<E> &
  (E extends { method: 'GET' | 'DELETE' } ? InferInput<Prop<E, 'input'>> : unknown);

type UrlArgsWith<E, Extra> = EndpointUrlArgs<E> & Extra;

export type ScopedUrlFn<E, Extra> = [keyof UrlArgsWith<E, Extra>] extends [never]
  ? () => string
  : (args: UrlArgsWith<E, Extra>) => string;

export type ScopedUrlBuilder<C extends Record<string, EndpointDef>, Extra> = {
  [K in keyof C as IsUrlBuildable<C[K]> extends true ? K : never]: ScopedUrlFn<C[K], Extra>;
};

export type TypedUrlBuilder<C extends Record<string, EndpointDef>> = ScopedUrlBuilder<
  C,
  unknown
>;
