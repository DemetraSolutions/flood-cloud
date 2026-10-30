---
name: legacy-module-analysis
description: Usa prima di riscrivere un dominio (prodotti, vendite, magazzino, documenti…) per analizzare il servizio ms-* corrispondente del legacy e produrre una specifica funzionale da discutere con l'utente.
---
# Legacy Module Analysis

## Dove guardare
Progetto: `../cloud-commerce-platform-server` (sola lettura).
- Router: `ms/ms-<domain>-service/routers/Router.mjs` (percorsi e verbi).
- Logica: `ms/ms-<domain>-service/controllers/Controller_v_1.0.mjs`.
- Montaggio e autenticazione: `index.mjs`.
- Uso dai client: `../cloud-commerce-backoffice-client`, `../cloud-commerce-pos` (cerca il percorso `ms/<domain>/`).

Non leggere né riportare valori di segreti (`package.json` scripts, `deploy-prod/`, `keys/`).

## Specifica da produrre
```markdown
# <Dominio> — specifica funzionale (da legacy)

## Scopo
## Entità e campi
| Campo | Tipo | Significato | Obbligatorio | Note (valori ammessi, unità, es. prezzi in centesimi?) |
## Relazioni
## Operazioni usate dai client
| Operazione legacy | Chi la usa (backoffice/POS) | Cosa fa davvero | Proposta nel nuovo API |
## Regole di business ed effetti collaterali
## Permessi osservati (ruoli, controlli presenti o mancanti)
## Problemi del legacy da non ripetere
## Dati da migrare
## Domande aperte per l'utente
```

## Regole
- Distingui ciò che il codice **fa** da ciò che **sembra voler fare**: se divergono, è una domanda per l'utente.
- Le operazioni generiche del legacy (`find`, `aggregate`, `updateMany` con query del client) vanno ricondotte agli **usi reali** dei client: sono quelli a definire gli endpoint nuovi.
- Nessun codice nel nuovo progetto finché la specifica non è approvata.
