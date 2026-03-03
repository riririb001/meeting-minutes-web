/**
 * 회의록 상세 페이지
 * - 회의록 보기, 다운로드, 삭제
 * - STT 텍스트 교정 플로우 (수락/무시/직접수정)
 */

import { loadMeeting, updateMeeting, deleteMeeting as dbDeleteMeeting, loadRecording } from '../storage.js';
import { reviewTranscript, summarizeMeeting } from '../groq-api.js';
import { state, getApiKey, navigate } from '../app.js';
import { renderMarkdown, downloadTextFile, escapeHtml } from '../utils.js';

export async function renderDetailPage(container) {
  const meeting = await loadMeeting(state.detailId);

  if (!meeting) {
    container.innerHTML = `
      <div class="alert alert-error">회의록을 찾을 수 없습니다.</div>
      <button class="btn btn-secondary" id="btn-back-err">&#x2190; 목록으로 돌아가기</button>
    `;
    container.querySelector('#btn-back-err').addEventListener('click', () => {
      navigate('list');
    });
    return;
  }

  const displaySummary = meeting.final_summary || meeting.summary;
  const isReviewed = meeting.reviewed || false;

  // 리뷰 모드 확인
  if (state.reviewState.step === 'reviewing') {
    renderReviewMode(container, meeting, displaySummary, isReviewed);
    return;
  }

  renderNormalMode(container, meeting, displaySummary, isReviewed);
}

// ── 일반 모드 ─────────────────────────────────
function renderNormalMode(container, meeting, displaySummary, isReviewed) {
  container.innerHTML = `
    <!-- 상단 버튼 -->
    <div class="btn-group" style="margin-bottom: 16px; flex-wrap: wrap;">
      <button class="btn btn-secondary" id="btn-back">&#x2190; 목록으로 돌아가기</button>
      <button class="btn btn-secondary" id="btn-download">&#x1F4E5; 다운로드 (.txt)</button>
      <button class="btn btn-danger" id="btn-delete">&#x1F5D1; 삭제</button>
    </div>

    <hr class="divider">

    <p class="page-caption">작성일시: ${meeting.created_at}</p>
    ${isReviewed ? '<div class="alert alert-success">텍스트 교정 후 회의록이 재생성되었습니다.</div>' : ''}

    <!-- 오디오 재생 -->
    <div id="audio-section"></div>

    <!-- 원본 텍스트 -->
    ${meeting.transcript ? `
    <div class="expander collapsed" id="transcript-expander">
      <div class="expander-header">&#x1F50A; 원본 텍스트 보기 (STT 결과)</div>
      <div class="expander-content">
        <textarea class="textarea" readonly>${escapeHtml(meeting.transcript)}</textarea>
      </div>
    </div>
    ` : ''}

    <!-- 요약 -->
    <div class="markdown-body">${renderMarkdown(displaySummary)}</div>

    <hr class="divider">

    <!-- 검토 버튼 -->
    <button class="btn btn-secondary btn-full" id="btn-review">
      &#x1F50D; ${isReviewed ? '음성 인식 재검토' : '음성 인식 텍스트 검토'}
    </button>
  `;

  // 이벤트 바인딩
  setupNormalEvents(container, meeting, displaySummary);
  loadAudioPlayer(container, meeting.id);
}

function setupNormalEvents(container, meeting, displaySummary) {
  // 뒤로 가기
  container.querySelector('#btn-back').addEventListener('click', () => {
    state.reviewState = { step: 'idle', issues: [], index: 0, transcript: '' };
    navigate('list');
  });

  // 다운로드
  container.querySelector('#btn-download').addEventListener('click', () => {
    const dateStr = meeting.created_at.slice(0, 10).replace(/-/g, '');
    downloadTextFile(displaySummary, `회의록_${dateStr}.txt`);
  });

  // 삭제
  container.querySelector('#btn-delete').addEventListener('click', async () => {
    if (!confirm('이 회의록을 삭제하시겠습니까?')) return;
    await dbDeleteMeeting(meeting.id);
    state.reviewState = { step: 'idle', issues: [], index: 0, transcript: '' };
    navigate('list');
  });

  // 접기/펼치기
  const expander = container.querySelector('#transcript-expander');
  if (expander) {
    expander.querySelector('.expander-header').addEventListener('click', () => {
      expander.classList.toggle('collapsed');
    });
  }

  // STT 검토
  container.querySelector('#btn-review').addEventListener('click', async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert('왼쪽 사이드바에서 Groq API Key를 먼저 입력해 주세요!');
      return;
    }
    if (!meeting.transcript) {
      alert('원본 텍스트가 없어 검토할 수 없습니다.');
      return;
    }

    const btn = container.querySelector('#btn-review');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> AI가 텍스트를 검토하고 있습니다...';

    try {
      const issues = await reviewTranscript(meeting.transcript, apiKey);
      state.reviewState = {
        step: 'reviewing',
        issues,
        index: 0,
        transcript: meeting.transcript,
      };
      renderDetailPage(container);
    } catch (err) {
      alert(`검토 실패: ${err.message}`);
      btn.disabled = false;
      btn.innerHTML = '&#x1F50D; 음성 인식 텍스트 검토';
    }
  });
}

