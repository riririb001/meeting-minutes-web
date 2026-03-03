/**
 * MediaRecorder 기반 오디오 녹음 모듈
 */

export class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.isRecording = false;
    this.startTime = 0;
    this.mimeType = '';
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

    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.mediaRecorder.start(1000); // 1초마다 데이터 수집
    this.isRecording = true;
    this.startTime = Date.now();
  }

  /** 녹음 중지 → Blob 반환 */
  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        const duration = (Date.now() - this.startTime) / 1000;

        // 스트림 해제
        if (this.stream) {
          this.stream.getTracks().forEach(t => t.stop());
          this.stream = null;
        }
        this.isRecording = false;
        this.mediaRecorder = null;
        this.chunks = [];

        resolve({ blob, mimeType: this.mimeType, duration });
      };

      this.mediaRecorder.stop();
    });
  }

  /** 현재 녹음 상태 */
  getStatus() {
    if (!this.isRecording) {
      return { isRecording: false, elapsedSeconds: 0, bytesRecorded: 0 };
    }
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    const bytesRecorded = this.chunks.reduce((sum, c) => sum + c.size, 0);
    return { isRecording: true, elapsedSeconds, bytesRecorded };
  }
}
