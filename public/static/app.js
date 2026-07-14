/* ============================================================
 * ClipForge - 이미지 + 오디오 → 영상 자동 조립 엔진
 * 모든 처리는 브라우저에서: Canvas + WebAudio + MediaRecorder
 * ============================================================ */

const state = {
  images: [],          // { id, file, url, img(HTMLImageElement), lip: {x,y,size}|null }
  audioFile: null,
  audioBuffer: null,   // AudioBuffer (decoded)
  audioDuration: 0,
  aspect: '16:9',
  rendering: false,
  previewPlaying: false,
  resultUrl: null,
  lipEnvelope: null,   // Float32Array 음량 엔벨로프 (립싱크용)
  lipEnvFps: 60,
};

const $ = (id) => document.getElementById(id);

const els = {
  imageDrop: $('image-drop'), imageInput: $('image-input'), imageList: $('image-list'),
  audioDrop: $('audio-drop'), audioInput: $('audio-input'), audioInfo: $('audio-info'),
  audioName: $('audio-name'), audioDuration: $('audio-duration'),
  audioWaveform: $('audio-waveform'), audioPlayBtn: $('audio-play-btn'), audioRemove: $('audio-remove'),
  canvas: $('preview-canvas'), canvasWrap: $('canvas-wrap'), placeholder: $('canvas-placeholder'),
  btnGenerate: $('btn-generate'), btnPreview: $('btn-preview'),
  renderOverlay: $('render-overlay'), renderProgress: $('render-progress'), renderBar: $('render-bar'),
  resultPanel: $('result-panel'), resultVideo: $('result-video'),
  btnDownload: $('btn-download'), btnRegenerate: $('btn-regenerate'),
  timeline: $('timeline'), timelineTrack: $('timeline-track'), timelineTotal: $('timeline-total'),
  motionSelect: $('motion-select'), transitionSelect: $('transition-select'),
  visualizerSelect: $('visualizer-select'), resolutionSelect: $('resolution-select'),
  subtitleInput: $('subtitle-input'), subtitlePos: $('subtitle-pos'), subtitleColor: $('subtitle-color'),
  lipEnable: $('lip-enable'), lipIntensity: $('lip-intensity'), lipIntensityVal: $('lip-intensity-val'),
  lipModal: $('lip-modal'), lipCanvas: $('lip-canvas'), lipClose: $('lip-close'),
  lipSize: $('lip-size'), lipTest: $('lip-test'), lipClear: $('lip-clear'), lipSave: $('lip-save'),
};

let audioCtx = null;
let previewAudio = null; // HTMLAudioElement for simple playback

/* ---------------- 업로드 처리 ---------------- */

function setupDropZone(zone, input, handler) {
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => handler(e.target.files));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    handler(e.dataTransfer.files);
  });
}

setupDropZone(els.imageDrop, els.imageInput, handleImageFiles);
setupDropZone(els.audioDrop, els.audioInput, handleAudioFile);

async function handleImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    state.images.push({ id: crypto.randomUUID(), file, url, img, lip: null });
  }
  els.imageInput.value = '';
  renderImageList();
  updateUI();
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

async function handleAudioFile(files) {
  const file = files[0];
  if (!file || !file.type.startsWith('audio/')) {
    if (file) alert('오디오 파일만 업로드할 수 있어요.');
    return;
  }
  state.audioFile = file;
  els.audioInput.value = '';

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const arrayBuf = await file.arrayBuffer();
  try {
    state.audioBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));
  } catch (e) {
    alert('오디오 디코딩 실패: 지원하지 않는 형식이에요.');
    state.audioFile = null;
    return;
  }
  state.audioDuration = state.audioBuffer.duration;
  state.lipEnvelope = computeEnvelope(state.audioBuffer, state.lipEnvFps);

  // 재생용 엘리먼트
  if (previewAudio) { previewAudio.pause(); URL.revokeObjectURL(previewAudio.src); }
  previewAudio = new Audio(URL.createObjectURL(file));

  els.audioName.textContent = file.name;
  els.audioDuration.textContent = formatTime(state.audioDuration) + ' · ' + (file.size / 1024 / 1024).toFixed(2) + ' MB';
  els.audioInfo.classList.remove('hidden');
  els.audioDrop.classList.add('hidden');
  drawWaveform();
  updateUI();
}

els.audioRemove.addEventListener('click', () => {
  if (previewAudio) previewAudio.pause();
  state.audioFile = null;
  state.audioBuffer = null;
  state.audioDuration = 0;
  els.audioInfo.classList.add('hidden');
  els.audioDrop.classList.remove('hidden');
  updateUI();
});

