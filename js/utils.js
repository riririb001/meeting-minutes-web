/**
 * 유틸리티 함수 모듈
 */

/** 회의록 ID 생성 (meeting_YYYYMMDD_HHMMSS.json) */
export function generateMeetingId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `meeting_${ts}.json`;
}

/** 현재 시각 문자열 (YYYY-MM-DD HH:MM:SS) */
export function getCurrentTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 오늘 날짜 (YYYY년 MM월 DD일) */
export function getTodayKorean() {
  const now = new Date();
  return `${now.getFullYear()}년 ${String(now.getMonth() + 1).padStart(2, '0')}월 ${String(now.getDate()).padStart(2, '0')}일`;
}

/** 시간 포맷 (초 → X분 Y초) */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

/** 파일 크기 포맷 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 요약에서 미리보기 텍스트 추출 (app.py 로직 재현) */
export function extractPreview(summary) {
  if (!summary) return '(내용 미리보기 없음)';
  const lines = summary.trim().split('\n');
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped && !stripped.startsWith('#') && !stripped.startsWith('**') && !stripped.startsWith('---')) {
      return stripped.length > 80 ? stripped.slice(0, 80) + '...' : stripped;
    }
  }
  return '(내용 미리보기 없음)';
}

/**
 * 마크다운 → HTML 변환 (간이 렌더러)
 * 회의록 프롬프트가 생성하는 포맷에 맞춤:
 * 제목(#), 볼드(**), 리스트(-), 테이블(|), 수평선(---), 코드(`), 번호 리스트
 */
export function renderMarkdown(text) {
  if (!text) return '';

  const lines = text.split('\n');
  let html = '';
  let inTable = false;
  let inList = false;
  let inOrderedList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // 테이블 구분선 (|---|---| 형태) → 건너뜀
    if (/^\|[\s\-:|]+\|$/.test(line.trim())) {
      continue;
    }

    // 테이블 행
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      if (!inTable) {
        if (inList) { html += '</ul>'; inList = false; }
        if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
        html += '<table>';
        inTable = true;
        // 첫 행은 헤더
        const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
        html += '<thead><tr>' + cells.map(c => `<th>${inlineFormat(c)}</th>`).join('') + '</tr></thead><tbody>';
        continue;
      }
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      html += '<tr>' + cells.map(c => `<td>${inlineFormat(c)}</td>`).join('') + '</tr>';
      continue;
    } else if (inTable) {
      html += '</tbody></table>';
      inTable = false;
    }

    // 수평선
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      if (inList) { html += '</ul>'; inList = false; }
      if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
      html += '<hr>';
      continue;
    }

    // 제목
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (inList) { html += '</ul>'; inList = false; }
      if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
      const level = headingMatch[1].length;
      html += `<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`;
      continue;
    }

    // 비순서 리스트
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineFormat(ulMatch[2])}</li>`;
      continue;
    }

    // 순서 리스트
    const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (olMatch) {
      if (inList) { html += '</ul>'; inList = false; }
      if (!inOrderedList) { html += '<ol>'; inOrderedList = true; }
      html += `<li>${inlineFormat(olMatch[2])}</li>`;
      continue;
    }

    // 리스트 종료
    if (inList) { html += '</ul>'; inList = false; }
    if (inOrderedList) { html += '</ol>'; inOrderedList = false; }

    // 빈 줄
    if (!line.trim()) {
      continue;
    }

    // 일반 단락
    html += `<p>${inlineFormat(line)}</p>`;
  }

  // 마무리
  if (inList) html += '</ul>';
  if (inOrderedList) html += '</ol>';
  if (inTable) html += '</tbody></table>';

  return html;
}

/** 인라인 마크다운 포맷 (볼드, 인라인코드, 링크) */
function inlineFormat(text) {
  return text
    // 인라인 코드
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 볼드
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // 링크
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/** HTML 이스케이프 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** 텍스트 파일 다운로드 트리거 */
export function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
