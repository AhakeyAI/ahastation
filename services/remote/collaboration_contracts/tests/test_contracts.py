import json
import unittest

from collaboration_contracts.validation import ROOT, validate_contract


class ContractTests(unittest.TestCase):
    def test_shared_cases(self):
        cases = json.loads((ROOT / "contracts/collaboration/validation-cases.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(case=case["name"]):
                self.assertEqual(validate_contract(case["contract"], case["value"])["ok"], case["valid"])

    def test_invalid_values_are_not_disclosed(self):
        result = validate_contract("deviceConfig", {"password": "test-private-value"})
        self.assertFalse(result["ok"])
        self.assertNotIn("test-private-value", json.dumps(result))

    def test_non_json_values_fail_closed(self):
        cycle = {}
        cycle["self"] = cycle
        for value in (cycle, float("nan"), float("inf"), {"x": object()}, {1: "bad"}, ("tuple",)):
            self.assertFalse(validate_contract("snapshot", value)["ok"])

    def test_success_returns_a_copy(self):
        samples = json.loads((ROOT / "contracts/collaboration/examples.json").read_text(encoding="utf-8"))
        value = samples["deviceConfig"]
        result = validate_contract("deviceConfig", value)
        self.assertTrue(result["ok"])
        result["value"]["agents"][0]["available"] = False
        self.assertTrue(value["agents"][0]["available"])


if __name__ == "__main__":
    unittest.main()
