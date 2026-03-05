// ============================================================
//  Image Upload
// ============================================================
import { MAX_IMAGE_BYTES, IMAGE_CHUNK_BYTES } from './constants.js';
import { $, makeUploadId } from './utils.js';
import { S, pendingImage, setPendingImage } from './state.js';
import { showToast } from './toast.js';
import { setWaiting } from './waiting.js';
import { updateSendBtn } from './input.js';

function imageProgressLabel(image) {
  if (!image) return '0%';
  if (image.status === 'uploaded') return 'Done';
  if (image.status === 'submitting') return 'Send';
  if (image.status === 'failed') return 'Retry';
  return `${Math.max(0, Math.min(100, Math.round((image.progress || 0) * 100)))}%`;
}

export function updateImagePreviewUi() {
  const preview = $('image-preview');
  const img = $('image-preview-img');
  const overlay = $('image-upload-overlay');
  const ring = $('image-upload-ring');
  const text = $('image-upload-text');
  const removeBtn = $('image-preview-remove');
  const currentImage = pendingImage;

  if (!currentImage) {
    preview.classList.add('hidden');
    img.src = '';
    overlay.classList.add('hidden');
    text.textContent = '0%';
    ring.style.strokeDashoffset = '97.4';
    removeBtn.disabled = false;
    return;
  }

  preview.classList.remove('hidden');
  img.src = currentImage.previewUrl || '';
  removeBtn.disabled = currentImage.status === 'submitting';

  const showOverlay = currentImage.status === 'uploading' || currentImage.status === 'uploaded' ||
    currentImage.status === 'submitting' || currentImage.status === 'failed';
  overlay.classList.toggle('hidden', !showOverlay);
  text.textContent = imageProgressLabel(currentImage);
  ring.style.strokeDashoffset = String(97.4 * (1 - Math.max(0, Math.min(1, currentImage.progress || 0))));
}

function clearUploadWaiter(uploadId, err = null) {
  const waiter = S.uploadWaiters.get(uploadId);
  if (!waiter) return;
  S.uploadWaiters.delete(uploadId);
  if (err) waiter.reject(err);
  else waiter.resolve();
}

function waitForUploadStatus(uploadId, expectedStatuses, matchFn) {
  return new Promise((resolve, reject) => {
    S.uploadWaiters.set(uploadId, {
      expectedStatuses: new Set(expectedStatuses),
      matchFn,
      resolve,
      reject,
    });
  });
}

export function handleUploadStatus(m) {
  const currentImage = pendingImage;
  if (currentImage && m.uploadId === currentImage.uploadId) {
    if (Number.isFinite(m.totalBytes) && m.totalBytes > 0) currentImage.totalBytes = m.totalBytes;
    if (Number.isFinite(m.receivedBytes)) currentImage.uploadedBytes = m.receivedBytes;
    const totalBytes = currentImage.totalBytes || 0;
    if (totalBytes > 0 && Number.isFinite(currentImage.uploadedBytes)) {
      currentImage.progress = Math.max(0, Math.min(1, currentImage.uploadedBytes / totalBytes));
    }
    if (m.status === 'ready_for_chunks' || m.status === 'uploading') currentImage.status = 'uploading';
    else if (m.status === 'uploaded') {
      currentImage.status = 'uploaded';
      currentImage.progress = 1;
    } else if (m.status === 'submitted') {
      currentImage.status = 'submitted';
      currentImage.progress = 1;
    } else if (m.status === 'error' || m.status === 'aborted') {
      currentImage.status = 'failed';
    }
    updateImagePreviewUi();
  }

  const waiter = S.uploadWaiters.get(m.uploadId);
  if (!waiter) return;
  if (m.status === 'error' || m.status === 'aborted') {
    S.uploadWaiters.delete(m.uploadId);
    waiter.reject(new Error(m.message || 'Image upload failed'));
    return;
  }
  if (!waiter.expectedStatuses.has(m.status)) return;
  if (waiter.matchFn && !waiter.matchFn(m)) return;
  S.uploadWaiters.delete(m.uploadId);
  waiter.resolve(m);
}

export function clearPendingImage({ abortUpload = true } = {}) {
  const currentImage = pendingImage;
  if (currentImage && abortUpload && currentImage.uploadId && S.ws && S.ws.readyState === WebSocket.OPEN &&
      currentImage.status !== 'submitted') {
    S.ws.send(JSON.stringify({ type: 'image_upload_abort', uploadId: currentImage.uploadId }));
  }
  if (currentImage?.previewUrl) {
    try { URL.revokeObjectURL(currentImage.previewUrl); } catch {}
  }
  setPendingImage(null);
  updateImagePreviewUi();
  updateSendBtn();
}

function fileChunkToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read image chunk'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      try { URL.revokeObjectURL(objectUrl); } catch {}
      reject(new Error('Failed to decode image preview'));
    };
    img.onload = () => {
      try {
        const maxW = 480;
        const maxH = 320;
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch (err) {
        reject(err);
      } finally {
        try { URL.revokeObjectURL(objectUrl); } catch {}
      }
    };
    img.src = objectUrl;
  });
}

export async function submitPendingImageUpload() {
  const currentImage = pendingImage;
  if (!currentImage || !currentImage.submitQueued || currentImage.status !== 'uploaded') return;
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) throw new Error('Connection lost');

  const uploadId = currentImage.uploadId;
  currentImage.status = 'submitting';
  updateImagePreviewUi();
  const waitForSubmitted = waitForUploadStatus(uploadId, ['submitted']);
  S.ws.send(JSON.stringify({
    type: 'image_submit',
    uploadId,
    text: currentImage.queuedText || '',
  }));
  await waitForSubmitted;
  clearPendingImage({ abortUpload: false });
}

async function startImageUpload(image) {
  if (!image || !S.ws || S.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Connection unavailable');
  }

  image.status = 'uploading';
  image.progress = 0;
  image.uploadedBytes = 0;
  updateImagePreviewUi();

  const totalChunks = Math.max(1, Math.ceil(image.file.size / IMAGE_CHUNK_BYTES));
  let waitForStatus = waitForUploadStatus(image.uploadId, ['ready_for_chunks']);
  S.ws.send(JSON.stringify({
    type: 'image_upload_init',
    uploadId: image.uploadId,
    totalBytes: image.file.size,
    totalChunks,
    mediaType: image.mediaType,
    name: image.name,
  }));
  await waitForStatus;

  for (let index = 0; index < totalChunks; index++) {
    const start = index * IMAGE_CHUNK_BYTES;
    const end = Math.min(image.file.size, start + IMAGE_CHUNK_BYTES);
    const base64 = await fileChunkToBase64(image.file.slice(start, end));
    waitForStatus = waitForUploadStatus(image.uploadId, ['uploading'], msg => msg.chunkIndex === index);
    S.ws.send(JSON.stringify({
      type: 'image_upload_chunk',
      uploadId: image.uploadId,
      index,
      base64,
    }));
    await waitForStatus;
  }

  waitForStatus = waitForUploadStatus(image.uploadId, ['uploaded']);
  S.ws.send(JSON.stringify({ type: 'image_upload_complete', uploadId: image.uploadId }));
  await waitForStatus;

  const currentImage = pendingImage;
  if (currentImage && currentImage.uploadId === image.uploadId && currentImage.submitQueued) {
    await submitPendingImageUpload();
  }
}

export function initImageUpload() {
  $('btn-image').addEventListener('click', () => {
    if (S.waiting) return;
    $('image-file-input').click();
  });

  $('image-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file');
      return;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      showToast('Image too large (max 4MB)');
      return;
    }
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN || !S.authenticated) {
      showToast('Connection unavailable');
      return;
    }

    clearPendingImage();
    const previewUrl = await fileToDataUrl(file);
    const newImage = {
      file,
      mediaType: file.type || 'image/png',
      name: file.name,
      previewUrl,
      uploadId: makeUploadId(),
      status: 'uploading',
      progress: 0,
      uploadedBytes: 0,
      totalBytes: file.size,
      submitQueued: false,
      queuedText: '',
    };
    setPendingImage(newImage);
    updateImagePreviewUi();
    updateSendBtn();

    try {
      await startImageUpload(newImage);
    } catch (err) {
      const currentImage = pendingImage;
      if (currentImage) {
        const wasQueued = currentImage.submitQueued;
        currentImage.status = 'failed';
        updateImagePreviewUi();
        if (wasQueued && S.waiting) setWaiting(false, 'image_upload_failed');
      }
      showToast(err.message || 'Image upload failed');
    }
  });

  $('image-preview-remove').addEventListener('click', () => {
    clearPendingImage();
  });

  updateImagePreviewUi();
  updateSendBtn();
}
