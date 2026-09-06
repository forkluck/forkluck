import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from validate import FIELDS, validate  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEADER = ",".join(FIELDS) + "\n"
ONION = "onion,Onion,onions,,,,,110,,1 each,no,usda:170000\n"


def problems(body):
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as handle:
        handle.write(HEADER + body)
    try:
        return validate(handle.name, ROOT)
    finally:
        os.unlink(handle.name)


class ValidateTests(unittest.TestCase):
    def test_a_good_file_passes(self):
        self.assertEqual(problems(ONION + "onion,,,,,chopped,,160,1 cup,,no,usda:170000\n"), [])

    def test_verify_tags_are_allowed_alongside_allergens(self):
        body = ("ketchup,Ketchup,,nightshades,celery,,,240,1 cup,,no,x\n")
        self.assertEqual(problems(body), [])

    def test_each_rule_is_enforced(self):
        for body, fragment in [
            ("Onion,Onion,,,,,,110,,1 each,no,x\n", "must match"),
            ("onion,,,,,,,110,,1 each,no,x\n", "needs a name"),
            (ONION + "onion,Onion,,,,chopped,,160,1 cup,,no,x\n", "first row"),
            (ONION + "shallot,Shallot,,,,,,10,1 tbsp,,no,x\n" + "onion,,,,,chopped,,160,1 cup,,no,x\n", "grouped"),
            (ONION + "onion-2,onion!,,,,,,110,,1 each,no,x\n", "already used"),
            ("onion,Yellow onion,,,,,,110,,1 each,no,x\n", "Title Case"),
            ("lamb,Leg Of Lamb,,,,,,110,,1 each,no,x\n", "Title Case"),
            ("onion,Onion,,gluten,,,,110,,1 each,no,x\n", "big nine"),
            ("onion,Onion,,,gluten,,,110,,1 each,no,x\n", "verify tag"),
            ("onion,Onion,,milk,milk,,,110,,1 each,no,x\n", "both allergens and verify"),
            (ONION + "onion,,,,sulphites,chopped,,160,1 cup,,no,x\n", "first row"),
            (ONION + "onion,,,,,pulverised,,160,1 cup,,no,x\n", "preparations.txt"),
            (ONION + "onion,,,,,chopped,,-1,1 cup,,no,x\n", "above 0"),
            (ONION + "onion,,,,,peeled,0,,,,yes,\n", "(0, 1000]"),
            (ONION + "onion,,,,,chopped,,160,cup,,no,x\n", "`amount unit`"),
            (ONION + "onion,,,,,chopped,,160,1 mug,,no,x\n", "units.txt"),
            (ONION + "onion,,,,,chopped,80,160,1 cup,,no,x\n", "cannot share"),
            (ONION + "onion,,,,,chopped,,,1 cup,,no,x\n", "either grams"),
            ("onion,Onion,,,,,,110,,1 each,maybe,x\n", "estimated must"),
            ("onion,Onion,,,,,,110,,1 each,no,\n", "source is required"),
            (ONION + "onion,,,,,,,120,,1 each,no,x\n", "duplicate"),
            ("onion,Onion,,,,chopped,,160,1 cup,,no,x\n", "no Default"),
        ]:
            with self.subTest(fragment=fragment):
                self.assertTrue(any(fragment in p for p in problems(body)), problems(body))


if __name__ == "__main__":
    unittest.main()
