import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  FAL_KEY?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/static/*', serveStatic({ root: './public' }))

app.get('/api/health', (c) => c.json({ status: 'ok', service: 'ClipForge' }))

/* ============ fal.ai AI 립싱크 프록시 (키는 서버에만 존재) ============ */

const FAL_MODELS: Record<string, string> = {
  sadtalker: 'fal-ai/sadtalker',
    kling: 'fal-ai/kling-video/ai-avatar/v2/standard',
  omnihuman: 'fal-ai/bytedance/omnihuman',
}

// 키 설정 여부 확인 (키 자체는 절대 반환 안 함)
app.get('/api/lipsync/config', (c) => {
  return c.json({ configured: !!c.env.FAL_KEY })
})

// 파일을 fal.ai 스토리지에 업로드하고 공개 URL 반환 (base64 한계 해결)
app.post('/api/lipsync/upload', async (c) => {
  const falKey = c.env.FAL_KEY
  if (!falKey) return c.json({ error: 'FAL_KEY 미설정' }, 500)

  const contentType = c.req.header('content-type') || 'application/octet-stream'
  const fileName = c.req.query('name') || `upload_${Date.now()}`
  const body = await c.req.arrayBuffer()
  if (!body || body.byteLength === 0) return c.json({ error: '빈 파일이에요.' }, 400)

  // 1) 업로드 세션 생성
  const initRes = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content_type: contentType, file_name: fileName }),
  })
  const initText = await initRes.text()
let initData: any
try {
  initData = JSON.parse(initText)
} catch {
  return c.json({
    error: 'fal 스토리지 응답 오류',
    detail: initText.slice(0, 500) || `HTTP ${initRes.status}`,
  }, 502)
}

  if (!initRes.ok || !initData.upload_url) {
    return c.json({ error: 'fal 스토리지 초기화 실패', detail: initData }, 502)
  }

  // 2) 실제 파일 업로드
  const putRes = await fetch(initData.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  })
  if (!putRes.ok) {
    return c.json({ error: `fal 스토리지 업로드 실패 (${putRes.status})` }, 502)
  }

  return c.json({ file_url: initData.file_url })
})

// 립싱크 생성 요청 (fal.ai queue에 제출)
app.post('/api/lipsync/submit', async (c) => {
  const falKey = c.env.FAL_KEY
  if (!falKey) return c.json({ error: 'FAL_KEY가 설정되지 않았어요. 관리자에게 문의하세요.' }, 500)

  const body = await c.req.json<{
    model?: string
    image_data_uri: string
    audio_data_uri: string
    expression_scale?: number
  }>()

  const modelId = FAL_MODELS[body.model || 'sadtalker']
  if (!modelId) return c.json({ error: '지원하지 않는 모델이에요.' }, 400)
  if (!body.image_data_uri || !body.audio_data_uri) {
    return c.json({ error: '이미지와 오디오가 모두 필요해요.' }, 400)
  }

  // 모델별 입력 스키마
  let input: Record<string, unknown>
  if ((body.model || 'sadtalker') === 'sadtalker') {
    input = {
      source_image_url: body.image_data_uri,
      driven_audio_url: body.audio_data_uri,
      face_model_resolution: '512',
      expression_scale: body.expression_scale ?? 1,
      preprocess: 'full',
      still_mode: true,
    }
  } else {
    input = {
      image_url: body.image_data_uri,
      audio_url: body.audio_data_uri,
    }
  }

  const res = await fetch(`https://queue.fal.run/${modelId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  const data = await res.json<any>()
  if (!res.ok) {
    const msg = data?.detail || data?.error || JSON.stringify(data)
    return c.json({ error: `fal.ai 오류 (${res.status}): ${msg}` }, 502)
  }

  return c.json({ request_id: data.request_id, model: body.model || 'sadtalker' })
})

// 상태 조회 (프론트에서 폴링)
app.get('/api/lipsync/status/:id', async (c) => {
  const falKey = c.env.FAL_KEY
  if (!falKey) return c.json({ error: 'FAL_KEY 미설정' }, 500)

  const modelId = FAL_MODELS[c.req.query('model') || 'sadtalker']
  const id = c.req.param('id')

  const res = await fetch(`https://queue.fal.run/${modelId}/requests/${id}/status?logs=1`, {
    headers: { 'Authorization': `Key ${falKey}` },
  })
  const data = await res.json<any>()
  return c.json(data, res.status as any)
})

