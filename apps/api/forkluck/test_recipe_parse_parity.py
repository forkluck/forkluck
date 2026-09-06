"""The Django read model agrees with the editor parser on the shared corpus.

`apps/web/tests/fixtures/recipe-lines.json` is the single expectation set: the vitest
suite reads it in `apps/web/tests/recipe-parse.test.ts` and this test reads the same
file, so a parser form fixed on one side cannot drift on the other.
"""

import json

from django.test import SimpleTestCase

from .domains.recipes.health import parse_ingredients
from .paths import WEB_ROOT

CORPUS = (
    WEB_ROOT / "tests" / "fixtures" / "recipe-lines.json"
)


def _corpus() -> list[dict]:
    document = json.loads(CORPUS.read_text(encoding="utf-8"))
    return document["lines"]


class RecipeParseParityTests(SimpleTestCase):
    def test_corpus_is_readable_and_populated(self):
        self.assertGreater(len(_corpus()), 30)

    def test_read_model_agrees_with_the_editor_on_every_corpus_line(self):
        for case in _corpus():
            line = case["line"]
            expected = case["expect"]
            with self.subTest(line=line):
                parsed = parse_ingredients(line, keep_unresolved_measures=True)
                if expected.get("kind") in {"header", "note"} or expected.get(
                    "unmeasured"
                ):
                    # A heading, a note and an ingredient with no amount all
                    # reach no cost, so this read model keeps no row for them.
                    self.assertEqual(parsed, [])
                    continue
                if expected.get("skipped"):
                    # A refused line never reaches a gram weight in either
                    # engine; the read model keeps unconvertible ones as the
                    # written text so pricing can report the loss. Assert the
                    # row count too: `all([])` is True, so a line the read
                    # model dropped entirely used to pass this vacuously.
                    self.assertEqual(
                        len(parsed),
                        1 if expected["affectsPricing"] else 0,
                        msg="an unconvertible line must survive as written text",
                    )
                    self.assertTrue(all(row.grams is None for row in parsed))
                    continue
                self.assertEqual(len(parsed), 1)
                row = parsed[0]
                self.assertEqual(row.name, expected["name"])
                if "amount" in expected:
                    self.assertAlmostEqual(
                        row.entered_amount, expected["amount"], places=3
                    )
                # The editor reports a unitless line it could weigh as
                # `assumed-g`; the read model spells the same reading `g`.
                self.assertEqual(
                    row.entered_unit,
                    "g" if expected["unit"] == "assumed-g" else expected["unit"],
                )
                if expected["grams"] is None:
                    self.assertIsNone(row.grams)
                else:
                    self.assertAlmostEqual(row.grams, expected["grams"], places=1)
                if "reviewFlag" in expected:
                    self.assertEqual(row.needs_review, expected["reviewFlag"])
