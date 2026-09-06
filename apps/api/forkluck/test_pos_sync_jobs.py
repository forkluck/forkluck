import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.test import Client
from django.utils import timezone

from .domains.sales.pos_sync import (
    SyncFailed,
    _decorate_completed_sync,
    claim_next_sync_run,
    execute_claimed_sync_run,
    recover_stale_sync_runs,
)
from .models import SalesChannelConnection, SyncRun, User
from .testing import InternalApiTestCase


class PosSyncJobTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="jobs@example.com",
            name="Job Tester",
            password="a-long-test-passphrase-2468",
        )
        self.other_user = User.objects.create_user(
            email="other-jobs@example.com",
            name="Other Job Tester",
            password="a-long-test-passphrase-1357",
        )
        self.connection = SalesChannelConnection.objects.create(
            user=self.user,
            provider="square",
            provider_account_id="MERCHANT_1",
            access_token_encrypted="unused-in-job-tests",
            merchant_id="MERCHANT_1",
            location_ids=["LOCATION_1"],
            provider_timezone="UTC",
            currency_code="USD",
        )
        self.client = Client()
        self.client.force_login(self.user)

    def action(self, name: str, body: dict, *, client: Client | None = None):
        return (client or self.client).post(
            f"/internal/v1/actions/{name}/",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_X_FORKLUCK_INTERNAL_SECRET=settings.FORKLUCK_INTERNAL_SECRET,
        )

    def enqueue(self) -> SyncRun:
        response = self.action("enqueue-pos-sync", {"provider": "square"})
        self.assertEqual(response.status_code, 200)
        return SyncRun.objects.get(id=response.json()["syncRun"]["id"])

    def test_enqueue_is_durable_and_idempotent_while_active(self) -> None:
        first = self.action("enqueue-pos-sync", {"provider": "square"})
        second = self.action("enqueue-pos-sync", {"provider": "square"})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(
            first.json()["syncRun"]["id"], second.json()["syncRun"]["id"]
        )
        run = SyncRun.objects.get()
        self.assertEqual(run.user, self.user)
        self.assertEqual(run.connection, self.connection)
        self.assertEqual(run.connection_generation, self.connection.generation)
        self.assertEqual(run.provider_account_id, "MERCHANT_1")
        self.assertEqual(run.status, SyncRun.Status.QUEUED)
        self.assertEqual(run.attempts, 0)
        self.assertEqual(
            first.json()["syncRun"]["cursor"],
            {"watermark": None, "continuationPasses": 0},
        )

    def test_terminal_catalog_decoration_owns_a_provider_lease(self) -> None:
        observed_tokens = []

        def observe_lease(*args, **kwargs):
            stored = SalesChannelConnection.objects.get(pk=self.connection.pk)
            observed_tokens.append(stored.sync_lease_token)
            return {}

        adapter = object()
        with (
            patch(
                "forkluck.domains.sales.pos_sync.provider_sync.get_pos_sales_adapter",
                return_value=adapter,
            ),
            patch(
                "forkluck.domains.sales.pos_sync.sync_square_modifier_catalog",
                side_effect=observe_lease,
            ),
            patch(
                "forkluck.domains.sales.pos_sync.sync_product_catalog",
                side_effect=observe_lease,
            ),
            patch(
                "forkluck.domains.sales.pos_sync._backfill_categories",
                side_effect=observe_lease,
            ),
        ):
            _decorate_completed_sync(self.connection)

        self.assertEqual(len(observed_tokens), 3)
        self.assertTrue(all(token is not None for token in observed_tokens))
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_lease_token)

    def test_list_detail_and_retry_are_tenant_scoped(self) -> None:
        run = self.enqueue()
        run.status = SyncRun.Status.FAILED
        run.finished_at = timezone.now()
        run.error = "synthetic failure"
        run.save(update_fields=["status", "finished_at", "error", "updated_at"])

        variant = self.get_internal("/internal/v1/pos-sync-runs/")
        detail = self.get_internal(f"/internal/v1/pos-sync-runs/{run.id}/")
        self.assertEqual(variant.status_code, 200)
        self.assertEqual(variant.json()["items"][0]["id"], str(run.id))
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["syncRun"]["error"], "synthetic failure")

        stranger = Client()
        stranger.force_login(self.other_user)
        hidden = self.get_internal(
            f"/internal/v1/pos-sync-runs/{run.id}/", client=stranger
        )
        denied_retry = self.action(
            "retry-pos-sync", {"id": str(run.id)}, client=stranger
        )
        self.assertEqual(hidden.status_code, 404)
        self.assertEqual(denied_retry.status_code, 400)
        self.assertEqual(denied_retry.json(), {"error": "Sync run not found"})

        retried = self.action("retry-pos-sync", {"id": str(run.id)})
        self.assertEqual(retried.status_code, 200)
        self.assertNotEqual(retried.json()["syncRun"]["id"], str(run.id))

    def test_claim_is_atomic_and_bumps_the_bounded_attempt_count(self) -> None:
        run = self.enqueue()
        claimed = claim_next_sync_run()
        self.assertIsNotNone(claimed)
        claimed_run, token = claimed
        self.assertEqual(claimed_run.id, run.id)
        self.assertEqual(claimed_run.status, SyncRun.Status.RUNNING)
        self.assertEqual(claimed_run.attempts, 1)
        self.assertEqual(claimed_run.claim_token, token)
        self.assertIsNone(claim_next_sync_run())

    def test_losing_the_claim_while_failing_does_not_kill_the_worker(
        self,
    ) -> None:
        """Stale recovery can requeue a run while its worker is still failing.

        The worker's own failure bookkeeping then matches no row. That must
        end the attempt quietly instead of escalating out of the queue loop.
        """
        run = self.enqueue()
        claimed = claim_next_sync_run()
        self.assertIsNotNone(claimed)
        claimed_run, token = claimed

        def requeue_then_fail(*args, **kwargs):
            SyncRun.objects.filter(id=claimed_run.id).update(
                status=SyncRun.Status.QUEUED, claim_token=None
            )
            raise SyncFailed("provider rejected the request")

        with patch(
            "forkluck.domains.sales.pos_sync.sync_connection",
            side_effect=requeue_then_fail,
        ):
            execute_claimed_sync_run(claimed_run, token)

        superseded = SyncRun.objects.get(id=run.id)
        self.assertEqual(superseded.status, SyncRun.Status.QUEUED)
        self.assertIsNone(superseded.claim_token)

    def test_stale_claim_is_requeued_or_failed_at_attempt_cap(self) -> None:
        stale_at = timezone.now() - timedelta(minutes=20)
        recoverable = self.enqueue()
        recoverable.status = SyncRun.Status.RUNNING
        recoverable.attempts = 1
        recoverable.claim_token = uuid.uuid4()
        recoverable.heartbeat_at = stale_at
        recoverable.save()

        recovered = recover_stale_sync_runs()
        self.assertEqual(recovered, 1)
        recoverable.refresh_from_db()
        self.assertEqual(recoverable.status, SyncRun.Status.QUEUED)
        self.assertIsNone(recoverable.claim_token)

        recoverable.status = SyncRun.Status.FAILED
        recoverable.finished_at = timezone.now()
        recoverable.save()
        exhausted = SyncRun.objects.create(
            user=self.user,
            connection=self.connection,
            provider="square",
            provider_account_id="MERCHANT_1",
            status=SyncRun.Status.RUNNING,
            attempts=3,
            max_attempts=3,
            claim_token=uuid.uuid4(),
            heartbeat_at=stale_at,
        )
        self.assertEqual(recover_stale_sync_runs(), 0)
        exhausted.refresh_from_db()
        self.assertEqual(exhausted.status, SyncRun.Status.FAILED)
        self.assertIsNotNone(exhausted.finished_at)

    def test_committed_checkpoint_recovers_even_at_attempt_cap(self) -> None:
        run = self.enqueue()
        stale_at = timezone.now() - timedelta(minutes=20)
        run.status = SyncRun.Status.RUNNING
        run.attempts = run.max_attempts
        run.claim_token = uuid.uuid4()
        run.heartbeat_at = stale_at
        run.checkpoint = {
            "receipt": {"provider": "square", "partial": False},
            "pendingScopes": [],
            "partial": False,
            "passCount": 1,
        }
        run.save()

        self.assertEqual(recover_stale_sync_runs(), 1)
        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.QUEUED)
        claimed, _ = claim_next_sync_run()
        self.assertEqual(claimed.id, run.id)
        self.assertEqual(claimed.attempts, claimed.max_attempts)

    def test_orphaned_active_run_is_cancelled_on_recovery(self) -> None:
        run = self.enqueue()
        SalesChannelConnection.objects.filter(id=self.connection.id).delete()
        self.assertEqual(recover_stale_sync_runs(), 0)
        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.CANCELLED)
        self.assertIsNone(run.connection_id)

    def test_worker_continues_partial_passes_and_aggregates_receipts(self) -> None:
        run = self.enqueue()
        claimed_run, token = claim_next_sync_run()
        receipts = [
            {
                "provider": "square",
                "batchId": str(uuid.uuid4()),
                "imported": 2,
                "updated": 0,
                "deduplicated": 1,
                "pagesProcessed": 12,
                "linesFetched": 3,
                "partial": True,
                "periodStart": "2026-01-01",
                "periodEnd": "2026-01-02",
            },
            {
                "provider": "square",
                "batchId": str(uuid.uuid4()),
                "imported": 1,
                "updated": 1,
                "deduplicated": 2,
                "pagesProcessed": 2,
                "linesFetched": 4,
                "partial": False,
                "periodStart": "2026-01-03",
                "periodEnd": "2026-01-04",
            },
        ]
        def commit_checkpoint(*args, run, pass_count, **kwargs):
            receipt = receipts.pop(0)
            run.checkpoint = {
                "receipt": receipt,
                "pendingScopes": [],
                "partial": receipt["partial"],
                "passCount": pass_count,
            }
            run.progress = {
                **run.progress,
                "phase": "finalizing",
                "continuationPasses": pass_count,
            }
            run.cursor = {
                "watermark": None,
                "continuationPasses": pass_count,
            }
            run.save(update_fields=["checkpoint", "progress", "cursor"])
            return receipt

        with (
            patch(
                "forkluck.domains.sales.pos_sync.sync_connection",
                side_effect=commit_checkpoint,
            ) as sync,
            patch("forkluck.domains.sales.pos_sync._decorate_completed_sync"),
        ):
            execute_claimed_sync_run(claimed_run, token)
            run.refresh_from_db()
            self.assertEqual(run.status, SyncRun.Status.QUEUED)
            self.assertEqual(run.attempts, 1)
            claimed_run, token = claim_next_sync_run()
            self.assertEqual(claimed_run.attempts, 1)
            execute_claimed_sync_run(claimed_run, token)

        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.SUCCEEDED)
        self.assertEqual(run.progress["continuationPasses"], 2)
        self.assertEqual(run.cursor["continuationPasses"], 2)
        self.assertIsNone(run.cursor["watermark"])
        self.assertEqual(run.progress["phase"], "succeeded")
        receipt = run.result["receipt"]
        self.assertEqual(receipt["imported"], 3)
        self.assertEqual(receipt["updated"], 1)
        self.assertEqual(receipt["deduplicated"], 3)
        self.assertEqual(receipt["pagesProcessed"], 14)
        self.assertEqual(receipt["linesFetched"], 7)
        self.assertEqual(receipt["periodStart"], "2026-01-01")
        self.assertEqual(receipt["periodEnd"], "2026-01-04")
        self.assertEqual(len(receipt["batchIds"]), 2)
        self.assertFalse(receipt["partial"])
        self.assertEqual(sync.call_args_list[0].kwargs["pass_count"], 1)
        self.assertEqual(sync.call_args_list[1].kwargs["pass_count"], 2)
        self.assertFalse(
            sync.call_args_list[0].kwargs["include_modifier_catalog"]
        )

    def test_transient_failures_retry_then_stop_at_attempt_cap(self) -> None:
        run = self.enqueue()
        for expected_attempt in range(1, 4):
            run.available_at = timezone.now() - timedelta(seconds=1)
            run.save(update_fields=["available_at", "updated_at"])
            claimed_run, token = claim_next_sync_run()
            with patch(
                "forkluck.domains.sales.pos_sync.sync_connection",
                side_effect=SyncFailed("provider temporarily unavailable"),
            ):
                execute_claimed_sync_run(claimed_run, token)
            run.refresh_from_db()
            self.assertEqual(run.attempts, expected_attempt)
            expected_status = (
                SyncRun.Status.FAILED
                if expected_attempt == run.max_attempts
                else SyncRun.Status.QUEUED
            )
            self.assertEqual(run.status, expected_status)
        self.assertIn("temporarily unavailable", run.error)
        self.assertIsNotNone(run.finished_at)

    def test_disconnect_during_a_claimed_run_is_not_retried(self) -> None:
        run = self.enqueue()
        claimed_run, token = claim_next_sync_run()

        def disconnect_then_fail(*args, **kwargs):
            self.connection.delete()
            raise SyncFailed(
                "The provider connection was disconnected before this sync "
                "could finish."
            )

        with patch(
            "forkluck.domains.sales.pos_sync.sync_connection",
            side_effect=disconnect_then_fail,
        ):
            execute_claimed_sync_run(claimed_run, token)

        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.FAILED)
        self.assertEqual(run.attempts, 1)
        self.assertIsNotNone(run.finished_at)
        self.assertIn("disconnected", run.error)

    def test_worker_refuses_a_replaced_provider_account(self) -> None:
        run = self.enqueue()
        claimed_run, token = claim_next_sync_run()
        self.connection.provider_account_id = "MERCHANT_2"
        self.connection.merchant_id = "MERCHANT_2"
        self.connection.save(
            update_fields=["provider_account_id", "merchant_id", "updated_at"]
        )

        with patch("forkluck.domains.sales.pos_sync.sync_connection") as sync:
            execute_claimed_sync_run(claimed_run, token)

        run.refresh_from_db()
        self.assertEqual(run.status, SyncRun.Status.FAILED)
        self.assertIn("connection changed", run.error)
        sync.assert_not_called()

    def test_worker_command_once_exits_cleanly_with_an_empty_queue(self) -> None:
        # The daemon's close_old_connections would close the test
        # transaction's connection — a no-op on in-memory SQLite, fatal on
        # Postgres, and it poisons every later test in the class.
        with patch(
            "forkluck.management.commands.run_pos_sync_worker.close_old_connections"
        ):
            call_command("run_pos_sync_worker", "--once", verbosity=0)
