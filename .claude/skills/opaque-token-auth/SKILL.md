---
name: opaque-token-auth
description: Usa quando implementi login, sessioni, access e refresh token, logout, revoca o il middleware di autenticazione Bearer: token opachi con node:crypto, hash SHA-256 a riposo, rotazione del refresh con rilevamento del riuso.
---
# Opaque Token Auth

> Implementa questa skill solo dopo che l'utente ha confermato i token opachi (`doc/Security-Model.md` §10.1).

## Generazione e hash
```js
import { randomBytes, createHash } from 'node:crypto';

/**
 * Genera un segreto casuale con prefisso riconoscibile.
 * @param {string} prefix es. 'fc_at_' (access) o 'fc_rt_' (refresh)
 * @returns {string} segreto da consegnare al client una sola volta
 */
export function generateToken(prefix) {
  return prefix + randomBytes(32).toString('base64url');
}

/**
 * Hash da salvare e su cui cercare. SHA-256 basta: il token ha 256 bit di entropia.
 * @param {string} token
 * @returns {string} hash esadecimale
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
```
La ricerca avviene **per hash su indice univoco**: il confronto lo fa l'indice, non serve `timingSafeEqual` sul token.

## Collection `sessions` (indicativa)
`_id`, `userId`, `tenantId`, `familyId`, `accessTokenHash` (univoco), `accessExpiresAt`, `refreshTokenHash` (univoco), `refreshExpiresAt`, `refreshUsedAt`, `revokedAt`, `revokedReason`, `createdAt`, `lastUsedAt`, `ip`, `userAgent`. Indice TTL su `refreshExpiresAt`.

## Middleware Bearer
1. Header assente o non nel formato `Bearer fc_at_…` ⇒ 401 `UNAUTHENTICATED` (nessun dettaglio sul motivo).
2. `findOne({ accessTokenHash })`; non trovata, scaduta, revocata ⇒ 401.
3. Carica l'utente: inattivo o tenant sospeso ⇒ 401.
4. Costruisce `req.auth` (skill `tenant-isolation`), aggiorna `lastUsedAt` senza bloccare la risposta più di una volta al minuto.
5. Risposta `401` con `WWW-Authenticate: Bearer`.

## Login
- Rate limit per IP e per identificativo prima di toccare il database.
- Identificativo validato come stringa (mai oggetto).
- Utente inesistente: verifica comunque un hash fittizio per tempo costante; risposta identica a password errata (`INVALID_CREDENTIALS`).
- Successo: nuova sessione con `familyId` nuovo; risponde `{ accessToken, accessExpiresAt, refreshToken, refreshExpiresAt }` nel body (mai nei header esposti via CORS come il legacy).

## Refresh con rotazione
Operazione atomica:
```js
const session = await sessions.findOneAndUpdate(
  { refreshTokenHash: hashToken(refreshToken), refreshUsedAt: null, revokedAt: null, refreshExpiresAt: { $gt: now } },
  { $set: { refreshUsedAt: now } },
);
```
- Se `null`, cerca il token **senza** i vincoli: se esiste ed era già usato ⇒ **riuso rilevato**: revoca tutte le sessioni della `familyId` e registra l'evento nell'audit log. Risposta sempre 401.
- Se valido: crea una nuova sessione nella stessa famiglia con token nuovi e revoca la precedente.

## Revoca
Logout (sessione corrente), logout ovunque (tutte le sessioni dell'utente), cambio password, disattivazione utente, cambio ruolo: `updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now, revokedReason } })`.

## Test obbligatori
Token assente, malformato, inesistente, scaduto, revocato; utente disattivato; refresh valido; refresh riusato (famiglia revocata); refresh scaduto; logout ovunque; nessun token nei log.
