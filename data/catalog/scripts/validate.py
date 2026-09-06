#!/usr/bin/env python3
"""Validate catalog.csv against the column rules in README.md.

    python3 data/catalog/scripts/validate.py [catalog.csv]

Prints one line per problem and exits 1 when there is any.
"""
import csv
import os
import re
import sys

FIELDS = ["id", "name", "synonyms", "allergens", "verify", "preparation",
          "yield", "grams", "volume", "each", "estimated", "source"]
ALLERGENS = {"milk", "egg", "fish", "shellfish", "tree_nuts", "peanut",
             "wheat", "soy", "sesame", "sulphites", "gluten_cereals",
             "mollusks", "mustard", "lupin", "celery", "allium",
             "nightshades", "legumes", "stone_fruit"}
ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_vocabulary(root):
    with open(os.path.join(root, "vocab", "preparations.txt")) as source:
        preparations = {line.strip() for line in source if line.strip()}
    units = {"volume": set(), "count": set()}
    with open(os.path.join(root, "vocab", "units.txt")) as source:
        for line in source:
            if line.strip():
                slug, family = line.split()
                units[family].add(slug)
    return preparations, units


def positive(text):
    try:
        return float(text) > 0
    except ValueError:
        return False


def check_measure(row, field, units, line, errors):
    """The `amount unit` shape; returns the unit, or "" when the cell is empty."""
    value = row[field]
    if not value:
        return ""
    parts = value.split(" ")
    if len(parts) != 2 or not positive(parts[0]):
        errors.append(f"line {line}: {field} {value!r} is not `amount unit`")
        return ""
    if parts[1] not in units:
        errors.append(f"line {line}: {field} unit {parts[1]!r} is not in vocab/units.txt")
    return parts[1]


SMALL_WORDS = {"of", "the", "and", "in", "de", "di", "du", "da", "la", "le", "el", "with", "a", "al", "en", "y", "des", "von", "van"}
KEEP_WORDS = {"d'Ambert"}


def title_case(name):
    """Chicken Feet, Leg of Lamb, Bone-In Chicken Thigh: every word capitalised
    except the small connecting ones, and both halves of a hyphenated word."""
    def cap(word):
        if word in KEEP_WORDS:
            return word
        parts = []
        for part in word.split("-"):
            for index, char in enumerate(part):
                if char.isalpha():
                    part = part[:index] + char.upper() + part[index + 1:]
                    break
            parts.append(part)
        return "-".join(parts)
    words = name.split(" ")
    return " ".join(
        cap(word) if index == 0 or word.lower() not in SMALL_WORDS else word.lower()
        for index, word in enumerate(words)
    )


def validate(path, root=ROOT):
    preparations, units = load_vocabulary(root)
    errors = []
    with open(path, newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != FIELDS:
            return [f"line 1: header must be {','.join(FIELDS)}"]
        rows = list(reader)

    started = set()
    current = None
    keys = {}
    defaults = set()
    names = {}
    for index, row in enumerate(rows):
        line = index + 2
        identifier = row["id"]
        if not ID.match(identifier):
            errors.append(f"line {line}: id {identifier!r} must match {ID.pattern}")
        first = identifier != current
        if first:
            if identifier in started:
                errors.append(f"line {line}: rows for id {identifier!r} are not grouped together")
            started.add(identifier)
            current = identifier
            if not row["name"]:
                errors.append(f"line {line}: the first row of {identifier!r} needs a name")
            plain = " ".join(re.sub(r"[^a-z0-9]+", " ", row["name"].lower()).split())
            if plain in names:
                errors.append(f"line {line}: name {row['name']!r} is already used by {names[plain]!r}")
            names.setdefault(plain, identifier)
            if row["name"] != title_case(row["name"]):
                errors.append(f"line {line}: name {row['name']!r} is not Title Case, want {title_case(row['name'])!r}")
            for part in filter(None, row["synonyms"].split("|")):
                if part != part.strip():
                    errors.append(f"line {line}: synonym {part!r} has stray whitespace")
            declared = set()
            for part in filter(None, row["allergens"].split("|")):
                if part not in ALLERGENS:
                    errors.append(f"line {line}: allergen {part!r} is not one of the big nine")
                declared.add(part)
            for part in filter(None, row["verify"].split("|")):
                if part not in ALLERGENS:
                    errors.append(f"line {line}: verify tag {part!r} is not one of the big nine")
                if part in declared:
                    errors.append(f"line {line}: {part!r} is in both allergens and verify")
        else:
            for field in ("name", "synonyms", "allergens", "verify"):
                if row[field]:
                    errors.append(f"line {line}: {field} belongs on the first row of {identifier!r} only")

        preparation = row["preparation"]
        if preparation and preparation not in preparations:
            errors.append(f"line {line}: preparation {preparation!r} is not in vocab/preparations.txt")
        if row["grams"] and not positive(row["grams"]):
            errors.append(f"line {line}: grams {row['grams']!r} must be a number above 0")
        if row["yield"] and not (positive(row["yield"]) and float(row["yield"]) <= 1000):
            errors.append(f"line {line}: yield {row['yield']!r} must be a number in (0, 1000]")
        volume_unit = check_measure(row, "volume", units["volume"], line, errors)
        each_unit = check_measure(row, "each", units["count"], line, errors)

        if row["grams"] and row["yield"]:
            errors.append(f"line {line}: grams and yield cannot share a row")
        if not preparation:
            defaults.add(identifier)
        equivalence = row["grams"] and (row["volume"] or row["each"])
        yield_only = (preparation and row["yield"] and not row["grams"]
                      and not row["volume"] and not row["each"])
        if not equivalence and not yield_only:
            errors.append(f"line {line}: a row is either grams plus volume and/or each, "
                          "or a preparation with only a yield")

        if row["estimated"] not in ("yes", "no"):
            errors.append(f"line {line}: estimated must be `yes` or `no`")
        if row["estimated"] == "no" and not row["source"]:
            errors.append(f"line {line}: source is required when estimated is `no`")

        for unit in {unit for unit in (volume_unit, each_unit) if unit} or {""}:
            key = (identifier, preparation, unit)
            if key in keys:
                errors.append(f"line {line}: duplicate of line {keys[key]}: "
                              f"{identifier} / {preparation or 'default'} / {unit or 'yield'}")
            else:
                keys[key] = line
    for identifier in sorted(started - defaults):
        errors.append(f"id {identifier!r} has no Default row (one with a blank preparation)")
    return errors


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "catalog.csv")
    errors = validate(path)
    for error in errors:
        print(error)
    if errors:
        print(f"{len(errors)} problem(s) in {path}")
        return 1
    print(f"{path}: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
