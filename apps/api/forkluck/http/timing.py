import logging
import time

from django.db import connection


SLOW_REQUEST_MS = 300

logger = logging.getLogger("forkluck.slow_request")


class SlowRequestMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        queries = 0
        db_ms = 0.0
        slowest_ms = 0.0
        slowest_sql = ""

        def measure(execute, sql, params, many, context):
            nonlocal queries, db_ms, slowest_ms, slowest_sql
            queries += 1
            started = time.perf_counter()
            try:
                return execute(sql, params, many, context)
            finally:
                query_ms = (time.perf_counter() - started) * 1000
                db_ms += query_ms
                if query_ms > slowest_ms:
                    slowest_ms = query_ms
                    # The statement only, never `params`: the SQL is
                    # parameterized ORM output, the params are tenant data.
                    slowest_sql = sql[:200]

        started = time.monotonic()
        with connection.execute_wrapper(measure):
            response = self.get_response(request)
        elapsed_ms = (time.monotonic() - started) * 1000
        if elapsed_ms >= SLOW_REQUEST_MS:
            logger.warning(
                "slow request %s %s %s %dms %d queries %dms db slowest %dms: %s",
                request.method,
                request.path,
                response.status_code,
                elapsed_ms,
                queries,
                db_ms,
                slowest_ms,
                slowest_sql,
            )
        return response
