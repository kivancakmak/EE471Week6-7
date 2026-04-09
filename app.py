import os
from io import BytesIO
from pathlib import Path
from typing import Dict
from xml.sax.saxutils import escape

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file


BASE_DIR = Path(__file__).resolve().parent
for env_path in (BASE_DIR / ".env", BASE_DIR.parent / ".env"):
    if env_path.exists():
        load_dotenv(env_path)
        break

app = Flask(__name__)

SPEECH_KEY = os.getenv("SPEECH_KEY")
SPEECH_REGION = os.getenv("SPEECH_REGION")
MAX_TEXT_LENGTH = 3000
OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3"

VOICE_OPTIONS: Dict[str, str] = {
    "en-US-JennyNeural": "English (US) - Jenny",
    "en-US-GuyNeural": "English (US) - Guy",
    "en-GB-SoniaNeural": "English (UK) - Sonia",
    "tr-TR-EmelNeural": "Turkish - Emel",
    "tr-TR-AhmetNeural": "Turkish - Ahmet",
    "de-DE-KatjaNeural": "German - Katja",
    "fr-FR-DeniseNeural": "French - Denise",
}


def get_token() -> str:
    if not SPEECH_KEY or not SPEECH_REGION:
        raise ValueError("Missing SPEECH_KEY or SPEECH_REGION in .env.")

    token_url = (
        f"https://{SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken"
    )
    response = requests.post(
        token_url,
        headers={"Ocp-Apim-Subscription-Key": SPEECH_KEY},
        timeout=20,
    )
    response.raise_for_status()
    return response.text


def build_ssml(text: str, voice_name: str) -> str:
    escaped_text = escape(text)
    return (
        "<speak version='1.0' xml:lang='en-US'>"
        f"<voice name='{voice_name}'>"
        f"{escaped_text}"
        "</voice>"
        "</speak>"
    )


def synthesize_speech(text: str, voice_name: str) -> bytes:
    token = get_token()
    ssml = build_ssml(text, voice_name)
    tts_url = f"https://{SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"

    response = requests.post(
        tts_url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
            "User-Agent": "speech-studio-project",
        },
        data=ssml.encode("utf-8"),
        timeout=45,
    )
    response.raise_for_status()
    return response.content


@app.get("/")
def index():
    return render_template(
        "index.html",
        voices=VOICE_OPTIONS,
        default_voice="tr-TR-EmelNeural",
        max_text_length=MAX_TEXT_LENGTH,
    )


@app.post("/api/text-to-speech")
def text_to_speech():
    payload = request.get_json(silent=True) or {}
    raw_text = payload.get("text", "")
    text = raw_text.strip()
    voice_name = payload.get("voice", "tr-TR-EmelNeural")

    if not text:
        return jsonify({"error": "Please enter some text to convert to speech."}), 400

    if len(text) > MAX_TEXT_LENGTH:
        return (
            jsonify(
                {
                    "error": f"Text is too long. Please keep it under {MAX_TEXT_LENGTH} characters."
                }
            ),
            400,
        )

    if voice_name not in VOICE_OPTIONS:
        return jsonify({"error": "Please choose a valid voice option."}), 400

    try:
        audio_bytes = synthesize_speech(text, voice_name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 500
    except requests.HTTPError as exc:
        details = exc.response.text.strip() if exc.response is not None else str(exc)
        return (
            jsonify({"error": f"Azure Speech request failed. {details}"}),
            502,
        )
    except requests.RequestException:
        return (
            jsonify(
                {
                    "error": "Could not reach Azure Speech. Check your internet connection and region."
                }
            ),
            502,
        )

    return send_file(
        BytesIO(audio_bytes),
        mimetype="audio/mpeg",
        as_attachment=False,
        download_name="speech.mp3",
    )


if __name__ == "__main__":
    app.run(debug=True)
