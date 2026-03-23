// ============================================================
//  Interactions — AskUserQuestion + ExitPlanMode
// ============================================================
import { PLAN_OPTIONS } from './constants.js';
import { $, esc } from './utils.js';
import { S } from './state.js';
import { renderMd, renderPlanCard, consumePendingPlanCard } from './renderer.js';
import { showToast } from './toast.js';

let pendingInteractions = new Map();
let pendingInteractionOrder = [];
let questionQueue = [];
let currentQuestionItem = null;
let currentQuestionIdx = 0;
let activePlanToolUseId = null;
let currentAnswers = [];
let currentOtherTexts = [];
let questionSubmitting = false;

export function resetInteractionState() {
  pendingInteractions.clear();
  pendingInteractionOrder = [];
  questionQueue = [];
  currentQuestionItem = null;
  currentQuestionIdx = 0;
  activePlanToolUseId = null;
  currentAnswers = [];
  currentOtherTexts = [];
  questionSubmitting = false;
  $('question-overlay').classList.remove('visible');
  $('plan-overlay').classList.remove('visible');
}

export function enqueuePendingInteraction(toolUseId, kind, payload) {
  if (!toolUseId) return;
  if (!pendingInteractions.has(toolUseId)) pendingInteractionOrder.push(toolUseId);
  pendingInteractions.set(toolUseId, { toolUseId, kind, payload });
}

export function dropPendingInteraction(toolUseId) {
  if (!toolUseId || !pendingInteractions.has(toolUseId)) return false;
  pendingInteractions.delete(toolUseId);
  pendingInteractionOrder = pendingInteractionOrder.filter(id => id !== toolUseId);
  return true;
}

function getNextPendingInteraction() {
  while (pendingInteractionOrder.length > 0) {
    const toolUseId = pendingInteractionOrder[0];
    const interaction = pendingInteractions.get(toolUseId);
    if (interaction) return interaction;
    pendingInteractionOrder.shift();
  }
  return null;
}

function hasActiveInteractionUi() {
  return !!currentQuestionItem || !!activePlanToolUseId ||
    $('question-overlay').classList.contains('visible') ||
    $('plan-overlay').classList.contains('visible');
}

export function presentNextPendingInteraction() {
  if (S.replaying || hasActiveInteractionUi()) return;
  const next = getNextPendingInteraction();
  if (!next) return;
  if (next.kind === 'question') {
    showQuestion(next.payload, { toolUseId: next.toolUseId });
  } else if (next.kind === 'plan') {
    showPlanApproval(next.payload, { toolUseId: next.toolUseId });
  }
}

export function registerInteractiveToolUse(block) {
  const toolName = block.name || '';
  if (toolName === 'AskUserQuestion' && block.input && block.input.questions) {
    if (block.id) {
      enqueuePendingInteraction(block.id, 'question', block.input.questions);
      presentNextPendingInteraction();
    } else if (!S.replaying) {
      showQuestion(block.input.questions);
    }
    return true;
  }
  if (toolName === 'ExitPlanMode') {
    if (S.replaying) {
      const plan = normalizePlanContent(block.input?.plan || '');
      if (plan) renderPlanCard(plan);
    }
    if (block.id) {
      enqueuePendingInteraction(block.id, 'plan', block.input || {});
      presentNextPendingInteraction();
    } else if (!S.replaying) {
      showPlanApproval(block.input);
    }
    return true;
  }
  return false;
}

export function resolveInteractiveToolResult(block) {
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  if (!toolUseId) return;
  const interaction = pendingInteractions.get(toolUseId);
  if (!interaction) return;
  dropPendingInteraction(toolUseId);
  if (interaction.kind === 'question') dismissQuestionInteraction(toolUseId);
  if (interaction.kind === 'plan') dismissPlanInteraction(toolUseId);
  presentNextPendingInteraction();
}

// ---- Question system ----
export function showQuestion(questions, { toolUseId = '' } = {}) {
  if (!Array.isArray(questions) || questions.length === 0) return;
  if (toolUseId) {
    if (currentQuestionItem?.toolUseId === toolUseId) return;
    if (questionQueue.some(item => item.toolUseId === toolUseId)) return;
  }
  questionQueue.push({ toolUseId, questions });
  if (!currentQuestionItem) showNextQuestion();
}

function showNextQuestion() {
  if (questionQueue.length === 0) {
    $('question-overlay').classList.remove('visible');
    currentQuestionItem = null;
    return;
  }
  currentQuestionItem = questionQueue[0];
  currentQuestionIdx = 0;
  currentAnswers = currentQuestionItem.questions.map(() => new Set());
  currentOtherTexts = currentQuestionItem.questions.map(() => '');
  questionSubmitting = false;
  renderCurrentQuestion();
}

