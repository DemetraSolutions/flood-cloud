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
```js
import { before, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';

/**
 * Apre un database usa-e-getta per un file di test.
 * @returns {Promise<{ client: MongoClient, db: import('mongodb').Db, drop: () => Promise<void> }>}
 * @throws {Error} se FLOOD_CLOUD_TEST_MONGO_URI non è impostata
 */
export async function openTestDatabase() {
  const uri = process.env.FLOOD_CLOUD_TEST_MONGO_URI;
  if (!uri) {
    throw new Error('FLOOD_CLOUD_TEST_MONGO_URI non impostata: i test di integrazione richiedono MongoDB.');
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
```js
let ctx;
before(async () => { ctx = await openTestDatabase(); await ensureIndexes(ctx.db); });
after(async () => { await ctx.drop(); });
```

## Transazioni
Le transazioni richiedono un replica set. Se un passo introduce transazioni, l'ambiente di test deve usare un replica set (anche a nodo singolo): chiedi all'utente come predisporlo prima di procedere.
