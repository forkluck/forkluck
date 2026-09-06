"""Apply a merchant's SKU decisions wherever the SKU appears.

A merchant selling the same item on Shopify and Square would otherwise have to
link the two identities by hand, once per channel, before either one costs or
reports as one product. Syncing never invents products: catalogs land in
review and stay there until a person tracks them. But once the merchant has
said what a SKU *is* (a single product, or one product sold as a pack of six),
repeating that decision for the same SKU on another identity carries no
judgement.

Two things say what a SKU is. Tracking a variant mirrors that decision onto
every other identity carrying its SKU, on the other channel and on further
holders of the same channel alike. And the SKUs a product declares on its own
page, each with its units per sale, link matching identities as they arrive
from a sync, whether or not the product has ever been tracked anywhere; a pack
SKU declared as x6 links with that multiplier. What still sits out: an
identity whose own records disagree on the SKU, one the merchant ignored, and
any SKU already spoken for by a *different* product, the one wrong link this
must never make, since splitting or merging revenue across products is worse
than an unlinked row.

Every variant this writes is stamped `auto_sku` so it can be withdrawn again;
see `withdraw_auto_matches`.
"""

from dataclasses import dataclass, field
from decimal import Decimal

from django.db import transaction
from django.db.models import Count

from ...models import (
    BenchCostSettings,
    SalesCatalogItem,
    SalesChannelConnection,
    SalesProductVariant,
    SalesLine,
    SalesProduct,
    SalesProductSku,
    User,
)
from ..shared.locking import lock_workspace
from .core import (
    attach_lines_to_variant,
    detach_lines_from_variant,
    group_key_part,
    ignore_key_set,
    identity_scope_key,
)

# Mirroring is defined between exactly these two channels.
SHOPIFY = "shopify"
SQUARE = "square"


@dataclass(frozen=True)
class Candidate:
    """One provider identity eligible to receive a mirrored variant."""

    channel: str
    provider_account_id: str
    match_key: str
    normalized_sku: str
    item_name: str
    external_variant_title: str
    external_object_id: str
    product_external_object_id: str

    @property
    def scope(self) -> tuple[str, str, str]:
        return (self.channel, self.provider_account_id, self.match_key)


def auto_match_enabled(user: User) -> bool:
    """Whether this workspace wants its SKU decisions mirrored.

    Read straight off the model rather than through the workspace domain:
    domains are independent, and `domains/sales` may not import
    `domains/workspace`. A workspace with no settings row has never opted out.
    """
    row = (
        BenchCostSettings.objects.filter(user=user)
        .values_list("product_auto_match_enabled", flat=True)
        .first()
    )
    return True if row is None else row


def _active_accounts(user: User) -> set[tuple[str, str]]:
    """Active connections whose catalog has been fetched on this connection.

    Disconnecting deletes the connection row but leaves catalog rows behind, so
    a reconnected account arrives with stale `is_active` snapshots and a fresh
    row whose `product_catalog_synced_at` is null. Until its own refresh lands,
    those snapshots cannot vouch for SKU uniqueness — so the account sits out.
    """
    return set(
        SalesChannelConnection.objects.filter(
            user=user,
            status=SalesChannelConnection.Status.ACTIVE,
            product_catalog_synced_at__isnull=False,
        ).values_list("provider", "provider_account_id")
    )


