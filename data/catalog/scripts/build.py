#!/usr/bin/env python3
"""Build catalog.csv from seeds.csv and a USDA SR Legacy CSV export.

    python3 data/catalog/scripts/build.py --seeds data/catalog/seeds.csv --sr ~/Downloads/sr_legacy --out data/catalog/catalog.csv

The SR Legacy zip is never committed; pass the directory it unpacks to.
Rows whose source does not start with "usda:" are hand-written and survive a
rebuild verbatim.
"""
import argparse
import csv
import os
import re

FIELDS = ["id", "name", "synonyms", "allergens", "verify", "preparation",
          "yield", "grams", "volume", "each", "estimated", "source"]

VOLUME_MEASURES = {
    "cup": "cup", "cups": "cup",
    "tbsp": "tbsp", "tablespoon": "tbsp", "tablespoons": "tbsp",
    "tsp": "tsp", "teaspoon": "tsp", "teaspoons": "tsp",
    "fl oz": "fl-oz", "fluid ounce": "fl-oz", "fluid ounces": "fl-oz",
}
COUNT_MEASURES = {
    "clove": "clove", "cloves": "clove", "bunch": "bunch", "bunches": "bunch",
    "stalk": "stalk", "stalks": "stalk", "head": "head", "heads": "head",
    "sprig": "sprig", "sprigs": "sprig", "leaf": "leaf", "leaves": "leaf",
    "ear": "ear", "ears": "ear", "stick": "stick", "sticks": "stick",
    "slice": "slice", "slices": "slice",
}
# Generic item nouns SR uses for one of the food itself; anything cut-specific
# ("steak", "fillet", "breast") is left alone because no unit matches it.
PIECE_MEASURES = {
    "fruit", "piece", "pieces", "olive", "olives", "date", "dates", "prune",
    "prunes", "cherry", "cherries", "anchovy", "anchovies", "tortilla",
    "tortillas", "artichoke", "berry", "berries", "mushroom", "mushrooms",
    "pepper", "peppers", "potato", "potatoes", "carrot", "onion", "tomato",
}
SIZES = {"small": "small", "medium": "medium", "large": "large",
         "extra large": "extra-large", "jumbo": "jumbo"}
# Descriptors that still mean the plain ingredient.
PLAIN = {"", "whole", "ground", "leaves", "pieces", "sections", "crumbled",
         "crumbled not packed", "not packed", "pitted", "without pits",
         "unsifted dipped", "unsifted", "drained", "with liquid", "kernels",
         "arils seed juice sacs", "florets", "cooked", "boneless"}
PREPARATIONS = {
    "chopped": "chopped", "chopped or diced": "chopped",
    "chopped or sliced": "chopped", "diced": "diced", "cubes": "diced",
    "cubed": "diced", "sliced": "sliced", "slices": "sliced",
    "grated": "grated", "shredded": "shredded", "minced": "minced",
    "melted": "melted", "packed": "packed", "sifted": "sifted",
    "halves": "halved", "halved": "halved", "mashed": "mashed",
}
UNIT_ORDER = ["cup", "tbsp", "tsp", "fl-oz"]

