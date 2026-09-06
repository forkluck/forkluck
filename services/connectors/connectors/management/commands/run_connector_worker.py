import time

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import close_old_connections
from django.utils import timezone

from connectors.models import ConnectorRun
from connectors.worker import execute, fail_stale_runs

GAP_SLICE_SECONDS = 0.5


def provider_gap_remaining(provider_key):
    """Seconds still owed before this provider's site may be visited again."""
    gap = settings.CONNECTORS_PROVIDER_RUN_GAP_SECONDS
    if gap <= 0:
        return 0.0
    # A terminal run's heartbeat is stamped when the worker finished it, so it is
    # the last moment this provider was reached; no extra column is needed.
    finished_at = (
        ConnectorRun.objects.filter(
            connection__provider_key=provider_key,
            status__in=[ConnectorRun.Status.SUCCEEDED, ConnectorRun.Status.FAILED],
            heartbeat_at__isnull=False,
        )
        .order_by("-heartbeat_at")
        .values_list("heartbeat_at", flat=True)
        .first()
    )
    if finished_at is None:
        return 0.0
    return max(0.0, gap - (timezone.now() - finished_at).total_seconds())


class Command(BaseCommand):
    help = "Claim queued private connector runs and fetch supplier documents."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--poll-seconds", type=float, default=2.0)

    def handle(self, *args, **options):
        while True:
            close_old_connections()
            fail_stale_runs()
            run = (
                ConnectorRun.objects.select_related("connection")
                .filter(status=ConnectorRun.Status.QUEUED)
                .order_by("created_at")
                .first()
            )
            if run:
                remaining = provider_gap_remaining(run.connection.provider_key)
                if remaining > 0:
                    # Ten kitchens pressing Sync at once must not hit the supplier
                    # back to back. Sleep in slices so a shutdown signal lands
                    # promptly, then start the loop over to re-check stale runs.
                    while remaining > 0:
                        slice_seconds = min(remaining, GAP_SLICE_SECONDS)
                        time.sleep(slice_seconds)
                        remaining -= slice_seconds
                    continue
                execute(run.id)
            elif options["once"]:
                return
            else:
                time.sleep(options["poll_seconds"])