def _claimed_skus(user: User, exclude_product_id=None) -> set[str]:
    """Normalized SKUs already spoken for by a link on either channel.

    A SKU that names an existing variant is not free to mirror onto a new
    identity: linking it would put the same SKU on two products. The product
    being mirrored *from* is excluded — its own variants claiming the SKU is
    the whole premise.
    """
    variants = SalesProductVariant.objects.filter(user=user)
    lines = SalesLine.objects.filter(user=user, variant__isnull=False)
    if exclude_product_id is not None:
        variants = variants.exclude(product_id=exclude_product_id)
        lines = lines.exclude(variant__product_id=exclude_product_id)
    claimed = {
        group_key_part(sku)
        for sku in variants.exclude(sku="").values_list("sku", flat=True).distinct()
    }
    # Distinct in the database: the ledger holds one row per historical sale,
    # not per SKU.
    claimed.update(
        group_key_part(sku)
        for sku in lines.exclude(sku="").values_list("sku", flat=True).distinct()
    )
    # A declared product SKU (own or pack) is the merchant's canonical identity
    # even when no provider variant has been saved with it yet. Exclude the
    # source product itself: its declared SKUs are the decision being applied.
    # The table's unique constraint keeps one SKU from naming two products,
    # while repeated provider identities under that one product remain
    # eligible below.
    canonical_skus = SalesProductSku.objects.filter(user=user)
    if exclude_product_id is not None:
        canonical_skus = canonical_skus.exclude(product_id=exclude_product_id)
    claimed.update(
        group_key_part(sku)
        for sku in canonical_skus.values_list("normalized_sku", flat=True)
    )
    # And the SKU an already-linked identity carries in the catalog *now*. Its
    # variant may have been saved with a blank SKU, or the provider may have
    # changed it since; either way that identity is not in the candidate pool,
    # so without this its SKU would look unspoken-for and a second identity
    # carrying it would mirror — merging two products' revenue.
    linked_scopes = set(
        variants.values_list("channel", "provider_account_id", "match_key")
    )
    if linked_scopes:
        for channel, account, key, sku in SalesCatalogItem.objects.filter(
            user=user, is_active=True
        ).exclude(sku="").values_list(
            "channel", "provider_account_id", "match_key", "sku"
        ):
            if (channel, account, key) in linked_scopes:
                claimed.add(group_key_part(sku))
    claimed.discard("")
    return claimed


def _line_candidates(
    user: User, active: set[tuple[str, str]], listed: set[tuple[str, str, str]]
) -> list[Candidate]:
    """Pending sales-line identities, one candidate per SKU they carry.

    An identity whose lines disagree on SKU is emitted once per SKU, so
    `_candidate_pool` sees the disagreement, keeps every one of those SKUs
    counted against its channel, and selects none of them.
    """
    rows = (
        SalesLine.objects.filter(user=user, variant__isnull=True)
        .exclude(sku="")
        .values("channel", "provider_account_id", "match_key", "sku")
        .annotate(occurrences=Count("id"))
    )
    by_identity: dict[tuple[str, str, str], dict] = {}
    for row in rows:
        scope = (row["channel"], row["provider_account_id"], row["match_key"])
        normalized = group_key_part(row["sku"])
        if not normalized:
            continue
        entry = by_identity.setdefault(scope, {"skus": set(), "row": row})
        entry["skus"].add(normalized)

    names = {
        (row["channel"], row["provider_account_id"], row["match_key"]): row
        for row in SalesLine.objects.filter(user=user, variant__isnull=True)
        .values(
            "channel",
            "provider_account_id",
            "match_key",
            "item_name",
            "external_variant_title",
            "external_object_id",
            "product_external_object_id",
        )
        .distinct()
    }

    candidates = []
    for scope, entry in by_identity.items():
        channel, account, _ = scope
        if (channel, account) not in active:
            continue
        if scope in listed:
            continue
        detail = names.get(scope)
        if detail is None or not detail["item_name"].strip():
            continue
        for normalized in sorted(entry["skus"]):
            candidates.append(
                Candidate(
                    channel=channel,
                    provider_account_id=account,
                    match_key=scope[2],
                    normalized_sku=normalized,
                    item_name=detail["item_name"],
                    external_variant_title=detail["external_variant_title"],
                    external_object_id=detail["external_object_id"],
                    product_external_object_id=detail["product_external_object_id"],
                )
            )
    return candidates


