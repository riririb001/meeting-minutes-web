/**
 * 녹음 페이지
 * - 마이크 녹음 시작/중지
 * - 기존 오디오 파일 업로드
 * - STT → 요약 파이프라인
 */

import { AudioRecorder } from '../recorder.js';
import { transcribeAudio, summarizeMeeting } from '../groq-api.js';
import { saveMeeting, saveRecording } from '../storage.js';
import { state, getApiKey } from '../app.js';
import {
  generateMeetingId, getCurrentTimestamp, formatDuration,
  formatFileSize, renderMarkdown, downloadTextFile,
} from '../utils.js';

let recorder = new AudioRecorder();
let statusInterval = null;

export function renderRecordPage(container) {
  container.innerHTML = `
    <h1 class="page-title">회의록 자동 생성기</h1>
    <p class="page-caption">마이크로 회의를 녹음하면 AI가 자동으로 회의록을 생성합니다.</p>
    <hr class="divider">

    <!-- 녹음 버튼 -->
    <div class="btn-group-equal" id="record-buttons">
      <button class="btn btn-primary" id="btn-start" ${recorder.isRecording || state.processing ? 'disabled' : ''}>
        &#x1F399; 녹음 시작
      </button>
      <button class="btn btn-secondary" id="btn-stop" ${!recorder.isRecording || state.processing ? 'disabled' : ''}>
        &#x23F9; 녹음 종료 및 요약하기
      </button>
    </div>

    <!-- 녹음 상태 -->
    <div id="recording-status"></div>

    <!-- 처리 상태 -->
    <div id="processing-status"></div>

    <!-- 결과 -->
    <div id="result-area"></div>

    <hr class="divider">

    <!-- 기존 파일 업로드 -->
    <h2 class="section-title">&#x1F4C1; 기존 오디오 파일로 회의록 생성</h2>
    <p class="page-caption">이전에 녹음한 오디오 파일을 업로드하여 회의록을 생성할 수 있습니다.</p>

    <div class="file-upload-area" id="upload-area">
      <div class="file-upload-icon">&#x1F4E4;</div>
      <div class="file-upload-text">클릭하거나 파일을 드래그하세요<br>(WAV, MP3, WebM, M4A, MP4)</div>
      <input type="file" class="file-upload-input" id="file-input"
             accept="audio/*,.wav,.mp3,.webm,.m4a,.mp4,.ogg">
    </div>
    <div id="upload-info"></div>
  `;

  setupRecordingEvents(container);
  setupUploadEvents(container);
  showCurrentResults(container);

  // 녹음 중이면 상태 표시 시작
  if (recorder.isRecording) {
    startStatusUpdates(container);
  }
}

