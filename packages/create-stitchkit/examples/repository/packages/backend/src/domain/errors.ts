import { defineErrors } from 'stitchkit';
import { z } from 'zod';

export const { errors: domainErrors, codes: domainErrorCodes } = defineErrors({
  GITHUB_UNAVAILABLE: {
    status: 503,
    // Declared once here instead of at every throw site.
    message: 'GitHub repository data is temporarily unavailable',
    details: z.object({ cause: z.string() }),
  },
});
