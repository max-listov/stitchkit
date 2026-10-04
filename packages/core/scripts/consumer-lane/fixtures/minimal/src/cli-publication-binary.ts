import {
  type CliBuildStamp,
  CliBuildStampSchema,
  createCli,
  defineCliCommand,
  formatCliBuildStamp,
} from 'stitchkit/cli';
import { z } from 'zod';

declare const PUBLICATION_STAMP: CliBuildStamp;
const stamp = CliBuildStampSchema.parse(PUBLICATION_STAMP);

await createCli({
  name: 'publisher-proof',
  version: formatCliBuildStamp(stamp),
  commands: [
    defineCliCommand({
      name: 'stamp',
      description: 'Return the identity compiled into this executable',
      input: z.object({}),
      output: CliBuildStampSchema,
      handler: () => stamp,
    }),
  ],
});