function finishCurrentQuestionItem(nextDelayMs = 0) {
  const finishedToolUseId = currentQuestionItem?.toolUseId || '';
  if (questionQueue.length > 0) questionQueue.shift();
  currentQuestionItem = null;
  currentQuestionIdx = 0;
  currentAnswers = [];
  currentOtherTexts = [];
  questionSubmitting = false;
  if (finishedToolUseId) dropPendingInteraction(finishedToolUseId);
  if (questionQueue.length > 0) {
    setTimeout(showNextQuestion, nextDelayMs);
  } else {
    presentNextPendingInteraction();
  }
}

function dismissQuestionInteraction(toolUseId) {
  if (!toolUseId) return;
  const wasCurrent = currentQuestionItem?.toolUseId === toolUseId;
  questionQueue = questionQueue.filter(item => item.toolUseId !== toolUseId);
  if (wasCurrent) {
    currentQuestionItem = null;
    currentQuestionIdx = 0;
    currentAnswers = [];
    currentOtherTexts = [];
    questionSubmitting = false;
    $('question-overlay').classList.remove('visible');
    if (questionQueue.length > 0) {
      setTimeout(showNextQuestion, 0);
    } else {
      presentNextPendingInteraction();
    }
  }
}

function renderCurrentQuestion() {
  if (!currentQuestionItem) return;
  const questions = currentQuestionItem.questions;
  if (currentQuestionIdx >= questions.length) {
    submitAllAnswers();
    return;
  }

  const q = questions[currentQuestionIdx];
  const isMulti = !!q.multiSelect;
  const total = questions.length;
  const selected = currentAnswers[currentQuestionIdx] || new Set();
  const otherText = currentOtherTexts[currentQuestionIdx] || '';

  $('question-header-text').textContent = q.header || 'Question';
  $('question-text').textContent = q.question || '';

  const progressEl = $('question-progress');
  if (total > 1) {
    progressEl.textContent = `${currentQuestionIdx + 1} / ${total}`;
    progressEl.style.display = '';
  } else {
    progressEl.style.display = 'none';
  }

  const optionsEl = $('question-options');
  const options = q.options || [];
  optionsEl.innerHTML = options.map((opt, i) => {
    const idx = i + 1;
    const isSel = selected.has(idx);
    return `
      <button class="question-opt${isSel ? ' selected' : ''}${isMulti ? ' multi' : ''}" data-idx="${idx}"${questionSubmitting ? ' disabled' : ''}>
        ${isMulti
          ? `<span class="question-opt-check">${isSel ? '&#9745;' : '&#9744;'}</span>`
          : `<span class="question-opt-num${isSel ? ' active' : ''}">${idx}</span>`}
        <div class="question-opt-body">
          <div class="question-opt-label">${esc(opt.label)}</div>
          ${opt.description ? `<div class="question-opt-desc">${esc(opt.description)}</div>` : ''}
        </div>
      </button>`;
  }).join('');

  optionsEl.querySelectorAll('.question-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      if (questionSubmitting) return;
      const idx = parseInt(btn.dataset.idx, 10);
      isMulti ? toggleOption(idx) : selectOption(idx);
    });
  });

  $('question-other-input').value = otherText;
  $('question-other-input').disabled = questionSubmitting;

  const prevBtn = $('question-prev-btn');
  const nextBtn = $('question-next-btn');
  prevBtn.style.display = currentQuestionIdx > 0 ? '' : 'none';
  prevBtn.disabled = questionSubmitting;

  const isLast = currentQuestionIdx === total - 1;
  nextBtn.disabled = questionSubmitting;
  nextBtn.textContent = questionSubmitting
    ? 'Submitting...'
    : ((!isLast && total > 1) ? 'Next \u2192' : (total > 1 ? 'Submit All' : 'Submit'));

  $('question-overlay').classList.add('visible');
}

function selectOption(idx) {
  if (!currentQuestionItem) return;
  currentAnswers[currentQuestionIdx] = new Set([idx]);
  currentOtherTexts[currentQuestionIdx] = '';
  renderCurrentQuestion();
}

function toggleOption(idx) {
  const selected = currentAnswers[currentQuestionIdx];
  if (!selected) return;
  if (selected.has(idx)) selected.delete(idx);
  else selected.add(idx);
  renderCurrentQuestion();
}

function goToPrev() {
  if (!currentQuestionItem || currentQuestionIdx <= 0 || questionSubmitting) return;
  currentQuestionIdx--;
  renderCurrentQuestion();
}

function hasAnswerAt(index) {
  const selected = currentAnswers[index];
  if (selected && selected.size > 0) return true;
  return !!String(currentOtherTexts[index] || '').trim();
}

function buildQuestionResponses() {
  return currentQuestionItem.questions.map((_, index) => ({
    selectedOptions: [...(currentAnswers[index] || [])].sort((a, b) => a - b),
    otherText: String(currentOtherTexts[index] || '').trim(),
  }));
}

function focusQuestion(index) {
  currentQuestionIdx = index;
  renderCurrentQuestion();
}

