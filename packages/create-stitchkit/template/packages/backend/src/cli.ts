#!/usr/bin/env bun

import { appDeclaration, appVersion } from '@app/config/declaration';
import { createCli } from 'stitchkit/cli';
import { createSurface } from './surface';

const { services, socket } = await createSurface();

try {
  await createCli({
    name: appDeclaration.identity.slug,
    version: appVersion,
    services,
    access: { open: 'local-operator' },
  });
} finally {
  await socket.close();
}
