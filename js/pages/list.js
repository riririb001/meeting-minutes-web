/**
 * 회의록 목록 페이지
 */

import { loadMeetings } from '../storage.js';
import { navigate } from '../app.js';
import { extractPreview } from '../utils.js';

export async function renderListPage(container) {
  container.innerHTML = `
    <h1 class="page-title">&#x1F4C2; 회의록 목록</h1>
    <p class="page-caption">저장된 회의록을 확인할 수 있습니다.</p>
    <hr class="divider">
    <div id="meeting-list"></div>
  `;

  const listDiv = container.querySelector('#meeting-list');

  try {
    const meetings = await loadMeetings();

    if (meetings.length === 0) {
      listDiv.innerHTML = `
        <div class="empty-state">
          저장된 회의록이 없습니다.<br>새 녹음을 시작해 보세요.
        </div>
      `;
      return;
    }

    for (const meeting of meetings) {
      const preview = extractPreview(meeting.summary);
      const reviewed = meeting.reviewed ? '<span class="badge badge-success">교정 완료</span>' : '';
      const templateBadge = meeting.template_name
        ? `<span class="badge badge-template">${meeting.template_name}</span>`
        : '';

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-header">
          <div>
            <div class="card-title">${meeting.created_at} ${templateBadge} ${reviewed}</div>
            <div class="card-caption">${preview}</div>
          </div>
          <button class="btn btn-secondary btn-view" data-id="${meeting.id}">보기</button>
        </div>
      `;
      listDiv.appendChild(card);
    }

    // 보기 버튼 이벤트
    listDiv.querySelectorAll('.btn-view').forEach(btn => {
      btn.addEventListener('click', () => {
        navigate('detail', { detailId: btn.dataset.id });
      });
    });

  } catch (err) {
    listDiv.innerHTML = `<div class="alert alert-error">회의록 목록 로드 실패: ${err.message}</div>`;
  }
}