function goToNext() {
  if (!currentQuestionItem || questionSubmitting) return;
  if (!hasAnswerAt(currentQuestionIdx)) {
    showToast('请先完成当前问题');
    return;
  }
  if (currentQuestionIdx >= currentQuestionItem.questions.length - 1) {
    submitAllAnswers();
  } else {
    currentQuestionIdx++;
    renderCurrentQuestion();
  }
}

function updateOtherText(value) {
  if (!currentQuestionItem) return;
  currentOtherTexts[currentQuestionIdx] = value;
  const question = currentQuestionItem.questions[currentQuestionIdx];
  if (!value.trim() || question?.multiSelect) return;
  const selected = currentAnswers[currentQuestionIdx];
  if (!selected || selected.size === 0) return;
  currentAnswers[currentQuestionIdx] = new Set();
  renderCurrentQuestion();
}

export function handleQuestionSubmissionError(toolUseId, error) {
  if (!currentQuestionItem) return;
  if (toolUseId && currentQuestionItem.toolUseId && currentQuestionItem.toolUseId !== toolUseId) return;
  questionSubmitting = false;
  renderCurrentQuestion();
  showToast(error || '提交问题答案失败');
}

function submitAllAnswers() {
  if (!currentQuestionItem || questionSubmitting) return;
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    showToast('Connection unavailable');
    return;
  }

  const firstIncompleteIdx = currentQuestionItem.questions.findIndex((_, index) => !hasAnswerAt(index));
  if (firstIncompleteIdx >= 0) {
    focusQuestion(firstIncompleteIdx);
    showToast('请先完成所有问题');
    return;
  }

  questionSubmitting = true;
  renderCurrentQuestion();
  S.ws.send(JSON.stringify({
    type: 'answer_questions',
    toolUseId: currentQuestionItem.toolUseId || '',
    questions: currentQuestionItem.questions,
    responses: buildQuestionResponses(),
  }));
}

// ---- Plan approval ----
export function normalizePlanContent(plan) {
  return String(plan || '').trim();
}

export function dismissPlanInteraction(toolUseId) {
  if (!toolUseId) return;
  if (activePlanToolUseId !== toolUseId) return;
  activePlanToolUseId = null;
  $('plan-overlay').classList.remove('visible');
  presentNextPendingInteraction();
}

export function showPlanApproval(input, { toolUseId = '' } = {}) {
  if (toolUseId && activePlanToolUseId === toolUseId && $('plan-overlay').classList.contains('visible')) return;
  activePlanToolUseId = toolUseId || activePlanToolUseId || null;
  const plan = normalizePlanContent(input?.plan || '');
  S.pendingPlanContent = plan;

  const contentEl = $('plan-content');
  if (plan) {
    contentEl.style.display = '';
    contentEl.innerHTML = renderMd(plan);
  } else {
    contentEl.style.display = 'none';
  }

  const optionsEl = $('plan-options');
  optionsEl.innerHTML = PLAN_OPTIONS.map(opt => `
    <button class="question-opt" data-num="${opt.num}">
      <span class="question-opt-num">${opt.num}</span>
      <div class="question-opt-body">
        <div class="question-opt-label">${esc(opt.label)}</div>
        <div class="question-opt-desc">${esc(opt.desc)}</div>
      </div>
    </button>
  `).join('');

  optionsEl.querySelectorAll('.question-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
      if (btn.dataset.num === '1') {
        S.ws.send(JSON.stringify({ type: 'expect_clear' }));
      } else {
        consumePendingPlanCard();
      }
      if (activePlanToolUseId) dropPendingInteraction(activePlanToolUseId);
      activePlanToolUseId = null;
      S.ws.send(JSON.stringify({ type: 'input', data: btn.dataset.num }));
      $('plan-overlay').classList.remove('visible');
      presentNextPendingInteraction();
    });
  });

  $('plan-other-input').value = '';
  $('plan-overlay').classList.add('visible');
}

function sendPlanOther() {
  const text = $('plan-other-input').value.trim();
  if (!text || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  consumePendingPlanCard();
  if (activePlanToolUseId) dropPendingInteraction(activePlanToolUseId);
  activePlanToolUseId = null;
  S.ws.send(JSON.stringify({ type: 'input', data: '4' }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'chat', text }));
    }
  }, 500);
  $('plan-overlay').classList.remove('visible');
  presentNextPendingInteraction();
}

export function initInteractions() {
  $('question-prev-btn').addEventListener('click', goToPrev);
  $('question-next-btn').addEventListener('click', goToNext);
  $('question-other-input').addEventListener('input', e => {
    if (questionSubmitting) return;
    updateOtherText(e.target.value || '');
  });
  $('question-other-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); goToNext(); }
  });
  $('plan-other-btn').addEventListener('click', sendPlanOther);
  $('plan-other-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendPlanOther(); }
  });
}
