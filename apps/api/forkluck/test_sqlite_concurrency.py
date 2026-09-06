"""The SQLite write-concurrency contract behind every self-hosted deployment.

SQLite transactions begin DEFERRED, so a transaction that reads before it
writes upgrades its lock mid-transaction — and while another connection holds
the write lock, that upgrade fails immediately with "database is locked",
because the busy timeout applies only to acquiring a lock, never to upgrading
one. Any two concurrent requests where both write could therefore answer an
intermittent 500 (observed as acceptance-test flakes on
``actions/match-catalog-prices/``). The sqlite OPTIONS in ``config.settings``
make every transaction ``BEGIN IMMEDIATE`` with a busy timeout so concurrent
writers queue instead of erroring; this test holds a write open on a
temporary database from one thread while another reads and then writes in the
shape that used to fail instantly. With the OPTIONS removed it fails in under
a millisecond.
"""

import os
import tempfile
import threading
import unittest

from django.conf import settings
from django.db import connections, transaction


@unittest.skipUnless(
    settings.DATABASES["default"]["ENGINE"] == "django.db.backends.sqlite3",
    "The write-contention contract is SQLite-specific",
)
class SqliteWriteContentionTests(unittest.TestCase):
    alias = "sqlite_write_contention_probe"

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        # A file-backed database with the deployed connection options: the
        # in-memory test database cannot reproduce cross-connection locking.
        connections.databases[self.alias] = {
            **connections.databases["default"],
            "NAME": os.path.join(self.temporary_directory.name, "probe.sqlite3"),
        }
        self.addCleanup(connections.databases.pop, self.alias)
        self.addCleanup(connections[self.alias].close)
        with connections[self.alias].cursor() as cursor:
            cursor.execute(
                "CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)"
            )

    def test_read_then_write_waits_for_a_concurrent_writer(self):
        holder_writing = threading.Event()
        release_holder = threading.Event()

        def hold_write_lock():
            try:
                with transaction.atomic(using=self.alias):
                    with connections[self.alias].cursor() as cursor:
                        cursor.execute(
                            "INSERT INTO probe (value) VALUES ('holder')"
                        )
                    holder_writing.set()
                    release_holder.wait(timeout=5)
            finally:
                connections[self.alias].close()

        holder = threading.Thread(target=hold_write_lock)
        holder.start()
        release_timer = threading.Timer(0.3, release_holder.set)
        try:
            self.assertTrue(holder_writing.wait(timeout=5))
            release_timer.start()
            with transaction.atomic(using=self.alias):
                with connections[self.alias].cursor() as cursor:
                    cursor.execute("SELECT COUNT(*) FROM probe")
                    cursor.fetchone()
                    cursor.execute(
                        "INSERT INTO probe (value) VALUES ('waiter')"
                    )
        finally:
            release_timer.cancel()
            release_holder.set()
            holder.join(timeout=5)

        with connections[self.alias].cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM probe")
            self.assertEqual(cursor.fetchone()[0], 2)
