---
name: tenant-isolation
description: Usa quando scrivi codice che legge o modifica dati di un tenant: contesto di autenticazione req.auth, autorizzazione RBAC per permessi, scope company/place, repository con contesto obbligatorio, 404 cross-tenant e test di isolamento.
---
# Tenant Isolation & RBAC

## Contesto di autenticazione
Il middleware di autenticazione produce un oggetto **congelato** (`Object.freeze`) in `req.auth`:
```js
/**
 * @typedef {object} AuthContext
 * @property {'user'|'device'|'apiKey'} kind tipo di credenziale verificata
 * @property {string} principalId id dell'utente, del dispositivo o della API key
 * @property {string} tenantId tenant ricavato dalla credenziale
 * @property {string} role ruolo (solo per kind 'user')
 * @property {ReadonlySet<string>} permissions permessi effettivi 'risorsa:azione'
 * @property {{ companyIds: string[] | null, placeIds: string[] | null }} scope null = tutto il tenant
 * @property {string} credentialId id della sessione/chiave, per audit e revoca
 */
```
È l'**unica** fonte di tenant, ruolo, permessi e scope. Valori come `groupId`, `tenantId`, `role` nel body o nella query non vengono mai letti (e lo schema li rifiuta come campi sconosciuti).

## Autorizzazione
- Una sola policy (`src/shared/security/policy.js`) mappa ruolo → permessi; le API key e i dispositivi hanno i permessi dei propri scope.
- Il builder delle route applica `requirePermission(route.permission)`: 403 se manca.
- Regole più fini (es. "solo il proprio place") stanno nel service, usando `auth.scope`.

## Repository con contesto
```js
/**
 * Restituisce un prodotto del tenant, o null se non esiste nel suo scope.
 * @param {AuthContext} auth contesto verificato
 * @param {import('mongodb').ObjectId} id
 */
async function findById(auth, id) {
  return products.findOne({ _id: id, ...tenantFilter(auth) }, { projection: PUBLIC_FIELDS });
}
```
- `tenantFilter(auth)` produce `{ tenantId }` più i vincoli di scope (`placeId: { $in: auth.scope.placeIds }` se presente).
- Insert: `tenantId` e campi di scope impostati dal server, mai dal body.
- Update/delete: filtro **sempre** con `tenantFilter`; `matchedCount === 0` ⇒ 404.
- Se si adotta il database per tenant, il repository riceve il `Db` dal contesto e non può aprirne altri (decisione aperta in `doc/Security-Model.md` §10).

## Accesso cross-tenant
Solo per ruoli di piattaforma/dealer con permesso esplicito (es. `tenants:impersonate`), con tenant di destinazione verificato tra quelli consentiti e **registrato nell'audit log**. Mai tramite un parametro di query generico come il `?groupId=` del legacy.

## Test obbligatori per ogni risorsa di tenant
- Tenant B non vede la risorsa di A in lista e nel dettaglio (404).
- Tenant B non può modificarla né cancellarla (404, documento invariato).
- Utente con scope su place X non vede i dati di place Y.
- Body con `tenantId`/`groupId`/`role` ⇒ 422.
- Permesso mancante ⇒ 403.
