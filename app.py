import os
import tempfile
import threading
from io import BytesIO
from pathlib import Path
from typing import Dict
from xml.sax.saxutils import escape

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file

try:
    import azure.cognitiveservices.speech as speechsdk
except ModuleNotFoundError:  # pragma: no cover - depends on local env
    speechsdk = None


BASE_DIR = Path(__file__).resolve().parent
for env_path in (BASE_DIR / ".env", BASE_DIR.parent / ".env"):
    if env_path.exists():
        load_dotenv(env_path)
        break

app = Flask(__name__)

SPEECH_KEY = os.getenv("SPEECH_KEY")
SPEECH_REGION = os.getenv("SPEECH_REGION")
MAX_TEXT_LENGTH = 3000
MAX_AUDIO_BYTES = 10 * 1024 * 1024
DEFAULT_TTS_FORMAT = "audio-24khz-96kbitrate-mono-mp3"

VOICE_OPTIONS: Dict[str, str] = {
    "en-US-JennyNeural": "English (US) - Jenny",
    "en-US-GuyNeural": "English (US) - Guy",
    "en-GB-SoniaNeural": "English (UK) - Sonia",
    "tr-TR-EmelNeural": "Turkish - Emel",
    "tr-TR-AhmetNeural": "Turkish - Ahmet",
    "de-DE-KatjaNeural": "German - Katja",
    "fr-FR-DeniseNeural": "French - Denise",
}

TRANSCRIPTION_LANGUAGE_OPTIONS: Dict[str, str] = {
    "en-US": "English (US)",
    "en-GB": "English (UK)",
    "tr-TR": "Turkish",
    "de-DE": "German",
    "fr-FR": "French",
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


def synthesize_speech(
    text: str,
    voice_name: str,
    output_format: str = DEFAULT_TTS_FORMAT,
) -> bytes:
    token = get_token()
    ssml = build_ssml(text, voice_name)
    tts_url = f"https://{SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"

    response = requests.post(
        tts_url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": output_format,
            "User-Agent": "speech-studio-project",
        },
        data=ssml.encode("utf-8"),
        timeout=45,
    )
    response.raise_for_status()
    return response.content


def transcribe_audio_file(audio_path: Path, language: str) -> str:
    if speechsdk is None:
        raise RuntimeError(
            "Speech-to-text requires the azure-cognitiveservices-speech package."
        )

    speech_config = speechsdk.SpeechConfig(
        subscription=SPEECH_KEY,
        region=SPEECH_REGION,
    )
    speech_config.speech_recognition_language = language
    audio_config = speechsdk.audio.AudioConfig(filename=str(audio_path))
    recognizer = speechsdk.SpeechRecognizer(
        speech_config=speech_config,
        audio_config=audio_config,
    )

    recognized_text = []
    errors = []
    finished = threading.Event()

    def handle_recognized(event):
        result = event.result
        if result.reason == speechsdk.ResultReason.RecognizedSpeech and result.text:
            recognized_text.append(result.text.strip())

    def handle_canceled(event):
        details = "Recognition was canceled."
        result = getattr(event, "result", None)
        if result is not None:
            cancellation = speechsdk.CancellationDetails(result)
            if cancellation.error_details:
                details = cancellation.error_details
        errors.append(details)
        finished.set()

    def handle_session_end(_event):
        finished.set()

    recognizer.recognized.connect(handle_recognized)
    recognizer.canceled.connect(handle_canceled)
    recognizer.session_stopped.connect(handle_session_end)

    try:
        recognizer.start_continuous_recognition()
        finished.wait(timeout=120)
        recognizer.stop_continuous_recognition()

        if errors and not recognized_text:
            raise RuntimeError(errors[0])

        transcript = " ".join(recognized_text).strip()
        if not transcript:
            raise RuntimeError(
                "No speech was recognized. Upload a clear WAV file or record again."
            )

        return transcript
    finally:
        recognizer = None
        audio_config = None


@app.get("/")
def index():
    return render_template(
        "index.html",
        voices=VOICE_OPTIONS,
        default_voice="tr-TR-EmelNeural",
        languages=TRANSCRIPTION_LANGUAGE_OPTIONS,
        default_language="tr-TR",
        max_text_length=MAX_TEXT_LENGTH,
        max_audio_mb=MAX_AUDIO_BYTES // (1024 * 1024),
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
        return jsonify({"error": f"Azure Speech request failed. {details}"}), 502
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


@app.post("/api/speech-to-text")
def speech_to_text():
    audio_file = request.files.get("audio")
    language = request.form.get("language", "tr-TR")

    if not audio_file or not audio_file.filename:
        return jsonify({"error": "Please upload or record a WAV audio file."}), 400

    if language not in TRANSCRIPTION_LANGUAGE_OPTIONS:
        return jsonify({"error": "Please choose a valid transcription language."}), 400

    filename = audio_file.filename.lower()
    if not filename.endswith(".wav"):
        return jsonify({"error": "Only WAV audio files are supported right now."}), 400

    audio_bytes = audio_file.read()
    if not audio_bytes:
        return jsonify({"error": "The audio file is empty."}), 400

    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return (
            jsonify(
                {
                    "error": f"Audio is too large. Please keep it under {MAX_AUDIO_BYTES // (1024 * 1024)} MB."
                }
            ),
            400,
        )

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_file:
            temp_file.write(audio_bytes)
            temp_path = Path(temp_file.name)

        transcript = transcribe_audio_file(temp_path, language)
        return jsonify({"transcript": transcript})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 500
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        return (
            jsonify(
                {
                    "error": "Speech transcription failed. Use a clear WAV file and try again."
                }
            ),
            502,
        )
    finally:
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except PermissionError:
                pass


if __name__ == "__main__":
    app.run(debug=True)
