"""Parser vocabulary read from the manifest the editor parser also reads.

`data/parser-vocabulary.json` is the single source for the word lists both
engines must spell the same way — unit aliases, qualifier and size words,
non-measure annotations, vulgar fractions, and the ingredient profiles measures
and each-weights resolve through. Regex assembly stays in each engine; only the
words are shared, so `apps/web/lib/recipe/parse.ts` and `domains/recipes/health.py`
cannot drift apart on what a line says.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .values import normalized_name

from ...paths import DATA_DIR

MANIFEST = DATA_DIR / "parser-vocabulary.json"


def load_vocabulary(path: Path = MANIFEST) -> dict[str, Any]:
    """Read and validate the manifest, raising ValueError on any defect."""
    if not path.is_file():
        raise ValueError(f"Vocabulary manifest not found: {path}")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Vocabulary manifest is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise ValueError("Vocabulary manifest must be an object")

    for key in (
        "qualifierWords",
        "sizeWords",
        "nonMeasureAnnotations",
        "profileAnnotations",
        "listMarkerGlyphs",
    ):
        terms = document.get(key)
        if (
            not isinstance(terms, list)
            or not terms
            or not all(isinstance(term, str) and term for term in terms)
        ):
            raise ValueError(f"Vocabulary {key} must be non-empty text")

    # Each engine assembles these into a character class, where a multi-character
    # entry would silently become several unrelated members.
    if any(len(glyph) != 1 for glyph in document["listMarkerGlyphs"]):
        raise ValueError("Vocabulary listMarkerGlyphs must each be one character")

    catalog = document.get("units")
    if not isinstance(catalog, list) or not catalog:
        raise ValueError("Vocabulary units must be a non-empty array")
    families = {"mass", "volume", "count", "dimensionless"}
    slugs: set[str] = set()
    for entry in catalog:
        if not isinstance(entry, dict):
            raise ValueError("Each units entry must be an object")
        slug = entry.get("slug")
        if not isinstance(slug, str) or not slug:
            raise ValueError("Each units entry needs a slug")
        if slug in slugs:
            raise ValueError(f"Duplicate unit: {slug}")
        slugs.add(slug)
        for key in ("label", "short"):
            if not isinstance(entry.get(key), str) or not entry[key]:
                raise ValueError(f"Unit {slug} needs a {key}")
        if entry.get("family") not in families:
            raise ValueError(f"Unit {slug} needs one of {sorted(families)}")
        factor = entry.get("perBase")
        if factor is not None and (
            isinstance(factor, bool)
            or not isinstance(factor, (int, float))
            or factor <= 0
        ):
            raise ValueError(f"Unit {slug} perBase must be positive or null")
        # Mass and volume are the two families that always convert, so a
        # missing factor there is a defect rather than "ask the ingredient".
        if entry["family"] in ("mass", "volume") and factor is None:
            raise ValueError(f"Unit {slug} must state how many base units it is")
        pattern = entry.get("pattern")
        if pattern is not None and (not isinstance(pattern, str) or not pattern):
            raise ValueError(f"Unit {slug} pattern must be text")

    fractions = document.get("vulgarFractions")
    if not isinstance(fractions, dict) or not fractions:
        raise ValueError("Vocabulary vulgarFractions must be a non-empty object")
    if not all(
        isinstance(key, str) and isinstance(value, str) and key and value
        for key, value in fractions.items()
    ):
        raise ValueError("Vocabulary vulgarFractions must map text to text")

    profiles = document.get("ingredientProfiles")
    if not isinstance(profiles, list) or not profiles:
        raise ValueError("Vocabulary ingredientProfiles must be a non-empty array")
    keys: set[str] = set()
    for profile in profiles:
        if not isinstance(profile, dict):
            raise ValueError("Each ingredientProfiles entry must be an object")
        key = profile.get("key")
        if not isinstance(key, str) or not key:
            raise ValueError("Each ingredientProfiles entry needs a key")
        if key in keys:
            raise ValueError(f"Duplicate profile key: {key}")
        keys.add(key)
        if not isinstance(profile.get("name"), str) or not profile["name"]:
            raise ValueError(f"Profile {key} needs a name")
        alias_names = profile.get("aliases")
        if not isinstance(alias_names, list) or not all(
            isinstance(term, str) and term for term in alias_names
        ):
            raise ValueError(f"Profile {key} aliases must be text")
        grams = profile.get("eachWeightG")
        if grams is not None and (
            isinstance(grams, bool)
            or not isinstance(grams, (int, float))
            or grams <= 0
        ):
            raise ValueError(f"Profile {key} eachWeightG must be positive")
    return document


@lru_cache(maxsize=1)
def vocabulary() -> dict[str, Any]:
    return load_vocabulary()


@lru_cache(maxsize=1)
def unit_slugs() -> frozenset[str]:
    """Every unit slug a recipe line or a menu component may be counted in."""
    return frozenset(str(row["slug"]) for row in vocabulary()["units"])


@lru_cache(maxsize=1)
def profile_by_alias() -> dict[str, str]:
    """Every profile name and alias, normalized, mapped to its canonical name."""
    return {
        normalized_name(term): normalized_name(profile["name"])
        for profile in vocabulary()["ingredientProfiles"]
        for term in (profile["name"], *profile["aliases"])
    }


@lru_cache(maxsize=1)
def profile_measure_names() -> frozenset[str]:
    """The canonical profile names a saved measure can be keyed on."""
    return frozenset(profile_by_alias().values())


@lru_cache(maxsize=1)
def each_weight_grams() -> dict[str, float]:
    """What one piece weighs, by canonical profile name, where a profile says."""
    return {
        normalized_name(profile["name"]): float(profile["eachWeightG"])
        for profile in vocabulary()["ingredientProfiles"]
        if profile.get("eachWeightG") is not None
    }
