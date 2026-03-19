/**
 * app.js - 앱 진입점, 라우터, 전역 상태
 * + Phase 2: toast 알림, 저장 공간 체크
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

// ── Toast 알림 시스템 ──
export function showToast(message, type = 'info') {
  // 기존 toast 제거
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // 표시 애니메이션
  requestAnimationFrame(() => toast.classList.add('toast-show'));

  // 3초 후 자동 제거
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── 저장 공간 체크 ──
export async function checkStorageQuota() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    } catch (e) {
      return null;
    }
  }
  return null;
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

  // 모바일: 네비게이션 시 사이드바 닫기
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('open');

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

  document.querySelectorAll('input[name="stt-model"]').forEach((r) => {
    r.addEventListener('change', () => localStorage.setItem('stt_model', r.value));
  });

  // 키워드 복원
  const savedKeywords = localStorage.getItem('stt_keywords') || '';
  const keywordsInput = document.getElementById('input-keywords');
  if (keywordsInput && savedKeywords) keywordsInput.value = savedKeywords;
  if (keywordsInput) {
    keywordsInput.addEventListener('input', () => localStorage.setItem('stt_keywords', keywordsInput.value));
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
    menuToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.getElementById('app').addEventListener('click', () => sidebar.classList.remove('open'));
  }

  // API 키 가이드 모달
  const guideBtn = document.getElementById('btn-api-guide');
  const guideModal = document.getElementById('modal-api-guide');
  const guideClose = document.getElementById('modal-close');
  if (guideBtn && guideModal) {
    guideBtn.addEventListener('click', () => { guideModal.hidden = false; });
    if (guideClose) guideClose.addEventListener('click', () => { guideModal.hidden = true; });
    guideModal.addEventListener('click', (e) => { if (e.target === guideModal) guideModal.hidden = true; });
  }

  // crash recovery 체크
  try {
    const orphanIds = await getOrphanedRecordingIds();
    if (orphanIds.length > 0) {
      for (const id of orphanIds) await deleteAudioSegments(id);
    }
  } catch (e) { console.warn('crash recovery 체크 실패:', e); }

  window.addEventListener('hashchange', render);
  render();
}

document.addEventListener('DOMContentLoaded', init);
