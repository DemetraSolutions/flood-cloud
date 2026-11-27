# Flood Cloud — API Pubbliche

> **Documento destinato agli integratori esterni.** Contiene solo ciò che è pubblico.
> Regole di redazione (`GEMINI.md` §3): nessun riferimento a superfici interne, dettagli implementativi, database o informazioni utili a un attaccante; esempi completi di richiesta e risposta; mantenuto a ogni passo che tocca `/public/v1`.

## Introduzione
Le API pubbliche di Flood Cloud permettono ai sistemi di un'attività (per esempio un e-commerce o un gestionale) di leggere i propri dati in modo sicuro. La versione attuale offre: il profilo della propria chiave, i punti vendita, le aziende, i listini e le aliquote (sola lettura) e il **catalogo**: prodotti, categorie, marche, gruppi di attributi, reparti e giacenze in lettura; prodotti e categorie anche in scrittura; i **contatti** (clienti e fornitori) con i loro gruppi, e le **carte fedeltà** avanzate con credito e punti. Altri dati (vendite, ordini, prenotazioni) arriveranno in versioni successive di questo documento.

- **URL di base:** `https://<host>/public/v1` *(host da definire)*
- **Formato:** JSON (`Content-Type: application/json; charset=utf-8`), date ISO 8601 in UTC, importi in centesimi interi.
- **Solo da server a server:** le chiavi non vanno mai inserite in pagine web, app distribuite o repository di codice. Le API non rispondono con alcuna intestazione CORS: una pagina web non può chiamarle.
- **Lettura e scrittura:** gli endpoint sono `GET`, tranne quelli di scrittura del catalogo (`POST`, `PATCH`, `DELETE`), che richiedono il permesso `catalog:write` (vedi "Catalogo"), `contacts:write` (vedi "Contatti") o `fidelityCards:write` (vedi "Carte fedeltà").

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
| `catalog:read` | `GET /price-lists`, `GET /taxes`, `GET /currencies`, `GET /measure-units` (listini, aliquote, valute e unità di misura) e **tutte le letture del catalogo**: prodotti, categorie, marche, gruppi di attributi, reparti e giacenze |
| `catalog:write` | **le scritture del catalogo**: creare, modificare, cestinare e ripristinare i prodotti; creare, modificare ed eliminare le categorie |
| `contacts:read` | **dati personali**: `GET /contacts`, `GET /contacts/{contactId}`, `GET /contact-groups`, `GET /contact-groups/{contactGroupId}` |
| `contacts:write` | creare, modificare, cestinare e ripristinare i contatti |
| `fidelityCards:read` | `GET /fidelity-cards`, `GET /fidelity-cards/{cardId}`, `GET /fidelity-cards/{cardId}/movements` (credito e punti delle carte) |
| `fidelityCards:write` | **muove credito prepagato**: creare carte (anche con credito e punti iniziali), cambiarne tipo e stato, rettificare credito e punti |
| `sales:read` | `GET /sales`, `GET /sales/{saleId}`: gli scontrini e le fatture dei punti vendita (importi in centesimi, **nessun dato personale del cliente**) |

`catalog:write` si concede solo alle chiavi che devono scrivere e **non include** `catalog:read`: una chiave di sola scrittura riceve la voce che ha scritto, ma non legge il catalogo. Per scrivere e rileggere servono entrambi. Lo stesso vale per `contacts:write` e `fidelityCards:write`, che **non includono** `contacts:read` e `fidelityCards:read`. Concedi `contacts:read` e `fidelityCards:write` solo a sistemi fidati: il primo dà accesso a dati personali, il secondo permette di spendere o accreditare credito.

Una chiave può essere **ristretta** a determinate aziende e/o a determinati punti vendita: vede solo quelli (se sono indicati entrambi, solo i punti vendita che soddisfano entrambe le restrizioni). Per le aziende e i punti vendita fuori dalle restrizioni, o di altre attività, la risposta è `404`, come se non esistessero. Listini e aliquote sono dell'attività intera e non sono ristretti. **Contatti, gruppi di contatti e carte fedeltà non sono ristretti**: sono dell'attività intera, e una chiave ristretta li vede e li modifica tutti. Le restrizioni valgono invece per il catalogo e **definiscono che cosa la chiave può scrivere** (vedi "Catalogo: il perimetro della chiave").

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

Le **scritture** (catalogo, contatti e carte fedeltà) hanno un limite in più: **60 scritture al minuto per chiave, in totale** (in mancanza di un valore diverso concordato). Oltre il limite la risposta è `429` con `Retry-After`, prima ancora che il corpo della richiesta sia letto. Ogni richiesta, scritture comprese, conta nei limiti al minuto, nella quota giornaliera e nel conteggio d'uso della chiave.

Buone pratiche: rispetta `Retry-After`, non ripetere subito una richiesta respinta, e usa la paginazione con pagine ampie (fino a 100 elementi) invece di molte richieste piccole.

## Errori
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [{ "field": "limit", "issue": "maximum" }] } }
```
| Codice HTTP | `error.code` | Significato |
|---|---|---|
| `401` | `UNAUTHENTICATED` | chiave assente, non valida, scaduta o revocata, oppure accesso dell'attività non attivo |
| `403` | `FORBIDDEN` | la chiave non ha il permesso per questa operazione |
| `403` | `FEATURE_DISABLED` | la funzione dell'attività necessaria (per esempio il magazzino per le giacenze, la cassa per i reparti) non è attiva |
| `404` | `NOT_FOUND` | risorsa inesistente, o non accessibile con questa chiave, o percorso inesistente |
| `405` | `METHOD_NOT_ALLOWED` | metodo non previsto per la risorsa (metodi ammessi nell'header `Allow`) |
| `409` | `CONFLICT` | scrittura in conflitto con lo stato della risorsa (per esempio un prodotto nel cestino, una categoria ancora in uso, un `Idempotency-Key` già usato con un corpo diverso) |
| `412` | `PRECONDITION_FAILED` | la risorsa è cambiata dopo l'ultima lettura (`If-Match` non più valido) |
| `413` | `PAYLOAD_TOO_LARGE` | corpo oltre il limite (256 KB per un prodotto, 128 KB per una categoria, 64 KB per un contatto, 16 KB per una carta) |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | corpo non JSON |
| `422` | `VALIDATION_ERROR` | parametri o corpo non validi o non previsti (dettagli in `details`) |
| `429` | `RATE_LIMITED` / `QUOTA_EXCEEDED` | limite al minuto o quota giornaliera superati (della chiave o dell'attività) |
| `500` | `INTERNAL_ERROR` | errore del servizio; riprova più tardi |

I `details` di un `422` indicano il parametro o il campo del corpo (`field`) e il motivo (`issue`: per esempio `type`, `minimum`, `maximum`, `format`, `unknown`, `required`, `notAllowed`, `incorrect`). I messaggi non contengono mai dettagli interni.

Ogni risposta contiene l'header `X-Request-Id`: indicalo quando segnali un problema all'assistenza.

## Paginazione
Le liste restituiscono al massimo `limit` elementi (default 50, **massimo 100**) in ordine alfabetico per nome, e un cursore per la pagina successiva:
```json
{ "data": [ ... ], "page": { "limit": 50, "next": "eyJ2ZXIiOjEs..." } }
```
Per la pagina successiva passa `?cursor=<next>` con lo **stesso valore** ricevuto, senza interpretarlo né modificarlo; `next: null` indica l'ultima pagina. Per punti vendita e aziende gli unici parametri ammessi sono `limit` e `cursor`: ogni altro parametro (filtri, ordinamenti, ricerca) è rifiutato con `422`. Le liste del catalogo hanno parametri propri e un ordine proprio (vedi "Catalogo"). Un cursore alterato è rifiutato con `422`.
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

### GET /currencies
Le valute dell'attività. **Permesso:** `catalog:read`. Nessun parametro.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/currencies
```
**Risposta** `200`
```json
{
  "data": [
    { "code": "EUR", "symbol": "€" },
    { "code": "USD", "symbol": "$" }
  ]
}
```
`code` è il codice di tre lettere (ISO 4217); `symbol` il simbolo da mostrare. L'elenco è completo (al più 10 voci), senza paginazione, e uguale per ogni chiave con il permesso, anche se ristretta a certe aziende o punti vendita: sono dati dell'attività.

