---
name: tenant-isolation
description: Usa quando scrivi codice che legge o modifica dati di un gruppo, azienda o punto vendita: contesto req.auth, ruoli PSA/D/SA/CA/PA, scope calcolato dal server, database del gruppo risolto dal contesto, RBAC per permessi, 404 fuori scope e test di isolamento.
---
# Tenant Isolation & RBAC

Riferimenti: `doc/Security-Model.md` §8, `doc/Architecture.md` §3.

## Contesto di autenticazione
Ogni middleware di autenticazione produce un oggetto **congelato** in `req.auth`:
```js
/**
 * @typedef {object} AuthContext
 * @property {'user'|'storeServer'|'apiKey'} kind tipo di credenziale verificata
 * @property {string} principalId id dell'utente, del server di punto vendita o della API key
 * @property {string} credentialId id della sessione, del token o della chiave (audit e revoca)
 * @property {string|null} role ruolo, solo per kind 'user' (PSA, D, SA, CA, PA)
 * @property {ReadonlySet<string>} permissions permessi effettivi 'risorsa:azione'
 * @property {Scope} scope perimetro dei dati visibili, calcolato dal server
 */
/**
 * @typedef {object} Scope
 * @property {'all'|'groups'} level 'all' solo per PSA
 * @property {string[]} groupIds gruppi visibili (D: i propri gruppi; altri: uno)
 * @property {string[]|null} companyIds null = tutte le aziende dei gruppi visibili
 * @property {string[]|null} placeIds null = tutti i punti vendita delle aziende visibili
 */
```
| Credenziale | Scope |
|---|---|
| PSA | `level: 'all'` |
| D | i gruppi con `dealerId` del dealer |
| SA | il proprio gruppo |
| CA | il proprio gruppo, `companyIds` |
| PA | il proprio gruppo, `placeIds` |
| server di punto vendita | il proprio gruppo, azienda e punto vendita (fisso) |
| API key pubblica | il proprio gruppo, restrizioni opzionali |
Valori come `groupId`, `role`, `permissions` nel body o nella query non vengono mai letti: lo schema li rifiuta.

## Gruppo di lavoro e database
- Le risorse del gruppo stanno nel database `<prefix><env>_<groupId>`. Il gruppo su cui operare viene:
  - dalla credenziale, se lo scope contiene un solo gruppo;
  - dal percorso (`/v1/groups/:groupId/...`) per PSA e D, **verificato** contro lo scope (fuori scope ⇒ `404`).
- Un helper unico (`resolveGroupDb(auth, groupId)`) valida l'id, controlla lo scope e restituisce il `Db`; i repository ricevono quel `Db` e non ne aprono altri.

## Autorizzazione
- Una sola policy (`src/shared/security/policy.js`) mappa ruolo → permessi; server di punto vendita e API key hanno i propri permessi.
- Il builder delle route applica `requirePermission(route.permission)` ⇒ `403`.
- Gli utenti `E` non hanno alcun permesso sul backoffice.
- Gestione utenti: si creano e modificano solo utenti di ruolo inferiore e nel proprio scope; nessuno modifica il proprio ruolo o scope.

## Repository con contesto
```js
/**
 * Restituisce un punto vendita visibile al chiamante, o null.
 * @param {AuthContext} auth contesto verificato
 * @param {import('mongodb').ObjectId} placeId
 */
async function findPlaceById(auth, placeId) {
  return places.findOne({ _id: placeId, ...scopeFilter(auth) }, { projection: PUBLIC_FIELDS });
}
```
- `scopeFilter(auth)` traduce lo scope in filtro (`groupId: { $in }`, `companyId: { $in }`, `_id`/`placeId: { $in }`); per `level: 'all'` non aggiunge vincoli.
- Insert: `groupId`, `companyId`, `placeId` impostati dal server, mai dal body.
- Update/delete: filtro **sempre** con `scopeFilter`; `matchedCount === 0` ⇒ `404`.

## Audit
Ogni accesso di PSA o D a un gruppo è registrato nell'audit log (attore, gruppo, azione).

## Test obbligatori per ogni risorsa
- Gruppo B non vede, modifica o cancella le risorse di A (`404`, dati invariati).
- D vede i propri gruppi e non quelli di un altro dealer.
- CA e PA vedono solo le proprie aziende e i propri punti vendita.
- Server di punto vendita limitato al proprio punto vendita.
- Body con `groupId`/`role` ⇒ `422`; permesso mancante ⇒ `403`; utente `E` ⇒ nessun accesso al backoffice.
