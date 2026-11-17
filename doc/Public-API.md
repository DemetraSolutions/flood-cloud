# Flood Cloud — API Pubbliche

> **Documento destinato agli integratori esterni.** Contiene solo ciò che è pubblico.
> Regole di redazione (`GEMINI.md` §3): nessun riferimento a superfici interne, dettagli implementativi, database o informazioni utili a un attaccante; esempi completi di richiesta e risposta; mantenuto a ogni passo che tocca `/public/v1`.

## Introduzione
Le API pubbliche di Flood Cloud permettono ai sistemi di un'attività (per esempio un e-commerce o un gestionale) di leggere i propri dati in modo sicuro. La versione attuale offre **letture**: il profilo della propria chiave, i punti vendita, le aziende, i listini e le aliquote. Altri dati (prodotti, vendite, ordini, prenotazioni, clienti) arriveranno in versioni successive di questo documento.

- **URL di base:** `https://<host>/public/v1` *(host da definire)*
- **Formato:** JSON (`Content-Type: application/json; charset=utf-8`), date ISO 8601 in UTC, importi in centesimi interi.
- **Solo da server a server:** le chiavi non vanno mai inserite in pagine web, app distribuite o repository di codice. Le API non rispondono con alcuna intestazione CORS: una pagina web non può chiamarle.
- **Solo lettura:** tutti gli endpoint attuali sono `GET`.

## Autenticazione
Ogni richiesta include la propria API key nell'header `X-Api-Key`:
```http
GET /public/v1/me HTTP/1.1
Host: <host>
X-Api-Key: fc_pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/me
```
- La chiave si legge **solo** dall'header `X-Api-Key`: non è accettata nella URL, in un cookie o in altri header.
- Le chiavi si creano su richiesta al tuo referente Flood Cloud, che sceglie i permessi, le eventuali restrizioni, la scadenza e i limiti della chiave. **Un'attività può avere più chiavi**, per esempio una per ogni sistema che si integra.
- La chiave completa è mostrata **una sola volta** alla creazione: conservala in modo sicuro (un gestore di segreti, mai nel codice). Se la perdi, chiedine una nuova e fai revocare la precedente.
- Una chiave accede solo ai dati della propria attività ed eventualmente solo ad alcune aziende o punti vendita.
- Le API di un'attività sono attive solo dopo l'abilitazione da parte di Flood Cloud.
- Se la chiave è sconosciuta, revocata, scaduta o l'accesso dell'attività non è attivo, la risposta è sempre la stessa `401`: non indica quale sia il motivo.
```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Authentication required" } }
```
- Troppi tentativi con chiavi non valide dallo stesso indirizzo vengono rifiutati con `429` per un breve periodo, anche con una chiave buona. Una chiave scaduta non si riattiva: ne serve una nuova.

## Permessi
Ogni chiave ha uno o più permessi; una richiesta a un endpoint il cui permesso manca risponde `403`.

| Permesso | Consente |
|---|---|
| *(nessuno)* | `GET /me`: sempre ammesso per una chiave valida |
| `places:read` | `GET /places`, `GET /places/{placeId}` |
| `companies:read` | `GET /companies`, `GET /companies/{companyId}` |
| `catalog:read` | `GET /price-lists`, `GET /taxes` (listini e aliquote) |

Una chiave può essere **ristretta** a determinate aziende e/o a determinati punti vendita: vede solo quelli (se sono indicati entrambi, solo i punti vendita che soddisfano entrambe le restrizioni). Per le aziende e i punti vendita fuori dalle restrizioni, o di altre attività, la risposta è `404`, come se non esistessero. Listini e aliquote sono dell'attività intera e non sono ristretti.