### GET /measure-units
Le unità di misura dell'attività. **Permesso:** `catalog:read`. Nessun parametro.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/measure-units
```
**Risposta** `200`
```json
{
  "data": [
    { "id": "unita-pezzi", "value": "pz", "name": "pz" },
    { "id": "unita-chili", "value": "kg", "name": "kg" }
  ]
}
```
`value` è il testo dell'unità (come lo portano i prodotti); `name` è il nome da mostrare, oggi uguale a `value`. L'elenco è completo (al più 50 voci), senza paginazione, e uguale per ogni chiave con il permesso.

## Catalogo

Il catalogo dell'attività: prodotti (compresi servizi e varianti), categorie, marche, gruppi di attributi, reparti e giacenze. Si legge con `catalog:read` e, per prodotti e categorie, si scrive con `catalog:write`. Marche, gruppi di attributi, reparti e giacenze sono **solo in lettura**.

### Convenzioni

- **Prezzi in centesimi interi, IVA inclusa.** Ogni regola di prezzo ha `grossCents` (per esempio `1999` per 19,99 euro; da 0 a 100 000 000 000) e l'aliquota che la governa (`taxId`, come in `GET /taxes`). In lettura trovi anche `taxRatePercent` (sola lettura). In scrittura mandi `grossCents` e `taxId`: l'importo senza IVA lo calcola Flood Cloud. Le conversioni sono esatte al centesimo (un importo memorizzato con una frazione di centesimo si legge arrotondato e, se lo rimandi invariato, resta quello memorizzato); se rimandi una regola come l'hai letta (senza `taxRatePercent`) non cambia nulla.
- **Stato.** Prodotti, categorie, marche e reparti hanno `status`: `active`, `disabled` (disattivato) e, solo per i prodotti, `trashed` (nel cestino). Si scrive `active` o `disabled`; per cestinare e ripristinare un prodotto ci sono due endpoint dedicati.
- **Lingue.** I testi (`name`, `description`…) sono oggetti per lingua: `{ "it": "Acqua", "en": "Water" }`. Alla creazione serve almeno il nome nella prima lingua dell'attività; le lingue non attive dell'attività sono rifiutate.
- **Versioni (`ETag` e `If-Match`).** Ogni risposta che contiene un prodotto, una categoria, una marca, un gruppo di attributi o un reparto ha l'header `ETag`. Per **modificare**, cestinare o ripristinare invia `If-Match` con l'`ETag` che hai letto: se la voce è cambiata nel frattempo la risposta è `412` e devi rileggerla. Senza `If-Match`, o con un valore non valido, è `422`.
- **Creazioni idempotenti (`Idempotency-Key`).** Le creazioni (`POST /products`, `POST /categories`) richiedono l'header `Idempotency-Key` con un UUID generato da te: se non sai se la richiesta è andata a buon fine, ripetila con la **stessa chiave e lo stesso corpo** e ricevi la stessa risposta della prima volta, senza creare un duplicato. La stessa chiave con un corpo diverso è `409`. Le chiavi valgono 24 ore e sono legate alla tua chiave API.
- **I campi che non vedi restano invariati.** Una scrittura cambia solo ciò che invii. Se rimandi una voce come l'hai letta (anche con una chiave ristretta) non cambia nulla e l'`ETag` resta lo stesso: i dati che l'API non mostra (per esempio la quantità caricata dei codici a barre, i dati di produzione e di sala di un punto vendita, la portata del menu), i riferimenti a prodotti che la tua chiave non raggiunge (anche se nel cestino) nelle liste di varianti, menu e scelte, e l'importo esatto di un prezzo il cui valore arrotondato al centesimo è quello che rimandi, **restano come sono**. Per togliere un riferimento a un prodotto che non raggiungi non c'è modo: chiedilo a chi amministra l'attività.
- **Cosa non c'è mai.** Costi, fornitori, immagini, postazioni di stampa delle comande, impostazioni di sala e dati interni non compaiono in lettura e sono rifiutati in scrittura (`422`, `unknown`). Non esistono l'eliminazione definitiva di un prodotto, lo svuotamento del cestino, la duplicazione e le scritture su marche, gruppi di attributi, reparti e giacenze.

### Catalogo: il perimetro della chiave

La chiave vede e scrive il catalogo **come un amministratore** dei punti vendita a cui è ristretta:

- **Chiave senza restrizioni** (tutta l'attività): come un amministratore dell'attività. Legge tutto e modifica per intero ogni prodotto e ogni categoria, anche quelli "per tutti" i punti vendita.
- **Chiave ristretta a punti vendita o ad aziende** (per le aziende contano i loro punti vendita): vede solo le voci disponibili **nei suoi punti vendita** o **per tutti** i punti vendita; una voce disponibile solo in altri punti vendita non esiste per lei (`404`). In scrittura:
  - una voce disponibile **solo nei suoi punti vendita** si modifica per intero, si cestina e (per le categorie) si elimina;
  - una voce **condivisa** con altri punti vendita, o disponibile **per tutti**, si modifica solo nei **dati dei suoi punti vendita** (per i prodotti la sezione `places`); per ogni altro campo la risposta è `403` con il nome del campo in `details` (`{ "field": "name", "issue": "notAllowed" }`). Il campo `editable` dice se la chiave può modificare la voce per intero;
  - una nuova voce deve dichiarare **i suoi punti vendita** (`places`) e solo punti vendita della chiave (altrimenti `403`); una voce "per tutti" non si può creare;
  - **eccezione:** se l'attività ha **un solo punto vendita** (fuori dal cestino) le voci "per tutti" sono interamente sue e se ne possono creare. Appena nasce un secondo punto vendita tornano valide le regole sopra.
- Una chiave le cui restrizioni non corrispondono ad alcun punto vendita attivo non vede il catalogo (`404`).
- Dei dati per punto vendita (`places`, giacenze) la chiave riceve **solo quelli dei suoi punti vendita**. Gli identificativi di altri prodotti (modificatori, scelte dei menu) compaiono solo se il prodotto è raggiungibile dalla chiave.

### Catalogo: che cosa non è ristretto

- Gli identificativi delle **categorie** (`categoryIds` dei prodotti, `modifierCategoryIds`, `menu[].categoryId`, `modifierChoices[].categoryId`) **non sono filtrati** per perimetro, come per un amministratore di un punto vendita: la chiave può leggerli e usarli anche se la categoria è di altri punti vendita (la categoria stessa, se non è nel suo perimetro, risponde `404`).
- Gli **avvisi sui duplicati** (`warnings`: codice, PLU, codice a barre già usati) considerano **tutti i prodotti dell'attività**, anche quelli fuori dal perimetro della chiave: segnalano che un valore è già usato, non quale prodotto lo usa.
- **`DELETE /categories/{categoryId}` non richiede `If-Match`**: elimina la categoria che esiste in quel momento (se è usata la risposta è comunque `409`).

### Catalogo: aggiornamento incrementale

Gli elenchi del catalogo sono ordinati **dal meno recente al più recente** per data di modifica (`updatedAt`), a pagine con cursore, e accettano `updatedSince` (un istante ISO 8601, per esempio `2026-11-24T09:30:00.000Z`, oppure solo la data).

- **Senza `updatedSince`**: solo le voci **attive** (per i prodotti, non nel cestino). È la lettura per il primo scaricamento.
- **Con `updatedSince`**: **ogni voce modificata da quell'istante in poi (compreso)**, **anche quelle disattivate (`status: "disabled"`) e, per i prodotti, quelle nel cestino (`status: "trashed"`)**: sono il segnale per toglierle dalla tua copia.

Procedura: scarica tutto a pagine fino a `page.next: null`; conserva il più grande `updatedAt` visto; a ogni aggiornamento richiedi `updatedSince=<quel valore>`. La voce con quello stesso `updatedAt` torna anche nella lettura successiva: riconoscila per `id`. Una voce modificata mentre leggi le pagine passa in fondo all'elenco: la rivedrai, non la perdi. Per ogni voce ricevuta: se `status` non è `active`, toglila; altrimenti sostituiscila.

**Attenzione:** una voce **eliminata per sempre** (categorie, marche, gruppi di attributi) o che esce dal perimetro della tua chiave non compare nell'aggiornamento incrementale. Fai una **rilettura completa periodica** (per esempio ogni notte): ricostruisci l'elenco e scarta gli identificativi non più presenti.

### GET /products
Elenca i prodotti, **interi**. **Permesso:** `catalog:read`. Parametri: `limit` (1–50, default 25), `cursor`, `family` (`products`, `services`, `tgm` per tabacchi, giochi e monopoli, `modifiers` per le varianti; senza, tutte), `updatedSince`, `ecommerce=true` (solo i prodotti disponibili per l'e-commerce). Senza `updatedSince` ricevi i prodotti **attivi e non nel cestino**.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/products?limit=1&family=products"
```
**Risposta** `200`
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab3501",
      "family": "products",
      "type": "product",
      "isModifier": false,
      "status": "active",
      "code": "ACQ-05",
      "name": { "it": "Acqua naturale 0,5 l" },
      "shortName": { "it": "Acqua 0,5" },
      "description": { "it": "Bottiglia in PET" },
      "shortDescription": { "it": "" },
      "favorite": false,
      "generic": false,
      "noDiscount": false,
      "brandId": "665f1c2e9b1d4a0012ab3601",
      "categoryIds": ["665f1c2e9b1d4a0012ab3701"],
      "attributeIds": [],
      "position": null,
      "availability": { "pos": true, "warehouse": true, "ecommerce": true },
      "featured": false,
      "validFrom": null,
      "validTo": null,
      "loadUnit": "pz",
      "unloadUnit": "pz",
      "conversionRatio": 1,
      "barcodes": [{ "value": "8000000000001", "saleQuantity": 1 }],
      "prices": [
        {
          "id": "Zk3vQ0aT9bX2mN7pLw4HcA",
          "priceListId": "Zk3vQ0aT9bX2mN7pLw4HcB",
          "currency": "EUR",
          "taxId": "n1P8xQwR2cV5tYb7KdLm0g",
          "taxRatePercent": 22,
          "grossCents": 120,
          "discountPercent": 0,
          "validFrom": null,
          "validTo": null,
          "dailyFrom": null,
          "dailyTo": null,
          "weekDays": [],
          "fromQuantity": 1,
          "maxSaleQuantity": null
        }
      ],
      "places": [{ "placeId": "665f1c2e9b1d4a0012ab3421", "favorite": true, "position": null }],
      "menu": [],
      "modularPriceRule": null,
      "shipping": { "width": null, "height": null, "depth": null, "weight": null },
      "editable": true,
      "trashedAt": null,
      "createdAt": "2024-03-01T09:00:00.000Z",
      "updatedAt": "2026-11-20T09:00:00.000Z"
    }
  ],
  "page": { "limit": 1, "next": "eyJ2ZXIiOjEs..." }
}
```
- `places`: i punti vendita **della chiave** in cui il prodotto è disponibile; **vuoto** = disponibile per tutti i punti vendita.
- `prices`: una voce per regola di prezzo. `fromQuantity` è la quantità minima da cui vale (prezzi a scaglioni); `validFrom`/`validTo` un periodo; `dailyFrom`/`dailyTo` una fascia oraria (`HH:mm`); `weekDays` i giorni (0 = domenica … 6 = sabato; vuoto = tutti); `discountPercent` lo sconto in percentuale.
- I campi che dipendono da funzioni dell'attività (`plu`, `duration`, `maxConcurrent`, `availability`, `featured`, `scaleType`, `loadUnit`, `unloadUnit`, `conversionRatio`, gli elenchi di modificatori…) compaiono solo se l'attività ha la funzione.
- `modifier` (solo per le varianti), `requiredModifierIds`, `modifierIds`, `excludedModifierIds`, `modifierCategoryIds`, `menu` e `modifierChoices` descrivono varianti e menu; gli identificativi di altri prodotti sono solo quelli raggiungibili dalla chiave.

### GET /products/{productId}
Un prodotto, con l'header `ETag`. **Permesso:** `catalog:read`. Un prodotto nel cestino si legge, con `status: "trashed"` e `trashedAt`. In più, `warnings` segnala un codice, un PLU o un codice a barre che altri prodotti usano già (la scrittura riesce comunque):
```json
{ "data": { "id": "665f1c2e9b1d4a0012ab3501", "status": "active", "code": "ACQ-05", "warnings": [{ "field": "barcodes.0", "issue": "duplicate" }] } }
```
*(risposta abbreviata: contiene tutti i campi del prodotto, come in elenco)*. `404` se il prodotto non esiste o non è nel perimetro della chiave.

### GET /products/{productId}/stock e GET /stock
Le giacenze, **in sola lettura**, per punto vendita e deposito. **Permesso:** `catalog:read`. Disponibili se l'attività ha la funzione di magazzino (altrimenti `403` con codice `FEATURE_DISABLED`). Solo i punti vendita della chiave.
- `GET /products/{productId}/stock`: le giacenze di un prodotto.
- `GET /stock`: a pagine (`limit` 1–50, default 25, `cursor`), i prodotti che movimentano il magazzino e non sono nel cestino.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" https://<host>/public/v1/products/665f1c2e9b1d4a0012ab3501/stock
```
**Risposta** `200`
```json
{
  "data": {
    "productId": "665f1c2e9b1d4a0012ab3501",
    "code": "ACQ-05",
    "updatedAt": "2026-11-20T09:00:00.000Z",
    "stock": [
      { "placeId": "665f1c2e9b1d4a0012ab3421", "storageId": "665f1c2e9b1d4a0012ab3801", "quantity": 48, "min": 12, "max": 96, "location": "A1" }
    ]
  }
}
```
`quantity` è la quantità in giacenza nell'unità di carico del prodotto; `min`, `max` e `location` possono essere `null`. `updatedAt` è la data dell'ultima modifica del **prodotto**: le giacenze si muovono con il magazzino, quindi per tenerle allineate rileggi periodicamente `GET /stock` invece di affidarti a `updatedSince`.

