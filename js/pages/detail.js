/**
 * pages/detail.js - 회의록 상세 페이지 + STT 교정 워크플로우
 * app.py render_detail_page() 이식
 */

import { loadMeeting, updateMeeting, deleteMeeting } from '../storage.js';
import { summarize, reviewTranscript } from '../groq-api.js';
import { renderMarkdown, escapeHtml, downloadAsText } from '../utils.js';
import { navigate, getApiKey, state } from '../app.js';

// 교정 상태
let reviewState = {
  step: 'idle',     // idle | loading | reviewing | done
  issues: [],
  index: 0,
  transcript: '',
  meetingId: '',
};

export function resetReviewState() {
  reviewState = { step: 'idle', issues: [], index: 0, transcript: '', meetingId: '' };
}

export async function renderDetailPage(meetingId) {
  const app = document.getElementById('app');

  const meeting = await loadMeeting(meetingId);
  if (!meeting) {
    app.innerHTML = `
      <div class="status-box status-error">회의록을 찾을 수 없습니다.</div>
      <button class="btn btn-secondary" id="btn-back">← 목록으로 돌아가기</button>
    `;
    document.getElementById('btn-back').addEventListener('click', () => {
      resetReviewState();
      navigate('list');
    });
    return;
  }

  const displaySummary = meeting.final_summary || meeting.summary;
  const isReviewed = meeting.reviewed || false;

  // 교정 모드일 때
  if (reviewState.step === 'reviewing' && reviewState.meetingId === meetingId) {
    renderReviewMode(app, meeting, displaySummary);
    return;
  }

  if (reviewState.step === 'done' && reviewState.meetingId === meetingId) {
    renderReviewComplete(app, meeting);
    return;
  }

  // 기본 상세 보기
  app.innerHTML = `
    <div class="detail-toolbar">
      <button class="btn btn-secondary" id="btn-back">← 목록으로 돌아가기</button>
      <button class="btn btn-secondary" id="btn-download">다운로드 (.txt)</button>
      <button class="btn btn-danger-outline" id="btn-delete">삭제</button>
    </div>
    <hr>
    <p class="caption">작성일시: ${escapeHtml(meeting.created_at)}</p>
    ${isReviewed ? '<div class="status-box status-success">텍스트 교정 후 회의록이 재생성되었습니다.</div>' : ''}

    ${meeting.transcript ? `
    <details class="collapsible">
      <summary>원본 텍스트 보기 (STT 결과)</summary>
      <textarea readonly rows="8">${escapeHtml(meeting.transcript)}</textarea>
    </details>
    ` : ''}

    <div class="markdown-body">${renderMarkdown(displaySummary)}</div>

    <hr>
    <button class="btn btn-primary" id="btn-review" style="width:100%;">
      ${isReviewed ? '음성 인식 재검토' : '음성 인식 텍스트 검토'}
    </button>
    <p class="caption" style="text-align:center; margin-top:4px;">
      AI가 음성 인식 텍스트에서 잘못 변환된 부분을 찾고, 교정 후 회의록을 다시 생성합니다
    </p>
  `;

  // 이벤트
  document.getElementById('btn-back').addEventListener('click', () => {
    resetReviewState();
    navigate('list');
  });

  document.getElementById('btn-download').addEventListener('click', () => {
    const fn = `회의록_${(meeting.created_at || '').slice(0, 10).replace(/-/g, '')}.txt`;
    downloadAsText(displaySummary, fn);
  });

  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (!confirm('이 회의록을 삭제하시겠습니까?')) return;
    try {
      await deleteMeeting(meetingId);
      resetReviewState();
      navigate('list');
    } catch (e) {
      alert('삭제 실패: ' + e.message);
    }
  });

  document.getElementById('btn-review').addEventListener('click', async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert('왼쪽 사이드바에서 Groq API Key를 먼저 입력해 주세요!');
      return;
    }
    if (!meeting.transcript) {
      alert('원본 텍스트가 없어 검토할 수 없습니다.');
      return;
    }

    // 검토 시작
    reviewState.step = 'loading';
    reviewState.meetingId = meetingId;
    app.innerHTML = `
      <div class="status-box status-info">
        <span class="step-icon">⏳</span> AI가 음성 인식 텍스트를 검토하고 있습니다...
      </div>
    `;

    try {
      const issues = await reviewTranscript(meeting.transcript, apiKey);
      reviewState.issues = issues;
      reviewState.index = 0;
      reviewState.transcript = meeting.transcript;

      if (!issues || issues.length === 0) {
        reviewState.step = 'idle';
        app.innerHTML = `
          <div class="status-box status-success">검토 결과, 수정이 필요한 부분이 없습니다! 음성 인식이 잘 되었습니다.</div>
          <button class="btn btn-secondary" id="btn-back" style="margin-top:12px;">← 돌아가기</button>
        `;
        document.getElementById('btn-back').addEventListener('click', () => renderDetailPage(meetingId));
        return;
      }

      reviewState.step = 'reviewing';
      renderDetailPage(meetingId);
    } catch (e) {
      reviewState.step = 'idle';
      alert('검토 실패: ' + e.message);
      renderDetailPage(meetingId);
    }
  });
}

// ── 교정 모드 ──
function renderReviewMode(app, meeting) {
  const issues = reviewState.issues;
  let idx = reviewState.index;

  // 이전 교정으로 사라진 텍스트 건너뛰기
  while (idx < issues.length) {
    const orig = issues[idx].original || '';
    if (orig && !reviewState.transcript.includes(orig)) {
      idx++;
      reviewState.index = idx;
      continue;
    }
    break;
  }

  // 모든 항목 완료
  if (idx >= issues.length) {
    reviewState.step = 'done';
    renderReviewComplete(app, meeting);
    return;
  }

  const issue = issues[idx];
  const original = issue.original || '';
  const suggestion = issue.suggestion || '';
  const reason = issue.reason || '수정 제안';
  const occurCount = original ? (reviewState.transcript.split(original).length - 1) : 0;

  app.innerHTML = `
    <h2>음성 인식 텍스트 검토</h2>
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${((idx) / issues.length) * 100}%"></div>
    </div>
    <p class="caption" style="text-align:center;">진행: ${idx + 1} / ${issues.length}</p>

    <details class="collapsible">
      <summary>현재 텍스트 전체 보기</summary>
      <textarea readonly rows="6">${escapeHtml(reviewState.transcript)}</textarea>
    </details>

    <div class="review-card">
      <h3>#${idx + 1}. ${escapeHtml(reason)}</h3>
      ${occurCount > 1 ? `<p class="caption">이 표현이 텍스트에 <strong>${occurCount}번</strong> 등장합니다 → 수락 시 모두 수정됩니다.</p>` : ''}

      <div class="comparison">
        <div class="comp-side">
          <label>인식된 텍스트:</label>
          <code>${escapeHtml(original)}</code>
        </div>
        <div class="comp-arrow">→</div>
        <div class="comp-side">
          <label>수정 제안:</label>
          <code>${escapeHtml(suggestion)}</code>
        </div>
      </div>

      <div class="review-actions">
        <button class="btn btn-primary" id="btn-accept">수락</button>
        <button class="btn btn-secondary" id="btn-skip">무시</button>
      </div>

      <details class="collapsible" style="margin-top:12px;">
        <summary>직접 수정하기</summary>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <input type="text" id="custom-text" class="sidebar-input" style="flex:1; color:var(--text); background:var(--bg-secondary);">
          <button class="btn btn-secondary" id="btn-apply-custom">적용</button>
        </div>
      </details>
    </div>
  `;

  // input value를 프로그래밍 방식으로 설정 (XSS 방지)
  const customInput = document.getElementById('custom-text');
  if (customInput) customInput.value = suggestion;

  document.getElementById('btn-accept').addEventListener('click', () => {
    if (original && suggestion) {
      reviewState.transcript = reviewState.transcript.replaceAll(original, suggestion);
    }
    reviewState.index = idx + 1;
    renderDetailPage(reviewState.meetingId);
  });

  document.getElementById('btn-skip').addEventListener('click', () => {
    reviewState.index = idx + 1;
    renderDetailPage(reviewState.meetingId);
  });

  document.getElementById('btn-apply-custom').addEventListener('click', () => {
    const custom = document.getElementById('custom-text').value;
    if (original && custom) {
      reviewState.transcript = reviewState.transcript.replaceAll(original, custom);
    }
    reviewState.index = idx + 1;
    renderDetailPage(reviewState.meetingId);
  });
}

// ── 교정 완료 ──
function renderReviewComplete(app, meeting) {
  app.innerHTML = `
    <h2>텍스트 교정 완료</h2>
    <div class="status-box status-info">모든 항목의 검토가 끝났습니다. 교정된 텍스트로 회의록을 다시 생성합니다.</div>

    <details class="collapsible">
      <summary>교정된 텍스트 확인</summary>
      <textarea readonly rows="6">${escapeHtml(reviewState.transcript)}</textarea>
    </details>

    <button class="btn btn-primary" id="btn-regenerate" style="width:100%; margin-top:12px;">
      회의록 재생성
    </button>
  `;

  document.getElementById('btn-regenerate').addEventListener('click', async () => {
    const apiKey = getApiKey();
    if (!apiKey) {
      alert('Groq API Key를 입력해 주세요.');
      return;
    }

    const btn = document.getElementById('btn-regenerate');
    btn.disabled = true;
    btn.textContent = '회의록을 재생성하고 있습니다...';

    try {
      const hasSpeakers = reviewState.transcript.includes('[화자');
      const newSummary = await summarize(reviewState.transcript, apiKey, hasSpeakers);

      await updateMeeting(meeting.id, {
        transcript: reviewState.transcript,
        summary: newSummary,
        final_summary: newSummary,
        reviewed: true,
      });

      resetReviewState();
      renderDetailPage(meeting.id);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '회의록 재생성';
      alert('재생성 실패: ' + e.message);
    }
  });
}
