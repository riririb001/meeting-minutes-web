/**
 * pages/list.js - 회의록 목록 페이지
 * app.py render_list_page() 이식
 */

import { loadMeetings } from '../storage.js';
import { extractPreview, escapeHtml } from '../utils.js';
import { navigate } from '../app.js';

export async function renderListPage() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <h1>회의록 목록</h1>
    <p class="caption">저장된 회의록을 확인할 수 있습니다.</p>
    <hr>
    <div id="meeting-list"><p class="loading">불러오는 중...</p></div>
  `;

  try {
    const meetings = await loadMeetings();
    const listEl = document.getElementById('meeting-list');

    if (!meetings || meetings.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          저장된 회의록이 없습니다.<br>새 녹음을 시작해 보세요.
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    for (const meeting of meetings) {
      const preview = extractPreview(meeting.summary);
      const reviewed = meeting.reviewed ? '<span class="badge badge-reviewed">교정됨</span>' : '';

      const card = document.createElement('div');
      card.className = 'meeting-card';
      card.innerHTML = `
        <div class="card-info">
          <strong>${escapeHtml(meeting.created_at)}</strong>
          ${reviewed}
          <p class="card-preview">${escapeHtml(preview)}</p>
        </div>
        <button class="btn btn-small btn-primary">보기</button>
      `;

      card.querySelector('button').addEventListener('click', () => {
        navigate('detail', meeting.id);
      });

      listEl.appendChild(card);
    }
  } catch (e) {
    document.getElementById('meeting-list').innerHTML = `
      <div class="status-box status-error">목록 로드 실패: ${escapeHtml(e.message)}</div>
    `;
  }
}