// ── 오디오 플레이어 ───────────────────────────
async function loadAudioPlayer(container, meetingId) {
  const section = container.querySelector('#audio-section');
  try {
    const blob = await loadRecording(meetingId);
    if (blob) {
      const url = URL.createObjectURL(blob);
      section.innerHTML = `
        <div class="expander collapsed" id="audio-expander">
          <div class="expander-header">&#x1F3B5; 녹음 파일 재생</div>
          <div class="expander-content">
            <audio class="audio-player" controls src="${url}"></audio>
          </div>
        </div>
      `;
      section.querySelector('.expander-header').addEventListener('click', () => {
        section.querySelector('.expander').classList.toggle('collapsed');
      });
    }
  } catch (_) {
    // 녹음 파일이 없을 수 있음
  }
}

// ── 리뷰 모드 ─────────────────────────────────
function renderReviewMode(container, meeting, displaySummary, isReviewed) {
  const { issues, index, transcript: currentTranscript } = state.reviewState;

  // 이슈가 없는 경우
  if (!issues || issues.length === 0) {
    container.innerHTML = `
      <button class="btn btn-secondary" id="btn-back">&#x2190; 목록으로 돌아가기</button>
      <hr class="divider">
      <div class="alert alert-success">검토 결과, 수정이 필요한 부분이 없습니다! 음성 인식이 잘 되었습니다.</div>
    `;
    container.querySelector('#btn-back').addEventListener('click', () => {
      state.reviewState = { step: 'idle', issues: [], index: 0, transcript: '' };
      navigate('detail', { detailId: meeting.id });
    });
    return;
  }

  // 모든 항목 검토 완료
  if (index >= issues.length) {
    renderReviewComplete(container, meeting);
    return;
  }

  // 현재 이슈
  const issue = issues[index];
  const originalText = issue.original || '';

  // 이전 교정으로 이미 사라진 텍스트면 건너뛰기
  if (originalText && !currentTranscript.includes(originalText)) {
    state.reviewState.index = index + 1;
    renderDetailPage(container);
    return;
  }

  const occurCount = originalText ? (currentTranscript.match(new RegExp(escapeRegex(originalText), 'g')) || []).length : 0;
  const progressPct = ((index) / issues.length * 100).toFixed(0);

  container.innerHTML = `
    <button class="btn btn-secondary" id="btn-back-review">&#x2190; 검토 중단하고 돌아가기</button>
    <hr class="divider">

    <h2 class="section-title">&#x1F50D; 음성 인식 텍스트 검토</h2>

    <div class="progress-bar"><div class="progress-fill" style="width: ${progressPct}%"></div></div>
    <div class="progress-text">진행: ${index + 1} / ${issues.length}</div>

    <!-- 현재 텍스트 전체 보기 -->
    <div class="expander collapsed" id="review-transcript-expander" style="margin: 12px 0;">
      <div class="expander-header">&#x1F4DD; 현재 텍스트 전체 보기</div>
      <div class="expander-content">
        <textarea class="textarea" readonly>${escapeHtml(currentTranscript)}</textarea>
      </div>
    </div>

    <!-- 이슈 카드 -->
    <div class="card">
      <div class="card-title">#${index + 1}. ${escapeHtml(issue.reason || '수정 제안')}</div>
      ${occurCount > 1 ? `<p class="caption" style="margin-top: 4px;">이 표현이 텍스트에 <strong>${occurCount}번</strong> 등장합니다 - 수락 시 모두 수정됩니다.</p>` : ''}

      <div class="correction-compare">
        <div>
          <div class="correction-label">인식된 텍스트:</div>
          <div class="code-block">${escapeHtml(originalText)}</div>
        </div>
        <div class="correction-arrow">&#x2192;</div>
        <div>
          <div class="correction-label">수정 제안:</div>
          <div class="code-block">${escapeHtml(issue.suggestion || '')}</div>
        </div>
      </div>

      <hr class="divider">

      <div class="btn-group-3">
        <button class="btn btn-primary" id="btn-accept">&#x2705; 수락</button>
        <button class="btn btn-secondary" id="btn-custom-toggle">&#x270F; 직접 수정</button>
        <button class="btn btn-secondary" id="btn-skip">&#x23ED; 무시</button>
      </div>

      <!-- 직접 수정 영역 (숨김) -->
      <div id="custom-edit-area" style="display: none; margin-top: 12px;">
        <label style="font-size: 13px; font-weight: 500;">수정할 내용을 입력하세요:</label>
        <input type="text" class="text-input" id="custom-input" value="${escapeHtml(issue.suggestion || '')}" style="margin: 6px 0;">
        <button class="btn btn-primary btn-full" id="btn-apply-custom">적용</button>
      </div>
    </div>
  `;

  // 이벤트 바인딩
  setupReviewEvents(container, meeting, issue, index);
}

