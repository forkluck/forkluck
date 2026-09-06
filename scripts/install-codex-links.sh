#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skills_root="$repo_root/skills"
codex_root="${CODEX_HOME:-$HOME/.codex}"
install_root="$codex_root/skills"

mkdir -p "$install_root"

for source in "$skills_root"/*; do
    [[ -d "$source" ]] || continue
    name="$(basename "$source")"
    target="$install_root/$name"

    if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
        echo "Linked $name"
        continue
    fi
    if [[ -e "$target" || -L "$target" ]]; then
        echo "Refusing to replace existing path: $target" >&2
        exit 1
    fi

    ln -s "$source" "$target"
    echo "Linked $name"
done
