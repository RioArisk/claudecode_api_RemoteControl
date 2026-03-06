// ============================================================
//  Todo Panel
// ============================================================
import { TODO_AUTO_CLEAR_DELAY_MS } from './constants.js';
import { $, esc } from './utils.js';
import { S } from './state.js';
import { scrollEnd } from './waiting.js';
import { scheduleSessionCacheSave } from './renderer.js';

export const todoState = {
  tasks: new Map(),
  pendingCreates: new Map(),
  panelOpen: false,
  autoOpenedForBatch: false,
  clearTimer: null,
};

export function cancelTodoAutoClear() {
  if (!todoState.clearTimer) return;
  clearTimeout(todoState.clearTimer);
  todoState.clearTimer = null;
}

export function clearTodoBatch() {
  cancelTodoAutoClear();
  todoState.tasks.clear();
  todoState.pendingCreates.clear();
  todoState.panelOpen = false;
  todoState.autoOpenedForBatch = false;
  $('todo-panel').classList.remove('has-tasks', 'open');
  $('todo-list').innerHTML = '';
  $('todo-summary').textContent = '';
  $('todo-progress-bar').style.width = '0%';
  $('todo-progress-bar').classList.remove('all-done');
  $('todo-badge').textContent = '0';
  $('todo-badge').classList.remove('done');
  scheduleSessionCacheSave();
}

function syncTodoPanelLifecycle(tasks) {
  const hasTasks = tasks.length > 0;
  const hasPendingCreates = todoState.pendingCreates.size > 0;
  const hasOpenTasks = tasks.some(([, task]) => (task.status || 'pending') !== 'completed');

  if (!hasTasks) {
    cancelTodoAutoClear();
    todoState.autoOpenedForBatch = false;
    todoState.panelOpen = false;
    return;
  }

  if (!todoState.autoOpenedForBatch) {
    todoState.autoOpenedForBatch = true;
    todoState.panelOpen = true;
  }

  if (hasOpenTasks || hasPendingCreates) {
    cancelTodoAutoClear();
    return;
  }

  if (!todoState.clearTimer) {
    todoState.clearTimer = setTimeout(() => {
      todoState.clearTimer = null;
      const latestTasks = Array.from(todoState.tasks.values());
      const latestHasPendingCreates = todoState.pendingCreates.size > 0;
      const latestHasOpenTasks = latestTasks.some(task => (task.status || 'pending') !== 'completed');
      if (!latestHasPendingCreates && latestTasks.length > 0 && !latestHasOpenTasks) {
        clearTodoBatch();
      }
    }, TODO_AUTO_CLEAR_DELAY_MS);
  }
}

export function handleTodoToolUse(b) {
  const { name, id, input } = b;
  if (name === 'TaskCreate') {
    const hasOpenTasks = Array.from(todoState.tasks.values()).some(t => t.status !== 'completed');
    if (todoState.tasks.size > 0 && !hasOpenTasks) {
      clearTodoBatch();
    }
    todoState.pendingCreates.set(id, input);
  } else if (name === 'TaskUpdate' && input.taskId) {
    const task = todoState.tasks.get(input.taskId);
    if (task) {
      if (input.status) task.status = input.status;
      if (input.subject) task.subject = input.subject;
      if (input.description) task.description = input.description;
      if (input.activeForm) task.activeForm = input.activeForm;
      renderTodoPanel();
    }
  }
}

