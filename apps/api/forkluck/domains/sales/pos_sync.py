"""Sales-domain orchestration and persistence for POS syncs.

Provider adapters acquire and normalize external records.  This module owns
variant interpretation, tenant-scoped persistence, accounting, watermarks,
and durable job state.
"""

import hashlib
import logging
import time as time_module
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta

from django.db import IntegrityError, connection as db_connection, transaction
from django.db.models import F, Max, Min, Q
from django.utils import timezone

from ...integrations import pos_sync as provider_sync
from ..shared.activity import record_event
from ..shared.billing import require_entitlement
from ..shared.locking import lock_workspace
from .auto_match import auto_match_enabled, mirror_pending
from ...models import (
    SalesChannelConnection,
    SalesCatalogItem,
    SalesImport,
    SalesLine,
    SalesLineModifier,
    SalesModifierList,
    SalesModifierOption,
    SyncRun,
    User,
    resolve_sold_on,
)
from ..shared.values import text_value
from .core import (
    JsonObject,
    assign_entry_fingerprints,
    existing_fingerprints,
    identity_scope_key,
    ignore_key_set,
    item_match_key,
    item_object_match_key,
    variant_index,
    refresh_sales_import_totals,
    resolve_item_variant,
    sales_group_key,
    store_entry_modifiers,
    sweep_ignore_rules,
)

logger = logging.getLogger(__name__)

BACKFILL_DAYS = provider_sync.BACKFILL_DAYS
SHOPIFY_BACKFILL_DAYS = provider_sync.SHOPIFY_BACKFILL_DAYS
OVERLAP = provider_sync.OVERLAP
TIME_BUDGET_S = provider_sync.TIME_BUDGET_S
SYNC_LEASE_TIMEOUT = provider_sync.SYNC_LEASE_TIMEOUT
CATEGORY_BACKFILL_LINE_CAP = provider_sync.CATEGORY_BACKFILL_LINE_CAP
SyncFailed = provider_sync.SyncFailed
clean_text = provider_sync.clean_text

# A single Square catalog page can block for the vendor timeout, and the web
# service kills a request well before the sum of many. The refresh is optional
# work, so it is attempted only when the orders pass left this much of its
# budget unspent; otherwise the next sync picks the catalog up.
MODIFIER_CATALOG_MIN_BUDGET_S = 15
# The full product catalog is generally larger than modifiers, but remains an
# optional decoration after durable sales progress.  Keep a distinct threshold
# so changing modifier catalog behavior cannot accidentally starve Catalog.
PRODUCT_CATALOG_MIN_BUDGET_S = 15
# Leave room for the final response after optional provider decoration. The
# sales watermark is committed before this work starts, but keeping catalog
# requests inside the caller's budget also avoids a worker timeout.
OPTIONAL_DECORATION_RESERVE_S = 2.0


def _backfill_categories(
    connection: SalesChannelConnection,
    adapter: provider_sync.PosSalesAdapter,
) -> int:
    """Fill `external_category` on this user's already-stored pending lines.

    Lines synced before category capture existed carry a blank category, which
    would leave the merchant's whole review backlog ungroupable until those
    exact items sold again. Every successful provider pass therefore tops up
    a bounded slice of them from the catalog.

    Only *pending* lines are touched: a line already claimed by a menu item has
    left the review inbox, so paying for its category buys nothing.
    """
    lines = list(
        SalesLine.objects.filter(
            user=connection.user,
            channel=connection.provider,
            provider_account_id=connection.provider_account_id,
            product__isnull=True,
            external_category="",
        )
        .only("id", "external_object_id", "source_payload")
        .order_by("id")[:CATEGORY_BACKFILL_LINE_CAP]
    )
    by_object: dict[str, list[SalesLine]] = {}
    for line in lines:
        object_id = (
            (line.source_payload or {}).get("productObjectId")
            if connection.provider == SalesImport.Channel.SHOPIFY
            else line.external_object_id
        ) or ""
        if object_id:
            by_object.setdefault(object_id, []).append(line)
    if not by_object:
        return 0
    categories = adapter.category_labels(sorted(by_object))
    updates = []
    for object_id, object_lines in by_object.items():
        category = clean_text(categories.get(object_id, ""), 120)
        if not category:
            continue
        for line in object_lines:
            line.external_category = category
            updates.append(line)
    if updates:
        with transaction.atomic():
            lock_workspace(connection.user)
            if not SalesChannelConnection.objects.select_for_update().filter(
                pk=connection.pk,
                user=connection.user,
                provider=connection.provider,
                provider_account_id=connection.provider_account_id,
                generation=connection.generation,
                status=SalesChannelConnection.Status.ACTIVE,
            ).exists():
                return 0
            SalesLine.objects.bulk_update(
                updates, ["external_category"], batch_size=500
            )
    return len(updates)


def _claim_sync_lease(connection: SalesChannelConnection) -> uuid.UUID:
    """Claim this provider before making any external API request.

    Claimed under the workspace lock so acquisition serializes with the
    matcher's lease check: a sync either shows its lease before matching
    decides, or waits until the decision has committed. The lock is released
    with this short transaction — never held across the provider fetch.
    """

    lease_token = uuid.uuid4()
    started_at = timezone.now()
    stale_before = started_at - SYNC_LEASE_TIMEOUT
    with transaction.atomic():
        lock_workspace(connection.user)
        claimed = (
            SalesChannelConnection.objects.filter(
                pk=connection.pk,
                user_id=connection.user_id,
                provider=connection.provider,
                provider_account_id=connection.provider_account_id,
                generation=connection.generation,
                status=SalesChannelConnection.Status.ACTIVE,
            )
            .filter(
                Q(sync_lease_token__isnull=True)
                | Q(sync_lease_started_at__lt=stale_before)
            )
            .update(
                sync_lease_token=lease_token,
                sync_lease_started_at=started_at,
            )
        )
    if claimed != 1:
        raise SyncFailed(
            "A sync for this channel is already running — wait for it to "
            "finish before trying again."
        )
    return lease_token


def _release_sync_lease(
    connection: SalesChannelConnection, lease_token: uuid.UUID
) -> None:
    # Match the token as well as the connection. If this worker outlived its
    # lease, it must not clear a newer worker's claim.
    SalesChannelConnection.objects.filter(
        pk=connection.pk,
        user_id=connection.user_id,
        provider=connection.provider,
        provider_account_id=connection.provider_account_id,
        generation=connection.generation,
        sync_lease_token=lease_token,
    ).update(sync_lease_token=None, sync_lease_started_at=None)


def sync_connection(
    connection: SalesChannelConnection,
    *,
    time_budget_s: int = TIME_BUDGET_S,
    include_modifier_catalog: bool = False,
    run: SyncRun | None = None,
    claim_token: uuid.UUID | None = None,
    pass_count: int = 1,
) -> JsonObject:
    """Run one bounded provider pass, serialized per connection."""

    lease_token = _claim_sync_lease(connection)
    try:
        receipt = _sync_connection(
            connection,
            time_budget_s=time_budget_s,
            include_modifier_catalog=include_modifier_catalog,
            run=run,
            claim_token=claim_token,
            pass_count=pass_count,
            lease_token=lease_token,
        )
    except Exception:
        _release_sync_lease(connection, lease_token)
        raise
    return receipt