// 완성 결과 조회
app.get('/api/lipsync/result/:id', async (c) => {
  const falKey = c.env.FAL_KEY
  if (!falKey) return c.json({ error: 'FAL_KEY 미설정' }, 500)

  const modelId = FAL_MODELS[c.req.query('model') || 'sadtalker']
  const id = c.req.param('id')

  const res = await fetch(`https://queue.fal.run/${modelId}/requests/${id}`, {
    headers: { 'Authorization': `Key ${falKey}` },
  })
  const data = await res.json<any>()
  if (!res.ok) return c.json({ error: 'fal.ai 결과 조회 실패', detail: data }, 502)
  return c.json(data)
})

app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClipForge - 이미지 + 오디오 → 영상 제작소</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="/static/style.css" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            'cc-bg': '#101012',
            'cc-panel': '#1b1b1f',
            'cc-panel2': '#242429',
            'cc-border': '#333338',
            'cc-accent': '#4de3e0',
            'cc-accent2': '#7c6cff',
          }
        }
      }
    }
  </script>
</head>
<body class="bg-cc-bg text-gray-200 min-h-screen select-none">

  <!-- 상단 바 -->
  <header id="top-bar" class="h-14 flex items-center justify-between px-5 bg-cc-panel border-b border-cc-border sticky top-0 z-50">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-cc-accent to-cc-accent2 flex items-center justify-center">
        <i class="fas fa-film text-black text-sm"></i>
      </div>
      <h1 class="font-bold text-lg tracking-tight">Clip<span class="text-cc-accent">Forge</span></h1>
      <span class="text-xs text-gray-500 hidden sm:inline">이미지 + 오디오 → 영상 자동 조립</span>
    </div>
    <div class="flex items-center gap-2">
      <button id="btn-generate" class="px-5 py-2 rounded-lg bg-gradient-to-r from-cc-accent to-cc-accent2 text-black font-bold text-sm hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed" disabled>
        <i class="fas fa-wand-magic-sparkles mr-1"></i> 영상 생성
      </button>
    </div>
  </header>

  <main id="main-layout" class="flex flex-col lg:flex-row gap-4 p-4 max-w-[1400px] mx-auto">

    <!-- 좌측: 소스 패널 -->
    <section id="source-panel" class="w-full lg:w-[380px] shrink-0 space-y-4">

      <!-- 이미지 업로드 -->
      <div class="bg-cc-panel rounded-xl border border-cc-border p-4">
        <h2 class="text-sm font-semibold mb-3 flex items-center gap-2">
          <i class="fas fa-image text-cc-accent"></i> 이미지
          <span class="text-xs text-gray-500 font-normal">(여러 장 가능 · 순서대로 슬라이드)</span>
        </h2>
        <div id="image-drop" class="drop-zone rounded-lg border-2 border-dashed border-cc-border p-6 text-center cursor-pointer hover:border-cc-accent transition">
          <i class="fas fa-cloud-arrow-up text-2xl text-gray-500 mb-2"></i>
          <p class="text-sm text-gray-400">클릭 또는 드래그로 이미지 추가</p>
          <p class="text-xs text-gray-600 mt-1">JPG · PNG · WEBP · GIF</p>
        </div>
        <input type="file" id="image-input" accept="image/*" multiple class="hidden">
        <div id="image-list" class="grid grid-cols-3 gap-2 mt-3"></div>
      </div>

      <!-- 오디오 업로드 -->
      <div class="bg-cc-panel rounded-xl border border-cc-border p-4">
        <h2 class="text-sm font-semibold mb-3 flex items-center gap-2">
          <i class="fas fa-music text-cc-accent2"></i> 오디오
          <span class="text-xs text-gray-500 font-normal">(음성 · 음악)</span>
        </h2>
        <div id="audio-drop" class="drop-zone rounded-lg border-2 border-dashed border-cc-border p-6 text-center cursor-pointer hover:border-cc-accent2 transition">
          <i class="fas fa-file-audio text-2xl text-gray-500 mb-2"></i>
          <p class="text-sm text-gray-400">클릭 또는 드래그로 오디오 추가</p>
          <p class="text-xs text-gray-600 mt-1">MP3 · WAV · M4A · OGG</p>
        </div>
        <input type="file" id="audio-input" accept="audio/*" class="hidden">
        <div id="audio-info" class="hidden mt-3 bg-cc-panel2 rounded-lg p-3">
          <div class="flex items-center gap-3">
            <button id="audio-play-btn" class="w-9 h-9 rounded-full bg-cc-accent2 text-black flex items-center justify-center shrink-0">
              <i class="fas fa-play text-xs"></i>
            </button>
            <div class="min-w-0 flex-1">
              <p id="audio-name" class="text-xs truncate"></p>
              <p id="audio-duration" class="text-xs text-gray-500"></p>
            </div>
            <button id="audio-remove" class="text-gray-500 hover:text-red-400 shrink-0"><i class="fas fa-xmark"></i></button>
          </div>
          <canvas id="audio-waveform" class="w-full h-12 mt-2 rounded"></canvas>
        </div>
      </div>

      <!-- 설정 -->
      <div class="bg-cc-panel rounded-xl border border-cc-border p-4 space-y-4">
        <h2 class="text-sm font-semibold flex items-center gap-2">
          <i class="fas fa-sliders text-cc-accent"></i> 영상 설정
        </h2>

        <div>
          <label class="text-xs text-gray-400 block mb-2">화면 비율</label>
          <div id="aspect-buttons" class="grid grid-cols-3 gap-2">
            <button data-aspect="16:9" class="aspect-btn active px-2 py-2 rounded-lg bg-cc-panel2 border border-cc-border text-xs hover:border-cc-accent transition">16:9<br><span class="text-gray-500">유튜브</span></button>
            <button data-aspect="9:16" class="aspect-btn px-2 py-2 rounded-lg bg-cc-panel2 border border-cc-border text-xs hover:border-cc-accent transition">9:16<br><span class="text-gray-500">쇼츠</span></button>
            <button data-aspect="1:1" class="aspect-btn px-2 py-2 rounded-lg bg-cc-panel2 border border-cc-border text-xs hover:border-cc-accent transition">1:1<br><span class="text-gray-500">인스타</span></button>
          </div>
        </div>

        <div>
          <label class="text-xs text-gray-400 block mb-2">모션 효과 (Ken Burns)</label>
          <select id="motion-select" class="w-full bg-cc-panel2 border border-cc-border rounded-lg px-3 py-2 text-sm">
            <option value="kenburns">줌 인/아웃 + 팬 (자동 랜덤)</option>
            <option value="zoomin">줌 인</option>
            <option value="zoomout">줌 아웃</option>
            <option value="panlr">좌→우 팬</option>
            <option value="none">고정 (효과 없음)</option>
          </select>
        </div>

        <div>
          <label class="text-xs text-gray-400 block mb-2">전환 효과</label>
          <select id="transition-select" class="w-full bg-cc-panel2 border border-cc-border rounded-lg px-3 py-2 text-sm">
            <option value="fade">크로스 페이드</option>
            <option value="slide">슬라이드</option>
            <option value="zoom">줌 전환</option>
            <option value="cut">컷 (즉시 전환)</option>
          </select>
        </div>

        <!-- AI 립싱크 (fal.ai) -->
        <div id="ai-lip-panel" class="bg-gradient-to-br from-cc-panel2 to-[#1e1a2e] rounded-lg p-3 border border-cc-accent2/40">
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs font-semibold flex items-center gap-1.5">
              <i class="fas fa-robot text-cc-accent2"></i> AI 립싱크 <span class="text-[10px] px-1.5 py-0.5 rounded bg-cc-accent2/20 text-cc-accent2">진짜 AI</span>
            </label>
            <span id="ai-lip-status-badge" class="text-[10px] text-gray-500"></span>
          </div>
          <p class="text-[11px] text-gray-500 leading-relaxed mb-2">
            fal.ai AI가 얼굴을 분석해 <b class="text-gray-300">실제로 말하는 영상</b>을 만들어요. 이미지 1장 + 오디오 필요.
          </p>
          <select id="ai-lip-model" class="w-full bg-cc-panel border border-cc-border rounded-lg px-3 py-2 text-xs mb-2">
            <option value="sadtalker">SadTalker — 절약 모드 (회당 ~150원)</option>
            <option value="kling">Kling Standard — 가성비 AI (초당 약 85원)</option>
            <option value="omnihuman">OmniHuman — 캡컷급 고품질 (초당 ~200원)</option>
          </select>
          <button id="btn-ai-lipsync" class="w-full px-4 py-2.5 rounded-lg bg-gradient-to-r from-cc-accent2 to-purple-500 text-white font-bold text-sm hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed" disabled>
            <i class="fas fa-wand-magic-sparkles mr-1"></i> AI 립싱크 영상 생성
          </button>
          <div id="ai-lip-progress" class="hidden mt-2">
            <div class="flex items-center gap-2 text-xs text-gray-400">
              <div class="w-3.5 h-3.5 rounded-full border-2 border-cc-accent2 border-t-transparent animate-spin"></div>
              <span id="ai-lip-progress-text">AI 서버에 제출 중...</span>
            </div>
          </div>
        </div>

        <!-- 간이 립싱크 설정 -->
        <div id="lip-settings" class="bg-cc-panel2 rounded-lg p-3 border border-cc-border">
          <div class="flex items-center justify-between mb-2">
            <label class="text-xs font-semibold flex items-center gap-1.5">
              <i class="fas fa-face-grin-wide text-cc-accent"></i> 간이 립싱크 <span class="text-[10px] px-1.5 py-0.5 rounded bg-cc-accent/20 text-cc-accent">무료</span>
            </label>
            <label class="inline-flex items-center cursor-pointer">
              <input id="lip-enable" type="checkbox" checked class="sr-only peer">
              <div class="w-9 h-5 bg-cc-border rounded-full peer peer-checked:bg-cc-accent transition relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:transition peer-checked:after:translate-x-4"></div>
            </label>
          </div>
          <p class="text-[11px] text-gray-500 leading-relaxed mb-2">이미지 썸네일의 <i class="fas fa-face-grin-wide text-cc-accent"></i> 버튼으로 입 위치를 지정하면, 오디오 음성에 맞춰 입이 움직여요.</p>
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-gray-500 shrink-0">움직임 강도</span>
            <input id="lip-intensity" type="range" min="0.4" max="1.6" step="0.1" value="1" class="flex-1 accent-[#4de3e0]">
            <span id="lip-intensity-val" class="text-[11px] text-cc-accent w-8 text-right">1.0x</span>
          </div>
        </div>

        <div class="flex items-center justify-between">
          <label class="text-xs text-gray-400">오디오 비주얼라이저</label>
          <select id="visualizer-select" class="bg-cc-panel2 border border-cc-border rounded-lg px-3 py-1.5 text-xs">
            <option value="bars">바 (하단)</option>
            <option value="wave">웨이브</option>
            <option value="circle">서클</option>
            <option value="none">끄기</option>
          </select>
        </div>

        <div>
          <label class="text-xs text-gray-400 block mb-2">자막 / 타이틀 (선택)</label>
          <input id="subtitle-input" type="text" placeholder="영상에 표시할 텍스트 입력..." class="w-full bg-cc-panel2 border border-cc-border rounded-lg px-3 py-2 text-sm placeholder-gray-600">
          <div class="flex gap-2 mt-2">
            <select id="subtitle-pos" class="flex-1 bg-cc-panel2 border border-cc-border rounded-lg px-2 py-1.5 text-xs">
              <option value="bottom">하단</option>
              <option value="center">중앙</option>
              <option value="top">상단</option>
            </select>
            <input id="subtitle-color" type="color" value="#ffffff" class="w-10 h-8 bg-cc-panel2 border border-cc-border rounded-lg cursor-pointer">
          </div>
        </div>

        <div>
          <label class="text-xs text-gray-400 block mb-2">해상도</label>
          <select id="resolution-select" class="w-full bg-cc-panel2 border border-cc-border rounded-lg px-3 py-2 text-sm">
            <option value="1280">HD (720p)</option>
            <option value="1920">FHD (1080p)</option>
            <option value="854">SD (480p)</option>
          </select>
        </div>
      </div>
    </section>

    <!-- 우측: 프리뷰 + 결과 -->
    <section id="preview-panel" class="flex-1 space-y-4">
      <div class="bg-cc-panel rounded-xl border border-cc-border p-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-semibold flex items-center gap-2">
            <i class="fas fa-eye text-cc-accent"></i> 미리보기
          </h2>
          <button id="btn-preview" class="px-3 py-1.5 rounded-lg bg-cc-panel2 border border-cc-border text-xs hover:border-cc-accent transition disabled:opacity-40" disabled>
            <i class="fas fa-play mr-1"></i> 미리보기 재생
          </button>
        </div>
        <div id="canvas-wrap" class="relative bg-black rounded-lg overflow-hidden flex items-center justify-center" style="aspect-ratio:16/9">
          <canvas id="preview-canvas" class="max-w-full max-h-full"></canvas>
          <div id="canvas-placeholder" class="absolute inset-0 flex flex-col items-center justify-center text-gray-600">
            <i class="fas fa-clapperboard text-4xl mb-3"></i>
            <p class="text-sm">이미지와 오디오를 추가하면 미리보기가 표시돼요</p>
          </div>
          <!-- 렌더링 진행 오버레이 -->
          <div id="render-overlay" class="hidden absolute inset-0 bg-black/80 flex-col items-center justify-center z-10">
            <div class="w-16 h-16 rounded-full border-4 border-cc-accent border-t-transparent animate-spin mb-4"></div>
            <p class="text-sm font-semibold mb-1">영상 렌더링 중...</p>
            <p id="render-progress" class="text-xs text-gray-400">0%</p>
            <div class="w-64 h-2 bg-cc-panel2 rounded-full mt-3 overflow-hidden">
              <div id="render-bar" class="h-full bg-gradient-to-r from-cc-accent to-cc-accent2 rounded-full transition-all" style="width:0%"></div>
            </div>
            <p class="text-xs text-gray-600 mt-3">렌더링 중에는 이 탭을 벗어나지 마세요</p>
          </div>
        </div>
        <!-- 타임라인 -->
        <div id="timeline" class="mt-3 hidden">
          <div class="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <i class="fas fa-timeline"></i>
            <span>타임라인</span>
            <span id="timeline-total" class="ml-auto"></span>
          </div>
          <div id="timeline-track" class="h-10 bg-cc-panel2 rounded-lg flex overflow-hidden border border-cc-border"></div>
        </div>
      </div>

      <!-- 결과 -->
      <div id="result-panel" class="hidden bg-cc-panel rounded-xl border border-cc-accent p-4">
        <h2 class="text-sm font-semibold mb-3 flex items-center gap-2">
          <i class="fas fa-circle-check text-cc-accent"></i> 완성된 영상
        </h2>
        <video id="result-video" controls class="w-full rounded-lg bg-black max-h-[420px]"></video>
        <div class="flex flex-wrap gap-2 mt-3">
          <a id="btn-download" class="px-4 py-2 rounded-lg bg-gradient-to-r from-cc-accent to-cc-accent2 text-black font-bold text-sm cursor-pointer hover:opacity-90 transition">
            <i class="fas fa-download mr-1"></i> 다운로드 (WebM)
          </a>
          <button id="btn-regenerate" class="px-4 py-2 rounded-lg bg-cc-panel2 border border-cc-border text-sm hover:border-cc-accent transition">
            <i class="fas fa-rotate mr-1"></i> 다시 만들기
          </button>
        </div>
        <p class="text-xs text-gray-500 mt-2"><i class="fas fa-circle-info mr-1"></i>WebM 형식은 유튜브·인스타 업로드 가능. MP4가 필요하면 변환 사이트(예: cloudconvert.com) 이용.</p>
      </div>
    </section>
  </main>

  <footer class="text-center text-xs text-gray-600 py-6">
    ClipForge · 모든 처리는 브라우저에서 이루어지며 파일이 서버로 전송되지 않습니다 🔒
  </footer>

  <!-- 립싱크 에디터 모달 -->
  <div id="lip-modal" class="hidden fixed inset-0 z-[100] bg-black/80 items-center justify-center p-4">
    <div class="bg-cc-panel border border-cc-border rounded-2xl p-5 w-full max-w-2xl max-h-[92vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-sm flex items-center gap-2">
          <i class="fas fa-face-grin-wide text-cc-accent"></i> 입 위치 지정
        </h3>
        <button id="lip-close" class="text-gray-500 hover:text-white w-8 h-8"><i class="fas fa-xmark"></i></button>
      </div>
      <p class="text-xs text-gray-500 mb-3"><i class="fas fa-hand-pointer mr-1 text-cc-accent"></i>인물의 <b class="text-gray-300">입 중앙</b>을 클릭(드래그)해서 위치를 맞춘 뒤, 입 크기를 조절하세요.</p>
      <div class="flex justify-center bg-black rounded-lg overflow-hidden">
        <canvas id="lip-canvas" class="cursor-crosshair max-w-full touch-none"></canvas>
      </div>
      <div class="flex items-center gap-2 mt-4">
        <span class="text-xs text-gray-500 shrink-0 w-14">입 크기</span>
        <input id="lip-size" type="range" min="0.03" max="0.22" step="0.005" value="0.08" class="flex-1 accent-[#4de3e0]">
      </div>
      <div class="flex flex-wrap gap-2 mt-4">
        <button id="lip-test" class="px-4 py-2 rounded-lg bg-cc-panel2 border border-cc-border text-sm hover:border-cc-accent transition">
          <i class="fas fa-play mr-1"></i> 립싱크 테스트
        </button>
        <div class="flex-1"></div>
        <button id="lip-clear" class="px-4 py-2 rounded-lg bg-cc-panel2 border border-cc-border text-sm text-red-400 hover:border-red-400 transition">
          <i class="fas fa-trash mr-1"></i> 해제
        </button>
        <button id="lip-save" class="px-5 py-2 rounded-lg bg-gradient-to-r from-cc-accent to-cc-accent2 text-black font-bold text-sm hover:opacity-90 transition">
          <i class="fas fa-check mr-1"></i> 저장
        </button>
      </div>
    </div>
  </div>

  <script src="/static/app.js"></script>
</body>
</html>`)
})

export default app
