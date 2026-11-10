import { readFile } from 'node:fs/promises';
import { createServer } from '../../server/index.mjs';

const [root, point, inputFile] = process.argv.slice(2);
const { draftId, body } = JSON.parse(await readFile(inputFile, 'utf8'));
const server = await createServer({ dataDir: root, env: {}, storageFault: async phase => { if (phase === point) process.exit(77); } });
await server.workbench.publisher.publish(draftId, body);
throw Error('Crash injection was not reached');
