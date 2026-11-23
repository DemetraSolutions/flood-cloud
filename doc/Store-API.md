# Flood Cloud — API per il server di punto vendita

Documento per chi sviluppa il **server di punto vendita**: descrive solo le chiamate che il server di negozio può fare al cloud con la propria **chiave di negozio**. Si aggiorna a ogni passo che apre una nuova chiamata al negozio (registro in fondo).

- **Stato:** attivazione, contesto, lettura del proprio punto vendita e configurazione completa di gruppo, azienda e punto vendita.
- **Non è qui:** le API del backoffice (`doc/API.md`) e le API pubbliche per gli integratori (`doc/Public-API.md`).

## 1. Convenzioni

- **Indirizzo di base:** `https://<host>/v1`. L'host di ogni ambiente viene comunicato a parte; si usa solo HTTPS, con verifica del certificato obbligatoria.
- **Formato:** JSON UTF-8 (`Content-Type: application/json`), body non compresso.
- **Risposte:** `{ "data": … }`; le liste aggiungono `page`.
- **Errori:** `{ "error": { "code": "…", "message": "…", "details": [ … ] } }`. Si decide in base a `code` e allo stato HTTP, mai al testo di `message`.
- **Date:** ISO 8601 in UTC. **Importi:** interi in centesimi. **Identificativi:** stringhe, da trattare come opache.
- **`X-Request-Id`:** ogni risposta lo porta; va scritto nei log del server di negozio e indicato nelle segnalazioni.
- **Cache:** ogni risposta è `Cache-Control: no-store`.

## 2. Come funziona l'accesso

Ogni punto vendita ha **una sola chiave attiva**. La chiave identifica il punto vendita, non una persona: per ottenerla non serve alcun login.

1. Dal backoffice un amministratore di piattaforma o un rivenditore genera il **codice di attivazione** del punto vendita (scheda del punto vendita, "Impostazioni rivenditore"). Il codice vale **24 ore**, per **un solo uso**, e si vede una sola volta.
2. Il tecnico installatore lo digita sul server di negozio.
3. Il server di negozio lo scambia con la chiave: `POST /v1/store-activations` (§3.1).
4. Da quel momento ogni richiesta porta l'header `Authorization: Bearer fc_sk_…`.

Una nuova attivazione dello stesso punto vendita **revoca subito** la chiave precedente. La chiave non scade: vale finché non viene revocata.

### Regole per chi scrive il server di negozio

- Conservare la chiave nel **deposito sicuro del sistema operativo** (Keychain, DPAPI, Android Keystore, libsecret), mai in chiaro su file o database.
- Non scrivere mai la chiave nei log e non mandarla ai dispositivi del negozio (casse, palmari).
- Mandarla solo nell'header `Authorization`, mai nell'URL o nel body.
- Su `403 STORE_DISABLED` **non cancellare la chiave** (§4).
- Considerare la chiave persa solo su `401`.

### Regole per le credenziali ricevute

Le chiamate dei §3.4 e §3.6 consegnano al server di negozio **credenziali in chiaro** (pagamenti, integrazioni, casse automatiche, `legacyApiKey`). Chi le riceve ne è responsabile:

- **Conservazione:** cifrate a riposo, mai in chiaro su file o database; mai in backup non cifrati.
- **Log:** mai nei log, nei crash report o negli strumenti di monitoraggio degli errori (Sentry compreso). Non si scrivono nei log nemmeno i corpi delle risposte dei §3.4–3.6, né gli header `ETag` e `If-None-Match`.
- **Dispositivi del negozio:** a una cassa o a un palmare va solo la credenziale che serve a quel dispositivo, mai la risposta intera e mai `legacyApiKey`.
- **Su `401`:** insieme alla chiave di negozio si cancellano anche le credenziali conservate.
- **Compromissione:** revocare la chiave di negozio ferma le nuove letture ma **non invalida le credenziali già scaricate**. Se un server di negozio è stato compromesso va segnalato subito: le credenziali vanno cambiate presso i fornitori.

## 3. Chiamate disponibili

### 3.1 Attivazione — `POST /v1/store-activations`

Scambia il codice di attivazione con la chiave. È l'unica chiamata **senza credenziale**.

