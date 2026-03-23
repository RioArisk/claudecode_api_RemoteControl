'use strict';

const CHAT_SUBMIT_DELAY_MS = 150;
const SINGLE_SELECT_DELAY_MS = 300;
const OTHER_SELECT_DELAY_MS = 500;
const MULTI_SELECT_TOGGLE_DELAY_MS = 200;
const MULTI_SELECT_OTHER_OPEN_DELAY_MS = 400;
const MULTI_SELECT_OTHER_CHAR_DELAY_MS = 50;
const MULTI_SELECT_ADVANCE_DELAY_MS = 300;
const FINAL_CONFIRM_DELAY_MS = 300;
const FINAL_CONFIRM_STEP_DELAY_MS = 100;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeQuestion(question, index) {
  const normalized = question && typeof question === 'object' ? question : {};
  const options = Array.isArray(normalized.options) ? normalized.options : [];
  if (options.length === 0) {
    throw new Error(`Question ${index + 1} has no options`);
  }
  return {
    question: String(normalized.question || '').trim(),
    header: String(normalized.header || '').trim(),
    options,
    multiSelect: !!normalized.multiSelect,
  };
}

function normalizeResponse(response, question, index) {
  const raw = response && typeof response === 'object' ? response : {};
  const otherText = typeof raw.otherText === 'string' ? raw.otherText.trim() : '';
  const selectedOptions = Array.isArray(raw.selectedOptions)
    ? [...new Set(raw.selectedOptions
      .map(value => Number(value))
      .filter(value => Number.isInteger(value)))]
    : [];

  const optionCount = question.options.length;
  for (const value of selectedOptions) {
    if (value < 1 || value > optionCount) {
      throw new Error(`Question ${index + 1} has an invalid option selection`);
    }
  }

  if (!question.multiSelect && selectedOptions.length > 1) {
    throw new Error(`Question ${index + 1} only supports one selection`);
  }

  if (!question.multiSelect && otherText && selectedOptions.length > 0) {
    throw new Error(`Question ${index + 1} cannot combine custom text with option selections`);
  }

  if (!otherText && selectedOptions.length === 0) {
    throw new Error(`Question ${index + 1} requires an answer`);
  }

  return {
    selectedOptions: selectedOptions.sort((a, b) => a - b),
    otherText,
  };
}

function normalizeAskUserQuestionSubmission(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  const responses = Array.isArray(raw.responses) ? raw.responses : [];
  if (questions.length === 0) {
    throw new Error('Question data is missing');
  }
  if (questions.length !== responses.length) {
    throw new Error('Question response count mismatch');
  }

  const normalizedQuestions = questions.map(normalizeQuestion);
  const normalizedResponses = normalizedQuestions.map((question, index) =>
    normalizeResponse(responses[index], question, index));

  return {
    toolUseId: typeof raw.toolUseId === 'string' ? raw.toolUseId : '',
    questions: normalizedQuestions,
    responses: normalizedResponses,
  };
}

function buildAskUserQuestionSubmissionKey(payload, fallbackId = '') {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const toolUseId = typeof raw.toolUseId === 'string' ? raw.toolUseId.trim() : '';
  if (toolUseId) return `tool:${toolUseId}`;
  const fallback = String(fallbackId || '').trim();
  return `fallback:${fallback || 'anonymous'}`;
}

function claimAskUserQuestionSubmissionLock(activeLocks, payload, fallbackId = '') {
  if (!activeLocks || typeof activeLocks.has !== 'function' || typeof activeLocks.add !== 'function') {
    throw new Error('Question submission lock storage unavailable');
  }
  const key = buildAskUserQuestionSubmissionKey(payload, fallbackId);
  if (activeLocks.has(key)) return '';
  activeLocks.add(key);
  return key;
}

function releaseAskUserQuestionSubmissionLock(activeLocks, key) {
  if (!activeLocks || typeof activeLocks.delete !== 'function' || !key) return;
  activeLocks.delete(key);
}

function buildAskUserQuestionPtyOperations(payload) {
  const normalized = normalizeAskUserQuestionSubmission(payload);
  const operations = [];

  normalized.questions.forEach((question, index) => {
    const response = normalized.responses[index];
    const otherOptionIndex = String(question.options.length + 1);

    if (question.multiSelect) {
      if (response.otherText) {
        operations.push({ type: 'input', data: otherOptionIndex });
        operations.push({ type: 'delay', ms: MULTI_SELECT_OTHER_OPEN_DELAY_MS });
        for (const ch of response.otherText) {
          operations.push({ type: 'input', data: ch });
          operations.push({ type: 'delay', ms: MULTI_SELECT_OTHER_CHAR_DELAY_MS });
        }
        operations.push({ type: 'delay', ms: MULTI_SELECT_OTHER_OPEN_DELAY_MS });
      }
      for (const value of response.selectedOptions) {
        operations.push({ type: 'input', data: String(value) });
        operations.push({ type: 'delay', ms: MULTI_SELECT_TOGGLE_DELAY_MS });
      }
      operations.push({ type: 'input', data: '\x1b[C' });
      operations.push({ type: 'delay', ms: MULTI_SELECT_ADVANCE_DELAY_MS });
      return;
    }

    if (response.otherText) {
      operations.push({ type: 'input', data: otherOptionIndex });
      operations.push({ type: 'delay', ms: OTHER_SELECT_DELAY_MS });
      operations.push({ type: 'text', data: response.otherText });
      operations.push({ type: 'delay', ms: OTHER_SELECT_DELAY_MS });
      return;
    }

    operations.push({ type: 'input', data: String(response.selectedOptions[0]) });
    operations.push({ type: 'delay', ms: SINGLE_SELECT_DELAY_MS });
  });

  operations.push({ type: 'delay', ms: FINAL_CONFIRM_DELAY_MS });
  operations.push({ type: 'input', data: '\x1b[C' });
  operations.push({ type: 'delay', ms: FINAL_CONFIRM_STEP_DELAY_MS });
  operations.push({ type: 'input', data: '\r' });

  return operations;
}

async function executePtyOperations(proc, operations) {
  if (!proc) throw new Error('Claude is not running');
  for (const operation of operations) {
    if (!proc) throw new Error('Claude is not running');
    if (operation.type === 'delay') {
      await sleep(operation.ms);
      continue;
    }
    if (operation.type === 'input') {
      proc.write(operation.data);
      continue;
    }
    if (operation.type === 'text') {
      proc.write(operation.data);
      await sleep(CHAT_SUBMIT_DELAY_MS);
      proc.write('\r');
    }
  }
}

module.exports = {
  normalizeAskUserQuestionSubmission,
  claimAskUserQuestionSubmissionLock,
  releaseAskUserQuestionSubmissionLock,
  buildAskUserQuestionPtyOperations,
  executePtyOperations,
};