### POST /products
Crea un prodotto. **Permesso:** `catalog:write`. Richiede `Idempotency-Key`. Il corpo ha come unico campo obbligatorio `name`; ogni altro campo è facoltativo. Campi ammessi: `type` (`product`, `service`, `exempt`, `tobaccos`, `games`, `monopoly`), `status` (`active`/`disabled`), `code`, `plu`, `barcodes` (`[{ "value", "saleQuantity" }]`, senza valori ripetuti), `favorite`, `generic`, `noDiscount`, `brandId`, `categoryIds`, `attributeIds`, `position`, `duration`, `maxConcurrent`, `availability`, `featured`, `validFrom`, `validTo`, `shortName`, `description`, `shortDescription`, `prices`, `places`, `shipping`, `scaleType`, `loadUnit`, `unloadUnit`, `conversionRatio`, e per varianti e menu `isModifier`, `modifier`, `requiredModifierIds`, `modifierIds`, `excludedModifierIds`, `modifierCategoryIds`, `menu`, `modifierChoices`, `modularPriceRule`. Ogni campo che non è in questo elenco è rifiutato con `422` (`unknown`). Un campo che dipende da una funzione che l'attività non ha è rifiutato con `422` (`notAllowed`).

Un prezzo si scrive così:
```json
{ "priceListId": "Zk3vQ0aT9bX2mN7pLw4HcB", "currency": "EUR", "taxId": "n1P8xQwR2cV5tYb7KdLm0g", "grossCents": 120, "discountPercent": 0, "fromQuantity": 1 }
```
`id` si omette in creazione; `validFrom`/`validTo`, `dailyFrom`/`dailyTo`, `weekDays`, `maxSaleQuantity` sono facoltativi.

