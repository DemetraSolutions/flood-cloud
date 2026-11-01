/**
 * Entry point: the only module that touches the real `process`.
 * Run with `node server/main.ts`.
 * @module
 */
import { fileURLToPath } from 'node:url';
import { run } from './run.ts';

await run(process, fileURLToPath(new URL('../dist/backoffice/browser', import.meta.url)));
