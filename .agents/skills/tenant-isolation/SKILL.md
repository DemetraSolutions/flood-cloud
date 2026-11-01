---
name: tenant-isolation
description: Usa quando scrivi codice che legge o modifica dati di un gruppo, azienda o punto vendita: contesto req.auth, ruoli PSA/D/SA/CA/PA, scope calcolato dal server, database del gruppo risolto dal contesto, RBAC per permessi, 404 fuori scope e test di isolamento.
---
# Tenant Isolation & RBAC

Riferimenti: `doc/Security-Model.md` §8, `doc/Architecture.md` §3.

## Contesto di autenticazione
Ogni middleware di autenticazione produce un oggetto **congelato** in `req.auth`:
```ts
/** Data perimeter visible to the caller, computed by the server. */
export interface Scope {
  /** 'all' only for PSA */
  readonly level: 'all' | 'groups';
  /** visible groups (D: own groups; others: exactly one) */
  readonly groupIds: readonly string[];
  /** null = every company of the visible groups */
  readonly companyIds: readonly string[] | null;
  /** null = every place of the visible companies */
  readonly placeIds: readonly string[] | null;
}

/** Verified, frozen authentication context stored in req.auth. */
export interface AuthContext {
  /** type of the verified credential */
  readonly kind: 'user' | 'storeServer' | 'apiKey';
  /** id of the user, store server or API key */
  readonly principalId: string;
  /** id of the session, token or key (audit and revocation) */
  readonly credentialId: string;
  /** role, only for kind 'user' (PSA, D, SA, CA, PA) */
  readonly role: 'PSA' | 'D' | 'SA' | 'CA' | 'PA' | null;
  /** effective 'resource:action' permissions */
  readonly permissions: ReadonlySet<string>;
  /** visible data perimeter, computed by the server */
  readonly scope: Scope;
}
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
- Una sola policy (`src/shared/security/policy.ts`) mappa ruolo → permessi; server di punto vendita e API key hanno i propri permessi.
- Il builder delle route applica `requirePermission(route.permission)` ⇒ `403`.
- Gli utenti `E` non hanno alcun permesso sul backoffice.
- Gestione utenti: si creano e modificano solo utenti di ruolo inferiore e nel proprio scope; nessuno modifica il proprio ruolo o scope.

## Repository con contesto
```ts
import type { Collection, Document, ObjectId } from 'mongodb';

/**
 * Returns a place visible to the caller, or null.
 * @param places places collection of the group database
 * @param auth verified context
 * @param placeId id of the place
 */
async function findPlaceById(places: Collection, auth: AuthContext, placeId: ObjectId): Promise<Document | null> {
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
