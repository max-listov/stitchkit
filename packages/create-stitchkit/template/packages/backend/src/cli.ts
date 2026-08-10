#!/usr/bin/env bun

import { appIdentity } from '@app/config/identity';
import { createCli } from 'stitchkit/cli';
import { createSurface } from './surface';

const { services, socket } = await createSurface();

try {
  await createCli({ name: appIdentity.slug, version: appIdentity.version, services });
} finally {
  await socket.io.close();
}
