
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const exportBtn= document.getElementById('exportBtn');
const includeMic = document.getElementById('includeMic');
const notesEl  = document.getElementById('notes');


let recording = false;
let tabStream = null;
let micStream = null;
let mixedStream = null;    
let audioCtx = null;
let workletNode = null;
let tabSource = null;
let micSource = null;
let monitorEl = null;        


chrome.storage.local.get(['scribble_notes'], (res) => {
  notesEl.value = res.scribble_notes || '';
});
const saveNotes = debounce(() => {
  chrome.storage.local.set({ scribble_notes: notesEl.value });
}, 250);
notesEl.addEventListener('input', saveNotes);

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function uiState(isRecording) {
  startBtn.disabled = isRecording;
  stopBtn.disabled  = !isRecording;
}

async function getTabStream() {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      if (chrome.runtime.lastError || !stream) return reject(chrome.runtime.lastError || new Error('No tab stream'));
      resolve(stream);
    });
  });
}

async function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    video: false
  });
}

async function createMixedStream(tab, mic) {
  if (tab && mic) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();
    const tabSrc = ctx.createMediaStreamSource(tab);
    const micSrc = ctx.createMediaStreamSource(mic);
    tabSrc.connect(dest);
    micSrc.connect(dest);
    dest.stream.getAudioTracks()[0].addEventListener('ended', () => { try { ctx.close(); } catch {} });
    return dest.stream;
  }
  return tab || mic;
}

function encodeWavPCM16(float32Samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + float32Samples.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  const writeString = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i)); };
  const writeUint32 = (v) => { view.setUint32(offset, v, true); offset += 4; };
  const writeUint16 = (v) => { view.setUint16(offset, v, true); offset += 2; };

  writeString('RIFF');
  writeUint32(36 + float32Samples.length * 2);
  writeString('WAVE');
  writeString('fmt ');
  writeUint32(16);
  writeUint16(1);
  writeUint16(1);
  writeUint32(sampleRate);
  writeUint32(sampleRate * 2);
  writeUint16(2);
  writeUint16(16);
  writeString('data');
  writeUint32(float32Samples.length * 2);

  let idx = 0;
  for (let i = 0; i < float32Samples.length; i++, idx += 2) {
    let s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(44 + idx, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}


async function sendChunk(blob) {
  try {
    const form = new FormData();
    form.append('audio', blob, `chunk-${Date.now()}.wav`);
    const res = await fetch('http://localhost:8000/transcribe', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const line = (data?.text || '').trim();
    if (line) {
      if (notesEl.value && !notesEl.value.endsWith('\n')) notesEl.value += '\n';
      notesEl.value += line + '\n';
      saveNotes();
    }
  } catch (e) {
    console.warn('Chunk send failed:', e);
  }
}


async function startRecording() {
  if (recording) return;
  try {
   
    tabStream = await getTabStream();
    if (includeMic.checked) {
      try { micStream = await getMicStream(); } catch (e) { console.warn('Mic not granted', e); }
    }

 
    mixedStream = await createMixedStream(tabStream, micStream);


    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));


    const source = audioCtx.createMediaStreamSource(mixedStream);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture', { processorOptions: { chunkFrames: 16000 * 4 } });
    workletNode.port.onmessage = async (e) => {
      if (e.data?.type === 'chunk') {
        const wavBlob = encodeWavPCM16(e.data.samples, 16000);
        await sendChunk(wavBlob);
      }
    };
   
    source.connect(workletNode);


    monitorEl = new Audio();
    monitorEl.style.display = 'none';
    document.body.appendChild(monitorEl);
    monitorEl.srcObject = tabStream;
    monitorEl.autoplay = true;
    monitorEl.muted = false;
    monitorEl.volume = 1.0;
    try { await monitorEl.play(); } catch (err) { console.warn('monitor play failed', err); }

    
    if (micStream) {
      const micCtx = audioCtx; 
      micSource = micCtx.createMediaStreamSource(micStream);
      const micGain = micCtx.createGain();
      micGain.gain.value = 0.12;
      micSource.connect(micGain).connect(micCtx.destination);
    }

    uiState(true);
    recording = true;
  } catch (err) {
    console.error('Failed to start:', err);
    alert('Could not start capture. Start from the meeting tab and allow audio permissions.');
    await stopRecording();
  }
}

function stopRecording() {
  if (!recording) return;


  const finish = () => {
    try { workletNode?.disconnect(); } catch {}
    try { tabSource?.disconnect(); } catch {}
    try { micSource?.disconnect(); } catch {}
    try { audioCtx?.close(); } catch {}
    try {
      if (monitorEl) {
        monitorEl.pause();
        monitorEl.srcObject = null;
        monitorEl.remove();
        monitorEl = null;
      }
    } catch {}
    try { tabStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    try { micStream?.getTracks()?.forEach(t => t.stop()); } catch {}

    tabStream = micStream = mixedStream = null;
    audioCtx = workletNode = tabSource = micSource = null;

    uiState(false);
    recording = false;
  };

  if (workletNode) {
    const onFlushed = (e) => {
      if (e.data?.type === 'flushed') {
        workletNode.port.removeEventListener('message', onFlushed);
        finish();
      }
    };
    workletNode.port.addEventListener('message', onFlushed);
    try { workletNode.port.postMessage({ type: 'flush' }); } catch { finish(); }
  } else {
    finish();
  }
}


startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
clearBtn.addEventListener('click', () => { notesEl.value = ''; saveNotes(); });
exportBtn.addEventListener('click', () => {
  const blob = new Blob([notesEl.value || ''], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `scribble-notes-${Date.now()}.txt`, saveAs: true });
});


window.addEventListener('beforeunload', () => { if (recording) stopRecording(); });
