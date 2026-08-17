#!/home/ubuntu/.cyberboss-telegram/voice-venv/bin/python
import json
import sys
from faster_whisper import WhisperModel


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: transcribe-telegram-audio.py <audio-file>")
    model = WhisperModel("base", device="cpu", compute_type="int8", cpu_threads=2)
    segments, info = model.transcribe(sys.argv[1], beam_size=1, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    print(json.dumps({"text": text, "language": info.language or "", "probability": info.language_probability or 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