**Richiesta**
```sh
curl -X POST https://<host>/public/v1/products \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H "Idempotency-Key: <UUID generato dal tuo sistema>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": { "it": "Acqua naturale 0,5 l" },
    "code": "ACQ-05",
    "barcodes": [{ "value": "8000000000001", "saleQuantity": 1 }],
    "categoryIds": ["665f1c2e9b1d4a0012ab3701"],
    "prices": [{ "priceListId": "Zk3vQ0aT9bX2mN7pLw4HcB", "currency": "EUR", "taxId": "n1P8xQwR2cV5tYb7KdLm0g", "grossCents": 120 }],
    "places": [{ "placeId": "665f1c2e9b1d4a0012ab3421", "favorite": true }]
  }'
```
**Risposta** `201` con l'header `Location: /public/v1/products/665f1c2e9b1d4a0012ab3501` e l'`ETag` della versione; il corpo è il prodotto completo (come in `GET /products/{productId}`).

Errori: `403` (punti vendita non della chiave, o prodotto "per tutti" non consentito alla chiave), `422` (campi non validi, listino o aliquota inesistenti, riferimenti non validi, lingua non attiva), `413`, `415`, `429`.

### PATCH /products/{productId}
Modifica un prodotto. **Permesso:** `catalog:write`. Richiede `If-Match`. Corpo: uno o più campi di quelli della creazione (almeno uno). I testi per lingua si fondono (`{ "it": null }` toglie una lingua); gli altri campi sostituiscono il valore, e `prices`, `barcodes`, `places` e gli elenchi di identificativi sostituiscono **l'intera lista** (con una chiave ristretta, `places` sostituisce solo i punti vendita della chiave e lascia quelli degli altri): per cambiare un prezzo rimanda tutte le regole (con `id` quelle che esistono, senza `id` quelle nuove; una regola non rimandata è tolta). Una modifica che non cambia nulla non scrive nulla e risponde con la stessa versione.

**Richiesta**
```sh
curl -X PATCH https://<host>/public/v1/products/665f1c2e9b1d4a0012ab3501 \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H 'If-Match: "ofQyXEWYuR1LURZT2EB4zAb4gmcNZ2kptw2o6mGKnOE"' \
  -H "Content-Type: application/json" \
  -d '{ "prices": [{ "id": "Zk3vQ0aT9bX2mN7pLw4HcA", "priceListId": "Zk3vQ0aT9bX2mN7pLw4HcB", "currency": "EUR", "taxId": "n1P8xQwR2cV5tYb7KdLm0g", "grossCents": 130 }] }'
```
**Risposta** `200` con il prodotto aggiornato e il nuovo `ETag`.

Errori: `403` (campo non modificabile dalla chiave su una voce condivisa), `404`, `409` (il prodotto è nel cestino o è cambiato mentre si scriveva), `412`, `422`, `429`.

### POST /products/{productId}/trash e POST /products/{productId}/restore
Sposta un prodotto nel cestino, o lo toglie dal cestino. **Permesso:** `catalog:write`. Richiedono `If-Match`; nessun corpo. Rispondono `200` con il prodotto (`status: "trashed"` oppure di nuovo `active`/`disabled`) e il nuovo `ETag`. `409` se il prodotto è già nel cestino (o non lo è), `412`, `403`, `404`. Un prodotto nel cestino non si modifica e non compare negli elenchi senza `updatedSince`. **Non esiste** l'eliminazione definitiva.

### GET /categories
Elenca le categorie. **Permesso:** `catalog:read`. Parametri: `limit` (1–100, default 50), `cursor`, `updatedSince`. Senza `updatedSince`, solo le categorie attive.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/categories?limit=50"
```
**Risposta** `200`
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab3701",
      "name": { "it": "Bevande" },
      "description": { "it": "" },
      "status": "active",
      "parentId": null,
      "position": 1,
      "availability": { "pos": true, "ecommerce": true },
      "noDiscount": false,
      "requiresLegalAge": false,
      "featured": false,
      "places": [{ "placeId": "665f1c2e9b1d4a0012ab3421", "position": 1 }],
      "editable": true,
      "createdAt": "2024-03-01T09:00:00.000Z",
      "updatedAt": "2026-11-20T09:00:00.000Z"
    }
  ],
  "page": { "limit": 50, "next": null }
}
```
`parentId` è la categoria madre (`null` per una categoria radice). `places` vuoto = per tutti i punti vendita.

### GET /categories/tree
L'albero compatto delle categorie raggiungibili dalla chiave, con `ETag` debole e risposta `304` a `If-None-Match`. **Permesso:** `catalog:read`. Nessun parametro. `409` in un'attività con troppe categorie: usa l'elenco.
```json
{ "data": [{ "id": "665f1c2e9b1d4a0012ab3701", "name": "Bevande", "parentId": null, "position": 1, "status": "active", "children": [] }] }
```
`name` è nella prima lingua dell'attività.