function setupRecordingEvents(container) {
  const btnStart = container.querySelector('#btn-start');
  const btnStop = container.querySelector('#btn-stop');

  btnStart.addEventListener('click', async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      showAlert(container, '#processing-status', 'error', '왼쪽 사이드바에서 Groq API Key를 먼저 입력해 주세요!');
      return;
    }

    try {
      await recorder.start();
      btnStart.disabled = true;
      btnStop.disabled = false;
      startStatusUpdates(container);
    } catch (err) {
      showAlert(container, '#processing-status', 'error', `녹음 시작 실패: ${err.message}`);
    }
  });

  btnStop.addEventListener('click', async () => {
    if (!recorder.isRecording) return;
    btnStop.disabled = true;
    stopStatusUpdates();

    const statusArea = container.querySelector('#processing-status');
    const resultArea = container.querySelector('#result-area');
    state.processing = true;

    try {
      // 1단계: 녹음 중지
      showAlert(container, '#processing-status', 'info',
        '<span class="spinner"></span> <strong>1단계:</strong> 녹음 종료 및 파일 마무리 중...');

      const result = await recorder.stop();
      if (!result || !result.blob || result.blob.size === 0) {
        showAlert(container, '#processing-status', 'error', '녹음된 데이터가 없습니다. 다시 시도해 주세요.');
        state.processing = false;
        return;
      }

      showAlert(container, '#processing-status', 'success',
        `<strong>1단계 완료:</strong> 음성 파일 준비 (${formatFileSize(result.blob.size)}, ${formatDuration(result.duration)})`);

      // 2단계: STT
      appendAlert(statusArea, 'info',
        '<span class="spinner"></span> <strong>2단계:</strong> 음성을 텍스트로 변환 중... (Groq Whisper API)');

      const apiKey = getApiKey();
      state.currentTranscript = await transcribeAudio(result.blob, apiKey, (current, total) => {
        if (total > 1) {
          updateLastAlert(statusArea,
            `<span class="spinner"></span> <strong>2단계:</strong> 음성 변환 중... (${current}/${total} 청크)`);
        }
      });

      updateLastAlert(statusArea, '<strong>2단계 완료:</strong> 음성 → 텍스트 변환 성공!', 'success');

      // 3단계: 요약
      appendAlert(statusArea, 'info',
        '<span class="spinner"></span> <strong>3단계:</strong> 회의록 요약 생성 중... (Groq API)');

      state.currentSummary = await summarizeMeeting(state.currentTranscript, apiKey);
      updateLastAlert(statusArea, '<strong>3단계 완료:</strong> 회의록 요약 생성 완료!', 'success');

      // 저장
      const meetingId = generateMeetingId();
      const meetingData = {
        id: meetingId,
        created_at: getCurrentTimestamp(),
        transcript: state.currentTranscript,
        summary: state.currentSummary,
      };
      await saveMeeting(meetingData);
      await saveRecording(meetingId, result.blob);

      appendAlert(statusArea, 'success', `회의록이 자동 저장되었습니다. (<code>${meetingId}</code>)`);

      // 결과 표시
      showResults(resultArea, state.currentTranscript, state.currentSummary);

    } catch (err) {
      appendAlert(statusArea, 'error', `처리 실패: ${err.message}`);
    } finally {
      state.processing = false;
      btnStart.disabled = false;
    }
  });
}

function setupUploadEvents(container) {
  const uploadArea = container.querySelector('#upload-area');
  const fileInput = container.querySelector('#file-input');
  const uploadInfo = container.querySelector('#upload-info');

  uploadArea.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file, container);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) handleFileUpload(file, container);
  });
}

async function handleFileUpload(file, container) {
  const apiKey = getApiKey();
  if (!apiKey) {
    showAlert(container, '#upload-info', 'error', '왼쪽 사이드바에서 Groq API Key를 먼저 입력해 주세요!');
    return;
  }

  if (state.processing || recorder.isRecording) {
    showAlert(container, '#upload-info', 'warning', '녹음 중이거나 처리 중에는 파일을 업로드할 수 없습니다.');
    return;
  }

  state.processing = true;
  const statusArea = container.querySelector('#upload-info');
  const resultArea = container.querySelector('#result-area');

  // 버튼 비활성화
  container.querySelector('#btn-start').disabled = true;

  try {
    showAlert(container, '#upload-info', 'info',
      `파일: <strong>${file.name}</strong> (${formatFileSize(file.size)})`);

    // 1단계: STT
    appendAlert(statusArea, 'info',
      '<span class="spinner"></span> <strong>1단계:</strong> 음성을 텍스트로 변환 중... (Groq Whisper API)');

    state.currentTranscript = await transcribeAudio(file, apiKey, (current, total) => {
      if (total > 1) {
        updateLastAlert(statusArea,
          `<span class="spinner"></span> <strong>1단계:</strong> 음성 변환 중... (${current}/${total} 청크)`);
      }
    });

    updateLastAlert(statusArea, '<strong>1단계 완료:</strong> 음성 → 텍스트 변환 성공!', 'success');

    // 2단계: 요약
    appendAlert(statusArea, 'info',
      '<span class="spinner"></span> <strong>2단계:</strong> 회의록 요약 생성 중... (Groq API)');

    state.currentSummary = await summarizeMeeting(state.currentTranscript, apiKey);
    updateLastAlert(statusArea, '<strong>2단계 완료:</strong> 회의록 요약 생성 완료!', 'success');

    // 저장
    const meetingId = generateMeetingId();
    const meetingData = {
      id: meetingId,
      created_at: getCurrentTimestamp(),
      transcript: state.currentTranscript,
      summary: state.currentSummary,
    };
    await saveMeeting(meetingData);
    await saveRecording(meetingId, file);

    appendAlert(statusArea, 'success', `회의록이 자동 저장되었습니다. (<code>${meetingId}</code>)`);

    // 결과 표시
    showResults(resultArea, state.currentTranscript, state.currentSummary);

  } catch (err) {
    appendAlert(statusArea, 'error', `처리 실패: ${err.message}`);
  } finally {
    state.processing = false;
    container.querySelector('#btn-start').disabled = false;
  }
}

