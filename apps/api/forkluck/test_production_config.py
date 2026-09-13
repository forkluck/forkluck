"""The production settings guard.

`config.settings` refuses to import in a production environment that still
carries development defaults. Reimporting the module under a patched
environment is the only way to exercise that, so each case builds a full
environment and reloads the module in isolation.
"""

import importlib
import os
import sys
from pathlib import Path
from unittest import mock

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase
from .paths import ROOT as REPO_ROOT


GOOD_ENVIRONMENT = {
    "FORKLUCK_ENVIRONMENT": "production",
    "DATABASE_URL": "postgres://user:pass@db.internal:5432/forkluck",
    "DJANGO_SECRET_KEY": "a-real-production-secret-long-enough-for-djangos-own-check",
    "FORKLUCK_INTERNAL_SECRET": "a-real-internal-secret",
    "DJANGO_SECURE_COOKIES": "1",
    "FORKLUCK_TOKEN_ENCRYPTION_KEY": "ab" * 32,
    "DJANGO_ALLOWED_HOSTS": "app.forkluck.com",
    "DJANGO_CSRF_TRUSTED_ORIGINS": "https://app.forkluck.com",
    "FORKLUCK_APP_ORIGIN": "https://app.forkluck.com",
    "DJANGO_DEBUG": "0",
    "FORKLUCK_REQUIRE_EMAIL_VERIFICATION": "true",
    "ACS_CONNECTION_STRING": "endpoint=https://test.communication.azure.com/;accesskey=test",
}


def reload_settings(environment: dict[str, str]):
    """Import config.settings under exactly `environment`.

    The module is dropped from sys.modules first so the guard re-runs, and
    ``sys.argv`` is blanked because the guard stands down under the test
    runner — which is precisely the path being tested here.
    """
    with mock.patch.dict(os.environ, environment, clear=True):
        with mock.patch.object(sys, "argv", ["manage.py", "runserver"]):
            sys.modules.pop("config.settings", None)
            try:
                return importlib.import_module("config.settings")
            finally:
                sys.modules.pop("config.settings", None)


