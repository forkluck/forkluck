"""Allergen tags read off a package, and the hints one ingredient carries.

Nothing here is an assertion. A hint says "the package text mentions this" or
"the catalog cannot say for your brand"; only a user override or a catalog
default states what an ingredient contains. The keyword lists are deliberately
short: a tag this parser misses costs a suggestion, a tag it invents costs
trust.
"""

import re

from ...models import CatalogIngredient, Ingredient, IngredientAllergenStatus

# Keyword -> tag. Every entry is matched whole-word on the normalized text,
# with an optional plural "s", so "almonds" hits "almond" and "maltodextrin"
# misses "malt".
_WHEAT_WORDS = (
    "wheat",
    "durum",
    "semolina",
    "spelt",
    "kamut",
    "farina",
    "bulgur",
    "couscous",
    "seitan",
)
KEYWORDS: dict[str, tuple[str, ...]] = {
    "milk": (
        "milk",
        "butter",
        "cream",
        "cheese",
        "whey",
        "casein",
        "caseinate",
        "lactose",
        "yogurt",
        "yoghurt",
        "ghee",
        "buttermilk",
    ),
    "egg": ("egg", "eggs", "albumen", "albumin", "mayonnaise"),
    "fish": (
        "fish",
        "anchovy",
        "anchovies",
        "cod",
        "salmon",
        "tuna",
        "sardine",
        "haddock",
        "pollock",
        "fish sauce",
    ),
    "shellfish": ("shrimp", "prawn", "crab", "lobster", "crayfish", "krill"),
    "mollusks": (
        "clam",
        "mussel",
        "oyster",
        "scallop",
        "squid",
        "octopus",
        "snail",
        "cuttlefish",
    ),
    "tree_nuts": (
        "almond",
        "walnut",
        "pecan",
        "cashew",
        "pistachio",
        "hazelnut",
        "filbert",
        "macadamia",
        "brazil nut",
        "pine nut",
    ),
    "peanut": ("peanut", "peanuts", "groundnut"),
    "wheat": _WHEAT_WORDS,
    "gluten_cereals": (*_WHEAT_WORDS, "rye", "barley", "malt", "oats", "oat", "triticale"),
    "soy": ("soy", "soya", "soybean", "soybeans", "tofu", "edamame", "miso", "tempeh"),
    "sesame": ("sesame", "tahini"),
    "sulphites": (
        "sulfite",
        "sulfites",
        "sulphite",
        "sulphites",
        "sulfur dioxide",
        "sulphur dioxide",
        "metabisulfite",
        "metabisulphite",
    ),
    "mustard": ("mustard",),
    "celery": ("celery", "celeriac"),
    "lupin": ("lupin", "lupine"),
}

# Phrases whose "milk" or "butter" is not dairy. Removed from the text before
# the milk keywords run, and only then: "peanut butter" still names a peanut.
_MILK_EXCLUSIONS = (
    "cream of tartar",
    "coconut milk",
    "almond milk",
    "oat milk",
    "soy milk",
    "rice milk",
    "cocoa butter",
    "shea butter",
    "peanut butter",
    "almond butter",
    "nut butter",
    "butternut",
)
# A gluten-free claim is the opposite of a gluten cereal.
_GLUTEN_EXCLUSIONS = ("gluten free",)
EXCLUSIONS: dict[str, tuple[str, ...]] = {
    "milk": _MILK_EXCLUSIONS,
    "gluten_cereals": _GLUTEN_EXCLUSIONS,
}

# A statement sentence starts with one of these; the rest of the sentence is
# the tag list it declares.
_CONTAINS_MARKERS = ("contains",)
_MAY_CONTAIN_MARKERS = (
    "may contain",
    "may also contain",
    "manufactured in a facility that also processes",
    "produced on shared equipment with",
)


def _normalize(text: str) -> str:
    """Lowercase, with every run of punctuation and space as one space.

    Padded, so a keyword pattern can look for spaces on both sides without a
    special case at either end.
    """
    return f" {re.sub(r'[^a-z0-9]+', ' ', text.casefold()).strip()} "


