"""Small FoodData Central client and nutrient-shape adapter."""

import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


FDC_API_ROOT = "https://api.nal.usda.gov/fdc/v1"
FDC_API_KEY_ENV = "FDC_API_KEY"
# Grams of USDA proximates a record must account for. Bicarbonate reaches 69.
ACCOUNTED_MASS_FLOOR = 65.0


class FoodDataError(ValueError):
    pass


@dataclass(frozen=True)
class FoodDataMatch:
    fdc_id: int
    description: str
    data_type: str
    # The brand owner on a branded record; empty on a common food.
    brand: str = ""

    def as_json(self) -> dict[str, Any]:
        return {
            "fdcId": self.fdc_id,
            "description": self.description,
            "dataType": self.data_type,
            "brand": self.brand,
        }


def _api_key() -> str:
    value = os.getenv(FDC_API_KEY_ENV, "").strip()
    if not value:
        raise FoodDataError("Nutrition search is not configured")
    return value


def _request(path: str, *, payload: dict[str, Any] | None = None) -> Any:
    query = urlencode({"api_key": _api_key()})
    body = json.dumps(payload).encode() if payload is not None else None
    request = Request(
        f"{FDC_API_ROOT}{path}?{query}",
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Forkluck/1.0 (+https://forkluck.com)",
        },
        method="POST" if body is not None else "GET",
    )
    try:
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read())
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise FoodDataError(
            "Nutrition data is temporarily unavailable. Try again shortly."
        ) from exc


# Foundation and SR Legacy carry the analyzed staple records; FNDDS mostly
# describes prepared dishes, so it ranks last among equal name matches.
_DATA_TYPE_RANK = {"Foundation": 0, "SR Legacy": 1}


def _description_words(text: str) -> list[str]:
    return text.casefold().replace(",", " ").split()


def _ranked(query: str, matches: list[FoodDataMatch]) -> list[FoodDataMatch]:
    """Re-rank FDC's relevance order for kitchen queries.

    FDC scores a generic word like "sugar" higher on composite foods
    ("Beverages, tea, with sugar") than on the staple itself ("Sugars,
    granulated"), which buries the record people are actually after. Rank
    foods whose *name* (leading word) matches a query token first, then
    any-word matches, then FDC's own order as the tiebreak.
    """
    tokens = _description_words(query)

    def sort_key(pair: tuple[int, FoodDataMatch]) -> tuple[int, int, int, int]:
        index, match = pair
        words = _description_words(match.description)
        matched = all(any(word.startswith(token) for word in words) for token in tokens)
        leading = bool(words and any(words[0].startswith(token) for token in tokens))
        return (
            0 if matched else 1,
            0 if leading else 1,
            _DATA_TYPE_RANK.get(match.data_type, 2),
            index,
        )

    return [match for _, match in sorted(enumerate(matches), key=sort_key)]


COMMON_DATA_TYPES = ["Foundation", "SR Legacy", "Survey (FNDDS)"]
BRANDED_DATA_TYPES = ["Branded"]


def _brand(item: dict[str, Any]) -> str:
    for key in ("brandOwner", "brandName"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:120]
    return ""


def search_foods(
    query: str, *, scope: str = "common", page_size: int = 8
) -> list[FoodDataMatch]:
    # Ask FDC for far more than we show: the staple record for a generic
    # query often sits below its first page of composite foods.
    payload = _request(
        "/foods/search",
        payload={
            "query": query,
            "pageSize": max(page_size, 40),
            "dataType": BRANDED_DATA_TYPES if scope == "branded" else COMMON_DATA_TYPES,
        },
    )
    foods = payload.get("foods") if isinstance(payload, dict) else None
    if not isinstance(foods, list):
        raise FoodDataError("The nutrition search response was invalid")
    matches: list[FoodDataMatch] = []
    for item in foods:
        if not isinstance(item, dict):
            continue
        fdc_id = item.get("fdcId")
        description = item.get("description")
        data_type = item.get("dataType", "")
        if isinstance(fdc_id, int) and isinstance(description, str):
            matches.append(
                FoodDataMatch(fdc_id, description, str(data_type), _brand(item))
            )
    return _ranked(query, matches)[:page_size]