- **Limiti:** 10 richieste al minuto per indirizzo IP; body di al più 2 KB.
- **Body:**
  ```json
  {
    "activationCode": "7KQ2-M9XD-4TPA-H3WN",
    "installation": { "appVersion": "2.0.1", "platform": "windows" }
  }
  ```
  - `activationCode` (obbligatorio): come lo digita una persona. Maiuscole e minuscole sono equivalenti, trattini e spazi sono facoltativi, `O` vale `0`, `I` e `L` valgono `1`.
  - `installation` (facoltativo): `appVersion` e `platform`, stringhe di al più 64 caratteri (lettere, cifre, spazio e `. _ + -`). Servono alla diagnostica.
  - Ogni altra proprietà è rifiutata con `422`.
- **Risposta:** `201`, con `Location: /v1/store-context`
  ```json
  {
    "data": {
      "key": "fc_sk_…",
      "keyId": "6650…",
      "groupId": "665f…",
      "companyId": "665f…",
      "placeId": "665f…"
    }
  }
  ```
  `key` arriva **solo in questa risposta**: il cloud non la conserva in chiaro e non può rimandarla.
- **Errori:**

  | Stato | `code` | Significato |
  |---|---|---|
  | `401` | `INVALID_CREDENTIALS` | Codice non valido. La risposta è identica per codice errato, scaduto, già usato o punto vendita non operativo: il server di negozio mostra un solo messaggio ("codice non valido o scaduto"). |
  | `413` | `PAYLOAD_TOO_LARGE` | Body oltre 2 KB. |
  | `415` | `UNSUPPORTED_MEDIA_TYPE` | Content type diverso da JSON, o body compresso. |
  | `422` | `VALIDATION_ERROR` | Body malformato; `details` indica il campo. |
  | `429` | `RATE_LIMITED` | Troppe richieste: riprovare dopo i secondi di `Retry-After`. |

**Attenzione alla risposta persa.** Il codice si consuma al primo scambio riuscito. Se il server di negozio non riceve la risposta (rete caduta, errore `5xx`), il codice può essere già consumato: **non va riprovato in automatico**, serve un nuovo codice dal backoffice. Per questo la chiave va salvata nel deposito sicuro **prima** di ogni altra operazione.

### 3.2 Contesto — `GET /v1/store-context`

Dice a quale gruppo, azienda e punto vendita appartiene la chiave. Serve a verificare la chiave all'avvio e a conoscere l'azienda attuale del punto vendita.