def _catalog_candidates(
    user: User, active: set[tuple[str, str]], listed: set[tuple[str, str, str]]
) -> list[Candidate]:
    """Synced catalog rows that have never been sold or linked."""
    candidates = []
    for item in SalesCatalogItem.objects.filter(user=user, is_active=True).exclude(
        sku=""
    ):
        scope = (item.channel, item.provider_account_id, item.match_key)
        if (item.channel, item.provider_account_id) not in active:
            continue
        if scope in listed:
            continue
        normalized = group_key_part(item.sku)
        if not normalized or not item.item_name.strip():
            continue
        candidates.append(
            Candidate(
                channel=item.channel,
                provider_account_id=item.provider_account_id,
                match_key=item.match_key,
                normalized_sku=normalized,
                item_name=item.item_name,
                external_variant_title=item.external_variant_title,
                external_object_id=item.external_object_id,
                product_external_object_id="",
            )
        )
    return candidates


def _candidate_pool(user: User):
    """Every unlinked identity, merged across its sale and catalog records.

    A sold item is usually in the synced catalog too, and both records derive
    the same object-ID match_key. Merge by identity, recording every SKU an
    identity was seen under, and mark as conflicting any identity whose records
    disagree — that is the ambiguity mirroring must not resolve on its own.

    Returns `(by_sku, merged, conflicting)`: SKUs to the scopes observed under
    them per channel, scopes to one representative candidate, and the scopes
    whose records disagree.
    """
    active = _active_accounts(user)
    listed = set(
        SalesProductVariant.objects.filter(user=user).values_list(
            "channel", "provider_account_id", "match_key"
        )
    )
    merged: dict[tuple[str, str, str], Candidate] = {}
    observed: dict[tuple[str, str, str], set[str]] = {}
    conflicting: set[tuple[str, str, str]] = set()
    for candidate in _line_candidates(user, active, listed) + _catalog_candidates(
        user, active, listed
    ):
        observed.setdefault(candidate.scope, set()).add(candidate.normalized_sku)
        seen = merged.get(candidate.scope)
        if seen is None:
            merged[candidate.scope] = candidate
        elif seen.normalized_sku != candidate.normalized_sku:
            conflicting.add(candidate.scope)

    by_sku: dict[tuple[str, str], list[tuple[str, str, str]]] = {}
    for scope, skus in observed.items():
        channel = scope[0]
        if channel not in (SHOPIFY, SQUARE):
            continue
        # Ignored and conflicting identities stay in the bucket and are
        # filtered where the mirror picks its targets — each sits out on its
        # own verdict without hiding the SKU's other holders.
        for normalized in skus:
            by_sku.setdefault((channel, normalized), []).append(scope)
    return by_sku, merged, conflicting


def _mirrorable(variant: SalesProductVariant, *, has_product_sku: bool) -> bool:
    return (
        variant.product_id is not None
        and variant.identity_kind == SalesProductVariant.IdentityKind.ITEM
        and variant.channel in (SHOPIFY, SQUARE)
        and bool(has_product_sku or group_key_part(variant.sku))
    )


@dataclass
class _Pool:
    """The unlinked identities one linking pass draws from, plus its verdicts."""

    by_sku: dict
    merged: dict
    conflicting: set
    ignored: set
    claimed_for: dict = field(default_factory=dict)


def _pool(user: User) -> _Pool:
    by_sku, merged, conflicting = _candidate_pool(user)
    return _Pool(by_sku, merged, conflicting, ignore_key_set(user))


