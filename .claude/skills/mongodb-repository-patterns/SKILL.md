---
name: mongodb-repository-patterns
description: Usa quando scrivi un repository MongoDB con il driver ufficiale: connessione unica, indici idempotenti, proiezioni, paginazione a cursore, update atomici, gestione dell'errore di chiave duplicata, chiusura ordinata.
---
# MongoDB Repository Patterns

## Connessione
- Un solo `MongoClient` per processo, creato in `src/server.ts` e iniettato; mai connessioni per richiesta.
- `serverSelectionTimeoutMS` e `maxPoolSize` da configurazione; `client.close()` all'arresto.
- L'URI arriva dalla configurazione validata: mai loggarlo (contiene credenziali).

## Indici idempotenti
```ts
import type { Db } from 'mongodb';

/**
 * Creates the sessions collection indexes; safe to call on every startup.
 * @param db common database
 */
export async function ensureSessionIndexes(db: Db): Promise<void> {
  await db.collection('sessions').createIndexes([
    { key: { accessTokenHash: 1 }, name: 'accessTokenHash_unique', unique: true },
    { key: { refreshTokenHash: 1 }, name: 'refreshTokenHash_unique', unique: true },
    { key: { userId: 1, revokedAt: 1 }, name: 'user_active' },
    { key: { refreshExpiresAt: 1 }, name: 'ttl_refresh', expireAfterSeconds: 0 },
  ]);
}
```

## Paginazione a cursore
```ts
import type { Collection, Document, Filter, ObjectId } from 'mongodb';

/** Page request: maximum size and optional cursor (id of the last item seen). */
export interface PageRequest {
  limit: number;
  after?: ObjectId;
}

/** One page of results with the cursor of the next one. */
export interface Page {
  items: Document[];
  next: string | null;
}

/**
 * Lists scoped documents ordered by _id, one page at a time.
 * @param collection collection to read
 * @param filter filter already including scopeFilter(auth)
 * @param page page size and cursor
 */
async function listPage(collection: Collection, filter: Filter<Document>, { limit, after }: PageRequest): Promise<Page> {
  const query: Filter<Document> = after ? { ...filter, _id: { $gt: after } } : filter;
  const docs = await collection.find(query, { projection: PUBLIC_FIELDS })
    .sort({ _id: 1 }).limit(limit + 1).toArray();
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  const last = items.at(-1);
  return { items, next: hasMore && last ? (last._id as ObjectId).toHexString() : null };
}
```
Il cursore restituito al client è opaco (es. base64url) e si rivalida all'ingresso.

## Errori del driver
- Chiave duplicata (`err.code === 11000`) ⇒ `AppError(409, 'CONFLICT', …)` senza riportare il nome dell'indice o il valore.
- Altri errori del driver non si traducono: arrivano al gestore centrale come 500 generici.

## Update atomici
`findOneAndUpdate` / `updateOne` con condizioni nel filtro (es. `usedAt: null`) per evitare race condition; mai leggere-modificare-scrivere in due passaggi su dati concorrenti.

## Proiezioni
Ogni repository dichiara `PUBLIC_FIELDS`; i campi sensibili (hash, salt, segreti cifrati) si leggono solo nei metodi che ne hanno bisogno (es. verifica password) e non escono dal service.
