/**
 * utils.js - 유틸리티 함수
 */

/** 회의록 ID 생성 (meeting_YYYYMMDD_HHMMSS.json) */
export function generateMeetingId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `meeting_${ts}.json`;
}

/** 날짜 포맷 "2026-03-19 14:30:22" */
export function formatDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 경과 시간 포맷 "00:05:23" */
export function formatElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 파일 크기 포맷 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 오늘 날짜 "2026년 03월 19일" */
export function todayString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}년 ${pad(now.getMonth() + 1)}월 ${pad(now.getDate())}일`;
}

/** HTML 이스케이프 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** 마크다운 → HTML 변환 (회의록 출력용) */
export function renderMarkdown(md) {
  if (!md) return '';
  let html = escapeHtml(md);

  // 코드 블록 (``` ... ```) — 먼저 처리하여 내부가 변환되지 않도록
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${code}</code></pre>`;
  });

  // 테이블
  html = html.replace(/((?:\|.*\|\n)+)/g, (table) => {
    const rows = table.trim().split('\n');
    if (rows.length < 2) return table;
    let result = '<table>';
    rows.forEach((row, i) => {
      // 구분선(---|---) 무시
      if (/^\|[\s\-:]+\|$/.test(row.replace(/\|/g, '|').trim())) return;
      const tag = i === 0 ? 'th' : 'td';
      const cells = row.split('|').filter((_, ci, arr) => ci > 0 && ci < arr.length - 1);
      result += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    result += '</table>';
    return result;
  });

  // 헤딩
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 수평선
  html = html.replace(/^---+$/gm, '<hr>');
  html = html.replace(/^────+$/gm, '<hr>');

  // 볼드
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 리스트
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // 번호 리스트
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
  html = html.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (m) => '<ol>' + m.replace(/<\/?oli>/g, (t) => t.replace('oli', 'li')) + '</ol>');
  html = html.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');

  // 줄바꿈
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';

  // 빈 <p> 제거
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>\s*(<h[1-3]>)/g, '$1');
  html = html.replace(/(<\/h[1-3]>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<hr>)/g, '$1');
  html = html.replace(/(<hr>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<table>)/g, '$1');
  html = html.replace(/(<\/table>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');

  return html;
}

/** 요약 미리보기 추출 (목록 카드용) */
export function extractPreview(summary) {
  if (!summary) return '(내용 미리보기 없음)';
  const lines = summary.trim().split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (s && !s.startsWith('#') && !s.startsWith('**') && !s.startsWith('---') && !s.startsWith('────')) {
      return s.length > 80 ? s.slice(0, 80) + '...' : s;
    }
  }
  return '(내용 미리보기 없음)';
}

/** 텍스트 파일 다운로드 */
export function downloadAsText(content, filename) {
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
