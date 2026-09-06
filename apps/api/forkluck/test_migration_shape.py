"""One shape rule over the whole migration history.

PostgreSQL defers FK trigger work from a data pass to the end of the
transaction and then refuses the ALTER TABLE that follows it: "cannot ALTER
TABLE ... because it has pending trigger events". We have written that bug
twice (0057, then 0061). The rule is cheap to state for every migration at
once, so it is stated here instead of pinned to a pair of file names.
"""

import pkgutil
from importlib import import_module

from django.db.migrations import RunPython, RunSQL
from django.test import SimpleTestCase

from . import migrations as migrations_package

# The clean initial migration has no data pass, so no exception is needed.
ALREADY_APPLIED: set[str] = set()


class MigrationShapeTests(SimpleTestCase):
    def test_no_schema_operation_follows_a_data_operation(self):
        offenders = set()
        for module in pkgutil.iter_modules(migrations_package.__path__):
            if not module.name[0].isdigit():
                continue
            migration = import_module(
                f"{migrations_package.__name__}.{module.name}"
            ).Migration
            if getattr(migration, "atomic", True) is False:
                continue
            wrote_rows = False
            for operation in migration.operations:
                if isinstance(operation, (RunPython, RunSQL)):
                    wrote_rows = True
                elif wrote_rows:
                    offenders.add(module.name)
                    break
        self.assertEqual(
            offenders,
            ALREADY_APPLIED,
            "A schema operation follows a data operation inside one atomic "
            "migration. Put the data pass in its own numbered migration named "
            "backfill_/fix_/delete_, or set atomic = False if every operation "
            "is idempotent.",
        )
