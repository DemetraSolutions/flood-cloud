# Analisi del Progetto Legacy

> Riferimento funzionale per la riscrittura. Fonte: `../cloud-commerce-platform-server` (package `dcp-server`), analizzato il 2026-10-30.
> Questo documento descrive **cosa** fa il legacy. Non è una specifica da copiare: ogni parte si riprogetta (`GEMINI.md` §0).
> Nessun valore segreto è riportato qui. **Tutte le credenziali presenti nel legacy vanno considerate compromesse e ruotate.**

## 1. Cos'è
Piattaforma SaaS italiana multi-tenant di **cassa (POS) e backoffice in cloud** per retail, ristorazione/ospitalità e tabaccherie, con adempimenti fiscali (fatturazione elettronica via hub Aruba, registratore telematico via Fiskaly). Client noti: `cloud-commerce-backoffice-client`, `cloud-commerce-pos`.

Numeri: ~42k righe JS, 1081 commit, **nessun test**, Node 20 (Dockerfile su Node 16), Express 4, driver MongoDB 6 più alias del driver 2.2.

## 2. Gerarchia e attori
- **Platform Super Admin** (`PSA`) e **Dealer/rivenditore** (`D`): gestiscono la piattaforma e più gruppi clienti.
- **Group** = tenant (organizzazione cliente, appartiene a un dealer) → **Company** (soggetto giuridico, dati fiscali) → **Place** (punto vendita/locale, con `devices[]`, `storages[]`, `rooms[]`).
- **User**: utenti del backoffice e operatori di cassa, legati a group/company/place. Ruoli visti nel codice: `PSA`, `D`, `SA`, `CA`, `PA`, `X`, `L` (significato esatto da confermare). Permessi per modulo `permissions.<modulo>.{r,w}`.
- **Contact**: clienti finali e fornitori, con carte fedeltà; alcuni hanno un `account` (login lato cliente/e-commerce).
- **F-Lite**: linea prodotto separata con propri account e proprio JWT (`flite/`).

## 3. Multi-tenancy
- **Un database per tenant**: `<prefix><env>_<groupId>`; database comuni `<prefix><env>_common`, `..._flite_common`, `..._queue` (coda e-fatture).
- Il tenant si ricava da `groupId` dell'utente del JWT o dall'header `Apikey` che corrisponde a `groups.apiKey`. PSA e dealer possono forzare il tenant con `?groupId=`.
- Lo scope per company/place **non è centralizzato**: ogni controller lo ricostruisce da filtri inviati dal client.
- `companies` e `places` stanno nei database dei gruppi: estrarre tutti i punti vendita (es. per un dealer) richiede di interrogare ogni database. Nel nuovo progetto passano nel common (`doc/Architecture.md` §3.2).
- Esiste un'opzione `group.databaseHost` (host dedicato) che il codice ignora: **eliminata** nel nuovo progetto.
- I POS dei negozi (in realtà il server di punto vendita) si autenticano con l'unica API key del gruppo, condivisa da tutti i negozi; gli amministratori con un JWT di fatto senza scadenza.

## 4. Domini funzionali (servizi `ms/`)
| Area | Servizi legacy | Collection principali |
|---|---|---|
| Identità e tenancy | users, groups, companies, places, countries | `users`, `groups`, `companies`, `places`, `countries` |
| Catalogo | products (con reparti, categorie, brand, attributi, bundle, import/export CSV-XLSX), tgm (listino tabacchi) | `products`, `products_*`, `tobaccos` |
| Magazzino | warehouse | `warehouse` (movimenti per causale e deposito) |
| Vendite | sales (transazione: movimenti di magazzino, punti fedeltà, documento in coda) | `sales` |
| Documenti fiscali | documents (fatture, scontrini, XML, export, stampa pubblica), coda Aruba | `documents`, `queue` |
| POS | pos (`:type` = chiusure, turni, checkout, giocate) | `pos_*` |
| CRM e fedeltà | contacts, fidelity, email-templates | `contacts`, `contacts_groups`, `fidelity_cards*`, `email_templates` |
| Prenotazioni | calendar (con algoritmo slot), table-reservation, rooms | `calendar`, `table_reservation`, `rooms` |
| Report | stats (aggregazioni, stream, CSV), logs | letture su `sales` e altre |
| File | files (immagini ridimensionate, disco locale + Google Cloud Storage), releases (zip app) | `files` |
| Integrazioni | Aruba, Fiskaly, Cerved, Satispay, Dojo, TSH, TurboSMTP, EasyAppear, Tomatoai, Google Reserve | — |

Codice morto da non considerare: `__ms-query-service`, cartelle root `routers/`, `models/`, `factories/`, `template/`, `modules/*Module.js`, `OLD_CronEngine`, `esm`, nunjucks.

## 5. Forma dell'API legacy
- Percorsi `/api/:version/ms/<dominio>/<verbo>` (solo versione `1.0`), **208 POST**, 12 GET, 4 PATCH.
- Verbi generici che ricalcano il driver: `find`, `findOne`, `aggregate`, `countDocuments`, `insertOne`, `updateOne`, `updateMany`, `deleteMany`.
- **Il client invia query e pipeline MongoDB grezze** nel body; il server corregge a mano ObjectId e date. È la causa principale dei problemi di sicurezza e manutenzione.

## 6. Job e deploy
- La stessa immagine gira in tre ruoli scelti da variabili d'ambiente: **api**, **stats** (su replica analitica), **cron** (una sola replica). Deploy su GKE via GitHub Actions; un servizio stats su Cloud Run.
- Job: coda e-fatture Aruba con rate limit per hub (auth < 1/min, upload ≤ 55/h, stato < 12/min), pulizia file temporanei, pulizia log oltre 90 giorni, pulizia contatti.
- Event bus in processo (`insert_sales` → invio a servizio esterno).

## 7. Problemi da non ripetere
- **Sicurezza**: vedi `doc/Security-Model.md` §1 (analisi delle vulnerabilità legacy).
- Segreti versionati nel repository (script `package.json`, Makefile di deploy, chiave di service account in `keys/`, moduli di integrazione).
- Autenticazione decisa da una whitelist di sottostringhe del percorso: una nuova route non in lista è pubblica.
- Controller di migliaia di righe che mescolano validazione, permessi, query e integrazioni.
- Nome del database costruito a mano in ~300 punti.
- Errori silenziati (`unhandledRejection` ignorato), doppio `next`, middleware che non chiamano `next`.
- PII cifrate con un segreto condiviso; nessun test.

## 8. Concetti di dominio da preservare
Gerarchia dealer → group → company → place (device, storage, room); catena **vendita → movimento di magazzino → documento fiscale**; coda e-fatture con i limiti del provider; ruoli e permessi per modulo; separazione dei ruoli di esecuzione (api / stats / cron).