### GET /categories/{categoryId}
Una categoria, con `ETag` (stessa forma dell'elenco). **Permesso:** `catalog:read`. `404` se non esiste o non è nel perimetro.

### POST /categories
Crea una categoria. **Permesso:** `catalog:write`. Richiede `Idempotency-Key`. Obbligatorio `name`. Campi ammessi: `description`, `status`, `parentId`, `position`, `availability` (`pos`, `ecommerce`), `noDiscount`, `requiresLegalAge`, `featured`, `tobacco`, `modifierIds`, `modifierCategoryIds`, `places` (`[{ "placeId", "position" }]`). Gli altri campi sono rifiutati (`422`, `unknown`).

**Richiesta**
```sh
curl -X POST https://<host>/public/v1/categories \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H "Idempotency-Key: <UUID generato dal tuo sistema>" \
  -H "Content-Type: application/json" \
  -d '{ "name": { "it": "Bibite" }, "parentId": "665f1c2e9b1d4a0012ab3701", "places": [{ "placeId": "665f1c2e9b1d4a0012ab3421" }] }'
```
**Risposta** `201`, `Location: /public/v1/categories/<id>`, `ETag`, e la categoria nel corpo. Errori: `403`, `422` (per esempio un `parentId` inesistente o che creerebbe un ciclo), `429`.

### PATCH /categories/{categoryId}
Modifica una categoria. **Permesso:** `catalog:write`. Richiede `If-Match`; almeno un campo. `422` se la modifica creerebbe un ciclo di categorie. `403`, `404`, `412`.

### DELETE /categories/{categoryId}
Elimina una categoria **per sempre**. **Permesso:** `catalog:write`. Risponde `204`. `409` se qualcosa la usa (una categoria figlia o un prodotto): sposta o togli prima i riferimenti; non c'è eliminazione a cascata. `403` per una categoria condivisa o "per tutti" (con una chiave ristretta), `404`.

### GET /brands e GET /brands/{brandId}
Le marche. **Permesso:** `catalog:read`. Parametri: `limit` (1–100, default 50), `cursor`, `updatedSince`. Solo lettura.
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab3601",
      "name": { "it": "Acme" },
      "description": { "it": "" },
      "status": "active",
      "placeIds": [],
      "createdAt": "2024-03-01T09:00:00.000Z",
      "updatedAt": "2026-11-20T09:00:00.000Z"
    }
  ],
  "page": { "limit": 50, "next": null }
}
```
`placeIds` vuoto = per tutti i punti vendita. Il dettaglio ha la stessa forma, con l'`ETag`.

### GET /attribute-groups e GET /attribute-groups/{attributeGroupId}
I gruppi di attributi (per esempio "Taglie") con i loro attributi, a cui i prodotti si riferiscono con `attributeIds`. **Permesso:** `catalog:read`. Parametri come le marche. Solo lettura.
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab3901",
      "name": { "it": "Taglie" },
      "attributes": [
        { "id": "a1b2c3d4e5f6", "name": { "it": "S" } },
        { "id": "f6e5d4c3b2a1", "name": { "it": "M" } }
      ],
      "createdAt": null,
      "updatedAt": "2026-11-20T09:00:00.000Z"
    }
  ],
  "page": { "limit": 50, "next": null }
}
```
I gruppi di attributi non hanno `status`: non possono essere disattivati.

### GET /departments e GET /departments/{departmentId}
I reparti di cassa. **Permesso:** `catalog:read`. Parametri come le marche. Solo lettura. Disponibili se l'attività ha la funzione di cassa (altrimenti `403` `FEATURE_DISABLED`).
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab3a01",
      "code": 1,
      "name": { "it": "Alimentari" },
      "description": { "it": "" },
      "status": "active",
      "taxId": "n1P8xQwR2cV5tYb7KdLm0g",
      "taxRatePercent": 22,
      "noDiscount": false,
      "placeIds": [],
      "createdAt": "2024-03-01T09:00:00.000Z",
      "updatedAt": "2026-11-20T09:00:00.000Z"
    }
  ],
  "page": { "limit": 50, "next": null }
}
```

## Contatti

I contatti dell'attività (clienti, fornitori e altri) e i loro gruppi. Si leggono con `contacts:read` e si scrivono con `contacts:write`. I gruppi di contatti sono **solo in lettura**. I contatti sono dell'attività intera: anche una chiave ristretta ad aziende o punti vendita li vede e li modifica tutti.

### Che cosa contiene un contatto

```json
{
  "id": "665f1c2e9b1d4a0012ab5001",
  "code": "K-0042",
  "customer": true,
  "supplier": false,
  "displayName": "Mario Rossi",
  "contactGroupId": "665f1c2e9b1d4a0012ab5101",
  "person": {
    "firstName": "Mario",
    "lastName": "Rossi",
    "taxCode": "RSSMRA80A01F205X",
    "birthDate": "1980-01-01",
    "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "countryCode": "IT", "areaCode": "MI" },
    "phones": ["+39 02 123456"],
    "emails": ["mario@example.com"],
    "discountPercent": 10,
    "associatedCompanyId": null
  },
  "company": {
    "name": "",
    "vatNumber": "",
    "taxCode": "",
    "address": { "street": "", "postcode": "", "city": "", "countryCode": null, "areaCode": null },
    "phones": [],
    "emails": [],
    "faxes": [],
    "discountPercent": null
  },
  "fidelityCards": [
    { "code": "CARD-1", "advanced": false, "points": 120 },
    { "code": "GOLD-9", "advanced": true, "card": { "cardId": "665f1c2e9b1d4a0012ab6001", "cardType": { "id": "Zk3vQ0aT9bX2mN7pLw4HcB", "name": "Prepagata" }, "enabled": true, "balance": 12.5, "totalPoints": 40 } }
  ],
  "trashed": false,
  "createdAt": "2024-03-01T09:00:00.000Z",
  "updatedAt": "2026-11-20T09:00:00.000Z"
}
```
- `displayName` è la ragione sociale, oppure nome e cognome. Un contatto ha un nome o una ragione sociale.
- **Carte.** Una carta semplice ha il saldo dei punti (`points`). Una carta **avanzata** (con credito e raccolte punti: vedi "Carte fedeltà") è indicata da `advanced: true`; il suo dettaglio (`card`) c'è **solo se la chiave ha anche `fidelityCards:read`**.
- **Che cosa non c'è mai:** il listino del contatto, i dati di fatturazione elettronica, le note, i listini del fornitore, i servizi, i dati dell'account del cliente e gli avvisi sui duplicati. In scrittura questi campi sono rifiutati (`422`, `unknown`) e **restano come sono**.
- Una scrittura cambia solo ciò che invii: gli oggetti `person` e `company` e gli indirizzi si fondono campo per campo; `phones`, `emails`, `faxes` e `fidelityCards` sostituiscono **l'intera lista**.
- **Versioni (`ETag` e `If-Match`)** e **creazioni idempotenti (`Idempotency-Key`, valida 24 ore e legata alla tua chiave API)** funzionano come nel catalogo.

### GET /contacts
Elenca i contatti, **interi**. **Permesso:** `contacts:read`. Parametri (nessun altro è ammesso):

| Parametro | Significato |
|---|---|
| `limit` | 1–50, default 25 |
| `cursor` | il valore `page.next` ricevuto, senza modificarlo |
| `sort` | `displayName` (default), `lastName`, `companyName`, `updatedAt`; con `-` davanti l'ordine è inverso |
| `q` | ricerca: testo contenuto in nome, cognome o ragione sociale, oppure codice, codice fiscale, partita IVA, codice carta o e-mail uguali |
| `kind` | `customers`, `suppliers`, `others` o `all` (default) |
| `contactGroupId` | solo i contatti di quel gruppo |
| `trashed` | `true`: solo i contatti nel cestino; `false`: solo gli altri |
| `updatedSince` | istante ISO 8601 (o solo la data): aggiornamento incrementale |

Senza `updatedSince` e senza `trashed` si leggono i contatti **non nel cestino**. Con `updatedSince` si leggono **tutti i contatti modificati da quell'istante in poi (compreso)**, **anche quelli nel cestino** (`trashed: true`: toglili dalla tua copia), in ordine di modifica dal meno recente, salvo `sort`. Procedura come per il catalogo: scarica tutto a pagine, conserva il più grande `updatedAt`, ripeti con `updatedSince=<quel valore>`; riconosci per `id` il contatto con lo stesso `updatedAt`. **Un contatto eliminato per sempre dall'attività non compare**: fai una rilettura completa periodica.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/contacts?kind=customers&updatedSince=2026-11-24T09:30:00.000Z&limit=25"
```
**Risposta** `200`
```json
{
  "data": [ { "id": "665f1c2e9b1d4a0012ab5001", "code": "K-0042", "customer": true, "supplier": false, "displayName": "Mario Rossi", "contactGroupId": null, "person": { "...": "come sopra" }, "company": { "...": "come sopra" }, "fidelityCards": [], "trashed": false, "createdAt": "2024-03-01T09:00:00.000Z", "updatedAt": "2026-11-25T08:00:00.000Z" } ],
  "page": { "limit": 25, "next": null }
}
```

