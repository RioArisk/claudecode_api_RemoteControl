// ============================================================
//  Settings
// ============================================================
import { $ } from './utils.js';
import { S, approvalMode, setApprovalModeValue } from './state.js';
import { showConfirm } from './confirm.js';
import { updateSettingsCwd } from './dir-picker.js';

function updateSettingsActive() {
  document.querySelectorAll('.settings-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === approvalMode);
  });
}

function setApprovalMode(mode) {
  setApprovalModeValue(mode);
  localStorage.setItem('approvalMode', mode);
  updateSettingsActive();
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'set_approval_mode', mode }));
  }
}

export function initSettingsValues() {
  const radio = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
  if (radio) radio.checked = true;
  updateSettingsActive();
}

function openSettings() {
  initSettingsValues();
  updateSettingsCwd();
  $('settings-overlay').classList.add('visible');
}

function closeSettings() {
  $('settings-overlay').classList.remove('visible');
}

export { closeSettings };

export function initSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', e => {
    if (e.target === $('settings-overlay')) closeSettings();
  });

  document.querySelectorAll('input[name="approval-mode"]').forEach(radio => {
    radio.addEventListener('change', async (e) => {
      const mode = e.target.value;
      if (mode === 'all') {
        const ok = await showConfirm(
          '全部自动审批将允许所有命令（包括 Bash、系统命令）无需确认直接执行，这可能存在风险。确定要开启吗？'
        );
        if (!ok) {
          const prev = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
          if (prev) prev.checked = true;
          return;
        }
      } else if (mode === 'partial') {
        const ok = await showConfirm(
          '部分自动审批将自动放行 Read、Write、Edit、Glob、Grep 命令，无需手动确认。确定要开启吗？'
        );
        if (!ok) {
          const prev = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
          if (prev) prev.checked = true;
          return;
        }
      }
      setApprovalMode(mode);
    });
  });
}
