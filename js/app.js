/**
 * 앱 진입점 - 라우터, 전역 상태, 초기화
 */

import { initDB } from './storage.js';
import { renderRecordPage } from './pages/record.js';
import { renderListPage } from './pages/list.js';
import { renderDetailPage } from './pages/detail.js';

// ── 전역 상태 ──────────────────────────────
export const state = {
  currentPage: 'record',
  detailId: null,
  processing: false,
  currentTranscript: '',
  currentSummary: '',
  reviewState: {
    step: 'idle', // idle, reviewing, done
    issues: [],
    index: 0,
    transcript: '',
  },
};

// ── API 키 관리 ────────────────────────────
export function getApiKey() {
  return document.getElementById('groq-key').value.trim();
}

// ── 페이지 라우팅 ──────────────────────────
export function navigate(page, params = {}) {
  state.currentPage = page;
  if (params.detailId !== undefined) {
    state.detailId = params.detailId;
  }

  // 네비게이션 버튼 활성화 상태 업데이트
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // URL 해시 업데이트 (히스토리 관리)
  if (page === 'detail' && state.detailId) {
    history.pushState(null, '', `#detail/${encodeURIComponent(state.detailId)}`);
  } else {
    history.pushState(null, '', `#${page}`);
  }

  renderCurrentPage();
}

function renderCurrentPage() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  switch (state.currentPage) {
    case 'record':
      renderRecordPage(app);
      break;
    case 'list':
      renderListPage(app);
      break;
    case 'detail':
      renderDetailPage(app);
      break;
    default:
      renderRecordPage(app);
  }
}

// ── 해시 기반 라우팅 ────────────────────────
function handleHashChange() {
  const hash = location.hash.slice(1); // # 제거
  if (hash.startsWith('detail/')) {
    const id = decodeURIComponent(hash.slice(7));
    state.currentPage = 'detail';
    state.detailId = id;
  } else if (hash === 'list') {
    state.currentPage = 'list';
  } else {
    state.currentPage = 'record';
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === state.currentPage);
  });

  renderCurrentPage();
}

// ── 초기화 ──────────────────────────────────
async function init() {
  // IndexedDB 초기화
  await initDB();

  // API 키 로드
  const savedKey = localStorage.getItem('groq_api_key') || '';
  const keyInput = document.getElementById('groq-key');
  keyInput.value = savedKey;
  keyInput.addEventListener('input', () => {
    localStorage.setItem('groq_api_key', keyInput.value.trim());
  });

  // 네비게이션 버튼 이벤트
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // 리뷰 상태 초기화
      state.reviewState = { step: 'idle', issues: [], index: 0, transcript: '' };
      navigate(btn.dataset.page);
    });
  });

  // 모바일 메뉴 토글
  const menuToggle = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');
  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // 사이드바 외부 클릭 시 닫기 (모바일)
  document.getElementById('app').addEventListener('click', () => {
    sidebar.classList.remove('open');
  });

  // 매뉴얼 모달
  const manualModal = document.getElementById('manual-modal');
  document.getElementById('btn-manual').addEventListener('click', () => {
    manualModal.classList.add('open');
  });
  document.getElementById('modal-close').addEventListener('click', () => {
    manualModal.classList.remove('open');
  });
  manualModal.addEventListener('click', (e) => {
    if (e.target === manualModal) manualModal.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') manualModal.classList.remove('open');
  });

  // 해시 라우팅
  window.addEventListener('hashchange', handleHashChange);

  // 초기 페이지 렌더링
  handleHashChange();
}

// 앱 시작
init().catch(err => {
  console.error('앱 초기화 실패:', err);
  document.getElementById('app').innerHTML =
    `<div class="alert alert-error">앱 초기화에 실패했습니다: ${err.message}</div>`;
});
