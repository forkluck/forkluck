"""Refresh every persisted billing account from complete Stripe snapshots."""

from collections import Counter
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from forkluck.domains.accounts.billing_reconciliation import (
    BillingIdentityConflict,
    assert_customer_not_retired,
    get_billing_account,
    reconcile_billing_account,
)
from forkluck.integrations import stripe
from forkluck.integrations.stripe import StripeError
from forkluck.models import (
    BillingAccount,
    StripeBillingConfiguration,
    StripeCustomer,
    StripeRetiredCustomer,
    User,
)


class Command(BaseCommand):
    help = "Reconcile known billing accounts and safely inventory provider orphans."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--inventory-provider",
            action="store_true",
            help="Inventory all Forkluck-tagged Stripe customers before reconciling.",
        )
        parser.add_argument(
            "--tombstone-orphans",
            action="store_true",
            help=(
                "Record tagged customers with no current user as retired, but only "
                "when they have no provider subscriptions."
            ),
        )
        parser.add_argument(
            "--fail-on-orphans",
            action="store_true",
            help="Exit non-zero when an unresolved tagged provider customer remains.",
        )
        parser.add_argument(
            "--adopt-customer",
            metavar="CUSTOMER_ID",
            help="Explicitly bind one unbound provider customer after inventory review.",
        )
        parser.add_argument(
            "--adopt-user",
            metavar="USER_ID",
            help="The current Forkluck user confirmed to own --adopt-customer.",
        )

    def handle(self, *args, **options) -> None:
        adopt_customer = str(options["adopt_customer"] or "")
        adopt_user = str(options["adopt_user"] or "")
        if bool(adopt_customer) != bool(adopt_user):
            raise CommandError(
                "--adopt-customer and --adopt-user must be supplied together."
            )
        if adopt_customer:
            self._adopt_customer(adopt_customer, adopt_user)
        inventory = bool(
            options["inventory_provider"]
            or options["tombstone_orphans"]
            or options["fail_on_orphans"]
        )
        provider_counts: Counter = Counter()
        provider_by_user: dict[UUID, list[dict]] = {}
        orphan_customers: list[dict] = []
        unresolved_orphans = 0
        tagged_count = 0
        if inventory:
            try:
                customers = stripe.list_customers()
            except StripeError as exc:
                raise CommandError("Stripe customer inventory failed.") from exc
            retired_ids = set(
                StripeRetiredCustomer.objects.filter(
                    pk__in={str(customer.get("id") or "") for customer in customers}
                ).values_list("pk", flat=True)
            )
            for customer in customers:
                metadata = customer.get("metadata") or {}
                raw_user_id = str(metadata.get("forkluck_user_id") or "")
                if not raw_user_id:
                    continue
                tagged_count += 1
                if str(customer.get("id") or "") in retired_ids:
                    continue
                try:
                    user_id = UUID(raw_user_id)
                except ValueError:
                    orphan_customers.append(customer)
                    continue
                provider_counts[user_id] += 1
                provider_by_user.setdefault(user_id, []).append(customer)

            existing_user_ids = set(
                User.objects.filter(pk__in=provider_by_user).values_list("pk", flat=True)
            )
            for user_id in set(provider_by_user).difference(existing_user_ids):
                orphan_customers.extend(provider_by_user[user_id])
            for user in User.objects.filter(pk__in=existing_user_ids):
                get_billing_account(user)

            unresolved_orphans = len(orphan_customers)
            if options["tombstone_orphans"] and orphan_customers:
                tombstones = self._safe_orphan_tombstones(orphan_customers)
                with transaction.atomic():
                    StripeRetiredCustomer.objects.bulk_create(
                        tombstones,
                        ignore_conflicts=True,
                    )
                unresolved_orphans = 0

        accounts = list(
            BillingAccount.objects.select_related("user").order_by("user_id")
        )
        counts: dict[str, int] = {}
        try:
            for account in accounts:
                if not reconcile_billing_account(account):
                    raise CommandError(
                        "A concurrent billing refresh superseded the inventory pass; rerun it."
                    )
                account.refresh_from_db(fields=["status"])
                counts[account.status] = counts.get(account.status, 0) + 1
        except (StripeError, BillingIdentityConflict) as exc:
            raise CommandError(
                "Stripe billing reconciliation failed; no stale snapshot was committed."
            ) from exc
        summary = ", ".join(f"{key}={counts[key]}" for key in sorted(counts))
        duplicate_users = sum(count > 1 for count in provider_counts.values())
        provider_summary = ""
        if inventory:
            provider_summary = (
                f" Provider inventory: tagged_customers={tagged_count},"
                f" duplicate_users={duplicate_users},"
                f" unresolved_orphans={unresolved_orphans}."
            )
        self.stdout.write(
            self.style.SUCCESS(
                f"Reconciled {len(accounts)} billing account(s)"
                + (f": {summary}." if summary else ".")
                + provider_summary
            )
        )
        if options["fail_on_orphans"] and unresolved_orphans:
            raise CommandError(
                "Provider inventory contains Forkluck-tagged customers without a current user."
            )

    def _adopt_customer(self, customer_id: str, raw_user_id: str) -> None:
        try:
            user_id = UUID(raw_user_id)
            user = User.objects.get(pk=user_id)
        except (ValueError, User.DoesNotExist) as exc:
            raise CommandError("The adoption user does not exist.") from exc
        if StripeCustomer.objects.filter(stripe_customer_id=customer_id).exists():
            raise CommandError("The provider customer already has a local owner.")
        try:
            assert_customer_not_retired(customer_id)
            provider = stripe.retrieve_customer(customer_id)
        except (StripeError, BillingIdentityConflict) as exc:
            raise CommandError("The provider customer cannot be adopted.") from exc
        metadata = provider.get("metadata") or {}
        if (
            str(provider.get("id") or "") != customer_id
            or str(metadata.get("forkluck_user_id") or "") != str(user_id)
        ):
            raise CommandError(
                "The provider customer metadata does not match the confirmed user."
            )
        expected_livemode = StripeBillingConfiguration.objects.filter(pk=1).values_list(
            "livemode", flat=True
        ).first()
        if expected_livemode is None:
            raise CommandError(
                "Validate Stripe billing configuration before adopting a customer."
            )
        if bool(provider.get("livemode")) != expected_livemode:
            raise CommandError(
                "The provider customer mode does not match billing configuration."
            )
        try:
            if stripe.list_open_checkout_sessions(customer_id):
                raise CommandError(
                    "Expire the provider customer's open Checkout sessions before adoption."
                )
        except StripeError as exc:
            raise CommandError(
                "The provider customer's Checkout sessions could not be verified."
            ) from exc
        account = get_billing_account(user)
        with transaction.atomic():
            account = BillingAccount.objects.select_for_update().get(pk=account.pk)
            if StripeCustomer.objects.filter(
                stripe_customer_id=customer_id
            ).exists():
                raise CommandError("The provider customer already has a local owner.")
            StripeCustomer.objects.create(
                account=account,
                stripe_customer_id=customer_id,
                creation_idempotency_key=(
                    f"forkluck.customer.operator-adopted.{customer_id}"
                ),
                is_primary=not account.stripe_customers.filter(
                    is_primary=True
                ).exists(),
                livemode=bool(provider.get("livemode")),
            )

    def _safe_orphan_tombstones(
        self, customers: list[dict]
    ) -> list[StripeRetiredCustomer]:
        tombstones: list[StripeRetiredCustomer] = []
        try:
            for customer in customers:
                customer_id = str(customer.get("id") or "")
                if not customer_id:
                    raise CommandError("Stripe returned an orphan customer without an id.")
                if StripeCustomer.objects.filter(
                    stripe_customer_id=customer_id
                ).exists():
                    raise CommandError(
                        "A provider orphan is still attached to a local billing account."
                    )
                if stripe.list_subscriptions(customer_id):
                    raise CommandError(
                        "A provider orphan still has subscription history; resolve it manually."
                    )
                if stripe.list_open_checkout_sessions(customer_id):
                    raise CommandError(
                        "A provider orphan still has an open Checkout session; "
                        "expire it before tombstoning."
                    )
                tombstones.append(
                    StripeRetiredCustomer(
                        stripe_customer_id=customer_id,
                        livemode=bool(customer.get("livemode")),
                    )
                )
        except StripeError as exc:
            raise CommandError("Stripe orphan verification failed.") from exc
        return tombstones
