import { z } from 'zod';
import {
  createCli,
  createCliProfileStore,
  extractCliGlobalOptions,
  type RuntimeToolDefinition,
} from '../../src/entrypoints/cli';

export const profileGlobals = z.object({
  profile: z.string().optional(),
  label: z.string().optional(),
});

export function profileStore(directory: string, announce?: (line: string) => void) {
  return createCliProfileStore({
    directory,
    schema: z.object({ url: z.url(), token: z.string().min(1) }),
    announce,
  });
}

const inputSchema = z.object({ text: z.string().optional() });

export function profileTool(profile: string): RuntimeToolDefinition {
  return {
    name: 'endpoint',
    description: 'Report the selected profile',
    identity: { serviceName: 'profiles', action: 'endpoint', method: 'GET' },
    transports: ['CLI'],
    input: inputSchema,
    output: z.object({ profile: z.string(), input: inputSchema }),
    handler: ({ input }) => ({ profile, input }),
  };
}

if (import.meta.main) {
  const directory = process.env.STITCHKIT_TEST_CLI_PROFILE_DIR;
  if (directory === undefined) throw new Error('Missing test profile directory');
  const argv = process.argv.slice(2);
  const { globals } = extractCliGlobalOptions(argv, profileGlobals);
  const profile = profileStore(directory).resolve(
    typeof globals.profile === 'string' ? globals.profile : undefined,
  );
  await createCli({
    name: 'profile-fixture',
    version: '1.0.0',
    globalOptions: profileGlobals,
    runtimeTools: [profileTool(profile.name)],
  });
}
