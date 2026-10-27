#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path

from budget import BudgetError, VoiceBudget
from providers import PROVIDERS

TEXTS = [
    "好的，我先只读看一下这个项目的说明和最近的提交，然后给你一个阶段计划。",
    "测试有三项没有通过，我建议先修复授权持久化，再处理多后端并行。",
    "这个改动需要你确认，因为它会修改设置界面的默认行为。",
]
CREDENTIALS = {
    "xfyun": ["XFYUN_APP_ID", "XFYUN_API_KEY", "XFYUN_API_SECRET", "XFYUN_TTS_SPEAKER"],
    "doubao": ["DOUBAO_API_KEY", "DOUBAO_TTS_SPEAKER"],
    "azure": ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "AZURE_TTS_VOICE"],
}


def parse_args():
    parser = argparse.ArgumentParser(description="A-08 xfyun/doubao/Azure online voice benchmark")
    parser.add_argument("--providers", nargs="+", choices=PROVIDERS, default=list(PROVIDERS))
    parser.add_argument("--operations", nargs="+", choices=["tts", "asr"], default=["tts", "asr"])
    parser.add_argument("--repeat", type=int, default=2, choices=[1, 2])
    parser.add_argument("--audio", help="16 kHz mono PCM WAV, <=60 seconds; required for ASR")
    parser.add_argument("--pricing", default=str(Path(__file__).with_name("pricing.json")))
    parser.add_argument("--out", help="result JSON; default: ../../results/online-voice-<timestamp>.json")
    parser.add_argument("--execute", action="store_true", help="make real paid API calls; default is dry-run")
    return parser.parse_args()


def audio_duration(path):
    if not path:
        return None
    with wave.open(path, "rb") as wav:
        if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("ASR fixture must be 16 kHz mono signed 16-bit PCM WAV")
        seconds = wav.getnframes() / wav.getframerate()
    if seconds <= 0 or seconds > 60:
        raise ValueError("ASR fixture duration must be >0 and <=60 seconds")
    return seconds


def safe_error(error):
    message = str(error)
    for names in CREDENTIALS.values():
        for name in names:
            secret = os.environ.get(name)
            if secret:
                message = message.replace(secret, "[redacted]")
    message = re.sub(r"(?i)(authorization=)[^&\s]+", r"\1[redacted]", message)
    return message[:500]


def main():
    args = parse_args()
    pricing_path = Path(args.pricing).resolve()
    config = json.loads(pricing_path.read_text(encoding="utf-8"))
    duration = audio_duration(args.audio) if "asr" in args.operations else None
    if "asr" in args.operations and not args.audio:
        raise ValueError("--audio is required for ASR")
    out = Path(args.out).resolve() if args.out else Path(__file__).resolve().parents[1] / "results" / (
        "online-voice-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    audio_dir = out.with_suffix("")
    budget = VoiceBudget(config, out.with_suffix(".budget.jsonl") if args.execute else None)
    planned = []
    for provider in args.providers:
        for operation in args.operations:
            for repeat_index in range(args.repeat):
                for text_index, text in enumerate(TEXTS):
                    if operation == "tts" and text_index > 0 and repeat_index > 0:
                        continue
                    quantity = len(text) if operation == "tts" else duration
                    planned.append({
                        "provider": provider,
                        "operation": operation,
                        "repeat": repeat_index,
                        "textIndex": text_index,
                        "text": text,
                        "quantity": quantity,
                    })
    base = {
        "schemaVersion": 1,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "execute" if args.execute else "dry-run",
        "realApiCalls": bool(args.execute),
        "pricing": str(pricing_path),
        "pricingSha256": hashlib.sha256(pricing_path.read_bytes()).hexdigest(),
        "audio": str(Path(args.audio).resolve()) if args.audio else None,
        "audioSeconds": duration,
        "plannedCalls": len(planned),
        "repeatNote": "repeat=0 is cold; repeat=1 is warm; providers and calls run serially",
    }
    if not args.execute:
        estimates = []
        for item in planned:
            try:
                cost = str(budget.estimate(item["provider"], item["operation"], item["quantity"]))
            except BudgetError as error:
                cost = str(error)
            estimates.append({**item, "estimatedCny": cost})
        result = {
            **base,
            "credentialsRequired": {name: CREDENTIALS[name] for name in args.providers},
            "credentialPresence": {
                name: {key: bool(os.environ.get(key)) for key in CREDENTIALS[name]}
                for name in args.providers
            },
            "plan": estimates,
            "budget": budget.summary(),
            "note": "No network requests were made. --execute is required for real calls.",
        }
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"out": str(out), "plannedCalls": len(planned), "realApiCalls": False}, ensure_ascii=False))
        return

    records = []
    budget_stopped = None
    for item in planned:
        if budget_stopped:
            records.append({"provider": item["provider"], "operation": item["operation"], "ok": False,
                            "skipped": budget_stopped})
            continue
        reservation = None
        result = None
        try:
            reservation = budget.reserve(item["provider"], item["operation"], item["quantity"])
            provider_config = config["providers"][item["provider"]]
            kwargs = {}
            if item["provider"] == "doubao":
                kwargs = {
                    "tts_resource_id": provider_config["tts"]["resourceId"],
                    "asr_resource_id": provider_config["asr"]["resourceId"],
                }
            provider = PROVIDERS[item["provider"]](**kwargs)
            if item["operation"] == "tts":
                result = provider.tts(item["text"], item["repeat"])
            else:
                result = provider.asr(args.audio, item["repeat"])
            actual = result.pop("actualUsage", None)
            quality = "reported" if actual is not None else "input-observed"
            actual = item["quantity"] if actual is None else actual
            budget.settle(reservation, actual, quality)
            reservation = None
            audio_bytes = result.pop("audioBytes", b"")
            if audio_bytes:
                audio_dir.mkdir(parents=True, exist_ok=True)
                extension = result.pop("audioExtension")
                sample_rate = result.pop("sampleRate", None)
                audio_path = audio_dir / (
                    f"{item['provider']}-{item['operation']}-r{item['repeat']}-t{item['textIndex']}.{extension}"
                )
                audio_path.write_bytes(audio_bytes)
                result["audioPath"] = str(audio_path)
                result["audioBytes"] = len(audio_bytes)
                result["audioDecodable"] = "nonempty; verify playback in A-08"
                result["sampleRate"] = sample_rate
            records.append({**item, **result, "budgetQuality": quality})
        except BudgetError as error:
            budget_stopped = safe_error(error)
            if reservation:
                budget.settle(reservation)
                reservation = None
            records.append({**item, "ok": False, "error": budget_stopped, "budgetStopped": True})
        except Exception as error:
            if reservation:
                budget.settle(reservation)
                reservation = None
            records.append({**item, "ok": False, "error": safe_error(error), "retry": "none"})
    result = {
        **base,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "results": records,
        "budget": budget.summary(),
        "budgetStopped": budget_stopped,
        "passed": all(record.get("ok") for record in records),
    }
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(out), "passed": result["passed"], "budget": result["budget"]}, ensure_ascii=False))
    if not result["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(safe_error(error), file=sys.stderr)
        sys.exit(2)
