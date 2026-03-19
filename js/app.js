/**
 * app.js - 앱 진입점, 라우터, 전역 상태
 */

import { initDB, getOrphanedRecordingIds, deleteAudioSegments } from './storage.js';
import { renderRecordPage } from './pages/record.js';
import { renderListPage } from './pages/list.js';
import { renderDetailPage, resetReviewState } from './pages/detail.js';

// ── 전역 상태 ──
export const state = {
  currentPage: 'record',
  detailId: null,
  processing: false,
  currentTranscript: '',
  currentSummary: '',
};

// ── API 키 & 설정 ──
export function getApiKey() {
  const input = document.getElementById('input-api-key');
  return input ? input.value.trim() : '';
}

export function getSettings() {
  const modelRadios = document.querySelectorAll('input[name="stt-model"]');
  let sttModel = 'whisper-large-v3';
  for (const r of modelRadios) {
    if (r.checked) { sttModel = r.value; break; }
  }

  const keywordsEl = document.getElementById('input-keywords');
  const keywords = keywordsEl ? keywordsEl.value.trim() : '';

  return { sttModel, keywords };
}

// ── 라우팅 ──
export function navigate(page, param = null) {
  if (page === 'detail' && param) {
    location.hash = `#detail/${param}`;
  } else {
    location.hash = `#${page}`;
  }
}

function parseHash() {
  const hash = location.hash.slice(1) || 'record';
  if (hash.startsWith('detail/')) {
    return { page: 'detail', id: hash.slice(7) };
  }
  return { page: hash, id: null };
}

async function render() {
  const { page, id } = parseHash();
  state.currentPage = page;
  state.detailId = id;

  // 사이드바 활성 상태 업데이트
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page || (page === 'detail' && btn.dataset.page === 'list'));
  });

  switch (page) {
    case 'record':
      renderRecordPage();
      break;
    case 'list':
      await renderListPage();
      break;
    case 'detail':
      if (id) await renderDetailPage(id);
      else navigate('list');
      break;
    default:
      navigate('record');
  }
}

// ── 초기화 ──
async function init() {
  // IndexedDB 초기화
  await initDB();

  // API 키 복원
  const savedKey = localStorage.getItem('groq_api_key') || '';
  const keyInput = document.getElementById('input-api-key');
  if (keyInput && savedKey) keyInput.value = savedKey;

  // API 키 자동 저장
  if (keyInput) {
    let debounce = null;
    keyInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        localStorage.setItem('groq_api_key', keyInput.value.trim());
      }, 300);
    });
  }

  // STT 모델 복원
  const savedModel = localStorage.getItem('stt_model') || 'whisper-large-v3';
  const modelRadio = document.querySelector(`input[name="stt-model"][value="${savedModel}"]`);
  if (modelRadio) modelRadio.checked = true;

  // STT 모델 변경 저장
  document.querySelectorAll('input[name="stt-model"]').forEach((r) => {
    r.addEventListener('change', () => {
      localStorage.setItem('stt_model', r.value);
    });
  });

  // 키워드 복원
  const savedKeywords = localStorage.getItem('stt_keywords') || '';
  const keywordsInput = document.getElementById('input-keywords');
  if (keywordsInput && savedKeywords) keywordsInput.value = savedKeywords;
  if (keywordsInput) {
    keywordsInput.addEventListener('input', () => {
      localStorage.setItem('stt_keywords', keywordsInput.value);
    });
  }

  // 사이드바 네비게이션
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      resetReviewState();
      navigate(btn.dataset.page);
    });
  });

  // 모바일 메뉴 토글
  const menuToggle = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');
  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
    // 메뉴 외부 클릭 시 닫기
    document.getElementById('app').addEventListener('click', () => {
      sidebar.classList.remove('open');
    });
  }

  // API 키 가이드 모달
  const guideBtn = document.getElementById('btn-api-guide');
  const guideModal = document.getElementById('modal-api-guide');
  const guideClose = document.getElementById('modal-close');
  if (guideBtn && guideModal) {
    guideBtn.addEventListener('click', () => { guideModal.hidden = false; });
    if (guideClose) guideClose.addEventListener('click', () => { guideModal.hidden = true; });
    guideModal.addEventListener('click', (e) => {
      if (e.target === guideModal) guideModal.hidden = true;
    });
  }

  // crash recovery 체크
  try {
    const orphanIds = await getOrphanedRecordingIds();
    if (orphanIds.length > 0) {
      console.log(`이전 녹음 세그먼트 ${orphanIds.length}건 발견 (자동 정리)`);
      for (const id of orphanIds) {
        await deleteAudioSegments(id);
      }
    }
  } catch (e) {
    console.warn('crash recovery 체크 실패:', e);
  }

  // 해시 변경 감지
  window.addEventListener('hashchange', render);

  // 초기 렌더링
  render();
}

document.addEventListener('DOMContentLoaded', init);
