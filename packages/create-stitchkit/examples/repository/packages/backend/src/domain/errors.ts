import { defineErrors } from 'stitchkit';
import { z } from 'zod';

export const { errors: domainErrors, codes: domainErrorCodes } = defineErrors({
  GITHUB_UNAVAILABLE: {
    status: 503,
    details: z.object({ cause: z.string() }),
  },
});
