# Riferimento API

> Documento **mantenuto a ogni passo** (`GEMINI.md` §3): descrive **tutti** gli endpoint realizzati delle tre superfici. Regole di progettazione in `doc/API-Guidelines.md`, credenziali in `doc/Security-Model.md`.
> Gli endpoint della superficie pubblica sono descritti anche in `doc/Public-API.md`, la versione per gli integratori esterni.

## Convenzioni comuni
- Envelope: `{ "data": ... }`, liste con `page`, errori `{ "error": { "code", "message", "details" } }`.
- Date ISO 8601 UTC, importi in centesimi interi, identificativi stringa.
- Codici d'errore: tabella in `doc/API-Guidelines.md` §5.

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