### GET /contacts/{contactId}
Un contatto, con l'header `ETag`. **Permesso:** `contacts:read`. `404` se non esiste o è di un'altra attività; un contatto nel cestino si legge, con `trashed: true`.

### POST /contacts
Crea un contatto. **Permesso:** `contacts:write`. Richiede `Idempotency-Key`. Tutti i campi sono facoltativi, ma serve un nome (`person.firstName`) o una ragione sociale (`company.name`). Campi ammessi: `code`, `customer`, `supplier`, `contactGroupId`, `person` (`firstName`, `lastName`, `taxCode`, `birthDate`, `address`, `phones`, `emails`, `discountPercent`, `associatedCompanyId`), `company` (`name`, `vatNumber`, `taxCode`, `address`, `phones`, `emails`, `faxes`, `discountPercent`), `fidelityCards` (`[{ "code": "…" }]`: i codici delle carte, da 1 a 64 caratteri, senza `|`). **Aggiungere o togliere il codice di una carta avanzata** (vedi "Carte fedeltà") richiede **anche `fidelityCards:write`**: senza, la richiesta è `403` e non scrive nulla; i codici delle carte semplici richiedono il solo `contacts:write`. Ogni altro campo è rifiutato con `422` (`unknown`). Un codice, un codice fiscale o una partita IVA già usati da altri contatti **non** sono un errore e non vengono segnalati.

**Richiesta**
```sh
curl -X POST https://<host>/public/v1/contacts \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H "Idempotency-Key: <UUID generato dal tuo sistema>" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "K-0042",
    "customer": true,
    "person": { "firstName": "Mario", "lastName": "Rossi", "emails": ["mario@example.com"], "address": { "street": "Via Roma 1", "city": "Milano", "postcode": "20100", "countryCode": "IT", "areaCode": "MI" } },
    "fidelityCards": [{ "code": "CARD-1" }]
  }'
```
**Risposta** `201` con l'header `Location: /public/v1/contacts/665f1c2e9b1d4a0012ab5001`, l'`ETag` e il contatto completo (come in `GET /contacts/{contactId}`).

Errori: `422` (campi non validi o non previsti, gruppo di contatti, azienda associata, paese o provincia inesistenti), `409` (`Idempotency-Key` già usato con un corpo diverso), `403`, `413`, `415`, `429`.

### PATCH /contacts/{contactId}
Modifica un contatto. **Permesso:** `contacts:write`. Richiede `If-Match`. Corpo: uno o più campi di quelli della creazione (almeno uno). Una modifica che non cambia nulla non scrive nulla e risponde con la stessa versione.

**Richiesta**
```sh
curl -X PATCH https://<host>/public/v1/contacts/665f1c2e9b1d4a0012ab5001 \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H 'If-Match: "ofQyXEWYuR1LURZT2EB4zAb4gmcNZ2kptw2o6mGKnOE"' \
  -H "Content-Type: application/json" \
  -d '{ "person": { "address": { "city": "Torino" }, "phones": ["+39 011 123456"] } }'
```
**Risposta** `200` con il contatto aggiornato e il nuovo `ETag`. Errori: `404`, `409` (il contatto è nel cestino o è cambiato mentre si scriveva), `412`, `422`, `403`, `429`.

### POST /contacts/{contactId}/trash e POST /contacts/{contactId}/restore
Sposta un contatto nel cestino, o lo toglie dal cestino. **Permesso:** `contacts:write`. Richiedono `If-Match`; nessun corpo. Rispondono `200` con il contatto (`trashed: true`, oppure di nuovo `false`) e il nuovo `ETag`. `409` se il contatto è già nel cestino (o non lo è), `412`, `404`. Un contatto nel cestino non si modifica. **Non esiste** l'eliminazione definitiva.

