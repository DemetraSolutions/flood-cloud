---
name: mongodb-integration-tests
description: Usa quando scrivi test di integrazione che toccano MongoDB reale: database usa-e-getta, pulizia, fixture di tenant, verifica di indici e isolamento.
---
# MongoDB Integration Tests

## Regole
1. L'URI arriva **solo** da `FLOOD_CLOUD_TEST_MONGO_URI`. Se manca, la suite d'integrazione **fallisce** con un messaggio chiaro: la copertura al 100% dipende anche da questi test, quindi non si saltano in silenzio.
2. Ogni file di test usa un database dedicato con nome casuale (`flood_cloud_test_<random>`), eliminato in `after`. Mai usare il database di sviluppo o di produzione.
3. Gli indici si creano con la stessa funzione usata dall'app all'avvio: i test verificano anche che gli indici (es. unicità) siano davvero applicati.
4. Le fixture creano almeno **due tenant**: ogni test d'isolamento verifica che il tenant A non legga, modifichi o cancelli i dati del tenant B.
5. Nessuna dipendenza dall'ordine dei test: ogni `describe` prepara i propri dati.

## Pattern
```ts
import { before, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';

/** Disposable database handle for a test file. */
export interface TestDatabase {
  client: MongoClient;
  db: Db;
  drop: () => Promise<void>;
}

/**
 * Opens a disposable database for a test file.
 * @throws {Error} when FLOOD_CLOUD_TEST_MONGO_URI is not set
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const uri = process.env.FLOOD_CLOUD_TEST_MONGO_URI;
  if (!uri) {
    throw new Error('FLOOD_CLOUD_TEST_MONGO_URI is not set: integration tests require MongoDB.');
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(`flood_cloud_test_${randomBytes(6).toString('hex')}`);
  return {
    client,
    db,
    drop: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}
```

## Uso
```ts
let ctx: TestDatabase;
before(async () => { ctx = await openTestDatabase(); await ensureIndexes(ctx.db); });
after(async () => { await ctx.drop(); });
```

## Transazioni
Le transazioni richiedono un replica set. Se un passo introduce transazioni, l'ambiente di test deve usare un replica set (anche a nodo singolo): chiedi all'utente come predisporlo prima di procedere.