## Limiti di utilizzo
Ogni chiave ha due limiti, scelti alla creazione (in mancanza, valgono quelli dell'attività: **60 richieste al minuto** e **10 000 richieste al giorno**). In più l'attività ha un **tetto per tutte le sue chiavi insieme** (in mancanza, **120 richieste al minuto** e **20 000 al giorno**): più chiavi non aggirano i limiti dell'attività. I quattro conteggi si applicano nell'ordine: minuto della chiave, minuto dell'attività, giorno della chiave, giorno dell'attività; il primo superato rifiuta la richiesta.

1. **Limite al minuto** (della chiave e dell'attività). Ogni risposta riporta lo stato del più stretto dei due:
   ```http
   RateLimit-Limit: 60
   RateLimit-Remaining: 54
   RateLimit-Reset: 42
   ```
   `RateLimit-Reset` è il numero di secondi alla riapertura della finestra. Oltre uno dei due limiti la risposta è `429` con `Retry-After` (secondi da attendere) e gli header del limite superato:
   ```http
   HTTP/1.1 429 Too Many Requests
   Retry-After: 42
   ```
   ```json
   { "error": { "code": "RATE_LIMITED", "message": "Too many requests" } }
   ```
2. **Quota giornaliera** (della chiave e dell'attività), sul giorno UTC. Oltre la quota la risposta è `429` con codice `QUOTA_EXCEEDED` e `Retry-After` con i secondi fino a mezzanotte UTC, quando la quota riparte. Gli header `RateLimit-*` descrivono solo i limiti al minuto e **non** sono presenti su questa risposta:
   ```json
   { "error": { "code": "QUOTA_EXCEEDED", "message": "Quota exceeded" } }
   ```
   Una richiesta rifiutata da un limite al minuto non consuma alcuna quota giornaliera; una chiave che ha già esaurito la propria quota giornaliera è rifiutata subito e non consuma nulla dell'attività (non riduce la capacità delle altre chiavi); una richiesta rifiutata dalla quota giornaliera dell'attività ha già contato nella quota della propria chiave. `GET /me` mostra i tuoi limiti, il tetto dell'attività e quante richieste hai già fatto oggi.

Buone pratiche: rispetta `Retry-After`, non ripetere subito una richiesta respinta, e usa la paginazione con pagine ampie (fino a 100 elementi) invece di molte richieste piccole.

## Errori
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "limit", "issue": "maximum" }] } }
```
| Codice HTTP | `error.code` | Significato |
|---|---|---|
| `401` | `UNAUTHENTICATED` | chiave assente, non valida, scaduta o revocata, oppure accesso dell'attività non attivo |
| `403` | `FORBIDDEN` | la chiave non ha il permesso per questa operazione |
| `404` | `NOT_FOUND` | risorsa inesistente, o non accessibile con questa chiave, o percorso inesistente |
| `405` | `METHOD_NOT_ALLOWED` | metodo non previsto per la risorsa (metodi ammessi nell'header `Allow`) |
| `422` | `VALIDATION_ERROR` | parametri non validi o non previsti (dettagli in `details`) |
| `429` | `RATE_LIMITED` / `QUOTA_EXCEEDED` | limite al minuto o quota giornaliera superati (della chiave o dell'attività) |
| `500` | `INTERNAL_ERROR` | errore del servizio; riprova più tardi |

I `details` di un `422` indicano il parametro (`field`) e il motivo (`issue`: per esempio `type`, `minimum`, `maximum`, `format`, `unknown`). I messaggi non contengono mai dettagli interni.

Ogni risposta contiene l'header `X-Request-Id`: indicalo quando segnali un problema all'assistenza.

## Paginazione
Le liste restituiscono al massimo `limit` elementi (default 50, **massimo 100**) in ordine alfabetico per nome, e un cursore per la pagina successiva:
```json
{ "data": [ ... ], "page": { "limit": 50, "next": "eyJ2ZXIiOjEs..." } }
```
Per la pagina successiva passa `?cursor=<next>` con lo **stesso valore** ricevuto, senza interpretarlo né modificarlo; `next: null` indica l'ultima pagina. Gli unici parametri ammessi sono `limit` e `cursor`: ogni altro parametro (filtri, ordinamenti, ricerca) è rifiutato con `422`. Un cursore alterato è rifiutato con `422`.
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/places?limit=100"
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/places?limit=100&cursor=eyJ2ZXIiOjEs..."
```
Le liste di listini e aliquote sono sempre complete (poche voci) e non hanno `page`.

