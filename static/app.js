const tabButtons = document.querySelectorAll(".mode-tab");
const featurePanels = document.querySelectorAll(".feature-panel");

const ttsForm = document.getElementById("tts-form");
const textInput = document.getElementById("tts-text");
const voiceSelect = document.getElementById("voice");
const submitButton = document.getElementById("submit-button");
const clearButton = document.getElementById("clear-button");
const statusBox = document.getElementById("status");
const resultPanel = document.getElementById("result-panel");
const audioPlayer = document.getElementById("audio-player");
const downloadLink = document.getElementById("download-link");
const characterCount = document.getElementById("character-count");

const sttForm = document.getElementById("stt-form");
const audioFileInput = document.getElementById("audio-file");
const languageSelect = document.getElementById("language");
const startRecordingButton = document.getElementById("start-recording");
const stopRecordingButton = document.getElementById("stop-recording");
const clearSttButton = document.getElementById("clear-stt");
const transcribeButton = document.getElementById("transcribe-button");
const sttStatusBox = document.getElementById("stt-status");
const sttPreviewPanel = document.getElementById("stt-preview-panel");
const sttAudioPlayer = document.getElementById("stt-audio-player");
const recordingIndicator = document.getElementById("recording-indicator");
const transcriptPanel = document.getElementById("transcript-panel");
const transcriptOutput = document.getElementById("transcript-output");
const copyTranscriptButton = document.getElementById("copy-transcript");

let currentAudioUrl = null;
let currentSttAudioUrl = null;
let currentSttFile = null;
let activeStream = null;
let activeAudioContext = null;
let activeProcessor = null;
let bufferedSamples = [];

function switchPanel(targetId) {
    featurePanels.forEach((panel) => {
        panel.classList.toggle("active-panel", panel.id === targetId);
        panel.classList.toggle("hidden-panel", panel.id !== targetId);
    });

    tabButtons.forEach((button) => {
        button.classList.toggle("active", button.dataset.target === targetId);
    });
}

tabButtons.forEach((button) => {
    button.addEventListener("click", () => switchPanel(button.dataset.target));
});

function setStatus(element, message, tone = "") {
    element.textContent = message;
    element.className = tone ? `status ${tone}` : "status";
}

function updateCharacterCount() {
    characterCount.textContent = textInput.value.length;
}

function resetAudioResult() {
    resultPanel.classList.add("hidden");
    audioPlayer.removeAttribute("src");
    downloadLink.removeAttribute("href");

    if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
    }
}

function resetSttPreview() {
    sttPreviewPanel.classList.add("hidden");
    sttAudioPlayer.removeAttribute("src");

    if (currentSttAudioUrl) {
        URL.revokeObjectURL(currentSttAudioUrl);
        currentSttAudioUrl = null;
    }
}

function showSttPreview(file) {
    resetSttPreview();
    currentSttAudioUrl = URL.createObjectURL(file);
    sttAudioPlayer.src = currentSttAudioUrl;
    sttAudioPlayer.load();
    sttPreviewPanel.classList.remove("hidden");
}

function clearTranscript() {
    transcriptOutput.textContent = "";
    transcriptPanel.classList.add("hidden");
}

function clearTtsForm() {
    textInput.value = "";
    voiceSelect.selectedIndex = 0;
    resetAudioResult();
    setStatus(statusBox, "", "");
    updateCharacterCount();
    textInput.focus();
}

function clearSttForm() {
    audioFileInput.value = "";
    currentSttFile = null;
    resetSttPreview();
    clearTranscript();
    setStatus(sttStatusBox, "", "");
    clearSttButton.disabled = false;
    recordingIndicator.textContent = "Ready to record";
}

function mergeBuffers(chunks, totalLength) {
    const merged = new Float32Array(totalLength);
    let offset = 0;

    chunks.forEach((chunk) => {
        merged.set(chunk, offset);
        offset += chunk.length;
    });

    return merged;
}

function downsampleBuffer(buffer, inputSampleRate, targetSampleRate) {
    if (targetSampleRate >= inputSampleRate) {
        return buffer;
    }

    const sampleRateRatio = inputSampleRate / targetSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
        let accum = 0;
        let count = 0;

        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
            accum += buffer[i];
            count += 1;
        }

        result[offsetResult] = accum / count;
        offsetResult += 1;
        offsetBuffer = nextOffsetBuffer;
    }

    return result;
}

function writeString(view, offset, string) {
    for (let index = 0; index < string.length; index += 1) {
        view.setUint8(offset + index, string.charCodeAt(index));
    }
}

