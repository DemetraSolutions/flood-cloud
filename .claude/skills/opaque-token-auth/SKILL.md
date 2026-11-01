---
name: opaque-token-auth
description: Usa quando implementi login del backoffice, sessioni, access e refresh token, logout, revoca o il middleware Bearer della superficie /v1: token opachi con node:crypto, hash SHA-256 a riposo, rotazione del refresh con rilevamento del riuso, codice TOKEN_EXPIRED.
---
# Opaque Token Auth (backoffice)

Riferimenti: `doc/Security-Model.md` §4, collection `sessions` in `doc/Data-Model.md`. Decisione del 2026-10-30: **token opachi**, non JWT.

## Generazione e hash
```ts
import { randomBytes, createHash } from 'node:crypto';

/**
 * Generates a random secret with a recognizable prefix.
 * @param prefix e.g. 'fc_at_' (access) or 'fc_rt_' (refresh)
 * @returns secret to hand to the client exactly once
 */
export function generateToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

/**
 * Hash to store and look up. SHA-256 is enough: the token carries 256 bits of entropy.
 * @param token plain token received from or sent to the client
 * @returns hex-encoded hash
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```
La ricerca avviene **per hash su indice univoco**: non serve `timingSafeEqual` sul token.

## Durate (default configurabili)
Access 15 minuti; refresh 7 giorni di inattività; famiglia di sessioni al massimo 30 giorni, poi nuovo login.

## Middleware Bearer (`/v1`)
1. Header assente o non `Bearer fc_at_…` ⇒ `401 UNAUTHENTICATED`.
2. `findOne({ accessTokenHash })`: inesistente o revocata ⇒ `401 UNAUTHENTICATED`; scaduta ⇒ `401 TOKEN_EXPIRED` (è il segnale per cui il client chiama il refresh).
3. Utente `active` con ruolo ammesso al backoffice (non `E`), gruppo `active` ⇒ altrimenti `401 UNAUTHENTICATED`.
4. Costruisce `req.auth` (skill `tenant-isolation`); `lastUsedAt` aggiornato al massimo una volta al minuto.
5. `WWW-Authenticate: Bearer` sulle risposte `401`.

## Login (`POST /v1/auth/login`)
- Rate limit per IP e per username **prima** di toccare le password (skill `rate-limiting-metering`).
- Username validato come stringa; utente inesistente ⇒ verifica comunque un hash fittizio; risposta identica (`401 INVALID_CREDENTIALS`) per utente inesistente, password errata, utente `E`, utente disattivato, gruppo sospeso.
- Successo: sessione con `familyId` nuovo e `familyExpiresAt`; risposta con `accessToken` e `accessExpiresAt`; refresh token nel cookie `HttpOnly` o nel body secondo la decisione aperta (`doc/Security-Model.md` §12). Mai nei header esposti via CORS come nel legacy.

## Refresh con rotazione (`POST /v1/auth/refresh`)
```ts
const session = await sessions.findOneAndUpdate(
  { refreshTokenHash: hashToken(refreshToken), refreshUsedAt: null, revokedAt: null,
    refreshExpiresAt: { $gt: now }, familyExpiresAt: { $gt: now } },
  { $set: { refreshUsedAt: now } },
); // WithId<SessionDocument> | null (driver 6+ returns the document directly)
```
- Se `null`: cerca il token senza vincoli; se esiste ed era già usato ⇒ **riuso**: revoca tutta la `familyId`, evento nell'audit log. Risposta sempre `401`.
- Se valido: nuova sessione nella stessa famiglia (stesso `familyExpiresAt`), revoca della precedente.
- Con il cookie: verifica dell'header `Origin` contro l'allowlist.

## Revoca
Logout (sessione corrente), logout ovunque, cambio password, cambio ruolo o scope, utente disattivato, gruppo sospeso: `updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now, revokedReason } })` (per il gruppo: `groupId`).

## Test obbligatori
Token assente, malformato, inesistente, scaduto (`TOKEN_EXPIRED`), revocato; utente `E`; utente disattivato; gruppo sospeso; refresh valido; refresh riusato (famiglia revocata); refresh oltre la durata massima; logout ovunque; token assenti dai log; token store o API key rifiutati su `/v1`.