def interpret_provider_entries(entries: list[JsonObject]) -> None:
    """Add Forkluck matching identities to provider-normalized facts.

    Adapters deliberately know nothing about variants or matching priority;
    this is the first sales-domain interpretation step.
    """

    for entry in entries:
        group_key = sales_group_key(
            entry["sku"], entry["item_name"], entry["variant_name"]
        )
        entry["group_key"] = group_key
        entry["match_key"] = item_match_key(
            entry["channel"],
            external_object_id=entry.get("external_object_id", ""),
            product_external_object_id=entry.get(
                "product_external_object_id", ""
            ),
            external_variant_title=entry["variant_name"],
            group_key=group_key,
        )


def _sync_connection(
    connection: SalesChannelConnection,
    *,
    time_budget_s: int = TIME_BUDGET_S,
    include_modifier_catalog: bool = False,
    run: SyncRun | None,
    claim_token: uuid.UUID | None,
    pass_count: int,
    lease_token: uuid.UUID,
) -> JsonObject:
    provider = connection.provider
    run_start = timezone.now()
    sync_deadline = time_module.monotonic() + time_budget_s

    backfilling = connection.backfilled_at is None
    if connection.sync_watermark is not None:
        # The overlap guards against late provider writes between sessions.
        # Square's exact in-session position is stored in sync_cursor; Shopify
        # continues to advance the timestamp watermark on bounded passes.
        since = connection.sync_watermark
        if not connection.sync_cursor and pass_count == 1:
            since -= OVERLAP
    else:
        backfill_days = (
            SHOPIFY_BACKFILL_DAYS
            if provider == SalesImport.Channel.SHOPIFY
            else BACKFILL_DAYS
        )
        since = run_start - timedelta(days=backfill_days)

    adapter = provider_sync.get_pos_sales_adapter(connection)
    acquired = adapter.acquire(
        since=since,
        until=run_start,
        backfilling=backfilling,
        time_budget_s=time_budget_s,
    )
    entries = acquired.entries
    interpret_provider_entries(entries)
    counts = {
        "fetched": len(entries),
        "malformed_lines": acquired.malformed_lines,
        "malformed_modifiers": acquired.malformed_modifiers,
        "warnings": acquired.warnings,
        "pages": acquired.pages,
    }
    progress = {
        "max_ts": acquired.max_timestamp,
        "partial": acquired.partial,
    }

    receipt: JsonObject = {
        "provider": provider,
        "batchId": None,
        "imported": 0,
        "updated": 0,
        "deduplicated": 0,
        "trackedLines": 0,
        "pendingLines": 0,
        "ignoredLines": 0,
        "pendingIdentities": 0,
        "ignoredIdentities": 0,
        "skippedMalformed": counts["malformed_lines"],
        "modifierOccurrences": 0,
        "modifierOccurrencesAttached": 0,
        "modifierOccurrencesPending": 0,
        "pendingModifierIdentities": 0,
        "skippedModifiersMalformed": counts["malformed_modifiers"],
        # Kept for older clients: sync no longer discards a line for being
        # unmatched or ignored, so nothing lands in these buckets.
        "skippedUnmatched": 0,
        "skippedIgnored": 0,
        "warnings": counts["warnings"],
        "partial": progress["partial"],
        "periodStart": None,
        "periodEnd": None,
        # Progress facts for the Sync button: how far this pass got, whatever
        # it ended up storing. `linesFetched` counts provider lines read,
        # before dedup — `imported` is the stored subset.
        "pagesProcessed": counts["pages"],
        "linesFetched": counts["fetched"],
        "categoriesBackfilled": 0,
        "catalogItemCount": 0,
    }

    try:
        pending_scope_lines = _commit_sync_pass(
            connection=connection,
            entries=entries,
            receipt=receipt,
            counts=counts,
            run_start=run_start,
            acquired=acquired,
            lease_token=lease_token,
            run=run,
            claim_token=claim_token,
            pass_count=pass_count,
        )
    except IntegrityError as exc:
        logger.warning("Concurrent sync for connection %s", connection.pk)
        raise SyncFailed(
            "A sync for this channel is already running — give it a "
            "moment, then check the Sales page."
        ) from exc

    # Durable workers finalize this display-only sweep from the checkpoint.
    # Direct callers (focused tests and administrative use) still receive a
    # complete receipt from the same primitive.
    if run is not None:
        return receipt

    # After the write, not inside it: sweeping inside would grow this
    # transaction by a full scan. The counters above were taken against the
    # pre-sync ignore set, so anything a rule just claimed is still sitting in
    # `pending` and has to be moved — a receipt that sends the merchant to a
    # review queue these rows already left is worse than no receipt.
    rule_ignored = sweep_ignore_rules(connection.user, channels={provider})
    receipt["ruleIgnoredIdentities"] = len(rule_ignored)
    for scope, line_count in pending_scope_lines.items():
        if scope not in rule_ignored:
            continue
        receipt["pendingLines"] -= line_count
        receipt["ignoredLines"] += line_count
        receipt["pendingIdentities"] -= 1
        receipt["ignoredIdentities"] += 1

    try:
        receipt["categoriesBackfilled"] = _backfill_categories(
            connection, adapter
        )
    except Exception:
        # Decoration only: a merchant who presses Sync must never lose a
        # stored run because a category lookup failed.
        logger.warning(
            "%s category backfill failed for connection %s",
            provider,
            connection.pk,
            exc_info=True,
        )

    # Modifier metadata decorates the sales result. Commit the durable sales
    # progress first so a slow catalog, outage, or revoked grant cannot make
    # the next run reread orders that were already persisted.
    catalog_deadline = sync_deadline - OPTIONAL_DECORATION_RESERVE_S
    seconds_left = catalog_deadline - time_module.monotonic()
    if (
        include_modifier_catalog
        and provider == SalesImport.Channel.SQUARE
        and not progress["partial"]
        and seconds_left >= MODIFIER_CATALOG_MIN_BUDGET_S
    ):
        try:
            sync_square_modifier_catalog(
                connection,
                adapter=adapter,
                deadline=catalog_deadline,
            )
        except Exception:
            logger.warning(
                "%s modifier catalog refresh failed for connection %s",
                provider,
                connection.pk,
                exc_info=True,
            )

    # A complete catalog walk is the only condition under which stale rows may
    # be deactivated.  The adapter raises for a deadline, pagination defect,
    # or vendor error, so this block cannot turn a partial response into a
    # destructive empty catalog.
    seconds_left = catalog_deadline - time_module.monotonic()
    if (
        include_modifier_catalog
        and connection.status == SalesChannelConnection.Status.ACTIVE
        and not progress["partial"]
        and seconds_left >= PRODUCT_CATALOG_MIN_BUDGET_S
    ):
        try:
            catalog_receipt = sync_product_catalog(
                connection,
                adapter=adapter,
                deadline=catalog_deadline,
            )
            receipt["catalogItemCount"] = catalog_receipt["itemCount"]
        except Exception:
            logger.warning(
                "%s product catalog refresh failed for connection %s",
                provider,
                connection.pk,
                exc_info=True,
            )
    return receipt


