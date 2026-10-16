"""Run inside a built image with --network none and the synthetic sample mounted."""
import io
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import wave

token = secrets.token_hex(32)
process = subprocess.Popen(["python", "server.py"], env={**os.environ, "VOICE_API_TOKEN": token})
base = "http://127.0.0.1:8000"


def request(path, data=None, content_type="application/json", authenticated=True):
    headers = {"Content-Type": content_type}
    if authenticated:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=data, headers=headers)
    return urllib.request.urlopen(req, timeout=60)


try:
    for attempt in range(100):
        if process.poll() is not None:
            raise RuntimeError("Voice process exited during startup")
        try:
            request("/health").close()
            break
        except urllib.error.URLError:
            time.sleep(0.25)
    else:
        raise RuntimeError("Voice startup timed out")

    try:
        request("/v1/voices", authenticated=False)
        raise AssertionError("Unauthenticated catalog was accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 401
    with request("/v1/voices") as response:
        voices = json.load(response)
        assert voices[0]["id"] == "orc-ru"

    start = time.monotonic()
    with request("/v1/audio/speech", json.dumps({"input": "Вождь, я слушаю. Говори, что нужно сделать. За Орду!", "voice": "orc-ru"}).encode()) as response:
        audio = response.read()
        assert response.headers.get_content_type() == "audio/wav"
    elapsed = time.monotonic() - start
    with wave.open(io.BytesIO(audio)) as wav:
        duration = wav.getnframes() / wav.getframerate()
    assert len(audio) > 10_000
    assert 1 < duration < 20
    with open("/tmp/orc-smoke.wav", "wb") as output:
        output.write(audio)

    try:
        request("/v1/audio/speech", b'{"input":"hello","voice":"unknown"}')
        raise AssertionError("Invalid voice was accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 400

    with open("/sample.wav", "rb") as sample:
        recording = sample.read()
    boundary = "rakazo-smoke-audio"
    multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + recording + f"\r\n--{boundary}--\r\n".encode())
    start_asr = time.monotonic()
    with request("/v1/audio/transcriptions", multipart, "multipart/form-data; boundary=" + boundary) as response:
        transcript = json.load(response)["text"]
    assert "слушаю" in transcript and "задачу" in transcript, transcript
    with open(f"/proc/{process.pid}/status") as status:
        rss = next(line.strip() for line in status if line.startswith("VmRSS:"))
    print(json.dumps({"tts_seconds": round(elapsed, 2), "audio_seconds": round(duration, 2), "asr_seconds": round(time.monotonic() - start_asr, 2), "memory": rss, "transcript": transcript, "auth_rejection": 401, "invalid_voice": 400}, ensure_ascii=False), flush=True)
finally:
    process.terminate()
    process.wait(timeout=10)
