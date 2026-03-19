/**
 * pages/record.js - 녹음 페이지
 * Phase 1: 온보딩, 키워드 노출, 예상 시간
 * Phase 2: 저장 공간 경고
 * Phase 3: 브라우저 알림, 오디오 레벨 미터
 */

import { AudioRecorder } from '../recorder.js';
import { preprocessAudio, splitAudioFile } from '../audio-processor.js';
import { transcribeAllSegments, summarize } from '../groq-api.js';
import { saveMeeting, deleteAudioSegments, saveRecording, loadRecording, loadMeetingsWithRecordings } from '../storage.js';
import { generateMeetingId, formatDateTime, formatElapsed, formatFileSize, renderMarkdown, downloadAsText, escapeHtml } from '../utils.js';
import { getApiKey, getSettings, navigate, state, showToast, checkStorageQuota } from '../app.js';

let recorder = null;
let levelAnalyser = null;
let levelAnimFrame = null;
let levelAudioCtx = null;

function getRecorder() {
  if (!recorder) recorder = new AudioRecorder();
  return recorder;
}

export function renderRecordPage() {
  const app = document.getElementById('app');
  const rec = getRecorder();
  const apiKey = getApiKey();

  // ── Phase 1: 온보딩 — API 키 미설정 시 가이드 먼저 표시 ──
  if (!apiKey) {
    app.innerHTML = `
      <div class="onboarding">
        <h1>회의록 자동 생성기</h1>
        <p class="caption">마이크로 회의를 녹음하면 AI가 자동으로 회의록을 생성합니다.</p>
        <hr>
        <div class="onboarding-card">
          <h2>시작하기 전에 — API 키 설정 (1분)</h2>
          <p>이 앱은 무료 Groq AI를 사용합니다. API 키만 발급받으면 바로 사용할 수 있어요.</p>
          <div class="onboarding-steps">
            <div class="onboarding-step">
              <span class="step-num">1</span>
              <div>
                <strong><a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a></strong> 접속 후 Google 계정으로 가입
              </div>
            </div>
            <div class="onboarding-step">
              <span class="step-num">2</span>
              <div>좌측 <strong>API Keys</strong> → <strong>Create API Key</strong> 클릭</div>
            </div>
            <div class="onboarding-step">
              <span class="step-num">3</span>
              <div>생성된 키를 아래에 붙여넣기</div>
            </div>
          </div>
          <div style="margin-top:16px;">
            <label class="sidebar-label" style="color:var(--text-secondary);">Groq API Key</label>
            <input type="password" id="onboarding-api-key" class="onboarding-input" placeholder="gsk_..." autocomplete="off">
          </div>
          <button id="btn-onboarding-save" class="btn btn-primary" style="width:100%; margin-top:12px;">
            설정 완료 — 시작하기
          </button>
          <p class="caption" style="margin-top:8px; text-align:center;">API 키는 브라우저에만 저장됩니다 (서버 전송 없음)</p>
        </div>
      </div>
    `;

    document.getElementById('btn-onboarding-save').addEventListener('click', () => {
      const key = document.getElementById('onboarding-api-key').value.trim();
      if (!key) { alert('API 키를 입력해주세요.'); return; }
      // 사이드바 input과 localStorage에 동기화
      const sidebarInput = document.getElementById('input-api-key');
      if (sidebarInput) sidebarInput.value = key;
      localStorage.setItem('groq_api_key', key);
      showToast('API 키가 설정되었습니다!', 'success');
      renderRecordPage();
    });
    return;
  }

  // ── 메인 녹음 페이지 ──
  const settings = getSettings();

  app.innerHTML = `
    <h1>회의록 자동 생성기</h1>
    <p class="caption">마이크로 회의를 녹음하면 AI가 자동으로 회의록을 생성합니다.</p>
    <hr>

    <!-- Phase 1: 녹음 전 키워드 프로모션 -->
    <div id="keyword-tip" class="tip-box" ${settings.keywords ? 'hidden' : ''}>
      <strong>💡 TIP:</strong> 회의 키워드를 입력하면 인식 정확도가 크게 올라갑니다.
      <div style="margin-top:8px; display:flex; gap:8px; align-items:flex-start;">
        <input type="text" id="inline-keywords" class="inline-input" placeholder="예: 스프린트, KPI, 홍길동, 마케팅팀" value="${escapeHtml(settings.keywords)}">
        <button id="btn-save-keywords" class="btn btn-small btn-secondary">저장</button>
      </div>
    </div>

    <div class="button-row">
      <button id="btn-start" class="btn btn-primary" ${rec.isRecording || state.processing ? 'disabled' : ''}>
        🎙️ 녹음 시작
      </button>
      <button id="btn-stop" class="btn btn-danger" ${!rec.isRecording || state.processing ? 'disabled' : ''}>
        ⏹️ 녹음 종료 및 요약하기
      </button>
    </div>

    <div id="recording-status" class="status-box status-recording" ${rec.isRecording ? '' : 'hidden'}>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="recording-dot"></span>
        <strong>녹음 중입니다...</strong>
      </div>
      <div style="margin-top:8px;">
        녹음 시간: <span id="elapsed-time">00:00:00</span>
      </div>
      <!-- Phase 3: 오디오 레벨 미터 -->
      <div id="level-meter-container" style="margin-top:8px;">
        <div class="level-meter"><div class="level-meter-fill" id="level-meter-fill"></div></div>
        <small style="color:#999;">마이크 입력 레벨</small>
      </div>
    </div>

    <div id="processing-steps" hidden></div>
    <div id="record-error" class="status-box status-error" hidden></div>

    <div id="results" hidden>
      <details class="collapsible">
        <summary>원본 텍스트 보기 (STT 결과)</summary>
        <textarea id="transcript-text" readonly rows="8"></textarea>
      </details>
      <h2>회의록 요약 결과</h2>
      <div id="summary-content" class="markdown-body"></div>
      <div class="result-actions">
        <button id="btn-download" class="btn btn-secondary">📥 회의록 다운로드 (.txt)</button>
        <button id="btn-copy" class="btn btn-secondary">📋 클립보드 복사</button>
      </div>
    </div>

    <hr>
    <h2>📁 기존 녹음 파일 다시 처리</h2>
    <p class="caption">이전에 녹음한 파일을 선택하여 회의록을 다시 생성할 수 있습니다.</p>

    <div id="saved-recordings-section">
      <p class="loading">저장된 녹음 파일 불러오는 중...</p>
    </div>

    <hr style="border-style:dashed; margin:24px 0;">
    <h3>외부 파일 업로드</h3>
    <p class="caption">다른 곳에서 녹음한 오디오 파일을 업로드하여 회의록을 생성할 수도 있습니다.</p>
    <div class="file-upload-area" id="file-drop-zone">
      <input type="file" id="file-input" accept="audio/*,.wav,.webm,.mp3,.m4a,.ogg,.mp4">
      <p>파일을 여기에 끌어다 놓거나 클릭하여 선택</p>
      <p id="file-info" class="caption"></p>
    </div>
    <button id="btn-reprocess" class="btn btn-secondary" disabled style="margin-top:8px;">
      🔄 이 파일로 회의록 생성
    </button>

    <!-- Phase 2: 저장 공간 경고 -->
    <div id="storage-warning" hidden></div>
  `;

  // ── 이벤트 바인딩 ──
  document.getElementById('btn-start').addEventListener('click', handleStartRecording);
  document.getElementById('btn-stop').addEventListener('click', handleStopRecording);

  // 인라인 키워드 저장
  const btnSaveKw = document.getElementById('btn-save-keywords');
  if (btnSaveKw) {
    btnSaveKw.addEventListener('click', () => {
      const val = document.getElementById('inline-keywords').value.trim();
      const sidebarKw = document.getElementById('input-keywords');
      if (sidebarKw) sidebarKw.value = val;
      localStorage.setItem('stt_keywords', val);
      const tipBox = document.getElementById('keyword-tip');
      if (tipBox && val) {
        tipBox.innerHTML = `<strong>✅ 키워드 저장됨:</strong> ${escapeHtml(val)}`;
      }
    });
  }

  // 녹음 중이면 타이머 + 레벨 미터 연결
  if (rec.isRecording) {
    rec.onElapsedUpdate = (secs) => {
      const el = document.getElementById('elapsed-time');
      if (el) el.textContent = formatElapsed(secs);
    };
    startLevelMeter(rec.stream);
  }

  // 이전 결과가 있으면 표시
  if (state.currentTranscript && state.currentSummary) {
    showResults(state.currentTranscript, state.currentSummary);
  }

  // 파일 업로드
  let selectedFile = null;
  const fileInput = document.getElementById('file-input');
  const fileDropZone = document.getElementById('file-drop-zone');
  const btnReprocess = document.getElementById('btn-reprocess');

  fileInput.addEventListener('change', (e) => {
    selectedFile = e.target.files[0] || null;
    updateFileInfo(selectedFile);
    btnReprocess.disabled = !selectedFile;
  });
  fileDropZone.addEventListener('dragover', (e) => { e.preventDefault(); fileDropZone.classList.add('drag-over'); });
  fileDropZone.addEventListener('dragleave', () => fileDropZone.classList.remove('drag-over'));
  fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.classList.remove('drag-over');
    selectedFile = e.dataTransfer.files[0] || null;
    updateFileInfo(selectedFile);
    btnReprocess.disabled = !selectedFile;
  });
  btnReprocess.addEventListener('click', () => { if (selectedFile) handleFileReprocess(selectedFile); });

  // 저장된 녹음 목록 로드
  loadSavedRecordingsList();

  // Phase 2: 저장 공간 체크
  checkStorageAndWarn();
}

