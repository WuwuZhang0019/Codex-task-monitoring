import { runSessionWorker } from './session-worker-runtime.mjs';

await runSessionWorker(process.argv[2]);
