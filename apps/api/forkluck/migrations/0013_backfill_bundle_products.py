"""Turn every assorted variant into a bundle product with product components.

An assorted variant was a sales-attribution rule with no product row: no
price, no cost, no packaging, and one copy per channel listing.  This pass
gives each distinct box a real product, so the same box sold on two channels
becomes one product with two variants.

Grouping is by *normalized counts*, not by raw member weights: a Square
listing of 3/3/3/3 with multiplier 12 and a Shopify listing of 1/1/1/1 with
multiplier 12 both mean three of each, and they must collapse into one
product.  Components are written in `component_product_id` order — the order
the old member split walked — so the cents an expanded view allocates are
identical to the ones the member split allocated.
"""

import re
from collections import Counter
from decimal import Decimal

from django.db import migrations


COUNT_PLACES = Decimal("0.001")
# A channel listing names its fulfilment in the last " - " segment. It is not
# part of the product's name and it is what makes two listings of one box read
# as two different boxes.
SHIPPING_SEGMENT = re.compile(
    r"\b(ship|shipping|pre-?order|delivery|pickup|when ready)\b", re.IGNORECASE
)


def _normalized(value: str) -> str:
    return re.sub("[\\s\\ufeff]+", " ", value.lower()).strip()


def _bundle_name(external_names: list[str]) -> str:
    """The shortest listing name in the group, minus its fulfilment segment."""
    candidates = []
    for raw in external_names:
        name = raw.strip()
        if not name:
            continue
        segments = name.split(" - ")
        if len(segments) > 1 and SHIPPING_SEGMENT.search(segments[-1]):
            trimmed = " - ".join(segments[:-1]).strip()
            name = trimmed or name
        candidates.append(name)
    if not candidates:
        return "Box"
    return min(candidates, key=lambda value: (len(value), value))


def _bundle_sku(skus: list[str], taken: set[str]) -> str:
    """The group's usual SKU, unless a product already owns its normal form.

    `sales_product_user_normalized_sku_unique` would refuse the insert; a
    blank SKU is the only answer that keeps the migration running, and the
    merchant types the real one when they open the product.
    """
    counted = Counter(sku for sku in skus if sku.strip())
    if not counted:
        return ""
    top = max(counted.values())
    sku = min(sku for sku, count in counted.items() if count == top)
    return "" if _normalized(sku) in taken else sku


def backfill_bundle_products(apps, schema_editor):
    SalesProduct = apps.get_model("forkluck", "SalesProduct")
    SalesProductComponent = apps.get_model("forkluck", "SalesProductComponent")
    SalesProductVariant = apps.get_model("forkluck", "SalesProductVariant")
    SalesLine = apps.get_model("forkluck", "SalesLine")

    assorted = SalesProductVariant.objects.filter(kind="assorted").order_by(
        "created_at", "id"
    )
    user_ids = sorted({row.user_id for row in assorted.only("user_id")})
    for user_id in user_ids:
        variants = list(
            SalesProductVariant.objects.filter(user_id=user_id, kind="assorted")
            .order_by("created_at", "id")
            .prefetch_related("members")
        )
        taken = set(
            SalesProduct.objects.filter(user_id=user_id)
            .exclude(normalized_sku="")
            .values_list("normalized_sku", flat=True)
        )
        groups: dict[tuple, tuple[list, list]] = {}
        for variant in variants:
            members = sorted(variant.members.all(), key=lambda row: row.product_id)
            weight_total = sum(member.quantity for member in members)
            counts = []
            for member in members:
                count = (
                    Decimal(variant.quantity_multiplier)
                    * Decimal(member.quantity)
                    / Decimal(weight_total)
                ).quantize(COUNT_PLACES)
                counts.append((member.product_id, count))
            key = tuple((str(product_id), str(count)) for product_id, count in counts)
            groups.setdefault(key, (counts, []))[1].append(variant)

        for counts, group in groups.values():
            sku = _bundle_sku([variant.sku for variant in group], taken)
            name = _bundle_name([variant.external_name for variant in group])
            bundle = SalesProduct.objects.create(
                user_id=user_id,
                name=name[:200],
                normalized_name=re.sub(r"\s+", " ", name).strip().casefold()[:200],
                sku=sku,
                normalized_sku=_normalized(sku),
                description="",
                sell_price_cents=0,
                base_unit="",
                category="",
                is_active=True,
                link_source="manual",
            )
            if bundle.normalized_sku:
                taken.add(bundle.normalized_sku)
            SalesProductComponent.objects.bulk_create(
                [
                    SalesProductComponent(
                        product=bundle,
                        component_product_id=product_id,
                        quantity=count,
                        unit="",
                        position=position,
                    )
                    for position, (product_id, count) in enumerate(counts)
                ]
            )
            for variant in group:
                # Attribution stays: a variant that claims 30% of its sale
                # claims the same 30% of it as a bundle.
                SalesProductVariant.objects.filter(pk=variant.pk).update(
                    product=bundle, kind="direct", quantity_multiplier=Decimal("1")
                )
                SalesLine.objects.filter(user_id=user_id, variant_id=variant.pk).exclude(
                    product_id=bundle.pk
                ).update(product_id=bundle.pk)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("forkluck", "0012_sales_product_component_product"),
    ]

    operations = [
        migrations.RunPython(backfill_bundle_products, noop),
    ]
