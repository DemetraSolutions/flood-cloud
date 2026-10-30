# Scopo del Prodotto — Flood Cloud

## Cos'è
**Flood Cloud** è il nuovo server della piattaforma cloud commerce di Flood: un SaaS multi-tenant di **cassa (POS) e backoffice** per attività commerciali italiane (retail, ristorazione e ospitalità, tabaccherie), con gestione di catalogo, magazzino, vendite, documenti fiscali, clienti e fedeltà, prenotazioni e report.

Sostituisce `cloud-commerce-platform-server` (analisi in `doc/Legacy-Analysis.md`) con una riscrittura completa, non un porting.

## Chi lo usa
- **Piattaforma e rivenditori (dealer)**: attivano e gestiscono i clienti.
- **Esercenti**: amministratori di gruppo, società e punti vendita, tramite il backoffice.
- **Operatori di cassa** tramite i **dispositivi POS** e kiosk.
- **Sistemi esterni** tramite API key (integrazioni, e-commerce) e provider (fatturazione elettronica, registratore telematico, pagamenti).

## Gerarchia di dominio
Dealer → **Group** (tenant) → **Company** (soggetto giuridico) → **Place** (punto vendita, con dispositivi, depositi, sale/tavoli). Catena centrale: **vendita → movimento di magazzino → documento fiscale**.

## Obiettivi della riscrittura
1. **Sicurezza rifatta da zero** secondo `doc/Security-Model.md`: deny by default, credenziali hashate e con scope, isolamento dei tenant garantito dal server.
2. **API a risorse tipizzate e validate**, al posto del proxy MongoDB generico del legacy.
3. **Copertura dei test al 100%**, applicata dalla suite.
4. **Dipendenze minime**: `express`, `mongodb`, `body-parser`, `compression`, `multer`; tutto il resto con le API native di Node o su approvazione.
5. **Sviluppo per passi**: un dominio alla volta, ciascuno completo di test e documentazione prima del successivo.

## Stack
Node.js 24 LTS, ESM, Express 5, driver ufficiale MongoDB, `node:test`.

## Fuori scopo (per ora)
Tutto ciò che non è stato deciso in un passo approvato. La roadmap dei passi si definisce con l'utente.
