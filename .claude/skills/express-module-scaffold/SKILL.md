---
name: express-module-scaffold
description: Usa quando crei un nuovo modulo di dominio o una nuova route Express 5: struttura dei file, dichiarazione di route con autenticazione e permesso obbligatori, strati route/controller/service/repository e test corrispondenti.
---
# Express Module Scaffold

## Struttura
```
src/modules/<domain>/
  <domain>.routes.js       # dichiarazione delle route
  <domain>.controller.js   # HTTP ↔ service
  <domain>.service.js      # regole di business, nessun req/res
  <domain>.repository.js   # unico accesso a MongoDB, con contesto di tenant
  <domain>.schemas.js      # schemi di validazione di body/query/params
  <domain>.mapper.js       # documento MongoDB → DTO di risposta
  indexes.js               # indici della collection
test/unit/modules/<domain>/...
test/integration/modules/<domain>.test.js
```
Crea **solo** i file che il passo richiede: un modulo di sola lettura non ha bisogno di schemi di update.

## Route dichiarative (deny by default)
Ogni route è un oggetto con `auth` **obbligatorio**. Il builder condiviso (`src/shared/http/define-routes.js`) monta nell'ordine autenticazione → autorizzazione → validazione → handler, e **lancia un errore all'avvio** se una route non dichiara `auth`, o se dichiara un'autenticazione diversa da `public` senza `permission`.
```js
import { listProductsQuery, productIdParams, createProductBody } from './products.schemas.js';

/**
 * Route del modulo prodotti.
 * @param {ReturnType<import('./products.controller.js').createProductsController>} controller
 * @returns {import('../../shared/http/define-routes.js').RouteDefinition[]}
 */
export function productsRoutes(controller) {
  return [
    { method: 'get', path: '/v1/products', auth: ['user', 'apiKey'], permission: 'products:read',
      schema: { query: listProductsQuery }, handler: controller.list },
    { method: 'get', path: '/v1/products/:id', auth: ['user', 'apiKey'], permission: 'products:read',
      schema: { params: productIdParams }, handler: controller.getById },
    { method: 'post', path: '/v1/products', auth: ['user'], permission: 'products:write',
      schema: { body: createProductBody }, handler: controller.create },
  ];
}
```
Le uniche route `auth: 'public'` ammesse sono quelle che lo sono per natura (health, login, refresh, webhook con firma propria) e vanno motivate in un commento.

## Controller
```js
/**
 * Crea il controller prodotti.
 * @param {{ productsService: ReturnType<import('./products.service.js').createProductsService> }} deps
 */
export function createProductsController({ productsService }) {
  return {
    /** @type {import('express').RequestHandler} */
    async list(req, res) {
      const page = await productsService.list(req.auth, req.valid.query);
      res.json({ data: page.items, page: page.page });
    },
    // ...
  };
}
```
- Il controller legge solo `req.auth` (contesto verificato) e `req.valid` (input validato), mai `req.body`/`req.query` grezzi.

## Checklist del modulo
- [ ] ogni route con `auth` e `permission`
- [ ] schemi per ogni input
- [ ] repository con contesto di tenant (skill `tenant-isolation`)
- [ ] indici dichiarati e creati all'avvio
- [ ] test unitari dei service e test di integrazione della catena completa, inclusi i rifiuti di sicurezza
- [ ] `doc/API.md` aggiornato (skill `docs-sync-checklist`)
