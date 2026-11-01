---
name: password-hashing
description: Usa quando salvi, verifichi o cambi password o PIN: scrypt di node:crypto con salt per utente, parametri nel formato salvato, confronto a tempo costante, rehash, policy di lunghezza.
---
# Password Hashing (scrypt)

## Parametri
OWASP per scrypt: `N = 2^17`, `r = 8`, `p = 1`, chiave da 64 byte, salt da 16 byte. La memoria richiesta è `128 · N · r` ≈ 128 MiB, oltre il default di Node (32 MiB): imposta `maxmem` esplicito.

## Implementazione
```js
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LENGTH = 64;

/**
 * Hashes a password into the self-describing format scrypt$N$r$p$salt$hash.
 * @param {string} password plain-text password, already validated
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFC'), salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Verifies a password against the stored hash in constant time.
 * @param {string} password
 * @param {string} stored hash in the hashPassword format
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password.normalize('NFC'), Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return timingSafeEqual(actual, expected);
}
```
- Usa sempre la versione **asincrona**: la sincrona blocca l'event loop per centinaia di millisecondi.
- scrypt asincrono usa il threadpool di libuv (4 thread di default): il rate limit sul login protegge anche dal sovraccarico.
- Un hash fittizio precalcolato si verifica quando l'utente non esiste, per non rivelarlo con i tempi.

## Rehash
Se i parametri salvati sono inferiori a quelli correnti, dopo un login riuscito ricalcola e salva il nuovo hash.

## Policy
Lunghezza 12–128 caratteri, nessuna regola di composizione forzata, rifiuto delle password uguali a email/username. Il cambio password revoca tutte le sessioni.

## PIN operatore
Stesso schema (salt + scrypt), con tentativi limitati e blocco temporaneo: un PIN ha poca entropia, la protezione vera è il rate limit.

## Test
Hash diversi per la stessa password (salt), verifica corretta, password errata, formato corrotto, algoritmo sconosciuto, rehash quando i parametri cambiano. Nei test usa parametri ridotti iniettati per velocità, ma verifica a parte che i parametri di produzione siano quelli OWASP.
