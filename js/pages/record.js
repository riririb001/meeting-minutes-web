/**
 * pages/record.js - 녹음 페이지
 * app.py render_record_page() 이식
 */

import { AudioRecorder } from '../recorder.js';
import { preprocessAudio, splitAudioFile } from '../audio-processor.js';
import { transcribeAllSegments, summarize } from '../groq-api.js';
import { saveMeeting, deleteAudioSegments } from '../storage.js';
import { generateMeetingId, formatDateTime, formatElapsed, formatFileSize, renderMarkdown, downloadAsText } from '../utils.js';
import { getApiKey, getSettings, navigate, state } from '../app.js';

let recorder = null;

function getRecorder() {
  if (!recorder) recorder = new AudioRecorder();
  return recorder;
}

export function renderRecordPage() {
  const app = document.getElementById('app');
  const rec = getRecorder();

  app.innerHTML = `
    <h1>회의록 자동 생성기</h1>
    <p class="caption">마이크로 회의를 녹음하면 AI가 자동으로 회의록을 생성합니다.</p>
    <hr>

    <div class="button-row">
      <button id="btn-start" class="btn btn-primary" ${rec.isRecording || state.processing ? 'disabled' : ''}>
        녹음 시작
      </button>
      <button id="btn-stop" class="btn btn-danger" ${!rec.isRecording || state.processing ? 'disabled' : ''}>
        녹음 종료 및 요약하기
      </button>
    </div>

    <div id="recording-status" class="status-box status-recording" ${rec.isRecording ? '' : 'hidden'}>
      <span class="recording-dot"></span>
      <strong>녹음 중입니다...</strong>
      <br>녹음 시간: <span id="elapsed-time">00:00:00</span>
      <br><small>실시간 저장 중 (5분마다 세그먼트 자동 분할)</small>
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
      <button id="btn-download" class="btn btn-secondary">회의록 다운로드 (.txt)</button>
    </div>

    <hr>
    <h2>기존 녹음 파일 다시 처리</h2>
    <p class="caption">이전에 녹음한 오디오 파일을 업로드하여 회의록을 다시 생성할 수 있습니다.</p>
    <div class="file-upload-area" id="file-drop-zone">
      <input type="file" id="file-input" accept="audio/*,.wav,.webm,.mp3,.m4a,.ogg,.mp4">
      <p>파일을 여기에 끌어다 놓거나 클릭하여 선택</p>
      <p id="file-info" class="caption"></p>
    </div>
    <button id="btn-reprocess" class="btn btn-secondary" disabled style="margin-top:8px;">
      이 파일로 회의록 생성
    </button>
  `;

  // ── 이벤트 바인딩 ──
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnReprocess = document.getElementById('btn-reprocess');
  const fileInput = document.getElementById('file-input');
  const fileDropZone = document.getElementById('file-drop-zone');

  btnStart.addEventListener('click', handleStartRecording);
  btnStop.addEventListener('click', handleStopRecording);

  // 녹음 중이면 타이머 연결
  if (rec.isRecording) {
    rec.onElapsedUpdate = (secs) => {
      const el = document.getElementById('elapsed-time');
      if (el) el.textContent = formatElapsed(secs);
    };
  }

  // 이전 결과가 있으면 표시
  if (state.currentTranscript && state.currentSummary) {
    showResults(state.currentTranscript, state.currentSummary);
  }

  // 파일 업로드
  let selectedFile = null;
  fileInput.addEventListener('change', (e) => {
    selectedFile = e.target.files[0] || null;
    updateFileInfo(selectedFile);
    btnReprocess.disabled = !selectedFile;
  });

  fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropZone.classList.add('drag-over');
  });
  fileDropZone.addEventListener('dragleave', () => fileDropZone.classList.remove('drag-over'));
  fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.classList.remove('drag-over');
    selectedFile = e.dataTransfer.files[0] || null;
    updateFileInfo(selectedFile);
    btnReprocess.disabled = !selectedFile;
  });

  btnReprocess.addEventListener('click', () => {
    if (selectedFile) handleFileReprocess(selectedFile);
  });
}

function updateFileInfo(file) {
  const info = document.getElementById('file-info');
  if (!info) return;
  if (file) {
    info.textContent = `${file.name} (${formatFileSize(file.size)})`;
  } else {
    info.textContent = '';
  }
}

