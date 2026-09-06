"""Auto-ignore rules: the standing instruction behind an ignore row.

A rule is a *reason*, and the `SalesSkuIgnore` rows carrying its id are its
effect. Most of what follows is about that relationship holding under change —
a rule narrowed, disabled, deleted, or outvoted by a merchant who tracked the
identity themselves — because a rule that keeps ignoring revenue after its
reason is gone is silent and expensive.
"""

from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from .domains.sales.core import (
    IGNORE_RULE_MAX_PER_USER,
    IgnoreCandidate,
    action_delete_sales_ignore_rule,
    action_preview_sales_ignore_rule,
    action_save_sales_ignore_rule,
    action_save_sales_product,
    action_unignore_sales_skus,
    apply_sku_ignores,
    ignore_key_set,
    menu_overview_payload,
    pending_review_count,
    rule_matches,
    sweep_ignore_rules,
)
from .models import (
    SalesCatalogItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesIgnoreRule,
    SalesImport,
    SalesLine,
    SalesProduct,
    SalesSkuIgnore,
    User,
)


def condition(field: str, operator: str, value: str) -> dict:
    return {"field": field, "operator": operator, "value": value}


class IgnoreRuleTestCase(TestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="rules@example.com",
            name="Ruler",
            password="a-long-test-passphrase-2468",
        )
        self.connect("square", "M1")
        self.connect("shopify", "shop-1")

    def connect(self, provider: str, account: str) -> None:
        SalesChannelConnection.objects.create(
            user=self.user,
            provider=provider,
            provider_account_id=account,
            status=SalesChannelConnection.Status.ACTIVE,
            product_catalog_synced_at=timezone.now(),
        )

    def catalog(
        self,
        sku: str,
        *,
        channel="square",
        account="M1",
        name="Linzer cookie",
        variant="",
        active=True,
    ) -> SalesCatalogItem:
        return SalesCatalogItem.objects.create(
            user=self.user,
            channel=channel,
            provider_account_id=account,
            match_key=f"{channel}:item:{sku}:{name}:{variant}",
            sku=sku,
            item_name=name,
            external_variant_title=variant,
            external_object_id=f"ext-{channel}-{sku}-{name}-{variant}",
            is_active=active,
            last_seen_at=timezone.now(),
        )

    def line(
        self,
        sku: str,
        *,
        channel="square",
        account="M1",
        name="Linzer cookie",
        variant="",
        match_key=None,
    ) -> SalesLine:
        sales_import = SalesImport.objects.create(
            user=self.user,
            channel=channel,
            provider_account_id=account,
            file_name="sales.csv",
            timezone="UTC",
        )
        return SalesLine.objects.create(
            user=self.user,
            sales_import=sales_import,
            channel=channel,
            provider_account_id=account,
            match_key=match_key or f"{channel}:sku:{sku.lower()}",
            sku=sku,
            item_name=name,
            external_variant_title=variant,
            source_position=0,
            source_fingerprint=f"{channel}-{sku}-{name}-{variant}",
            external_order_id="1",
            sold_at=timezone.now(),
            group_key=f"sku:{sku.lower()}",
            quantity=Decimal("1"),
            gross_cents=500,
            net_sales_cents=500,
        )

    def rule(self, *conditions, channel="square", enabled=True) -> SalesIgnoreRule:
        return SalesIgnoreRule.objects.create(
            user=self.user,
            channel=channel,
            enabled=enabled,
            conditions=list(conditions),
        )

    def save_rule(self, *conditions, channel="square", enabled=True, rule_id=None):
        body = {
            "channel": channel,
            "enabled": enabled,
            "conditions": list(conditions),
        }
        if rule_id is not None:
            body["id"] = rule_id
        return action_save_sales_ignore_rule(self.user, body)

    def ignored_keys(self) -> set[str]:
        return set(
            SalesSkuIgnore.objects.filter(user=self.user).values_list(
                "match_key", flat=True
            )
        )


