"""B05 echo baseline: how much of the device's own TTS does its microphone hear?

Plays each TTS sample through the default speaker while recording the default
microphone, then reports:
  - echo level: RMS of the recording during playback vs. a silent baseline (dB)
  - leakage: what the local ASR transcribes from the recording (should be empty
    if the device does not "hear itself")

This is the RAW baseline with no echo cancellation. It tells us how hard the
AEC has to work on this hardware; the Chromium AEC comparison (system TTS vs.
WebAudio playback) still has to be done inside the app.

IT PLAYS SOUND THROUGH THE SPEAKER. Run it only when someone is present and
the room is quiet. Optional second pass: talk over the playback to estimate
barge-in recognition (--talk).

Usage (from the repo root, in the venv that run-n5095.ps1 created):
  %USERPROFILE%\\aha-c0\\.venv\\Scripts\\python.exe -m pip install sounddevice
  %USERPROFILE%\\aha-c0\\.venv\\Scripts\\python.exe docs\\c0\\b05-voice\\echo_test.py ^
      --models %USERPROFILE%\\aha-c0\\models ^
      --wavs docs\\c0\\results\\ahastation-20261022-2335-voice-wav ^
      --out docs\\c0\\results\\echo-<host>.json
"""
import argparse
import glob
import json
import math
import os
import platform
import time

import numpy as np
import sounddevice as sd
import soundfile as sf
import sherpa_onnx

SR = 16000


def one(pattern, d):
    hits = sorted(glob.glob(os.path.join(d, pattern)))
    return hits[0] if hits else None


def make_asr(models, threads):
    d = os.path.join(models, "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30")
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        encoder=one("encoder*.onnx", d), decoder=one("decoder*.onnx", d), joiner=one("joiner*.onnx", d),
        tokens=os.path.join(d, "tokens.txt"), num_threads=threads, sample_rate=SR, feature_dim=80,
    )


def transcribe(rec, samples):
    s = rec.create_stream()
    s.accept_waveform(SR, samples.astype(np.float32))
    s.accept_waveform(SR, np.zeros(int(0.5 * SR), dtype=np.float32))
    s.input_finished()
    while rec.is_ready(s):
        rec.decode_stream(s)
    return rec.get_result(s).strip()


def rms_db(x):
    r = float(np.sqrt(np.mean(np.square(x.astype(np.float64))))) if len(x) else 0.0
    return 20 * math.log10(r) if r > 0 else -120.0


def resample(x, src, dst):
    if src == dst:
        return x
    n = int(round(len(x) * dst / src))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--wavs", required=True, help="folder of TTS samples to play")
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--limit", type=int, default=6, help="max samples to play")
    ap.add_argument("--talk", action="store_true", help="prompt the tester to speak over playback")
    args = ap.parse_args()

    rec = make_asr(args.models, args.threads)
    print("Recording 3 s of room silence for the baseline. Stay quiet.")
    silence = sd.rec(int(3 * SR), samplerate=SR, channels=1, dtype="float32")
    sd.wait()
    base_db = rms_db(silence[:, 0])

    files = sorted(glob.glob(os.path.join(args.wavs, "*.wav")))[: args.limit]
    runs = []
    for f in files:
        audio, sr = sf.read(f, dtype="float32")
        if audio.ndim > 1:
            audio = audio[:, 0]
        if args.talk:
            input(f"\nNext: {os.path.basename(f)}. Press Enter, then read a short sentence aloud while it plays.")
        else:
            print(f"Playing {os.path.basename(f)} ...")
        tail = int(0.5 * sr)
        play = np.concatenate([audio, np.zeros(tail, dtype=np.float32)])
        recorded = sd.playrec(play, samplerate=sr, channels=1, dtype="float32", input_mapping=[1])
        sd.wait()
        mic = resample(recorded[:, 0], sr, SR)
        text = transcribe(rec, mic)
        runs.append({
            "wav": os.path.basename(f),
            "playbackSeconds": round(len(audio) / sr, 2),
            "micDb": round(rms_db(mic), 1),
            "echoOverSilenceDb": round(rms_db(mic) - base_db, 1),
            "asrText": text,
            "asrHeardSomething": bool(text),
        })
        print(f"  mic {runs[-1]['micDb']} dB (+{runs[-1]['echoOverSilenceDb']} dB over silence), ASR: {text!r}")
        time.sleep(0.5)

    result = {
        "asOf": time.strftime("%Y-%m-%d %H:%M:%S"),
        "host": {"platform": platform.platform(), "node": platform.node()},
        "mode": "talk-over" if args.talk else "echo-only",
        "aec": "none (raw device baseline)",
        "silenceDb": round(base_db, 1),
        "runs": runs,
        "summary": {
            "samples": len(runs),
            "asrLeakageRate": round(sum(r["asrHeardSomething"] for r in runs) / len(runs), 2) if runs else None,
        },
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print(f"\nwrote {args.out}")
    if not args.talk:
        print("echo-only: asrLeakageRate > 0 means the mic transcribes the device's own voice without AEC.")


if __name__ == "__main__":
    main()