function floatTo16BitPCM(view, offset, input) {
    for (let index = 0; index < input.length; index += 1, offset += 2) {
        const sample = Math.max(-1, Math.min(1, input[index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
}

function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);
    floatTo16BitPCM(view, 44, samples);

    return new Blob([view], { type: "audio/wav" });
}

async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus(sttStatusBox, "This browser does not support microphone recording.", "error");
        return;
    }

    clearTranscript();
    audioFileInput.value = "";
    currentSttFile = null;
    resetSttPreview();
    setStatus(sttStatusBox, "", "");

    try {
        activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        activeAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = activeAudioContext.createMediaStreamSource(activeStream);
        activeProcessor = activeAudioContext.createScriptProcessor(4096, 1, 1);
        bufferedSamples = [];

        activeProcessor.onaudioprocess = (event) => {
            const channelData = event.inputBuffer.getChannelData(0);
            bufferedSamples.push(new Float32Array(channelData));
        };

        source.connect(activeProcessor);
        activeProcessor.connect(activeAudioContext.destination);

        startRecordingButton.disabled = true;
        stopRecordingButton.disabled = false;
        clearSttButton.disabled = true;
        recordingIndicator.textContent = "Recording...";
        setStatus(sttStatusBox, "Recording from microphone...", "loading");
    } catch (error) {
        setStatus(sttStatusBox, "Microphone access was denied or unavailable.", "error");
    }
}

async function stopRecording() {
    if (!activeAudioContext || !activeProcessor) {
        return;
    }

    const sampleRate = activeAudioContext.sampleRate;
    const totalLength = bufferedSamples.reduce((sum, chunk) => sum + chunk.length, 0);
    const mergedSamples = mergeBuffers(bufferedSamples, totalLength);
    const wavSamples = downsampleBuffer(mergedSamples, sampleRate, 16000);
    const wavBlob = encodeWav(wavSamples, 16000);
    currentSttFile = new File([wavBlob], "recording.wav", { type: "audio/wav" });
    showSttPreview(currentSttFile);

    activeProcessor.disconnect();
    activeProcessor.onaudioprocess = null;
    activeProcessor = null;

    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;

    await activeAudioContext.close();
    activeAudioContext = null;
    bufferedSamples = [];

    startRecordingButton.disabled = false;
    stopRecordingButton.disabled = true;
    clearSttButton.disabled = false;
    recordingIndicator.textContent = "Recorded audio ready";
    setStatus(sttStatusBox, "Recording finished. You can transcribe it now.", "success");
}

textInput.addEventListener("input", updateCharacterCount);
clearButton.addEventListener("click", clearTtsForm);
audioFileInput.addEventListener("change", () => {
    const [file] = audioFileInput.files;
    clearTranscript();

    if (!file) {
        currentSttFile = null;
        resetSttPreview();
        setStatus(sttStatusBox, "", "");
        return;
    }

    currentSttFile = file;
    showSttPreview(file);
    recordingIndicator.textContent = "Audio file selected";
    setStatus(sttStatusBox, "Audio file ready for transcription.", "success");
});
startRecordingButton.addEventListener("click", startRecording);
stopRecordingButton.addEventListener("click", stopRecording);
clearSttButton.addEventListener("click", clearSttForm);

copyTranscriptButton.addEventListener("click", async () => {
    const text = transcriptOutput.textContent.trim();
    if (!text) {
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        setStatus(sttStatusBox, "Transcript copied to clipboard.", "success");
    } catch (error) {
        setStatus(sttStatusBox, "Could not copy the transcript automatically.", "error");
    }
});

updateCharacterCount();

ttsForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    resetAudioResult();
    submitButton.disabled = true;
    setStatus(statusBox, "Generating speech audio...", "loading");

    try {
        const response = await fetch("/api/text-to-speech", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                text: textInput.value,
                voice: voiceSelect.value,
            }),
        });

        if (!response.ok) {
            const errorPayload = await response.json().catch(() => ({}));
            throw new Error(errorPayload.error || "Speech generation failed.");
        }

        const audioBlob = await response.blob();
        currentAudioUrl = URL.createObjectURL(audioBlob);

        audioPlayer.src = currentAudioUrl;
        downloadLink.href = currentAudioUrl;
        resultPanel.classList.remove("hidden");
        audioPlayer.load();
        setStatus(statusBox, "Speech synthesized successfully!", "success");
    } catch (error) {
        setStatus(statusBox, error.message, "error");
    } finally {
        submitButton.disabled = false;
    }
});

sttForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!currentSttFile) {
        setStatus(sttStatusBox, "Please upload or record a WAV file first.", "error");
        return;
    }

    clearTranscript();
    transcribeButton.disabled = true;
    setStatus(sttStatusBox, "Transcribing audio...", "loading");

    try {
        const formData = new FormData();
        formData.append("audio", currentSttFile);
        formData.append("language", languageSelect.value);

        const response = await fetch("/api/speech-to-text", {
            method: "POST",
            body: formData,
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || "Transcription failed.");
        }

        transcriptOutput.textContent = payload.transcript || "";
        transcriptPanel.classList.remove("hidden");
        setStatus(sttStatusBox, "Audio transcribed successfully!", "success");
    } catch (error) {
        setStatus(sttStatusBox, error.message, "error");
    } finally {
        transcribeButton.disabled = false;
    }
});
