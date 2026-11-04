import { z } from 'zod';
import { createClient, createUrlBuilder } from '../src/browser/client';
import {
  type ConfiguredScopedDefineContract,
  type ContractFactoryConfig,
  createContractFactory,
  defineContract,
  type EndpointDef,
  type EndpointStreamDescriptor,
  type FactoryScopedEndpoint,
  withToolView,
} from '../src/entrypoints/contract';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const TextSchema = z.string();
const InputSchema = z.object({ value: z.string() });

type OptionalEndpoint = {
  method: 'GET';
  path: '/optional';
  desc: string;
  output: typeof TextSchema;
  expose?: readonly ['MCP'];
};
type ConditionalEndpoint = Omit<OptionalEndpoint, 'expose'> &
  ({ expose: readonly ['HTTP'] } | { expose?: undefined });

function factoryTypeChecks(
  optional: OptionalEndpoint,
  conditional: ConditionalEndpoint,
  annotated: FactoryScopedEndpoint<'public' | 'admin'>,
  endpointUnion: OptionalEndpoint | { method: 'GET'; path: '/union'; desc: string },
) {
  const base = createContractFactory<'public' | 'admin'>();
  const { defineContract } = base.configure({ toolExposure: { default: ['HTTP', 'CLI'] } });
  const mixed = defineContract(
    { prefix: 'typed', scope: 'admin' },
    {
      read: { method: 'GET', path: '/', desc: 'Read', output: TextSchema },
      raw: { method: 'GET', path: '/raw', desc: 'Raw', rawResponse: true },
      upload: {
        method: 'POST',
        path: '/upload',
        desc: 'Upload',
        multipart: { files: { file: {} } },
      },
      body: { method: 'POST', path: '/body', desc: 'Body', rawBody: true, input: InputSchema },
      metadata: { method: 'GET', path: '/metadata', desc: 'Metadata', responseMeta: {} },
      stream: { method: 'GET', path: '/stream', desc: 'Stream', stream: { item: TextSchema } },
      head: { method: 'HEAD', path: '/head', desc: 'Head', rawResponse: true },
      cli: { method: 'GET', path: '/cli', desc: 'CLI', expose: ['CLI'] },
      hidden: { method: 'GET', path: '/hidden', desc: 'Hidden', expose: [] },
      undefined: { method: 'GET', path: '/undefined', desc: 'Undefined', expose: undefined },
    },
  );
  const exact: [
    Equal<typeof mixed.meta.scope, 'admin'>,
    Equal<typeof mixed.endpoints.read.expose, readonly ['HTTP', 'CLI']>,
    Equal<typeof mixed.endpoints.raw.expose, readonly ['HTTP']>,
    Equal<typeof mixed.endpoints.upload.expose, readonly ['HTTP']>,
    Equal<typeof mixed.endpoints.body.expose, readonly ['HTTP']>,
    Equal<typeof mixed.endpoints.metadata.expose, readonly ['HTTP']>,
    Equal<typeof mixed.endpoints.stream.expose, readonly ['HTTP']>,
    Equal<typeof mixed.endpoints.head.expose, readonly ['HTTP']>,
    Equal<typeof mixed.endpoints.cli.expose, readonly ['CLI']>,
    Equal<typeof mixed.endpoints.hidden.expose, readonly []>,
    Equal<typeof mixed.endpoints.undefined.expose, readonly ['HTTP', 'CLI']>,
  ] = [true, true, true, true, true, true, true, true, true, true, true];
  void exact;
  const client = createClient(mixed, { baseUrl: 'http://localhost' });
  const urls = createUrlBuilder(mixed, { baseUrl: 'http://localhost' });
  void client.read();
  void urls.raw();
  // @ts-expect-error CLI-only endpoints are not HTTP client methods
  void client.cli();
  // @ts-expect-error empty exposure is not an HTTP client method
  void client.hidden();
  // @ts-expect-error CLI-only endpoints have no HTTP URL
  void urls.cli();
  // @ts-expect-error empty exposure has no HTTP URL
  void urls.hidden();

  const cli = base.configure({ toolExposure: { default: ['CLI'] } }).defineContract(
    { prefix: 'cli', scope: 'public' },
    {
      optional,
      conditional,
      annotated,
      endpointUnion,
      raw: { method: 'GET', path: '/raw', desc: 'Raw', rawResponse: true },
      head: { method: 'HEAD', path: '/head', desc: 'Head', rawResponse: true },
      upload: {
        method: 'POST',
        path: '/upload',
        desc: 'Upload',
        multipart: { files: { file: {} } },
      },
      body: { method: 'POST', path: '/body', desc: 'Body', rawBody: true, input: InputSchema },
      metadata: { method: 'GET', path: '/metadata', desc: 'Metadata', responseMeta: {} },
      stream: { method: 'GET', path: '/stream', desc: 'Stream', stream: { item: TextSchema } },
      http: { method: 'GET', path: '/http', desc: 'HTTP override', expose: ['HTTP'] },
    },
  );
  const optionalExposure: readonly ['MCP'] | readonly ['CLI'] = cli.endpoints.optional.expose;
  const conditionalExposure: readonly ['HTTP'] | readonly ['CLI'] =
    cli.endpoints.conditional.expose;
  const unionExposure: readonly ['MCP'] | readonly ['CLI'] =
    cli.endpoints.endpointUnion.expose;
  const hiddenKinds: [
    Equal<typeof cli.endpoints.raw.expose, readonly []>,
    Equal<typeof cli.endpoints.head.expose, readonly []>,
    Equal<typeof cli.endpoints.upload.expose, readonly []>,
    Equal<typeof cli.endpoints.body.expose, readonly []>,
    Equal<typeof cli.endpoints.metadata.expose, readonly []>,
    Equal<typeof cli.endpoints.stream.expose, readonly []>,
    Equal<typeof cli.endpoints.http.expose, readonly ['HTTP']>,
    Equal<typeof cli.endpoints.optional.expose, readonly ['MCP'] | readonly ['CLI']>,
    Equal<typeof cli.endpoints.conditional.expose, readonly ['HTTP'] | readonly ['CLI']>,
  ] = [true, true, true, true, true, true, true, true, true];
  void [optionalExposure, conditionalExposure, unionExposure, hiddenKinds];
  const cliClient = createClient(cli, { baseUrl: 'http://localhost' });
  const cliUrls = createUrlBuilder(cli, { baseUrl: 'http://localhost' });
  void cliClient.http();
  void cliUrls.http();
  // @ts-expect-error optional MCP override or CLI default never has HTTP
  void cliClient.optional();
  // @ts-expect-error a conditional HTTP override is not guaranteed to exist
  void cliClient.conditional();
  // @ts-expect-error annotated broad endpoints do not guarantee HTTP
  void cliClient.annotated();
  // @ts-expect-error endpoint unions never acquire HTTP from a CLI default
  void cliClient.endpointUnion();
  // @ts-expect-error hidden intrinsic endpoint has no HTTP URL
  void cliUrls.raw();
  // @ts-expect-error an optional override does not guarantee an HTTP URL
  void cliUrls.conditional();

  const hidden = base
    .configure({ toolExposure: { default: [] } })
    .defineContract(
      { prefix: 'hidden', scope: 'public' },
      { read: { method: 'GET', path: '/', desc: 'Read', output: TextSchema } },
    );
  const empty: Equal<typeof hidden.endpoints.read.expose, readonly []> = true;
  void empty;
  // @ts-expect-error hidden endpoints cannot carry a tool view
  withToolView(hidden.endpoints.read, { project: (full) => full });
  // @ts-expect-error scope remains required after configuration
  defineContract({ prefix: 'missing' }, {});
  // @ts-expect-error configured scope is held to the application's vocabulary
  defineContract({ prefix: 'wrong', scope: 'owner' }, {});
  defineContract(
    { prefix: 'wrong', scope: 'public' },
    // @ts-expect-error endpoint scope is held to the same vocabulary
    { read: { method: 'GET', path: '/', desc: 'Read', scope: 'owner' } },
  );
  // @ts-expect-error transport spelling is validated at the policy boundary
  base.configure({ toolExposure: { default: ['UNKNOWN'] } });
  // @ts-expect-error the constructor no longer accepts the old string policy
  createContractFactory<'public'>({ toolExposure: 'explicit' });
  defineContract(
    { prefix: 'invalid-upload', scope: 'public' },
    {
      // @ts-expect-error explicit multipart tool exposure contradicts its HTTP-only capability
      upload: {
        method: 'POST',
        path: '/',
        desc: 'Upload',
        multipart: { files: { file: {} } },
        expose: ['CLI'],
      },
    },
  );
}
void factoryTypeChecks;

