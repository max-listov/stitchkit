import { createClient, createUrlBuilder } from 'stitchkit';
import {
  type ConfiguredScopedDefineContract,
  createContractFactory,
} from 'stitchkit/contract';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const base = createContractFactory<'public'>();
const contract = base.configure({ toolExposure: { default: ['HTTP', 'CLI'] } }).defineContract(
  { prefix: 'packed-factory', scope: 'public' },
  {
    read: { method: 'GET', path: '/', desc: 'Read' },
    download: { method: 'GET', path: '/download', desc: 'Download', rawResponse: true },
    local: { method: 'GET', path: '/local', desc: 'CLI only', expose: ['CLI'] },
  },
);
const exact: [
  Equal<typeof contract.meta.scope, 'public'>,
  Equal<typeof contract.endpoints.read.expose, readonly ['HTTP', 'CLI']>,
  Equal<typeof contract.endpoints.download.expose, readonly ['HTTP']>,
  Equal<typeof contract.endpoints.local.expose, readonly ['CLI']>,
] = [true, true, true, true];
void exact;
const configured: ConfiguredScopedDefineContract<'public', readonly ['HTTP', 'CLI']> =
  base.configure({
    toolExposure: { default: ['HTTP', 'CLI'] },
  }).defineContract;
void configured;
/** Type-level only: the same call throws at run time. */
function refusedKey() {
  // @ts-expect-error emitted declarations refuse a key outside the exposure policy
  base.configure({ toolExposure: { default: ['HTTP'], extra: true } });
}
void refusedKey;
const client = createClient(contract, { baseUrl: 'http://localhost' });
const urls = createUrlBuilder(contract, { baseUrl: 'http://localhost' });
void client.read;
void urls.download;
// @ts-expect-error emitted declarations must not invent an HTTP client method
void client.local;
// @ts-expect-error emitted declarations must not invent an HTTP URL
void urls.local;
if (Reflect.has(client, 'local') || Reflect.has(urls, 'local')) {
  throw new Error('Packed factory exposed a CLI-only operation over HTTP');
}

const cli = base
  .configure({ toolExposure: { default: ['CLI'] } })
  .defineContract(
    { prefix: 'packed-cli', scope: 'public' },
    { read: { method: 'GET', path: '/', desc: 'Hidden HTTP download', rawResponse: true } },
  );
const empty: Equal<typeof cli.endpoints.read.expose, readonly []> = true;
void empty;
if (cli.endpoints.read.expose.length !== 0) throw new Error('Packed factory reopened HTTP');
