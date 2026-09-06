"""Volume-to-weight rules read from the manifest the editor parser also reads.

`data/volume-measures.json` is the single source: the recipe-health read model
weighs a line from it, and `seed_volume_measures` installs the same numbers on
catalog ingredients, so the two cannot drift apart.
"""

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from ...paths import DATA_DIR

MANIFEST = DATA_DIR / "volume-measures.json"

MILLILITERS_PER_CUP = 236.5882365


def _load_document(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"Rule manifest not found: {path}")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Rule manifest is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise ValueError("Rule manifest must be an object")
    return document


def _standard_grams_per_cup(document: dict[str, Any]) -> float:
    grams = document.get("standardGramsPerCup")
    if isinstance(grams, bool) or not isinstance(grams, (int, float)):
        raise ValueError("Rule manifest needs a numeric standardGramsPerCup")
    if not 1 <= grams <= 2000:
        raise ValueError(f"standardGramsPerCup is out of range: {grams}")
    return float(grams)


def load_rules(path: Path = MANIFEST) -> list[dict[str, Any]]:
    """Read and validate the rule manifest, raising ValueError on any defect."""
    document = _load_document(path)
    _standard_grams_per_cup(document)
    rules = document.get("rules")
    if not isinstance(rules, list) or not rules:
        raise ValueError("Rule manifest must hold a non-empty 'rules' array")

    keys: set[str] = set()
    for position, rule in enumerate(rules, 1):
        if not isinstance(rule, dict):
            raise ValueError(f"Rule {position} must be an object")
        key = rule.get("key")
        if not isinstance(key, str) or not key:
            raise ValueError(f"Rule {position} needs a key")
        if key in keys:
            raise ValueError(f"Duplicate rule key: {key}")
        keys.add(key)
        match = rule.get("match")
        if not isinstance(match, list) or not match:
            raise ValueError(f"Rule {key} needs a non-empty 'match' list")
        if not all(isinstance(term, str) and term for term in match):
            raise ValueError(f"Rule {key} match terms must be non-empty text")
        for field in ("endings", "exclude", "categories"):
            terms = rule.get(field)
            if terms is not None and (
                not isinstance(terms, list)
                or not terms
                or not all(isinstance(term, str) and term for term in terms)
            ):
                raise ValueError(f"Rule {key} {field} must be non-empty text")
        grams = rule.get("gramsPerCup")
        if isinstance(grams, bool) or not isinstance(grams, (int, float)):
            raise ValueError(f"Rule {key} needs a numeric gramsPerCup")
        if not 1 <= grams <= 2000:
            raise ValueError(f"Rule {key} gramsPerCup is out of range: {grams}")
    return rules


@lru_cache(maxsize=1)
def default_rules() -> tuple[dict[str, Any], ...]:
    return tuple(load_rules())


@lru_cache(maxsize=1)
def default_standard_grams_per_cup() -> float:
    document = _load_document(MANIFEST)
    return _standard_grams_per_cup(document)


def _contains_phrase(words: list[str], phrase: str) -> bool:
    """Whole-word match, so "honey" does not read out of Honeycrisp Apples."""
    terms = phrase.split()
    if not terms:
        return False
    span = len(terms)
    return any(
        words[start : start + span] == terms
        for start in range(len(words) - span + 1)
    )


def _ends_with_phrase(words: list[str], phrase: str) -> bool:
    terms = phrase.split()
    return bool(terms) and words[len(words) - len(terms) :] == terms


def match_rule(
    words: list[str],
    rules: tuple[dict[str, Any], ...] | list[dict[str, Any]],
    category: str | None = None,
) -> dict[str, Any] | None:
    """The first rule that describes this name.

    The name must end on the product the rule names — "sugar snap peas" ends
    on peas and is not sugar; "peanut butter powder" is not the paste. A rule
    whose match term is a descriptor lists its product forms in ``endings``.
    A catalog category narrows which categorized rules may bind, but never
    excuses the terminal check: broad categories like grocery hold compound
    products too.
    """
    for rule in rules:
        categories = rule.get("categories")
        if categories and category is not None and category not in categories:
            continue
        if any(not _contains_phrase(words, term) for term in rule["match"]):
            continue
        if any(_contains_phrase(words, term) for term in rule.get("exclude", ())):
            continue
        if not any(
            _ends_with_phrase(words, term)
            for term in rule.get("endings") or rule["match"]
        ):
            continue
        return rule
    return None


def grams_for(
    milliliters: float,
    name: str,
    qualifier: str = "",
    *,
    allow_standard: bool = True,
) -> float | None:
    """What that volume of this ingredient weighs, from its name alone.

    Every rule and the standard estimate describe the ingredient in its plain
    state, so a parsed preparation or packing qualifier has no compatible
    answer and stays unresolved. Known rules win; otherwise a matched
    ingredient may use the shared 8 oz-weight-per-cup convention.
    """
    if qualifier:
        return None
    words = re.sub(r"[^a-z0-9\s]", " ", name.lower()).split()
    if not words:
        return None
    rule = match_rule(words, default_rules())
    if rule is None and not allow_standard:
        return None
    grams_per_cup = (
        rule["gramsPerCup"] if rule is not None else default_standard_grams_per_cup()
    )
    return milliliters / MILLILITERS_PER_CUP * grams_per_cup
