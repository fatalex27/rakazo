"""Private CPU speech sidecar. No audio/text persistence and no outbound runtime calls."""
import io
import json
import os
import secrets
import subprocess
import threading
import wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime
from faster_whisper import WhisperModel
from piper import PiperVoice, SynthesisConfig

MAX_BODY = 9 * 1024 * 1024
MAX_SECONDS = 45
TOKEN = os.environ["VOICE_API_TOKEN"]
if len(TOKEN) < 32:
    raise ValueError("VOICE_API_TOKEN must have at least 32 characters")
onnxruntime.disable_telemetry_events()
tts = PiperVoice.load("/voice/models/ru_RU-dmitri-medium.onnx")
asr = WhisperModel("/voice/models/whisper-base", device="cpu", compute_type="int8", cpu_threads=1, local_files_only=True)
inference = threading.Lock()
slots = threading.BoundedSemaphore(4)
VOICES = [{"id": "orc-ru", "label": "Орк · русский"}, {"id": "dmitri-ru", "label": "Дмитрий · русский"}]


def convert(audio, *filters):
    return subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "pipe", "-i", "pipe:0", *filters, "pipe:1"],
        input=audio, capture_output=True, check=True, timeout=20,
    ).stdout


def speak(text, voice):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        tts.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=0.95))
    audio = output.getvalue()
    if voice == "orc-ru":
        pcm = convert(audio, "-af", "asetrate=17640,aresample=22050,atempo=1.25,highpass=f=70,lowpass=f=4500,bass=g=5:f=140,alimiter=limit=0.85", "-f", "s16le")
        result = io.BytesIO()
        with wave.open(result, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(22050)
            wav.writeframes(pcm)
        audio = result.getvalue()
    return audio


def transcribe(audio):
    pcm = convert(audio, "-t", str(MAX_SECONDS + 1), "-ac", "1", "-ar", "16000", "-f", "s16le")
    if len(pcm) > MAX_SECONDS * 16000 * 2:
        raise ValueError("Recording exceeds the supported duration")
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if not len(samples) or float(np.sqrt(np.mean(samples * samples))) < 0.002:
        return ""
    segments, _ = asr.transcribe(samples, language="ru", beam_size=1, temperature=0, condition_on_previous_text=False)
    return " ".join(segment.text.strip() for segment in segments).strip()


class Handler(BaseHTTPRequestHandler):
    timeout = 15

    def log_message(self, *args):
        pass

    def reply(self, status, body, mime="application/json"):
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        if not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            self.reply(401, {"error": "Unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        if not self.authorized():
            return
        if self.path == "/v1/voices":
            return self.reply(200, VOICES)
        self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authorized():
            return
        if not slots.acquire(blocking=False):
            return self.reply(429, {"error": "Voice server is busy"})
        try:
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.reply(400, {"error": "Invalid length"})
            if not 0 < size <= MAX_BODY:
                return self.reply(413, {"error": "Audio request is too large or empty"})
            body = self.rfile.read(size)
            if len(body) != size:
                return self.reply(400, {"error": "Incomplete request"})
            if not inference.acquire(timeout=2):
                return self.reply(429, {"error": "Voice server is busy"})
            try:
                if self.path == "/v1/audio/speech":
                    data = json.loads(body)
                    text = data.get("input")
                    voice = data.get("voice")
                    if not isinstance(text, str) or not text.strip() or len(text) > 2000 or voice not in {v["id"] for v in VOICES}:
                        return self.reply(400, {"error": "Invalid text or voice"})
                    return self.reply(200, speak(text, voice), "audio/wav")
                if self.path == "/v1/audio/transcriptions":
                    content_type = self.headers.get("Content-Type", "")
                    if not content_type.startswith("multipart/form-data;"):
                        return self.reply(400, {"error": "Expected multipart audio"})
                    message = BytesParser(policy=default).parsebytes(("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
                    audio = next((part.get_payload(decode=True) for part in message.iter_parts() if part.get_param("name", header="content-disposition") == "file"), None)
                    if not audio:
                        return self.reply(400, {"error": "Missing audio"})
                    return self.reply(200, {"text": transcribe(audio)})
                self.reply(404, {"error": "Not found"})
            finally:
                inference.release()
        except (ValueError, TypeError, AttributeError, subprocess.SubprocessError):
            self.reply(400, {"error": "Speech input could not be processed"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:  # noqa: BLE001 - HTTP boundary must not expose model errors or user audio/text.
            self.reply(500, {"error": "Local voice processing failed"})
        finally:
            slots.release()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
