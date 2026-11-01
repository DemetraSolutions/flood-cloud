---
name: node-test-coverage
description: Usa quando scrivi o organizzi test con node:test, configuri la coverage nativa al 100% o testi endpoint Express via fetch su porta effimera.
---
# Node Test & Coverage

## Script `package.json`
```json
{
  "scripts": {
    "test": "node --test --experimental-test-coverage --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 --test-coverage-include=src/** \"test/**/*.test.ts\"",
    "test:unit": "node --test \"test/unit/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  }
}
```
- `--test-coverage-include=src/**` misura solo il codice applicativo, non i test.
- Node 24 esegue nativamente i file di test `.ts` (type stripping, nessuna build) e la coverage è mappata sui sorgenti `.ts` (verificato).
- `npm run typecheck` (`tsc --noEmit`) deve passare insieme a `npm test`: il type stripping non controlla i tipi.
- Prima di cambiare i flag verifica la documentazione della versione di Node in uso (`node --help`): alcuni flag di coverage evolvono tra le versioni.

## Test unitario
```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from '../../src/shared/validation/email.ts';

describe('normalizeEmail', () => {
  it('lowercases and trims the value', () => {
    assert.equal(normalizeEmail('  Mario@Example.COM '), 'mario@example.com');
  });

  it('rejects a non-string value', () => {
    assert.throws(() => normalizeEmail({ $gt: '' } as unknown as string), { code: 'VALIDATION_ERROR' });
  });
});
```

## Test HTTP su porta effimera
L'app si costruisce con una factory (`createApp(deps)`) che **non** apre connessioni né porte: il test inietta le dipendenze e avvia il server.
```ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';

describe('GET /health', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = createApp({ /* test dependencies */ });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));

  it('responds 200 with the standard envelope', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'ok' } });
  });
});
```

## Mock e tempo
```ts
import { mock } from 'node:test';
mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00Z') });
// ... assertions on token expiry
mock.timers.reset();
```
Preferisci l'**iniezione** di un orologio (`clock.now()`) nei servizi: rende i test più semplici dei mock globali.

## Checklist per ogni file di `src/`
- [ ] happy path
- [ ] ogni ramo `if`/`switch`/`??`/`?.` percorso almeno una volta in entrambe le direzioni
- [ ] ogni `throw` e ogni risposta d'errore
- [ ] nessun test che passa senza asserzioni