// ── Phase 2: 저장 공간 경고 ──
async function checkStorageAndWarn() {
  const info = await checkStorageQuota();
  if (!info) return;
  const el = document.getElementById('storage-warning');
  if (!el) return;

  const usedPercent = Math.round((info.usage / info.quota) * 100);
  if (usedPercent >= 80) {
    el.hidden = false;
    el.className = 'status-box status-error';
    el.innerHTML = `⚠️ <strong>저장 공간 ${usedPercent}% 사용 중</strong> (${formatFileSize(info.usage)} / ${formatFileSize(info.quota)})<br>
      <small>오래된 회의록을 삭제하면 공간이 확보됩니다.</small>`;
  } else if (usedPercent >= 50) {
    el.hidden = false;
    el.className = 'status-box status-info';
    el.innerHTML = `💾 저장 공간 ${usedPercent}% 사용 중 (${formatFileSize(info.usage)} / ${formatFileSize(info.quota)})`;
  }
}

// ── Phase 3: 오디오 레벨 미터 ──
function startLevelMeter(stream) {
  if (!stream) return;
  stopLevelMeter(); // 기존 컨텍스트 정리
  try {
    levelAudioCtx = new AudioContext();
    const source = levelAudioCtx.createMediaStreamSource(stream);
    levelAnalyser = levelAudioCtx.createAnalyser();
    levelAnalyser.fftSize = 256;
    source.connect(levelAnalyser);

    const dataArray = new Uint8Array(levelAnalyser.frequencyBinCount);
    function updateMeter() {
      if (!levelAnalyser) return;
      levelAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const percent = Math.min(100, Math.round((avg / 128) * 100));
      const fill = document.getElementById('level-meter-fill');
      if (fill) {
        fill.style.width = percent + '%';
        fill.style.background = percent > 70 ? 'var(--danger)' : percent > 30 ? 'var(--success)' : 'var(--info)';
      }
      levelAnimFrame = requestAnimationFrame(updateMeter);
    }
    updateMeter();
  } catch (e) {
    console.warn('레벨 미터 초기화 실패:', e);
  }
}

