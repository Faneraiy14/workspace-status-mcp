#!/bin/sh
# Ставить dispatch.sh як глобальні git-хуки: ~/.config/git/hooks/<ім'я> + core.hooksPath.
# Повторний запуск безпечний (лише перезаписує ці копії).
set -e
src="$(cd "$(dirname "$0")" && pwd)/dispatch.sh"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/git/hooks"
existing="$(git config --global core.hooksPath || true)"
if [ -n "$existing" ] && [ "$existing" != "$dest" ]; then
    echo "core.hooksPath уже = $existing - не перезаписую" >&2; exit 1
fi
mkdir -p "$dest"
for h in applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg \
         commit-msg post-commit pre-rebase post-checkout post-merge pre-push post-rewrite pre-auto-gc; do
    cp "$src" "$dest/$h"; chmod +x "$dest/$h"
done
git config --global core.hooksPath "$dest"
echo "встановлено в $dest"
