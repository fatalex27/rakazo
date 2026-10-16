"""Download only public, pinned speech assets during image build, never at runtime."""
from pathlib import Path
from urllib.request import urlretrieve

from faster_whisper import download_model

root = Path("/voice/models")
root.mkdir(parents=True, exist_ok=True)
base = "https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/dmitri/medium/"
for name in ("ru_RU-dmitri-medium.onnx", "ru_RU-dmitri-medium.onnx.json", "MODEL_CARD"):
    urlretrieve(base + name, root / name)
download_model("base", output_dir=str(root / "whisper-base"), revision="ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66")