- **Autenticazione:** chiave di negozio.
- **Risposta:** `200`
  ```json
  {
    "data": {
      "groupId": "665f…",
      "companyId": "665f…",
      "placeId": "665f…",
      "keyId": "6650…",
      "activatedAt": "2026-11-13T10:00:00.000Z"
    }
  }
  ```
  `companyId` può cambiare nel tempo (il punto vendita può essere spostato su un'altra azienda dello stesso gruppo): va riletto a ogni avvio.
- **Errori:** quelli del §4.

### 3.3 Il proprio punto vendita — `GET /v1/groups/{groupId}/places/{placeId}`

Restituisce l'anagrafica e le impostazioni del punto vendita. `groupId` e `placeId` sono quelli del contesto: con qualunque altro valore la risposta è `404`.

- **Autenticazione:** chiave di negozio.
- **Header di risposta:** `ETag`, la versione del documento. Cambia a ogni modifica: si può confrontare per sapere se le impostazioni sono cambiate.
- **Risposta:** `200`. Campi principali:
  ```json
  {
    "data": {
      "id": "665f…", "groupId": "665f…", "companyId": "665f…",
      "name": "Bar Roma",
      "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
      "contactName": "Mario Rossi", "email": "bar@esempio.it", "phone": "+39 02 1234567",
      "priceListId": "665f…", "ecommercePriceListId": null, "invoiceSeries": "FE",
      "priceLists": [{ "id": "665f…", "allYouCanEat": true, "ayceCode1": "12", "ayceCode2": null }],
      "trashed": false, "createdAt": "2026-01-15T10:00:00.000Z", "updatedAt": "2026-11-13T09:30:00.000Z",
      "license": { "plan": "advanced", "expirationDate": "2030-01-01T00:00:00.000Z", "status": "active", "sentry": false },
      "openingHours": { "timezone": "Europe/Rome", "week": { "…": "…" }, "special": { "…": "…" } }
    }
  }
  ```
  Oltre a questi la risposta contiene i blocchi delle impostazioni (cassa, stampe, pagamenti, sale, prenotazioni, asporto e consegna, self ordering, kiosk, appuntamenti, display, fidelity, tabacchi, media), i dispositivi, le postazioni comanda, le sale, i depositi e le integrazioni, con gli stessi nomi usati dal backoffice. Il dettaglio campo per campo è in `doc/API.md`, sezioni "Punti vendita" e "Impostazioni del punto vendita".
- **Cosa non arriva da questa chiamata:**
  - le **credenziali** di integrazioni e dispositivi (pagamenti, cassa automatica…): al loro posto c'è un indicatore `<nome>Set: true|false`;
  - le impostazioni riservate al rivenditore (`dealerSettings`).
  Per avere la configurazione **completa**, credenziali comprese, si usa `GET /v1/store-context/place` (§3.6).
- **Valori mancanti:** un campo assente o non valido nel documento arriva come `null`, `false` o `[]`.
- **Errori:** quelli del §4; `404 NOT_FOUND` per un punto vendita o un gruppo diversi dal proprio.

### 3.4 Configurazione del gruppo — `GET /v1/store-context/group`

Tutta la configurazione del gruppo del punto vendita, comprese le chiavi delle integrazioni. Nessun parametro: il gruppo è quello della chiave.

- **Autenticazione:** chiave di negozio. **Header di risposta:** `ETag`, un valore opaco che cambia quando cambia la configurazione; con `If-None-Match` uguale la risposta è `304` senza corpo: si può usare per sapere se la configurazione è cambiata. La risposta non è mai compressa e non va conservata nei log.
- **Risposta:** `200`. Campi di primo livello:
  ```json
  {
    "data": {
      "id": "665f…", "name": "Gruppo Rossi", "description": null,
      "status": "active", "trashed": false, "trashedAt": null, "demo": false,
      "features": { "…": true },
      "languages": ["it", "en"],
      "statsSettings": { "openingTime": "06:30", "compressProductsCategories": false, "timeSlots": [{ "from": "00:00", "to": "06:00" }] },
      "integrations": {
        "easyappear": { "enabled": false, "apiKey": null },
        "yellgo": { "enabled": true, "apiKey": "…" }
      },
      "legacyApiKey": "…",
      "priceLists": [], "taxes": [], "currencies": [], "measureUnits": [], "warehouseRules": [], "fidelityCardRules": [],
      "cardTypes": [], "pointsCollections": [], "prizeCatalogues": [], "productFavorites": [], "promotions": [],
      "createdAt": "2024-01-15T10:00:00.000Z", "updatedAt": "2026-11-13T09:30:00.000Z"
    }
  }
  ```
  `integrations` ha una voce per ogni integrazione prevista, con l'interruttore (`enabled`) e la chiave in chiaro (`apiKey`, `null` se manca). I cataloghi sono elenchi con gli stessi nomi e la stessa forma delle rispettive risorse del backoffice (`doc/API.md`). Sono quelli **dell'intero gruppo**: promozioni, tipi di carta e gruppi preferiti arrivano anche se riguardano altri punti vendita, e il server di negozio usa quelli che valgono per il proprio.
- **`legacyApiKey` è temporaneo:** serve finché le chiamate al vecchio servizio non sono migrate; poi verrà rimosso. Vale per **tutto il gruppo**, non per il solo punto vendita: va protetto come la credenziale più delicata, non va usato per altro né inoltrato ai dispositivi del negozio.
- **Cosa non arriva mai:** tutto ciò che riguarda le API pubbliche del gruppo, il rivenditore e l'infrastruttura.
- **Errori:** quelli del §4.

### 3.5 Configurazione dell'azienda — `GET /v1/store-context/company`

Tutta la configurazione dell'azienda **attuale** del punto vendita (se il punto vendita passa a un'altra azienda, la chiamata restituisce la nuova). Nessun parametro.

- **Autenticazione:** chiave di negozio. **Header di risposta:** `ETag`, la versione del documento (forte); `If-None-Match` uguale dà `304` senza corpo.
- **Risposta:** `200`. Campi di primo livello:
  ```json
  {
    "data": {
      "id": "665f…", "groupId": "665f…", "name": "Rossi S.r.l.",
      "vatNumber": "01234567890", "fiscalCode": null,
      "address": { "street": "Via Roma 1", "postcode": "20100", "city": "Milano", "province": "MI", "country": "IT" },
      "currency": "EUR", "email": null, "phone": null, "status": "active",
      "trashed": false, "trashedAt": null, "expirationDate": null,
      "createdAt": "2024-01-15T10:00:00.000Z", "updatedAt": "2026-11-13T09:30:00.000Z",
      "eInvoicing": { "…": "…" },
      "invoiceNumbering": { "position": "prefix", "values": [{ "name": "FE", "cash": false }], "lastInvoiceNumber": 12, "discountLines": false, "cervedLookup": false },
      "bankAccounts": [], "mealVoucherIssuers": [],
      "customerApp": { "…": "…" },
      "media": { "…": "…" }
    }
  }
  ```
  I nomi e la forma dei campi sono quelli del backoffice (`doc/API.md`, sezione "Aziende").