### GET /contact-groups e GET /contact-groups/{contactGroupId}
I gruppi di contatti. **Permesso:** `contacts:read`. Solo lettura. Parametri della lista: `limit` (1–100, default 50), `cursor`, `sort` (`name`, default, o `updatedAt`, anche con `-`), `q` (testo nel nome). Ogni risposta con un gruppo ha l'`ETag`.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/contact-groups?limit=50"
```
**Risposta** `200`
```json
{
  "data": [ { "id": "665f1c2e9b1d4a0012ab5101", "name": "Clienti vip", "discountPercent": 5 } ],
  "page": { "limit": 50, "next": null }
}
```
`discountPercent` è `null` se il gruppo non ha sconto. Il listino del gruppo non è mai mostrato.

## Carte fedeltà

Le carte fedeltà **avanzate**: carte con un tipo, uno stato, un credito prepagato e punti su una o più raccolte. Si leggono con `fidelityCards:read` e si scrivono con `fidelityCards:write`. Sono dell'attività intera, senza restrizioni di azienda o punto vendita. **Non esiste l'eliminazione di una carta.** I punti delle carte semplici di un contatto si leggono nel contatto (vedi "Contatti") e non si modificano da qui.

- **Importi.** Il credito (`balance`) è in unità di valuta con due decimali (per esempio `25.5`), come nelle risposte; è presente solo nelle carte di un tipo prepagato. I punti sono interi per raccolta; `totalPoints` somma quelli delle raccolte attive in questo momento.
- **Una scrittura risponde con la carta scritta, saldi compresi**, anche se la chiave non ha `fidelityCards:read`: chi può creare o rettificare vede il risultato della propria operazione.
- **Creare una carta con un codice già presente su dei contatti la collega a quei contatti** (un contatto "ha" una carta per il suo codice): con `contactIds` li si aggiungono ad altri.
- **I contatti di una carta** (`contacts`, `contact`) compaiono **solo se la chiave ha anche `contacts:read`**, e solo con `id` e `displayName`; altrimenti c'è soltanto `contactsCount`.
- **Versioni.** Le risposte con una carta hanno l'`ETag`, da usare come `If-Match` per cambiarne il tipo o lo stato. Credito e punti si muovono con le rettifiche e **non** cambiano la versione.

```json
{
  "id": "665f1c2e9b1d4a0012ab6001",
  "code": "GOLD-9",
  "cardType": { "id": "Zk3vQ0aT9bX2mN7pLw4HcB", "name": "Prepagata", "enabled": true, "prepaid": true, "pointsCollect": true },
  "enabled": true,
  "balance": 12.5,
  "points": [ { "collectionId": "n1P8xQwR2cV5tYb7KdLm0g", "name": "Raccolta punti", "points": 40, "active": true } ],
  "totalPoints": 40,
  "contactsCount": 1,
  "contacts": [ { "id": "665f1c2e9b1d4a0012ab5001", "displayName": "Mario Rossi" } ],
  "createdAt": "2026-01-10T09:00:00.000Z",
  "updatedAt": "2026-01-10T09:00:00.000Z"
}
```

### GET /fidelity-cards
Elenca le carte. **Permesso:** `fidelityCards:read`. Parametri: `limit` (1–100, default 50), `cursor`, `sort` (`code`, default, `createdAt`, `updatedAt`; anche con `-`), `q` (il codice della carta; con `contacts:read` anche un testo nel nome di un contatto che la possiede), `cardTypeId`, `enabled` (`true`/`false`).

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/fidelity-cards?q=GOLD&limit=50"
```
**Risposta** `200`
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab6001",
      "code": "GOLD-9",
      "cardType": { "id": "Zk3vQ0aT9bX2mN7pLw4HcB", "name": "Prepagata" },
      "enabled": true,
      "balance": 12.5,
      "totalPoints": 40,
      "contactsCount": 1,
      "contact": { "id": "665f1c2e9b1d4a0012ab5001", "displayName": "Mario Rossi" },
      "createdAt": "2026-01-10T09:00:00.000Z"
    }
  ],
  "page": { "limit": 50, "next": null }
}
```
`contact` (il primo contatto della carta) c'è solo con `contacts:read`.

### GET /fidelity-cards/{cardId}
Una carta, con l'`ETag`. **Permesso:** `fidelityCards:read`. `404` se non esiste o è di un'altra attività.

### GET /fidelity-cards/{cardId}/movements
La storia della carta, dal movimento più recente. **Permesso:** `fidelityCards:read`. Parametri: `limit` (1–100, default 50), `cursor`.
```json
{
  "data": [
    { "id": "665f1c2e9b1d4a0012ab7001", "date": "2026-11-25T10:00:00.000Z", "type": "manually", "balance": 3, "points": 0, "collection": null, "operator": { "kind": "apiKey", "name": "Webshop" } },
    { "id": "665f1c2e9b1d4a0012ab7002", "date": "2026-01-10T09:00:00.000Z", "type": "manually", "balance": 20, "points": 0, "collection": null, "operator": { "kind": "user", "name": "Anna Bianchi" } }
  ],
  "page": { "limit": 50, "next": null }
}
```
`balance` e `points` hanno il segno del movimento (un movimento di solo credito ha `points: 0`, uno di soli punti ha `balance: 0` e la `collection`). `operator` è chi ha eseguito il movimento, solo per nome: `{ "kind": "user", "name": … }` per un utente, `{ "kind": "apiKey", "name": … }` per una chiave API (il nome dato alla chiave, anche se poi revocata); un movimento di una vendita non ha operatore (`null`).

### POST /fidelity-cards
Crea una carta. **Permesso:** `fidelityCards:write`. Richiede `Idempotency-Key`: poiché l'operazione muove credito, una richiesta di cui non si conosce l'esito **non si ripete** con la stessa chiave prima che siano passate 24 ore (la risposta è `409` con `Idempotency-Key`/`pending`): verifica prima lo stato della carta. Corpo:

| Campo | Significato |
|---|---|
| `code` | obbligatorio, da 1 a 64 caratteri, senza `|`; univoco nell'attività (`409` se già usato) |
| `cardTypeId` | obbligatorio, un tipo di carta dell'attività |
| `enabled` | facoltativo, default `true` |
| `initialBalance` | facoltativo, credito iniziale (da 0,01 a 1 000 000, due decimali), solo per un tipo prepagato |
| `initialPoints` | facoltativo, `[{ "collectionId", "points" }]` (punti interi da 1), solo su raccolte del tipo |
| `contactIds` | facoltativo, fino a 20 contatti a cui dare la carta: **richiede anche `contacts:write`** (altrimenti `403`, anche con la lista vuota) |

**Richiesta**
```sh
curl -X POST https://<host>/public/v1/fidelity-cards \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H "Idempotency-Key: <UUID generato dal tuo sistema>" \
  -H "Content-Type: application/json" \
  -d '{ "code": "GOLD-9", "cardTypeId": "Zk3vQ0aT9bX2mN7pLw4HcB", "initialBalance": 25.5, "initialPoints": [{ "collectionId": "n1P8xQwR2cV5tYb7KdLm0g", "points": 10 }] }'
```
**Risposta** `201` con l'header `Location: /public/v1/fidelity-cards/665f1c2e9b1d4a0012ab6001`, l'`ETag` e la carta completa. Il credito e i punti iniziali sono registrati come movimenti della carta.

Errori: `403` (`contactIds` senza `contacts:write`), `409` (codice già usato; `Idempotency-Key` con un corpo diverso o in attesa), `422` (tipo inesistente, credito su un tipo non prepagato, raccolta non del tipo, contatto inesistente, campi non previsti), `413`, `415`, `429`.

### PATCH /fidelity-cards/{cardId}
Cambia il tipo (`cardTypeId`) e/o lo stato (`enabled`) di una carta. **Permesso:** `fidelityCards:write`. Richiede `If-Match`; almeno un campo. Il codice non si cambia (`422`). Non si può passare a un tipo non prepagato finché la carta ha credito (`409`, `balance`/`notEmpty`).
```sh
curl -X PATCH https://<host>/public/v1/fidelity-cards/665f1c2e9b1d4a0012ab6001 \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H 'If-Match: "ofQyXEWYuR1LURZT2EB4zAb4gmcNZ2kptw2o6mGKnOE"' \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```
**Risposta** `200` con la carta e il nuovo `ETag`. Errori: `404`, `409`, `412`, `422`, `403`, `429`.

