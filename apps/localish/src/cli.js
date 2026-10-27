#!/usr/bin/env node

import { createLocalishServer } from './server.js';

const command = process.argv[2] ?? 'start';
if (command !== 'start' && command !== '--help' && command !== '-h') {
  console.error('Usage: localish [start]');
  process.exitCode = 2;
} else if (command === '--help' || command === '-h') {
  console.log('Usage: localish [start]\n\nStarts the local desktop service on 127.0.0.1:8080 by default.');
} else {
  const app = createLocalishServer();
  try {
    const address = await app.listen();
    const port = typeof address === 'object' && address ? address.port : 8080;
    console.log(`localish listening at http://127.0.0.1:${port}`);
    console.log('Keep this process running while remoteish uses the SSH reverse socket.');

    const shutdown = async () => {
      await app.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(`Could not start localish: ${error.message}`);
    process.exitCode = 1;
  }
}
