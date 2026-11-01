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
 * @property {'user'|'storeServer'|'apiKey'} kind type of the verified credential
 * @property {string} principalId id of the user, store server or API key
 * @property {string} credentialId id of the session, token or key (audit and revocation)
 * @property {string|null} role role, only for kind 'user' (PSA, D, SA, CA, PA)
 * @property {ReadonlySet<string>} permissions effective 'resource:action' permissions
 * @property {Scope} scope visible data perimeter, computed by the server
 */
/**
 * @typedef {object} Scope
 * @property {'all'|'groups'} level 'all' only for PSA
 * @property {string[]} groupIds visible groups (D: own groups; others: exactly one)
 * @property {string[]|null} companyIds null = every company of the visible groups
 * @property {string[]|null} placeIds null = every place of the visible companies
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
 * Returns a place visible to the caller, or null.
 * @param {AuthContext} auth verified context
 * @param {import('mongodb').ObjectId} placeId
 * @returns {Promise<object|null>}
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