- **Errori:** quelli del §4.

### 3.6 Configurazione del punto vendita — `GET /v1/store-context/place`

Tutta la configurazione del proprio punto vendita, **con le credenziali di integrazioni e dispositivi in chiaro** e le impostazioni del rivenditore. Nessun parametro.

- **Autenticazione:** chiave di negozio. **Header di risposta:** `ETag`, la versione del documento (forte); `If-None-Match` uguale dà `304` senza corpo. La risposta non è mai compressa e non va conservata nei log.
- **Risposta:** `200`. Stessa struttura del §3.3 (anagrafica, `license`, `openingHours`, i blocchi delle impostazioni, `devices`, `printStations`, `rooms`, `storages`, `integrations`), più `dealerSettings`; dove il §3.3 ha `<nome>Set`, qui c'è `<nome>` con il valore, oppure `null` se manca:
  ```json
  {
    "data": {
      "id": "665f…", "groupId": "665f…", "companyId": "665f…", "name": "Bar Roma",
      "integrations": {
        "dojo": { "status": true, "apiKey": "…" },
        "floodPay": { "status": true, "stripe": { "publicKey": "…", "privateKey": "…", "webhookPrivateKey": null } }
      },
      "devices": {
        "items": [{ "id": "d1", "type": "desk", "name": "Cassa", "automaticCashUsername": "…", "automaticCashPassword": "…" }],
        "editable": true
      },
      "dealerSettings": { "sentry": false, "serverIp": "10.0.0.1", "connectorAddress": "" }
    }
  }
  ```
  I valori assenti o non validi arrivano come `null`, `false` o `[]`.
- **Errori:** quelli del §4.

### 3.7 Quando rileggere

Le tre chiamate dei §3.4–3.6 sono pensate per essere interrogate periodicamente: con `If-None-Match` uguale all'ultimo `ETag` la risposta è `304` senza corpo e non si perde nulla. Si rileggono comunque all'avvio e dopo ogni `403 STORE_DISABLED` risolto. Contano nel limite di 600 richieste al minuto della chiave (§4).

## 4. Stati ed errori di ogni chiamata autenticata

| Stato | `code` | Quando | Cosa fa il server di negozio |
|---|---|---|---|
| `401` | `UNAUTHENTICATED` | Chiave assente, malformata, sconosciuta o **revocata**. Succede anche se il punto vendita è stato messo nel cestino o eliminato, o se è stata fatta una nuova attivazione. | La chiave è persa: chiede una nuova attivazione. |
| `403` | `STORE_DISABLED` | La chiave è valida ma il punto vendita non è operativo: gruppo sospeso o nel cestino, punto vendita disattivato, licenza scaduta, azienda nel cestino. | **Tiene la chiave**, avvisa l'operatore e riprova più tardi: riprende da solo dopo riattivazione, ripristino o rinnovo. |
| `403` | `FORBIDDEN` | La chiamata non è aperta al server di negozio. | Errore di integrazione: la chiamata non è tra quelle di questo documento. |
| `404` | `NOT_FOUND` | Risorsa inesistente o non del proprio punto vendita. | Controlla gli identificativi con il contesto (§3.2). |
| `429` | `RATE_LIMITED` | Oltre **600 richieste al minuto** per chiave. Contano tutte le richieste, anche quelle rifiutate. | Aspetta i secondi di `Retry-After`. |
| `5xx` | — | Errore del cloud. | Riprova con attesa crescente; segnala `X-Request-Id`. |

Un punto vendita ripristinato dal cestino **non riottiene** la vecchia chiave: serve una nuova attivazione.

## 5. In arrivo

Chiamate non ancora aperte al server di negozio, previste con i prossimi passi (oggi rispondono `403 FORBIDDEN`):

- utenti del punto vendita, con gli amministratori che lo gestiscono;
- catalogo (prodotti, categorie e le altre anagrafiche) limitato a ciò che vale per il punto vendita;
- anagrafiche dei clienti (contatti).

## 6. Registro delle modifiche

| Data | Modifica |
|---|---|
| 2026-11-23 | Prima versione: attivazione, contesto, lettura del proprio punto vendita. |
| 2026-11-23 | Configurazione completa di gruppo, azienda e punto vendita (§3.4–3.6), credenziali in chiaro; `legacyApiKey` temporanea nel gruppo; regole per le credenziali ricevute (§2). |