def _entry_line_values(entry: JsonObject) -> JsonObject:
    matched_variant = entry["matched_variant"]
    return {
        # variant_id is our SalesProductVariant; external_variant_title below
        # is the provider's own variation title, carried on the adapter entry
        # under its older key.
        "product_id": matched_variant.product_id if matched_variant else None,
        "variant_id": matched_variant.id if matched_variant else None,
        "group_key": entry["group_key"],
        "match_key": entry["match_key"],
        "external_object_id": entry.get("external_object_id", ""),
        "product_external_object_id": entry.get(
            "product_external_object_id", ""
        ),
        "external_category": entry.get("external_category", ""),
        "external_order_id": entry["external_order_id"],
        "sold_at": entry["sold_at"],
        "timezone": entry["timezone"],
        "sku": entry["sku"],
        "item_name": entry["item_name"],
        "external_variant_title": entry["variant_name"],
        "quantity": entry["quantity"],
        "gross_cents": entry["gross_cents"],
        "discount_cents": entry["discount_cents"],
        "net_sales_cents": entry["net_sales_cents"],
        "tax_cents": entry["tax_cents"],
        "refund_cents": entry["refund_cents"],
        "currency_code": entry["currency_code"],
        "location": entry["location"],
        "employee_name": entry["employee_name"],
        "order_source": entry["order_source"],
        "financial_status": entry["financial_status"],
        "fulfillment_status": entry["fulfillment_status"],
        "source_payload": entry["source_payload"],
    }


def _provider_snapshot_matches_entry(
    line: SalesLine, entry: JsonObject
) -> bool:
    if any(
        getattr(line, field) != value
        for field, value in _entry_line_values(entry).items()
    ):
        return False
    stored_modifiers = list(line.modifiers.all())
    incoming_modifiers = entry.get("modifiers") or []
    if len(stored_modifiers) != len(incoming_modifiers):
        return False
    fields = (
        "source_uid",
        "external_object_id",
        "sku",
        "name",
        "quantity",
        "base_price_cents",
        "total_price_cents",
        "source_payload",
    )
    return all(
        all(getattr(stored, field) == incoming[field] for field in fields)
        for stored, incoming in zip(stored_modifiers, incoming_modifiers)
    )


def _replace_provider_snapshot(
    line: SalesLine,
    entry: JsonObject,
    *,
    extra_update_fields: tuple[str, ...] = (),
) -> None:
    values = _entry_line_values(entry)
    for field, value in values.items():
        setattr(line, field, value)
    line.save(
        update_fields=[*extra_update_fields, *values, "updated_at"]
    )


def _correct_square_location_timezones(
    connection: SalesChannelConnection, fresh: dict[str, str]
) -> None:
    """Correct only history belonging to a Square location whose zone changed."""

    prior = connection.location_timezones or {}
    changed = {
        location_id: timezone_name
        for location_id, timezone_name in fresh.items()
        if prior.get(location_id) != timezone_name
    }
    if not changed:
        return
    affected_import_ids: set[uuid.UUID] = set()
    updates: list[SalesLine] = []
    corrected_at = timezone.now()
    lines = SalesLine.objects.select_for_update().filter(
        user=connection.user,
        channel=SalesImport.Channel.SQUARE,
        provider_account_id=connection.provider_account_id,
        location__in=changed,
    )
    for line in lines:
        line.timezone = changed[line.location]
        line.sold_on = resolve_sold_on(line.sold_at, line.timezone)
        line.updated_at = corrected_at
        affected_import_ids.add(line.sales_import_id)
        updates.append(line)
    if updates:
        SalesLine.objects.bulk_update(
            updates, ["timezone", "sold_on", "updated_at"], batch_size=500
        )
    for sales_import in SalesImport.objects.select_for_update().filter(
        id__in=affected_import_ids
    ):
        bounds = sales_import.lines.aggregate(
            period_start=Min("sold_on"), period_end=Max("sold_on")
        )
        sales_import.period_start = bounds["period_start"]
        sales_import.period_end = bounds["period_end"]
        sales_import.save(
            update_fields=["period_start", "period_end", "updated_at"]
        )


