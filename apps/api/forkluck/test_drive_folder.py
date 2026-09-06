"""The Drive folder a workspace's supplier documents arrive in.

Forkluck keeps Drive ids and metadata only, so these tests are about state:
which folder a workspace points at, what the poller has registered about the
files in it, and that neither leaks across users.
"""

import uuid
from datetime import datetime, timezone as datetime_timezone

from django.utils import timezone

from .models import (
    BenchCostSettings,
    DriveFile,
    DriveFileExtraction,
    DriveFolderSource,
    DriveWatchState,
    Invoice,
    User,
)
from .testing import InternalApiTestCase


def registration(drive_file_id: str, **overrides) -> dict:
    entry = {
        "driveFileId": drive_file_id,
        "name": f"{drive_file_id}.pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 2048,
        "modifiedTime": "2026-08-14T09:30:00Z",
        "webViewLink": f"https://drive.example/{drive_file_id}",
        "folderPath": "2026-08",
        "support": "ok",
        "removed": False,
    }
    entry.update(overrides)
    return entry


class DriveFolderTests(InternalApiTestCase):
    def setUp(self) -> None:
        self.user = User.objects.create_user(
            email="drive@example.com",
            name="Drive Tester",
            password="a-long-test-passphrase-2468",
        )
        self.client.force_login(self.user)
        # The poller only registers into a connected folder, so every
        # workspace in these tests has one.
        self.connect(self.user)

    @staticmethod
    def connect(user: User) -> DriveFolderSource:
        source, _ = DriveFolderSource.objects.update_or_create(
            user=user,
            defaults={"folder_id": "folder-1", "folder_name": "Receipts"},
        )
        return source

    def other_client(self):
        other = User.objects.create_user(
            email="drive-other@example.com",
            name="Other Drive Tester",
            password="a-long-test-passphrase-2468",
        )
        client = self.client_class()
        client.force_login(other)
        self.connect(other)
        return other, client

    def read(self) -> dict:
        response = self.get_internal("drive-folder/")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def files(self, status: str, **query) -> dict:
        response = self.get_internal("drive-files/", {"status": status, **query})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def register(self, entries: list[dict], *, user: User | None = None) -> dict:
        """The poller's own route: no session, the workspace named in the
        body."""
        response = self.post_system(
            "system/drive-files/",
            {"userId": str((user or self.user).id), "files": entries},
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_connect_replaces_the_single_folder(self):
        self.post_internal(
            "connect-drive-folder",
            {"folderId": "folder-1", "folderName": "kitchen-receipts"},
        )
        response = self.post_internal(
            "connect-drive-folder",
            {"folderId": "folder-2", "folderName": "receipts 2026"},
        )
        self.assertEqual(
            response.json()["folder"],
            {"folderId": "folder-2", "folderName": "receipts 2026"},
        )
        self.assertEqual(DriveFolderSource.objects.filter(user=self.user).count(), 1)
        self.assertEqual(
            self.read()["folder"],
            {"folderId": "folder-2", "folderName": "receipts 2026"},
        )

    def test_disconnect_clears_the_folder_and_keeps_the_registry(self):
        self.post_internal(
            "connect-drive-folder", {"folderId": "folder-1", "folderName": "Receipts"}
        )
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "fileName": "bundle.pdf"}]},
        )
        self.post_internal("disconnect-drive-folder", {})
        payload = self.read()
        self.assertIsNone(payload["folder"])
        self.assertEqual(len(payload["skipped"]), 1)


