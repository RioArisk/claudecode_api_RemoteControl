// ============================================================
//  Interactions — AskUserQuestion + ExitPlanMode
// ============================================================
import { PLAN_OPTIONS } from './constants.js';
import { $, esc } from './utils.js';
import { S } from './state.js';
import { renderMd, renderPlanCard, consumePendingPlanCard } from './renderer.js';

let pendingInteractions = new Map();
let pendingInteractionOrder = [];
let questionQueue = [];
let currentQuestionItem = null;
let currentQuestionIdx = 0;
let activePlanToolUseId = null;

export function resetInteractionState() {
  pendingInteractions.clear();
  pendingInteractionOrder = [];
  questionQueue = [];
  currentQuestionItem = null;
  currentQuestionIdx = 0;
  activePlanToolUseId = null;
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
  renderCurrentQuestion();
}

function finishCurrentQuestionItem(nextDelayMs = 0) {
  const finishedToolUseId = currentQuestionItem?.toolUseId || '';
  if (questionQueue.length > 0) questionQueue.shift();
  currentQuestionItem = null;
  currentQuestionIdx = 0;
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
  if (currentQuestionIdx >= currentQuestionItem.questions.length) {
    finishCurrentQuestionItem();
    return;
  }
  const q = currentQuestionItem.questions[currentQuestionIdx];
  $('question-header-text').textContent = q.header || 'Question';
  $('question-text').textContent = q.question || '';

  const optionsEl = $('question-options');
  const options = q.options || [];
  optionsEl.innerHTML = options.map((opt, i) => `
    <button class="question-opt" data-idx="${i + 1}">
      <span class="question-opt-num">${i + 1}</span>
      <div class="question-opt-body">
        <div class="question-opt-label">${esc(opt.label)}</div>
        ${opt.description ? `<div class="question-opt-desc">${esc(opt.description)}</div>` : ''}
      </div>
    </button>
  `).join('');

  optionsEl.querySelectorAll('.question-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      sendQuestionAnswer(idx);
    });
  });

  $('question-other-input').value = '';
  $('question-overlay').classList.add('visible');
}

function sendQuestionAnswer(numKey) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: String(numKey) }));
  $('question-overlay').classList.remove('visible');
  currentQuestionIdx++;
  if (currentQuestionItem && currentQuestionIdx < currentQuestionItem.questions.length) {
    setTimeout(renderCurrentQuestion, 500);
  } else {
    finishCurrentQuestionItem(500);
  }
}

function sendQuestionOther() {
  const text = $('question-other-input').value.trim();
  if (!text || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  const options = currentQuestionItem?.questions?.[currentQuestionIdx]?.options || [];
  const otherNum = String(options.length + 1);
  S.ws.send(JSON.stringify({ type: 'input', data: otherNum }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'chat', text }));
    }
  }, 500);
  $('question-overlay').classList.remove('visible');
  currentQuestionIdx++;
  if (currentQuestionItem && currentQuestionIdx < currentQuestionItem.questions.length) {
    setTimeout(renderCurrentQuestion, 1000);
  } else {
    finishCurrentQuestionItem(1000);
  }
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
  $('question-other-btn').addEventListener('click', sendQuestionOther);
  $('question-other-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendQuestionOther(); }
  });
  $('plan-other-btn').addEventListener('click', sendPlanOther);
  $('plan-other-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendPlanOther(); }
  });
}
