---
name: node-test-coverage
description: Usa quando scrivi o organizzi test con node:test, configuri la coverage nativa al 100% o testi endpoint Express via fetch su porta effimera.
---
# Node Test & Coverage

## Script `package.json`
```json
{
  "scripts": {
    "test": "node --test --experimental-test-coverage --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 --test-coverage-include=src/** \"test/**/*.test.js\"",
    "test:unit": "node --test \"test/unit/**/*.test.js\""
  }
}
```
- `--test-coverage-include=src/**` misura solo il codice applicativo, non i test.
- Prima di cambiare i flag verifica la documentazione della versione di Node in uso (`node --help`): alcuni flag di coverage evolvono tra le versioni.

## Test unitario
```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from '../../src/shared/validation/email.js';

describe('normalizeEmail', () => {
  it('lowercases and trims the value', () => {
    assert.equal(normalizeEmail('  Mario@Example.COM '), 'mario@example.com');
  });

  it('rejects a non-string value', () => {
    assert.throws(() => normalizeEmail({ $gt: '' }), { code: 'VALIDATION_ERROR' });
  });
});
```

## Test HTTP su porta effimera
L'app si costruisce con una factory (`createApp(deps)`) che **non** apre connessioni né porte: il test inietta le dipendenze e avvia il server.
```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';

describe('GET /health', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = createApp({ /* test dependencies */ });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('responds 200 with the standard envelope', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { status: 'ok' } });
  });
});
```

## Mock e tempo
```js
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