class ConditionSyntaxTests(IgnoreRuleTestCase):
    """The 3x3 grid of field and operator, plus what normalization folds."""

    def candidate(self, **kw) -> IgnoreCandidate:
        return IgnoreCandidate(
            channel=kw.get("channel", "square"),
            provider_account_id="M1",
            match_key="square:item:1",
            sku=kw.get("sku", "GC-01"),
            item_name=kw.get("item_name", "Gift card"),
            external_variant_title=kw.get("external_variant_title", "Large"),
        )

    def test_every_field_and_operator_matches_and_refuses(self):
        cases = [
            ("sku", "is", "GC-01", "GC-02"),
            ("sku", "starts_with", "GC", "XX"),
            ("sku", "contains", "C-0", "ZZZ"),
            ("title", "is", "Gift card", "Gift cards"),
            ("title", "starts_with", "Gift", "Card"),
            ("title", "contains", "ft ca", "biscuit"),
            ("variant", "is", "Large", "Small"),
            ("variant", "starts_with", "Lar", "Sma"),
            ("variant", "contains", "arg", "mal"),
        ]
        for field, operator, hit, miss in cases:
            with self.subTest(field=field, operator=operator):
                self.assertTrue(
                    rule_matches([condition(field, operator, hit)], self.candidate())
                )
                self.assertFalse(
                    rule_matches([condition(field, operator, miss)], self.candidate())
                )

    def test_matching_folds_case_and_collapses_whitespace(self):
        # The same folding that built the identity's match key, so a rule
        # written by hand meets a title the provider spaced differently.
        for value in ["gift card", "GIFT CARD", "  Gift   card  ", "Gift﻿ card"]:
            with self.subTest(value=value):
                self.assertTrue(
                    rule_matches(
                        [condition("title", "is", value)],
                        self.candidate(item_name="Gift  card"),
                    )
                )

    def test_conditions_are_anded(self):
        both = [
            condition("sku", "starts_with", "GC"),
            condition("variant", "is", "Large"),
        ]
        self.assertTrue(rule_matches(both, self.candidate()))
        self.assertFalse(rule_matches(both, self.candidate(external_variant_title="Small")))

    def test_a_blank_haystack_never_matches_a_real_needle(self):
        self.assertFalse(
            rule_matches(
                [condition("variant", "contains", "large")],
                self.candidate(external_variant_title=""),
            )
        )
        self.assertFalse(
            rule_matches(
                [condition("sku", "starts_with", "GC")], self.candidate(sku="")
            )
        )

    def test_malformed_conditions_are_inert_rather_than_fatal(self):
        # The JSON column has no database-level shape; one bad row must not be
        # able to fail every sync in the workspace.
        for conditions in [
            [],
            "not-a-list",
            [{"field": "sku"}],
            [condition("nope", "is", "x")],
            [condition("sku", "nope", "x")],
            [condition("sku", "is", "")],
            ["not-a-dict"],
        ]:
            with self.subTest(conditions=conditions):
                self.assertFalse(rule_matches(conditions, self.candidate()))