els.audioPlayBtn.addEventListener('click', () => {
  if (!previewAudio) return;
  const icon = els.audioPlayBtn.querySelector('i');
  if (previewAudio.paused) {
    previewAudio.play();
    icon.className = 'fas fa-pause text-xs';
    previewAudio.onended = () => icon.className = 'fas fa-play text-xs';
  } else {
    previewAudio.pause();
    icon.className = 'fas fa-play text-xs';
  }
});

function drawWaveform() {
  const canvas = els.audioWaveform;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext('2d');
  const data = state.audioBuffer.getChannelData(0);
  const bars = 120;
  const step = Math.floor(data.length / bars);
  const w = canvas.width / bars;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = 0; j < step; j += 32) peak = Math.max(peak, Math.abs(data[i * step + j]));
    const h = Math.max(2, peak * canvas.height * 0.9);
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#7c6cff');
    grad.addColorStop(1, '#4de3e0');
    ctx.fillStyle = grad;
    ctx.fillRect(i * w + w * 0.15, (canvas.height - h) / 2, w * 0.7, h);
  }
}

/* ---------------- 립싱크: 음량 엔벨로프 추출 ---------------- */

// 오디오에서 시간별 음량(RMS) 엔벨로프를 미리 계산 → 미리보기/렌더 동일한 입 움직임 보장
function computeEnvelope(buffer, fps) {
  const data = buffer.getChannelData(0);
  const frames = Math.max(1, Math.ceil(buffer.duration * fps));
  const win = Math.max(1, Math.floor(data.length / frames));
  const raw = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0, cnt = 0;
    const start = i * win;
    for (let j = 0; j < win; j += 8) { const v = data[start + j] || 0; sum += v * v; cnt++; }
    raw[i] = Math.sqrt(sum / Math.max(1, cnt));
  }
  // 95 퍼센타일로 정규화 (피크 왜곡 방지)
  const sorted = Array.from(raw).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const env = new Float32Array(frames);
  let prev = 0;
  for (let i = 0; i < frames; i++) {
    let v = Math.min(1, raw[i] / (ref || 1));
    v = Math.pow(v, 0.7); // 작은 소리도 입이 반응하도록 감마 보정
    // 빠른 어택 / 느린 디케이 → 자연스러운 입 움직임
    prev = v > prev ? prev + (v - prev) * 0.55 : prev + (v - prev) * 0.28;
    env[i] = prev;
  }
  return env;
}

function envAt(t) {
  if (!state.lipEnvelope) return 0;
  const i = Math.min(state.lipEnvelope.length - 1, Math.max(0, Math.floor(t * state.lipEnvFps)));
  return state.lipEnvelope[i];
}

/* ---------------- 이미지 목록 (정렬/삭제) ---------------- */

let dragSrcIdx = null;

function renderImageList() {
  els.imageList.innerHTML = '';
  state.images.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'img-thumb';
    div.draggable = true;
    div.innerHTML = `
      <img src="${item.url}" alt="이미지 ${idx + 1}">
      <span class="idx-badge">${idx + 1}</span>
      <button class="lip-btn ${item.lip ? 'lip-set' : ''}" title="립싱크 입 위치 지정"><i class="fas fa-face-grin-wide"></i></button>
      <button class="remove-btn"><i class="fas fa-xmark"></i></button>`;
    div.querySelector('.lip-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openLipEditor(idx);
    });
    div.querySelector('.remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      URL.revokeObjectURL(item.url);
      state.images.splice(idx, 1);
      renderImageList();
      updateUI();
    });
    div.addEventListener('dragstart', () => { dragSrcIdx = idx; div.classList.add('drag-src'); });
    div.addEventListener('dragend', () => div.classList.remove('drag-src'));
    div.addEventListener('dragover', (e) => e.preventDefault());
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragSrcIdx === null || dragSrcIdx === idx) return;
      const [moved] = state.images.splice(dragSrcIdx, 1);
      state.images.splice(idx, 0, moved);
      dragSrcIdx = null;
      renderImageList();
      updateUI();
    });
    els.imageList.appendChild(div);
  });
}

/* ---------------- UI 갱신 ---------------- */

document.querySelectorAll('.aspect-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.aspect-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.aspect = btn.dataset.aspect;
    const [w, h] = state.aspect.split(':').map(Number);
    els.canvasWrap.style.aspectRatio = `${w}/${h}`;
    updateUI();
  });
});

