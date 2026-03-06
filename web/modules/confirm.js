// ============================================================
//  Confirm Dialog
// ============================================================
import { $ } from './utils.js';

let confirmResolve = null;

export function showConfirm(text) {
  return new Promise(resolve => {
    $('confirm-text').textContent = text;
    $('confirm-overlay').classList.add('visible');
    confirmResolve = resolve;
  });
}

export function initConfirm() {
  $('confirm-ok').addEventListener('click', () => {
    $('confirm-overlay').classList.remove('visible');
    if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
  });
  $('confirm-cancel').addEventListener('click', () => {
    $('confirm-overlay').classList.remove('visible');
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  });
}