def _matches(text: str, keyword: str) -> bool:
    return re.search(rf" {re.escape(keyword)}s? ", text) is not None


def _tags(text: str) -> set[str]:
    """Every tag the normalized text names."""
    found = set()
    for tag, keywords in KEYWORDS.items():
        scanned = text
        for phrase in EXCLUSIONS.get(tag, ()):
            scanned = scanned.replace(f" {phrase} ", " ")
        if any(_matches(scanned, keyword) for keyword in keywords):
            found.add(tag)
    return found


def _statement(sentence: str, markers: tuple[str, ...]) -> str | None:
    """The tag list of a sentence that opens with one of these markers."""
    for marker in markers:
        if sentence.startswith(f" {marker} "):
            return sentence[len(marker) + 1 :]
    return None


def allergen_hints(text: str) -> dict[str, list[str]]:
    """Allergen tags a package ingredient list mentions.

    The scan reads the ingredient text; a trailing "CONTAINS ..." sentence
    adds to it, and a "MAY CONTAIN ..." or shared-equipment sentence declares
    its own tags instead of feeding the scan. A tag declared as contains never
    also reads as may-contain.
    """
    contains: set[str] = set()
    may_contain: set[str] = set()
    scanned: list[str] = []
    for raw in re.split(r"[.;]", text or ""):
        sentence = _normalize(raw)
        if sentence.strip() == "":
            continue
        declared = _statement(sentence, _MAY_CONTAIN_MARKERS)
        if declared is not None:
            may_contain |= _tags(declared)
            continue
        declared = _statement(sentence, _CONTAINS_MARKERS)
        if declared is not None:
            contains |= _tags(declared)
            continue
        scanned.append(sentence)
    for sentence in scanned:
        contains |= _tags(sentence)
    return {
        "contains": sorted(contains),
        "mayContain": sorted(may_contain - contains),
    }


def catalog_identity(ingredient: Ingredient) -> CatalogIngredient | None:
    """The catalog row an ingredient's allergen defaults come from."""
    if ingredient.catalog_ingredient_id:
        return ingredient.catalog_ingredient
    if ingredient.catalog_product_id and ingredient.catalog_product.ingredient_id:
        return ingredient.catalog_product.ingredient
    return None


def ingredient_allergen_hints(ingredient: Ingredient) -> dict[str, list[str]]:
    """Allergen tags this ingredient has not been told about yet.

    Read off its stored package text and off the catalog's brand-dependent
    rows. A tag the user has already decided, an override of any status,
    never appears, and neither does a contains hint the effective status
    already asserts. Packaging asserts nothing, so it hints nothing.
    """
    empty: dict[str, list[str]] = {"contains": [], "mayContain": [], "checkLabel": []}
    if ingredient.non_edible:
        return empty
    catalog = catalog_identity(ingredient)
    defaults: dict[str, str] = {}
    check_label: set[str] = set()
    if catalog is not None:
        for row in catalog.allergen_defaults.all():
            if row.status == IngredientAllergenStatus.CHECK_LABEL:
                check_label.add(row.allergen)
            else:
                defaults[row.allergen] = row.status
    decided = {row.allergen for row in ingredient.allergen_overrides.all()}
    parsed = allergen_hints(ingredient.nutrition_package_ingredients)
    asserted = {
        key
        for key, status in defaults.items()
        if status == IngredientAllergenStatus.CONTAINS
    }
    contains = set(parsed["contains"]) - decided - asserted
    may_contain = set(parsed["mayContain"]) - decided
    return {
        "contains": sorted(contains),
        "mayContain": sorted(may_contain),
        # The package already answered a check-your-label question.
        "checkLabel": sorted(check_label - decided - contains - may_contain),
    }


def has_allergen_hints(ingredient: Ingredient) -> bool:
    return any(ingredient_allergen_hints(ingredient).values())
