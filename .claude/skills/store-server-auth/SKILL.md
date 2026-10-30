---
name: store-server-auth
description: Usa quando implementi l'autenticazione dei server di punto vendita sulla superficie /store/v1: codice di attivazione, registrazione della chiave pubblica Ed25519, asserzioni firmate con anti-replay, access token opachi da 15 minuti, rotazione e revoca delle chiavi, migrazione dalla API key di gruppo.
---
# Store Server Auth (Ed25519)

Riferimenti: `doc/Security-Model.md` §5, collection `storeServers`, `storeServerActivations`, `storeServerNonces`, `storeServerTokens` in `doc/Data-Model.md`.

## Flusso
1. **Codice di attivazione** (backoffice, permesso `storeServers:manage`): 10 caratteri da alfabeto senza ambiguità (es. Crockford base32), `codeHash` SHA-256, scadenza 15 minuti, tentativi limitati.
2. **Attivazione** `POST /store/v1/activation` (route pubblica con rate limit severo): `{ code, publicKey, softwareVersion, hostname }`. Consumo atomico del codice (`findOneAndUpdate` con `usedAt: null`, non scaduto), validazione della chiave pubblica, salvataggio con `keyId` casuale, server `active`.
3. **Token** `POST /store/v1/token` (route pubblica, autenticata dalla firma): asserzione firmata ⇒ access token `fc_st_…` da 15 minuti.
4. **Chiamate operative** con `Authorization: Bearer fc_st_…`.

## Chiave pubblica
Il client invia la chiave pubblica Ed25519 in formato SPKI DER base64. Validazione lato server:
```js
import { createPublicKey } from 'node:crypto';

/**
 * Converte e valida una chiave pubblica Ed25519 ricevuta dal server di punto vendita.
 * @param {string} spkiBase64 chiave in formato SPKI DER codificata base64
 * @returns {import('node:crypto').KeyObject}
 * @throws {AppError} 422 se non è una chiave pubblica Ed25519 valida
 */
export function parseEd25519PublicKey(spkiBase64) {
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  } catch (cause) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Invalid request', [{ field: 'publicKey', issue: 'invalid' }], { cause });
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new AppError(422, 'VALIDATION_ERROR', 'Invalid request', [{ field: 'publicKey', issue: 'unsupported_type' }]);
  }
  return key;
}
```

## Asserzione
Body: `{ storeServerId, keyId, iat, jti, signature }`; `aud` fisso `flood-cloud-store`.
Stringa firmata: `v1.<aud>.<storeServerId>.<keyId>.<iat>.<jti>`.
```js
import { verify } from 'node:crypto';

/**
 * Verifica la firma Ed25519 di un'asserzione.
 * @param {{ message: string, signature: string, publicKey: import('node:crypto').KeyObject }} input
 * @returns {boolean}
 */
export function verifyAssertionSignature({ message, signature, publicKey }) {
  const sig = Buffer.from(signature, 'base64url');
  if (sig.length !== 64) return false;
  return verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
}
```
Ordine dei controlli (ogni fallimento ⇒ `401`, stesso messaggio, evento in audit log):
1. schema dell'asserzione valido (tipi, lunghezze, `jti` di 16 byte base64url);
2. server `active` e `keyId` attivo e non revocato;
3. firma valida;
4. `|now − iat| ≤ 300 s`, altrimenti `401 CLOCK_SKEW` con l'ora del server;
5. `jti` inserito in `storeServerNonces` (`_id: storeServerId:jti`, TTL): errore di chiave duplicata ⇒ replay ⇒ `401`;
6. emissione del token, aggiornamento di `lastSeenAt`, `lastIp`.

La verifica della firma avviene **prima** di scrivere il nonce, così richieste non firmate non riempiono la collection.

## Middleware Bearer della superficie store
Cerca `tokenHash` in `storeServerTokens` (non scaduto, non revocato), ricarica il server (`active`) e il gruppo (`active`), costruisce `req.auth = { kind: 'storeServer', principalId, groupId, companyId, placeId, permissions }` congelato. Scope **fisso** sul punto vendita.

## Rotazione e revoca
- `POST /store/v1/keys` (token valido): `{ publicKey, proof }` dove `proof` è la firma con la **nuova** chiave di `v1.rotate.<storeServerId>.<tokenId>`; la vecchia chiave è revocata appena la nuova è registrata, i token esistenti restano validi fino a scadenza.
- Revoca dal backoffice: `status: 'revoked'`, chiavi revocate, `storeServerTokens` revocati in blocco.

## Idempotenza
Le scritture della superficie store richiedono `Idempotency-Key`: collection per gruppo con chiave univoca `(storeServerId, idempotencyKey)`, hash del body e risposta salvata; stessa chiave con body diverso ⇒ `409`.

## Test obbligatori
Codice valido, scaduto, già usato, errato oltre i tentativi; chiave pubblica non Ed25519 o malformata; firma errata, di lunghezza errata, con `keyId` revocato; `iat` fuori tolleranza; `jti` riusato; server revocato; gruppo sospeso; token scaduto o revocato; accesso a un altro punto vendita (`404`); rotazione con prova errata; token del backoffice rifiutato su `/store/v1`. Nei test le coppie di chiavi si generano con `generateKeyPairSync('ed25519')`.
