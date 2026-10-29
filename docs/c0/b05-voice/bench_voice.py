#!/usr/bin/env python3
"""B05 N5095 voice benchmark: local Chinese ASR / multi-speaker TTS RTF via sherpa-onnx.

Usage (Windows or macOS, Python 3.9+):
    python -m venv .venv && .venv/Scripts/activate   # macOS: source .venv/bin/activate
    pip install sherpa-onnx==1.13.8 numpy soundfile
    python bench_voice.py --models ./models --out ./result.json [--threads 1 2 4]

Expected layout under --models (extract official sherpa-onnx release archives as-is):
    sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30/   (ASR, streaming)
    vits-icefall-zh-aishell3/                             (TTS, 174 speakers, 8 kHz)
    kokoro-int8-multi-lang-v1_1/                          (TTS, 103 speakers, 24 kHz)
Missing model dirs are skipped and recorded as "missing".

RTF = processing time / audio duration. < 1 means faster than real time.
Only measures compute; it does not replace the B05 tests for echo, barge-in, noise and the hardware button.
"""
import argparse
import glob
import json
import os
import platform
import sys
import time

import numpy as np

try:
    import sherpa_onnx
except ImportError:
    sys.exit("pip install sherpa-onnx numpy soundfile")

ZH_SENTENCES = [
    "好的，我先只读看一下这个项目的说明和最近的提交，然后给你一个阶段计划。",
    "测试有三项没有通过，我建议先修复授权持久化，再处理多后端并行。",
    "这个改动需要你确认，因为它会修改设置界面的默认行为。",
]


def cpu_info():
    info = {"platform": platform.platform(), "machine": platform.machine(),
            "processor": platform.processor(), "cpuCount": os.cpu_count(),
            "python": sys.version.split()[0], "sherpaOnnx": getattr(sherpa_onnx, "__version__", "?")}
    if sys.platform == "win32":
        try:
            import subprocess
            info["cpuName"] = subprocess.check_output(
                ["powershell", "-NoProfile", "(Get-CimInstance Win32_Processor).Name"], text=True).strip()
        except Exception as e:  # noqa: BLE001
            info["cpuName"] = f"unknown ({e})"
    elif sys.platform == "darwin":
        import subprocess
        info["cpuName"] = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    else:
        try:
            with open("/proc/cpuinfo") as f:
                info["cpuName"] = next(l.split(":", 1)[1].strip() for l in f if l.startswith("model name"))
        except Exception:  # noqa: BLE001
            info["cpuName"] = "unknown"
    return info


def one(pattern, root):
    hits = sorted(glob.glob(os.path.join(root, pattern)))
    return hits[0] if hits else None


def one_dir(pattern, root):
    hits = sorted(h for h in glob.glob(os.path.join(root, pattern)) if os.path.isdir(h))
    return hits[0] if hits else None


def build_kokoro(d, threads):
    model = one("model*.onnx", d)
    lexicon = ",".join(p for p in [one("lexicon-us-en.txt", d), one("lexicon-zh.txt", d)] if p)
    dict_dir = os.path.join(d, "dict")
    cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=model, voices=os.path.join(d, "voices.bin"), tokens=os.path.join(d, "tokens.txt"),
            data_dir=os.path.join(d, "espeak-ng-data"), lexicon=lexicon,
            dict_dir=dict_dir if os.path.isdir(dict_dir) else ""),
        num_threads=threads),
        rule_fsts=",".join(sorted(glob.glob(os.path.join(d, "*.fst")))))
    return sherpa_onnx.OfflineTts(cfg)


def build_vits(d, threads):
    cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=one("*.onnx", d), lexicon=one("lexicon.txt", d) or "", tokens=os.path.join(d, "tokens.txt")),
        num_threads=threads),
        rule_fsts=",".join(sorted(glob.glob(os.path.join(d, "*.fst")))))
    return sherpa_onnx.OfflineTts(cfg)