def _nutrient_amounts(food: dict[str, Any]) -> dict[int, float]:
    result: dict[int, float] = {}
    nutrients = food.get("foodNutrients")
    if not isinstance(nutrients, list):
        return result
    for row in nutrients:
        if not isinstance(row, dict):
            continue
        nested = row.get("nutrient")
        nutrient_id = (
            nested.get("id") if isinstance(nested, dict) else row.get("nutrientId")
        )
        amount = row.get("amount", row.get("value"))
        if isinstance(nutrient_id, int) and isinstance(amount, (int, float)):
            result[nutrient_id] = max(0.0, float(amount))
    return result


def _compose(
    *,
    water: float | None,
    fat: float,
    protein: float,
    carbohydrate: float,
    fiber: float,
    sugars: float,
    sodium_mg: float,
    ash: float,
    alcohol: float,
    extras: dict[str, float | None],
    enforce_floor: bool,
) -> dict[str, Any]:
    """Forkluck's per-100 g mass composition from label-style nutrients.

    Water, fat, protein, sugars, starch, fiber, salt and other sum to 100 g.
    A record that states no water (a branded label, a typed package) has it
    derived as what the stated mass leaves over. The rest of the keys are the
    label nutrients as reported: None where the record is silent, because an
    unknown is not a zero.
    """
    # Preserve sodium as supplied while also deriving salt equivalent for the
    # kitchen estimate. Keeping both avoids forcing one label definition onto
    # every consumer of the pinned nutrient snapshot.
    salt = sodium_mg / 1000 * 2.5
    starch = max(0.0, carbohydrate - fiber - sugars)
    # Sodium is part of ash, so the larger of the two is the mineral mass.
    minerals = max(ash, salt)
    if water is None:
        water = max(0.0, 100.0 - protein - fat - carbohydrate - minerals - alcohol)
    proximates = water + protein + fat + carbohydrate + minerals + alcohol
    if enforce_floor and proximates < ACCOUNTED_MASS_FLOOR:
        raise FoodDataError(
            "That food does not include complete nutrition data. Choose another result."
        )
    known = water + protein + fat + sugars + starch + fiber + salt
    other = max(0.0, 100.0 - known)
    # Saturates are a share of fat, not mass beside it, so they stay out of the
    # accounting above and are clamped to fat: a record whose saturates exceed
    # its own total fat is reporting one of the two wrong.
    saturated = extras.get("saturatedFat")
    if saturated is not None:
        saturated = min(saturated, fat)
    composition: dict[str, float | None] = {
        "water": water,
        "fat": fat,
        "protein": protein,
        "sugars": sugars,
        "starch": starch,
        "fiber": fiber,
        "salt": salt,
        "other": other,
        "totalCarbohydrate": carbohydrate,
        "sodiumMg": sodium_mg,
        "saturatedFat": saturated,
        "calories": extras.get("calories"),
        "transFat": extras.get("transFat"),
        "cholesterolMg": extras.get("cholesterolMg"),
        "addedSugars": extras.get("addedSugars"),
        "vitaminDMcg": extras.get("vitaminDMcg"),
        "calciumMg": extras.get("calciumMg"),
        "ironMg": extras.get("ironMg"),
        "potassiumMg": extras.get("potassiumMg"),
    }
    return {
        key: round(value, 4) if value is not None else None
        for key, value in composition.items()
    }


def _first(values: dict[int, float], *ids: int) -> float | None:
    for nutrient_id in ids:
        if nutrient_id in values:
            return values[nutrient_id]
    return None


