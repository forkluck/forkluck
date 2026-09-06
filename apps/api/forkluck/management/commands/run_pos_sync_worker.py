"""Run the durable POS sync queue worker."""

import time

from django.core.management.base import BaseCommand, CommandParser
from django.db import close_old_connections

from ...domains.sales.pos_sync import process_next_sync_run


class Command(BaseCommand):
    help = "Process queued Square and Shopify sales sync runs"

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--once",
            action="store_true",
            help="Process at most one available run, then exit",
        )
        parser.add_argument(
            "--poll-interval",
            type=float,
            default=2.0,
            help="Seconds to wait when the queue is empty (default: 2)",
        )
        parser.add_argument(
            "--max-jobs",
            type=int,
            default=0,
            help="Exit after this many claimed runs (0 means no limit)",
        )

    def handle(self, *args, **options) -> None:
        poll_interval = options["poll_interval"]
        max_jobs = options["max_jobs"]
        if poll_interval < 0.1 or poll_interval > 60:
            raise ValueError("Poll interval must be between 0.1 and 60 seconds")
        if max_jobs < 0:
            raise ValueError("Max jobs cannot be negative")

        processed = 0
        while True:
            close_old_connections()
            claimed = process_next_sync_run()
            close_old_connections()
            if claimed:
                processed += 1
                if options["once"] or (max_jobs and processed >= max_jobs):
                    return
                continue
            if options["once"] or (max_jobs and processed >= max_jobs):
                return
            time.sleep(poll_interval)
