/**
 * MediaRecorder 기반 오디오 녹음 모듈
 * - 20MB 세그먼트 자동 분할 (Groq Whisper API 25MB 제한 대응)
 */

const SEGMENT_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB per segment

export class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.segments = [];
    this.isRecording = false;
    this.startTime = 0;
    this.mimeType = '';
    this.segmentSize = 0;
    this._rotating = false;
  }

  /** 지원되는 MIME 타입 감지 */
  _detectMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  /** 녹음 시작 */
  async start() {
    this.mimeType = this._detectMimeType();
    if (!this.mimeType) {
      throw new Error('이 브라우저에서는 오디오 녹음을 지원하지 않습니다.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.segments = [];
    this.segmentSize = 0;
    this._rotating = false;
    this._startNewRecorder();
    this.isRecording = true;
    this.startTime = Date.now();
  }

  /** 새 MediaRecorder 인스턴스 시작 */
  _startNewRecorder() {
    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    this.chunks = [];
    this.segmentSize = 0;

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
        this.segmentSize += e.data.size;

        // 세그먼트 크기 초과 시 자동 교체
        if (this.segmentSize >= SEGMENT_SIZE_LIMIT && !this._rotating) {
          this._rotateSegment();
        }
      }
    };

    this.mediaRecorder.start(1000); // 1초마다 데이터 수집
  }

  /** 현재 세그먼트를 저장하고 새 세그먼트 시작 */
  _rotateSegment() {
    this._rotating = true;
    const currentChunks = this.chunks;

    this.mediaRecorder.onstop = () => {
      const segmentBlob = new Blob(currentChunks, { type: this.mimeType });
      this.segments.push(segmentBlob);
      this._startNewRecorder();
      this._rotating = false;
    };

    this.mediaRecorder.stop();
  }

  /** 녹음 중지 → { blob, segments, mimeType, duration } 반환 */
  stop() {
    return new Promise((resolve) => {
      // 세그먼트 교체 중이면 완료 대기
      if (this._rotating) {
        const wait = setInterval(() => {
          if (!this._rotating) {
            clearInterval(wait);
            this._finalStop(resolve);
          }
        }, 50);
        return;
      }

      this._finalStop(resolve);
    });
  }

  _finalStop(resolve) {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
      resolve(null);
      return;
    }

    this.mediaRecorder.onstop = () => {
      // 마지막 세그먼트 추가
      if (this.chunks.length > 0) {
        const segmentBlob = new Blob(this.chunks, { type: this.mimeType });
        this.segments.push(segmentBlob);
      }

      const segments = [...this.segments];
      const blob = new Blob(segments, { type: this.mimeType });
      const duration = (Date.now() - this.startTime) / 1000;

      // 스트림 해제
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
      }
      this.isRecording = false;
      this.mediaRecorder = null;
      this.chunks = [];
      this.segments = [];

      resolve({ blob, segments, mimeType: this.mimeType, duration });
    };

    this.mediaRecorder.stop();
  }

  /** 현재 녹음 상태 */
  getStatus() {
    if (!this.isRecording) {
      return { isRecording: false, elapsedSeconds: 0, bytesRecorded: 0 };
    }
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    const segmentBytes = this.segments.reduce((sum, s) => sum + s.size, 0);
    const currentBytes = this.chunks.reduce((sum, c) => sum + c.size, 0);
    return { isRecording: true, elapsedSeconds, bytesRecorded: segmentBytes + currentBytes };
  }
}
