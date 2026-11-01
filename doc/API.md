# Riferimento API

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive **tutti** gli endpoint realizzati delle tre superfici. Regole di progettazione in `doc/API-Guidelines.md`, credenziali in `doc/Security-Model.md`.
> Gli endpoint della superficie pubblica sono descritti anche in `doc/Public-API.md`, la versione per gli integratori esterni.

## Convenzioni comuni
- Envelope: `{ "data": ... }`, liste con `page`, errori `{ "error": { "code", "message", "details" } }`.
- Date ISO 8601 UTC, importi in centesimi interi, identificativi stringa.
- Codici d'errore: tabella in `doc/API-Guidelines.md` §5.
- Ogni risposta porta `X-Request-Id`, generato dal server (un valore inviato dal client non viene riutilizzato).
- Errori comuni a ogni percorso: `404 NOT_FOUND` (percorso inesistente), `405 METHOD_NOT_ALLOWED` con `Allow` (metodo non previsto), `400 BAD_REQUEST` (percorso o richiesta malformati). Sulle route con body: `400 MALFORMED_JSON`, `413 PAYLOAD_TOO_LARGE` (limite di default 100 KB), `415 UNSUPPORTED_MEDIA_TYPE` (content type diverso da `application/json` UTF-8 o body compresso).

## Endpoint di servizio
Fuori dalle superfici API, per le sonde di GKE.

### GET /health/live
- **Autenticazione e permesso:** anonimo (sonda di liveness dell'orchestratore)
- **Risposta:** `200`
  ```json
  { "data": { "status": "ok" } }
  ```

### GET /health/ready
- **Autenticazione e permesso:** anonimo (sonda di readiness dell'orchestratore)
- **Risposta:** `200` `{ "data": { "status": "ok" } }` se il servizio può ricevere traffico
- **Errori:** `503 SERVICE_UNAVAILABLE` durante l'arresto o se un controllo di prontezza fallisce (database non raggiungibile entro 2 s), senza dettagli
  ```json
  { "error": { "code": "SERVICE_UNAVAILABLE", "message": "Service unavailable" } }
  ```

## Formato di ogni endpoint
```markdown
### <METODO> <percorso>
- **Superficie:** backoffice | store | pubblica
- **Autenticazione e permesso:** es. Bearer backoffice, `products:read` — oppure anonimo (motivo)
- **Ruoli:** chi può chiamarlo e con quale perimetro
- **Parametri di percorso / query:** nome, tipo, obbligatorio, vincoli
- **Body:** schema con tipi e vincoli
- **Header particolari:** `Idempotency-Key`, `If-Match`…
- **Risposta:** codice e esempio
- **Errori:** codici possibili e quando
```

## Superficie backoffice — `/v1`
Nessun endpoint realizzato.

## Superficie server di punto vendita — `/store/v1`
Nessun endpoint realizzato.

## Superficie pubblica — `/public/v1`
Nessun endpoint realizzato.