def _commit_sync_pass(
    *,
    connection: SalesChannelConnection,
    entries: list[JsonObject],
    receipt: JsonObject,
    counts: JsonObject,
    run_start: datetime,
    acquired: provider_sync.NormalizedSalesBatch,
    lease_token: uuid.UUID,
    run: SyncRun | None,
    claim_token: uuid.UUID | None,
    pass_count: int,
) -> dict[tuple[str, str, str], int]:
    """Atomically record one provider pass and its durable checkpoint.

    Returns how many lines each pending identity contributed, so a rule sweep
    running after this commit can move the ones it takes out of `pending`.
    """
    user = connection.user
    provider = connection.provider
    pending_scope_lines: dict[tuple[str, str, str], int] = {}
    with transaction.atomic():
        # Taken before the connection row so this flow and the sales undo
        # always acquire the workspace lock first and cannot deadlock against
        # each other. A sync writes SalesImport rows, so an undo's
        # newest-active check must not be able to interleave with it.
        lock_workspace(user)
        current_connection = (
            SalesChannelConnection.objects.select_for_update()
            .filter(
                pk=connection.pk,
                user_id=connection.user_id,
                provider=connection.provider,
                provider_account_id=connection.provider_account_id,
                generation=connection.generation,
                status=SalesChannelConnection.Status.ACTIVE,
                sync_lease_token=lease_token,
            )
            .first()
        )
        if current_connection is None:
            raise SyncFailed(
                "The provider connection changed or was disconnected before "
                "this sync could finish."
            )
        locked_run: SyncRun | None = None
        if run is not None:
            if claim_token is None:
                raise LostSyncRunClaim
            locked_run = (
                SyncRun.objects.select_for_update()
                .filter(
                    id=run.id,
                    user_id=connection.user_id,
                    connection=current_connection,
                    connection_generation=connection.generation,
                    provider=connection.provider,
                    provider_account_id=connection.provider_account_id,
                    status=SyncRun.Status.RUNNING,
                    claim_token=claim_token,
                )
                .first()
            )
            if locked_run is None:
                raise LostSyncRunClaim

        variants = variant_index(user)
        ignored = ignore_key_set(user)
        for entry in entries:
            match = resolve_item_variant(
                user,
                channel=entry["channel"],
                provider_account_id=connection.provider_account_id,
                external_object_id=entry["external_object_id"],
                product_external_object_id=entry.get(
                    "product_external_object_id", ""
                ),
                group_key=entry["match_key"],
                sku=entry["sku"],
                item_name=entry["item_name"],
                external_variant_title=entry["variant_name"],
                variants=variants,
                suggest=False,
            )
            entry["matched_variant"] = (
                match.variant if match.status == "matched" else None
            )

        if acquired.location_timezones is not None:
            _correct_square_location_timezones(
                current_connection, acquired.location_timezones
            )
        assign_entry_fingerprints(entries)
        # Provider rows with immutable ledger ids must remain distinct even
        # when every visible amount/name is identical. Their fallback hash is
        # derived from that id, while id-less custom/deleted rows retain the
        # legacy content fingerprint and occurrence suffix.
        for entry in entries:
            provider_record_id = entry.get("provider_record_id", "")
            if provider_record_id:
                entry["fingerprint"] = hashlib.sha256(
                    (
                        f"{provider}:{connection.provider_account_id}:"
                        f"{provider_record_id}"
                    ).encode("utf-8")
                ).hexdigest()
        seen = existing_fingerprints(
            user,
            provider,
            connection.provider_account_id,
            [entry["fingerprint"] for entry in entries],
        )
        provider_record_ids = {
            entry["provider_record_id"]
            for entry in entries
            if entry.get("provider_record_id")
        }
        existing_provider_lines = {
            line.provider_record_id: line
            for line in SalesLine.objects.select_for_update()
            .filter(
                user=user,
                channel=provider,
                provider_account_id=connection.provider_account_id,
                provider_record_id__in=provider_record_ids,
            )
            .select_related("sales_import")
            .prefetch_related("modifiers")
        }
        last_provider_position = {
            entry["provider_record_id"]: position
            for position, entry in enumerate(entries)
            if entry.get("provider_record_id")
        }
        new_entries = []
        updated: list[tuple[JsonObject, SalesLine]] = []
        affected_imports: set[uuid.UUID] = set()
        for position, entry in enumerate(entries):
            provider_record_id = entry.get("provider_record_id", "")
            if (
                provider_record_id
                and last_provider_position[provider_record_id] != position
            ):
                receipt["deduplicated"] += 1
                continue
            if provider_record_id:
                existing = existing_provider_lines.get(provider_record_id)
                if existing is not None:
                    if _provider_snapshot_matches_entry(existing, entry):
                        receipt["deduplicated"] += 1
                    else:
                        _replace_provider_snapshot(existing, entry)
                        updated.append((entry, existing))
                        affected_imports.add(existing.sales_import_id)
                        receipt["updated"] += 1
                    continue
            elif entry["fingerprint"] in seen:
                receipt["deduplicated"] += 1
                continue
            seen.add(entry["fingerprint"])
            new_entries.append(entry)

        if updated:
            updated_lines = [line for _, line in updated]
            SalesLineModifier.objects.filter(sales_line__in=updated_lines).delete()
            receipt["modifierOccurrences"] += store_entry_modifiers(
                user,
                provider,
                connection.provider_account_id,
                updated,
            )
            for sales_import in SalesImport.objects.select_for_update().filter(
                id__in=affected_imports
            ):
                refresh_sales_import_totals(sales_import)

        lines: list[SalesLine] = []
        if new_entries:
            period_dates = [
                resolve_sold_on(entry["sold_at"], entry["timezone"])
                for entry in new_entries
            ]
            sales_import = SalesImport.objects.create(
                user=user,
                file_name=(
                    f"{provider.title()} sync — "
                    f"{run_start:%Y-%m-%d %H:%M} UTC"
                ),
                source=SalesImport.Source.API,
                channel=provider,
                provider_account_id=connection.provider_account_id,
                timezone=connection.provider_timezone,
                currency_code=connection.currency_code,
                period_start=min(period_dates),
                period_end=max(period_dates),
                total_rows=counts["fetched"],
                skipped_count=counts["malformed_lines"],
                duplicate_count=receipt["deduplicated"],
            )
            lines = [
                SalesLine(
                    user=user,
                    sales_import=sales_import,
                    product=(
                        entry["matched_variant"].product
                        if entry["matched_variant"]
                        else None
                    ),
                    variant=entry["matched_variant"],
                    channel=provider,
                    provider_account_id=connection.provider_account_id,
                    group_key=entry["group_key"],
                    match_key=entry["match_key"],
                    external_object_id=entry.get("external_object_id", ""),
                    product_external_object_id=entry.get(
                        "product_external_object_id", ""
                    ),
                    external_category=entry.get("external_category", ""),
                    source_position=position,
                    source_fingerprint=entry["fingerprint"],
                    provider_record_id=entry.get("provider_record_id", ""),
                    external_order_id=entry["external_order_id"],
                    sold_at=entry["sold_at"],
                    timezone=entry["timezone"],
                    sku=entry["sku"],
                    item_name=entry["item_name"],
                    external_variant_title=entry["variant_name"],
                    quantity=entry["quantity"],
                    gross_cents=entry["gross_cents"],
                    discount_cents=entry["discount_cents"],
                    net_sales_cents=entry["net_sales_cents"],
                    tax_cents=entry["tax_cents"],
                    refund_cents=entry["refund_cents"],
                    currency_code=entry["currency_code"],
                    location=entry["location"],
                    employee_name=entry["employee_name"],
                    order_source=entry["order_source"],
                    financial_status=entry["financial_status"],
                    fulfillment_status=entry["fulfillment_status"],
                    source_payload=entry["source_payload"],
                )
                for position, entry in enumerate(new_entries, start=1)
            ]
            SalesLine.objects.bulk_create(lines, batch_size=500)
            receipt["modifierOccurrences"] += store_entry_modifiers(
                user,
                provider,
                connection.provider_account_id,
                list(zip(new_entries, lines)),
            )
            refresh_sales_import_totals(sales_import)
            receipt["batchId"] = str(sales_import.id)
            receipt["imported"] = len(new_entries)
            # No actor: a sync is the connector's work, not a person's.
            record_event(
                user,
                None,
                "import",
                "imported",
                resource_id=sales_import.id,
                name=sales_import.file_name,
                kind="sales",
                imported=len(new_entries),
                channel=provider,
            )

            pending_keys: set[str] = set()
            ignored_identities: set[str] = set()
            for line in lines:
                scope = identity_scope_key(
                    line.channel, line.provider_account_id, line.match_key
                )
                if line.variant_id is not None:
                    receipt["trackedLines"] += 1
                elif scope in ignored:
                    receipt["ignoredLines"] += 1
                    ignored_identities.add(line.match_key)
                else:
                    receipt["pendingLines"] += 1
                    pending_keys.add(line.match_key)
                    pending_scope_lines[scope] = (
                        pending_scope_lines.get(scope, 0) + 1
                    )
            receipt["pendingIdentities"] = len(pending_keys)
            receipt["ignoredIdentities"] = len(ignored_identities)

        changed = [*updated, *zip(new_entries, lines)]
        if changed:
            period_dates = [
                resolve_sold_on(entry["sold_at"], entry["timezone"])
                for entry, _ in changed
            ]
            receipt["periodStart"] = min(period_dates).isoformat()
            receipt["periodEnd"] = max(period_dates).isoformat()

        if receipt["modifierOccurrences"]:
            stored_modifiers = SalesLineModifier.objects.filter(
                sales_line__in=[line for _, line in changed]
            )
            receipt["modifierOccurrencesAttached"] = stored_modifiers.filter(
                variant__isnull=False
            ).count()
            receipt["modifierOccurrencesPending"] = (
                receipt["modifierOccurrences"]
                - receipt["modifierOccurrencesAttached"]
            )
            receipt["pendingModifierIdentities"] = len(
                set(
                    stored_modifiers.filter(
                        variant__isnull=True
                    ).values_list("match_key", flat=True)
                )
                - {
                    key
                    for channel, account, key in ignored
                    if channel == provider
                    and account == connection.provider_account_id
                }
            )

        if acquired.location_ids is not None:
            current_connection.location_ids = acquired.location_ids
        if acquired.location_timezones is not None:
            current_connection.location_timezones = acquired.location_timezones
        if acquired.sync_cursor is not None:
            current_connection.sync_cursor = acquired.sync_cursor
            if not acquired.partial:
                completed_at = acquired.session_end or run_start
                current_connection.sync_watermark = completed_at
                if current_connection.backfilled_at is None:
                    current_connection.backfilled_at = completed_at
        elif acquired.partial and acquired.max_timestamp is not None:
            current_connection.sync_watermark = acquired.max_timestamp
        elif not acquired.partial:
            current_connection.sync_watermark = run_start
            if current_connection.backfilled_at is None:
                current_connection.backfilled_at = run_start
        current_connection.last_synced_at = run_start
        current_connection.last_error = ""
        current_connection.sync_lease_token = None
        current_connection.sync_lease_started_at = None
        current_connection.save(
            update_fields=[
                "location_ids",
                "location_timezones",
                "sync_cursor",
                "sync_watermark",
                "backfilled_at",
                "last_synced_at",
                "last_error",
                "sync_lease_token",
                "sync_lease_started_at",
                "updated_at",
            ]
        )
        for field in (
            "location_ids",
            "location_timezones",
            "sync_cursor",
            "sync_watermark",
            "backfilled_at",
            "last_synced_at",
            "last_error",
            "sync_lease_token",
            "sync_lease_started_at",
        ):
            setattr(connection, field, getattr(current_connection, field))

        if locked_run is not None:
            now = timezone.now()
            locked_run.heartbeat_at = now
            locked_run.progress = {
                **locked_run.progress,
                "phase": "finalizing",
                "continuationPasses": pass_count,
                "partial": acquired.partial,
                "pagesProcessed": int(receipt.get("pagesProcessed") or 0),
                "linesFetched": int(receipt.get("linesFetched") or 0),
                "imported": int(receipt.get("imported") or 0),
                "updated": int(receipt.get("updated") or 0),
                "deduplicated": int(receipt.get("deduplicated") or 0),
                "lastPassAt": now.isoformat(),
            }
            locked_run.cursor = _job_cursor(
                current_connection, continuation_passes=pass_count
            )
            locked_run.checkpoint = {
                "receipt": receipt,
                "pendingScopes": [
                    {
                        "channel": scope[0],
                        "providerAccountId": scope[1],
                        "matchKey": scope[2],
                        "lineCount": count,
                    }
                    for scope, count in pending_scope_lines.items()
                ],
                "partial": acquired.partial,
                "passCount": pass_count,
            }
            locked_run.save(
                update_fields=[
                    "heartbeat_at",
                    "progress",
                    "cursor",
                    "checkpoint",
                    "updated_at",
                ]
            )
            run.heartbeat_at = locked_run.heartbeat_at
            run.progress = locked_run.progress
            run.cursor = locked_run.cursor
            run.checkpoint = locked_run.checkpoint
        # The lines just landed are pending until a declared SKU claims them.
        if auto_match_enabled(user):
            mirror_pending(user)
    return pending_scope_lines


