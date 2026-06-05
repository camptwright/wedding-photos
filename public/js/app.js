let state = { guest: null, config: {}, uploads: [] };

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
    document.getElementById('couple-names').textContent = state.config.coupleNames;
    document.getElementById('wedding-date').textContent = state.config.weddingDate;
    document.getElementById('upload-max').textContent = state.config.maxUploads;
    document.title = `${state.config.coupleNames} — Wedding Photos`;
  } catch (e) { console.error('Config load failed:', e); }

  const params = new URLSearchParams(window.location.search);
  const tableId = params.get('table');
  if (tableId) document.getElementById('table-id').value = tableId;

  if (window.location.pathname === '/admin') { showScreen('admin'); return; }

  const saved = localStorage.getItem('wedding-guest');
  if (saved) {
    try {
      const guest = JSON.parse(saved);
      const res = await fetch('/api/guest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: guest.name, tableId: guest.table_id }),
      });
      state.guest = await res.json();
      localStorage.setItem('wedding-guest', JSON.stringify(state.guest));
      await loadMyUploads();
      showScreen('upload');
    } catch (e) { localStorage.removeItem('wedding-guest'); }
  }

  const nameInput = document.getElementById('guest-name');
  const enterBtn = document.getElementById('btn-enter');
  nameInput.addEventListener('input', () => { enterBtn.disabled = nameInput.value.trim().length < 1; });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !enterBtn.disabled) enterBtn.click(); });
  enterBtn.addEventListener('click', handleEnter);

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });

  document.getElementById('btn-done').addEventListener('click', () => showScreen('thanks'));
  document.getElementById('btn-more').addEventListener('click', () => showScreen('upload'));
  document.getElementById('btn-admin-login').addEventListener('click', handleAdminLogin);
  document.getElementById('admin-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdminLogin(); });
  document.getElementById('btn-admin-refresh')?.addEventListener('click', loadAdminData);
});

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  window.scrollTo(0, 0);
}

async function handleEnter() {
  const name = document.getElementById('guest-name').value.trim();
  const tableId = document.getElementById('table-id').value.trim();
  if (!name) return;
  try {
    const res = await fetch('/api/guest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, tableId: tableId || 'general' }),
    });
    if (!res.ok) throw new Error('Registration failed');
    state.guest = await res.json();
    localStorage.setItem('wedding-guest', JSON.stringify(state.guest));
    document.getElementById('guest-display-name').textContent = state.guest.name;
    updateCounter(state.guest.uploadCount);
    await loadMyUploads();
    showScreen('upload');
  } catch (e) { showStatus('Something went wrong. Please try again.', 'error'); }
}

async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList);
  const remaining = state.config.maxUploads - (state.guest?.uploadCount || 0);
  if (remaining <= 0) { showStatus(`You've reached the upload limit of ${state.config.maxUploads} files.`, 'error'); return; }
  if (files.length > remaining) showStatus(`You can only upload ${remaining} more file${remaining === 1 ? '' : 's'}. Sending the first ${remaining}.`, 'error');
  await uploadBatch(files.slice(0, remaining));
}

async function uploadBatch(files) {
  const progressEl = document.getElementById('upload-progress');
  const progressFill = document.getElementById('batch-progress');
  const progressText = document.getElementById('uploading-text');
  progressEl.style.display = 'block';

  const chunkSize = 5;
  let uploaded = 0, failed = 0;

  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    const formData = new FormData();
    chunk.forEach(f => formData.append('files', f));
    progressText.textContent = `Uploading ${uploaded + 1}–${Math.min(uploaded + chunk.length, files.length)} of ${files.length}...`;
    progressFill.style.width = `${(uploaded / files.length) * 100}%`;

    try {
      const res = await fetch('/api/upload', {
        method: 'POST', headers: { 'X-Guest-ID': state.guest.id }, body: formData,
      });
      const data = await res.json();
      if (!res.ok) { showStatus(data.error || 'Upload failed', 'error'); failed += chunk.length; continue; }
      uploaded += data.uploaded;
      failed += data.rejected;
      state.guest.uploadCount = data.totalUploads;
      updateCounter(data.totalUploads);
    } catch (e) { failed += chunk.length; showStatus('Network error. Check your connection and try again.', 'error'); }
  }

  progressFill.style.width = '100%';
  await new Promise(r => setTimeout(r, 400));
  progressEl.style.display = 'none';
  progressFill.style.width = '0%';
  document.getElementById('file-input').value = '';
  await loadMyUploads();

  if (uploaded > 0) { showStatus(`${uploaded} file${uploaded === 1 ? '' : 's'} shared successfully!`, 'success'); document.getElementById('btn-done').style.display = 'block'; }
  if (failed > 0 && uploaded > 0) showStatus(`${uploaded} uploaded, ${failed} couldn't be saved.`, 'error');
}

