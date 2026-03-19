/**
 * audio-processor.js - Web Audio API 기반 오디오 전처리
 *
 * app.py의 전처리를 웹 환경에 맞게 구현:
 * - 80Hz 하이패스 필터 (scipy butter(4, 80, 'highpass') 대체)
 * - 피크 정규화 0.95 (numpy peak normalization 대체)
 * - noisereduce 대체: 브라우저 getUserMedia noiseSuppression + DynamicsCompressor
 * - 출력: WAV Blob (Groq API 호환)
 */

/**
 * 오디오 Blob을 전처리하여 WAV Blob으로 반환
 * @param {Blob} audioBlob - 입력 오디오 (webm, mp4, wav 등)
 * @returns {Promise<Blob>} 전처리된 WAV Blob
 */
export async function preprocessAudio(audioBlob) {
  // 1. Blob → ArrayBuffer → AudioBuffer
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: 16000 });

  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (e) {
    // 디코딩 실패 시 원본 반환 (WAV 변환만)
    audioCtx.close();
    throw new Error('오디오 디코딩 실패: ' + e.message);
  }

  // 2. 모노 변환 (첫 번째 채널 사용)
  const inputData = audioBuffer.getChannelData(0);
  const sampleRate = 16000;

  // 3. OfflineAudioContext로 필터링
  const offlineCtx = new OfflineAudioContext(1, inputData.length, sampleRate);

  // 소스 버퍼 생성
  const srcBuffer = offlineCtx.createBuffer(1, inputData.length, sampleRate);
  srcBuffer.getChannelData(0).set(inputData);
  const source = offlineCtx.createBufferSource();
  source.buffer = srcBuffer;

  // 하이패스 필터: 80Hz (app.py의 butter(4, 80, 'highpass') 대응)
  const highpass = offlineCtx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 80;
  highpass.Q.value = 0.707; // Butterworth 근사

  // 다이나믹 컴프레서 (노이즈 리덕션 보완)
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -30;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  // 연결: source → highpass → compressor → destination
  source.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  audioCtx.close();

  // 4. 피크 정규화 (target: 0.95)
  const processedData = renderedBuffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < processedData.length; i++) {
    const abs = Math.abs(processedData[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0) {
    const gain = 0.95 / peak;
    for (let i = 0; i < processedData.length; i++) {
      processedData[i] *= gain;
    }
  }

  // 5. WAV 변환
  return audioBufferToWav(processedData, sampleRate);
}

/**
 * Float32 PCM 데이터를 WAV Blob으로 변환
 */
function audioBufferToWav(samples, sampleRate) {
  const numSamples = samples.length;
  const bytesPerSample = 2; // int16
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF 헤더
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt 청크
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // 청크 크기
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // 모노
  view.setUint32(24, sampleRate, true);  // 샘플레이트
  view.setUint32(28, sampleRate * bytesPerSample, true); // 바이트레이트
  view.setUint16(32, bytesPerSample, true);              // 블록 정렬
  view.setUint16(34, 16, true);          // 비트 깊이

  // data 청크
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Float32 → Int16 변환
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * 오디오 파일(업로드)을 세그먼트로 분할
 * @param {Blob} audioBlob - 업로드된 오디오 파일
 * @param {number} maxDurationSec - 세그먼트 최대 길이(초), 기본 300(5분)
 * @returns {Promise<Blob[]>} WAV 세그먼트 배열
 */
export async function splitAudioFile(audioBlob, maxDurationSec = 300) {
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }

  const sampleRate = 16000;
  const inputData = audioBuffer.getChannelData(0);
  const samplesPerSegment = maxDurationSec * sampleRate;
  const segments = [];

  for (let start = 0; start < inputData.length; start += samplesPerSegment) {
    const end = Math.min(start + samplesPerSegment, inputData.length);
    const segData = inputData.slice(start, end);

    // 피크 정규화
    let peak = 0;
    for (let i = 0; i < segData.length; i++) {
      const abs = Math.abs(segData[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0) {
      const gain = 0.95 / peak;
      for (let i = 0; i < segData.length; i++) {
        segData[i] *= gain;
      }
    }

    segments.push(audioBufferToWav(segData, sampleRate));
  }

  return segments;
}