# Seeds whose SR entry carries no household portion the units vocabulary can
# express (meat and fish are sold by weight there): kitchen estimates.
HAND_ROWS = {
    "water": [("", "", "237", "1 cup", "", "no", "si:density")],
    # A recipe that says "1 egg" means a large one, not USDA's medium default.
    "egg": [("", "", "50", "", "1 each", "no", "usda:171287")],
    # And "1 yolk" means the yolk of a large egg.
    "egg-yolk": [("", "", "17", "", "1 each", "no", "usda:172184")],
    # SR lists lemon juice by the cup and the fluid ounce only.
    "lemon-juice": [("", "", "15", "1 tbsp", "", "no", "usda:167747")],
    "pomegranate": [("", "", "282", "", "1 each", "yes", "")],
    "coconut-shredded": [("", "", "80", "1 cup", "", "yes", "")],
    "greek-yogurt": [("", "", "245", "1 cup", "", "yes", "")],
    "goat-cheese": [("", "", "135", "1 cup", "", "yes", "")],
    "pasta-dry": [("", "", "100", "1 cup", "", "yes", "")],
    "cashew": [("", "", "130", "1 cup", "", "yes", "")],
    "macadamia": [("", "", "134", "1 cup", "", "yes", "")],
    "chia-seed": [("", "", "170", "1 cup", "", "yes", ""),
                  ("", "", "12", "1 tbsp", "", "yes", "")],
    "chocolate-dark": [("", "", "170", "1 cup", "", "yes", "")],
    "chocolate-chips": [("", "", "170", "1 cup", "", "yes", "")],
    "gelatin": [("", "", "7", "1 tbsp", "", "yes", "")],
    "chicken-breast": [("", "", "174", "", "1 each", "yes", "")],
    "chicken-thigh": [("", "", "100", "", "1 each", "yes", "")],
    "chicken-whole": [("", "", "1600", "", "1 each", "yes", "")],
    "ground-chicken": [("", "", "225", "1 cup", "", "yes", "")],
    "turkey-breast": [("", "", "1800", "", "1 each", "yes", "")],
    "ground-turkey": [("", "", "225", "1 cup", "", "yes", "")],
    "ground-beef": [("", "", "225", "1 cup", "", "yes", "")],
    "beef-chuck": [("", "", "225", "1 cup", "", "yes", "")],
    "beef-brisket": [("", "", "2270", "", "1 each", "yes", "")],
    "beef-sirloin": [("", "", "227", "", "1 each", "yes", "")],
    "ribeye": [("", "", "340", "", "1 each", "yes", "")],
    "pork-shoulder": [("", "", "2270", "", "1 each", "yes", "")],
    "pork-chop": [("", "", "170", "", "1 each", "yes", "")],
    "pork-belly": [("", "", "225", "1 cup", "", "yes", "")],
    "ground-pork": [("", "", "225", "1 cup", "", "yes", "")],
    "bacon": [("", "", "28", "", "1 slice", "yes", "")],
    "sausage-italian": [("", "", "85", "", "1 each", "yes", "")],
    "chorizo": [("", "", "85", "", "1 each", "yes", "")],
    "lamb-shoulder": [("", "", "1800", "", "1 each", "yes", "")],
    "lamb-chop": [("", "", "100", "", "1 each", "yes", "")],
    "salmon": [("", "", "170", "", "1 each", "yes", "")],
    "cod": [("", "", "170", "", "1 each", "yes", "")],
    "halibut": [("", "", "170", "", "1 each", "yes", "")],
    "tilapia": [("", "", "115", "", "1 each", "yes", "")],
    "trout": [("", "", "140", "", "1 each", "yes", "")],
    "tuna-canned": [("", "", "142", "", "1 can", "yes", "")],
    "crab": [("", "", "135", "1 cup", "", "yes", "")],
    "lobster": [("", "", "700", "", "1 each", "yes", "")],
    "scallop": [("", "", "30", "", "1 each", "yes", "")],
    "squid": [("", "", "40", "", "1 each", "yes", "")],
}


def parse_modifier(text, food):
    """(kind, preparation, unit) for an SR portion modifier, or None. `food`
    is the seed name: a piece noun only counts for the food it names, so a
    tomato's "cherry" portion is a variety, not one tomato."""
    norm = re.sub(r"\(.*?\)", " ", text.lower())
    norm = " ".join(re.sub(r"[^a-z ]", " ", norm).split())
    norm = re.sub(r"\bwhole\b", " ", norm).strip()
    norm = " ".join(norm.split())
    if norm in SIZES:
        return "size", SIZES[norm], "each"
    for measure in sorted(VOLUME_MEASURES, key=len, reverse=True):
        if norm == measure or norm.startswith(measure + " "):
            return describe("volume", VOLUME_MEASURES[measure], norm[len(measure):].strip())
    for measure in sorted(COUNT_MEASURES, key=len, reverse=True):
        if norm == measure or norm.startswith(measure + " "):
            return describe("each", COUNT_MEASURES[measure], norm[len(measure):].strip())
    for measure in sorted(PIECE_MEASURES, key=len, reverse=True):
        if (norm == measure or norm.startswith(measure + " ")) and (
            measure.rstrip("s") in food.lower() or measure in {"fruit", "piece", "pieces"}
        ):
            return describe("piece", "each", norm[len(measure):].strip())
    return None


def describe(kind, unit, descriptor):
    if descriptor in PLAIN:
        return kind, "", unit
    if descriptor in PREPARATIONS:
        return kind, PREPARATIONS[descriptor], unit
    if kind in ("piece", "each") and descriptor in SIZES:
        return "size", SIZES[descriptor], unit
    return None


def number(text):
    value = float(text)
    return str(int(value)) if value == int(value) else str(round(value, 3))


