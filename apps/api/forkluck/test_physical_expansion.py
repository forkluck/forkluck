from __future__ import annotations

from unittest import TestCase

from forkluck.domains.shared.physical_expansion import (
    EquivalencyBasis,
    Measure,
    PurchaseBasis,
    RecipeLine,
    RecipeNode,
    expand_physical_demand,
    purchase_quantity,
    recipe_measure_pairs,
)


class PhysicalExpansionTests(TestCase):
    def test_recipe_equivalency_scales_the_non_anchor_measure(self) -> None:
        pairs = recipe_measure_pairs(
            2,
            "kg",
            EquivalencyBasis(
                mass=Measure(1000, "g"),
                volume=Measure(1, "l"),
                standard=True,
            ),
        )

        self.assertEqual(pairs, ((2.0, "kg"), (2.0, "l")))

    def test_purchase_quantity_keeps_usage_separate_from_gross_purchase(self) -> None:
        result = purchase_quantity(
            100,
            "g",
            PurchaseBasis(purchase_size=1000, purchase_unit="g", yield_percent=80),
        )

        self.assertIsNotNone(result.usage)
        self.assertIsNotNone(result.purchase)
        self.assertEqual(result.usage.amount, 100)
        self.assertEqual(result.purchase.amount, 125)
        self.assertEqual(result.purchase_units, 0.125)

    def test_nested_recipe_flattens_to_physical_usage_and_purchase(self) -> None:
        child = RecipeNode(
            id="child",
            yield_amount=100,
            yield_unit="g",
            lines=(RecipeLine("flour-line", 20, "g", ingredient_key="flour"),),
        )
        root = RecipeNode(
            id="root",
            yield_amount=100,
            yield_unit="g",
            lines=(RecipeLine("child-line", 50, "g", recipe_key="child"),),
        )

        result = expand_physical_demand(
            root,
            resolve_ingredient=lambda key: PurchaseBasis(1000, "g")
            if key == "flour"
            else None,
            resolve_recipe=lambda key: child if key == "child" else None,
        )

        flour = next(material for material in result.materials if material.key == "flour")
        self.assertEqual(flour.usage.amount, 10)
        self.assertEqual(flour.purchase.amount, 10)
        self.assertEqual(
            flour.path,
            ("root", "child-line", "child", "flour-line"),
        )
        self.assertTrue(flour.cost_included)
        self.assertFalse(result.issues)

    def test_efficiency_is_gross_input_and_excluded_lines_stay_physical(self) -> None:
        root = RecipeNode(
            id="root",
            yield_amount=100,
            yield_unit="g",
            lines=(
                RecipeLine(
                    "gross-line",
                    100,
                    "g",
                    ingredient_key="oil",
                    efficiency=50,
                    excluded_from_cost=True,
                ),
            ),
        )

        result = expand_physical_demand(
            root,
            resolve_ingredient=lambda key: PurchaseBasis(1000, "g")
            if key == "oil"
            else None,
            resolve_recipe=lambda _key: None,
        )

        oil = next(material for material in result.materials if material.key == "oil")
        self.assertEqual(oil.usage.amount, 100)
        self.assertEqual(oil.purchase.amount, 200)
        self.assertFalse(oil.cost_included)

    def test_unresolved_conversion_is_structured(self) -> None:
        result = purchase_quantity(
            1,
            "cup",
            PurchaseBasis(
                purchase_size=1,
                purchase_unit="kg",
                conversion_is_automatic=False,
            ),
        )

        self.assertFalse(result.resolved)
        self.assertEqual(result.issues[0].code, "unresolved-conversion")

    def test_recipe_cycle_is_reported_without_recursing_forever(self) -> None:
        a = RecipeNode(
            id="a",
            yield_amount=1,
            yield_unit="each",
            lines=(RecipeLine("a-to-b", 1, "each", recipe_key="b"),),
        )
        b = RecipeNode(
            id="b",
            yield_amount=1,
            yield_unit="each",
            lines=(RecipeLine("b-to-a", 1, "each", recipe_key="a"),),
        )
        nodes = {"a": a, "b": b}

        result = expand_physical_demand(
            a,
            resolve_ingredient=lambda _key: None,
            resolve_recipe=nodes.get,
        )

        cycle = next(issue for issue in result.issues if issue.code == "recipe-cycle")
        self.assertEqual(
            cycle.path,
            ("a", "a-to-b", "b", "b-to-a", "a"),
        )