export function handleTodoToolResult(b, evt) {
  const { tool_use_id, content } = b;
  const text = typeof content === 'string' ? content :
    Array.isArray(content) ? content.map(c => c.text || '').join('') : '';
  const toolUseResult = (evt && typeof evt.toolUseResult === 'object' && evt.toolUseResult) ? evt.toolUseResult : null;

  const createInput = todoState.pendingCreates.get(tool_use_id);
  if (createInput) {
    todoState.pendingCreates.delete(tool_use_id);
    const metaTaskId = toolUseResult?.task?.id;
    const m = text.match(/Task #(\d+) created/i);
    const taskId = metaTaskId ? String(metaTaskId) : (m ? m[1] : '');
    if (taskId) {
      const metaSubject = toolUseResult?.task?.subject;
      todoState.tasks.set(taskId, {
        subject: metaSubject || createInput.subject || '',
        description: createInput.description || '',
        status: 'pending',
        activeForm: createInput.activeForm || '',
        blockedBy: [],
        blocks: [],
      });
      renderTodoPanel();
    }
    return;
  }

  if (toolUseResult?.taskId) {
    const taskId = String(toolUseResult.taskId);
    let task = todoState.tasks.get(taskId);
    if (!task) {
      task = {
        subject: `Task #${taskId}`,
        description: '',
        status: 'pending',
        activeForm: '',
        blockedBy: [],
        blocks: [],
      };
      todoState.tasks.set(taskId, task);
    }
    if (toolUseResult.statusChange?.to) {
      task.status = toolUseResult.statusChange.to;
    }
    renderTodoPanel();
    return;
  }

  if (text.includes('Task #') && (text.includes('[pending]') || text.includes('[in_progress]') || text.includes('[completed]'))) {
    const lines = text.split('\n');
    for (const line of lines) {
      const tm = line.match(/#(\d+)\.\s*\[(\w+)]\s*(.*)/);
      if (tm) {
        const [, taskId, status, subject] = tm;
        const existing = todoState.tasks.get(taskId);
        if (existing) {
          existing.status = status;
          if (subject.trim()) existing.subject = subject.trim();
        } else {
          todoState.tasks.set(taskId, {
            subject: subject.trim(),
            description: '',
            status,
            activeForm: '',
            blockedBy: [],
            blocks: [],
          });
        }
      }
    }
    renderTodoPanel();
    return;
  }

  const um = text.match(/Updated task #(\d+)/i);
  if (um) {
    renderTodoPanel();
  }
}

export function isTodoTool(name) {
  return name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList' || name === 'TaskGet';
}

export function renderTodoPanel() {
  const panel = $('todo-panel');
  const list = $('todo-list');
  const tasks = Array.from(todoState.tasks.entries()).sort(([aId], [bId]) => {
    const aNum = Number.parseInt(aId, 10);
    const bNum = Number.parseInt(bId, 10);
    const aOk = Number.isFinite(aNum);
    const bOk = Number.isFinite(bNum);
    if (aOk && bOk) return aNum - bNum;
    if (aOk) return -1;
    if (bOk) return 1;
    return String(aId).localeCompare(String(bId), undefined, { numeric: true });
  });

  if (tasks.length === 0) {
    panel.classList.remove('has-tasks', 'open');
    list.innerHTML = '';
    $('todo-summary').textContent = '';
    $('todo-progress-bar').style.width = '0%';
    $('todo-progress-bar').classList.remove('all-done');
    $('todo-badge').textContent = '0';
    $('todo-badge').classList.remove('done');
    return;
  }

  syncTodoPanelLifecycle(tasks);
  panel.classList.add('has-tasks');
  panel.classList.toggle('open', todoState.panelOpen);

  const total = tasks.length;
  const completed = tasks.filter(([, t]) => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const badge = $('todo-badge');
  const remaining = total - completed;
  badge.textContent = remaining > 0 ? remaining : '\u2713';
  badge.classList.toggle('done', remaining === 0);

  const bar = $('todo-progress-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('all-done', pct === 100);

  $('todo-summary').textContent = `${completed}/${total}`;

  const STATUS_ICON = {
    pending: '\u25CB',
    in_progress: '\u25D4',
    completed: '\u2713',
  };
  const STATUS_LABEL = {
    pending: 'Pending',
    in_progress: 'Running',
    completed: 'Done',
  };

  list.innerHTML = tasks.map(([id, t]) => {
    const status = t.status || 'pending';
    const showActive = status === 'in_progress' && t.activeForm;
    return `<div class="todo-item ${status}">
      <div class="todo-icon">${STATUS_ICON[status] || '\u25CB'}</div>
      <div class="todo-body">
        <div class="todo-subject">${esc(t.subject || 'Task #' + id)}</div>
        ${showActive ? `<div class="todo-active-form">${esc(t.activeForm)}</div>` : ''}
      </div>
      <span class="todo-status-tag">${STATUS_LABEL[status] || status}</span>
    </div>`;
  }).join('');

  scrollEnd();
}

export function toggleTodoPanel() {
  const panel = $('todo-panel');
  todoState.panelOpen = !todoState.panelOpen;
  panel.classList.toggle('open', todoState.panelOpen);
  scheduleSessionCacheSave();
}

// Make toggleTodoPanel available globally for inline onclick in HTML
window.toggleTodoPanel = toggleTodoPanel;

export function resetTodoState() {
  cancelTodoAutoClear();
  todoState.tasks.clear();
  todoState.pendingCreates.clear();
  todoState.panelOpen = false;
  todoState.autoOpenedForBatch = false;
  $('todo-panel').classList.remove('has-tasks', 'open');
  $('todo-list').innerHTML = '';
  $('todo-summary').textContent = '';
  $('todo-progress-bar').style.width = '0%';
  $('todo-progress-bar').classList.remove('all-done');
  $('todo-badge').textContent = '0';
  $('todo-badge').classList.remove('done');
}

export function getTodoSnapshot() {
  return {
    tasks: Array.from(todoState.tasks.entries()),
    panelOpen: todoState.panelOpen,
  };
}

export function restoreTodoSnapshot(snapshot) {
  resetTodoState();
  if (!snapshot || !Array.isArray(snapshot.tasks) || snapshot.tasks.length === 0) return;
  snapshot.tasks.forEach(([taskId, task]) => {
    todoState.tasks.set(String(taskId), task);
  });
  todoState.panelOpen = !!snapshot.panelOpen;
  todoState.autoOpenedForBatch = todoState.tasks.size > 0;
  renderTodoPanel();
  $('todo-panel').classList.toggle('open', todoState.panelOpen && todoState.tasks.size > 0);
}
