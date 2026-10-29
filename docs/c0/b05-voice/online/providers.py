import base64
import gzip
import hashlib
import hmac
import json
import os
import struct
import time
import uuid
from email.utils import formatdate
from urllib.parse import urlencode
from xml.sax.saxutils import escape


def _requests():
    try:
        import requests
    except ImportError as error:
        raise RuntimeError("pip install -r requirements.txt") from error
    return requests


def _websocket():
    try:
        import websocket
    except ImportError as error:
        raise RuntimeError("pip install -r requirements.txt") from error
    return websocket


def _timed_result(provider, operation, started, **values):
    return {
        "provider": provider,
        "operation": operation,
        "ok": True,
        "totalMs": round((time.perf_counter() - started) * 1000, 3),
        "retries": 0,
        **values,
    }


def xfyun_signed_url(host, path, api_key, api_secret, date=None):
    date = date or formatdate(timeval=None, localtime=False, usegmt=True)
    origin = f"host: {host}\ndate: {date}\nGET {path} HTTP/1.1"
    signature = base64.b64encode(
        hmac.new(api_secret.encode(), origin.encode(), hashlib.sha256).digest()
    ).decode()
    authorization_origin = (
        f'api_key="{api_key}", algorithm="hmac-sha256", '
        f'headers="host date request-line", signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode()).decode()
    return f"wss://{host}{path}?" + urlencode({
        "host": host,
        "date": date,
        "authorization": authorization,
    })


def xfyun_tts_request(app_id, text, speaker):
    return {
        "common": {"app_id": app_id},
        "business": {
            "aue": "raw",
            "auf": "audio/L16;rate=16000",
            "vcn": speaker,
            "tte": "UTF8",
        },
        "data": {"status": 2, "text": base64.b64encode(text.encode()).decode()},
    }


def _xfyun_text(result):
    words = result.get("ws", [])
    return "".join(
        item.get("w", "")
        for word in words
        for item in word.get("cw", [])
    )


class XfyunAsrDecoder:
    def __init__(self):
        self.segments = []

    def accept(self, result):
        text = _xfyun_text(result)
        mode = result.get("pgs")
        if mode == "rpl":
            start, end = result.get("rg", [1, len(self.segments)])
            self.segments[start - 1:end] = [text]
        else:
            self.segments.append(text)
        return self.text

    @property
    def text(self):
        return "".join(self.segments)


class XfyunProvider:
    name = "xfyun"

    def __init__(self, environ=None):
        env = environ or os.environ
        self.app_id = env.get("XFYUN_APP_ID", "")
        self.api_key = env.get("XFYUN_API_KEY", "")
        self.api_secret = env.get("XFYUN_API_SECRET", "")
        self.speaker = env.get("XFYUN_TTS_SPEAKER", "x4_xiaoyan")
        if not all([self.app_id, self.api_key, self.api_secret]):
            raise RuntimeError("XFYUN_APP_ID, XFYUN_API_KEY and XFYUN_API_SECRET are required")

    def tts(self, text, repeat_index=0):
        started = time.perf_counter()
        ws = _websocket().create_connection(
            xfyun_signed_url("tts-api.xfyun.cn", "/v2/tts", self.api_key, self.api_secret),
            timeout=60,
        )
        audio = bytearray()
        first_packet_ms = None
        first_audio_ms = None
        sid = None
        try:
            ws.send(json.dumps(xfyun_tts_request(self.app_id, text, self.speaker)))
            while True:
                response = json.loads(ws.recv())
                now = (time.perf_counter() - started) * 1000
                first_packet_ms = first_packet_ms if first_packet_ms is not None else now
                if response.get("code") != 0:
                    raise RuntimeError(f"xfyun TTS {response.get('code')}: {response.get('message')}")
                sid = response.get("sid") or sid
                data = response.get("data") or {}
                if data.get("audio"):
                    audio.extend(base64.b64decode(data["audio"]))
                    first_audio_ms = first_audio_ms if first_audio_ms is not None else now
                if data.get("status") == 2:
                    break
        finally:
            ws.close()
        return _timed_result(
            self.name, "tts", started,
            sid=sid,
            firstPacketMs=first_packet_ms,
            firstAudioMs=first_audio_ms,
            audioBytes=bytes(audio),
            audioExtension="pcm",
            sampleRate=16000,
            actualUsage=len(text),
            logId=sid,
        )

    def asr(self, audio_path, repeat_index=0):
        started = time.perf_counter()
        ws = _websocket().create_connection(
            xfyun_signed_url("iat-api.xfyun.cn", "/v2/iat", self.api_key, self.api_secret),
            timeout=90,
        )
        decoder = XfyunAsrDecoder()
        first_packet_ms = None
        first_text_ms = None
        sid = None
        try:
            with open(audio_path, "rb") as handle:
                chunks = [chunk for chunk in iter(lambda: handle.read(3200), b"")]
            for index, chunk in enumerate(chunks):
                status = 0 if index == 0 else (2 if index == len(chunks) - 1 else 1)
                frame = {
                    "data": {
                        "status": status,
                        "format": "audio/L16;rate=16000",
                        "audio": base64.b64encode(chunk).decode(),
                        "encoding": "raw",
                    }
                }
                if status == 0:
                    frame["common"] = {"app_id": self.app_id}
                    frame["business"] = {
                        "domain": "iat",
                        "language": "zh_cn",
                        "accent": "mandarin",
                        "vad_eos": 3000,
                        "dwa": "wpgs",
                    }
                ws.send(json.dumps(frame))
            while True:
                response = json.loads(ws.recv())
                now = (time.perf_counter() - started) * 1000
                first_packet_ms = first_packet_ms if first_packet_ms is not None else now
                if response.get("code") != 0:
                    raise RuntimeError(f"xfyun ASR {response.get('code')}: {response.get('message')}")
                sid = response.get("sid") or sid
                data = response.get("data") or {}
                if data.get("result"):
                    text = decoder.accept(data["result"])
                    if text and first_text_ms is None:
                        first_text_ms = now
                if data.get("status") == 2:
                    break
        finally:
            ws.close()
        return _timed_result(
            self.name, "asr", started,
            sid=sid,
            firstPacketMs=first_packet_ms,
            firstTextMs=first_text_ms,
            text=decoder.text,
            logId=sid,
        )


def doubao_tts_request(text, speaker):
    return {
        "user": {"uid": "ahastation-a08-benchmark"},
        "req_params": {
            "text": text,
            "speaker": speaker,
            "audio_params": {"format": "mp3", "sample_rate": 24000},
        },
    }


def volc_frame(message_type, flags, serialization, compression, payload, sequence=None):
    frame = bytearray([0x11, (message_type << 4) | flags, (serialization << 4) | compression, 0])
    if sequence is not None:
        frame.extend(struct.pack(">i", sequence))
    frame.extend(struct.pack(">I", len(payload)))
    frame.extend(payload)
    return bytes(frame)


def volc_parse_frame(frame):
    header_size = (frame[0] & 0x0F) * 4
    message_type = frame[1] >> 4
    flags = frame[1] & 0x0F
    compression = frame[2] & 0x0F
    cursor = header_size
    sequence = None
    error_code = None
    if flags in (1, 3):
        sequence = struct.unpack_from(">i", frame, cursor)[0]
        cursor += 4
    if message_type == 0x0F:
        error_code = struct.unpack_from(">I", frame, cursor)[0]
        cursor += 4
    size = struct.unpack_from(">I", frame, cursor)[0]
    cursor += 4
    payload = frame[cursor:cursor + size]
    if compression == 1:
        payload = gzip.decompress(payload)
    return {
        "messageType": message_type,
        "flags": flags,
        "sequence": sequence,
        "errorCode": error_code,
        "payload": payload,
    }


class DoubaoProvider:
    name = "doubao"

    def __init__(self, environ=None, tts_resource_id="seed-tts-2.0", asr_resource_id="volc.seedasr.sauc.duration"):
        env = environ or os.environ
        self.api_key = env.get("DOUBAO_API_KEY", "")
        self.speaker = env.get("DOUBAO_TTS_SPEAKER", "")
        self.tts_resource_id = tts_resource_id
        self.asr_resource_id = asr_resource_id
        if not self.api_key:
            raise RuntimeError("DOUBAO_API_KEY is required")
        if not self.speaker:
            raise RuntimeError("DOUBAO_TTS_SPEAKER is required; use a voice authorized for seed-tts-2.0")

    def tts(self, text, repeat_index=0):
        started = time.perf_counter()
        response = _requests().post(
            "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
            headers={
                "X-Api-Key": self.api_key,
                "X-Api-Resource-Id": self.tts_resource_id,
                "X-Api-Request-Id": str(uuid.uuid4()),
                "X-Control-Require-Usage-Tokens-Return": "text_words",
            },
            json=doubao_tts_request(text, self.speaker),
            stream=True,
            timeout=(15, 90),
        )
        response.raise_for_status()
        audio = bytearray()
        first_packet_ms = None
        first_audio_ms = None
        usage = None
        try:
            for line in response.iter_lines(decode_unicode=True):
                if not line:
                    continue
                event = json.loads(line)
                now = (time.perf_counter() - started) * 1000
                first_packet_ms = first_packet_ms if first_packet_ms is not None else now
                if event.get("code") not in (0, 20000000):
                    raise RuntimeError(f"doubao TTS {event.get('code')}: {event.get('message')}")
                if event.get("data"):
                    audio.extend(base64.b64decode(event["data"]))
                    first_audio_ms = first_audio_ms if first_audio_ms is not None else now
                if event.get("usage"):
                    usage = event["usage"]
                if event.get("code") == 20000000:
                    break
        finally:
            response.close()
        return _timed_result(
            self.name, "tts", started,
            firstPacketMs=first_packet_ms,
            firstAudioMs=first_audio_ms,
            audioBytes=bytes(audio),
            audioExtension="mp3",
            sampleRate=24000,
            usage=usage,
            actualUsage=(usage or {}).get("text_words"),
            logId=response.headers.get("X-Tt-Logid"),
        )

    def asr(self, audio_path, repeat_index=0):
        started = time.perf_counter()
        request_id = str(uuid.uuid4())
        ws = _websocket().create_connection(
            "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
            header=[
                f"X-Api-Key: {self.api_key}",
                f"X-Api-Resource-Id: {self.asr_resource_id}",
                f"X-Api-Request-Id: {request_id}",
                "X-Api-Sequence: -1",
                f"X-Api-Connect-Id: {request_id}",
            ],
            timeout=90,
        )
        first_packet_ms = None
        first_text_ms = None
        text = ""
        duration_ms = None
        log_id = request_id
        try:
            initial = {
                "user": {"uid": "ahastation-a08-benchmark"},
                "audio": {"format": "wav", "rate": 16000, "bits": 16, "channel": 1},
                "request": {"model_name": "bigmodel", "enable_punc": True, "show_utterances": True},
            }
            ws.send(volc_frame(1, 0, 1, 1, gzip.compress(json.dumps(initial).encode())), opcode=_websocket().ABNF.OPCODE_BINARY)
            initial_response = volc_parse_frame(ws.recv())
            if initial_response["messageType"] == 0x0F:
                raise RuntimeError(f"doubao ASR {initial_response['errorCode']}: {initial_response['payload'].decode(errors='replace')}")
            with open(audio_path, "rb") as handle:
                chunks = [chunk for chunk in iter(lambda: handle.read(6400), b"")]
            for index, chunk in enumerate(chunks):
                ws.send(volc_frame(2, 1, 0, 1, gzip.compress(chunk), sequence=index + 1), opcode=_websocket().ABNF.OPCODE_BINARY)
                response = volc_parse_frame(ws.recv())
                now = (time.perf_counter() - started) * 1000
                first_packet_ms = first_packet_ms if first_packet_ms is not None else now
                if response["messageType"] == 0x0F:
                    raise RuntimeError(f"doubao ASR {response['errorCode']}: {response['payload'].decode(errors='replace')}")
                payload = json.loads(response["payload"] or b"{}")
                text = (payload.get("result") or {}).get("text", text)
                duration_ms = (payload.get("audio_info") or {}).get("duration", duration_ms)
                if text and first_text_ms is None:
                    first_text_ms = now
            ws.send(volc_frame(2, 2, 0, 1, gzip.compress(b"")), opcode=_websocket().ABNF.OPCODE_BINARY)
            while True:
                response = volc_parse_frame(ws.recv())
                if response["messageType"] == 0x0F:
                    raise RuntimeError(f"doubao ASR {response['errorCode']}: {response['payload'].decode(errors='replace')}")
                payload = json.loads(response["payload"] or b"{}")
                text = (payload.get("result") or {}).get("text", text)
                duration_ms = (payload.get("audio_info") or {}).get("duration", duration_ms)
                if text and first_text_ms is None:
                    first_text_ms = (time.perf_counter() - started) * 1000
                if response["flags"] == 3:
                    break
        finally:
            ws.close()
        return _timed_result(
            self.name, "asr", started,
            firstPacketMs=first_packet_ms,
            firstTextMs=first_text_ms,
            text=text,
            actualUsage=duration_ms / 1000 if duration_ms is not None else None,
            logId=log_id,
        )


def azure_ssml(text, voice):
    return (
        "<speak version='1.0' xml:lang='zh-CN'>"
        f"<voice name='{escape(voice)}'>{escape(text)}</voice></speak>"
    )


class AzureProvider:
    name = "azure"

    def __init__(self, environ=None):
        env = environ or os.environ
        self.key = env.get("AZURE_SPEECH_KEY", "")
        self.region = env.get("AZURE_SPEECH_REGION", "")
        self.voice = env.get("AZURE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
        if not self.key or not self.region:
            raise RuntimeError("AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are required")

    def tts(self, text, repeat_index=0):
        started = time.perf_counter()
        response = _requests().post(
            f"https://{self.region}.tts.speech.microsoft.com/cognitiveservices/v1",
            headers={
                "Ocp-Apim-Subscription-Key": self.key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
                "User-Agent": "ahastation-a08-benchmark",
            },
            data=azure_ssml(text, self.voice).encode(),
            stream=True,
            timeout=(15, 90),
        )
        response.raise_for_status()
        audio = bytearray()
        first_packet_ms = None
        for chunk in response.iter_content(8192):
            if not chunk:
                continue
            if first_packet_ms is None:
                first_packet_ms = (time.perf_counter() - started) * 1000
            audio.extend(chunk)
        return _timed_result(
            self.name, "tts", started,
            firstPacketMs=first_packet_ms,
            firstAudioMs=first_packet_ms,
            audioBytes=bytes(audio),
            audioExtension="wav",
            sampleRate=24000,
            actualUsage=len(text),
            logId=response.headers.get("X-MSEdge-RequestId"),
        )

    def asr(self, audio_path, repeat_index=0):
        started = time.perf_counter()
        with open(audio_path, "rb") as handle:
            audio = handle.read()
        response = _requests().post(
            f"https://{self.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1",
            params={"language": "zh-CN", "format": "simple"},
            headers={
                "Ocp-Apim-Subscription-Key": self.key,
                "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                "Accept": "application/json",
            },
            data=audio,
            timeout=(15, 90),
        )
        response.raise_for_status()
        payload = response.json()
        status = payload.get("RecognitionStatus")
        if status != "Success":
            raise RuntimeError(f"Azure ASR recognition failed: {status}")
        return _timed_result(
            self.name, "asr", started,
            firstPacketMs=None,
            firstTextMs=(time.perf_counter() - started) * 1000,
            partialResults="not-supported-by-short-audio-rest",
            text=payload.get("DisplayText", ""),
            actualUsage=None,
            logId=response.headers.get("X-MSEdge-RequestId"),
        )


PROVIDERS = {
    "xfyun": XfyunProvider,
    "doubao": DoubaoProvider,
    "azure": AzureProvider,
}