def _link_sku(
    user: User,
    pool: _Pool,
    product_id,
    normalized: str,
    *,
    quantity_multiplier: Decimal,
    attribution_percent=None,
    source_channel: str | None = None,
) -> tuple[int, int]:
    """Link every eligible holder of one SKU to one product."""
    if product_id not in pool.claimed_for:
        pool.claimed_for[product_id] = _claimed_skus(
            user, exclude_product_id=product_id
        )
    if normalized in pool.claimed_for[product_id]:
        return 0, 0
    sku_key = f"sku:{normalized}"[:500]
    targets: list[tuple[str, str, str]] = []
    for channel in (SHOPIFY, SQUARE):
        scopes = [
            scope
            for scope in pool.by_sku.get((channel, normalized), [])
            # An identity whose own records disagree, or one the merchant
            # ignored, keeps its verdict: it sits out without stopping the
            # rest of the SKU's holders from linking.
            if scope not in pool.conflicting
            and identity_scope_key(*scope) not in pool.ignored
        ]
        # A `sku:` match_key names no object: it is history from an import
        # that predates the identity's object ID, not a rival item. Wherever
        # a real variant with this SKU exists (the source or a mirror), attach
        # claims those lines through the SKU; only a channel with no real
        # identity at all links the leftover directly so its history still
        # counts.
        real = [scope for scope in scopes if scope[2] != sku_key]
        if real:
            targets.extend(real)
        elif channel != source_channel:
            targets.extend(scope for scope in scopes if scope[2] == sku_key)
    created = attached = 0
    for scope in targets:
        candidate = pool.merged[scope]
        mirrored = SalesProductVariant(
            user=user,
            product_id=product_id,
            channel=candidate.channel,
            provider_account_id=candidate.provider_account_id,
            match_key=candidate.match_key,
            sku=candidate.normalized_sku,
            external_name=candidate.item_name[:240],
            external_variant_title=candidate.external_variant_title[:200],
            identity_kind=SalesProductVariant.IdentityKind.ITEM,
            external_object_id=candidate.external_object_id,
            product_external_object_id=candidate.product_external_object_id,
            # The merchant's decision, applied wherever the SKU appears.
            # Dropping attribution would have one SKU claim the whole sale
            # on one channel and part of it on the other.
            quantity_multiplier=quantity_multiplier,
            attribution_percent=attribution_percent,
            link_source=SalesProductVariant.LinkSource.AUTO_SKU,
        )
        mirrored.save()
        attached += attach_lines_to_variant(user, mirrored)
        created += 1
    if targets:
        # The pool is stale the moment the links land: those identities are
        # now listed and the SKU claimed for every other product.
        pool.by_sku[(SHOPIFY, normalized)] = []
        pool.by_sku[(SQUARE, normalized)] = []
        for skus in pool.claimed_for.values():
            skus.add(normalized)
    return created, attached


def _product_skus(user: User, product_ids) -> dict:
    """`{product_id: {normalized_sku: quantity_multiplier}}` for declared SKUs."""
    skus: dict = {}
    for product_id, normalized, multiplier in SalesProductSku.objects.filter(
        user=user, product_id__in=product_ids
    ).values_list("product_id", "normalized_sku", "quantity_multiplier"):
        skus.setdefault(product_id, {})[normalized] = multiplier
    return skus


def mirror_variants(
    user: User, variants: list[SalesProductVariant]
) -> tuple[int, int]:
    """Apply each tracked variant's decision to every holder of its SKU.

    Returns `(variants_created, lines_attached)`. Idempotent: an identity that
    already carries a variant is not a candidate, so re-running neither
    duplicates a variant nor moves one. Callers hold the save's transaction;
    the workspace lock serializes this against `withdraw_auto_matches`, so a
    merchant turning the setting off cannot race fresh `auto_sku` rows into a
    workspace that no longer wants them.
    """
    if not auto_match_enabled(user):
        return 0, 0
    product_skus = _product_skus(
        user, [variant.product_id for variant in variants if variant.product_id]
    )
    eligible = [
        variant
        for variant in variants
        if _mirrorable(
            variant, has_product_sku=variant.product_id in product_skus
        )
    ]
    if not eligible:
        return 0, 0

    lock_workspace(user)
    pool = _pool(user)
    created = attached = 0
    for source in eligible:
        # Every SKU the product declares, each with its own units per sale,
        # plus the variant's own SKU counted the way the variant counts.
        skus = dict(product_skus.get(source.product_id, {}))
        own = group_key_part(source.sku)
        if own:
            skus.setdefault(own, source.quantity_multiplier)
        for normalized, multiplier in skus.items():
            linked, lines = _link_sku(
                user,
                pool,
                source.product_id,
                normalized,
                quantity_multiplier=multiplier,
                attribution_percent=source.attribution_percent,
                source_channel=source.channel,
            )
            created += linked
            attached += lines
    return created, attached


