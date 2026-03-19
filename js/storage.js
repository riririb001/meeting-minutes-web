/**
 * storage.js - IndexedDB 래퍼
 * Object Stores:
 *   - meetings: 회의록 JSON 데이터 (keyPath: id)
 *   - audioSegments: 녹음 세그먼트 (crash recovery용)
 */

const DB_NAME = 'MeetingMinutesDB';
const DB_VERSION = 3;

let db = null;

export async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('meetings')) {
        const store = d.createObjectStore('meetings', { keyPath: 'id' });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
      if (!d.objectStoreNames.contains('audioSegments')) {
        const segStore = d.createObjectStore('audioSegments', { keyPath: 'id', autoIncrement: true });
        segStore.createIndex('recordingId', 'recordingId', { unique: false });
      }
      // 녹음 원본 보관 (회의록 ID로 연결)
      if (!d.objectStoreNames.contains('recordings')) {
        const recStore = d.createObjectStore('recordings', { keyPath: 'meetingId' });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function getDB() {
  if (!db) throw new Error('DB가 초기화되지 않았습니다. initDB()를 먼저 호출하세요.');
  return db;
}

// ── 회의록 CRUD ──

export async function saveMeeting(meeting) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('meetings', 'readwrite');
    tx.objectStore('meetings').put(meeting);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function loadMeetings() {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('meetings', 'readonly');
    const req = tx.objectStore('meetings').getAll();
    req.onsuccess = () => {
      const meetings = req.result || [];
      meetings.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      resolve(meetings);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function loadMeeting(id) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('meetings', 'readonly');
    const req = tx.objectStore('meetings').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function updateMeeting(id, updates) {
  const meeting = await loadMeeting(id);
  if (!meeting) throw new Error('회의록을 찾을 수 없습니다: ' + id);
  Object.assign(meeting, updates);
  return saveMeeting(meeting);
}

export async function deleteMeeting(id) {
  // 회의록 + 녹음 원본 함께 삭제
  return new Promise((resolve, reject) => {
    const storeNames = ['meetings'];
    if (getDB().objectStoreNames.contains('recordings')) {
      storeNames.push('recordings');
    }
    const tx = getDB().transaction(storeNames, 'readwrite');
    tx.objectStore('meetings').delete(id);
    if (storeNames.includes('recordings')) {
      tx.objectStore('recordings').delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ── 녹음 원본 보관 ──

/** 녹음 원본을 회의록 ID와 연결하여 저장 */
export async function saveRecording(meetingId, segments, mimeType, totalDuration) {
  // 세그먼트를 하나의 Blob으로 합치기
  const combinedBlob = new Blob(segments, { type: mimeType || 'audio/webm' });
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('recordings', 'readwrite');
    tx.objectStore('recordings').put({
      meetingId,
      blob: combinedBlob,
      mimeType: mimeType || 'audio/webm',
      size: combinedBlob.size,
      duration: totalDuration,
      savedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/** 녹음 원본 조회 */
export async function loadRecording(meetingId) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('recordings', 'readonly');
    const req = tx.objectStore('recordings').get(meetingId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

/** 녹음 원본 삭제 */
export async function deleteRecording(meetingId) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('recordings', 'readwrite');
    tx.objectStore('recordings').delete(meetingId);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/** 녹음이 있는 회의록 목록 (재처리용) */
export async function loadMeetingsWithRecordings() {
  const meetings = await loadMeetings();
  const recordingIds = await new Promise((resolve, reject) => {
    const tx = getDB().transaction('recordings', 'readonly');
    const req = tx.objectStore('recordings').getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result || []));
    req.onerror = (e) => reject(e.target.error);
  });
  return meetings
    .filter(m => recordingIds.has(m.id))
    .map(m => {
      return { ...m, hasRecording: true };
    });
}

// ── 오디오 세그먼트 (crash recovery) ──

export async function saveAudioSegment(recordingId, segmentIndex, blob, mimeType) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('audioSegments', 'readwrite');
    tx.objectStore('audioSegments').add({
      recordingId,
      segmentIndex,
      blob,
      mimeType,
      timestamp: Date.now(),
      completed: false,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function markRecordingComplete(recordingId) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('audioSegments', 'readwrite');
    const store = tx.objectStore('audioSegments');
    const idx = store.index('recordingId');
    const req = idx.openCursor(IDBKeyRange.only(recordingId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const record = cursor.value;
        record.completed = true;
        cursor.update(record);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getSegmentsByRecordingId(recordingId) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('audioSegments', 'readonly');
    const idx = tx.objectStore('audioSegments').index('recordingId');
    const req = idx.getAll(IDBKeyRange.only(recordingId));
    req.onsuccess = () => {
      const segs = req.result || [];
      segs.sort((a, b) => a.segmentIndex - b.segmentIndex);
      resolve(segs);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteAudioSegments(recordingId) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('audioSegments', 'readwrite');
    const store = tx.objectStore('audioSegments');
    const idx = store.index('recordingId');
    const req = idx.openCursor(IDBKeyRange.only(recordingId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/** 비정상 종료로 남은 세그먼트 찾기 (completed=false, 10분 이상 경과) */
export async function getOrphanedRecordingIds() {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction('audioSegments', 'readonly');
    const req = tx.objectStore('audioSegments').getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      const cutoff = Date.now() - 10 * 60 * 1000; // 10분 전
      const orphanIds = new Set();
      for (const seg of all) {
        if (!seg.completed && seg.timestamp < cutoff) {
          orphanIds.add(seg.recordingId);
        }
      }
      resolve([...orphanIds]);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}
