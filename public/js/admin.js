let pw = '';
const state = { photos: [] };

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  $('btn-unlock').addEventListener('click', unlock);
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('btn-refresh').addEventListener('click', load);
  $('btn-clear-todo').addEventListener('click', () => {
    $('todo-list').innerHTML = '';
    $('photos-todo').style.display = 'none';
  });
});

async function unlock() {
  pw = $('pw').value;
  const ok = await load();
  if (ok) {
    $('login').style.display = 'none';
    $('dash').style.display = 'block';
  } else {
    $('login-err').style.display = 'block';
  }
}

async function load() {
  try {
    const res = await fetch('/api/admin/photos', { headers: { 'X-Admin-Password': pw } });
    if (res.status === 403) return false;
    const data = await res.json();
    state.photos = data.photos || [];
    renderStats();
    renderGrid();
    return true;
  } catch (e) {
    toast('Could not reach the server.', true);
    return false;
  }
}

async function renderStats() {
  $('stat-count').textContent = state.photos.length;
  try {
    const res = await fetch('/api/admin/stats', { headers: { 'X-Admin-Password': pw } });
    if (res.ok) {
      const s = await res.json();
      $('stat-guests').textContent = s.total_guests ?? '—';
      $('stat-size').textContent = (s.totalSizeMB ?? '0') + ' MB';
    }
  } catch (e) { /* stats are optional */ }
}

function fileUrl(p) {
  // Public gallery file endpoint works in <img>/<video> (no header needed)
  return `/api/gallery/file/${p.guest_id}/${p.stored_name}`;
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  $('empty').style.display = state.photos.length ? 'none' : 'block';

  for (const p of state.photos) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.id = p.id;

    const isVideo = p.mime_type && p.mime_type.startsWith('video/');
    if (isVideo) {
      tile.innerHTML = `
        <video preload="metadata" muted playsinline src="${fileUrl(p)}#t=0.1"></video>
        <span class="badge">Video</span>`;
    } else {
      tile.innerHTML = `<img loading="lazy" src="${fileUrl(p)}" alt="">`;
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = p.guest_name || 'Guest';
    tile.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete photo';
    del.textContent = '×';
    del.onclick = () => removePhoto(p);
    tile.appendChild(del);

    grid.appendChild(tile);
  }
}

async function removePhoto(p) {
  if (!confirm(`Delete this photo from ${p.guest_name || 'a guest'}? This removes it from the website, the gallery, and the wall.`)) return;

  try {
    const res = await fetch(`/api/admin/upload/${p.id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Password': pw },
    });
    if (!res.ok) {
      toast('Delete failed.', true);
      return;
    }
    const data = await res.json();
    state.photos = state.photos.filter(x => x.id !== p.id);
    const tile = document.querySelector(`.tile[data-id="${p.id}"]`);
    if (tile) tile.remove();
    $('stat-count').textContent = state.photos.length;
    if (state.photos.length === 0) $('empty').style.display = 'block';

    addToPhotosTodo(data);
    toast('Removed from the website.');
  } catch (e) {
    toast('Delete failed.', true);
  }
}

// Track what still needs manual removal from Apple Photos
function addToPhotosTodo(data) {
  $('photos-todo').style.display = 'block';
  const li = document.createElement('li');
  li.innerHTML = `<span>${escHtml(data.photos_search)}</span><span class="who">from ${escHtml(data.guest_name)}</span>`;
  $('todo-list').appendChild(li);
}

function toast(msg, danger) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (danger ? ' danger' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast'; }, 3500);
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
