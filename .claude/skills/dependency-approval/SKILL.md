---
name: dependency-approval
description: Usa prima di installare, aggiornare o proporre qualsiasi pacchetto npm (anche devDependency): verifica necessità, alternative native, ultima versione stabile e richiesta di approvazione all'utente.
---
# Dependency Approval

Il progetto installa **solo le librerie strettamente necessarie** (`GEMINI.md` §11).

## Dipendenze approvate
| Pacchetto | Uso |
|---|---|
| `express` | server HTTP e routing (v5) |
| `mongodb` | driver ufficiale MongoDB |
| `body-parser` | parsing dei body JSON/urlencoded con limiti espliciti |
| `compression` | compressione delle risposte |
| `multer` | upload multipart |

Qualsiasi altro pacchetto richiede l'approvazione esplicita dell'utente. Quando viene approvato, aggiungilo a questa tabella.

## Prima di proporre una dipendenza
1. **Esiste un'API nativa?** Controlla prima Node.js: `node:crypto` (hash, HMAC, scrypt, randomBytes, timingSafeEqual), `node:test` e `node:assert` (test e mock), `fetch` (client HTTP), `node:util` (`parseArgs`, `styleText`), `node:fs/promises`, `AbortSignal.timeout`, `structuredClone`, `process.loadEnvFile` (file `.env`).
2. **Il codice necessario è piccolo e testabile?** Se sì, scrivilo e coprilo con i test invece di aggiungere un pacchetto.
3. **Il dominio è ad alto rischio** (crittografia di basso livello, parsing di formati complessi)? Lì una libreria matura è preferibile a codice proprio: segnalalo.

## Proposta all'utente
Presenta: nome, ultima versione stabile (`npm view <pkg> dist-tags`), motivo, alternativa nativa scartata e perché, numero di dipendenze transitive (`npm view <pkg> dependencies`), licenza, stato di manutenzione. Attendi il sì.

## Installazione
- Ultima versione **stabile** (`latest`, mai `next`, `alpha`, `beta`, `rc`).
- Versione esatta: `npm install --save-exact <pkg>@<versione>`.
- Dopo l'installazione: `npm audit` e test completi.
