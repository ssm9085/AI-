# ClipForge 🎬

캡컷(CapCut)의 "이미지 + 오디오 → 영상" 기능을 웹으로 구현한 브라우저 기반 영상 제작 도구.

## Project Overview
- **Name**: ClipForge (webapp)
- **Goal**: 이미지 여러 장과 음성/음악 파일을 업로드하면 자동으로 하나의 영상으로 조립
- **핵심 특징**: 서버 인코딩 없이 **100% 브라우저 내 처리** (Canvas + WebAudio + MediaRecorder) → 파일이 서버로 전송되지 않아 개인정보 안전, 서버 비용 0

## URLs
- **개발 프리뷰 (샌드박스)**: https://3000-ijg4strzdkf87kksmr02u-c81df28e.sandbox.novita.ai
- **Production**: 미배포 (Cloudflare Pages 배포 가능)

## 완성된 기능
1. ✅ 이미지 다중 업로드 (드래그앤드롭 지원, 드래그로 순서 변경, 삭제)
2. ✅ 오디오 업로드 (MP3/WAV/M4A/OGG) + 파형 시각화 + 재생 미리듣기
3. ✅ 오디오 길이에 맞춰 이미지 자동 균등 분할 (타임라인 표시)
4. ✅ 화면 비율: 16:9 (유튜브) / 9:16 (쇼츠) / 1:1 (인스타)
5. ✅ 모션 효과: Ken Burns (줌인/줌아웃/팬 자동 랜덤), 개별 선택 가능
6. ✅ 전환 효과: 크로스 페이드 / 슬라이드 / 줌 / 컷
7. ✅ 오디오 비주얼라이저: 바 / 웨이브 / 서클 (실시간 주파수 반응)
8. ✅ 자막/타이틀 오버레이 (위치·색상 선택)
9. ✅ 해상도: 480p / 720p / 1080p
10. ✅ 실시간 미리보기 재생 (오디오 동기화)
11. ✅ 영상 생성 진행률 표시 + WebM 다운로드
12. ✅ 인트로/아웃트로 자동 페이드
13. ✅ **립싱크 (BETA)**: 이미지에 입 위치 지정 → 오디오 음량 엔벨로프에 맞춰 입이 움직이는 2D 퍼펫 립싱크 (입 크기·강도 조절, 8초 실시간 테스트)

## 기능 진입점 (URI)
- `GET /` — 메인 앱 (전체 기능 단일 페이지)
- `GET /api/health` — 헬스체크 JSON
- `GET /static/app.js` — 영상 조립 엔진
- `GET /static/style.css` — 커스텀 스타일

## 미구현 / 다음 단계 추천
- ⬜ MP4 직접 출력 (브라우저 MediaRecorder는 WebM 위주 → ffmpeg.wasm 도입 검토)
- ⬜ 이미지별 개별 표시 시간 조절 (현재 균등 분할)
- ⬜ 배경음악 + 음성 2트랙 믹싱
- ⬜ 자막 타임코드 (구간별 자막)
- ⬜ 프로젝트 저장 (Cloudflare KV/R2 연동)
- ⬜ 템플릿 프리셋 (뉴스/브이로그/뮤직비디오 스타일)

## Data Architecture
- **Data Models**: 클라이언트 메모리 내 state 객체 (images[], audioBuffer, 설정값)
- **Storage Services**: 없음 — 모든 데이터는 브라우저 메모리에서만 처리 후 소멸
- **Data Flow**: 파일 업로드 → ObjectURL/AudioBuffer 디코딩 → Canvas 프레임 렌더링 + WebAudio 스트림 → MediaRecorder 캡처 → Blob 다운로드

## User Guide
1. **이미지 추가**: 왼쪽 이미지 영역 클릭 또는 드래그앤드롭 (여러 장 가능, 썸네일 드래그로 순서 변경)
2. **오디오 추가**: 음성 또는 음악 파일 업로드 (영상 길이 = 오디오 길이)
3. **설정 선택**: 비율, 모션, 전환, 비주얼라이저, 자막, 해상도
4. **미리보기 재생**으로 확인
5. **영상 생성** 버튼 클릭 → 실시간 렌더링 (오디오 길이만큼 소요, 탭 유지 필수)
6. 완성 후 **다운로드 (WebM)** — MP4 필요 시 cloudconvert.com 등에서 변환

## Deployment
- **Platform**: Cloudflare Pages (배포 준비 완료)
- **Status**: ✅ 샌드박스 개발 서버 활성
- **Tech Stack**: Hono + TypeScript + TailwindCSS(CDN) + Canvas/WebAudio/MediaRecorder API
- **Last Updated**: 2026-07-14
