from unittest.mock import patch

from django.http import HttpResponse
from django.test import Client, RequestFactory, TestCase

from .http import timing
from .models import User


class SlowRequestMiddlewareTests(TestCase):
    def test_request_succeeds_with_middleware_installed(self):
        response = Client().get("/api/auth/csrf")
        self.assertEqual(response.status_code, 200)

    def test_slow_request_logs_a_warning(self):
        with patch.object(timing, "SLOW_REQUEST_MS", 0):
            with self.assertLogs(timing.logger.name, "WARNING") as logs:
                Client().get("/api/auth/csrf")
        self.assertIn("slow request GET /api/auth/csrf", logs.output[0])

    def _log_line(self, get_response, path="/measured"):
        middleware = timing.SlowRequestMiddleware(get_response)
        with patch.object(timing, "SLOW_REQUEST_MS", 0):
            with self.assertLogs(timing.logger.name, "WARNING") as logs:
                response = middleware(RequestFactory().get(path))
        return response, logs.output[0]

    def test_log_line_carries_status_db_time_and_slowest_statement(self):
        def get_response(request):
            list(User.objects.filter(email="absent@example.com"))
            return HttpResponse(status=404)

        response, line = self._log_line(get_response)

        self.assertEqual(response.status_code, 404)
        self.assertIn("slow request GET /measured 404", line)
        self.assertRegex(line, r"1 queries \d+ms db slowest \d+ms: SELECT ")

    def test_query_parameters_are_never_logged(self):
        def get_response(request):
            list(User.objects.filter(email="tenant-secret@example.com"))
            return HttpResponse()

        _, line = self._log_line(get_response)

        self.assertNotIn("tenant-secret@example.com", line)