def sync_product_catalog(
    connection: SalesChannelConnection,
    *,
    adapter: provider_sync.PosSalesAdapter | None = None,
    deadline: float | None = None,
) -> JsonObject:
    """Persist one connected provider account's complete product catalog.

    Fetching happens before the transaction.  An adapter returns only after a
    complete successful walk, which makes the following account-scoped stale
    deactivation safe.  A disconnected/replaced account cannot be touched:
    lock and re-check its identity before writing.
    """
    adapter = adapter or provider_sync.get_pos_sales_adapter(connection)
    catalog_items = adapter.product_catalog_items(deadline=deadline)
    synced_at = timezone.now()
    seen_keys: set[str] = set()
    with transaction.atomic():
        # Workspace-wide, not just this connection: SKU mirroring reads the
        # committed snapshots under this same lock, so a save cannot approve a
        # mirror against a snapshot mid-replacement.
        lock_workspace(connection.user)
        locked = SalesChannelConnection.objects.select_for_update().get(
            pk=connection.pk,
            user=connection.user,
            provider=connection.provider,
            provider_account_id=connection.provider_account_id,
            generation=connection.generation,
            status=SalesChannelConnection.Status.ACTIVE,
        )
        for raw_item in catalog_items:
            external_object_id = clean_text(raw_item.get("external_object_id"), 192)
            if not external_object_id:
                # A catalog record without the provider's stable variation id
                # cannot collapse with sales and must never become linkable.
                continue
            match_key = item_object_match_key(connection.provider, external_object_id)
            if match_key in seen_keys:
                # Provider IDs are expected unique.  Retaining first-seen data
                # gives a deterministic safe result if a malformed response
                # repeats a variation without permitting a double write.
                continue
            seen_keys.add(match_key)
            SalesCatalogItem.objects.update_or_create(
                user=connection.user,
                channel=connection.provider,
                provider_account_id=connection.provider_account_id,
                match_key=match_key,
                defaults={
                    "external_object_id": external_object_id,
                    "sku": clean_text(raw_item.get("sku"), 120),
                    "item_name": clean_text(raw_item.get("item_name"), 240)
                    or "Unnamed item",
                    "external_variant_title": clean_text(
                        raw_item.get("variant_name"), 200
                    ),
                    "category": clean_text(raw_item.get("category"), 120),
                    "is_active": raw_item.get("is_active") is True,
                    "last_seen_at": synced_at,
                },
            )
        stale = SalesCatalogItem.objects.filter(
            user=connection.user,
            channel=connection.provider,
            provider_account_id=connection.provider_account_id,
            is_active=True,
        )
        if seen_keys:
            stale = stale.exclude(match_key__in=seen_keys)
        stale.update(is_active=False)
        locked.product_catalog_synced_at = synced_at
        locked.save(
            update_fields=["product_catalog_synced_at", "updated_at"]
        )
        if auto_match_enabled(connection.user):
            mirror_pending(connection.user)
    # Outside the write transaction: a rule covers whatever the catalog now
    # holds, and sweeping inside would grow this transaction by a full scan.
    rule_ignored = sweep_ignore_rules(
        connection.user, channels={connection.provider}
    )
    return {
        "itemCount": len(seen_keys),
        "syncedAt": synced_at.isoformat(),
        "ruleIgnoredIdentities": len(rule_ignored),
    }


