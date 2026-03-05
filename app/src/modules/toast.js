// ============================================================
//  Toast Messages
// ============================================================
import { $ } from './utils.js';

function localizeToastText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;

  const directMap = new Map([
    ['Server not found', '未找到服务器记录'],
    ['Invalid server address', '服务器地址无效'],
    ['Clearing conversation...', '正在清空当前对话…'],
    ['Fetching token costs...', '正在获取 Token 费用信息…'],
    ['Loading help...', '正在加载帮助信息…'],
    ['Please select an image file', '请选择图片文件'],
    ['Image too large (max 4MB)', '图片过大\n最大支持 4MB'],
    ['Connection unavailable', '连接不可用\n请先确认已连接到服务器'],
    ['Image upload failed', '图片上传失败'],
    ['Image upload failed. Re-select the image and try again.', '图片上传失败\n请重新选择图片后再试'],
    ['Image submit failed', '图片发送失败'],
    ['Failed to change folder', '切换文件夹失败'],
    ['Connection lost', '连接已断开'],
    ['Handshake timed out - check client/server compatibility and try again', '连接握手超时\n请检查客户端与服务端版本是否兼容'],
    ['Linux image paste requires xclip or wl-copy on the server. Install one and try again.', '服务端缺少图片剪贴板工具\n请安装 xclip 或 wl-copy 后重试'],
    ['Upload not ready', '图片尚未上传完成\n请稍后再试'],
    ['Upload session not found', '上传会话不存在\n请重新选择图片'],
    ['Upload owner mismatch', '上传会话无效\n请重新选择图片'],
    ['Missing uploadId', '上传请求无效\n请重新选择图片'],
    ['Missing chunk payload', '图片分片数据缺失\n请重新上传'],
  ]);

  if (directMap.has(raw)) return directMap.get(raw);
  if (raw.startsWith('Linux image paste requires a graphical session.')) {
    return 'Linux 服务端缺少图形会话环境变量\n请在 pm2/systemd 中设置 DISPLAY 或 WAYLAND_DISPLAY 后重试';
  }
  if (raw.startsWith('Now using ')) {
    return `已切换模型\n${raw.slice('Now using '.length)}`;
  }
  if (raw.startsWith('Switching to ')) {
    return `正在切换模型\n${raw.slice('Switching to '.length).replace(/\.\.\.$/, '')}`;
  }
  if (raw.startsWith('Authentication failed')) {
    return '鉴权失败\n请检查 Token 是否正确';
  }
  if (raw.startsWith('Unexpected chunk index')) {
    return '图片分片顺序异常\n请重新上传';
  }
  if (raw.startsWith('Upload incomplete')) {
    return '图片上传不完整\n请重新上传';
  }
  if (raw.startsWith('Image upload failed:')) {
    return `图片上传失败\n${raw.slice('Image upload failed:'.length).trim()}`;
  }
  return raw;
}

export function showToast(text) {
  const message = localizeToastText(text);
  if (!message) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