function setupReviewEvents(container, meeting, issue, index) {
  // 뒤로 가기
  container.querySelector('#btn-back-review').addEventListener('click', () => {
    state.reviewState = { step: 'idle', issues: [], index: 0, transcript: '' };
    renderDetailPage(container);
  });

  // 접기/펼치기
  const expander = container.querySelector('#review-transcript-expander');
  if (expander) {
    expander.querySelector('.expander-header').addEventListener('click', () => {
      expander.classList.toggle('collapsed');
    });
  }

  // 수락
  container.querySelector('#btn-accept').addEventListener('click', () => {
    const originalText = issue.original || '';
    const replacement = issue.suggestion || '';
    if (originalText && replacement) {
      state.reviewState.transcript = state.reviewState.transcript.replaceAll(originalText, replacement);
    }
    state.reviewState.index = index + 1;
    renderDetailPage(container);
  });

  // 무시
  container.querySelector('#btn-skip').addEventListener('click', () => {
    state.reviewState.index = index + 1;
    renderDetailPage(container);
  });

  // 직접 수정 토글
  container.querySelector('#btn-custom-toggle').addEventListener('click', () => {
    const area = container.querySelector('#custom-edit-area');
    area.style.display = area.style.display === 'none' ? 'block' : 'none';
    if (area.style.display === 'block') {
      container.querySelector('#custom-input').focus();
    }
  });

  // 직접 수정 적용
  container.querySelector('#btn-apply-custom').addEventListener('click', () => {
    const originalText = issue.original || '';
    const customText = container.querySelector('#custom-input').value;
    if (originalText && customText) {
      state.reviewState.transcript = state.reviewState.transcript.replaceAll(originalText, customText);
    }
    state.reviewState.index = index + 1;
    renderDetailPage(container);
  });
}

// ── 검토 완료 → 회의록 재생성 ──────────────────
function renderReviewComplete(container, meeting) {
  const currentTranscript = state.reviewState.transcript;

  container.innerHTML = `
    <button class="btn btn-secondary" id="btn-back-done">&#x2190; 목록으로 돌아가기</button>
    <hr class="divider">

    <h2 class="section-title">&#x2705; 텍스트 교정 완료</h2>
    <div class="alert alert-info">모든 항목의 검토가 끝났습니다. 교정된 텍스트로 회의록을 다시 생성합니다.</div>

    <div class="expander collapsed" id="corrected-expander">
      <div class="expander-header">&#x1F4DD; 교정된 텍스트 확인</div>
      <div class="expander-content">
        <textarea class="textarea" readonly>${escapeHtml(currentTranscript)}</textarea>
      </div>
    </div>

    <button class="btn btn-primary btn-full" id="btn-regenerate">&#x1F4DD; 회의록 재생성</button>
    <div id="regenerate-status"></div>
  `;

  // 뒤로 가기
  container.querySelector('#btn-back-done').addEventListener('click', () => {
    state.reviewState = { step: 'idle', issues: [], index: 0, transcript: '' };
    navigate('list');
  });

  // 접기/펼치기
  container.querySelector('#corrected-expander .expander-header').addEventListener('click', () => {
    container.querySelector('#corrected-expander').classList.toggle('collapsed');
  });

  // 회의록 재생성
  container.querySelector('#btn-regenerate').addEventListener('click', async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert('왼쪽 사이드바에서 Groq API Key를 먼저 입력해 주세요!');
      return;
    }

    const btn = container.querySelector('#btn-regenerate');
    const statusArea = container.querySelector('#regenerate-status');
    btn.disabled = true;
    statusArea.innerHTML = '<div class="alert alert-info"><span class="spinner"></span> 교정된 텍스트로 회의록을 다시 생성하고 있습니다...</div>';

    try {
      const newSummary = await summarizeMeeting(currentTranscript, apiKey);

      meeting.transcript = currentTranscript;
      meeting.summary = newSummary;
      meeting.final_summary = newSummary;
      meeting.reviewed = true;
      await updateMeeting(meeting.id, meeting);

      state.reviewState = { step: 'idle', issues: [], index: 0, transcript: '' };
      statusArea.innerHTML = '<div class="alert alert-success">회의록이 재생성되었습니다!</div>';

      // 1초 후 상세 페이지로 복귀
      setTimeout(() => renderDetailPage(container), 1000);
    } catch (err) {
      statusArea.innerHTML = `<div class="alert alert-error">재생성 실패: ${err.message}</div>`;
      btn.disabled = false;
    }
  });
}

/** 정규식 특수문자 이스케이프 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