function stopLevelMeter() {
  if (levelAnimFrame) { cancelAnimationFrame(levelAnimFrame); levelAnimFrame = null; }
  levelAnalyser = null;
  if (levelAudioCtx) { levelAudioCtx.close().catch(() => {}); levelAudioCtx = null; }
}

// ── Phase 3: 브라우저 알림 권한 요청 ──
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '📝' });
  }
}

// ── Phase 1: 예상 시간 계산 ──
function estimateProcessingTime(segmentCount) {
  // 세그먼트당 평균 ~30초 (전처리 5초 + STT 20초 + 여유 5초) + 요약 10초
  const estimateSec = segmentCount * 30 + 10;
  const min = Math.floor(estimateSec / 60);
  const sec = estimateSec % 60;
  return min > 0 ? `약 ${min}분 ${sec}초` : `약 ${sec}초`;
}

function updateFileInfo(file) {
  const info = document.getElementById('file-info');
  if (!info) return;
  info.textContent = file ? `${file.name} (${formatFileSize(file.size)})` : '';
}

// ── 저장된 녹음 목록 ──
async function loadSavedRecordingsList() {
  const section = document.getElementById('saved-recordings-section');
  if (!section) return;

  try {
    const meetings = await loadMeetingsWithRecordings();
    if (!meetings || meetings.length === 0) {
      section.innerHTML = '<p class="caption" style="color:#999;">저장된 녹음 파일이 없습니다. 녹음을 진행하면 여기에 표시됩니다.</p>';
      return;
    }

    let html = '<div class="saved-recordings-list">';
    for (const m of meetings) {
      html += `
        <div class="meeting-card" style="margin-bottom:6px;">
          <div class="card-info">
            <strong>${escapeHtml(m.created_at)}</strong>
            <p class="card-preview">${escapeHtml(m.id)}</p>
          </div>
          <button class="btn btn-small btn-secondary btn-reprocess-saved" data-meeting-id="${escapeHtml(m.id)}">
            🔄 다시 처리
          </button>
        </div>
      `;
    }
    html += '</div>';
    section.innerHTML = html;

    section.querySelectorAll('.btn-reprocess-saved').forEach(btn => {
      btn.addEventListener('click', () => handleSavedRecordingReprocess(btn.dataset.meetingId));
    });
  } catch (e) {
    section.innerHTML = `<p class="caption" style="color:#c00;">녹음 목록 로드 실패: ${escapeHtml(e.message)}</p>`;
  }
}