def nutrition_per_100g(food: dict[str, Any]) -> dict[str, Any]:
    """Convert FDC's nutrient list to Forkluck's mass composition.

    Foundation and SR Legacy records are analyzed foods and account for
    their mass; a branded record is a label transcribed per 100 g, which
    rarely states water or ash, so its water is derived instead.
    """
    values = _nutrient_amounts(food)
    branded = food.get("dataType") == "Branded"
    # An analyzed food that states no water is an incomplete record, which
    # the mass floor below refuses; a branded label never states it.
    water = _first(values, 1051)
    if water is None and not branded:
        water = 0.0
    # Vitamin D arrives in micrograms (1114) or, on older labels, in IU
    # (1110); 40 IU is one microgram.
    vitamin_d = _first(values, 1114)
    if vitamin_d is None and 1110 in values:
        vitamin_d = values[1110] / 40
    return _compose(
        water=water,
        # Newer Foundation fats state total fat as the NLEA figure (1085)
        # and nothing under 1004.
        fat=_first(values, 1004, 1085) or 0.0,
        protein=values.get(1003, 0.0),
        carbohydrate=_first(values, 1005, 1050) or 0.0,
        fiber=_first(values, 1079, 2033) or 0.0,
        sugars=_first(values, 2000, 1063) or 0.0,
        sodium_mg=values.get(1093, 0.0),
        ash=values.get(1007, 0.0),
        alcohol=values.get(1018, 0.0),
        extras={
            "saturatedFat": _first(values, 1258),
            "calories": _first(values, 1008),
            "transFat": _first(values, 1257),
            "cholesterolMg": _first(values, 1253),
            "addedSugars": _first(values, 1442, 1235),
            "vitaminDMcg": vitamin_d,
            "calciumMg": _first(values, 1087),
            "ironMg": _first(values, 1089),
            "potassiumMg": _first(values, 1092),
        },
        enforce_floor=not branded,
    )


LABEL_VALUE_KEYS = (
    "calories",
    "fat",
    "saturatedFat",
    "transFat",
    "cholesterolMg",
    "sodiumMg",
    "totalCarbohydrate",
    "fiber",
    "sugars",
    "addedSugars",
    "protein",
    "vitaminDMcg",
    "calciumMg",
    "ironMg",
    "potassiumMg",
)


def label_nutrition_per_100g(
    values: dict[str, float | None], serving_grams: float
) -> dict[str, Any]:
    """A typed package label, per serving, as Forkluck's per-100 g snapshot.

    The label states no water, so it is derived as what the stated mass
    leaves over. A blank line on the package stays None.
    """
    if serving_grams <= 0:
        raise FoodDataError("Serving grams must be positive")
    scale = 100.0 / serving_grams

    def per_100(key: str) -> float | None:
        value = values.get(key)
        return None if value is None else float(value) * scale

    return _compose(
        water=None,
        fat=per_100("fat") or 0.0,
        protein=per_100("protein") or 0.0,
        carbohydrate=per_100("totalCarbohydrate") or 0.0,
        fiber=per_100("fiber") or 0.0,
        sugars=per_100("sugars") or 0.0,
        sodium_mg=per_100("sodiumMg") or 0.0,
        ash=0.0,
        alcohol=0.0,
        extras={
            key: per_100(key)
            for key in (
                "saturatedFat",
                "calories",
                "transFat",
                "cholesterolMg",
                "addedSugars",
                "vitaminDMcg",
                "calciumMg",
                "ironMg",
                "potassiumMg",
            )
        },
        enforce_floor=False,
    )


# The longest branded ingredient list FDC carries runs past 3000 characters;
# beyond this the text is a data error, not a package.
PACKAGE_INGREDIENTS_LIMIT = 4000


def _package_ingredients(food: dict[str, Any]) -> str:
    """The package's own ingredient list. Only a branded record has one."""
    value = food.get("ingredients")
    return value.strip()[:PACKAGE_INGREDIENTS_LIMIT] if isinstance(value, str) else ""


def get_food(fdc_id: int) -> tuple[str, dict[str, float], str]:
    payload = _request(f"/food/{fdc_id}")
    if not isinstance(payload, dict) or not isinstance(payload.get("description"), str):
        raise FoodDataError("The nutrition food response was invalid")
    description = payload["description"].strip()
    brand = _brand(payload)
    if brand:
        description = f"{description}, {brand}"
    return (
        description[:240],
        nutrition_per_100g(payload),
        _package_ingredients(payload),
    )
