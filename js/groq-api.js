/**
 * Groq API 호출 모듈
 * - STT (Whisper)
 * - 회의록 요약 (Llama)
 * - 텍스트 교정 (Llama)
 */

import { getSummaryPrompt, getReviewPrompt } from './prompts.js';
import { getTodayKorean } from './utils.js';
import { getTemplateById } from './templates.js';

const WHISPER_MODEL = 'whisper-large-v3-turbo';
const LLM_MODEL = 'llama-3.3-70b-versatile';
const MAX_FILE_SIZE = 24 * 1024 * 1024; // 24MB

const BASE_URL = 'https://api.groq.com/openai/v1';

/** 공통 fetch 래퍼 (에러 처리 포함) */
async function apiFetch(endpoint, options) {
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, options);

  if (!response.ok) {
    let errorMsg = `API 오류 (${response.status})`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.error?.message || errorMsg;
    } catch (_) {
      // JSON 파싱 실패 시 기본 메시지 사용
    }
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * 오디오 Blob을 텍스트로 변환 (Groq Whisper API)
 * @param {Blob} audioBlob - 오디오 파일
 * @param {string} apiKey - Groq API 키
 * @param {function} onProgress - 진행 콜백 (선택)
 * @returns {string} 변환된 텍스트
 */
export async function transcribeAudio(audioBlob, apiKey, onProgress) {
  const chunks = splitAudioBlob(audioBlob);
  const allText = [];

  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) {
      onProgress(i + 1, chunks.length);
    }

    const ext = getFileExtension(audioBlob.type);
    const formData = new FormData();
    formData.append('file', chunks[i], `audio_chunk_${i}.${ext}`);
    formData.append('model', WHISPER_MODEL);
    formData.append('language', 'ko');
    formData.append('prompt', '회의록 녹음입니다.');
    formData.append('temperature', '0');

    const result = await apiFetch('/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
    });

    allText.push(result.text);
  }

  return allText.join(' ');
}

/**
 * 회의록 요약 생성 (Groq Chat API)
 * @param {string} transcript - 원본 텍스트
 * @param {string} apiKey - Groq API 키
 * @param {string} [templateId] - 템플릿 ID (선택)
 * @returns {string} 마크다운 요약
 */
export async function summarizeMeeting(transcript, apiKey, templateId = null) {
  const today = getTodayKorean();
  const template = templateId ? getTemplateById(templateId) : null;
  const prompt = getSummaryPrompt(today, transcript, template);

  const result = await apiFetch('/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  return result.choices[0].message.content;
}

/**
 * STT 텍스트 교정 검토 (Groq Chat API)
 * @param {string} transcript - 원본 텍스트
 * @param {string} apiKey - Groq API 키
 * @returns {Array<{original: string, suggestion: string, reason: string}>}
 */
export async function reviewTranscript(transcript, apiKey) {
  const prompt = getReviewPrompt(transcript);

  const result = await apiFetch('/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  let raw = result.choices[0].message.content.trim();

  // ```json ... ``` 감싸기 처리
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  }

  try {
    const issues = JSON.parse(raw);
    return Array.isArray(issues) ? issues : [];
  } catch (_) {
    return [];
  }
}

/** 큰 오디오 Blob을 MAX_FILE_SIZE 이하로 분할 */
function splitAudioBlob(blob) {
  if (blob.size <= MAX_FILE_SIZE) {
    return [blob];
  }

  const chunks = [];
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + MAX_FILE_SIZE, blob.size);
    chunks.push(blob.slice(offset, end, blob.type));
    offset = end;
  }
  return chunks;
}

/** MIME 타입에서 파일 확장자 추출 */
function getFileExtension(mimeType) {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}