// ── 녹음 상태 업데이트 ─────────────────────
function startStatusUpdates(container) {
  const statusDiv = container.querySelector('#recording-status');
  updateRecordingStatus(statusDiv);

  statusInterval = setInterval(() => {
    updateRecordingStatus(statusDiv);
  }, 1000);
}

function stopStatusUpdates() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
}

function updateRecordingStatus(statusDiv) {
  const status = recorder.getStatus();
  if (!status.isRecording) {
    statusDiv.innerHTML = '';
    return;
  }

  statusDiv.innerHTML = `
    <div class="alert alert-info">
      <span class="recording-indicator"></span>
      <strong>녹음 중입니다...</strong> 회의가 끝나면 [녹음 종료 및 요약하기] 버튼을 눌러주세요.<br>
      실시간 녹음: <strong>${formatDuration(status.elapsedSeconds)}</strong> (${formatFileSize(status.bytesRecorded)})
    </div>
  `;
}

// ── 결과 표시 ───────────────────────────────
function showCurrentResults(container) {
  if (!state.currentTranscript && !state.currentSummary) return;
  const resultArea = container.querySelector('#result-area');
  showResults(resultArea, state.currentTranscript, state.currentSummary);
}

function showResults(resultArea, transcript, summary) {
  resultArea.innerHTML = `
    <hr class="divider">

    ${transcript ? `
    <div class="expander collapsed" id="transcript-expander">
      <div class="expander-header">&#x1F50A; 원본 텍스트 보기 (STT 결과)</div>
      <div class="expander-content">
        <textarea class="textarea" readonly>${transcript}</textarea>
      </div>
    </div>
    ` : ''}

    ${summary ? `
    <h2 class="section-title">&#x1F4CB; 회의록 요약 결과</h2>
    <div class="markdown-body">${renderMarkdown(summary)}</div>
    <div style="margin-top: 12px;">
      <button class="btn btn-secondary" id="btn-download-result">
        &#x1F4E5; 회의록 다운로드 (.txt)
      </button>
    </div>
    ` : ''}
  `;

  // 접기/펼치기 이벤트
  const expander = resultArea.querySelector('#transcript-expander');
  if (expander) {
    expander.querySelector('.expander-header').addEventListener('click', () => {
      expander.classList.toggle('collapsed');
    });
  }

  // 다운로드 버튼
  const downloadBtn = resultArea.querySelector('#btn-download-result');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadTextFile(summary, `회의록_${today}.txt`);
    });
  }
}

// ── 알림 헬퍼 ───────────────────────────────
function showAlert(container, selector, type, message) {
  const el = container.querySelector(selector);
  el.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}

function appendAlert(parent, type, message) {
  parent.insertAdjacentHTML('beforeend', `<div class="alert alert-${type}">${message}</div>`);
}

function updateLastAlert(parent, message, type) {
  const alerts = parent.querySelectorAll('.alert');
  const last = alerts[alerts.length - 1];
  if (last) {
    if (type) {
      last.className = `alert alert-${type}`;
    }
    last.innerHTML = message;
  }
}