## Endpoint

### GET /me
Descrive la chiave che sta chiamando, la sua attività, i suoi limiti e l'uso di oggi. Non richiede permessi. Utile per verificare la chiave e i suoi permessi.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/me
```
**Risposta** `200`
```json
{
  "data": {
    "key": {
      "id": "6650c0a1b2c3d4e5f6a7b8c9",
      "name": "Webshop",
      "prefix": "fc_pk_AbCdEf",
      "permissions": ["places:read", "companies:read"],
      "restrictions": { "companyIds": null, "placeIds": null },
      "expiresAt": null
    },
    "group": { "id": "665f1c2e9b1d4a0012ab34a1", "name": "Gruppo Esempio" },
    "limits": {
      "rateLimitPerMinute": 60,
      "dailyQuota": 10000,
      "group": { "rateLimitPerMinute": 120, "dailyQuota": 20000 }
    },
    "usageToday": { "calls": 42 }
  }
}
```
- `key.prefix` sono i primi caratteri della chiave, per riconoscerla (la chiave completa non è mai restituita).
- `restrictions`: elenchi degli identificativi delle aziende e dei punti vendita a cui la chiave è limitata, o `null` se non c'è restrizione.
- `expiresAt`: data di scadenza della chiave, o `null`.
- `limits`: i limiti della chiave e, in `group`, il tetto di tutte le chiavi dell'attività insieme.
- `usageToday.calls`: richieste contate oggi (giorno UTC) contro la quota, questa compresa.

### GET /places
Elenca i punti vendita dell'attività. **Permesso:** `places:read`. Parametri: `limit` (1–100, default 50), `cursor`.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/places?limit=2"
```
**Risposta** `200`
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab3421",
      "name": "Bar Roma",
      "companyId": "665f1c2e9b1d4a0012ab3411",
      "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
      "phone": "+39 02 1234567",
      "email": "bar@example.com",
      "status": "active",
      "timezone": "Europe/Rome"
    },
    {
      "id": "665f1c2e9b1d4a0012ab3422",
      "name": "Pizzeria Centro",
      "companyId": "665f1c2e9b1d4a0012ab3411",
      "address": { "street": "Corso Italia 10", "postcode": "10100", "city": "Torino", "province": "TO", "country": "IT" },
      "phone": null,
      "email": null,
      "status": "disabled",
      "timezone": "Europe/Rome"
    }
  ],
  "page": { "limit": 2, "next": "eyJ2ZXIiOjEs..." }
}
```
| Campo | Descrizione |
|---|---|
| `id` | identificativo del punto vendita |
| `name` | nome |
| `companyId` | identificativo dell'azienda a cui appartiene (`null` se non disponibile) |
| `address` | `street`, `postcode`, `city`, `province` (sigla), `country` (codice a due lettere); ogni parte può essere `null` |
| `phone`, `email` | contatti, `null` se assenti |
| `status` | `active` oppure `disabled` |
| `timezone` | fuso orario (per esempio `Europe/Rome`), `null` se non impostato |

I punti vendita eliminati o nel cestino non compaiono.

### GET /places/{placeId}
Un punto vendita. **Permesso:** `places:read`.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/places/665f1c2e9b1d4a0012ab3421
```
**Risposta** `200`
```json
{
  "data": {
    "id": "665f1c2e9b1d4a0012ab3421",
    "name": "Bar Roma",
    "companyId": "665f1c2e9b1d4a0012ab3411",
    "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "phone": "+39 02 1234567",
    "email": "bar@example.com",
    "status": "active",
    "timezone": "Europe/Rome"
  }
}
```
Errori: `404` se il punto vendita non esiste, non è dell'attività della chiave o è fuori dalle sue restrizioni; `422` se l'identificativo non è valido.

