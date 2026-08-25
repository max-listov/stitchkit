#!/usr/bin/env bun

import { appDeclaration } from '@app/config/declaration';
import { createCli } from 'stitchkit/cli';
import { createSurface } from './surface';

const { services, socket } = await createSurface();

try {
  await createCli({
    name: appDeclaration.identity.slug,
    version: appDeclaration.identity.version,
    services,
  });
} finally {
  await socket.close();
}
