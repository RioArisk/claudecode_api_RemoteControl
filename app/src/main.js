// ============================================================
//  Claude Remote — Android Client (Tauri 2.0)
//  Entry point — imports and initializes all modules
// ============================================================

import { initConfirm } from './modules/confirm.js';
import { initHub } from './modules/hub.js';
import { initRenderer } from './modules/renderer.js';
import { initInput } from './modules/input.js';
import { initImageUpload } from './modules/image-upload.js';
import { initPermissions } from './modules/permissions.js';
import { initInteractions } from './modules/interactions.js';
import { initSettings, initSettingsValues } from './modules/settings.js';
import { initSessions } from './modules/sessions.js';
import { initDirPicker } from './modules/dir-picker.js';
import { initModelPicker } from './modules/model-picker.js';
import { initKeyboard } from './modules/keyboard.js';
import { initWaiting } from './modules/waiting.js';

const INIT_STEPS = [
  ['confirm', initConfirm],
  ['renderer', initRenderer],
  ['waiting', initWaiting],
  ['hub', initHub],
  ['input', initInput],
  ['image-upload', initImageUpload],
  ['permissions', initPermissions],
  ['interactions', initInteractions],
  ['settings-values', initSettingsValues],
  ['settings', initSettings],
  ['sessions', initSessions],
  ['dir-picker', initDirPicker],
  ['model-picker', initModelPicker],
  ['keyboard', initKeyboard],
];

let bootstrapped = false;

function runInitSteps() {
  const failures = [];
  for (const [name, init] of INIT_STEPS) {
    try {
      init();
    } catch (err) {
      failures.push(name);
      console.error(`[bootstrap] init failed: ${name}`, err);
    }
  }
  if (failures.length) {
    console.error(`[bootstrap] completed with failures: ${failures.join(', ')}`);
  }
}

export function bootstrapApp() {
  if (bootstrapped) return;
  bootstrapped = true;
  runInitSteps();
}

function startWhenReady() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApp, { once: true });
    return;
  }
  bootstrapApp();
}

startWhenReady();
