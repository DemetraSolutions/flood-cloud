---
name: webhook-verification
description: Usa quando ricevi webhook o callback da provider esterni (pagamenti, fiscale, fatturazione): body grezzo, verifica della firma a tempo costante, finestra anti-replay, idempotenza per id evento, elaborazione asincrona.
---
# Webhook Verification

## Regole
1. **Lo schema di firma è quello del provider**: leggi la sua documentazione ufficiale e implementalo esattamente (header, algoritmo, stringa firmata). Il pattern sotto è il caso HMAC generico.
2. **Body grezzo:** la firma si calcola sui byte ricevuti. Sulla route del webhook usa `bodyParser.raw({ type: '*/*', limit: '256kb' })` e fai il parse JSON **dopo** la verifica.
3. **Confronto a tempo costante** con `timingSafeEqual`, dopo aver verificato che le lunghezze coincidano.
4. **Anti-replay:** timestamp firmato entro una finestra (es. 5 minuti) e id evento registrato in una collection con indice univoco e TTL.
5. **Idempotenza:** un evento già visto risponde 200 senza rielaborarlo.
6. **Risposta rapida:** verifica, registra, rispondi 2xx; l'elaborazione pesante avviene dopo.
7. Il segreto del webhook è configurazione (o per tenant, cifrato), mai nel codice. La route è `anonymous: true` solo perché la firma è la sua autenticazione.

## Pattern HMAC
```js
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a hex HMAC-SHA256 signature over `${timestamp}.${rawBody}`.
 * @param {{ rawBody: Buffer, signature: string, timestamp: string, secret: string, now: number, toleranceMs: number }} input
 * @returns {boolean}
 */
export function verifyHmacSignature({ rawBody, signature, timestamp, secret, now, toleranceMs }) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts * 1000) > toleranceMs) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

## Test
Firma valida, firma errata, firma di lunghezza diversa, timestamp fuori finestra, evento duplicato, body modificato dopo la firma, segreto mancante in configurazione (avvio fallisce).
