/**
 * groq-api.js - Groq API 클라이언트
 * - STT: Whisper API (음성 → 텍스트)
 * - 요약: Llama 3.3 70B (텍스트 → 회의록)
 * - 교정: Llama 3.3 70B (STT 오류 검출)
 */

import { buildPrompt, SUMMARY_PROMPT_TEMPLATE, SUMMARY_PROMPT_WITH_SPEAKERS, TRANSCRIPT_REVIEW_PROMPT } from './prompts.js';
import { todayString } from './utils.js';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

/** Rate limit 재시도 로직 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, options);

    if (resp.status === 429 && attempt < maxRetries) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '0', 10);
      const waitMs = Math.max(retryAfter * 1000, (attempt + 1) * 2000);
      console.warn(`Rate limit (429). ${waitMs / 1000}초 후 재시도... (${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (resp.status === 401) throw new Error('API 키가 유효하지 않습니다. 확인 후 다시 시도해주세요.');
      if (resp.status === 413) throw new Error('파일이 너무 큽니다. 세그먼트 분할이 필요합니다.');
      throw new Error(`API 오류 (${resp.status}): ${body.slice(0, 200)}`);
    }

    return resp;
  }
  throw new Error('API 요청 한도 초과. 잠시 후 다시 시도해주세요.');
}

/**
 * 단일 세그먼트 STT (plain text)
 */
export async function transcribeSegment(wavBlob, apiKey, model, keywords = '', prevText = '') {
  const prompt = buildPrompt(keywords, prevText);
  const formData = new FormData();
  formData.append('file', wavBlob, 'audio.wav');
  formData.append('model', model);
  formData.append('language', 'ko');
  formData.append('prompt', prompt);
  formData.append('temperature', '0.0');

  const resp = await fetchWithRetry(`${GROQ_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  const data = await resp.json();
  return data.text || '';
}

/**
 * 단일 세그먼트 STT (타임스탬프 포함)
 */
export async function transcribeSegmentWithTimestamps(wavBlob, apiKey, model, keywords = '', prevText = '') {
  const prompt = buildPrompt(keywords, prevText);
  const formData = new FormData();
  formData.append('file', wavBlob, 'audio.wav');
  formData.append('model', model);
  formData.append('language', 'ko');
  formData.append('prompt', prompt);
  formData.append('temperature', '0.0');
  formData.append('response_format', 'verbose_json');

  const resp = await fetchWithRetry(`${GROQ_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  const data = await resp.json();
  return data.segments || [];
}

/**
 * 다중 세그먼트 STT 오케스트레이션
 * @param {Blob[]} wavSegments - 전처리된 WAV Blob 배열
 * @param {string} apiKey
 * @param {string} model
 * @param {string} keywords
 * @param {Function} onProgress - (current, total, text) => void
 * @returns {Promise<string>} 전체 텍스트
 */
export async function transcribeAllSegments(wavSegments, apiKey, model, keywords = '', onProgress = null) {
  const allTexts = [];

  for (let i = 0; i < wavSegments.length; i++) {
    const prevText = allTexts.length > 0 ? allTexts[allTexts.length - 1].slice(-200) : '';
    let text = '';
    try {
      text = await transcribeSegment(wavSegments[i], apiKey, model, keywords, prevText);
    } catch (e) {
      // 개별 세그먼트 실패 시 건너뛰고 계속 진행
      console.warn(`세그먼트 ${i + 1} STT 실패:`, e);
      text = `[세그먼트 ${i + 1} 변환 실패]`;
    }
    allTexts.push(text);

    if (onProgress) {
      onProgress(i + 1, wavSegments.length, allTexts.join(' '));
    }
  }

  const result = allTexts.join(' ');
  if (!result.trim() || allTexts.every(t => t.startsWith('[세그먼트'))) {
    throw new Error('모든 세그먼트의 텍스트 변환에 실패했습니다.');
  }
  return result;
}

/**
 * 회의록 요약 생성
 */
export async function summarize(transcript, apiKey, useSpeakers = false) {
  const today = todayString();
  let prompt;

  if (useSpeakers) {
    const speakerSet = new Set(transcript.match(/\[화자 \d+\]/g) || []);
    const speakers = [...speakerSet].sort().join(', ') || '(자동 분류)';
    prompt = SUMMARY_PROMPT_WITH_SPEAKERS
      .replace('{today}', today)
      .replace('{speakers}', speakers)
      .replace('{transcript}', transcript);
  } else {
    prompt = SUMMARY_PROMPT_TEMPLATE
      .replace('{today}', today)
      .replace('{transcript}', transcript);
  }

  const resp = await fetchWithRetry(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await resp.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('요약 API 응답이 비어 있습니다.');
  }
  return data.choices[0].message.content;
}

/**
 * STT 텍스트 교정 검토
 * @returns {Array<{original: string, suggestion: string, reason: string}>}
 */
export async function reviewTranscript(transcript, apiKey) {
  const prompt = TRANSCRIPT_REVIEW_PROMPT.replace('{transcript}', transcript);

  const resp = await fetchWithRetry(`${GROQ_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await resp.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    return [];
  }
  let raw = (data.choices[0].message.content || '').trim();

  // ```json ... ``` 감싸기 대응
  if (raw.includes('```')) {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) raw = match[1].trim();
  }

  try {
    const issues = JSON.parse(raw);
    if (!Array.isArray(issues)) return [];
    return issues;
  } catch {
    return [];
  }
}
