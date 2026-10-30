---
name: express-error-handling
description: Usa quando gestisci errori in Express 5: classe AppError con codici, gestore centrale, envelope di risposta standard, 404, nessuna fuga di stack trace o dettagli interni.
---
# Express 5 Error Handling

## Principi
- Express 5 inoltra automaticamente al gestore d'errori le **promise rifiutate** dei middleware/handler `async`: niente `try/catch` solo per chiamare `next(err)`.
- Un solo gestore centrale, registrato per ultimo.
- Il client riceve un **codice** stabile e un messaggio generico; i dettagli restano nei log del server.
- Mai inviare `err.message` di errori non previsti, stack trace, nomi di collection o messaggi del driver MongoDB.

## Envelope di risposta
```json
{ "data": { } }
{ "data": [ ], "page": { "limit": 50, "next": "<cursore opaco>" } }
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "email", "issue": "required" }] } }
```

## AppError
```js
/**
 * Errore applicativo previsto, tradotto dal gestore centrale in una risposta HTTP.
 */
export class AppError extends Error {
  /**
   * @param {number} status codice HTTP
   * @param {string} code codice stabile leggibile dai client (es. 'NOT_FOUND')
   * @param {string} message messaggio sicuro da mostrare al client
   * @param {Array<{field: string, issue: string}>} [details] dettagli di validazione
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
```

## Gestore centrale
```js
/**
 * Gestore d'errori finale: risponde con l'envelope standard senza esporre dettagli interni.
 * @param {(entry: object) => void} log funzione di log strutturato
 * @returns {import('express').ErrorRequestHandler}
 */
export function errorHandler(log) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'MALFORMED_JSON', message: 'Malformed JSON' } });
    }
    log({ level: 'error', requestId: req.id, err });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
  };
}
```

## Regole
1. Le route inesistenti finiscono in un handler 404 con `code: 'NOT_FOUND'`.
2. Le risorse di un altro tenant rispondono **404**, mai 403.
3. Ogni ramo del gestore ha il suo test (skill `node-test-coverage`).
4. Il log non contiene token, API key, password né body completi delle richieste.