class RegisterDriveFilesTests(DriveFolderTests):
    def test_a_supported_file_registers_as_new(self):
        result = self.register([registration("file-1")])
        self.assertEqual(result, {"registered": 1, "removed": 0, "newCount": 1})
        [row] = self.files("new")["files"]
        self.assertEqual(
            row,
            {
                "driveFileId": "file-1",
                "name": "file-1.pdf",
                "mimeType": "application/pdf",
                "sizeBytes": 2048,
                "modifiedTime": "2026-08-14T09:30:00+00:00",
                "webViewLink": "https://drive.example/file-1",
                "folderPath": "2026-08",
                "status": "new",
                "reason": "",
                "invoiceId": None,
                "seenAt": row["seenAt"],
                "parts": [],
            },
        )

    def test_an_unreadable_file_registers_as_unsupported_with_its_verdict(self):
        self.register(
            [
                registration("file-heic", support="heic"),
                registration("file-big", support="too_large"),
            ]
        )
        self.assertEqual(self.files("new")["count"], 0)
        rows = {row["driveFileId"]: row["reason"] for row in self.files("unsupported")["files"]}
        self.assertEqual(rows, {"file-heic": "heic", "file-big": "too_large"})

    def test_a_verdict_that_changes_re_decides_an_undecided_row(self):
        self.register([registration("file-1", support="unsupported")])
        self.register([registration("file-1", support="ok")])
        self.assertEqual(
            [row["driveFileId"] for row in self.files("new")["files"]], ["file-1"]
        )
        self.assertEqual(self.files("unsupported")["count"], 0)

    def test_registration_refreshes_metadata_but_keeps_the_workspace_verdict(self):
        for status in (
            DriveFile.Status.IMPORTED,
            DriveFile.Status.SKIPPED,
            DriveFile.Status.FAILED,
        ):
            with self.subTest(status=status):
                DriveFile.objects.update_or_create(
                    user=self.user,
                    drive_file_id="file-1",
                    defaults={
                        "name": "old.pdf",
                        "status": status,
                        "reason": "kept",
                        "seen_at": timezone.now(),
                    },
                )
                self.register(
                    [registration("file-1", name="renamed.pdf", support="heic")]
                )
                row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
                self.assertEqual(row.status, status)
                self.assertEqual(row.reason, "kept")
                self.assertEqual(row.name, "renamed.pdf")
                self.assertEqual(row.folder_path, "2026-08")

    def test_removed_deletes_every_row_except_an_imported_one(self):
        self.register([registration("file-new"), registration("file-kept")])
        DriveFile.objects.filter(user=self.user, drive_file_id="file-kept").update(
            status=DriveFile.Status.IMPORTED
        )
        result = self.register(
            [
                registration("file-new", removed=True),
                registration("file-kept", removed=True),
                registration("file-never-seen", removed=True),
            ]
        )
        self.assertEqual(result, {"registered": 0, "removed": 1, "newCount": 0})
        self.assertEqual(
            [row.drive_file_id for row in DriveFile.objects.filter(user=self.user)],
            ["file-kept"],
        )

    def test_a_file_mentioned_twice_is_registered_from_its_last_entry(self):
        result = self.register(
            [registration("file-1", name="first.pdf"), registration("file-1", name="second.pdf")]
        )
        self.assertEqual(result["registered"], 1)
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.name, "second.pdf")

    def test_a_null_size_and_modified_time_are_accepted(self):
        self.register(
            [registration("file-1", sizeBytes=None, modifiedTime=None)]
        )
        [row] = self.files("new")["files"]
        self.assertIsNone(row["sizeBytes"])
        self.assertIsNone(row["modifiedTime"])

    def test_query_count_does_not_grow_with_the_page(self):
        self.register([registration(f"seen-{index}") for index in range(3)])
        entries = [registration(f"seen-{index}") for index in range(3)]
        entries += [registration(f"fresh-{index}") for index in range(20)]
        entries.append(registration("seen-0", removed=True))
        with self.assertNumQueries(
            12,
            msg="A registration resolves the workspace's folder, then reads "
            "the known ids once and creates, updates, deletes and counts in "
            "one query each inside its transaction, however many files the "
            "poller sends; a delete costs two more because it collects what "
            "was read of the rows it removes",
        ):
            self.register(entries)

    def test_malformed_registrations_are_refused(self):
        for body in (
            {"files": "file-1"},
            {"files": [registration("file-1", support="maybe")]},
            {"files": [registration("file-1", removed="no")]},
            {"files": [registration("file-1", modifiedTime="the other day")]},
            {"files": [registration("file-1", sizeBytes="2048")]},
            {"files": [registration("a" * 200)]},
            {"files": [registration(f"file-{index}") for index in range(501)]},
        ):
            with self.subTest(body=str(body)[:60]):
                response = self.post_system(
                    "system/drive-files/", {"userId": str(self.user.id), **body}
                )
                self.assertEqual(response.status_code, 400)


class DriveFileStatusTests(DriveFolderTests):
    def test_skip_moves_a_registered_file_and_records_the_reason(self):
        self.register([registration("file-1")])
        response = self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "reason": "duplicate"}]},
        )
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(self.files("new")["count"], 0)
        self.assertEqual(
            self.read()["skipped"],
            [{"driveFileId": "file-1", "fileName": "file-1.pdf", "reason": "duplicate"}],
        )

    def test_skip_creates_a_row_for_a_file_the_poller_has_not_seen(self):
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "fileName": "linen.pdf"}]},
        )
        self.assertEqual(
            self.read()["skipped"],
            [{"driveFileId": "file-1", "fileName": "linen.pdf", "reason": ""}],
        )

    def test_skip_never_demotes_an_imported_file(self):
        self.register([registration("file-1")])
        DriveFile.objects.filter(user=self.user, drive_file_id="file-1").update(
            status=DriveFile.Status.IMPORTED
        )
        self.post_internal(
            "skip-drive-files", {"files": [{"driveFileId": "file-1"}]}
        )
        self.assertEqual(self.files("imported")["count"], 1)
        self.assertEqual(self.read()["skipped"], [])

    def test_skipping_the_same_file_twice_is_a_no_op(self):
        files = [
            {"driveFileId": "file-1", "fileName": "linen.pdf", "reason": ""},
            {"driveFileId": "file-2", "fileName": "photo.heic", "reason": "heic"},
        ]
        self.post_internal("skip-drive-files", {"files": files})
        response = self.post_internal("skip-drive-files", {"files": files})
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(DriveFile.objects.filter(user=self.user).count(), 2)
        skipped = self.read()["skipped"]
        self.assertEqual(
            {row["driveFileId"]: row["reason"] for row in skipped},
            {"file-1": "", "file-2": "heic"},
        )

    def test_unskip_returns_the_file_to_new_and_clears_the_reason(self):
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "reason": "heic"}]},
        )
        self.post_internal("unskip-drive-file", {"driveFileId": "file-1"})
        self.assertEqual(self.read()["skipped"], [])
        [row] = self.files("new")["files"]
        self.assertEqual((row["driveFileId"], row["reason"]), ("file-1", ""))

    def test_unskip_leaves_an_imported_file_alone(self):
        self.register([registration("file-1")])
        DriveFile.objects.filter(user=self.user, drive_file_id="file-1").update(
            status=DriveFile.Status.IMPORTED
        )
        self.post_internal("unskip-drive-file", {"driveFileId": "file-1"})
        self.assertEqual(self.files("imported")["count"], 1)

    def test_registry_is_per_user(self):
        self.register([registration("file-1")])
        other, other_client = self.other_client()
        self.register([registration("file-2")], user=other)
        self.post_internal(
            "skip-drive-files", {"files": [{"driveFileId": "file-2"}]},
            client=other_client,
        )
        self.assertEqual(
            [row["driveFileId"] for row in self.files("new")["files"]], ["file-1"]
        )
        self.assertEqual(
            self.get_internal(
                "drive-files/", {"status": "new"}, client=other_client
            ).json()["count"],
            0,
        )
        self.assertEqual(self.read()["skipped"], [])