// ── 녹음 시작 ──
async function handleStartRecording() {
  const apiKey = getApiKey();
  if (!apiKey) { showError('API Key를 먼저 입력해 주세요!'); return; }

  // Phase 3: 알림 권한 요청
  requestNotificationPermission();

  const rec = getRecorder();
  try {
    await rec.start();
    rec.onElapsedUpdate = (secs) => {
      const el = document.getElementById('elapsed-time');
      if (el) el.textContent = formatElapsed(secs);
    };
    renderRecordPage();
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      showError('마이크 사용 권한이 필요합니다. 브라우저 설정에서 허용해주세요.');
    } else {
      showError('녹음 시작 실패: ' + e.message);
    }
  }
}

// ── 녹음 종료 & 처리 ──
async function handleStopRecording() {
  const apiKey = getApiKey();
  const settings = getSettings();
  const rec = getRecorder();

  state.processing = true;
  updateButtonStates();
  stopLevelMeter();

  const recStatus = document.getElementById('recording-status');
  if (recStatus) recStatus.hidden = true;

  const stepsEl = document.getElementById('processing-steps');
  stepsEl.hidden = false;
  stepsEl.innerHTML = '';

  try {
    // 1단계: 녹음 종료
    addStep(stepsEl, 'step-save', '1단계: 녹음 종료 및 파일 마무리 중...', 'active');
    const result = await rec.stop();
    if (!result || result.segments.length === 0) {
      throw new Error('녹음된 데이터가 없습니다. 다시 시도해 주세요.');
    }
    updateStep('step-save', `1단계 완료: 녹음 파일 저장 (${result.segments.length}개 세그먼트)`, 'complete');

    // Phase 1: 예상 시간 표시
    const estTime = estimateProcessingTime(result.segments.length);
    addStep(stepsEl, 'step-estimate', `⏱️ 예상 처리 시간: ${estTime}`, 'info');

    // 1.5단계: 전처리
    addStep(stepsEl, 'step-preprocess', '음질 개선 중: 필터링 및 음량 정규화...', 'active');
    const wavSegments = [];
    for (let i = 0; i < result.segments.length; i++) {
      try {
        const wav = await preprocessAudio(result.segments[i]);
        wavSegments.push(wav);
      } catch (e) {
        console.warn(`세그먼트 ${i} 전처리 실패, 원본 사용:`, e);
        wavSegments.push(result.segments[i]);
      }
    }
    updateStep('step-preprocess', '음질 개선 완료: 필터링 + 음량 정규화 적용', 'complete');

    // 2단계: STT
    addStep(stepsEl, 'step-stt', `2단계: 음성을 텍스트로 변환 중... (${wavSegments.length}개 세그먼트)`, 'active');
    const startTime = Date.now();
    const transcript = await transcribeAllSegments(
      wavSegments, apiKey, settings.sttModel, settings.keywords,
      (current, total) => {
        updateStep('step-stt', `2단계: 음성 → 텍스트 변환 중... (${current}/${total})`, 'active');
      }
    );
    const sttSec = Math.floor((Date.now() - startTime) / 1000);
    updateStep('step-stt', `2단계 완료: 음성 → 텍스트 변환 성공 (소요: ${Math.floor(sttSec / 60)}분 ${sttSec % 60}초)`, 'complete');

    // 3단계: 요약
    addStep(stepsEl, 'step-summarize', '3단계: 회의록 요약 생성 중... (Groq API)', 'active');
    const summary = await summarize(transcript, apiKey, false);
    updateStep('step-summarize', '3단계 완료: 회의록 요약 생성 완료!', 'complete');

    // 저장
    const meetingId = generateMeetingId();
    await saveMeeting({ id: meetingId, created_at: formatDateTime(), transcript, summary, reviewed: false });
    try { await saveRecording(meetingId, result.segments, result.mimeType, result.totalDuration); } catch (e) { console.warn('녹음 원본 보관 실패:', e); }
    try { await deleteAudioSegments(result.recordingId); } catch (e) { console.warn('세그먼트 정리 실패:', e); }

    addStep(stepsEl, 'step-saved', `✅ 회의록이 자동 저장되었습니다. (${meetingId})`, 'complete');

    state.currentTranscript = transcript;
    state.currentSummary = summary;
    showResults(transcript, summary);

    // Phase 3: 브라우저 알림
    sendNotification('회의록 완성!', '회의록 요약이 생성되었습니다. 확인해보세요.');
    showToast('회의록이 생성되었습니다!', 'success');

  } catch (e) {
    showError(e.message);
    sendNotification('처리 실패', e.message);
  } finally {
    state.processing = false;
    updateButtonStates();
  }
}