// ── 녹음 시작 ──
async function handleStartRecording() {
  const apiKey = getApiKey();
  if (!apiKey) {
    showError('왼쪽 사이드바에서 Groq API Key를 먼저 입력해 주세요!');
    return;
  }

  const rec = getRecorder();
  try {
    await rec.start();
    rec.onElapsedUpdate = (secs) => {
      const el = document.getElementById('elapsed-time');
      if (el) el.textContent = formatElapsed(secs);
    };
    // UI 갱신
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

  // 녹음 상태 숨기기
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

    // 자동 저장
    const meetingId = generateMeetingId();
    await saveMeeting({
      id: meetingId,
      created_at: formatDateTime(),
      transcript,
      summary,
      reviewed: false,
    });

    // crash recovery 세그먼트 정리
    try {
      await deleteAudioSegments(result.recordingId);
    } catch (e) {
      console.warn('세그먼트 정리 실패:', e);
    }

    addStep(stepsEl, 'step-saved', `회의록이 자동 저장되었습니다. (${meetingId})`, 'complete');

    // 결과 표시
    state.currentTranscript = transcript;
    state.currentSummary = summary;
    showResults(transcript, summary);

  } catch (e) {
    showError(e.message);
  } finally {
    state.processing = false;
    updateButtonStates();
  }
}

// ── 파일 재처리 ──
async function handleFileReprocess(file) {
  const apiKey = getApiKey();
  if (!apiKey) {
    showError('왼쪽 사이드바에서 Groq API Key를 먼저 입력해 주세요!');
    return;
  }

  const settings = getSettings();
  state.processing = true;
  updateButtonStates();

  const stepsEl = document.getElementById('processing-steps');
  stepsEl.hidden = false;
  stepsEl.innerHTML = '';

  try {
    // 전처리 + 분할
    addStep(stepsEl, 'step-preprocess', '음질 개선 및 파일 분할 중...', 'active');
    let wavSegments;
    try {
      wavSegments = await splitAudioFile(file);
    } catch (e) {
      console.warn('파일 분할 실패, 전처리만 시도:', e);
      try {
        const wav = await preprocessAudio(file);
        wavSegments = [wav];
      } catch (e2) {
        wavSegments = [file];
      }
    }
    updateStep('step-preprocess', `음질 개선 완료 (${wavSegments.length}개 세그먼트)`, 'complete');

    // STT
    addStep(stepsEl, 'step-stt', `1단계: 음성을 텍스트로 변환 중... (${wavSegments.length}개 세그먼트)`, 'active');
    const startTime = Date.now();
    const transcript = await transcribeAllSegments(
      wavSegments, apiKey, settings.sttModel, settings.keywords,
      (current, total) => {
        updateStep('step-stt', `1단계: 음성 → 텍스트 변환 중... (${current}/${total})`, 'active');
      }
    );
    const sttSec = Math.floor((Date.now() - startTime) / 1000);
    updateStep('step-stt', `1단계 완료: 음성 → 텍스트 변환 성공 (소요: ${Math.floor(sttSec / 60)}분 ${sttSec % 60}초)`, 'complete');

    // 요약
    addStep(stepsEl, 'step-summarize', '2단계: 회의록 요약 생성 중... (Groq API)', 'active');
    const summary = await summarize(transcript, apiKey, false);
    updateStep('step-summarize', '2단계 완료: 회의록 요약 생성 완료!', 'complete');

    // 저장
    const meetingId = generateMeetingId();
    await saveMeeting({
      id: meetingId,
      created_at: formatDateTime(),
      transcript,
      summary,
      reviewed: false,
    });
    addStep(stepsEl, 'step-saved', `회의록이 자동 저장되었습니다. (${meetingId})`, 'complete');

    state.currentTranscript = transcript;
    state.currentSummary = summary;
    showResults(transcript, summary);

  } catch (e) {
    showError(e.message);
  } finally {
    state.processing = false;
    updateButtonStates();
  }
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
}

function showError(msg) {
  const el = document.getElementById('record-error');
  if (el) {
    el.hidden = false;
    el.textContent = msg;
  }
}

function addStep(container, id, text, status) {
  const div = document.createElement('div');
  div.id = id;
  div.className = `step step-${status}`;
  div.innerHTML = `<span class="step-icon">${status === 'active' ? '⏳' : '✅'}</span> ${text}`;
  container.appendChild(div);
}

function updateStep(id, text, status) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `step step-${status}`;
  const icon = status === 'complete' ? '✅' : status === 'error' ? '❌' : '⏳';
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
