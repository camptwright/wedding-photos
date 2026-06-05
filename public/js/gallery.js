const state = { photos: [], config: {} };
let lightboxIndex = 0;

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/gallery/config');
    state.config = await res.json();
    document.getElementById('couple-names').textContent = state.config.coupleNames;
    document.getElementById('wedding-date').textContent = state.config.weddingDate;
    document.title = `${state.config.coupleNames} — Gallery`;
  } catch (e) { console.error('Config load failed:', e); }

  await loadPhotos();
  connectStream();

  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('lightbox').classList.contains('open')) return;
    if (e.key === 'ArrowLeft')  prevPhoto();
    if (e.key === 'ArrowRight') nextPhoto();
    if (e.key === 'Escape')     closeLightbox();
  });
});

async function loadPhotos() {
  try {
    const res = await fetch('/api/gallery/photos');
    const data = await res.json();
    state.photos = data.photos;
    renderGallery();
  } catch (e) { console.error('Failed to load photos:', e); }
}

function fileUrl(p) {
  return `/api/gallery/file/${p.guest_id}/${p.stored_name}`;
}

function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  const empty = document.getElementById('empty-state');
  const count = document.getElementById('photo-count');
  count.textContent = state.photos.length;

  if (state.photos.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = '';
  state.photos.forEach((photo, i) => {
    const item = document.createElement('div');
    item.className = 'masonry-item';
    item.setAttribute('data-index', i);
    item.addEventListener('click', () => openLightbox(i));

    if (photo.mime_type && photo.mime_type.startsWith('video/')) {
      item.innerHTML = `
        <div class="video-thumb">
          <div class="video-thumb-inner">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(232,93,117,0.6)" stroke-width="1.5">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
          <span class="video-badge-thumb">Video</span>
        </div>
        <div class="photo-label"><span>${escHtml(photo.guest_name)}</span></div>`;
    } else {
      const img = document.createElement('img');
      img.src = fileUrl(photo);
      img.loading = 'lazy';
      img.alt = '';
      item.appendChild(img);
      const label = document.createElement('div');
      label.className = 'photo-label';
      label.innerHTML = `<span>${escHtml(photo.guest_name)}</span>`;
      item.appendChild(label);
    }

    grid.appendChild(item);
  });
}

function openLightbox(index) {
  lightboxIndex = index;
  renderLightboxPhoto();
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
  // Pause any playing video
  const vid = document.querySelector('.lightbox-media video');
  if (vid) vid.pause();
}

function handleLightboxClick(e) {
  if (e.target === document.getElementById('lightbox')) closeLightbox();
}

function prevPhoto() {
  lightboxIndex = (lightboxIndex - 1 + state.photos.length) % state.photos.length;
  renderLightboxPhoto();
}

function nextPhoto() {
  lightboxIndex = (lightboxIndex + 1) % state.photos.length;
  renderLightboxPhoto();
}

function renderLightboxPhoto() {
  const photo = state.photos[lightboxIndex];
  const mediaEl = document.getElementById('lightbox-media');
  const isVideo = photo.mime_type && photo.mime_type.startsWith('video/');

  if (isVideo) {
    mediaEl.innerHTML = `<video src="${fileUrl(photo)}" controls autoplay muted playsinline></video>`;
  } else {
    mediaEl.innerHTML = `<img src="${fileUrl(photo)}" alt="">`;
  }

  document.getElementById('lightbox-name').textContent = `Shared by ${photo.guest_name}`;
  document.getElementById('lightbox-counter').textContent =
    `${lightboxIndex + 1} / ${state.photos.length}`;
}

function connectStream() {
  const es = new EventSource('/api/gallery/stream');
  es.addEventListener('newphotos', (ev) => {
    try {
      const incoming = JSON.parse(ev.data);
      let added = false;
      for (const p of incoming) {
        if (!state.photos.find(x => x.id === p.id)) {
          state.photos.unshift(p);
          added = true;
        }
      }
      if (added) renderGallery();
    } catch (e) { /* ignore */ }
  });

  es.addEventListener('removephoto', (ev) => {
    try {
      const { id } = JSON.parse(ev.data);
      const before = state.photos.length;
      state.photos = state.photos.filter(p => p.id !== id);
      if (state.photos.length !== before) renderGallery();
    } catch (e) { /* ignore */ }
  });
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}