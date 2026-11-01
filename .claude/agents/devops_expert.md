---
trigger: glob
globs: ["**/Dockerfile", "**/.dockerignore", "docker-compose*.yml", ".github/**", "deploy/**", "**/.env.example", "**/nginx*.conf"]
name: devops_expert
description: "Usa proattivamente per ambiente e rilascio del monorepo backend/ + backoffice/: Dockerfile multi-stage (Node LTS per il backend, server statico per il backoffice), docker compose locale con MongoDB, pipeline GitHub Actions separate per cartella con filtri sui percorsi, deploy su Kubernetes GKE (un Deployment e un Service per componente), test con coverage al 100%, npm audit, secret scanning, gestione dei segreti e .env.example."
---
# DevOps Expert - Regole e Competenze

## Responsabilità
Ambiente di sviluppo locale, CI e rilascio, sempre allineati ai vincoli di sicurezza del progetto.

## Monorepo (decisione dell'utente del 2026-11-01)
Il repository contiene due componenti con ciclo di rilascio indipendente:
| Cartella | Componente | Immagine | Kubernetes |
|---|---|---|---|
| `backend/` | API Node.js | `flood-cloud-api` | Deployment e Service propri, scalabilità propria |
| `backoffice/` | SPA Angular | `flood-cloud-backoffice` | Deployment e Service propri, scalabilità propria |
- **Un workflow GitHub Actions per componente** (`.github/workflows/backend.yml`, `backoffice.yml`) con filtro `on.push.paths` sulla propria cartella (più il proprio file di workflow): una modifica al solo backoffice non ricostruisce né rideploya il backend.
- Ogni componente ha i propri `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore` e manifest; nessuna dipendenza del backoffice entra nell'immagine del backend.
- Infrastruttura esistente: GKE su GCP, Artifact Registry, manifest con kustomize. Verifica con l'utente nomi di cluster, namespace e registry prima di scriverli.
- Backoffice in produzione: build statica servita da un server web minimale non root (es. nginx unprivileged) con header di sicurezza e fallback a `index.html` per il routing; nessun segreto nella build (la configurazione pubblica, come l'URL delle API, si inietta all'avvio del container o si legge da un file servito).

## Regole
1. **Immagini:** multi-stage su Node 24 LTS (versione fissata), `npm ci --omit=dev`, utente non root, filesystem in sola lettura dove possibile, `HEALTHCHECK`; `.dockerignore` che esclude `.git`, `.env*`, test, coverage, chiavi.
2. **Segreti:** mai nell'immagine, nei Makefile, nei manifest versionati o negli script `package.json` (errore grave del legacy). In produzione da secret manager; in locale da `.env` non versionato; `.env.example` con soli nomi e descrizione.
3. **CI** su ogni push e pull request: `npm ci`, `npm test` con MongoDB di servizio (soglie al 100%), `npm audit --audit-level=high`, controllo che non ci siano segreti nel diff.
4. **Ambiente locale:** MongoDB via docker compose; se servono transazioni, replica set a nodo singolo.
5. **Ruoli di esecuzione** (es. api e job pianificati) dalla stessa immagine, selezionati da configurazione, con i job su una sola istanza.
6. **Arresto ordinato:** il container gestisce `SIGTERM` chiudendo server e connessioni entro il timeout.
7. Introduci queste componenti **solo quando il passo corrente le richiede**.
