#!/usr/bin/env bash
# Allinea l'ambiente Claude Code (.claude/) alla sorgente Antigravity (.agents/).
#
# La sorgente autoritativa e' SEMPRE .agents/: i file sotto .claude/ sono duplicati
# esatti, necessari perche' i due ambienti leggono percorsi diversi e non condivisi.
#
# Uso:
#   ./scripts/sync-agents.sh          copia .agents/ -> .claude/ (sovrascrive)
#   ./scripts/sync-agents.sh --check  verifica l'allineamento senza scrivere (exit 1 se diverge)
#
# Exit code: 0 allineato / sincronizzato, 1 divergenze rilevate in modalita' --check.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC_RULES=".agents/rules"
SRC_SKILLS=".agents/skills"
DST_RULES=".claude/agents"
DST_SKILLS=".claude/skills"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

drift=0

# Confronta un singolo file e, se richiesto, lo allinea.
compare_or_copy() {
  local src="$1" dst="$2"
  if cmp -s "$src" "$dst" 2>/dev/null; then
    return 0
  fi
  drift=1
  if [[ $CHECK_ONLY -eq 1 ]]; then
    echo "DIVERGE: $dst"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "aggiornato: $dst"
  fi
}

for src in "$SRC_RULES"/*.md; do
  compare_or_copy "$src" "$DST_RULES/$(basename "$src")"
done

for dir in "$SRC_SKILLS"/*/; do
  name="$(basename "$dir")"
  while IFS= read -r -d '' src; do
    compare_or_copy "$src" "$DST_SKILLS/$name/${src#"$dir"}"
  done < <(find "$dir" -type f -print0)
done

# Segnala i file orfani in .claude/ non piu' presenti in .agents/ (vanno rimossi a mano).
for dst in "$DST_RULES"/*.md; do
  [[ -e "$SRC_RULES/$(basename "$dst")" ]] || { echo "ORFANO (rimuovilo): $dst"; drift=1; }
done
for dir in "$DST_SKILLS"/*/; do
  [[ -e "$SRC_SKILLS/$(basename "$dir")" ]] || { echo "ORFANO (rimuovilo): $dir"; drift=1; }
done

if [[ $CHECK_ONLY -eq 1 ]]; then
  [[ $drift -eq 0 ]] && { echo "OK: .claude/ e' allineata a .agents/"; exit 0; }
  echo "ERRORE: .claude/ non e' allineata. Esegui ./scripts/sync-agents.sh"
  exit 1
fi

if [[ $drift -eq 0 ]]; then
  echo "OK: nessuna modifica necessaria, .claude/ era gia' allineata."
else
  echo "OK: sincronizzazione completata."
fi
exit 0