class DriveFilesReadTests(DriveFolderTests):
    def test_newest_modified_first_then_name_with_undated_files_last(self):
        self.register(
            [
                registration("older", name="b.pdf", modifiedTime="2026-08-01T00:00:00Z"),
                registration("newer", name="c.pdf", modifiedTime="2026-08-20T00:00:00Z"),
                registration("undated-b", name="z.pdf", modifiedTime=None),
                registration("undated-a", name="a.pdf", modifiedTime=None),
            ]
        )
        self.assertEqual(
            [row["driveFileId"] for row in self.files("new")["files"]],
            ["newer", "older", "undated-a", "undated-b"],
        )

    def test_count_is_the_whole_status_not_the_page(self):
        self.register([registration(f"file-{index}") for index in range(5)])
        payload = self.files("new", limit="2")
        self.assertEqual(len(payload["files"]), 2)
        self.assertEqual(payload["count"], 5)

    def test_status_is_required_and_checked(self):
        for query in ({}, {"status": "everything"}, {"status": ""}):
            with self.subTest(query=query):
                response = self.get_internal("drive-files/", query)
                self.assertEqual(response.status_code, 400)

    def test_a_malformed_limit_is_refused(self):
        response = self.get_internal("drive-files/", {"status": "new", "limit": "lots"})
        self.assertEqual(response.status_code, 400)


