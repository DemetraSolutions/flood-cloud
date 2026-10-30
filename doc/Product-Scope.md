# Scopo del Prodotto — Flood Cloud

## Cos'è
**Flood Cloud** è il nuovo server della piattaforma cloud commerce di Flood: un SaaS multi-tenant di **cassa (POS) e backoffice** per attività commerciali italiane (retail, ristorazione e ospitalità, tabaccherie), con gestione di catalogo, magazzino, vendite, documenti fiscali, clienti e fedeltà, prenotazioni e report.

Sostituisce `cloud-commerce-platform-server` (analisi in `doc/Legacy-Analysis.md`) con una riscrittura completa, non un porting.

## Chi lo usa
| Client | Cosa fa | Superficie |
|---|---|---|
| **App di backoffice** | gli amministratori gestiscono piattaforma, gruppi, anagrafiche, catalogo, report | `/v1` |
| **Server di punto vendita** | uno per negozio, sempre connesso: centralizza casse e dispositivi locali, invia vendite e scontrini, riceve i dati del catalogo | `/store/v1` |
| **Integrazioni del gruppo** | sistemi esterni di un singolo gruppo (es. e-commerce), con limiti e conteggio delle chiamate | `/public/v1` |

Le casse, i palmari e gli altri dispositivi del negozio **non comunicano mai direttamente con il cloud**: passano sempre dal server di punto vendita.

## Gerarchia e ruoli
Platform Super Admin (`PSA`) → Dealer (`D`) → **Gruppo** (tenant, cliente del dealer) → **Azienda** (soggetto giuridico) → **Punto vendita**.
- `PSA` vede tutto il sistema; `D` vede i gruppi che ha creato.
- Utenti del cliente: `SA` (gruppo), `CA` (aziende), `PA` (punti vendita), `E` (dipendente, opera solo dalle casse del punto vendita e non accede al backoffice).

Catena di dominio centrale: **vendita → movimento di magazzino → documento fiscale**.

## Obiettivi della riscrittura
1. **Sicurezza rifatta da zero** (`doc/Security-Model.md`): deny by default, sessioni del backoffice a scadenza con refresh, identità a chiave pubblica per ogni server di punto vendita, API pubbliche con chiavi per gruppo, rate limit e conteggio d'uso.
2. **API REST rigorose** (`doc/API-Guidelines.md`) al posto delle chiamate `POST` che simulavano query MongoDB.
3. **Copertura dei test al 100%**, applicata dalla suite.
4. **Dipendenze minime**: `express`, `mongodb`, `body-parser`, `compression`, `multer`; il resto con le API native di Node o su approvazione.
5. **Sviluppo per passi**: un dominio alla volta, completo di test e documentazione prima del successivo.

## Stack e architettura
Node.js 24 LTS, ESM, Express 5, driver ufficiale MongoDB, `node:test`. Un database common (identità e tenancy) più un database per gruppo, con nomi dipendenti dall'ambiente (`doc/Architecture.md`, `doc/Data-Model.md`).

## Fuori scopo (per ora)
Tutto ciò che non è stato deciso in un passo approvato. La roadmap dei passi si definisce con l'utente.
