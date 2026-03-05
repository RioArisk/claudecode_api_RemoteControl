// ============================================================
//  Model Picker
// ============================================================
import { MODELS } from './constants.js';
import { $ } from './utils.js';
import { S } from './state.js';
import { showToast } from './toast.js';
import { sendControlInput, sendSlashCmd, sendControlLine } from './input.js';

export function showModelPicker() {
  const list = $('model-list');
  list.innerHTML = MODELS.map(m =>
    `<div class="model-item" data-num="${m.num}">
      <span class="mi-num">${m.num}</span>
      <div class="mi-info">
        <span class="mi-name">${m.label}</span>
        <span class="mi-desc">${m.desc}</span>
      </div>
    </div>`
  ).join('');

  list.querySelectorAll('.model-item').forEach(el => {
    el.addEventListener('click', () => {
      const picked = MODELS.find(m => m.num === el.dataset.num);
      hideModelPicker();
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
      showToast('Switching to ' + (picked ? picked.label : 'model') + '...');
      sendControlInput('\x1b');
      setTimeout(() => {
        if (S.ws?.readyState === WebSocket.OPEN) sendSlashCmd('/model');
      }, 250);
      sendControlLine(el.dataset.num, { startDelayMs: 2400, submitDelayMs: 140 });
    });
  });

  $('model-picker').classList.add('visible');
}

export function hideModelPicker() {
  $('model-picker').classList.remove('visible');
}

export function initModelPicker() {
  $('model-picker').addEventListener('click', e => {
    if (e.target === $('model-picker')) hideModelPicker();
  });
}
