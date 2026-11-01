---
name: rate-limiting-metering
description: Usa quando implementi rate limit (login, refresh, attivazione, token, superfici API) o quote e conteggio d'uso delle API pubbliche: contatori atomici in MongoDB con TTL, header RateLimit, 429 con Retry-After, aggregazione a blocchi dell'uso.
---
# Rate Limiting & Metering

Riferimenti: `doc/Security-Model.md` §7, collection `rateLimits` e `apiUsage` in `doc/Data-Model.md`. Nessuna libreria: contatori in MongoDB, condivisi tra più istanze del server.

## Finestra fissa con contatore atomico
```js
/**
 * Increments the counter of the current window and tells whether the request is allowed.
 * @param {import('mongodb').Collection} rateLimits collection in the common database
 * @param {{ key: string, limit: number, windowMs: number, now: number }} input
 *   key = '<surface>:<subject>' (e.g. 'login:ip:203.0.113.7', 'public:key:<apiKeyId>')
 * @returns {Promise<{ allowed: boolean, remaining: number, resetAt: number }>}
 */
export async function hit(rateLimits, { key, limit, windowMs, now }) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const doc = await rateLimits.findOneAndUpdate(
    { _id: `${key}:${windowStart}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(resetAt + windowMs) } },
    { upsert: true, returnDocument: 'after' },
  );
  return { allowed: doc.count <= limit, remaining: Math.max(0, limit - doc.count), resetAt };
}
```
Indice TTL su `expiresAt`. In caso di due upsert concorrenti sulla stessa chiave il driver può restituire un errore di chiave duplicata: ritenta una volta.

## Middleware
- Risponde sempre con `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (secondi al reset).
- Oltre il limite: `429`, `Retry-After`, codice `RATE_LIMITED`; il controller non viene eseguito.
- Se MongoDB non risponde il middleware **fallisce chiuso** sugli endpoint di autenticazione (`503`), e la scelta per gli altri endpoint va documentata.
- L'IP si legge da `req.ip` con `trust proxy` configurato correttamente: mai direttamente da `X-Forwarded-For`.

## Soglie (default di piattaforma, configurabili)
| Chiave | Esempio |
|---|---|
| login per IP / per username | severo, con blocco progressivo dell'utente |
| refresh, attivazione, token store, per IP | severo |
| superficie store per server | ampio |
| superficie pubblica per chiave | `apiKeys.rateLimitPerMinute` o default |
I valori sono una decisione aperta (`doc/Security-Model.md` §12): non inventarli, leggili dalla configurazione.

## Quota mensile (API pubbliche)
Contatore con chiave `quota:<apiKeyId>:<YYYY-MM>` con la stessa funzione e finestra mensile calcolata in UTC; superata ⇒ `429 QUOTA_EXCEEDED`.

## Conteggio d'uso
- Accumulo in memoria per `(apiKeyId, day, route)` con chiamate ed errori; scrittura a blocchi ogni N secondi con `bulkWrite` di `updateOne` + `$inc` + `upsert`; flush anche all'arresto ordinato.
- `route` è il **pattern** della route (`/public/v1/products/:id`), mai l'URL con i valori.
- La perdita dell'ultimo blocco in caso di crash è accettabile per le statistiche; le quote invece usano il contatore atomico.

## Test
Sotto soglia, al limite, oltre il limite, cambio di finestra (orologio iniettato), header corretti, chiavi diverse indipendenti, quota mensile, flush del conteggio d'uso, errore del database su endpoint di autenticazione.