class ConditionValidationTests(IgnoreRuleTestCase):
    def assertRefused(self, message: str, *conditions):
        with self.assertRaises(ValueError) as caught:
            self.save_rule(*conditions)
        self.assertIn(message, str(caught.exception))

    def test_a_rule_needs_at_least_one_condition(self):
        self.assertRefused("at least one condition")

    def test_a_rule_caps_its_conditions(self):
        self.assertRefused(
            "at most 5 conditions",
            *[condition("sku", "contains", f"x{index}") for index in range(6)],
        )

    def test_a_blank_value_is_refused(self):
        # It would cover the entire channel — the single most dangerous input.
        self.assertRefused("Condition value is required", condition("sku", "is", ""))
        self.assertRefused("Condition value is required", condition("sku", "is", "   "))

    def test_an_overlong_value_is_refused(self):
        self.save_rule(condition("sku", "is", "x" * 200))
        self.assertRefused(
            "Condition value is too long", condition("title", "is", "x" * 201)
        )

    def test_unknown_field_and_operator_are_refused(self):
        self.assertRefused("field is not supported", condition("colour", "is", "red"))
        self.assertRefused("operator is not supported", condition("sku", "ends", "x"))

    def test_a_rule_cannot_repeat_one_condition(self):
        self.assertRefused(
            "cannot repeat the same condition",
            condition("sku", "is", "GC-1"),
            condition("sku", "is", "gc-1"),
        )

    def test_two_rules_on_a_channel_cannot_be_identical(self):
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertRefused(
            "already exists", condition("sku", "starts_with", "gc")
        )
        # The same conditions on the other channel mean something else.
        self.save_rule(condition("sku", "starts_with", "GC"), channel="shopify")

    def test_rules_are_capped_per_user(self):
        for index in range(IGNORE_RULE_MAX_PER_USER):
            self.save_rule(condition("sku", "is", f"sku-{index}"))
        self.assertRefused(
            f"at most {IGNORE_RULE_MAX_PER_USER} rules", condition("sku", "is", "one-more")
        )

    def test_an_unsupported_channel_is_refused(self):
        with self.assertRaises(ValueError):
            self.save_rule(condition("sku", "is", "GC"), channel="etsy")


class SweepTests(IgnoreRuleTestCase):
    def test_saving_a_rule_ignores_its_matches_from_both_populations(self):
        self.catalog("GC-01")
        self.line("GC-02")
        self.catalog("CK-01")
        result = self.save_rule(condition("sku", "starts_with", "GC"))

        self.assertEqual(result["ignored"], 2)
        self.assertEqual(
            self.ignored_keys(), {"square:item:GC-01:Linzer cookie:", "square:sku:gc-02"}
        )

    def test_a_rule_never_reaches_the_other_channel(self):
        self.catalog("GC-01", channel="shopify", account="shop-1")
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_a_rule_never_reaches_another_workspace(self):
        other = User.objects.create_user(
            email="other@example.com",
            name="Other",
            password="a-long-test-passphrase-2468",
        )
        SalesCatalogItem.objects.create(
            user=other,
            channel="square",
            provider_account_id="M1",
            match_key="square:item:GC-01",
            sku="GC-01",
            item_name="Gift card",
            external_object_id="ext",
            is_active=True,
            last_seen_at=timezone.now(),
        )
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(SalesSkuIgnore.objects.filter(user=other).count(), 0)

    def test_a_catalog_row_on_a_disconnected_account_is_not_swept(self):
        self.catalog("GC-01", account="gone")
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_a_csv_identity_keeps_its_blank_account(self):
        # bulk_create skips the model's save(), which would otherwise stamp a
        # connection's account onto a row that legitimately has none.
        self.line("GC-01", account="")
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(
            SalesSkuIgnore.objects.get(user=self.user).provider_account_id, ""
        )

    def test_an_inactive_catalog_row_is_not_swept(self):
        self.catalog("GC-01", active=False)
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_a_rule_never_touches_a_modifier_identity(self):
        SalesLine.objects.all().delete()
        self.line("GC-01", match_key="square:modifier:*:gift card")
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertFalse(
            SalesSkuIgnore.objects.filter(match_key__contains=":modifier:").exists()
        )

    def test_a_disabled_rule_sweeps_nothing(self):
        self.catalog("GC-01")
        self.save_rule(condition("sku", "starts_with", "GC"), enabled=False)
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_a_workspace_without_rules_takes_no_lock_and_one_query(self):
        with self.assertNumQueries(
            1, msg="every sync and import calls this; an unused feature pays one lookup"
        ):
            self.assertEqual(sweep_ignore_rules(self.user), set())

    def test_the_sweep_does_not_grow_with_the_number_of_matches(self):
        self.rule(condition("sku", "starts_with", "GC"))
        for index in range(5):
            self.catalog(f"GC-{index}")
        with self.assertNumQueries(11) as small:
            sweep_ignore_rules(self.user)
        SalesSkuIgnore.objects.all().delete()
        for index in range(5, 60):
            self.catalog(f"GC-{index}")
        with self.assertNumQueries(
            len(small.captured_queries),
            msg="a rule sweep must batch its writes, not insert per match",
        ):
            sweep_ignore_rules(self.user)
        self.assertEqual(SalesSkuIgnore.objects.count(), 60)