function getCanvasSize() {
  const base = parseInt(els.resolutionSelect.value, 10);
  const [aw, ah] = state.aspect.split(':').map(Number);
  if (aw >= ah) return { w: base, h: Math.round(base * ah / aw / 2) * 2 };
  return { w: Math.round(base * aw / ah / 2) * 2, h: base };
}

function updateUI() {
  const ready = state.images.length > 0 && state.audioBuffer;
  els.btnGenerate.disabled = !ready || state.rendering;
  els.btnPreview.disabled = !ready || state.rendering;

  if (state.images.length > 0) {
    els.placeholder.classList.add('hidden');
    drawStaticPreview();
  } else {
    els.placeholder.classList.remove('hidden');
    const ctx = els.canvas.getContext('2d');
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  }
  renderTimeline();
}

function drawStaticPreview() {
  const { w, h } = getCanvasSize();
  els.canvas.width = w;
  els.canvas.height = h;
  const ctx = els.canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (state.images[0]) drawImageCover(ctx, state.images[0].img, w, h, 1, 0, 0);
  drawSubtitle(ctx, w, h);
}

function renderTimeline() {
  if (state.images.length === 0 || !state.audioBuffer) {
    els.timeline.classList.add('hidden');
    return;
  }
  els.timeline.classList.remove('hidden');
  els.timelineTotal.textContent = '총 ' + formatTime(state.audioDuration);
  els.timelineTrack.innerHTML = '';
  const per = state.audioDuration / state.images.length;
  state.images.forEach((item, i) => {
    const seg = document.createElement('div');
    seg.className = 'tl-seg';
    seg.style.flex = '1';
    seg.style.backgroundImage = `url(${item.url})`;
    seg.innerHTML = `<span>${formatTime(per)}</span>`;
    els.timelineTrack.appendChild(seg);
  });
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------------- 렌더링 코어 (프레임 그리기) ---------------- */

// 이미지를 cover 방식으로 그리되 zoom/panX/panY 적용. 그린 영역 지오메트리 반환 (립싱크 좌표 매핑용)
function drawImageCover(ctx, img, cw, ch, zoom, panX, panY) {
  const ir = img.width / img.height;
  const cr = cw / ch;
  let dw, dh;
  if (ir > cr) { dh = ch * zoom; dw = dh * ir; }
  else { dw = cw * zoom; dh = dw / ir; }
  const maxPanX = (dw - cw) / 2;
  const maxPanY = (dh - ch) / 2;
  const x = (cw - dw) / 2 + panX * maxPanX;
  const y = (ch - dh) / 2 + panY * maxPanY;
  ctx.drawImage(img, x, y, dw, dh);
  return { x, y, dw, dh };
}

/* ---------------- 립싱크 입 렌더링 ---------------- */

// geom: drawImageCover 반환값, lip: {x,y,size} (이미지 기준 정규화 좌표), openness: 0~1
function drawMouth(ctx, geom, lip, openness) {
  if (openness < 0.05) return;
  const alpha = Math.min(1, (openness - 0.05) / 0.1);
  const mx = geom.x + lip.x * geom.dw;
  const my = geom.y + lip.y * geom.dh;
  const mw = lip.size * geom.dw;            // 입 너비
  const mh = mw * 0.65 * openness;          // 벌어진 높이

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(mx, my + mh * 0.18);

  // 입 주변 블렌딩 (부드러운 외곽)
  let g = ctx.createRadialGradient(0, 0, mw * 0.1, 0, 0, mw * 0.75);
  g.addColorStop(0, 'rgba(70,25,25,0.55)');
  g.addColorStop(0.55, 'rgba(90,40,38,0.28)');
  g.addColorStop(1, 'rgba(90,40,38,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, mw * 0.72, Math.max(2, mh * 0.9 + mw * 0.1), 0, 0, Math.PI * 2);
  ctx.fill();

  // 입 내부 (어두운 구강)
  g = ctx.createRadialGradient(0, mh * 0.1, 1, 0, 0, mw * 0.55);
  g.addColorStop(0, '#2a0f12');
  g.addColorStop(0.75, '#4a1a1e');
  g.addColorStop(1, '#6e3034');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, mw * 0.5, Math.max(1.5, mh * 0.5), 0, 0, Math.PI * 2);
  ctx.fill();

  // 윗니 (크게 벌릴 때만)
  if (openness > 0.3) {
    const teethA = Math.min(1, (openness - 0.3) / 0.25);
    ctx.globalAlpha = alpha * teethA * 0.95;
    ctx.fillStyle = '#e8e0d8';
    ctx.beginPath();
    ctx.ellipse(0, -mh * 0.32, mw * 0.36, Math.max(1, mh * 0.18), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 혀 (아주 크게 벌릴 때)
  if (openness > 0.5) {
    const tA = Math.min(1, (openness - 0.5) / 0.3);
    ctx.globalAlpha = alpha * tA * 0.85;
    ctx.fillStyle = '#a04a50';
    ctx.beginPath();
    ctx.ellipse(0, mh * 0.3, mw * 0.3, Math.max(1, mh * 0.22), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 아랫입술 하이라이트
  ctx.globalAlpha = alpha * 0.5;
  ctx.strokeStyle = 'rgba(150,70,68,0.8)';
  ctx.lineWidth = Math.max(1, mw * 0.045);
  ctx.beginPath();
  ctx.ellipse(0, 0, mw * 0.5, Math.max(1.5, mh * 0.5), 0, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  ctx.restore();
}

function getLipOpenness(t) {
  if (!els.lipEnable.checked) return 0;
  const intensity = parseFloat(els.lipIntensity.value);
  return Math.min(1, envAt(t) * intensity);
}

// 세그먼트별 모션 파라미터 결정
function getMotionParams(idx) {
  let mode = els.motionSelect.value;
  if (mode === 'kenburns') {
    const modes = ['zoomin', 'zoomout', 'panlr', 'panrl'];
    mode = modes[idx % modes.length];
  }
  switch (mode) {
    case 'zoomin':  return { z0: 1.0, z1: 1.18, px0: 0, px1: 0, py0: 0, py1: 0 };
    case 'zoomout': return { z0: 1.18, z1: 1.0, px0: 0, px1: 0, py0: 0, py1: 0 };
    case 'panlr':   return { z0: 1.15, z1: 1.15, px0: -1, px1: 1, py0: 0, py1: 0 };
    case 'panrl':   return { z0: 1.15, z1: 1.15, px0: 1, px1: -1, py0: 0, py1: 0 };
    default:        return { z0: 1.0, z1: 1.0, px0: 0, px1: 0, py0: 0, py1: 0 };
  }
}

const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/**
 * 시각 t(초)의 프레임을 ctx에 그린다.
 * freqData: Uint8Array | null (비주얼라이저용)
 */
function drawFrame(ctx, w, h, t, total, freqData) {
  const n = state.images.length;
  const per = total / n;
  const transition = els.transitionSelect.value;
  const TRANS = transition === 'cut' ? 0 : Math.min(0.8, per * 0.25);

  let idx = Math.min(n - 1, Math.floor(t / per));
  const segT = t - idx * per;
  const prog = easeInOut(Math.min(1, segT / per));

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  // 현재 세그먼트
  const m = getMotionParams(idx);
  const z = m.z0 + (m.z1 - m.z0) * prog;
  const px = m.px0 + (m.px1 - m.px0) * prog;
  const py = m.py0 + (m.py1 - m.py0) * prog;
  ctx.globalAlpha = 1;
  const geom = drawImageCover(ctx, state.images[idx].img, w, h, z, px, py);

  // 립싱크: 현재 이미지에 입 위치가 지정되어 있으면 음량에 맞춰 입 그리기
  if (state.images[idx].lip) {
    drawMouth(ctx, geom, state.images[idx].lip, getLipOpenness(t));
  }

  // 다음 세그먼트로의 전환
  if (idx < n - 1 && TRANS > 0 && segT > per - TRANS) {
    const tt = (segT - (per - TRANS)) / TRANS; // 0→1
    const nm = getMotionParams(idx + 1);
    const nz = nm.z0;
    ctx.save();
    if (transition === 'fade') {
      ctx.globalAlpha = tt;
      drawImageCover(ctx, state.images[idx + 1].img, w, h, nz, nm.px0, nm.py0);
    } else if (transition === 'slide') {
      ctx.globalAlpha = 1;
      ctx.translate(w * (1 - easeInOut(tt)), 0);
      drawImageCover(ctx, state.images[idx + 1].img, w, h, nz, nm.px0, nm.py0);
    } else if (transition === 'zoom') {
      ctx.globalAlpha = tt;
      const zz = 1.6 - 0.6 * easeInOut(tt);
      drawImageCover(ctx, state.images[idx + 1].img, w, h, nz * zz, nm.px0, nm.py0);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawVisualizer(ctx, w, h, freqData);
  drawSubtitle(ctx, w, h);

  // 인트로/아웃트로 페이드 (0.5초)
  const FADE = 0.5;
  let fade = 0;
  if (t < FADE) fade = 1 - t / FADE;
  if (t > total - FADE) fade = (t - (total - FADE)) / FADE;
  if (fade > 0) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(1, fade)})`;
    ctx.fillRect(0, 0, w, h);
  }
}

function drawVisualizer(ctx, w, h, freqData) {
  const type = els.visualizerSelect.value;
  if (type === 'none' || !freqData) return;

  const bins = 48;
  const step = Math.floor(freqData.length * 0.7 / bins);

  if (type === 'bars') {
    const bw = w / bins;
    for (let i = 0; i < bins; i++) {
      const v = freqData[i * step] / 255;
      const bh = v * h * 0.22;
      const grad = ctx.createLinearGradient(0, h - bh, 0, h);
      grad.addColorStop(0, 'rgba(77,227,224,0.9)');
      grad.addColorStop(1, 'rgba(124,108,255,0.5)');
      ctx.fillStyle = grad;
      ctx.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
    }
  } else if (type === 'wave') {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(77,227,224,0.85)';
    ctx.lineWidth = Math.max(2, h * 0.004);
    for (let i = 0; i < bins; i++) {
      const v = freqData[i * step] / 255;
      const x = (i / (bins - 1)) * w;
      const y = h * 0.85 - v * h * 0.12;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (type === 'circle') {
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) * 0.28;
    ctx.save();
    ctx.strokeStyle = 'rgba(77,227,224,0.8)';
    ctx.lineWidth = Math.max(2, h * 0.005);
    for (let i = 0; i < bins; i++) {
      const v = freqData[i * step] / 255;
      const ang = (i / bins) * Math.PI * 2 - Math.PI / 2;
      const r2 = r + v * Math.min(w, h) * 0.12;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawSubtitle(ctx, w, h) {
  const text = els.subtitleInput.value.trim();
  if (!text) return;
  const pos = els.subtitlePos.value;
  const color = els.subtitleColor.value;
  const fontSize = Math.round(h * 0.055);
  ctx.save();
  ctx.font = `700 ${fontSize}px 'Pretendard', 'Malgun Gothic', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let y = pos === 'top' ? h * 0.12 : pos === 'center' ? h * 0.5 : h * 0.86;

  // 반투명 배경 박스
  const metrics = ctx.measureText(text);
  const pad = fontSize * 0.5;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, w / 2 - metrics.width / 2 - pad, y - fontSize * 0.75, metrics.width + pad * 2, fontSize * 1.5, fontSize * 0.3);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;
  ctx.fillText(text, w / 2, y);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------- 미리보기 재생 ---------------- */

let previewRAF = null;

els.btnPreview.addEventListener('click', async () => {
  if (state.previewPlaying) { stopPreview(); return; }
  state.previewPlaying = true;
  els.btnPreview.innerHTML = '<i class="fas fa-stop mr-1"></i> 정지';

  const { w, h } = getCanvasSize();
  els.canvas.width = w;
  els.canvas.height = h;
  const ctx = els.canvas.getContext('2d');

  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const source = audioCtx.createBufferSource();
  source.buffer = state.audioBuffer;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  const freqData = new Uint8Array(analyser.frequencyBinCount);

  const total = state.audioDuration;
  const startAt = audioCtx.currentTime;
  source.start();
  state._previewSource = source;

  const loop = () => {
    if (!state.previewPlaying) return;
    const t = audioCtx.currentTime - startAt;
    if (t >= total) { stopPreview(); return; }
    analyser.getByteFrequencyData(freqData);
    drawFrame(ctx, w, h, t, total, freqData);
    previewRAF = requestAnimationFrame(loop);
  };
  loop();

  source.onended = () => { if (state.previewPlaying) stopPreview(); };
});

function stopPreview() {
  state.previewPlaying = false;
  if (previewRAF) cancelAnimationFrame(previewRAF);
  try { state._previewSource && state._previewSource.stop(); } catch (e) {}
  els.btnPreview.innerHTML = '<i class="fas fa-play mr-1"></i> 미리보기 재생';
  drawStaticPreview();
}

/* ---------------- 영상 생성 (MediaRecorder) ---------------- */

els.btnGenerate.addEventListener('click', generateVideo);
els.btnRegenerate.addEventListener('click', () => {
  els.resultPanel.classList.add('hidden');
  generateVideo();
});

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function generateVideo() {
  if (state.rendering) return;
  stopPreview();
  state.rendering = true;
  updateUI();
  els.renderOverlay.classList.remove('hidden');
  els.renderOverlay.classList.add('flex');

  try {
    const { w, h } = getCanvasSize();
    // 오프스크린 렌더 캔버스 (프리뷰 캔버스와 분리)
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // 오디오 그래프: source → analyser → dest(stream) 
    const source = audioCtx.createBufferSource();
    source.buffer = state.audioBuffer;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(analyser);
    analyser.connect(dest);
    const freqData = new Uint8Array(analyser.frequencyBinCount);

    // 캔버스 스트림 + 오디오 트랙 결합
    const fps = 30;
    const canvasStream = canvas.captureStream(fps);
    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(combined, {
      mimeType,
      videoBitsPerSecond: w >= 1920 ? 8_000_000 : 5_000_000,
      audioBitsPerSecond: 192_000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const total = state.audioDuration;
    const done = new Promise((res) => recorder.onstop = res);

    // 첫 프레임 먼저 그리고 시작
    drawFrame(ctx, w, h, 0, total, null);
    recorder.start(1000);
    const startAt = audioCtx.currentTime;
    source.start();

    // 실시간 렌더 루프
    await new Promise((resolve) => {
      const loop = () => {
        const t = audioCtx.currentTime - startAt;
        if (t >= total) { resolve(); return; }
        analyser.getByteFrequencyData(freqData);
        drawFrame(ctx, w, h, t, total, freqData);
        const pct = Math.min(100, Math.round(t / total * 100));
        els.renderProgress.textContent = pct + '% (' + formatTime(t) + ' / ' + formatTime(total) + ')';
        els.renderBar.style.width = pct + '%';
        requestAnimationFrame(loop);
      };
      loop();
    });

    try { source.stop(); } catch (e) {}
    recorder.stop();
    await done;

    const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = URL.createObjectURL(blob);

    els.resultVideo.src = state.resultUrl;
    const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    els.btnDownload.href = state.resultUrl;
    els.btnDownload.download = `clipforge_${Date.now()}.${ext}`;
    els.resultPanel.classList.remove('hidden');
    els.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    alert('영상 생성 중 오류가 발생했어요: ' + err.message);
  } finally {
    state.rendering = false;
    els.renderOverlay.classList.add('hidden');
    els.renderOverlay.classList.remove('flex');
    els.renderBar.style.width = '0%';
    updateUI();
  }
}

/* ---------------- 립싱크 에디터 모달 ---------------- */

const lipEditor = {
  idx: -1,
  lip: null,        // 편집 중 임시 값 {x,y,size}
  testing: false,
  testSource: null,
  testRAF: null,
};

function openLipEditor(idx) {
  lipEditor.idx = idx;
  const item = state.images[idx];
  lipEditor.lip = item.lip
    ? { ...item.lip }
    : { x: 0.5, y: 0.62, size: 0.08 };
  els.lipSize.value = lipEditor.lip.size;

  // 캔버스 크기: 모달 폭에 맞춰 이미지 비율 유지
  const maxW = Math.min(620, window.innerWidth - 80);
  const maxH = Math.min(460, window.innerHeight * 0.5);
  const scale = Math.min(maxW / item.img.width, maxH / item.img.height, 1);
  els.lipCanvas.width = Math.round(item.img.width * scale);
  els.lipCanvas.height = Math.round(item.img.height * scale);

  els.lipModal.classList.remove('hidden');
  els.lipModal.classList.add('flex');
  drawLipEditor(0);
}

function drawLipEditor(openness) {
  const item = state.images[lipEditor.idx];
  const cv = els.lipCanvas;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(item.img, 0, 0, cv.width, cv.height);
  const geom = { x: 0, y: 0, dw: cv.width, dh: cv.height };

  if (openness > 0.05) {
    drawMouth(ctx, geom, lipEditor.lip, openness);
  }

  // 가이드 마커 (테스트 중에는 숨김)
  if (!lipEditor.testing) {
    const mx = lipEditor.lip.x * cv.width;
    const my = lipEditor.lip.y * cv.height;
    const mw = lipEditor.lip.size * cv.width;
    ctx.save();
    ctx.strokeStyle = '#4de3e0';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.ellipse(mx, my, mw * 0.55, mw * 0.34, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 센터 십자
    ctx.beginPath();
    ctx.moveTo(mx - 7, my); ctx.lineTo(mx + 7, my);
    ctx.moveTo(mx, my - 7); ctx.lineTo(mx, my + 7);
    ctx.stroke();
    ctx.restore();
  }
}

function lipPointerSet(e) {
  const rect = els.lipCanvas.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  lipEditor.lip.x = Math.min(1, Math.max(0, cx / rect.width));
  lipEditor.lip.y = Math.min(1, Math.max(0, cy / rect.height));
  drawLipEditor(0);
}

let lipDragging = false;
els.lipCanvas.addEventListener('pointerdown', (e) => { lipDragging = true; stopLipTest(); lipPointerSet(e); });
els.lipCanvas.addEventListener('pointermove', (e) => { if (lipDragging) lipPointerSet(e); });
window.addEventListener('pointerup', () => lipDragging = false);

els.lipSize.addEventListener('input', () => {
  lipEditor.lip.size = parseFloat(els.lipSize.value);
  if (!lipEditor.testing) drawLipEditor(0);
});

els.lipTest.addEventListener('click', async () => {
  if (lipEditor.testing) { stopLipTest(); return; }
  if (!state.audioBuffer) { alert('먼저 오디오를 업로드해줘요!'); return; }
  lipEditor.testing = true;
  els.lipTest.innerHTML = '<i class="fas fa-stop mr-1"></i> 정지';

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const source = audioCtx.createBufferSource();
  source.buffer = state.audioBuffer;
  source.connect(audioCtx.destination);
  const startAt = audioCtx.currentTime;
  const testDur = Math.min(8, state.audioDuration); // 최대 8초 테스트
  source.start(0, 0, testDur);
  lipEditor.testSource = source;

  const loop = () => {
    if (!lipEditor.testing) return;
    const t = audioCtx.currentTime - startAt;
    if (t >= testDur) { stopLipTest(); return; }
    const intensity = parseFloat(els.lipIntensity.value);
    drawLipEditor(Math.min(1, envAt(t) * intensity));
    lipEditor.testRAF = requestAnimationFrame(loop);
  };
  loop();
  source.onended = () => { if (lipEditor.testing) stopLipTest(); };
});

function stopLipTest() {
  if (!lipEditor.testing) return;
  lipEditor.testing = false;
  if (lipEditor.testRAF) cancelAnimationFrame(lipEditor.testRAF);
  try { lipEditor.testSource && lipEditor.testSource.stop(); } catch (e) {}
  els.lipTest.innerHTML = '<i class="fas fa-play mr-1"></i> 립싱크 테스트';
  if (lipEditor.idx >= 0) drawLipEditor(0);
}

function closeLipModal() {
  stopLipTest();
  els.lipModal.classList.add('hidden');
  els.lipModal.classList.remove('flex');
  lipEditor.idx = -1;
}

els.lipClose.addEventListener('click', closeLipModal);
els.lipModal.addEventListener('click', (e) => { if (e.target === els.lipModal) closeLipModal(); });

els.lipSave.addEventListener('click', () => {
  if (lipEditor.idx >= 0) {
    state.images[lipEditor.idx].lip = { ...lipEditor.lip };
    renderImageList();
  }
  closeLipModal();
});

els.lipClear.addEventListener('click', () => {
  if (lipEditor.idx >= 0) {
    state.images[lipEditor.idx].lip = null;
    renderImageList();
  }
  closeLipModal();
});

els.lipIntensity.addEventListener('input', () => {
  els.lipIntensityVal.textContent = parseFloat(els.lipIntensity.value).toFixed(1) + 'x';
});

/* ---------------- AI 립싱크 (fal.ai 백엔드 프록시) ---------------- */

const aiEls = {
  btn: $('btn-ai-lipsync'),
  model: $('ai-lip-model'),
  progress: $('ai-lip-progress'),
  progressText: $('ai-lip-progress-text'),
  badge: $('ai-lip-status-badge'),
};

let aiConfigured = false;
let aiRunning = false;

// 서버에 키 설정 여부 확인
(async () => {
  try {
    const res = await fetch('/api/lipsync/config');
    const data = await res.json();
    aiConfigured = data.configured;
    aiEls.badge.textContent = aiConfigured ? '● 연결됨' : '○ 키 미설정';
    aiEls.badge.className = 'text-[10px] ' + (aiConfigured ? 'text-green-400' : 'text-yellow-500');
  } catch (e) {
    aiEls.badge.textContent = '연결 확인 실패';
  }
  updateAiButton();
})();

function updateAiButton() {
  aiEls.btn.disabled = !aiConfigured || aiRunning || state.images.length === 0 || !state.audioFile;
}

// 기존 updateUI에 AI 버튼 상태도 연동
const _origUpdateUI = updateUI;
updateUI = function () {
  _origUpdateUI();
  updateAiButton();
};

// 파일을 Base64 Data URI로 변환하여 fal.ai에 직접 전달
async function uploadToFal(file) {
  if (file.size > 8 * 1024 * 1024) {
    throw new Error(`${file.name} 파일이 너무 커요. 8MB 이하 파일을 사용해주세요.`);
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`${file.name} 파일 읽기 실패`));

    reader.readAsDataURL(file);
  });
}

aiEls.btn.addEventListener('click', async () => {
  if (aiRunning) return;
  if (state.images.length === 0 || !state.audioFile) return;

  const model = aiEls.model.value;
  const dur = Math.ceil(state.audioDuration);
  const costMsg = model === 'kling'
  ? `Kling Standard는 초당 약 85원이 결제돼요.\n오디오 길이 ${dur}초 → 약 ${(dur * 85).toLocaleString()}원 예상`
  : model === 'omnihuman'
    ? `OmniHuman은 초당 약 200원이 결제돼요.\n오디오 길이 ${dur}초 → 약 ${(dur * 200).toLocaleString()}원 예상`
    : `SadTalker는 회당 약 100~200원이 결제돼요.\n계속할까요?`;
  if (!confirm(costMsg)) return;

  aiRunning = true;
  updateAiButton();
  aiEls.progress.classList.remove('hidden');

  try {
    // 첫 번째 이미지 사용 (얼굴이 잘 보이는 사진이어야 함)
    aiEls.progressText.textContent = '이미지 업로드 중... (1/2)';
    const imageUri = await uploadToFal(state.images[0].file);
    aiEls.progressText.textContent = '오디오 업로드 중... (2/2)';
    const audioUri = await uploadToFal(state.audioFile);

    aiEls.progressText.textContent = 'AI 서버에 제출 중...';
    const submitRes = await fetch('/api/lipsync/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, image_data_uri: imageUri, audio_data_uri: audioUri }),
    });
    const submitData = await submitRes.json();
    if (!submitRes.ok) throw new Error(submitData.error || '제출 실패');

    const reqId = submitData.request_id;
    aiEls.progressText.textContent = 'AI가 영상 생성 중... (1~3분 소요)';

    // 폴링
    const started = Date.now();
    let status = '';
    while (true) {
      await new Promise(r => setTimeout(r, 4000));
      const sRes = await fetch(`/api/lipsync/status/${reqId}?model=${model}`);
      const sData = await sRes.json();
      status = sData.status;
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (status === 'COMPLETED') break;
      if (status === 'IN_QUEUE') {
        aiEls.progressText.textContent = `대기열 ${sData.queue_position ?? '?'}번째... (${elapsed}초 경과)`;
      } else {
        aiEls.progressText.textContent = `AI 렌더링 중... (${elapsed}초 경과)`;
      }
      if (elapsed > 600) throw new Error('시간 초과 (10분). fal.ai 대시보드에서 상태를 확인해주세요.');
    }

    aiEls.progressText.textContent = '결과 가져오는 중...';
    const rRes = await fetch(`/api/lipsync/result/${reqId}?model=${model}`);
    const rData = await rRes.json();
    const videoUrl = rData?.video?.url || rData?.response?.video?.url;
    if (!videoUrl) throw new Error('결과에 영상이 없어요: ' + JSON.stringify(rData).slice(0, 200));

    // 결과 패널에 표시
    els.resultVideo.src = videoUrl;
    els.btnDownload.href = videoUrl;
    els.btnDownload.removeAttribute('download');
    els.btnDownload.target = '_blank';
    els.btnDownload.innerHTML = '<i class="fas fa-download mr-1"></i> 다운로드 (MP4)';
    els.resultPanel.classList.remove('hidden');
    els.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    alert('AI 립싱크 실패: ' + err.message);
  } finally {
    aiRunning = false;
    aiEls.progress.classList.add('hidden');
    updateAiButton();
  }
});

/* ---------------- 설정 변경 시 프리뷰 갱신 ---------------- */

[els.resolutionSelect, els.subtitleInput, els.subtitlePos, els.subtitleColor].forEach(el => {
  el.addEventListener('input', () => { if (!state.previewPlaying && !state.rendering) drawStaticPreview(); });
});

updateUI();