### GET /companies
Elenca le aziende dell'attività. **Permesso:** `companies:read`. Parametri: `limit`, `cursor`.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/companies"
```
**Risposta** `200`
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab3411",
      "name": "Acme S.r.l.",
      "vatNumber": "01114601006",
      "fiscalCode": "01114601006",
      "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
      "email": "info@acme.example",
      "phone": "+39 02 1234567"
    }
  ],
  "page": { "limit": 50, "next": null }
}
```
| Campo | Descrizione |
|---|---|
| `id` | identificativo dell'azienda |
| `name` | ragione sociale |
| `vatNumber`, `fiscalCode` | partita IVA e codice fiscale, `null` se assenti |
| `address` | come per i punti vendita |
| `email`, `phone` | contatti, `null` se assenti |

Una chiave ristretta ad alcuni punti vendita vede le aziende di quei punti vendita; una ristretta ad alcune aziende, solo quelle. Le aziende eliminate o nel cestino non compaiono.

### GET /companies/{companyId}
Un'azienda. **Permesso:** `companies:read`. Risposta `200` con un oggetto `data` della stessa forma di un elemento di `GET /companies`; `404` se non esiste, non è dell'attività della chiave o è fuori dalle sue restrizioni; `422` se l'identificativo non è valido.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/companies/665f1c2e9b1d4a0012ab3411
```
**Risposta** `200`
```json
{
  "data": {
    "id": "665f1c2e9b1d4a0012ab3411",
    "name": "Acme S.r.l.",
    "vatNumber": "01114601006",
    "fiscalCode": "01114601006",
    "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
    "email": "info@acme.example",
    "phone": "+39 02 1234567"
  }
}
```

### GET /price-lists
I listini dell'attività. **Permesso:** `catalog:read`. Nessun parametro.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/price-lists
```
**Risposta** `200`
```json
{
  "data": [
    { "id": "Zk3vQ0aT9bX2mN7pLw4HcA", "name": "Listino base", "enabled": true, "isDefault": true },
    { "id": "Hq8wS2dK5nB1yR6eTz3MxP", "name": "Listino asporto", "enabled": false, "isDefault": false }
  ]
}
```
`enabled`: il listino è in uso; `isDefault`: è il listino predefinito (uno solo).

### GET /taxes
Le aliquote IVA dell'attività. **Permesso:** `catalog:read`. Nessun parametro.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/taxes
```
**Risposta** `200`
```json
{
  "data": [
    { "id": "n1P8xQwR2cV5tYb7KdLm0g", "rate": 22, "department": 1, "description": null, "vatNature": null },
    { "id": "e4Tj7uV0hC3sA9fGq2WbNy", "rate": 0, "department": 5, "description": "Esente art. 10", "vatNature": "N4" }
  ]
}
```
`rate` è la percentuale; `department` il reparto fiscale (o `null`); `vatNature` il codice di natura IVA (da `N1` a `N6.9`) per le aliquote a zero, altrimenti `null`.

## Buone pratiche di integrazione
- Conserva la chiave in un gestore di segreti e **non** inserirla in repository, log o richieste di assistenza; se sospetti che sia esposta, chiedi subito la revoca.
- Usa una chiave per ogni sistema, con i soli permessi e le sole restrizioni che servono.
- Gestisci `401` (chiave non più valida: avvisa l'amministratore, non ripetere in ciclo), `403`, `404` e `429` (rispetta `Retry-After`).
- Metti in cache le letture che cambiano di rado (listini, aliquote, anagrafiche) invece di richiederle a ogni operazione.
- Registra l'header `X-Request-Id` delle risposte con errore.