class PrecedenceTests(IgnoreRuleTestCase):
    def track(self, catalog_item: SalesCatalogItem) -> SalesProduct:
        return action_save_sales_product(
            self.user,
            {
                "name": "Gift card",
                "variants": [
                    {
                        "channel": catalog_item.channel,
                        "providerAccountId": catalog_item.provider_account_id,
                        "matchKey": catalog_item.match_key,
                        "sku": catalog_item.sku,
                        "externalName": catalog_item.item_name,
                        "externalVariantTitle": catalog_item.external_variant_title,
                    }
                ],
            },
        )

    def test_a_tracked_identity_is_skipped_not_refused(self):
        # apply_sku_ignores raises for a tracked key because a merchant asked
        # and deserves the reason. A sweep has nobody to tell, and a raise here
        # would turn one rule into a failed sync.
        item = self.catalog("GC-01")
        self.track(item)
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)
        self.assertEqual(SalesProductVariant.objects.count(), 1)

    def test_tracking_an_identity_beats_a_rule_permanently(self):
        item = self.catalog("GC-01")
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(SalesSkuIgnore.objects.count(), 1)

        self.track(item)
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)
        sweep_ignore_rules(self.user)
        sweep_ignore_rules(self.user)
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_an_existing_manual_ignore_stays_manual(self):
        item = self.catalog("GC-01")
        apply_sku_ignores(
            self.user,
            [
                {
                    "channel": item.channel,
                    "provider_account_id": item.provider_account_id,
                    "match_key": item.match_key,
                    "sku": item.sku,
                    "external_name": item.item_name,
                    "external_variant_title": "",
                }
            ],
        )
        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertIsNone(SalesSkuIgnore.objects.get(user=self.user).rule_id)

    def test_two_matching_rules_produce_one_row_and_the_first_claim_keeps_it(self):
        # One identity has at most one ignore row, so overlap is settled by
        # whoever got there first rather than by writing the row twice.
        self.catalog("GC-01")
        first = self.save_rule(condition("sku", "starts_with", "GC"))
        self.save_rule(condition("title", "contains", "linzer"))
        row = SalesSkuIgnore.objects.get(user=self.user)
        self.assertEqual(str(row.rule_id), first["rule"]["id"])


