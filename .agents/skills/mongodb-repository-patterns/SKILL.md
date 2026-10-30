---
name: mongodb-repository-patterns
description: Usa quando scrivi un repository MongoDB con il driver ufficiale: connessione unica, indici idempotenti, proiezioni, paginazione a cursore, update atomici, gestione dell'errore di chiave duplicata, chiusura ordinata.
---
# MongoDB Repository Patterns

## Connessione
- Un solo `MongoClient` per processo, creato in `src/server.js` e iniettato; mai connessioni per richiesta.
- `serverSelectionTimeoutMS` e `maxPoolSize` da configurazione; `client.close()` all'arresto.
- L'URI arriva dalla configurazione validata: mai loggarlo (contiene credenziali).

## Indici idempotenti
```js
/**
 * Crea gli indici della collection sessions; sicuro da richiamare a ogni avvio.
 * @param {import('mongodb').Db} db
 */
export async function ensureSessionIndexes(db) {
  await db.collection('sessions').createIndexes([
    { key: { accessTokenHash: 1 }, name: 'accessTokenHash_unique', unique: true },
    { key: { refreshTokenHash: 1 }, name: 'refreshTokenHash_unique', unique: true },
    { key: { userId: 1, revokedAt: 1 }, name: 'user_active' },
    { key: { refreshExpiresAt: 1 }, name: 'ttl_refresh', expireAfterSeconds: 0 },
  ]);
}
```

## Paginazione a cursore
```js
/**
 * Elenca i documenti del tenant in ordine di _id, a pagine.
 * @param {object} filter filtro già comprensivo di tenantFilter(auth)
 * @param {{ limit: number, after?: import('mongodb').ObjectId }} page
 */
async function listPage(collection, filter, { limit, after }) {
  const query = after ? { ...filter, _id: { $gt: after } } : filter;
  const docs = await collection.find(query, { projection: PUBLIC_FIELDS })
    .sort({ _id: 1 }).limit(limit + 1).toArray();
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  return { items, next: hasMore ? items.at(-1)._id.toHexString() : null };
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