def mirror_pending(user: User) -> tuple[int, int]:
    """Link pending identities to the products whose declared SKUs they carry.

    Runs as identities arrive (after a sync lands its catalog or orders) and
    when the setting is turned on. Needs no tracked variant: a product that
    has never been linked anywhere but declares `102201 x6` still claims the
    box identity, counted as six. Same lock and idempotency as
    `mirror_variants`.
    """
    if not auto_match_enabled(user):
        return 0, 0
    product_skus = _product_skus(
        user, SalesProduct.objects.filter(user=user).values_list("id", flat=True)
    )
    if not product_skus:
        return 0, 0

    lock_workspace(user)
    pool = _pool(user)
    created = attached = 0
    for product_id, skus in product_skus.items():
        for normalized, multiplier in skus.items():
            linked, lines = _link_sku(
                user, pool, product_id, normalized, quantity_multiplier=multiplier
            )
            created += linked
            attached += lines
    return created, attached


@transaction.atomic
def mirror_existing_links(user: User) -> int:
    """Mirror every already-tracked variant once. Returns variants created.

    Turning the setting on (and the backfill command) walk the workspace's
    existing decisions so a merchant who tracked everything single-sided is
    not left to re-track it all just to reach the other channel. Declared
    product SKUs are applied in the same pass.
    """
    mirrored = mirror_variants(
        user,
        list(
            SalesProductVariant.objects.filter(
                user=user,
                product__isnull=False,
                identity_kind=SalesProductVariant.IdentityKind.ITEM,
            )
        ),
    )[0]
    return mirrored + mirror_pending(user)[0]


@transaction.atomic
def withdraw_auto_matches(user: User) -> int:
    """Undo links this made and the merchant never touched.

    Only rows still stamped `auto_sku` are withdrawn; any merchant edit
    promotes a link to `manual` and puts it out of reach. Lines are released
    through `detach_lines_from_variant` so attributed revenue returns to its
    source rather than being stranded against a deleted product.

    Holds the same workspace lock `mirror_variants` takes, so a save in
    flight cannot slip fresh automatic links in behind this sweep.
    """
    lock_workspace(user)
    # Locked for the transaction: an edit action does not take the workspace
    # lock, so without this a promotion could commit between reading a row and
    # deleting it, and a link the merchant had just adopted would be swept.
    # No select_related("product"): the loop only reads product_id, and joining
    # the nullable FK under FOR UPDATE is a Postgres error ("cannot be applied
    # to the nullable side of an outer join").
    variants = list(
        SalesProductVariant.objects.select_for_update().filter(
            user=user, link_source=SalesProductVariant.LinkSource.AUTO_SKU
        )
    )
    product_ids = {
        variant.product_id for variant in variants if variant.product_id is not None
    }
    removed = 0
    for variant in variants:
        # Re-read the stamp this row was selected by. The lock above already
        # stops a promotion committing underneath, so this is belt and braces —
        # but releasing a merchant's sales because of a race would not be cheap
        # to undo, and this check is.
        if not SalesProductVariant.objects.filter(
            pk=variant.pk, link_source=SalesProductVariant.LinkSource.AUTO_SKU
        ).exists():
            continue
        # Detach before deleting. SalesLine.variant is SET_NULL, so afterwards
        # only the weaker product/match-key clause could still reach them.
        detach_lines_from_variant(variant)
        variant.delete()
        removed += 1

    # Products are the merchant's own now that only they create them; a legacy
    # `auto_sku` product from the era when syncing invented products is still
    # swept once nothing points at it. A product survives if the merchant
    # renamed it, if a manual variant still points at it, or if they put it
    # inside a bundle — that link is PROTECT, so deleting through it would
    # fail the whole action and leave the setting impossible to turn off.
    SalesProduct.objects.filter(
        user=user, id__in=product_ids, link_source="auto_sku", variants__isnull=True
    ).exclude(bundle_components__isnull=False).delete()
    return removed