class AllChannelRuleTests(IgnoreRuleTestCase):
    """A rule may name no channel at all, which means every one of them."""

    def test_a_rule_without_a_channel_sweeps_every_channel(self):
        self.catalog("GC-01")
        self.catalog("GC-02", channel="shopify", account="shop-1")
        result = self.save_rule(condition("sku", "starts_with", "GC"), channel=None)

        self.assertEqual(result["ignored"], 2)
        self.assertEqual(
            self.ignored_keys(),
            {"square:item:GC-01:Linzer cookie:", "shopify:item:GC-02:Linzer cookie:"},
        )

    def test_a_scoped_sweep_stays_inside_the_channel_it_was_asked_for(self):
        # A Square sync sweeps behind itself. The catch-all rule takes part,
        # but must not reach across into Shopify on that sync's behalf.
        self.catalog("GC-01")
        self.catalog("GC-02", channel="shopify", account="shop-1")
        self.rule(condition("sku", "starts_with", "GC"), channel=None)

        sweep_ignore_rules(self.user, channels={"square"})
        self.assertEqual(self.ignored_keys(), {"square:item:GC-01:Linzer cookie:"})

    def test_a_named_channel_claims_a_contested_identity_first(self):
        # Both rules match, and one identity holds one row, so the ordering has
        # to decide the same way on SQLite and PostgreSQL.
        self.catalog("GC-01")
        everywhere = self.rule(condition("sku", "starts_with", "GC"), channel=None)
        here = self.rule(condition("title", "contains", "linzer"), channel="square")

        sweep_ignore_rules(self.user)
        row = SalesSkuIgnore.objects.get(user=self.user)
        self.assertEqual(row.rule_id, here.id)
        self.assertEqual(everywhere.ignores.count(), 0)

    def test_it_cannot_repeat_a_rule_a_channel_already_carries(self):
        self.save_rule(condition("sku", "starts_with", "GC"))
        with self.assertRaisesMessage(ValueError, "already exists"):
            self.save_rule(condition("sku", "starts_with", "gc"), channel=None)

    def test_a_channel_cannot_repeat_a_rule_that_covers_everything(self):
        self.save_rule(condition("sku", "starts_with", "GC"), channel=None)
        with self.assertRaisesMessage(ValueError, "already exists"):
            self.save_rule(condition("sku", "starts_with", "gc"), channel="shopify")

    def test_narrowing_it_to_one_channel_releases_the_other(self):
        self.catalog("GC-01")
        self.catalog("GC-02", channel="shopify", account="shop-1")
        saved = self.save_rule(condition("sku", "starts_with", "GC"), channel=None)

        self.save_rule(
            condition("sku", "starts_with", "GC"),
            channel="square",
            rule_id=saved["rule"]["id"],
        )
        self.assertEqual(self.ignored_keys(), {"square:item:GC-01:Linzer cookie:"})

    def test_a_missing_channel_is_not_read_as_every_channel(self):
        with self.assertRaisesMessage(ValueError, "Sales channel is required"):
            action_save_sales_ignore_rule(
                self.user,
                {
                    "enabled": True,
                    "conditions": [condition("sku", "starts_with", "GC")],
                },
            )