// ── 저장된 녹음 재처리 ──
async function handleSavedRecordingReprocess(meetingId) {
  const apiKey = getApiKey();
  if (!apiKey) { showError('API Key를 먼저 입력해 주세요!'); return; }

  const recording = await loadRecording(meetingId);
  if (!recording || !recording.blob) { showError('녹음 파일을 찾을 수 없습니다.'); return; }

  const settings = getSettings();
  state.processing = true;
  updateButtonStates();

  const stepsEl = document.getElementById('processing-steps');
  stepsEl.hidden = false;
  stepsEl.innerHTML = '';

  try {
    addStep(stepsEl, 'step-preprocess', '음질 개선 및 파일 분할 중...', 'active');
    let wavSegments;
    try { wavSegments = await splitAudioFile(recording.blob); }
    catch (e) {
      try { const wav = await preprocessAudio(recording.blob); wavSegments = [wav]; }
      catch (e2) { wavSegments = [recording.blob]; }
    }
    updateStep('step-preprocess', `음질 개선 완료 (${wavSegments.length}개 세그먼트)`, 'complete');

    const estTime = estimateProcessingTime(wavSegments.length);
    addStep(stepsEl, 'step-estimate', `⏱️ 예상 처리 시간: ${estTime}`, 'info');

    addStep(stepsEl, 'step-stt', `1단계: 음성 → 텍스트 변환 중... (${wavSegments.length}개 세그먼트)`, 'active');
    const startTime = Date.now();
    const transcript = await transcribeAllSegments(wavSegments, apiKey, settings.sttModel, settings.keywords,
      (current, total) => { updateStep('step-stt', `1단계: 음성 → 텍스트 변환 중... (${current}/${total})`, 'active'); });
    const sttSec = Math.floor((Date.now() - startTime) / 1000);
    updateStep('step-stt', `1단계 완료 (소요: ${Math.floor(sttSec / 60)}분 ${sttSec % 60}초)`, 'complete');

    addStep(stepsEl, 'step-summarize', '2단계: 회의록 요약 생성 중...', 'active');
    const summary = await summarize(transcript, apiKey, false);
    updateStep('step-summarize', '2단계 완료!', 'complete');

    const newMeetingId = generateMeetingId();
    await saveMeeting({ id: newMeetingId, created_at: formatDateTime(), transcript, summary, reviewed: false });
    try { await saveRecording(newMeetingId, [recording.blob], recording.mimeType, recording.duration); } catch (e) {}
    addStep(stepsEl, 'step-saved', `✅ 회의록 저장 완료 (${newMeetingId})`, 'complete');

    state.currentTranscript = transcript;
    state.currentSummary = summary;
    showResults(transcript, summary);
    sendNotification('회의록 완성!', '재처리가 완료되었습니다.');
    showToast('회의록이 생성되었습니다!', 'success');
  } catch (e) { showError(e.message); }
  finally { state.processing = false; updateButtonStates(); }
}