def sync_square_modifier_catalog(
    connection: SalesChannelConnection,
    *,
    adapter: provider_sync.SquareSalesAdapter | None = None,
    deadline: float | None = None,
) -> JsonObject:
    """Persist the connected Square account's modifier lists and options."""

    adapter = adapter or provider_sync.SquareSalesAdapter(connection)
    catalog_lists = adapter.modifier_lists(deadline=deadline)

    synced_at = timezone.now()
    list_ids: set[str] = set()
    option_count = 0
    with transaction.atomic():
        lock_workspace(connection.user)
        locked = SalesChannelConnection.objects.select_for_update().get(
            pk=connection.pk,
            user=connection.user,
            provider=connection.provider,
            provider_account_id=connection.provider_account_id,
            generation=connection.generation,
            status=SalesChannelConnection.Status.ACTIVE,
        )
        for raw_list in catalog_lists:
            external_id = raw_list["external_object_id"]
            list_ids.add(external_id)
            modifier_list, _ = SalesModifierList.objects.update_or_create(
                user=connection.user,
                channel=SalesImport.Channel.SQUARE,
                provider_account_id=connection.provider_account_id,
                external_object_id=external_id,
                defaults={
                    "name": raw_list["name"],
                    "modifier_type": raw_list["modifier_type"],
                    "selection_type": raw_list["selection_type"],
                    "ordinal": raw_list["ordinal"],
                    "allow_quantities": raw_list["allow_quantities"],
                    "min_selected": raw_list["min_selected"],
                    "max_selected": raw_list["max_selected"],
                    "is_active": True,
                    "last_synced_at": synced_at,
                },
            )
            option_ids: set[str] = set()
            for raw_option in raw_list["options"]:
                option_ids.add(raw_option["external_object_id"])
                SalesModifierOption.objects.update_or_create(
                    modifier_list=modifier_list,
                    external_object_id=raw_option["external_object_id"],
                    defaults={
                        "name": raw_option["name"] or "Unnamed modifier",
                        "ordinal": raw_option["ordinal"],
                        "price_cents": raw_option["price_cents"],
                        "currency_code": raw_option["currency_code"],
                        "is_active": True,
                    },
                )
                option_count += 1
            stale_options = modifier_list.options.filter(is_active=True)
            if option_ids:
                stale_options = stale_options.exclude(
                    external_object_id__in=option_ids
                )
            stale_options.update(is_active=False)

        stale_lists = SalesModifierList.objects.filter(
            user=connection.user,
            channel=SalesImport.Channel.SQUARE,
            provider_account_id=connection.provider_account_id,
            is_active=True,
        )
        if list_ids:
            stale_lists = stale_lists.exclude(external_object_id__in=list_ids)
        stale_lists.update(is_active=False)
        locked.modifier_catalog_synced_at = synced_at
        locked.last_error = ""
        locked.save(
            update_fields=[
                "modifier_catalog_synced_at",
                "last_error",
                "updated_at",
            ]
        )

    return {
        "listCount": len(catalog_lists),
        "optionCount": option_count,
        "syncedAt": synced_at.isoformat(),
    }


# A single Shopify order may require up to twenty 15-second nested-page calls
# before it is safe to advance the watermark. Recovery must outlive that
# atomic provider operation or a second worker could steal a healthy claim.
JOB_STALE_AFTER = timedelta(minutes=15)
JOB_RETRY_DELAYS = (timedelta(seconds=5), timedelta(seconds=30))


class LostSyncRunClaim(RuntimeError):
    pass


class PermanentSyncRunFailure(RuntimeError):
    pass


def sync_run_json(run: SyncRun) -> JsonObject:
    return {
        "id": str(run.id),
        "provider": run.provider,
        "providerAccountId": run.provider_account_id,
        "connectionGeneration": run.connection_generation,
        "status": run.status,
        "progress": run.progress,
        "cursor": run.cursor,
        "result": run.result,
        "error": run.error,
        "attempts": run.attempts,
        "maxAttempts": run.max_attempts,
        "queuedAt": run.created_at.isoformat(),
        "availableAt": run.available_at.isoformat(),
        "startedAt": run.started_at.isoformat() if run.started_at else None,
        "heartbeatAt": run.heartbeat_at.isoformat() if run.heartbeat_at else None,
        "finishedAt": run.finished_at.isoformat() if run.finished_at else None,
    }


def sync_runs_payload(user: User, *, limit: int = 20) -> JsonObject:
    runs = SyncRun.objects.filter(user=user).order_by("-created_at")[:limit]
    return {"items": [sync_run_json(run) for run in runs]}


def _initial_job_progress() -> JsonObject:
    return {
        "phase": "queued",
        "continuationPasses": 0,
        "partial": False,
        "pagesProcessed": 0,
        "linesFetched": 0,
        "imported": 0,
        "updated": 0,
        "deduplicated": 0,
    }


def _job_cursor(
    connection: SalesChannelConnection, *, continuation_passes: int
) -> JsonObject:
    return {
        "watermark": (
            connection.sync_watermark.isoformat()
            if connection.sync_watermark is not None
            else None
        ),
        "continuationPasses": continuation_passes,
    }


def _enqueue_connection_sync(connection: SalesChannelConnection) -> SyncRun:
    with transaction.atomic():
        lock_workspace(connection.user)
        locked = (
            SalesChannelConnection.objects.select_for_update()
            .filter(
                pk=connection.pk,
                user=connection.user,
                provider=connection.provider,
                provider_account_id=connection.provider_account_id,
                generation=connection.generation,
            )
            .first()
        )
        if locked is None:
            raise ValueError(
                "The provider connection changed before the sync was queued."
            )
        if locked.status != SalesChannelConnection.Status.ACTIVE:
            raise ValueError(
                f"{locked.provider.title()} needs to be reconnected in "
                "Settings first."
            )
        existing = SyncRun.objects.filter(
            connection=locked,
            connection_generation=locked.generation,
            status__in=[SyncRun.Status.QUEUED, SyncRun.Status.RUNNING],
        ).first()
        if existing is not None:
            return existing
        return SyncRun.objects.create(
            user=locked.user,
            connection=locked,
            provider=locked.provider,
            provider_account_id=locked.provider_account_id,
            connection_generation=locked.generation,
            progress=_initial_job_progress(),
            cursor=_job_cursor(locked, continuation_passes=0),
        )


def action_enqueue_pos_sync(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "posSync")
    provider = text_value(body.get("provider"), "Provider", max_length=16)
    connection = SalesChannelConnection.objects.filter(
        user=user, provider=provider
    ).first()
    if connection is None:
        raise ValueError("This channel is not connected")
    return {"syncRun": sync_run_json(_enqueue_connection_sync(connection))}


def _run_id(value: object) -> uuid.UUID:
    raw = text_value(value, "Sync run id", max_length=36)
    try:
        return uuid.UUID(raw)
    except ValueError as exc:
        raise ValueError("Sync run id is invalid") from exc


def action_retry_pos_sync(user: User, body: JsonObject) -> JsonObject:
    require_entitlement(user, "posSync")
    run_id = _run_id(body.get("id"))
    prior = SyncRun.objects.select_related("connection").filter(
        id=run_id, user=user
    ).first()
    if prior is None:
        raise ValueError("Sync run not found")
    if prior.status in (SyncRun.Status.QUEUED, SyncRun.Status.RUNNING):
        return {"syncRun": sync_run_json(prior)}
    if prior.status != SyncRun.Status.FAILED:
        raise ValueError("Only a failed sync can be retried")
    connection = prior.connection
    if (
        connection is None
        or connection.user_id != user.id
        or connection.provider != prior.provider
        or connection.provider_account_id != prior.provider_account_id
        or connection.generation != prior.connection_generation
        or connection.status != SalesChannelConnection.Status.ACTIVE
    ):
        raise ValueError("Reconnect this provider before retrying the sync")
    return {"syncRun": sync_run_json(_enqueue_connection_sync(connection))}