class LifecycleTests(IgnoreRuleTestCase):
    def test_narrowing_a_rule_releases_what_no_longer_matches(self):
        self.catalog("GC-01")
        self.catalog("GC-02", name="Gift voucher")
        saved = self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(SalesSkuIgnore.objects.count(), 2)

        self.save_rule(
            condition("sku", "starts_with", "GC"),
            condition("title", "contains", "voucher"),
            rule_id=saved["rule"]["id"],
        )
        self.assertEqual(self.ignored_keys(), {"square:item:GC-02:Gift voucher:"})

    def test_widening_a_rule_takes_more(self):
        self.catalog("GC-01")
        self.catalog("CK-01")
        saved = self.save_rule(condition("sku", "starts_with", "GC"))
        self.save_rule(condition("sku", "contains", "-0"), rule_id=saved["rule"]["id"])
        self.assertEqual(SalesSkuIgnore.objects.count(), 2)

    def test_disabling_releases_and_re_enabling_reclaims(self):
        self.catalog("GC-01")
        saved = self.save_rule(condition("sku", "starts_with", "GC"))
        rule_id = saved["rule"]["id"]

        self.save_rule(
            condition("sku", "starts_with", "GC"), enabled=False, rule_id=rule_id
        )
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

        self.save_rule(
            condition("sku", "starts_with", "GC"), enabled=True, rule_id=rule_id
        )
        self.assertEqual(SalesSkuIgnore.objects.count(), 1)

    def test_deleting_a_rule_restores_its_identities(self):
        self.catalog("GC-01")
        saved = self.save_rule(condition("sku", "starts_with", "GC"))
        result = action_delete_sales_ignore_rule(
            self.user, {"id": saved["rule"]["id"]}
        )
        self.assertEqual(result["restored"], 1)
        self.assertEqual(SalesSkuIgnore.objects.count(), 0)

    def test_deleting_one_rule_hands_its_rows_to_another(self):
        self.catalog("GC-01")
        owner = self.save_rule(condition("title", "contains", "linzer"))
        keeper = self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(
            str(SalesSkuIgnore.objects.get().rule_id), owner["rule"]["id"]
        )

        action_delete_sales_ignore_rule(self.user, {"id": owner["rule"]["id"]})
        self.assertEqual(
            str(SalesSkuIgnore.objects.get().rule_id), keeper["rule"]["id"]
        )

    def test_moving_a_rule_to_the_other_channel_releases_what_it_left(self):
        # The released identity sits on the channel the rule just left, so a
        # sweep scoped to the saved channel would strand it as ignored.
        self.catalog("GC-01")
        self.catalog("GC-02", channel="shopify", account="shop-1")
        saved = self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(self.ignored_keys(), {"square:item:GC-01:Linzer cookie:"})

        self.save_rule(
            condition("sku", "starts_with", "GC"),
            channel="shopify",
            rule_id=saved["rule"]["id"],
        )
        self.assertEqual(self.ignored_keys(), {"shopify:item:GC-02:Linzer cookie:"})

    def test_a_rule_survives_its_identity_leaving_the_catalog(self):
        item = self.catalog("GC-01")
        self.save_rule(condition("sku", "starts_with", "GC"))
        item.is_active = False
        item.save(update_fields=["is_active"])
        self.assertEqual(SalesSkuIgnore.objects.count(), 1)

    def test_restoring_a_rule_owned_row_is_refused_by_name(self):
        # Deleting it would only invite the next sweep to write it back, so the
        # refusal names the row and sends the merchant to the rule.
        item = self.catalog("GC-01")
        self.save_rule(condition("sku", "starts_with", "GC"))
        with self.assertRaises(ValueError) as caught:
            action_unignore_sales_skus(
                self.user,
                {
                    "items": [
                        {
                            "channel": item.channel,
                            "providerAccountId": item.provider_account_id,
                            "matchKey": item.match_key,
                        }
                    ]
                },
            )
        self.assertIn("auto-ignore rule", str(caught.exception))
        self.assertIn("GC-01", str(caught.exception))
        self.assertEqual(SalesSkuIgnore.objects.count(), 1)

    def test_restoring_a_manual_row_still_works(self):
        item = self.catalog("CK-01")
        apply_sku_ignores(
            self.user,
            [
                {
                    "channel": item.channel,
                    "provider_account_id": item.provider_account_id,
                    "match_key": item.match_key,
                    "sku": item.sku,
                    "external_name": item.item_name,
                    "external_variant_title": "",
                }
            ],
        )
        result = action_unignore_sales_skus(
            self.user,
            {
                "items": [
                    {
                        "channel": item.channel,
                        "providerAccountId": item.provider_account_id,
                        "matchKey": item.match_key,
                    }
                ]
            },
        )
        self.assertEqual(result["removed"], 1)


class DownstreamTests(IgnoreRuleTestCase):
    def test_a_swept_identity_leaves_review_and_appears_as_rule_owned(self):
        self.catalog("GC-01")
        self.catalog("CK-01")
        before = pending_review_count(self.user, ignore_key_set(self.user))
        self.save_rule(condition("sku", "starts_with", "GC"))
        after = pending_review_count(self.user, ignore_key_set(self.user))
        self.assertEqual(before - after, 1)

        overview = menu_overview_payload(self.user, ["review", "ignored"])
        review_skus = {row["sku"] for row in overview["review"]["items"]}
        self.assertNotIn("GC-01", review_skus)
        ignored = overview["review"]["ignoredItems"]
        self.assertEqual([row["source"] for row in ignored], ["rule"])
        self.assertIsNotNone(ignored[0]["ruleId"])

    def test_the_rules_section_reports_what_each_rule_holds(self):
        self.catalog("GC-01")
        self.catalog("GC-02")
        self.save_rule(condition("sku", "starts_with", "GC"))
        overview = menu_overview_payload(self.user, ["rules"])
        self.assertEqual(len(overview["rules"]), 1)
        self.assertEqual(overview["rules"][0]["ignoredCount"], 2)

    def test_the_rules_section_costs_the_same_however_many_rules_exist(self):
        self.rule(condition("sku", "is", "sku-0"))
        # 8, not 7: sizing the modifier queue is one distinct scan every
        # section list pays, so the Products toolbar can name it without
        # asking for the rows.
        with self.assertNumQueries(8) as one_rule:
            menu_overview_payload(self.user, ["rules"])
        for index in range(1, 10):
            self.rule(condition("sku", "is", f"sku-{index}"))
        with self.assertNumQueries(
            len(one_rule.captured_queries),
            msg="rule counts are one annotate, not one query per rule",
        ):
            menu_overview_payload(self.user, ["rules"])



