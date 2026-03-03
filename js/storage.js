/**
 * IndexedDB 스토리지 모듈
 * - meetings: 회의록 JSON 데이터
 * - recordings: 오디오 Blob 데이터
 */

const DB_NAME = 'meetingMinutesDB';
const DB_VERSION = 1;

let db = null;

export async function initDB() {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('meetings')) {
        const store = database.createObjectStore('meetings', { keyPath: 'id' });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
      if (!database.objectStoreNames.contains('recordings')) {
        database.createObjectStore('recordings', { keyPath: 'id' });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onerror = (e) => {
      reject(new Error('IndexedDB 열기 실패: ' + e.target.error));
    };
  });
}

function getStore(storeName, mode = 'readonly') {
  const tx = db.transaction(storeName, mode);
  return tx.objectStore(storeName);
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ── 회의록 CRUD ──────────────────────────────

export async function saveMeeting(data) {
  const store = getStore('meetings', 'readwrite');
  return promisifyRequest(store.put(data));
}

export async function loadMeetings() {
  const store = getStore('meetings', 'readonly');
  const all = await promisifyRequest(store.getAll());
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function loadMeeting(id) {
  const store = getStore('meetings', 'readonly');
  return promisifyRequest(store.get(id));
}

export async function updateMeeting(id, data) {
  const store = getStore('meetings', 'readwrite');
  return promisifyRequest(store.put({ ...data, id }));
}

export async function deleteMeeting(id) {
  const store = getStore('meetings', 'readwrite');
  await promisifyRequest(store.delete(id));
  // 연관 녹음 파일도 삭제
  try {
    await deleteRecording(id);
  } catch (_) {
    // 녹음 파일이 없을 수 있음
  }
}

// ── 녹음 CRUD ────────────────────────────────

export async function saveRecording(id, blob) {
  const store = getStore('recordings', 'readwrite');
  return promisifyRequest(store.put({ id, blob, createdAt: new Date().toISOString() }));
}

export async function loadRecording(id) {
  const store = getStore('recordings', 'readonly');
  const result = await promisifyRequest(store.get(id));
  return result ? result.blob : null;
}

export async function deleteRecording(id) {
  const store = getStore('recordings', 'readwrite');
  return promisifyRequest(store.delete(id));
}