class ProductionConfigGuardTests(SimpleTestCase):
    def test_mail_bridge_can_supply_production_transactional_delivery(self):
        for url in ("https://mail.example.test/v3/example.test/messages", "http://127.0.0.1:3003/v3/example.test/messages"):
            with self.subTest(url=url):
                configured = reload_settings({
                    **GOOD_ENVIRONMENT, "ACS_CONNECTION_STRING": "",
                    "FORKLUCK_MAIL_BRIDGE_URL": url,
                    "FORKLUCK_MAIL_BRIDGE_API_KEY": "synthetic-bridge-key",
                })
                self.assertTrue(configured.FORKLUCK_ADMIN_CODE_LOGIN)

    def test_partial_or_unsafe_mail_bridge_configuration_fails_at_boot(self):
        for url, key in (
            ("", "synthetic-key"), ("https://mail.example.test/messages", ""),
            ("http://mail.example.test/messages", "synthetic-key"),
            ("https://user:pass@mail.example.test/messages", "synthetic-key"),
            ("https://mail.example.test/messages?key=secret", "synthetic-key"),
            ("https://mail.example.test/messages#fragment", "synthetic-key"),
            ("https://mail.example.test/", "synthetic-key"),
        ):
            with self.subTest(url=url), self.assertRaisesMessage(ImproperlyConfigured, "Mail bridge requires"):
                reload_settings({**GOOD_ENVIRONMENT, "FORKLUCK_MAIL_BRIDGE_URL": url, "FORKLUCK_MAIL_BRIDGE_API_KEY": key})

    def test_google_sign_in_pair_is_all_or_none_in_every_environment(self):
        for environment in ("development", "production", "staging"):
            for client_id, secret in (("client", ""), ("", "secret")):
                with self.subTest(environment=environment, client_id=client_id):
                    with self.assertRaisesMessage(ImproperlyConfigured, "Google sign-in requires both"):
                        reload_settings({**GOOD_ENVIRONMENT, "FORKLUCK_ENVIRONMENT": environment,
                            "GOOGLE_SIGN_IN_CLIENT_ID": client_id, "GOOGLE_SIGN_IN_CLIENT_SECRET": secret})
            configured = reload_settings({**GOOD_ENVIRONMENT, "FORKLUCK_ENVIRONMENT": environment,
                "GOOGLE_SIGN_IN_CLIENT_ID": "client", "GOOGLE_SIGN_IN_CLIENT_SECRET": "secret"})
            self.assertEqual(configured.GOOGLE_SIGN_IN_CLIENT_ID, "client")
            self.assertEqual(configured.GOOGLE_SIGN_IN_CLIENT_SECRET, "secret")

    def test_turnstile_pair_is_all_or_none_in_every_environment(self):
        for environment in ("development", "production", "staging"):
            for site_key, secret in (("site", ""), ("", "secret")):
                with self.subTest(environment=environment, site_key=site_key):
                    with self.assertRaisesMessage(ImproperlyConfigured, "Turnstile requires both"):
                        reload_settings({**GOOD_ENVIRONMENT, "FORKLUCK_ENVIRONMENT": environment,
                            "TURNSTILE_SITE_KEY": site_key, "TURNSTILE_SECRET_KEY": secret})
            configured = reload_settings({**GOOD_ENVIRONMENT, "FORKLUCK_ENVIRONMENT": environment,
                "TURNSTILE_SITE_KEY": "site", "TURNSTILE_SECRET_KEY": "secret"})
            self.assertEqual(configured.TURNSTILE_SITE_KEY, "site")
            self.assertEqual(configured.TURNSTILE_SECRET_KEY, "secret")
        unset = reload_settings(GOOD_ENVIRONMENT)
        self.assertEqual((unset.TURNSTILE_SITE_KEY, unset.TURNSTILE_SECRET_KEY), ("", ""))

    def test_test_runner_clears_even_partial_turnstile_configuration(self):
        with mock.patch.dict(os.environ, {**GOOD_ENVIRONMENT, "TURNSTILE_SECRET_KEY": "secret"}, clear=True):
            with mock.patch.object(sys, "argv", ["manage.py", "test"]):
                sys.modules.pop("config.settings", None)
                try:
                    configured = importlib.import_module("config.settings")
                    self.assertEqual(configured.TURNSTILE_SITE_KEY, "")
                    self.assertEqual(configured.TURNSTILE_SECRET_KEY, "")
                    self.assertNotIn("TURNSTILE_SECRET_KEY", os.environ)
                finally:
                    sys.modules.pop("config.settings", None)

    def test_test_runner_clears_even_partial_google_configuration(self):
        with mock.patch.dict(os.environ, {**GOOD_ENVIRONMENT, "GOOGLE_SIGN_IN_CLIENT_ID": "client"}, clear=True):
            with mock.patch.object(sys, "argv", ["manage.py", "test"]):
                sys.modules.pop("config.settings", None)
                try:
                    configured = importlib.import_module("config.settings")
                    self.assertEqual(configured.GOOGLE_SIGN_IN_CLIENT_ID, "")
                    self.assertEqual(configured.GOOGLE_SIGN_IN_CLIENT_SECRET, "")
                    self.assertNotIn("GOOGLE_SIGN_IN_CLIENT_ID", os.environ)
                    self.assertNotIn("GOOGLE_SIGN_IN_CLIENT_SECRET", os.environ)
                finally:
                    sys.modules.pop("config.settings", None)

    def test_fully_configured_production_boots(self):
        settings_module = reload_settings(GOOD_ENVIRONMENT)

        self.assertEqual(settings_module.FORKLUCK_ENVIRONMENT, "production")
        self.assertTrue(settings_module.SESSION_COOKIE_SECURE)
        self.assertTrue(settings_module.CSRF_COOKIE_SECURE)

    def test_real_hosts_can_include_the_private_loopback_connection(self):
        settings_module = reload_settings(
            {
                **GOOD_ENVIRONMENT,
                "DJANGO_ALLOWED_HOSTS": "app.forkluck.com,localhost,127.0.0.1",
            }
        )

        self.assertEqual(
            settings_module.ALLOWED_HOSTS,
            ["app.forkluck.com", "localhost", "127.0.0.1"],
        )

    def test_bare_production_environment_refuses_to_start(self):
        with self.assertRaises(ImproperlyConfigured) as caught:
            reload_settings(
                {
                    "FORKLUCK_ENVIRONMENT": "production",
                    "DATABASE_URL": GOOD_ENVIRONMENT["DATABASE_URL"],
                }
            )

        message = str(caught.exception)
        self.assertIn("DJANGO_SECRET_KEY", message)
        self.assertIn("FORKLUCK_INTERNAL_SECRET", message)
        self.assertIn("DJANGO_SECURE_COOKIES", message)
        self.assertIn("FORKLUCK_TOKEN_ENCRYPTION_KEY", message)
        self.assertIn("DJANGO_ALLOWED_HOSTS", message)
        self.assertIn("DJANGO_CSRF_TRUSTED_ORIGINS", message)
        self.assertIn("FORKLUCK_APP_ORIGIN", message)
        self.assertIn("FORKLUCK_REQUIRE_EMAIL_VERIFICATION", message)
        self.assertIn("ACS_CONNECTION_STRING", message)

    def test_non_ascii_internal_secret_is_rejected(self):
        # secrets.compare_digest raises TypeError on non-ASCII str, which would
        # turn the internal route's designed 404 denial into a 500.
        with self.assertRaises(ImproperlyConfigured) as caught:
            reload_settings(
                {**GOOD_ENVIRONMENT, "FORKLUCK_INTERNAL_SECRET": "sécret-interne"}
            )

        self.assertIn("FORKLUCK_INTERNAL_SECRET must be ASCII", str(caught.exception))

    def test_the_guard_stands_down_only_for_the_test_subcommand(self):
        # Membership in sys.argv would let any management command that happens
        # to take "test" as an argument disarm the guard.
        with mock.patch.dict(
            os.environ,
            {"FORKLUCK_ENVIRONMENT": "production", "DATABASE_URL": "sqlite:///x"},
            clear=True,
        ):
            with mock.patch.object(
                sys, "argv", ["manage.py", "import_measures", "test"]
            ):
                sys.modules.pop("config.settings", None)
                with self.assertRaises(ImproperlyConfigured):
                    try:
                        importlib.import_module("config.settings")
                    finally:
                        sys.modules.pop("config.settings", None)

    def test_development_environment_is_not_guarded(self):
        # A bare development environment carries every value the production
        # guard rejects; it must still import. Asserting specific defaults here
        # would instead assert the contents of the developer's own backend/.env.
        settings_module = reload_settings({"FORKLUCK_ENVIRONMENT": "development"})

        self.assertEqual(settings_module.FORKLUCK_ENVIRONMENT, "development")

    def test_production_ignores_a_stray_dotenv_file(self):
        # Deployed hosts get their environment from systemd. A leftover
        # backend/.env must not be able to satisfy the guard, so plant one
        # carrying every value the guard demands and confirm it is not read.
        env_file = Path(__file__).resolve().parent.parent / ".env"
        if env_file.exists():
            self.skipTest("refusing to overwrite the developer's backend/.env")
        env_file.write_text(
            "\n".join(f"{key}={value}" for key, value in GOOD_ENVIRONMENT.items())
        )
        self.addCleanup(env_file.unlink)

        with self.assertRaises(ImproperlyConfigured) as caught:
            reload_settings(
                {
                    "FORKLUCK_ENVIRONMENT": "production",
                    "DATABASE_URL": GOOD_ENVIRONMENT["DATABASE_URL"],
                }
            )

        self.assertIn("DJANGO_SECRET_KEY", str(caught.exception))

    def _assert_rejected(self, overrides: dict[str, str], expected: str):
        environment = {**GOOD_ENVIRONMENT, **overrides}
        with self.assertRaises(ImproperlyConfigured) as caught:
            reload_settings(environment)
        self.assertIn(expected, str(caught.exception))

    def test_each_development_leftover_is_rejected_on_its_own(self):
        # One good environment, one field spoiled at a time — a guard that only
        # fires when everything is wrong at once would pass the bare-environment
        # case above while letting a single missing variable through.
        self._assert_rejected({"DJANGO_DEBUG": "1"}, "DJANGO_DEBUG")
        self._assert_rejected(
            {"DJANGO_SECRET_KEY": "dev-only-forkluck-secret"}, "DJANGO_SECRET_KEY"
        )
        self._assert_rejected({"DJANGO_SECRET_KEY": "short"}, "DJANGO_SECRET_KEY")
        self._assert_rejected({"DJANGO_SECRET_KEY": "ab" * 40}, "DJANGO_SECRET_KEY")
        self._assert_rejected(
            {"FORKLUCK_INTERNAL_SECRET": "dev-internal-secret"},
            "FORKLUCK_INTERNAL_SECRET",
        )
        self._assert_rejected(
            {"DJANGO_SECURE_COOKIES": "0"}, "DJANGO_SECURE_COOKIES"
        )
        self._assert_rejected(
            {"FORKLUCK_REQUIRE_EMAIL_VERIFICATION": "false"},
            "FORKLUCK_REQUIRE_EMAIL_VERIFICATION",
        )
        self._assert_rejected(
            {"ACS_CONNECTION_STRING": ""}, "ACS_CONNECTION_STRING"
        )
        self._assert_rejected(
            {"FORKLUCK_TOKEN_ENCRYPTION_KEY": ""}, "FORKLUCK_TOKEN_ENCRYPTION_KEY"
        )
        self._assert_rejected(
            {"FORKLUCK_TOKEN_ENCRYPTION_KEY": "not-hex"},
            "FORKLUCK_TOKEN_ENCRYPTION_KEY",
        )
        self._assert_rejected(
            {"FORKLUCK_TOKEN_ENCRYPTION_KEY": "ab" * 16},
            "FORKLUCK_TOKEN_ENCRYPTION_KEY",
        )
        self._assert_rejected(
            {"DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1"},
            "DJANGO_ALLOWED_HOSTS",
        )
        self._assert_rejected({"DJANGO_ALLOWED_HOSTS": "*"}, "DJANGO_ALLOWED_HOSTS")
        self._assert_rejected(
            {"DJANGO_ALLOWED_HOSTS": "app.forkluck.com,*"},
            "DJANGO_ALLOWED_HOSTS",
        )
        self._assert_rejected(
            {"DJANGO_CSRF_TRUSTED_ORIGINS": "http://app.forkluck.com"},
            "DJANGO_CSRF_TRUSTED_ORIGINS",
        )
        self._assert_rejected(
            {"FORKLUCK_APP_ORIGIN": "http://localhost:3000"}, "FORKLUCK_APP_ORIGIN"
        )

    def test_partial_stripe_configuration_refuses_to_start(self):
        self._assert_rejected({"STRIPE_SECRET_KEY": "sk_live_x"}, "STRIPE_SECRET_KEY")
        self._assert_rejected(
            {"STRIPE_SECRET_KEY": "sk_live_x", "STRIPE_PRICE_ID": "price_x"},
            "STRIPE_WEBHOOK_SECRET",
        )
        self._assert_rejected(
            {
                "STRIPE_SECRET_KEY": "sk_live_x",
                "STRIPE_WEBHOOK_SECRET": "whsec_x",
                "STRIPE_PRICE_ID": "price_x",
            },
            "STRIPE_PRODUCT_ID",
        )
        self._assert_rejected(
            {
                "STRIPE_SECRET_KEY": "sk_live_x",
                "STRIPE_WEBHOOK_SECRET": "whsec_x",
                "STRIPE_PRICE_ID": "price_x",
                "STRIPE_PRODUCT_ID": "prod_x",
            },
            "STRIPE_WEBHOOK_ENDPOINT_ID",
        )

    def test_partial_connector_configuration_refuses_to_start(self):
        self._assert_rejected(
            {"FORKLUCK_CONNECTOR_SERVICE_URL": "https://connectors.forkluck.com"},
            "FORKLUCK_CONNECTOR_SERVICE_URL, FORKLUCK_CONNECTOR_CLIENT_ID",
        )

    def test_connector_service_must_use_https_in_production(self):
        self._assert_rejected(
            {
                "FORKLUCK_CONNECTOR_SERVICE_URL": "http://127.0.0.1:9123",
                "FORKLUCK_CONNECTOR_CLIENT_ID": "hosted-app",
                "FORKLUCK_CONNECTOR_CLIENT_SECRET": "connector-secret",
            },
            "FORKLUCK_CONNECTOR_SERVICE_URL must use HTTPS",
        )

    def test_complete_stripe_configuration_boots_with_billing_enabled(self):
        settings_module = reload_settings(
            {
                **GOOD_ENVIRONMENT,
                "STRIPE_SECRET_KEY": "sk_live_x",
                "STRIPE_WEBHOOK_SECRET": "whsec_x",
                "STRIPE_PRICE_ID": "price_x",
                "STRIPE_PRODUCT_ID": "prod_x",
                "STRIPE_WEBHOOK_ENDPOINT_ID": "we_x",
            }
        )

        self.assertTrue(settings_module.STRIPE_BILLING_ENABLED)