class PreviewTests(IgnoreRuleTestCase):
    def preview(self, *conditions, **kw):
        return action_preview_sales_ignore_rule(
            self.user,
            {"channel": "square", "conditions": list(conditions), **kw},
        )

    def test_the_preview_reports_the_same_set_the_sweep_would_write(self):
        self.catalog("GC-01")
        self.line("GC-02")
        self.catalog("CK-01")
        payload = self.preview(condition("sku", "starts_with", "GC"))
        previewed = {row["matchKey"] for row in payload["items"]}

        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(previewed, self.ignored_keys())

    def test_a_preview_without_a_channel_covers_both(self):
        self.catalog("GC-01")
        self.catalog("GC-02", channel="shopify", account="shop-1")
        payload = self.preview(condition("sku", "starts_with", "GC"), channel=None)
        self.assertEqual(
            {row["channel"] for row in payload["items"]}, {"square", "shopify"}
        )

    def test_an_identity_in_both_populations_is_previewed_once(self):
        # A synced catalog row and the lines it sold are the same identity; the
        # sweep writes one row for it, so the preview must not promise two.
        item = self.catalog("GC-01")
        self.line("GC-01", match_key=item.match_key)
        payload = self.preview(condition("sku", "starts_with", "GC"))

        self.assertEqual(payload["meta"]["pagination"]["total"], 1)
        self.assertEqual(len(payload["items"]), 1)

        self.save_rule(condition("sku", "starts_with", "GC"))
        self.assertEqual(len(self.ignored_keys()), 1)

    def test_the_preview_shows_what_a_rule_will_not_take(self):
        item = self.catalog("GC-01")
        action_save_sales_product(
            self.user,
            {
                "name": "Gift card",
                "variants": [
                    {
                        "channel": item.channel,
                        "providerAccountId": item.provider_account_id,
                        "matchKey": item.match_key,
                        "sku": item.sku,
                        "externalName": item.item_name,
                        "externalVariantTitle": "",
                    }
                ],
            },
        )
        self.catalog("GC-02")
        rows = {
            row["sku"]: row["status"]
            for row in self.preview(condition("sku", "starts_with", "GC"))["items"]
        }
        self.assertEqual(rows, {"GC-01": "tracked", "GC-02": "pending"})

    def test_the_preview_searches_and_paginates(self):
        for index in range(30):
            self.catalog(f"GC-{index:02d}", name=f"Gift card {index:02d}")
        first = self.preview(condition("sku", "starts_with", "GC"))
        self.assertEqual(first["meta"]["pagination"]["total"], 30)
        self.assertEqual(len(first["items"]), 25)
        self.assertEqual(first["meta"]["pagination"]["pages"], 2)

        second = self.preview(condition("sku", "starts_with", "GC"), page=2)
        self.assertEqual(len(second["items"]), 5)

        searched = self.preview(condition("sku", "starts_with", "GC"), q="card 07")
        self.assertEqual([row["sku"] for row in searched["items"]], ["GC-07"])

    def test_a_page_beyond_the_end_is_refused(self):
        self.catalog("GC-01")
        with self.assertRaises(ValueError):
            self.preview(condition("sku", "starts_with", "GC"), page=9)

    def test_the_preview_refuses_what_the_save_would_refuse(self):
        with self.assertRaises(ValueError):
            self.preview(condition("sku", "is", ""))