### POST /fidelity-cards/{cardId}/adjustments
Aggiunge o toglie credito e punti. **Permesso:** `fidelityCards:write`. Richiede `Idempotency-Key` (stesse regole di `POST /fidelity-cards`: nessuna ripetizione prima di 24 ore se l'esito è ignoto). Corpo: almeno uno tra `balanceDelta` (variazione del credito, con segno, due decimali, da -1 000 000 a 1 000 000, non zero; solo tipo prepagato) e `pointsDeltas` (`[{ "collectionId", "delta" }]`, interi non zero, solo raccolte del tipo, nessuna raccolta due volte), più un `reason` facoltativo (fino a 200 caratteri). Il credito e i punti **non scendono mai sotto zero**.
```sh
curl -X POST https://<host>/public/v1/fidelity-cards/665f1c2e9b1d4a0012ab6001/adjustments \
  -H "X-Api-Key: $FLOOD_API_KEY" \
  -H "Idempotency-Key: <UUID generato dal tuo sistema>" \
  -H "Content-Type: application/json" \
  -d '{ "balanceDelta": -4.5, "pointsDeltas": [{ "collectionId": "n1P8xQwR2cV5tYb7KdLm0g", "delta": 7 }], "reason": "rimborso ordine 1234" }'
```
**Risposta** `200` con la carta aggiornata (credito e punti nuovi; l'`ETag` non cambia). Errori: `404`, `409` (credito o punti insufficienti: `details` indica `balance` o `points.<raccolta>` con `insufficient`; `Idempotency-Key` con corpo diverso o in attesa), `422` (credito su un tipo non prepagato, raccolta non del tipo, nessuna variazione), `403`, `429`.

## Vendite

Le vendite dei punti vendita (scontrini, fatture, addebiti), **in sola lettura**, con il permesso `sales:read`. Una chiave **ristretta** a determinate aziende o punti vendita vede solo le vendite di quelli. `404` significa che la vendita non esiste oppure è fuori dalle restrizioni della chiave; lo stesso vale per una chiave le cui restrizioni non corrispondono a nessun punto vendita attivo.

- **Importi in centesimi interi** (`totalCents: 2440` è 24,40), mai decimali. Le percentuali (`discountPercent`, `taxRatePercent`) sono numeri.
- **Che cosa non c'è.** Non si espongono dati personali del cliente (della vendita si legge solo `customerId`, l'identificativo del contatto, che si può risolvere con `GET /contacts/{contactId}` se la chiave ha `contacts:read`), né l'operatore, il codice della carta fedeltà, il codice lotteria, le note, i dati di consegna o di prenotazione, la cassa (nome, numero di serie e impostazioni) né i costi.
- **Conti madre dei tavoli divisi (`receiptType: "partitioned"`).** Un tavolo diviso in più scontrini produce un conto madre che contiene i **prodotti reali** del tavolo e, per ogni parte pagata, uno scontrino che porta soltanto una riga segnaposto "Pasto completo". Il conto madre **non è uno scontrino**: **non va contato come scontrino né sommato ai ricavi** (i suoi totali non sono incassi: gli incassi sono quelli degli scontrini delle parti); va usato, invece, per le statistiche per prodotto e per categoria. Al contrario le righe "Pasto completo" degli scontrini delle parti **non vanno usate** per le statistiche sui prodotti. Per escludere i conti madre dall'elenco passa `partitioned=exclude`; per leggerli da soli `receiptType=partitioned`.
- **Righe.** `products` contiene al più 500 righe; `productsCount` è il numero reale (maggiore se la vendita ne ha di più). `name` è il nome del prodotto nella prima lingua disponibile.
- **Resi e annulli.** `fiscalState` è `refunded` (reso, anche parziale), `canceled` (annullata) o `null`; `refunds` elenca i resi con data, numeri fiscali e importo reso. Una vendita annullata va esclusa dai ricavi; una resa parziale va sottratta per l'importo reso.

```json
{
  "id": "665f1c2e9b1d4a0012ab7001",
  "date": "2026-05-10T10:00:00.000Z",
  "receiptType": "receipt",
  "number": { "report": 101, "number": 12 },
  "fiscalState": null,
  "refunds": [],
  "invoiced": false,
  "companyId": "665f1c2e9b1d4a0012ab3001",
  "placeId": "665f1c2e9b1d4a0012ab4001",
  "customerId": "665f1c2e9b1d4a0012ab5001",
  "products": [
    { "productId": "665f1c2e9b1d4a0012ab2001", "code": "PZ", "name": "Pizza", "quantity": 2, "unitPriceCents": 1220, "discountPercent": 0, "taxRatePercent": 22 }
  ],
  "productsCount": 1,
  "totals": { "totalCents": 2440, "taxableCents": 2000, "taxCents": 440, "discount": { "adjustment": null, "percentage": 0, "valueCents": 0 } },
  "payments": { "cashCents": 2440, "electronicCents": 0, "chequeCents": 0, "ticketsCents": 0, "fidelityCreditCents": 0 },
  "unpaidCents": 0
}
```

`receiptType` è `receipt` (scontrino), `invoice` (fattura), `charge` (addebito), `partitioned` (conto madre, vedi sopra) o `null` per una vendita di cui il tipo non è noto. `invoiced` è `true` se la vendita è stata inclusa in una fattura differita. `number` è il numero fiscale dello scontrino (`report` è il numero della chiusura giornaliera), `null` se non c'è. `unpaidCents` è l'importo non pagato (addebito o credito).

### GET /sales
Elenca le vendite dalla più recente. **Permesso:** `sales:read`. Parametri (ogni altro è `422`):

| Parametro | Significato |
|---|---|
| `from`, `to` | periodo: `from` **incluso**, `to` **escluso**, data ISO (`2026-05-01` o `2026-05-01T00:00:00Z`, UTC). **Obbligatori entrambi** senza `contactId`; intervallo **al più 1 anno** (`422`: `from`/`required`, `to`/`required`, `to`/`incorrect` se non dopo `from`, `to`/`maximum` oltre l'anno) |
| `contactId` | solo le vendite di quel contatto; con questo filtro il periodo è facoltativo |
| `companyId`, `placeId` | restringono ad un'azienda o a un punto vendita (dentro le restrizioni della chiave) |
| `receiptType` | `receipt`, `invoice`, `charge`, `partitioned` |
| `partitioned` | `include` (predefinito) o `exclude`: se elencare i conti madre dei tavoli divisi. `receiptType=partitioned` con `partitioned=exclude` è `422` |
| `fiscalState` | `none` (né annullata né resa), `canceled`, `refunded` (anche il reso parziale) |
| `limit`, `cursor` | pagina: `limit` 1–**50** (default 20), `cursor` come ricevuto in `page.next` (un valore diverso è `422`) |

Non esistono filtri incrementali: rileggi il periodo che ti serve.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/sales?from=2026-05-01&to=2026-06-01&partitioned=exclude&limit=20"
```
**Risposta** `200`
```json
{
  "data": [
    {
      "id": "665f1c2e9b1d4a0012ab7001",
      "date": "2026-05-10T10:00:00.000Z",
      "receiptType": "receipt",
      "number": { "report": 101, "number": 12 },
      "fiscalState": null,
      "refunds": [],
      "invoiced": false,
      "companyId": "665f1c2e9b1d4a0012ab3001",
      "placeId": "665f1c2e9b1d4a0012ab4001",
          "customerId": null,
      "products": [
        { "productId": "665f1c2e9b1d4a0012ab2001", "code": "PZ", "name": "Pizza", "quantity": 2, "unitPriceCents": 1220, "discountPercent": 0, "taxRatePercent": 22 }
      ],
      "productsCount": 1,
      "totals": { "totalCents": 2440, "taxableCents": 2000, "taxCents": 440, "discount": { "adjustment": null, "percentage": 0, "valueCents": 0 } },
      "payments": { "cashCents": 2440, "electronicCents": 0, "chequeCents": 0, "ticketsCents": 0, "fidelityCreditCents": 0 },
      "unpaidCents": 0
    }
  ],
  "page": { "limit": 20, "next": "eyJ2ZXIiOjEs..." }
}
```

### GET /sales/{saleId}
Una vendita, con la stessa forma di quelle dell'elenco. **Permesso:** `sales:read`. `404` se la vendita non esiste oppure è fuori dalle restrizioni della chiave.

**Richiesta**
```sh
curl -H "X-Api-Key: $FLOOD_API_KEY" "https://<host>/public/v1/sales/665f1c2e9b1d4a0012ab7001"
```
**Risposta** `200`: `{ "data": { …come sopra… } }`.

## Buone pratiche di integrazione
- Conserva la chiave in un gestore di segreti e **non** inserirla in repository, log o richieste di assistenza; se sospetti che sia esposta, chiedi subito la revoca.
- Usa una chiave per ogni sistema, con i soli permessi e le sole restrizioni che servono.
- Gestisci `401` (chiave non più valida: avvisa l'amministratore, non ripetere in ciclo), `403`, `404` e `429` (rispetta `Retry-After`).
- Metti in cache le letture che cambiano di rado (listini, aliquote, anagrafiche) invece di richiederle a ogni operazione.
- Per tenere allineato il catalogo usa l'aggiornamento incrementale (`updatedSince`) più una rilettura completa periodica; per le scritture genera un `Idempotency-Key` per ogni creazione e conserva l'`ETag` di ogni voce letta.
- Dai a una chiave di scrittura solo le restrizioni che servono: una chiave senza restrizioni può modificare ogni prodotto dell'attività.
- Per i contatti e le carte, genera un `Idempotency-Key` per ogni creazione e per ogni rettifica, e non ripeterle con una chiave nuova se non sai se la prima è andata a buon fine: leggi prima la carta.
- Per le statistiche di vendita non contare i conti madre `partitioned` come scontrini né sommarne i totali, e non usare le righe "Pasto completo" degli scontrini delle parti per le statistiche sui prodotti.
- Dai `contacts:read` e `fidelityCards:write` solo a chi ne ha davvero bisogno: i contatti sono dati personali e le rettifiche muovono credito.
- Registra l'header `X-Request-Id` delle risposte con errore.