def recover_stale_sync_runs(*, now: datetime | None = None) -> int:
    """Make abandoned worker claims runnable again, with a hard attempt cap."""

    now = now or timezone.now()
    stale_before = now - JOB_STALE_AFTER
    recovered = 0
    candidates = list(
        SyncRun.objects.filter(
            status__in=[SyncRun.Status.QUEUED, SyncRun.Status.RUNNING]
        ).values_list("id", "user_id")
    )
    for run_id, user_id in candidates:
        with transaction.atomic():
            workspace = User.objects.only("id").get(id=user_id)
            lock_workspace(workspace)
            connection = None
            connection_id = SyncRun.objects.filter(id=run_id).values_list(
                "connection_id", flat=True
            ).first()
            if connection_id is not None:
                connection = (
                    SalesChannelConnection.objects.select_for_update()
                    .filter(id=connection_id, user_id=user_id)
                    .first()
                )
            run = SyncRun.objects.select_for_update().filter(id=run_id).first()
            if run is None or run.status not in (
                SyncRun.Status.QUEUED,
                SyncRun.Status.RUNNING,
            ):
                continue
            current = (
                connection is not None
                and connection.status == SalesChannelConnection.Status.ACTIVE
                and connection.generation == run.connection_generation
                and connection.provider == run.provider
                and connection.provider_account_id == run.provider_account_id
            )
            if not current:
                run.status = SyncRun.Status.CANCELLED
                run.claim_token = None
                run.heartbeat_at = None
                run.finished_at = now
                run.error = ""
                run.progress = {**run.progress, "phase": "cancelled"}
                run.checkpoint = {}
            elif run.status != SyncRun.Status.RUNNING or (
                run.heartbeat_at is not None
                and run.heartbeat_at >= stale_before
            ):
                continue
            else:
                run.claim_token = None
                run.heartbeat_at = None
                if run.attempts >= run.max_attempts and not run.checkpoint:
                    run.status = SyncRun.Status.FAILED
                    run.finished_at = now
                    run.error = (
                        "The sync worker stopped before completing this run."
                    )
                    run.progress = {**run.progress, "phase": "failed"}
                else:
                    run.status = SyncRun.Status.QUEUED
                    run.available_at = now
                    run.error = (
                        "The prior worker stopped; the sync was safely requeued."
                    )
                    run.progress = {**run.progress, "phase": "queued"}
                    recovered += 1
            run.save(
                update_fields=[
                    "status",
                    "claim_token",
                    "heartbeat_at",
                    "available_at",
                    "finished_at",
                    "error",
                    "progress",
                    "checkpoint",
                    "updated_at",
                ]
            )
    return recovered


def claim_next_sync_run(*, now: datetime | None = None) -> tuple[SyncRun, uuid.UUID] | None:
    """Atomically lease the oldest runnable job to one worker."""

    now = now or timezone.now()
    recover_stale_sync_runs(now=now)
    with transaction.atomic():
        candidates = (
            SyncRun.objects.filter(
                Q(attempts__lt=F("max_attempts"))
                | ~Q(checkpoint={})
                | Q(progress__partial=True, error=""),
                status=SyncRun.Status.QUEUED,
                available_at__lte=now,
                connection__isnull=False,
                connection__status=SalesChannelConnection.Status.ACTIVE,
                connection__generation=F("connection_generation"),
                connection__provider=F("provider"),
                connection__provider_account_id=F("provider_account_id"),
            )
            .select_related("connection")
            .order_by("available_at", "created_at")
        )
        if db_connection.features.has_select_for_update_skip_locked:
            candidates = candidates.select_for_update(skip_locked=True)
        else:
            candidates = candidates.select_for_update()
        run = candidates.first()
        if run is None:
            return None
        claim_token = uuid.uuid4()
        run.status = SyncRun.Status.RUNNING
        run.claim_token = claim_token
        normal_continuation = (
            not run.checkpoint
            and bool(run.progress.get("partial"))
            and not run.error
        )
        if not run.checkpoint and not normal_continuation:
            run.attempts += 1
        run.started_at = run.started_at or now
        run.heartbeat_at = now
        run.finished_at = None
        run.error = ""
        run.progress = {**run.progress, "phase": "running"}
        run.save(
            update_fields=[
                "status",
                "claim_token",
                "attempts",
                "started_at",
                "heartbeat_at",
                "finished_at",
                "error",
                "progress",
                "updated_at",
            ]
        )
        return run, claim_token


_RECEIPT_ADD_FIELDS = (
    "imported",
    "updated",
    "deduplicated",
    "trackedLines",
    "pendingLines",
    "ignoredLines",
    "skippedMalformed",
    "modifierOccurrences",
    "modifierOccurrencesAttached",
    "modifierOccurrencesPending",
    "skippedModifiersMalformed",
    "warnings",
    "pagesProcessed",
    "linesFetched",
    "categoriesBackfilled",
)


def _merge_job_receipt(previous: JsonObject, current: JsonObject) -> JsonObject:
    merged: JsonObject = {**previous, **current}
    for field in _RECEIPT_ADD_FIELDS:
        merged[field] = int(previous.get(field) or 0) + int(
            current.get(field) or 0
        )
    batch_ids = list(previous.get("batchIds") or [])
    batch_id = current.get("batchId")
    if batch_id and batch_id not in batch_ids:
        batch_ids.append(batch_id)
    merged["batchIds"] = batch_ids
    merged["batchId"] = batch_id or previous.get("batchId")
    starts = [
        value
        for value in (previous.get("periodStart"), current.get("periodStart"))
        if value
    ]
    ends = [
        value
        for value in (previous.get("periodEnd"), current.get("periodEnd"))
        if value
    ]
    merged["periodStart"] = min(starts) if starts else None
    merged["periodEnd"] = max(ends) if ends else None
    return merged


def _finish_run(
    run: SyncRun,
    claim_token: uuid.UUID,
    *,
    status: str,
    error: str = "",
) -> None:
    now = timezone.now()
    progress = {**run.progress, "phase": status}
    updated = SyncRun.objects.filter(
        id=run.id,
        status=SyncRun.Status.RUNNING,
        claim_token=claim_token,
    ).update(
        status=status,
        claim_token=None,
        heartbeat_at=None,
        finished_at=now,
        error=error[:1000],
        progress=progress,
        checkpoint={},
        updated_at=now,
    )
    if updated != 1:
        raise LostSyncRunClaim
    run.status = status
    run.progress = progress
    run.checkpoint = {}


def _retry_or_fail_run(
    run: SyncRun,
    claim_token: uuid.UUID,
    *,
    message: str,
    permanent: bool = False,
) -> None:
    # A committed pass is never discarded because the worker died during the
    # idempotent ignore-rule finalization. Requeue its checkpoint even when
    # the provider-attempt budget is exhausted.
    if run.checkpoint:
        permanent = False
    if permanent or (run.attempts >= run.max_attempts and not run.checkpoint):
        _finish_run(
            run,
            claim_token,
            status=SyncRun.Status.FAILED,
            error=message,
        )
        return
    now = timezone.now()
    delay_index = min(run.attempts - 1, len(JOB_RETRY_DELAYS) - 1)
    available_at = now + JOB_RETRY_DELAYS[delay_index]
    progress = {**run.progress, "phase": "queued"}
    updated = SyncRun.objects.filter(
        id=run.id,
        status=SyncRun.Status.RUNNING,
        claim_token=claim_token,
    ).update(
        status=SyncRun.Status.QUEUED,
        claim_token=None,
        heartbeat_at=None,
        available_at=available_at,
        error=message[:1000],
        progress=progress,
        updated_at=now,
    )
    if updated != 1:
        raise LostSyncRunClaim