def read_portions(sr_dir):
    """Portions by fdc_id, each with SR's shape: an amount and a modifier.

    The full FoodData Central export holds the SR Legacy foods and more, but
    Foundation foods name their unit in measure_unit.csv and FNDDS foods put
    the whole measure in portion_description ("1 cup"); both are folded into
    the modifier so one parser serves all three.
    """
    units = {}
    units_path = os.path.join(sr_dir, "measure_unit.csv")
    if os.path.exists(units_path):
        with open(units_path, newline="") as handle:
            units = {row["id"]: row["name"] for row in csv.DictReader(handle)}
    portions = {}
    with open(os.path.join(sr_dir, "food_portion.csv"), newline="") as handle:
        for row in csv.DictReader(handle):
            unit = units.get(row["measure_unit_id"], "undetermined")
            if unit != "undetermined":
                row["modifier"] = " ".join(filter(None, [unit, row["modifier"]]))
            elif not row["amount"] and row["portion_description"]:
                amount, _, rest = row["portion_description"].partition(" ")
                row["amount"], row["modifier"] = amount, rest
            portions.setdefault(row["fdc_id"], []).append(row)
    for rows in portions.values():
        rows.sort(key=lambda row: int(row["seq_num"] or 0))
    return portions


def usda_rows(fdc_id, portions, food):
    rows = []
    seen = set()
    for portion in portions:
        parsed = parse_modifier(portion["modifier"], food)
        if not parsed:
            continue
        kind, preparation, unit = parsed
        try:
            amount, grams = number(portion["amount"]), number(portion["gram_weight"])
        except ValueError:
            continue
        if float(grams) <= 0 or float(amount) <= 0:
            continue
        key = (preparation, unit)
        if key in seen:
            continue
        seen.add(key)
        volume = f"{amount} {unit}" if kind == "volume" else ""
        each = "" if kind == "volume" else f"{amount} {unit}"
        rows.append({"preparation": preparation, "yield": "", "grams": grams,
                     "volume": volume, "each": each, "estimated": "no",
                     "source": f"usda:{fdc_id}"})
    rows.sort(key=lambda row: (
        row["preparation"] != "",
        UNIT_ORDER.index(row["volume"].split()[-1]) if row["volume"] else len(UNIT_ORDER),
        row["preparation"]))
    return rows


def default_rows(rows):
    """SR often lists only prepared portions, but every id needs a Default, and
    a `1 each` Default whenever SR sizes the item."""
    plain = [row for row in rows if not row["preparation"]]
    medium = next((row for row in rows if row["preparation"] == "medium"), None)
    if not plain:
        return [dict(medium or dict(rows[0], estimated="yes"), preparation="")]
    unit = medium["each"].split()[-1] if medium else ""
    if medium and not any(row["each"].endswith(" " + unit) for row in plain):
        return [dict(medium, preparation="")]
    return []


def hand_rows(seed_id):
    return [{"preparation": preparation, "yield": yield_, "grams": grams,
             "volume": volume, "each": each, "estimated": estimated,
             "source": source}
            for preparation, yield_, grams, volume, each, estimated, source
            in HAND_ROWS.get(seed_id, [])]


def read_existing(path):
    """Hand-written rows of an existing catalog, by id, in file order."""
    kept = {}
    if not os.path.exists(path):
        return kept
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            if row["source"].startswith("usda:"):
                continue
            kept.setdefault(row["id"], []).append(row)
    return kept


def row_key(row):
    unit = (row["volume"] or row["each"]).split(" ")[-1]
    return row["preparation"], unit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", default="seeds.csv")
    parser.add_argument("--sr", required=True, help="directory holding the SR Legacy CSVs")
    parser.add_argument("--out", default="catalog.csv")
    args = parser.parse_args()

    portions = read_portions(args.sr)
    kept = read_existing(args.out)
    with open(args.seeds, newline="") as handle:
        seeds = list(csv.DictReader(handle))

    out = []
    for seed in seeds:
        rows = hand_rows(seed["id"])
        if seed["fdc_id"]:
            rows += usda_rows(seed["fdc_id"], portions.get(seed["fdc_id"], []), seed["name"])
        taken = {row_key(row) for row in kept.get(seed["id"], [])}
        rows = [row for row in rows if row_key(row) not in taken]
        rows = [dict(row, id=seed["id"]) for row in kept.pop(seed["id"], []) + rows]
        # The identity goes on whichever row ends up first, below.
        for row in rows:
            row.update(name="", synonyms="", allergens="", verify="")
        if not rows:
            continue
        rows = default_rows(rows) + rows
        rows[0].update(name=seed["name"], synonyms=seed["synonyms"],
                       allergens=seed["allergens"], verify=seed.get("verify", ""))
        out += rows
    for rows in kept.values():
        out += rows

    with open(args.out, "w", newline="") as handle:
        writer = csv.DictWriter(handle, FIELDS, restval="", lineterminator="\n")
        writer.writeheader()
        for row in out:
            writer.writerow({field: row.get(field, "") for field in FIELDS})
    print(f"{args.out}: {len(out)} rows")


if __name__ == "__main__":
    main()