// ── 파일 재처리 ──
async function handleFileReprocess(file) {
  const apiKey = getApiKey();
  if (!apiKey) { showError('API Key를 먼저 입력해 주세요!'); return; }

  const settings = getSettings();
  state.processing = true;
  updateButtonStates();

  const stepsEl = document.getElementById('processing-steps');
  stepsEl.hidden = false;
  stepsEl.innerHTML = '';

  try {
    addStep(stepsEl, 'step-preprocess', '음질 개선 및 파일 분할 중...', 'active');
    let wavSegments;
    try { wavSegments = await splitAudioFile(file); }
    catch (e) {
      try { const wav = await preprocessAudio(file); wavSegments = [wav]; }
      catch (e2) { wavSegments = [file]; }
    }
    updateStep('step-preprocess', `음질 개선 완료 (${wavSegments.length}개 세그먼트)`, 'complete');

    const estTime = estimateProcessingTime(wavSegments.length);
    addStep(stepsEl, 'step-estimate', `⏱️ 예상 처리 시간: ${estTime}`, 'info');

    addStep(stepsEl, 'step-stt', `1단계: 음성 → 텍스트 변환 중...`, 'active');
    const startTime = Date.now();
    const transcript = await transcribeAllSegments(wavSegments, apiKey, settings.sttModel, settings.keywords,
      (current, total) => { updateStep('step-stt', `1단계: 변환 중... (${current}/${total})`, 'active'); });
    const sttSec = Math.floor((Date.now() - startTime) / 1000);
    updateStep('step-stt', `1단계 완료 (소요: ${Math.floor(sttSec / 60)}분 ${sttSec % 60}초)`, 'complete');

    addStep(stepsEl, 'step-summarize', '2단계: 요약 생성 중...', 'active');
    const summary = await summarize(transcript, apiKey, false);
    updateStep('step-summarize', '2단계 완료!', 'complete');

    const meetingId = generateMeetingId();
    await saveMeeting({ id: meetingId, created_at: formatDateTime(), transcript, summary, reviewed: false });
    addStep(stepsEl, 'step-saved', `✅ 회의록 저장 완료 (${meetingId})`, 'complete');

    state.currentTranscript = transcript;
    state.currentSummary = summary;
    showResults(transcript, summary);
    sendNotification('회의록 완성!', '파일 처리가 완료되었습니다.');
    showToast('회의록이 생성되었습니다!', 'success');
  } catch (e) { showError(e.message); }
  finally { state.processing = false; updateButtonStates(); }
}

// ── UI 헬퍼 ──

function showResults(transcript, summary) {
  const resultsEl = document.getElementById('results');
  if (!resultsEl) return;
  resultsEl.hidden = false;

  document.getElementById('transcript-text').value = transcript;
  document.getElementById('summary-content').innerHTML = renderMarkdown(summary);

  document.getElementById('btn-download').onclick = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fn = `회의록_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.txt`;
    downloadAsText(summary, fn);
  };

  // Phase 2: 클립보드 복사
  document.getElementById('btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      showToast('클립보드에 복사되었습니다!', 'success');
    } catch (e) {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = summary;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('클립보드에 복사되었습니다!', 'success');
    }
  };
}

function showError(msg) {
  const el = document.getElementById('record-error');
  if (el) { el.hidden = false; el.textContent = msg; }
}

function addStep(container, id, text, status) {
  const div = document.createElement('div');
  div.id = id;
  div.className = `step step-${status}`;
  const icon = status === 'complete' ? '✅' : status === 'error' ? '❌' : status === 'info' ? 'ℹ️' : '⏳';
  div.innerHTML = `<span class="step-icon">${icon}</span> ${text}`;
  container.appendChild(div);
}

function updateStep(id, text, status) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `step step-${status}`;
  const icon = status === 'complete' ? '✅' : status === 'error' ? '❌' : status === 'info' ? 'ℹ️' : '⏳';
  el.innerHTML = `<span class="step-icon">${icon}</span> ${text}`;
}

function updateButtonStates() {
  const rec = getRecorder();
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnReprocess = document.getElementById('btn-reprocess');
  if (btnStart) btnStart.disabled = rec.isRecording || state.processing;
  if (btnStop) btnStop.disabled = !rec.isRecording || state.processing;
  if (btnReprocess) btnReprocess.disabled = state.processing;
}