def _finalize_sync_checkpoint(
    run: SyncRun, claim_token: uuid.UUID
) -> bool:
    """Finalize the idempotent ignore sweep; return whether another pass remains."""

    checkpoint = dict(run.checkpoint or {})
    if not checkpoint:
        raise LostSyncRunClaim
    sweep_ignore_rules(run.user, channels={run.provider})
    with transaction.atomic():
        lock_workspace(run.user)
        connection = (
            SalesChannelConnection.objects.select_for_update()
            .filter(
                id=run.connection_id,
                user_id=run.user_id,
                provider=run.provider,
                provider_account_id=run.provider_account_id,
                generation=run.connection_generation,
                status=SalesChannelConnection.Status.ACTIVE,
            )
            .first()
        )
        if connection is None:
            raise LostSyncRunClaim
        locked = (
            SyncRun.objects.select_for_update()
            .filter(
                id=run.id,
                connection=connection,
                connection_generation=connection.generation,
                status=SyncRun.Status.RUNNING,
                claim_token=claim_token,
            )
            .first()
        )
        if locked is None or locked.checkpoint != checkpoint:
            raise LostSyncRunClaim
        ignored = ignore_key_set(run.user)
        receipt = dict(checkpoint.get("receipt") or {})
        rule_ignored_count = 0
        for raw_scope in checkpoint.get("pendingScopes") or []:
            scope = identity_scope_key(
                raw_scope.get("channel", ""),
                raw_scope.get("providerAccountId", ""),
                raw_scope.get("matchKey", ""),
            )
            if scope not in ignored:
                continue
            rule_ignored_count += 1
            receipt["pendingLines"] -= int(raw_scope.get("lineCount") or 0)
            receipt["ignoredLines"] += int(raw_scope.get("lineCount") or 0)
            receipt["pendingIdentities"] -= 1
            receipt["ignoredIdentities"] += 1
        receipt["ruleIgnoredIdentities"] = rule_ignored_count

        aggregate = _merge_job_receipt(
            dict((locked.result or {}).get("receipt") or {}), receipt
        )
        partial = bool(checkpoint.get("partial"))
        now = timezone.now()
        locked.result = {"receipt": aggregate}
        locked.checkpoint = {}
        locked.progress = {
            **locked.progress,
            "phase": "queued" if partial else "succeeded",
            "partial": partial,
        }
        if partial:
            locked.status = SyncRun.Status.QUEUED
            locked.claim_token = None
            locked.heartbeat_at = None
            locked.available_at = now
            locked.error = ""
        else:
            locked.status = SyncRun.Status.SUCCEEDED
            locked.claim_token = None
            locked.heartbeat_at = None
            locked.finished_at = now
            locked.error = ""
        locked.save(
            update_fields=[
                "status",
                "claim_token",
                "heartbeat_at",
                "available_at",
                "finished_at",
                "error",
                "progress",
                "result",
                "checkpoint",
                "updated_at",
            ]
        )
        run.status = locked.status
        run.claim_token = locked.claim_token
        run.heartbeat_at = locked.heartbeat_at
        run.available_at = locked.available_at
        run.finished_at = locked.finished_at
        run.error = locked.error
        run.progress = locked.progress
        run.result = locked.result
        run.checkpoint = {}
        return partial


def execute_claimed_sync_run(
    run: SyncRun,
    claim_token: uuid.UUID,
    *,
    time_budget_s: int = TIME_BUDGET_S,
) -> None:
    """Execute one user intent through bounded passes until it is complete.

    A lost claim is normal, not exceptional: stale recovery may requeue this
    run mid-flight, and the failure bookkeeping below can discover that only
    when its own guarded write matches no row. Absorbing it here keeps one
    superseded attempt from killing the worker loop.
    """

    try:
        _execute_claimed_sync_run(
            run,
            claim_token,
            time_budget_s=time_budget_s,
        )
    except LostSyncRunClaim:
        logger.warning("POS sync run %s lost its worker claim", run.id)


def _execute_claimed_sync_run(
    run: SyncRun,
    claim_token: uuid.UUID,
    *,
    time_budget_s: int,
) -> None:
    try:
        connection = SalesChannelConnection.objects.filter(
            id=run.connection_id,
            user_id=run.user_id,
            provider=run.provider,
            provider_account_id=run.provider_account_id,
            generation=run.connection_generation,
        ).first()
        if connection is None:
            raise PermanentSyncRunFailure(
                "The provider connection changed before this sync could run."
            )
        if connection.status != SalesChannelConnection.Status.ACTIVE:
            raise PermanentSyncRunFailure(
                f"{run.provider.title()} needs to be reconnected in Settings."
            )

        if run.checkpoint:
            if not _finalize_sync_checkpoint(run, claim_token):
                _decorate_completed_sync(connection)
            return
        pass_count = int(run.progress.get("continuationPasses") or 0) + 1
        sync_connection(
            connection,
            time_budget_s=time_budget_s,
            include_modifier_catalog=False,
            run=run,
            claim_token=claim_token,
            pass_count=pass_count,
        )
        if not _finalize_sync_checkpoint(run, claim_token):
            _decorate_completed_sync(connection)
    except LostSyncRunClaim:
        raise
    except PermanentSyncRunFailure as exc:
        _retry_or_fail_run(
            run, claim_token, message=str(exc), permanent=True
        )
    except SyncFailed as exc:
        connection_is_current = SalesChannelConnection.objects.filter(
            id=run.connection_id,
            user_id=run.user_id,
            provider=run.provider,
            provider_account_id=run.provider_account_id,
            generation=run.connection_generation,
            status=SalesChannelConnection.Status.ACTIVE,
        ).exists()
        _retry_or_fail_run(
            run,
            claim_token,
            message=str(exc),
            permanent=not connection_is_current,
        )
    except Exception:
        logger.exception("Unexpected POS sync worker failure for run %s", run.id)
        _retry_or_fail_run(
            run,
            claim_token,
            message="The sync worker encountered an unexpected error.",
        )


def process_next_sync_run() -> bool:
    claimed = claim_next_sync_run()
    if claimed is None:
        return False
    run, claim_token = claimed
    execute_claimed_sync_run(run, claim_token)
    return True


def _decorate_completed_sync(connection: SalesChannelConnection) -> None:
    """Best-effort catalog decoration after the financial run is terminal."""

    try:
        decoration_lease = _claim_sync_lease(connection)
    except SyncFailed:
        # Another requested sync owns the provider now. Its terminal
        # decoration will cover this best-effort metadata after it finishes.
        return
    try:
        adapter = provider_sync.get_pos_sales_adapter(connection)
        if connection.provider == SalesImport.Channel.SQUARE:
            try:
                sync_square_modifier_catalog(connection, adapter=adapter)
            except Exception:
                logger.warning(
                    "%s modifier catalog decoration failed for connection %s",
                    connection.provider,
                    connection.pk,
                    exc_info=True,
                )
        try:
            sync_product_catalog(connection, adapter=adapter)
        except Exception:
            logger.warning(
                "%s product catalog decoration failed for connection %s",
                connection.provider,
                connection.pk,
                exc_info=True,
            )
        try:
            _backfill_categories(connection, adapter)
        except Exception:
            logger.warning(
                "%s category decoration failed for connection %s",
                connection.provider,
                connection.pk,
                exc_info=True,
            )
    finally:
        _release_sync_lease(connection, decoration_lease)


# Sales-domain actions. Provider connection actions remain in the integration
# registry; dispatch composes both without either layer importing upward.
ACTIONS: dict[str, Callable[[User, JsonObject], JsonObject]] = {
    "enqueue-pos-sync": action_enqueue_pos_sync,
    "retry-pos-sync": action_retry_pos_sync,
}
