#!/usr/bin/env bun

import { createCli } from 'stitchkit/cli';
import { createSurface } from './surface';

const { services, socket } = await createSurface();

try {
  await createCli({ name: 'stitchkit-starter', version: '0.1.0', services });
} finally {
  await socket.io.close();
}