def bench_tts(name, builder, d, threads, sids, out_dir):
    tts = builder(d, threads)
    runs = []
    for sid in sids:
        for i, text in enumerate(ZH_SENTENCES):
            t0 = time.perf_counter()
            audio = tts.generate(text, sid=sid, speed=1.0)
            dt = time.perf_counter() - t0
            dur = len(audio.samples) / audio.sample_rate
            runs.append({"sid": sid, "sentence": i, "seconds": round(dt, 3), "audioSeconds": round(dur, 3),
                         "rtf": round(dt / dur, 3) if dur else None})
            if i == 0 and out_dir:
                import soundfile as sf
                sf.write(os.path.join(out_dir, f"{name}-t{threads}-sid{sid}.wav"), audio.samples, audio.sample_rate)
    rtfs = [r["rtf"] for r in runs if r["rtf"]]
    # First-chunk latency matters for barge-in; report time for the shortest sentence as a proxy.
    return {"model": name, "threads": threads, "sampleRate": tts.sample_rate, "numSpeakers": tts.num_speakers,
            "rtfMean": round(float(np.mean(rtfs)), 3), "rtfMax": round(float(np.max(rtfs)), 3), "runs": runs}


def bench_asr(d, threads, wav_paths):
    rec = sherpa_onnx.OnlineRecognizer.from_transducer(
        encoder=one("encoder*.onnx", d), decoder=one("decoder*.onnx", d), joiner=one("joiner*.onnx", d),
        tokens=os.path.join(d, "tokens.txt"), num_threads=threads, sample_rate=16000, feature_dim=80,
        decoding_method="greedy_search")
    import soundfile as sf
    runs = []
    for p in wav_paths:
        samples, sr = sf.read(p, dtype="float32", always_2d=False)
        if samples.ndim > 1:
            samples = samples[:, 0]
        s = rec.create_stream()
        chunk = int(0.1 * sr)  # feed 100 ms chunks like a live mic
        t0 = time.perf_counter()
        for k in range(0, len(samples), chunk):
            s.accept_waveform(sr, samples[k:k + chunk])
            while rec.is_ready(s):
                rec.decode_stream(s)
        s.accept_waveform(sr, np.zeros(int(0.5 * sr), dtype=np.float32))
        s.input_finished()
        while rec.is_ready(s):
            rec.decode_stream(s)
        dt = time.perf_counter() - t0
        dur = len(samples) / sr
        runs.append({"wav": os.path.basename(p), "audioSeconds": round(dur, 3), "seconds": round(dt, 3),
                     "rtf": round(dt / dur, 3), "text": rec.get_result(s)})
    return {"model": os.path.basename(d.rstrip("/\\")), "threads": threads,
            "rtfMean": round(float(np.mean([r["rtf"] for r in runs])), 3) if runs else None, "runs": runs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", default="result.json")
    ap.add_argument("--threads", type=int, nargs="+", default=[1, 2, 4])
    ap.add_argument("--wav-dir", help="extra 16 kHz mono zh test wavs (default: model test_wavs)")
    args = ap.parse_args()
    out_dir = os.path.splitext(args.out)[0] + "-wav"
    os.makedirs(out_dir, exist_ok=True)
    result = {"asOf": time.strftime("%Y-%m-%d %H:%M:%S"), "host": cpu_info(), "asr": [], "tts": [], "missing": []}

    asr_dir = one_dir("sherpa-onnx-streaming-zipformer-zh-int8-*", args.models)
    if asr_dir:
        wavs = sorted(glob.glob(os.path.join(args.wav_dir or os.path.join(asr_dir, "test_wavs"), "*.wav")))
        for t in args.threads:
            result["asr"].append(bench_asr(asr_dir, t, wavs))
    else:
        result["missing"].append("sherpa-onnx-streaming-zipformer-zh-int8-*")

    for name, pattern, builder, sids in [
        ("vits-aishell3", "vits-icefall-zh-aishell3", build_vits, [10, 33, 99, 150]),
        ("kokoro-v1_1", "kokoro*multi-lang-v1_1", build_kokoro, [3, 30, 60, 90]),
    ]:
        d = one_dir(pattern, args.models)
        if not d:
            result["missing"].append(pattern)
            continue
        for t in args.threads:
            result["tts"].append(bench_tts(name, builder, d, t, sids, out_dir))

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    for r in result["asr"]:
        print(f"ASR {r['model']} t={r['threads']} RTF {r['rtfMean']}")
    for r in result["tts"]:
        print(f"TTS {r['model']} t={r['threads']} speakers={r['numSpeakers']} RTF mean {r['rtfMean']} max {r['rtfMax']}")
    print("missing:", result["missing"])


if __name__ == "__main__":
    main()
