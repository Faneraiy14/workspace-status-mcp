#!/bin/sh
# Глобальний git-хук (core.hooksPath = тека з цими файлами). Кожне ім'я хука
# тут - копія цього самого скрипта.
#
# 1) core.hooksPath вимикає репо-локальні .git/hooks/*, тож спершу запускаємо
#    локальний хук з тим самим іменем, якщо він є (напр. поставлений
#    pre-commit/husky) - щоб глобальний хук нічого не ламав.
# 2) Лише для pre-push: у фоні копіюємо всі <projects>/*/.arch/ у приватний
#    бекап і пушимо його (bin/arch-backup.mjs). Push репо на нього не чекає
#    і не може через нього впасти. ARCH_BACKUP=0 вимикає (так робить сам
#    бекап, коли пушить себе, - інакше було б нескінченне коло).
name=$(basename "$0")
local_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/$name"
status=0
if [ -x "$local_hook" ]; then
    "$local_hook" "$@"
    status=$?
fi

if [ "$name" = "pre-push" ] && [ "$status" -eq 0 ] && [ "${ARCH_BACKUP:-1}" != "0" ]; then
    projects="${ARCH_PROJECTS_ROOT:-$HOME/Projects}"
    backup="${ARCH_BACKUP_DIR:-$projects/Architecture-backup}"
    script="${ARCH_BACKUP_SCRIPT:-$projects/workspace-status-mcp/bin/arch-backup.mjs}"
    if [ -d "$backup/.git" ] && [ -f "$script" ] && command -v node >/dev/null 2>&1; then
        nohup node "$script" "$projects" "$backup" --push-now >/dev/null 2>&1 &
    fi
fi
exit $status