class ReleasePackagingTests(SimpleTestCase):
    def test_nginx_replaces_upstream_failures_with_maintenance_response(self):
        root = REPO_ROOT
        config_name = Path("forkluck").with_suffix(".conf")
        nginx = (root / "deploy" / "nginx" / config_name).read_text(
            encoding="utf-8"
        )
        maintenance = root / "deploy" / "nginx" / "maintenance.html"

        self.assertEqual(nginx.count("error_page 502 503 504 =503"), 1)
        self.assertIn('add_header Retry-After "10" always;', nginx)
        self.assertTrue(maintenance.is_file())

    def test_nginx_ghost_site_serves_the_same_maintenance_response(self):
        # The public site is a second nginx file in front of Ghost. A Ghost
        # that is down must answer with the same 503 page as the application,
        # not nginx's bare gateway error.
        ghost = (
            REPO_ROOT
            / "deploy"
            / "nginx"
            / "forkluck-ghost.conf"
        ).read_text(encoding="utf-8")

        self.assertIn("error_page 502 503 504 =503 /maintenance.html;", ghost)
        self.assertIn('add_header Retry-After "10" always;', ghost)
        self.assertIn("proxy_pass http://127.0.0.1:2368;", ghost)

    def test_pull_requests_use_hosted_runners_without_deployment_access(self):
        # Contributor code may run, but must never reach the maintainer's
        # machine or receive production credentials through a PR workflow.
        workflows = REPO_ROOT / ".github" / "workflows"
        files = sorted(workflows.glob("*.yml"))
        self.assertTrue(files)
        for path in files:
            with self.subTest(workflow=path.name):
                text = path.read_text(encoding="utf-8")
                self.assertNotIn("pull_request_target:", text)
                if "  pull_request:" not in text:
                    continue
                self.assertIn("permissions:\n  contents: read", text)
                self.assertNotRegex(text, r"\$\{\{\s*secrets\.")
                self.assertNotIn("environment: production", text)
                runners = [line.strip() for line in text.splitlines() if "runs-on:" in line]
                self.assertTrue(runners)
                for runner in runners:
                    self.assertRegex(runner, r"^runs-on: ubuntu-[0-9]+\.[0-9]+$")

    def test_provisioning_requires_email_verification_configuration(self):
        provision = (
            REPO_ROOT / "deploy" / "provision-forkluck"
        ).read_text(encoding="utf-8")

        self.assertIn(
            "ensure_backend_env FORKLUCK_REQUIRE_EMAIL_VERIFICATION true",
            provision,
        )
        self.assertIn('ensure_backend_env ACS_CONNECTION_STRING ""', provision)

    def test_provisioning_declares_optional_google_sign_in(self):
        provision = (REPO_ROOT / "deploy" / "provision-forkluck").read_text(encoding="utf-8")
        for key in ("GOOGLE_SIGN_IN_CLIENT_ID", "GOOGLE_SIGN_IN_CLIENT_SECRET"):
            self.assertIn(f'ensure_backend_env {key} ""', provision)

    def test_provisioning_declares_optional_turnstile(self):
        provision = (REPO_ROOT / "deploy" / "provision-forkluck").read_text(encoding="utf-8")
        for key in ("TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"):
            self.assertIn(f'ensure_backend_env {key} ""', provision)

    def test_provisioning_declares_the_complete_stripe_identity(self):
        provision = (
            REPO_ROOT / "deploy" / "provision-forkluck"
        ).read_text(encoding="utf-8")

        for key in (
            "STRIPE_SECRET_KEY",
            "STRIPE_WEBHOOK_SECRET",
            "STRIPE_PRICE_ID",
            "STRIPE_PRODUCT_ID",
            "STRIPE_WEBHOOK_ENDPOINT_ID",
        ):
            self.assertIn(f'ensure_backend_env {key} ""', provision)

    def test_provisioning_declares_the_connector_service_identity(self):
        provision = (
            REPO_ROOT / "deploy" / "provision-forkluck"
        ).read_text(encoding="utf-8")

        for key in (
            "FORKLUCK_CONNECTOR_SERVICE_URL",
            "FORKLUCK_CONNECTOR_CLIENT_ID",
            "FORKLUCK_CONNECTOR_CLIENT_SECRET",
        ):
            self.assertIn(f'ensure_backend_env {key} ""', provision)

    def test_connector_worker_is_in_the_release_process_foundation(self):
        root = REPO_ROOT
        unit_name = "forkluck-connector-worker.service"
        command_name = "run_connector_sync_worker.py"
        provision = (root / "deploy" / "provision-forkluck").read_text(
            encoding="utf-8"
        )
        deploy = (root / "deploy" / "deploy-forkluck").read_text(
            encoding="utf-8"
        )
        workflow = (
            root / ".github" / "workflows" / "deploy.yml"
        ).read_text(encoding="utf-8")

        self.assertTrue((root / "deploy" / "systemd" / unit_name).is_file())
        self.assertIn(unit_name, provision)
        self.assertIn(unit_name, deploy)
        self.assertIn(command_name, deploy)
        self.assertIn(unit_name, workflow)

    def test_deploy_preflights_stripe_before_migrations_and_attests_after(self):
        deploy = (
            REPO_ROOT / "deploy" / "deploy-forkluck"
        ).read_text(encoding="utf-8")

        preflight = "validate_stripe_billing --preflight"
        migrate = "migrate --noinput"
        attest = "validate_stripe_billing --bootstrap-pending-webhook-secret"
        self.assertLess(deploy.index(preflight), deploy.index(migrate))
        self.assertLess(deploy.index(migrate), deploy.index(attest))

    def test_deploy_archive_carries_the_density_manifest(self):
        # domains/shared/density.py resolves data/volume-measures.json through
        # forkluck.paths, which walks up to the first ancestor holding data/ —
        # the release root in production — so the deploy archive must ship
        # data/ beside frontend/ and backend/, or
        # every recipe-health read on a deployed box raises at first touch.
        workflow = (
            REPO_ROOT
            / ".github"
            / "workflows"
            / "deploy.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("cp -R data release/data", workflow)
        self.assertIn("-C release frontend backend data", workflow)

    def test_deploy_loads_the_pinned_catalog_release_after_migrating(self):
        # The vendored catalog ships in data/ with the density manifest, but a
        # file on disk is not rows in the database: a release that migrates
        # without syncing leaves every new account without its starters.
        root = REPO_ROOT
        self.assertTrue((root / "data" / "catalog" / "catalog.csv").is_file())

        deploy = (root / "deploy" / "deploy-forkluck").read_text(encoding="utf-8")
        self.assertLess(
            deploy.index("migrate --noinput"), deploy.index("sync_catalog")
        )

    def test_deploy_can_restore_the_old_release_after_a_no_op_migration(self):
        deploy = (
            REPO_ROOT / "deploy" / "deploy-forkluck"
        ).read_text(encoding="utf-8")

        migration_check = "migrate --check"
        stop_services = "systemctl stop"
        migrate = "migrate --noinput"
        remember_result = 'schema_migrated="$migrations_pending"'
        restart_guard = (
            '"$services_stopped" == true && "$schema_migrated" == false'
        )

        self.assertLess(deploy.index(migration_check), deploy.index(stop_services))
        self.assertLess(deploy.index(stop_services), deploy.index(migrate))
        self.assertLess(deploy.index(migrate), deploy.index(remember_result))
        self.assertIn("migrations_pending=true", deploy)
        self.assertIn(restart_guard, deploy)

    def test_main_push_packages_and_deploys_on_hosted_runners_only(self):
        # The pull-request workflow is the verification gate: the branch
        # ruleset lets nothing onto main without its checks passing on an
        # up-to-date branch. The deploy workflow only packages and ships, and
        # never touches a self-hosted machine.
        workflow = (
            REPO_ROOT
            / ".github"
            / "workflows"
            / "deploy.yml"
        ).read_text(encoding="utf-8")
        package = workflow[
            workflow.index("\n  package:") : workflow.index("\n  deploy:")
        ]
        deploy = workflow[workflow.index("\n  deploy:") :]

        self.assertIn("push:", workflow)
        self.assertIn("- main", workflow)
        self.assertNotIn("self-hosted", workflow)
        self.assertNotIn("\n  verify:", workflow)

        # The artifact must match the Linux server: sharp and @napi-rs/canvas
        # ship platform-specific binaries.
        self.assertIn("if: github.ref == 'refs/heads/main'", package)
        self.assertIn("runs-on: ubuntu-24.04", package)
        self.assertIn("upload-artifact", package)
        self.assertNotIn("secrets.", package)

        self.assertIn("needs: [package]", deploy)
        self.assertIn("needs.package.result == 'success'", deploy)
        self.assertIn("github.ref == 'refs/heads/main'", deploy)
        self.assertIn("environment: production", deploy)

    def test_build_artifact_is_a_tarball_with_the_complete_release(self):
        workflow = (
            REPO_ROOT
            / ".github"
            / "workflows"
            / "deploy.yml"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'tar -czf "forkluck-${GITHUB_SHA}.tar.gz" -C release frontend backend data',
            workflow,
        )
        self.assertIn("name: packaged-release", workflow)
        self.assertNotIn("include-hidden-files:", workflow)

    def test_pull_request_gate_runs_the_postgres_and_browser_suites(self):
        # Since main only receives merged pull requests, the CI workflow must
        # carry every production gate: the migration chain and backend suite
        # on a Postgres that starts empty, the frontend checks and build, and
        # the browser acceptance run.
        ci = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("image: postgres:16", ci)
        self.assertIn(
            "DATABASE_URL: postgres://forkluck:forkluck@127.0.0.1:5432/forkluck_ci",
            ci,
        )
        self.assertIn("FORKLUCK_ENVIRONMENT: development", ci)
        for command in (
            "run: pnpm db:migrate",
            "run: pnpm verify:backend:checks",
            "scripts/backend-test-shard.py",
            "run: pnpm test\n",
            "run: pnpm typecheck",
            "run: pnpm lint",
            "run: pnpm format:check",
            "run: pnpm build",
            "run: pnpm test:acceptance",
        ):
            self.assertIn(command, ci)
