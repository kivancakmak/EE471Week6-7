const form = document.getElementById("tts-form");
const textInput = document.getElementById("tts-text");
const voiceSelect = document.getElementById("voice");
const submitButton = document.getElementById("submit-button");
const clearButton = document.getElementById("clear-button");
const statusBox = document.getElementById("status");
const resultPanel = document.getElementById("result-panel");
const audioPlayer = document.getElementById("audio-player");
const downloadLink = document.getElementById("download-link");
const characterCount = document.getElementById("character-count");

let currentAudioUrl = null;

function setStatus(message, tone = "") {
    statusBox.textContent = message;
    statusBox.className = tone ? `status ${tone}` : "status";
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

function clearForm() {
    textInput.value = "";
    voiceSelect.selectedIndex = 0;
    resetAudioResult();
    setStatus("", "");
    updateCharacterCount();
    textInput.focus();
}

textInput.addEventListener("input", updateCharacterCount);
clearButton.addEventListener("click", clearForm);
updateCharacterCount();

form.addEventListener("submit", async (event) => {
    event.preventDefault();

    resetAudioResult();
    submitButton.disabled = true;
    setStatus("Generating speech audio...", "loading");

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
        setStatus("Speech synthesized successfully!", "success");
    } catch (error) {
        setStatus(error.message, "error");
    } finally {
        submitButton.disabled = false;
    }
});
