# Forkluck ingredient catalog

An open list of kitchen ingredients with the numbers a recipe needs: what a cup,
a piece or a bunch weighs, and how much is left after peeling, chopping or
cooking. Built from USDA FoodData Central (SR Legacy household portions), which
is public domain, plus plain-English synonyms. This dataset is CC0 (see [LICENSE](LICENSE)).

This directory is the source of truth for the dataset. The Forkluck
application reads it directly at build and deploy time, and `pnpm db:migrate`
loads it into a local database through `manage.py sync_catalog`. Submit
dataset changes as pull requests against this directory; CI validates the file
on every pull request.

## The file

`catalog.csv` has one row per equivalence. Columns:

| column | meaning |
| --- | --- |
| `id` | stable slug, `^[a-z0-9][a-z0-9-]*$`. Never renamed once shipped: names can change, ids cannot. |
| `name` | display name in Title Case (`Chicken Feet`, `Leg of Lamb`, `Bone-In Chicken Thigh`); small words like `of`, `and`, `de` stay lower. Plural where the kitchen says it in the plural (`Green Beans`, `Kalamata Olives`, `Chicken Feet`), singular otherwise (`Dried Apricot`, `Chicken Thigh`). Only on the **first row** of an id. Unique across ids (ignoring case and punctuation). |
| `synonyms` | other ways people write it, separated by `\|`. First row only. |
| `allergens` | `milk egg fish shellfish tree_nuts peanut wheat soy sesame sulphites gluten_cereals mollusks mustard lupin celery allium nightshades legumes stone_fruit`, separated by `\|`. First row only. The last four (`allium`, `nightshades`, `legumes`, `stone_fruit`) are kitchen tags, not regulatory allergens. |
| `verify` | brand-dependent tags from the same list, separated by `\|`. First row only, and never a key that is already in `allergens`. These are the tags that *may* apply depending on the brand or formulation, so the app can say "check your label for: ...". A hint to go read the package, never a declaration that the ingredient contains them. |
| `preparation` | blank for the **Default** (the ingredient as bought), else a word from `vocab/preparations.txt`. Sizes (`small`, `large`) are preparations too. |
| `yield` | percent left after the preparation, `(0, 1000]`. Blank on Default means 100. |
| `grams` | weight of the `volume` or `each` on this row. |
| `volume` | `amount unit`, unit from the volume list in `vocab/units.txt` (`1 cup`, `1 tbsp`). |
| `each` | `amount unit`, unit from the count list (`1 each`, `1 clove`, `1 bunch`). |
| `estimated` | `yes` when a person estimated the number; `no` when it is measured and `source` says where. |
| `source` | `usda:<fdc_id>`, `sr-legacy:<ndb_no>` when the SR entry has no confirmed FoodData Central id, `si:density`, a manufacturer's package, or anything else that lets a reader check. Required when `estimated` is `no`. Only `usda:` sources are rebuilt from USDA; everything else is hand-written and kept. |

A row is either an **equivalence** (`grams` plus `volume` and/or `each`) or a
**yield-only preparation** (`preparation` and `yield`, nothing else). Every id
needs a Default row. `grams` and `yield` never share a row.

## Contributing

1. Edit `catalog.csv` (or `seeds.csv` and rebuild, below).
2. Run `python3 data/catalog/scripts/validate.py data/catalog/catalog.csv` from the repository root — CI runs the same check.
3. Open a pull request and say where a number came from.

Don't know the numbers? Open an issue describing the ingredient and source.

### Rebuilding from USDA

`seeds.csv` lists each ingredient with its SR Legacy `fdc_id`. With the
[SR Legacy CSV export](https://fdc.nal.usda.gov/download-datasets) unpacked
somewhere (it is never committed):

```sh
python3 data/catalog/scripts/build.py --seeds data/catalog/seeds.csv --sr ~/Downloads/sr_legacy --out data/catalog/catalog.csv
```

Rows whose `source` does not start with `usda:` are hand-written and survive a
rebuild, and a hand-written row beats a USDA row for the same preparation and
unit. Some seeds point at Foundation or FNDDS foods, so pass the full FoodData
Central CSV export rather than the SR Legacy subset.
