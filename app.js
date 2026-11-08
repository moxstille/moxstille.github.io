const buttonRecord = document.getElementById("recordButton");
const textStatus = document.getElementById("textStatus");
const fxChainDry = document.getElementById("fxChainDry");
const eqSliders = [
    document.getElementById("eqLow"),
    document.getElementById("eqMid"),
    document.getElementById("eqHigh"),
];
const driveSlider = document.getElementById("driveSlider");
const pedalRecorder = document.getElementById("pedalRecorder");

function setStatus(status) {
    currentStatus = status;
    pedalRecorder.dataset.status = status;
}

let fxChain = ["fxChainEQ", "fxChainDist"];
let fxChainElements = new Map();
fxChain.forEach((effect) => {
    fxChainElements.set(effect, document.getElementById(effect));
});

let currentStatus = "idle";

// Web Audio API engine interface
let eng = new AudioContext();
let recorder = null;

function submitAudio(where, what) {
    if (where.src) URL.revokeObjectURL(where.src);
    where.src = URL.createObjectURL(what);
}

function recordDryBlob(stream) {
    return new Promise((resolve) => {
        recorder = new MediaRecorder(stream);
        let data = [];

        recorder.ondataavailable = (ev) => {
            data.push(ev.data);
        };

        recorder.onstop = () => {
            // Combine blobs.
            // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
            let newBlob = new Blob(data, { type: recorder.mimeType });

            data = [];

            stream.getAudioTracks().forEach((track) => {
                track.stop();
            });
            submitAudio(fxChainDry, newBlob);

            resolve(newBlob);
        };

        recorder.start();
    });
}

async function beginRecording() {
    // Acquire permission to access microphone.
    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    // TODO: handle errors
    setStatus("recording");
    let stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    textStatus.textContent = "Rec";
    let dryAudio = await recordDryBlob(stream);

    // Async because want to keep page responsive while effects are underway.
    await processFx(dryAudio);

    setStatus("idle");
    textStatus.textContent = "Idle";
}

function stopRecording() {
    setStatus("stopped");
    textStatus.textContent = "Stop";
    recorder.stop();
}

function toggleRecording() {
    switch (currentStatus) {
        case "idle":
            beginRecording();
            break;
        case "recording":
            stopRecording();
            break;
        case "stopped":
            // Wait for it...
            break;
    }
}

function processFxEq(cnt) {
    // TODO: make this better

    let frequencies = [200, 500, 1000];

    let filters = frequencies.map((freq, i) => {
        let filter = cnt.createBiquadFilter();
        filter.type = "peaking";
        filter.frequency.value = freq;
        filter.gain.value = Number(eqSliders[i].value);
        return filter;
    });

    filters[0].connect(filters[1]);
    filters[1].connect(filters[2]);

    return { input: filters[0], output: filters[2] };
}

function processFxDist(cnt) {
    let shaper = cnt.createWaveShaper();
    // Nyquist
    shaper.oversample = "4x";

    let drive = Number(driveSlider.value);
    // Bypass
    if (drive === 0) return null;

    let bufsize = 512;
    let curve = new Float32Array(bufsize);
    for (let i = 0; i < bufsize; i++) {
        let x = (i * 2) / (bufsize - 1) - 1;
        curve[i] = Math.tanh(drive * x);
    }
    shaper.curve = curve;

    return { input: shaper, output: shaper };
}

function processEffect(cnt, effect) {
    switch (effect) {
        case "fxChainEQ":
            return processFxEq(cnt);
        case "fxChainDist":
            return processFxDist(cnt);
        default:
            throw new Error();
    }
}

async function renderStage(buf, effect) {
    let cnt = new OfflineAudioContext(
        buf.numberOfChannels,
        buf.length,
        buf.sampleRate,
    );

    let node = processEffect(cnt, effect);
    if (!node) return buf;

    let source = cnt.createBufferSource();
    source.buffer = buf;
    source.connect(node.input);
    node.output.connect(cnt.destination);

    source.start();
    return await cnt.startRendering();
}

async function processFx(dryAudio) {
    if (eng.state === "suspended") {
        eng.resume();
    }

    let buffer = await eng.decodeAudioData(await dryAudio.arrayBuffer());

    for (let effect of fxChain) {
        buffer = await renderStage(buffer, effect);
        submitAudio(fxChainElements.get(effect), writeWAV(buffer));
    }
}

function writeWAV(buffer) {
    let channels = buffer.numberOfChannels;
    let dataSize = buffer.length * channels * 2;
    let view = new DataView(new ArrayBuffer(44 + dataSize));

    function writeText(offset, text) {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    }

    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, dataSize, true);

    const data = [];
    for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
        for (let c = 0; c < channels; c++) {
            const s = Math.max(-1, Math.min(1, data[c][i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            offset += 2;
        }
    }
    return new Blob([view], { type: "audio/wav" });
}

buttonRecord.addEventListener("click", toggleRecording);
