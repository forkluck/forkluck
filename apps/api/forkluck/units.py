"""One vocabulary of units, read from data/parser-vocabulary.json.

The same file backs apps/web/lib/unit-registry.ts, so a unit is spelled one way in both
engines. A unit is identified by its slug. Mass and volume convert universally;
a container like a case or a bushel does not, because how much it holds is the
ingredient's business — those carry a factor of None, which is what makes "one
bushel, weight unknown" expressible. A dimensionless unit — a splash, to taste
— has no quantity at all.
"""

import json

# Read directly rather than through domains.shared.vocabulary: models.py needs
# these units, and that module reaches back into models through values.py.
# `vocabulary.load_vocabulary` is still what validates the file.
from .paths import DATA_DIR

MANIFEST = DATA_DIR / "parser-vocabulary.json"

_UNITS = json.loads(MANIFEST.read_text(encoding="utf-8"))["units"]


def _factors(family: str) -> dict[str, float]:
    return {
        unit["slug"]: float(unit["perBase"])
        for unit in _UNITS
        if unit["family"] == family and unit["perBase"] is not None
    }


GRAMS_PER_UNIT: dict[str, float] = _factors("mass")
MILLILITERS_PER_UNIT: dict[str, float] = _factors("volume")
PIECES_PER_UNIT: dict[str, float] = _factors("count")

MASS_UNITS = frozenset(GRAMS_PER_UNIT)
VOLUME_UNITS = frozenset(MILLILITERS_PER_UNIT)
# The units with a size everyone agrees on: a gram, a cup, a piece. A container
# has none, because how much it holds is the ingredient's business. Mirrors a
# null `perBase` in apps/web/lib/unit-registry.ts.
SIZED_UNITS = MASS_UNITS | VOLUME_UNITS | frozenset(PIECES_PER_UNIT)
DIMENSIONLESS_UNITS = frozenset(
    unit["slug"] for unit in _UNITS if unit["family"] == "dimensionless"
)
# Units whose factor is a convention rather than a fact — a pinch, a dash.
APPROXIMATE_UNITS = frozenset(
    unit["slug"] for unit in _UNITS if unit.get("approximate")
)

# What a household measure can be written in: you measure with a cup, a bunch
# or a pinch, never with a gram, and a splash has no quantity to record. An
# approximate unit belongs here because a saved measure is what overrules it.
MEASURE_UNIT_CHOICES: list[tuple[str, str]] = [
    (unit["slug"], unit["label"])
    for unit in _UNITS
    if unit["family"] in ("volume", "count") or unit.get("approximate")
]
MEASURE_UNIT_VALUES = frozenset(slug for slug, _ in MEASURE_UNIT_CHOICES)


def measure_unit_choices() -> list[tuple[str, str]]:
    """Passed to the model field as a callable so a catalog edit does not
    rewrite the whole list into a new migration."""
    return MEASURE_UNIT_CHOICES

# What one sold unit of a product is. Curated rather than derived from a
# family, because the count family also carries egg grades (large, jumbo) and
# containers whose contents nobody knows (case, tray), and a menu item is sold
# by none of them. A product measured in nothing is measured in "each", which
# is why the blank default is not in this list.
PRODUCT_UNIT_SLUGS = (
    "g",
    "kg",
    "oz",
    "lb",
    "ml",
    "l",
    "fl-oz",
    "each",
    "dozen",
    "slice",
    "portion",
    "serving",
)
_UNIT_LABELS = {unit["slug"]: unit["label"] for unit in _UNITS}
PRODUCT_UNIT_CHOICES: list[tuple[str, str]] = [
    (slug, _UNIT_LABELS[slug]) for slug in PRODUCT_UNIT_SLUGS
]
PRODUCT_UNIT_VALUES = frozenset(PRODUCT_UNIT_SLUGS)


def product_unit_choices() -> list[tuple[str, str]]:
    """Passed to the model field as a callable so a catalog edit does not
    rewrite the whole list into a new migration."""
    return PRODUCT_UNIT_CHOICES


# Kept for callers that only ever deal in weights.
WEIGHT_FACTORS = {unit: GRAMS_PER_UNIT[unit] for unit in ("g", "kg", "oz", "lb")}

# What a pack is bought by. Curated rather than derived from a family, the way
# PRODUCT_UNIT_SLUGS is, because the count family also carries egg grades and
# recipe measures nobody buys by. A supplier import validates its pack unit
# against this list. Mirrors PACK_UNIT_SLUGS in apps/web/lib/unit-registry.ts, which is
# the same list the purchase picker offers; a parity test holds the two
# together.
PACK_UNIT_SLUGS = (
    "g",
    "kg",
    "oz",
    "lb",
    "ml",
    "l",
    "fl-oz",
    "cup",
    "pt",
    "qt",
    "gal",
    "each",
    "dozen",
    "case",
    "pack",
    "bag",
    "box",
    "bottle",
    "can",
    "carton",
    "jar",
    "bunch",
)
PACK_UNIT_VALUES = frozenset(PACK_UNIT_SLUGS)

# The spellings a total yield counts pieces in. A tart is "8 slice" the way a
# crust is "1 pcs", and both mean a count of what one batch cuts into, so
# everything that reads a yield treats a slice as one piece. "pcs" is not in
# the catalog and "slice" has no size to convert by, so neither reaches "each"
# on its own. Mirrors countedAsEach in apps/web/lib/unit-registry.ts.
COUNT_YIELD_UNITS = frozenset({"pcs", "slice"})


def counted_as_each(slug: str | None) -> str | None:
    """"each" for a yield's count spellings, and the slug itself otherwise."""
    return "each" if slug in COUNT_YIELD_UNITS else slug


def unit_family(slug: str | None) -> str | None:
    if not slug:
        return None
    if slug in MASS_UNITS:
        return "mass"
    if slug in VOLUME_UNITS:
        return "volume"
    if slug in DIMENSIONLESS_UNITS:
        return "dimensionless"
    return "count"


def _per_base(slug: str) -> float | None:
    if slug in GRAMS_PER_UNIT:
        return GRAMS_PER_UNIT[slug]
    if slug in MILLILITERS_PER_UNIT:
        return MILLILITERS_PER_UNIT[slug]
    return PIECES_PER_UNIT.get(slug)


def unit_ratio(source: str | None, target: str | None) -> float | None:
    """How many `target` units one `source` unit is, or None when nothing
    universal relates them. None is an answer: it means ask the ingredient."""
    if not source or not target:
        return None
    if source == target:
        return 1.0
    if unit_family(source) != unit_family(target):
        return None
    source_base = _per_base(source)
    target_base = _per_base(target)
    if source_base is None or target_base is None:
        return None
    return source_base / target_base


def convert_amount(
    amount: float, source: str | None, target: str | None
) -> float | None:
    ratio = unit_ratio(source, target)
    return None if ratio is None else amount * ratio


def to_grams(amount, unit: str | None) -> int | None:
    """A pack's weight for the columns that still require one. None when the
    unit carries no weight of its own."""
    if amount is None:
        return None
    grams = convert_amount(float(amount), unit, "g")
    return None if grams is None else round(grams)
