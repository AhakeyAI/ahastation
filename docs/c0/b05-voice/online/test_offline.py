import base64
import gzip
import json
import os
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from budget import BudgetError, VoiceBudget
from bench_online import safe_error
from providers import (
    AzureProvider,
    DoubaoProvider,
    XfyunAsrDecoder,
    azure_ssml,
    doubao_tts_request,
    volc_frame,
    volc_parse_frame,
    xfyun_signed_url,
    xfyun_tts_request,
)

ROOT = Path(__file__).resolve().parent


def config():
    return json.loads((ROOT / "pricing.json").read_text(encoding="utf-8"))


class BudgetTests(unittest.TestCase):
    def test_hard_cap_and_settlement(self):
        cfg = config()
        cfg["totalBudgetCny"] = "0.01"
        budget = VoiceBudget(cfg)
        reservation = budget.reserve("doubao", "tts", 20)
        self.assertEqual(budget.remaining, Decimal("0.004"))
        with self.assertRaises(BudgetError):
            budget.reserve("doubao", "tts", 20)
        budget.settle(reservation, 10)
        self.assertEqual(budget.spent, Decimal("0.003"))
        self.assertTrue(budget.summary()["separateFromClaudeAndCodex"])

    def test_exact_100_is_allowed_and_excess_fails_closed(self):
        cfg = config()
        cfg["totalBudgetCny"] = "0.0003"
        budget = VoiceBudget(cfg)
        reservation = budget.reserve("doubao", "tts", 1)
        self.assertEqual(budget.remaining, 0)
        budget.settle(reservation, 1)
        with self.assertRaises(BudgetError):
            budget.reserve("azure", "tts", 1)

    def test_unknown_price_and_unknown_usage_are_conservative(self):
        budget = VoiceBudget(config())
        with self.assertRaisesRegex(BudgetError, "no verified price"):
            budget.reserve("xfyun", "tts", 10)
        reservation = budget.reserve("doubao", "tts", 10)
        budget.settle(reservation)
        self.assertEqual(budget.spent, Decimal("0.003"))


class ProtocolTests(unittest.TestCase):
    def test_xfyun_signature_and_payload(self):
        url = xfyun_signed_url(
            "tts-api.xfyun.cn", "/v2/tts", "key", "secret", "Thu, 01 Aug 2019 01:53:21 GMT"
        )
        self.assertTrue(url.startswith("wss://tts-api.xfyun.cn/v2/tts?"))
        authorization = base64.b64decode(parse_qs(urlparse(url).query)["authorization"][0]).decode()
        self.assertIn('api_key="key"', authorization)
        self.assertIn('signature="', authorization)
        request = xfyun_tts_request("app", "中文", "voice")
        self.assertEqual(base64.b64decode(request["data"]["text"]).decode(), "中文")
        self.assertEqual(request["business"]["vcn"], "voice")

    def test_signed_url_is_redacted_from_errors(self):
        url = xfyun_signed_url("tts-api.xfyun.cn", "/v2/tts", "key", "secret")
        with patch.dict(os.environ, {"XFYUN_API_KEY": "key", "XFYUN_API_SECRET": "secret"}):
            message = safe_error(RuntimeError(f"connection failed: {url}"))
        self.assertNotIn("secret", message)
        self.assertNotIn("api_key", message)
        self.assertIn("authorization=[redacted]", message)

    def test_xfyun_asr_increment_and_replacement(self):
        decoder = XfyunAsrDecoder()
        decoder.accept({"ws": [{"cw": [{"w": "你"}]}]})
        text = decoder.accept({"pgs": "apd", "ws": [{"cw": [{"w": "好"}]}]})
        self.assertEqual(text, "你好")
        decoder.accept({"pgs": "rpl", "rg": [1, 1], "ws": [{"cw": [{"w": "您"}]}]})
        self.assertEqual(decoder.text, "您好")

    def test_doubao_binary_frame_roundtrip(self):
        payload = gzip.compress(json.dumps({"result": {"text": "你好"}}).encode())
        parsed = volc_parse_frame(volc_frame(9, 3, 1, 1, payload, sequence=-1))
        self.assertEqual(parsed["flags"], 3)
        self.assertEqual(parsed["sequence"], -1)
        self.assertEqual(json.loads(parsed["payload"])["result"]["text"], "你好")
        self.assertEqual(doubao_tts_request("文本", "speaker")["req_params"]["speaker"], "speaker")

    def test_azure_ssml_escapes_text(self):
        ssml = azure_ssml("A&B <测试>", "zh-CN-XiaoxiaoNeural")
        self.assertIn("A&amp;B &lt;测试&gt;", ssml)


class FakeResponse:
    def __init__(self, kind):
        self.kind = kind
        self.headers = {"X-Test-Log": "log"}

    def raise_for_status(self):
        return None

    def iter_content(self, size):
        yield b"RIFFfake-audio"

    def iter_lines(self, decode_unicode):
        yield json.dumps({"code": 0, "data": base64.b64encode(b"mp3").decode()})
        yield json.dumps({"code": 20000000, "data": None, "usage": {"text_words": 4}})

    def close(self):
        return None


class ProviderOfflineTests(unittest.TestCase):
    def test_azure_auth_and_audio_without_network(self):
        calls = []

        class FakeRequests:
            def post(self, url, **kwargs):
                calls.append((url, kwargs))
                return FakeResponse("azure")

        with patch("providers._requests", return_value=FakeRequests()):
            result = AzureProvider({"AZURE_SPEECH_KEY": "secret", "AZURE_SPEECH_REGION": "eastus"}).tts("测试")
        self.assertEqual(result["audioBytes"], b"RIFFfake-audio")
        self.assertEqual(calls[0][1]["headers"]["Ocp-Apim-Subscription-Key"], "secret")
        self.assertNotIn("secret", repr(result))

    def test_doubao_auth_audio_and_usage_without_network(self):
        calls = []

        class FakeRequests:
            def post(self, url, **kwargs):
                calls.append((url, kwargs))
                return FakeResponse("doubao")

        with patch("providers._requests", return_value=FakeRequests()):
            result = DoubaoProvider({"DOUBAO_API_KEY": "secret", "DOUBAO_TTS_SPEAKER": "voice"}).tts("测试")
        self.assertEqual(result["audioBytes"], b"mp3")
        self.assertEqual(result["actualUsage"], 4)
        self.assertEqual(calls[0][1]["headers"]["X-Api-Resource-Id"], "seed-tts-2.0")
        self.assertNotIn("secret", repr(result))

    def test_dry_run_makes_no_requests_and_writes_no_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "dry.json"
            env = dict(os.environ)
            env["DOUBAO_API_KEY"] = "never-write-this-secret"
            completed = subprocess.run(
                [sys.executable, str(ROOT / "bench_online.py"), "--operations", "tts",
                 "--repeat", "1", "--out", str(out)],
                cwd=ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )
            payload = json.loads(out.read_text(encoding="utf-8"))
            self.assertFalse(payload["realApiCalls"])
            self.assertEqual(payload["plannedCalls"], 9)
            self.assertNotIn("never-write-this-secret", out.read_text(encoding="utf-8"))
            self.assertIn("No network requests", payload["note"])
            self.assertIn('"realApiCalls": false', completed.stdout)


if __name__ == "__main__":
    unittest.main()