function widenedPolicyChecks() {
  const policy: ContractFactoryConfig = { toolExposure: { default: ['CLI'] } };
  const contract = createContractFactory<'public'>()
    .configure(policy)
    .defineContract(
      { prefix: 'widened', scope: 'public' },
      { read: { method: 'GET', path: '/', desc: 'Read', output: TextSchema } },
    );
  const client = createClient(contract, { baseUrl: 'http://localhost' });
  const urls = createUrlBuilder(contract, { baseUrl: 'http://localhost' });
  // @ts-expect-error a widened policy does not guarantee HTTP is present
  void client.read();
  // @ts-expect-error a widened policy does not guarantee an HTTP URL
  void urls.read();
}
void widenedPolicyChecks;

function optionalCapabilityChecks(endpoint: {
  method: 'GET';
  path: '/';
  desc: string;
  stream?: EndpointStreamDescriptor;
}) {
  const contract = createContractFactory<'public'>()
    .configure({ toolExposure: { default: ['CLI'] } })
    .defineContract({ prefix: 'optional-stream', scope: 'public' }, { read: endpoint });
  const possible: Equal<
    typeof contract.endpoints.read.expose,
    readonly ['CLI'] | readonly []
  > = true;
  void possible;
  const client = createClient(contract, { baseUrl: 'http://localhost' });
  // @ts-expect-error an optional HTTP-only capability never promises HTTP from a CLI-only policy
  void client.read();
}
void optionalCapabilityChecks;

