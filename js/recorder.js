/**
 * recorder.js - MediaRecorder 기반 오디오 녹음
 *
 * 60분+ 안전 녹음 전략:
 * - 5분마다 세그먼트 분할 → IndexedDB에 즉시 저장 (crash safety)
 * - 세그먼트당 ~2-3MB (WebM/Opus) → Groq 25MB 제한 이내
 * - 메모리: 현재 세그먼트 청크만 RAM에 보유 (상수 메모리)
 * - Wake Lock API로 화면 절전 방지
 */

import { saveAudioSegment, markRecordingComplete } from './storage.js';

export class AudioRecorder {
  constructor() {
    // 설정
    this.SEGMENT_DURATION = 5 * 60 * 1000; // 5분 (ms)
    this.MAX_SEGMENT_BYTES = 20 * 1024 * 1024; // 20MB 안전 한계

    // 상태
    this.mediaRecorder = null;
    this.stream = null;
    this.isRecording = false;
    this.mimeType = '';
    this.recordingId = '';

    // 세그먼트 관리
    this.segments = [];           // 완성된 세그먼트 Blob 배열
    this.currentChunks = [];      // 현재 세그먼트에 쌓이는 데이터 청크
    this.currentSegmentSize = 0;
    this.segmentIndex = 0;
    this.segmentStartTime = 0;
    this._finalizing = false;     // race condition 방지

    // 타이머
    this.startTime = 0;
    this.elapsedTimer = null;
    this.onElapsedUpdate = null;  // 콜백: (seconds) => void

    // Wake Lock
    this.wakeLock = null;
  }

  /** 지원되는 MIME 타입 감지 */
  _detectMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
  }

  /** 녹음 시작 */
  async start() {
    if (this.isRecording) return;

    // 마이크 요청
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.mimeType = this._detectMimeType();
    this.recordingId = `rec_${Date.now()}`;
    this.segments = [];
    this.currentChunks = [];
    this.currentSegmentSize = 0;
    this.segmentIndex = 0;
    this.startTime = Date.now();
    this.segmentStartTime = Date.now();
    this.isRecording = true;

    // MediaRecorder — 1초마다 데이터 수신
    const options = this.mimeType ? { mimeType: this.mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, options);

    this.mediaRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        this.currentChunks.push(e.data);
        this.currentSegmentSize += e.data.size;

        // 세그먼트 분할 조건: 크기 초과 또는 시간 초과
        const elapsed = Date.now() - this.segmentStartTime;
        if (this.currentSegmentSize >= this.MAX_SEGMENT_BYTES || elapsed >= this.SEGMENT_DURATION) {
          await this._finalizeSegment();
        }
      }
    };

    this.mediaRecorder.start(1000); // 1초 timeslice

    // 탭 닫기 경고
    window.addEventListener('beforeunload', this._onBeforeUnload);

    // 경과 시간 타이머
    this.elapsedTimer = setInterval(() => {
      if (this.onElapsedUpdate) {
        const secs = Math.floor((Date.now() - this.startTime) / 1000);
        this.onElapsedUpdate(secs);
      }
    }, 1000);

    // Wake Lock
    await this._acquireWakeLock();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /** 현재 청크들을 세그먼트로 확정하고 IndexedDB에 저장 */
  async _finalizeSegment() {
    if (this.currentChunks.length === 0 || this._finalizing) return;
    this._finalizing = true;

    const blob = new Blob(this.currentChunks, { type: this.mimeType || 'audio/webm' });
    this.segments.push(blob);

    // crash recovery: IndexedDB에 즉시 저장
    try {
      await saveAudioSegment(this.recordingId, this.segmentIndex, blob, this.mimeType);
    } catch (e) {
      console.warn('세그먼트 IndexedDB 저장 실패:', e);
    }

    this.segmentIndex++;
    this.currentChunks = [];
    this.currentSegmentSize = 0;
    this.segmentStartTime = Date.now();
    this._finalizing = false;
  }

  /** 녹음 종료 */
  async stop() {
    if (!this.isRecording) return null;
    this.isRecording = false;

    // 타이머 정리
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }

    // MediaRecorder 정지 — 마지막 데이터 수신 대기
    await new Promise((resolve) => {
      this.mediaRecorder.onstop = resolve;
      this.mediaRecorder.stop();
    });

    // 남은 청크를 마지막 세그먼트로 확정
    await this._finalizeSegment();

    // 녹음 완료 표시
    try {
      await markRecordingComplete(this.recordingId);
    } catch (e) {
      console.warn('녹음 완료 표시 실패:', e);
    }

    // 스트림 정리
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    // Wake Lock 해제
    this._releaseWakeLock();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('beforeunload', this._onBeforeUnload);

    const totalDuration = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      recordingId: this.recordingId,
      segments: [...this.segments],
      mimeType: this.mimeType || 'audio/webm',
      totalDuration,
    };
  }

  /** Wake Lock 획득 */
  async _acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {
        console.warn('Wake Lock 획득 실패:', e);
      }
    }
  }

  /** Wake Lock 해제 */
  _releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  /** 탭 가시성 변경 시 Wake Lock 재획득 */
  _onVisibilityChange = async () => {
    if (document.visibilityState === 'visible' && this.isRecording) {
      await this._acquireWakeLock();
    }
  };

  /** 탭 닫기 시 경고 */
  _onBeforeUnload = (e) => {
    if (this.isRecording) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
}
