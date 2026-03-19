/**
 * pages/list.js - 회의록 목록 페이지
 * Phase 2: 검색/필터 추가
 */

import { loadMeetings } from '../storage.js';
import { extractPreview, escapeHtml } from '../utils.js';
import { navigate } from '../app.js';

let allMeetings = [];

export async function renderListPage() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <h1>📂 회의록 목록</h1>
    <p class="caption">저장된 회의록을 확인할 수 있습니다.</p>
    <hr>
    <!-- Phase 2: 검색 -->
    <div class="search-bar">
      <input type="text" id="search-input" class="search-input" placeholder="회의록 검색 (날짜, 내용...)">
    </div>
    <div id="meeting-list"><p class="loading">불러오는 중...</p></div>
  `;

  try {
    allMeetings = await loadMeetings();
    renderMeetingCards(allMeetings);

    // 검색 이벤트
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) {
        renderMeetingCards(allMeetings);
        return;
      }
      const filtered = allMeetings.filter(m => {
        const searchable = [
          m.created_at || '',
          m.transcript || '',
          m.summary || '',
          m.final_summary || '',
          m.id || '',
        ].join(' ').toLowerCase();
        return searchable.includes(query);
      });
      renderMeetingCards(filtered);
    });
  } catch (e) {
    document.getElementById('meeting-list').innerHTML = `
      <div class="status-box status-error">목록 로드 실패: ${escapeHtml(e.message)}</div>
    `;
  }
}

function renderMeetingCards(meetings) {
  const listEl = document.getElementById('meeting-list');
  if (!listEl) return;

  if (!meetings || meetings.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        ${allMeetings.length > 0 ? '검색 결과가 없습니다.' : '저장된 회의록이 없습니다.<br>새 녹음을 시작해 보세요.'}
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
}