class DriveWatchTests(DriveFolderTests):
    """The system surface: the cursor and the folder list the poller reads."""

    SAVE = "system/drive-watch/save/"

    def watch(self) -> dict:
        response = self.get_system("system/drive-watch/")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_the_cursor_reads_empty_before_the_first_poll(self):
        payload = self.watch()
        self.assertEqual(payload["pageToken"], "")
        self.assertIsNone(payload["polledAt"])
        self.assertEqual(payload["lastError"], "")
        self.assertIsNone(self.read()["watch"])

    def test_saving_the_cursor_replaces_the_single_row(self):
        first = self.post_system(
            self.SAVE,
            {
                "pageToken": "token-1",
                "polledAt": "2026-09-01T12:00:00Z",
                "lastError": "",
            },
        )
        self.assertEqual(first.json(), {"ok": True})
        self.post_system(
            self.SAVE,
            {
                "pageToken": "token-2",
                "polledAt": "2026-09-02T12:00:00Z",
                "lastError": "Drive said 403",
            },
        )
        self.assertEqual(DriveWatchState.objects.count(), 1)
        payload = self.watch()
        self.assertEqual(payload["pageToken"], "token-2")
        self.assertEqual(payload["polledAt"], "2026-09-02T12:00:00+00:00")
        self.assertEqual(payload["lastError"], "Drive said 403")

    def test_a_malformed_cursor_is_refused(self):
        response = self.post_system(self.SAVE, {"polledAt": "the other day"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "Modified time is invalid"})

    def test_the_folder_card_shows_the_poll_without_the_token(self):
        self.post_system(
            self.SAVE,
            {
                "pageToken": "token-1",
                "polledAt": "2026-09-01T12:00:00Z",
                "lastError": "",
            },
        )
        self.assertEqual(
            self.read()["watch"],
            {"polledAt": "2026-09-01T12:00:00+00:00", "lastError": ""},
        )

    def test_one_row_serves_every_workspace(self):
        self.other_client()
        self.post_system(
            self.SAVE, {"pageToken": "token-1", "polledAt": None, "lastError": ""}
        )
        self.assertEqual(self.watch()["pageToken"], "token-1")

    def test_every_connected_folder_is_listed_newest_first(self):
        other, _ = self.other_client()
        folders = self.watch()["folders"]
        self.assertEqual(
            [row["userId"] for row in folders], [str(other.id), str(self.user.id)]
        )
        self.assertEqual(
            folders[0],
            {
                "userId": str(other.id),
                "folderId": "folder-1",
                "folderName": "Receipts",
                # Nothing has been listed in full yet.
                "registeredAt": None,
            },
        )

    def test_mark_registered_records_the_first_full_listing(self):
        self.assertIsNone(self.watch()["folders"][0]["registeredAt"])
        response = self.post_system(
            "system/drive-files/",
            {
                "userId": str(self.user.id),
                "files": [registration("file-1")],
                "markRegistered": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIsNotNone(self.watch()["folders"][0]["registeredAt"])

    def test_reconnecting_the_folder_asks_for_a_full_listing_again(self):
        source = DriveFolderSource.objects.get(user=self.user)
        source.registered_at = timezone.now()
        source.save(update_fields=["registered_at"])
        self.post_internal(
            "connect-drive-folder",
            {"folderId": "folder-2", "folderName": "Receipts 2026"},
        )
        self.assertIsNone(self.watch()["folders"][0]["registeredAt"])

    def test_the_watch_read_is_two_queries(self):
        for index in range(4):
            self.connect(
                User.objects.create_user(
                    email=f"watch-{index}@example.com",
                    name=f"Watcher {index}",
                    password="a-long-test-passphrase-2468",
                )
            )
        with self.assertNumQueries(
            2,
            msg="The poller reads the cursor and the folder list in one query "
            "each, however many workspaces have connected a folder",
        ):
            self.get_system("system/drive-watch/")

    def test_registration_names_one_workspace_and_touches_no_other(self):
        other, _ = self.other_client()
        self.register([registration("file-1")])
        self.assertEqual(DriveFile.objects.filter(user=other).count(), 0)
        self.assertEqual(DriveFile.objects.filter(user=self.user).count(), 1)

    def test_an_unknown_or_unconnected_workspace_is_refused(self):
        stranger = User.objects.create_user(
            email="no-folder@example.com",
            name="No Folder",
            password="a-long-test-passphrase-2468",
        )
        for user_id in (str(uuid.uuid4()), str(stranger.id), "not-a-uuid", None):
            with self.subTest(user_id=user_id):
                response = self.post_system(
                    "system/drive-files/", {"userId": user_id, "files": []}
                )
                self.assertEqual(response.status_code, 404)
                self.assertEqual(
                    response.json(),
                    {"error": "No connected Drive folder for that workspace"},
                )


class DriveImportTests(DriveFolderTests):
    def test_importing_marks_the_registry_row_and_links_the_invoice(self):
        self.register([registration("file-1")])
        response = self.post_internal(
            "import-invoices",
            {
                "reviewedCurrencyCode": "USD",
                "source": "drive",
                "invoices": [
                    {
                        "supplier": "harbor",
                        "supplierName": "Harbor Supply",
                        "documentType": "invoice",
                        "invoiceNumber": "H-1",
                        "invoiceDate": "2026-08-14",
                        "totalCents": 1000,
                        "fileName": "harbor.pdf",
                        "driveFileId": "file-1",
                        "driveWebViewLink": "https://drive.example/file-1",
                        "lines": [],
                    }
                ]
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        invoice = Invoice.objects.get(user=self.user)
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.IMPORTED)
        self.assertEqual(row.invoice_id, invoice.id)
        [listed] = self.files("imported")["files"]
        self.assertEqual(listed["invoiceId"], str(invoice.id))
        self.assertEqual(self.files("new")["count"], 0)

    def test_importing_a_file_the_poller_never_saw_creates_its_row(self):
        self.post_internal(
            "import-invoices",
            {
                "reviewedCurrencyCode": "USD",
                "source": "drive",
                "invoices": [
                    {
                        "supplier": "harbor",
                        "supplierName": "Harbor Supply",
                        "documentType": "invoice",
                        "invoiceNumber": "H-2",
                        "invoiceDate": "2026-08-14",
                        "totalCents": 1000,
                        "fileName": "harbor.pdf",
                        "driveFileId": "file-2",
                        "driveWebViewLink": "https://drive.example/file-2",
                        "lines": [],
                    }
                ]
            },
        )
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-2")
        self.assertEqual(row.name, "harbor.pdf")
        self.assertEqual(row.web_view_link, "https://drive.example/file-2")
        self.assertEqual(row.status, DriveFile.Status.IMPORTED)

    def test_the_overview_counts_the_new_files(self):
        self.register(
            [registration("file-1"), registration("file-2", support="heic")]
        )
        overview = self.get_internal("invoices-overview/").json()
        self.assertEqual(overview["driveNewCount"], 1)


class DriveWatchModelTests(DriveFolderTests):
    def test_the_cursor_row_is_a_singleton(self):
        first = DriveWatchState.load()
        first.polled_at = datetime(2026, 9, 1, tzinfo=datetime_timezone.utc)
        first.save()
        self.assertEqual(DriveWatchState.load().pk, first.pk)
        self.assertEqual(DriveWatchState.objects.count(), 1)


class DriveExtractionMixin(DriveFolderTests):
    """The unattended half: the watcher reads a file and stores what it read."""

    def extract(self, drive_file_id: str, **overrides) -> dict:
        body = {
            "userId": str(self.user.id),
            "driveFileId": drive_file_id,
            "document": {"supplier": "harbor", "fileName": "harbor.pdf"},
            "model": "claude-sonnet",
            "escalated": False,
        }
        body.update(overrides)
        response = self.post_system("system/drive-extractions/", body)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def system_files(self, status: str, **query) -> dict:
        parts = "".join(f"&{key}={value}" for key, value in query.items())
        response = self.get_system(
            f"system/drive-files/?userId={self.user.id}&status={status}{parts}"
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()


class DriveExtractionRegisterTests(DriveExtractionMixin):
    """What a later registration may and may not undo."""

    def test_a_read_or_failed_verdict_survives_an_unchanged_file(self):
        self.register([registration("read"), registration("failed")])
        self.extract("read")
        self.post_system(
            "system/drive-extractions/failed/",
            {
                "userId": str(self.user.id),
                "driveFileId": "failed",
                "reason": "unreadable",
            },
        )
        result = self.register([registration("read"), registration("failed")])
        self.assertEqual(result["newCount"], 0)
        self.assertEqual(self.files("ready")["count"], 1)
        self.assertEqual(self.files("failed")["count"], 1)
        self.assertEqual(DriveFileExtraction.objects.count(), 1)

    def test_newer_bytes_send_a_read_file_back_to_new_and_drop_the_reading(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        result = self.register(
            [registration("file-1", modifiedTime="2026-08-20T09:30:00Z")]
        )
        self.assertEqual(result["newCount"], 1)
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.NEW)
        self.assertEqual(row.reason, "")
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_newer_bytes_re_decide_support(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        self.register(
            [
                registration(
                    "file-1", modifiedTime="2026-08-20T09:30:00Z", support="heic"
                )
            ]
        )
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.UNSUPPORTED)
        self.assertEqual(row.reason, "heic")

    def test_the_same_or_an_unknown_modified_time_leaves_the_reading_alone(self):
        for modified in ("2026-08-14T09:30:00Z", "2026-08-01T09:30:00Z", None):
            with self.subTest(modifiedTime=modified):
                self.register([registration("file-1")])
                self.extract("file-1")
                self.register([registration("file-1", modifiedTime=modified)])
                row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
                self.assertEqual(row.status, DriveFile.Status.READY)
                self.assertEqual(DriveFileExtraction.objects.count(), 1)

    def test_a_removed_ready_file_is_deleted_like_a_new_one(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        result = self.register([registration("file-1", removed=True)])
        self.assertEqual(result["removed"], 1)
        self.assertEqual(DriveFile.objects.filter(user=self.user).count(), 0)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)


class DriveExtractionSystemTests(DriveExtractionMixin):
    """The routes the reader calls: what to read, and what it read."""

    def test_the_reader_gets_the_oldest_files_first_with_undated_last(self):
        self.register(
            [
                registration("older", name="b.pdf", modifiedTime="2026-08-01T00:00:00Z"),
                registration("newer", name="c.pdf", modifiedTime="2026-08-20T00:00:00Z"),
                registration("undated-b", name="z.pdf", modifiedTime=None),
                registration("undated-a", name="a.pdf", modifiedTime=None),
            ]
        )
        self.assertEqual(
            [row["driveFileId"] for row in self.system_files("new")["files"]],
            ["older", "newer", "undated-a", "undated-b"],
        )

    def test_the_reader_sees_only_its_own_three_statuses(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        payload = self.system_files("ready")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(
            payload["files"][0]["parts"][0]["document"],
            {"supplier": "harbor", "fileName": "harbor.pdf"},
        )
        for status in ("imported", "skipped", "unsupported", "everything"):
            with self.subTest(status=status):
                response = self.get_system(
                    f"system/drive-files/?userId={self.user.id}&status={status}"
                )
                self.assertEqual(response.status_code, 400)

    def test_the_reader_reads_one_workspace_and_needs_a_connected_folder(self):
        other, _ = self.other_client()
        self.register([registration("file-1")])
        self.register([registration("file-2")], user=other)
        self.assertEqual(
            [row["driveFileId"] for row in self.system_files("new")["files"]],
            ["file-1"],
        )
        response = self.get_system(
            f"system/drive-files/?userId={uuid.uuid4()}&status=new"
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            response.json(),
            {"error": "No connected Drive folder for that workspace"},
        )

    def test_the_page_is_capped_and_the_count_is_the_whole_status(self):
        self.register([registration(f"file-{index}") for index in range(5)])
        payload = self.system_files("new", limit=2)
        self.assertEqual(len(payload["files"]), 2)
        self.assertEqual(payload["count"], 5)
        response = self.get_system(
            f"system/drive-files/?userId={self.user.id}&status=new&limit=lots"
        )
        self.assertEqual(response.status_code, 400)

    def test_the_reader_read_is_two_queries(self):
        self.register([registration(f"file-{index}") for index in range(5)])
        for drive_file_id in ("file-0", "file-1", "file-2"):
            self.extract(drive_file_id)
        with self.assertNumQueries(
            4,
            msg="The reader resolves the workspace's folder, then reads one "
            "page, its parts and the document total; what was read rides on "
            "one prefetch for the page, not one query per file",
        ):
            self.get_system(
                f"system/drive-files/?userId={self.user.id}&status=ready"
            )

    def test_storing_a_reading_moves_the_row_and_counts_what_is_waiting(self):
        self.register([registration("file-1"), registration("file-2")])
        self.assertEqual(self.extract("file-1"), {"ok": True, "readyCount": 1})
        self.assertEqual(self.extract("file-2"), {"ok": True, "readyCount": 2})
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.READY)
        self.assertEqual(row.reason, "")
        stored = DriveFileExtraction.objects.get(drive_file=row)
        self.assertEqual(stored.model, "claude-sonnet")
        self.assertFalse(stored.escalated)

    def test_a_second_reading_replaces_the_first(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        self.extract("file-1", document={"supplier": "linen"}, escalated=True)
        stored = DriveFileExtraction.objects.get()
        self.assertEqual(stored.document, {"supplier": "linen"})
        self.assertTrue(stored.escalated)

    def test_a_late_reader_never_overwrites_the_merchants_verdict(self):
        for status in (
            DriveFile.Status.IMPORTED,
            DriveFile.Status.SKIPPED,
            DriveFile.Status.UNSUPPORTED,
        ):
            with self.subTest(status=status):
                self.register([registration("file-1")])
                DriveFile.objects.filter(
                    user=self.user, drive_file_id="file-1"
                ).update(status=status)
                for path in (
                    "system/drive-extractions/",
                    "system/drive-extractions/failed/",
                ):
                    response = self.post_system(
                        path,
                        {
                            "userId": str(self.user.id),
                            "driveFileId": "file-1",
                            "document": {"supplier": "harbor"},
                            "reason": "unreadable",
                        },
                    )
                    self.assertEqual(response.status_code, 400)
                self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_a_malformed_or_oversized_reading_is_refused(self):
        self.register([registration("file-1")])
        for body in (
            {"document": {}},
            {"document": "harbor"},
            {"document": {"blob": "x" * (200 * 1024)}},
            {"model": "m" * 121},
            {"escalated": "yes"},
            {"driveFileId": ""},
        ):
            with self.subTest(body=str(body)[:40]):
                response = self.post_system(
                    "system/drive-extractions/",
                    {
                        "userId": str(self.user.id),
                        "driveFileId": "file-1",
                        "document": {"supplier": "harbor"},
                        **body,
                    },
                )
                self.assertEqual(response.status_code, 400, response.content)
        response = self.post_system(
            "system/drive-extractions/",
            {
                "userId": str(self.user.id),
                "driveFileId": "never-registered",
                "document": {"supplier": "harbor"},
            },
        )
        self.assertEqual(response.status_code, 404)

    def test_a_failed_read_records_the_reason_and_drops_the_reading(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        response = self.post_system(
            "system/drive-extractions/failed/",
            {
                "userId": str(self.user.id),
                "driveFileId": "file-1",
                "reason": "the scan is a photo of a wall",
            },
        )
        self.assertEqual(response.json(), {"ok": True})
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.FAILED)
        self.assertEqual(row.reason, "the scan is a photo of a wall")
        self.assertEqual(DriveFileExtraction.objects.count(), 0)
        long_reason = self.post_system(
            "system/drive-extractions/failed/",
            {
                "userId": str(self.user.id),
                "driveFileId": "file-1",
                "reason": "r" * 256,
            },
        )
        self.assertEqual(long_reason.status_code, 400)

    def test_the_probe_answers_the_action_plus_the_workspace_currency(self):
        BenchCostSettings.objects.update_or_create(
            user=self.user, defaults={"currency_code": "GBP"}
        )
        body = {
            "supplier": "harbor",
            "lines": [{"sku": "H-1", "name": "Butter 1kg"}],
        }
        attended = self.post_internal("invoice-line-status", body).json()
        response = self.post_system(
            "system/invoice-line-status/", {"userId": str(self.user.id), **body}
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {**attended, "currencyCode": "GBP"})

    def test_the_probe_needs_a_connected_workspace(self):
        response = self.post_system(
            "system/invoice-line-status/",
            {"userId": str(uuid.uuid4()), "supplier": "harbor", "lines": []},
        )
        self.assertEqual(response.status_code, 404)


class DriveExtractionReviewTests(DriveExtractionMixin):
    """What the merchant's screen does with a file the watcher has read."""

    def test_the_screen_reads_a_ready_file_with_what_was_read(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        [row] = self.files("ready")["files"]
        self.assertEqual(row["status"], "ready")
        [part] = row["parts"]
        self.assertEqual(
            part,
            {
                "id": part["id"],
                "part": 0,
                "pageStart": None,
                "pageEnd": None,
                "region": None,
                "status": "ready",
                "document": {"supplier": "harbor", "fileName": "harbor.pdf"},
                "model": "claude-sonnet",
                "escalated": False,
                "extractedAt": part["extractedAt"],
            },
        )
        self.assertEqual(self.files("new")["count"], 0)

    def test_a_file_in_any_other_status_carries_no_parts(self):
        self.register([registration("file-1")])
        [row] = self.files("new")["files"]
        self.assertEqual(row["parts"], [])

    def test_retry_puts_a_failed_file_back_in_line(self):
        self.register([registration("file-1"), registration("file-2")])
        self.post_system(
            "system/drive-extractions/failed/",
            {
                "userId": str(self.user.id),
                "driveFileId": "file-1",
                "reason": "unreadable",
            },
        )
        response = self.post_internal("retry-drive-file", {"driveFileId": "file-1"})
        self.assertEqual(response.json(), {"ok": True})
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.NEW)
        self.assertEqual(row.reason, "")

    def test_retry_leaves_every_other_status_alone(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        self.post_internal("retry-drive-file", {"driveFileId": "file-1"})
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.READY)
        self.assertEqual(DriveFileExtraction.objects.count(), 1)

    def test_skipping_a_read_file_drops_what_was_read(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "reason": "duplicate"}]},
        )
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.SKIPPED)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_importing_a_read_file_drops_what_was_read(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        response = self.post_internal(
            "import-invoices",
            {
                "reviewedCurrencyCode": "USD",
                "source": "drive",
                "invoices": [
                    {
                        "supplier": "harbor",
                        "supplierName": "Harbor Supply",
                        "documentType": "invoice",
                        "invoiceNumber": "H-9",
                        "invoiceDate": "2026-08-14",
                        "totalCents": 1000,
                        "fileName": "harbor.pdf",
                        "driveFileId": "file-1",
                        "driveWebViewLink": "https://drive.example/file-1",
                        "lines": [],
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.IMPORTED)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_the_overview_counts_both_halves_of_the_badge(self):
        self.register([registration("file-1"), registration("file-2")])
        self.extract("file-1")
        overview = self.get_internal("invoices-overview/").json()
        self.assertEqual(overview["driveNewCount"], 1)
        self.assertEqual(overview["driveReadyCount"], 1)


class DriveFilePartsTests(DriveExtractionMixin):
    """A file that holds several receipts: one row per document in it, and a
    file that only closes once every one of them is decided."""

    def extract_parts(self, drive_file_id: str, parts: list[dict]) -> dict:
        response = self.post_system(
            "system/drive-extractions/",
            {
                "userId": str(self.user.id),
                "driveFileId": drive_file_id,
                "model": "claude-sonnet",
                "parts": parts,
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def bundle(self, drive_file_id: str = "file-1") -> None:
        """Two receipts, pages 0-1 and 2-4 of one scan."""
        self.register([registration(drive_file_id)])
        self.extract_parts(
            drive_file_id,
            [
                {
                    "part": 0,
                    "document": {"supplier": "harbor", "fileName": "harbor.pdf"},
                    "pageStart": 0,
                    "pageEnd": 1,
                },
                {
                    "part": 1,
                    "document": {"supplier": "wegmans", "fileName": "harbor.pdf"},
                    "pageStart": 2,
                    "pageEnd": 4,
                    "escalated": True,
                },
            ],
        )

    def test_the_overview_badge_counts_documents_not_files(self):
        self.bundle()
        overview = self.get_internal("invoices-overview/").json()
        self.assertEqual(overview["driveReadyCount"], 2)

    def import_part(self, part: int, *, number: str, drive_file_id="file-1"):
        response = self.post_internal(
            "import-invoices",
            {
                "reviewedCurrencyCode": "USD",
                "source": "drive",
                "invoices": [
                    {
                        "supplier": "harbor",
                        "supplierName": "Harbor Supply",
                        "documentType": "invoice",
                        "invoiceNumber": number,
                        "invoiceDate": "2026-08-14",
                        "totalCents": 1000,
                        "fileName": "harbor.pdf",
                        "driveFileId": drive_file_id,
                        "drivePart": part,
                        "driveWebViewLink": "https://drive.example/file-1",
                        "lines": [],
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response

    def test_every_part_is_stored_and_listed_in_order(self):
        self.bundle()
        [row] = self.files("ready")["files"]
        self.assertEqual(
            [
                (
                    part["part"],
                    part["pageStart"],
                    part["pageEnd"],
                    part["region"],
                    part["status"],
                    part["escalated"],
                    part["document"]["supplier"],
                )
                for part in row["parts"]
            ],
            [
                (0, 0, 1, None, "ready", False, "harbor"),
                (1, 2, 4, None, "ready", True, "wegmans"),
            ],
        )

    def test_the_ready_count_counts_documents_not_files(self):
        # The reviewer works through documents, so a bundle of two receipts in
        # one file is two things waiting, not one.
        self.bundle()
        self.assertEqual(self.files("ready")["count"], 2)
        # A part that has been decided on is not offered again, so it stops
        # counting while its file stays ready for the other one.
        self.import_part(0, number="H-1")
        self.assertEqual(self.files("ready")["count"], 1)

    def test_a_photo_part_stores_its_region_instead_of_pages(self):
        self.register([registration("photo")])
        self.extract_parts(
            "photo",
            [
                {
                    "part": 0,
                    "document": {"supplier": "harbor"},
                    "region": {"x0": 0, "y0": 0, "x1": 0.5, "y1": 1},
                },
                {
                    "part": 1,
                    "document": {"supplier": "wegmans"},
                    "region": {"x0": 0.5, "y0": 0, "x1": 1, "y1": 1},
                },
            ],
        )
        [row] = self.files("ready")["files"]
        self.assertEqual(
            [part["region"] for part in row["parts"]],
            [
                {"x0": 0.0, "y0": 0.0, "x1": 0.5, "y1": 1.0},
                {"x0": 0.5, "y0": 0.0, "x1": 1.0, "y1": 1.0},
            ],
        )
        self.assertEqual([part["pageStart"] for part in row["parts"]], [None, None])

    def test_a_re_read_replaces_the_parts_that_were_stored(self):
        self.bundle()
        self.extract_parts("file-1", [{"part": 0, "document": {"supplier": "harbor"}}])
        self.assertEqual(DriveFileExtraction.objects.count(), 1)
        [row] = self.files("ready")["files"]
        self.assertEqual([part["part"] for part in row["parts"]], [0])

    def test_the_flat_single_document_body_is_still_one_part(self):
        self.register([registration("file-1")])
        self.extract("file-1")
        [part] = DriveFileExtraction.objects.all()
        self.assertEqual(part.part, 0)
        self.assertIsNone(part.page_start)
        self.assertIsNone(part.region)
        self.assertEqual(part.status, DriveFileExtraction.Status.READY)

    def test_importing_one_part_leaves_the_rest_of_the_file_on_offer(self):
        self.bundle()
        self.import_part(0, number="H-1")
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.READY)
        self.assertEqual(
            sorted(
                DriveFileExtraction.objects.filter(drive_file=row).values_list(
                    "part", "status"
                )
            ),
            [(0, "imported"), (1, "ready")],
        )
        invoice = Invoice.objects.get(user=self.user, invoice_number="H-1")
        self.assertEqual(invoice.drive_file_id, "file-1")
        self.assertEqual(invoice.drive_file_part, 0)

    def test_importing_the_last_part_closes_the_file_and_drops_the_readings(self):
        self.bundle()
        self.import_part(0, number="H-1")
        self.import_part(1, number="W-2")
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.IMPORTED)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)
        self.assertEqual(
            sorted(
                Invoice.objects.filter(user=self.user).values_list(
                    "invoice_number", "drive_file_part"
                )
            ),
            [("H-1", 0), ("W-2", 1)],
        )

    def test_both_parts_of_a_bundle_import_in_one_call(self):
        self.bundle()
        response = self.post_internal(
            "import-invoices",
            {
                "reviewedCurrencyCode": "USD",
                "source": "drive",
                "invoices": [
                    {
                        "supplier": "harbor",
                        "supplierName": "Harbor Supply",
                        "documentType": "invoice",
                        "invoiceNumber": number,
                        "invoiceDate": "2026-08-14",
                        "totalCents": 1000,
                        "fileName": "harbor.pdf",
                        "driveFileId": "file-1",
                        "drivePart": part,
                        "lines": [],
                    }
                    for part, number in ((0, "H-1"), (1, "W-2"))
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.IMPORTED)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_skipping_one_part_leaves_the_rest_of_the_file_on_offer(self):
        self.bundle()
        self.post_internal(
            "skip-drive-files",
            {
                "files": [
                    {"driveFileId": "file-1", "part": 1, "reason": "not a receipt"}
                ]
            },
        )
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.READY)
        self.assertEqual(
            sorted(
                DriveFileExtraction.objects.filter(drive_file=row).values_list(
                    "part", "status"
                )
            ),
            [(0, "ready"), (1, "skipped")],
        )

    def test_a_file_whose_parts_were_all_skipped_is_skipped(self):
        self.bundle()
        self.post_internal(
            "skip-drive-files",
            {
                "files": [
                    {"driveFileId": "file-1", "part": 0, "reason": "blank"},
                    {"driveFileId": "file-1", "part": 1, "reason": "blank"},
                ]
            },
        )
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.SKIPPED)
        self.assertEqual(row.reason, "blank")
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_a_file_with_one_part_imported_and_one_skipped_is_imported(self):
        self.bundle()
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "part": 1, "reason": "blank"}]},
        )
        self.import_part(0, number="H-1")
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.IMPORTED)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_never_offer_this_file_still_skips_the_whole_bundle(self):
        self.bundle()
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "reason": "duplicate scan"}]},
        )
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.SKIPPED)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_the_probe_knows_the_part_that_was_imported_not_the_file(self):
        self.bundle()
        self.import_part(0, number="H-1")
        body = {"supplier": "harbor", "lines": [], "driveFileId": "file-1"}
        self.assertTrue(
            self.post_internal("invoice-line-status", {**body, "drivePart": 0}).json()[
                "driveFileKnown"
            ]
        )
        self.assertFalse(
            self.post_internal("invoice-line-status", {**body, "drivePart": 1}).json()[
                "driveFileKnown"
            ]
        )
        # No part named is part 0, the whole-file document.
        self.assertTrue(
            self.post_internal("invoice-line-status", body).json()["driveFileKnown"]
        )

    def test_a_malformed_part_is_refused(self):
        self.register([registration("file-1")])
        document = {"supplier": "harbor"}
        for parts in (
            [],
            [{"part": 0, "document": {}}],
            [{"part": 0, "document": document}, {"part": 0, "document": document}],
            [{"part": -1, "document": document}],
            [{"part": 0, "document": document, "pageStart": 3, "pageEnd": 1}],
            [{"part": 0, "document": document, "pageStart": 1}],
            [
                {
                    "part": 0,
                    "document": document,
                    "pageStart": 0,
                    "pageEnd": 1,
                    "region": {"x0": 0, "y0": 0, "x1": 1, "y1": 1},
                }
            ],
            [{"part": 0, "document": document, "region": {"x0": 0, "y0": 0}}],
            [
                {
                    "part": 0,
                    "document": document,
                    "region": {"x0": 0.6, "y0": 0, "x1": 0.5, "y1": 1},
                }
            ],
        ):
            with self.subTest(parts=parts):
                response = self.post_system(
                    "system/drive-extractions/",
                    {
                        "userId": str(self.user.id),
                        "driveFileId": "file-1",
                        "parts": parts,
                    },
                )
                self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(DriveFileExtraction.objects.count(), 0)

    def test_a_part_of_another_workspaces_file_is_not_skippable(self):
        other, _ = self.other_client()
        self.register([registration("file-1")], user=other)
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "part": 0, "reason": "nope"}]},
        )
        row = DriveFile.objects.get(user=other, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.NEW)
        self.assertFalse(DriveFile.objects.filter(user=self.user).exists())

    def test_editing_an_invoice_keeps_the_part_it_was_read_from(self):
        self.bundle()
        self.import_part(1, number="W-2")
        invoice = Invoice.objects.get(user=self.user, invoice_number="W-2")
        response = self.post_internal(
            "save-invoice",
            {
                "id": str(invoice.id),
                "supplierName": "Wegmans",
                "invoiceNumber": "W-2",
                "invoiceDate": "2026-08-14",
                "totalCents": 1200,
                "lines": [
                    {
                        "sku": "",
                        "description": "FUEL SURCHARGE",
                        "quantity": None,
                        "unit": "",
                        "packSize": "",
                        "unitPriceCents": None,
                        "lineAmountCents": 1200,
                        "categoryId": None,
                        "sourcePayload": {},
                        "costEntry": None,
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.content)
        invoice.refresh_from_db()
        self.assertEqual(invoice.drive_file_id, "file-1")
        self.assertEqual(invoice.drive_file_part, 1)

    def test_a_part_of_a_file_nothing_has_read_is_not_a_skip(self):
        self.register([registration("file-1")])
        self.post_internal(
            "skip-drive-files",
            {"files": [{"driveFileId": "file-1", "part": 1, "reason": "stale"}]},
        )
        row = DriveFile.objects.get(user=self.user, drive_file_id="file-1")
        self.assertEqual(row.status, DriveFile.Status.NEW)
