"""Validate the checked-in skill metadata without depending on an agent install.

Every repository path a skill names in backticks must exist, so the skills
cannot silently rot when files move.
"""
from pathlib import Path
import re
import sys

import yaml

root = Path(__file__).resolve().parents[1]
PATH_TOKEN = re.compile(r"`((?:AGENTS|ARCHITECTURE)\.md|(?:docs|apps|services|skills|data|deploy)/[^`\s]+)`")
errors = []
for directory in sorted((root / "skills").iterdir()):
    if not directory.is_dir() or directory.name.startswith("."):
        continue
    try:
        text = (directory / "SKILL.md").read_text()
        sections = text.split("---", 2)
        if len(sections) != 3 or sections[0].strip() or not sections[2].strip():
            raise ValueError("SKILL.md needs YAML frontmatter and a body")
        metadata = yaml.safe_load(sections[1])
        if not isinstance(metadata, dict):
            raise ValueError("frontmatter must be a mapping")
        name = metadata.get("name")
        if name != directory.name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
            raise ValueError("name must match the directory and use lowercase kebab case")
        description = metadata.get("description")
        if not isinstance(description, str) or not 1 <= len(description.strip()) <= 1024:
            raise ValueError("description must contain 1–1024 characters")
        interface = yaml.safe_load((directory / "agents/openai.yaml").read_text())["interface"]
        for field in ("display_name", "short_description", "default_prompt"):
            if not isinstance(interface.get(field), str) or not interface[field].strip():
                raise ValueError(f"interface.{field} is required")
        if f"${name}" not in interface["default_prompt"]:
            raise ValueError("default_prompt must invoke this skill")
        missing = sorted(
            {
                token
                for token in PATH_TOKEN.findall(sections[2])
                # Installed dependencies are not part of the checkout.
                if "node_modules/" not in token and not (root / token.rstrip("/")).exists()
            }
        )
        if missing:
            raise ValueError(f"paths not found in this repository: {', '.join(missing)}")
        print(f"{name}: ok")
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError) as exc:
        errors.append(f"{directory.name}: {exc}")
for error in errors:
    print(error, file=sys.stderr)
sys.exit(bool(errors))