function configurationKeyChecks() {
  const base = createContractFactory<'public'>();
  // @ts-expect-error a key outside the exposure policy is refused before run time
  base.configure({ toolExposure: { default: ['HTTP'], extra: 1 } });
  // @ts-expect-error a key outside the configuration is refused before run time
  base.configure({ toolExposure: { default: ['HTTP'] }, other: true });
  // @ts-expect-error a misspelled default is not a default
  base.configure({ toolExposure: { defualt: ['HTTP'] } });
  const exact: Equal<
    ReturnType<
      typeof base.configure<{ toolExposure: { default: ['HTTP', 'CLI'] } }>
    >['defineContract'],
    ConfiguredScopedDefineContract<'public', ['HTTP', 'CLI']>
  > = true;
  void exact;
  const inferred: ConfiguredScopedDefineContract<'public', readonly ['HTTP', 'CLI']> =
    base.configure({ toolExposure: { default: ['HTTP', 'CLI'] } }).defineContract;
  void inferred;
}
void configurationKeyChecks;

/**
 * An endpoint typed as the broad `EndpointDef` (or `FactoryScopedEndpoint`)
 * carries `expose?: readonly Transport[]`, which may hold no HTTP; a client
 * method needs HTTP guaranteed. A helper that keeps the literal type keeps the method.
 */
function wideEndpointChecks(annotated: EndpointDef, scoped: FactoryScopedEndpoint<'public'>) {
  const endpoint = <const Endpoint extends EndpointDef>(value: Endpoint): Endpoint => value;
  const helped = endpoint({
    method: 'GET',
    path: '/helped',
    desc: 'Helped',
    output: TextSchema,
  });

  const plain = defineContract({ prefix: 'plain' }, { annotated, helped });
  const plainClient = createClient(plain, { baseUrl: 'http://localhost' });
  // @ts-expect-error a broad endpoint type does not guarantee HTTP, even without a factory
  void plainClient.annotated();
  void plainClient.helped();

  const unconfigured = createContractFactory<'public'>().defineContract(
    { prefix: 'unconfigured', scope: 'public' },
    { scoped, helped },
  );
  const unconfiguredClient = createClient(unconfigured, { baseUrl: 'http://localhost' });
  // @ts-expect-error a broad factory endpoint does not guarantee HTTP without configuration
  void unconfiguredClient.scoped();
  void unconfiguredClient.helped();

  const configured = createContractFactory<'public'>()
    .configure({ toolExposure: { default: ['HTTP'] } })
    .defineContract({ prefix: 'configured', scope: 'public' }, { scoped, helped });
  const configuredClient = createClient(configured, { baseUrl: 'http://localhost' });
  // @ts-expect-error an HTTP default does not repair an authored broad exposure
  void configuredClient.scoped();
  void configuredClient.helped();
}
void wideEndpointChecks;