async function loadMyUploads() {
  if (!state.guest) return;
  try {
    const res = await fetch(`/api/uploads/${state.guest.id}`);
    const data = await res.json();
    state.uploads = data.uploads;
    state.guest.uploadCount = data.count;
    updateCounter(data.count);
    renderThumbnails();
  } catch (e) { console.error('Failed to load uploads:', e); }
}

function uploadFileUrl(upload) {
  // Public gallery endpoint serves files without auth — works in <img>/<video>
  return `/api/gallery/file/${upload.guest_id}/${upload.stored_name}`;
}

function thumbFallback(isVideo) {
  const bg = isVideo ? '#e8e2dc' : '#f0ece8';
  const inner = isVideo
    ? `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8a8480" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
    : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#b8977e" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  return `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:${bg}">${inner}</div>`;
}

function renderThumbnails() {
  const grid = document.getElementById('uploads-grid');
  grid.innerHTML = '';
  for (const upload of state.uploads) {
    const thumb = document.createElement('div');
    thumb.className = 'upload-thumb';
    const isVideo = upload.mime_type.startsWith('video/');

    if (isVideo) {
      const video = document.createElement('video');
      video.src = `${uploadFileUrl(upload)}#t=0.1`;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      // If the video frame can't render, show the placeholder icon instead
      video.onerror = () => { video.remove(); thumb.insertAdjacentHTML('afterbegin', thumbFallback(true)); };
      thumb.appendChild(video);
      thumb.insertAdjacentHTML('beforeend', `<span class="video-badge">Video</span>`);
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = uploadFileUrl(upload);
      // Raw HEIC or any load failure falls back to the icon so the tile isn't broken
      img.onerror = () => { img.remove(); thumb.insertAdjacentHTML('afterbegin', thumbFallback(false)); };
      thumb.appendChild(img);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '×';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteUpload(upload.id); };
    thumb.appendChild(delBtn);

    grid.appendChild(thumb);
  }
  if (state.uploads.length > 0) document.getElementById('btn-done').style.display = 'block';
}

async function deleteUpload(uploadId) {
  try {
    const res = await fetch(`/api/upload/${uploadId}`, {
      method: 'DELETE', headers: { 'X-Guest-ID': state.guest.id },
    });
    const data = await res.json();
    if (data.deleted) {
      state.guest.uploadCount = data.totalUploads;
      updateCounter(data.totalUploads);
      await loadMyUploads();
      showStatus('Photo removed.', 'success');
    }
  } catch (e) { showStatus('Could not delete. Try again.', 'error'); }
}

function updateCounter(count) {
  document.getElementById('upload-count').textContent = count;
  document.getElementById('progress-fill').style.width = `${(count / state.config.maxUploads) * 100}%`;
  document.getElementById('guest-display-name').textContent = state.guest?.name || '';
}

function showStatus(message, type) {
  const el = document.getElementById('status-message');
  el.textContent = message;
  el.className = `status-message ${type}`;
  el.style.display = 'block';
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

let adminPassword = '';
async function handleAdminLogin() {
  adminPassword = document.getElementById('admin-pw').value;
  await loadAdminData();
}

async function loadAdminData() {
  try {
    const res = await fetch('/api/admin/stats', { headers: { 'X-Admin-Password': adminPassword } });
    if (res.status === 403) { showStatus('Invalid password.', 'error'); return; }
    const data = await res.json();
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-content').style.display = 'block';
    document.getElementById('stats-grid').innerHTML = `
      <div class="stat-card"><div class="stat-value">${data.total_guests}</div><div class="stat-label">Guests</div></div>
      <div class="stat-card"><div class="stat-value">${data.total_uploads}</div><div class="stat-label">Photos</div></div>
      <div class="stat-card"><div class="stat-value">${data.totalSizeMB} MB</div><div class="stat-label">Total Size</div></div>`;
    const rows = data.guests.map(g => `<tr><td>${escHtml(g.name)}</td><td>${g.table_id || '—'}</td><td>${g.upload_count}</td><td>${new Date(g.created_at).toLocaleTimeString()}</td></tr>`).join('');
    document.getElementById('guests-table').innerHTML = `<table><thead><tr><th>Name</th><th>Table</th><th>Uploads</th><th>Joined</th></tr></thead><tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No guests yet</td></tr>'}</tbody></table>`;
  } catch (e) { showStatus('Failed to load dashboard.', 'error'); }
}

function escHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }