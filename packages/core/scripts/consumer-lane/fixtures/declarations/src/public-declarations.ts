import type { ClientConfig, ClientFetch, HttpClientConfig, SessionOperation } from 'stitchkit';
import type { ApplicationConfig } from 'stitchkit/application';
import type { ContractDef } from 'stitchkit/contract';
import type { UnixClientTransport } from 'stitchkit/server';

type Assert<T extends true> = T;
type FetchInput = Parameters<ClientFetch>[0];
type ClientCredentials = NonNullable<ClientConfig['credentials']>;
type HttpCredentials = NonNullable<HttpClientConfig['credentials']>;
type HeaderInput = NonNullable<
  ReturnType<NonNullable<Parameters<SessionOperation<unknown>['bindFetch']>[1]>>
>;

type PublicDeclarationControls = [
  Assert<string extends FetchInput ? true : false>,
  Assert<Request extends FetchInput ? true : false>,
  Assert<URL extends FetchInput ? true : false>,
  Assert<number extends FetchInput ? false : true>,
  Assert<ReturnType<ClientFetch> extends Promise<Response> ? true : false>,
  Assert<'include' extends ClientCredentials ? true : false>,
  Assert<'always' extends ClientCredentials ? false : true>,
  Assert<'same-origin' extends HttpCredentials ? true : false>,
  Assert<'always' extends HttpCredentials ? false : true>,
  Assert<Record<string, string> extends HeaderInput ? true : false>,
  Assert<number extends HeaderInput ? false : true>,
];

declare const declarations: [
  UnixClientTransport,
  ClientConfig,
  HttpClientConfig,
  ApplicationConfig,
  ContractDef,
  PublicDeclarationControls,
];
void declarations;
