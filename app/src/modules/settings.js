// ============================================================
//  Settings
// ============================================================
import { $ } from './utils.js';
import { S, approvalMode, setApprovalModeValue, themeMode, setThemeModeValue } from './state.js';
import { showConfirm } from './confirm.js';
import { updateSettingsCwd } from './dir-picker.js';

function updateApprovalActive() {
  document.querySelectorAll('#approval-options .settings-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === approvalMode);
  });
}

function updateThemeActive() {
  document.querySelectorAll('#theme-options .settings-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.themeMode === themeMode);
  });
}

function setApprovalMode(mode) {
  setApprovalModeValue(mode);
  localStorage.setItem('approvalMode', mode);
  updateApprovalActive();
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'set_approval_mode', mode }));
  }
}

function applyTheme(mode) {
  setThemeModeValue(mode);
  localStorage.setItem('theme', mode);
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  updateThemeActive();
}

export function initSettingsValues() {
  const approvalRadio = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
  if (approvalRadio) approvalRadio.checked = true;
  updateApprovalActive();

  const themeRadio = document.querySelector(`input[name="theme-mode"][value="${themeMode}"]`);
  if (themeRadio) themeRadio.checked = true;
  updateThemeActive();
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

  document.querySelectorAll('input[name="theme-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      applyTheme(e.target.value);
    });
  });
}
