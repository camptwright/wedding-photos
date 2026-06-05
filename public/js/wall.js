// ─── Photo Wall Engine ──────────────────────────────────────────────────────
const KEY = new URLSearchParams(window.location.search).get('key') || '';

// When no key is provided, use the public gallery API routes
function apiUrl(path) {
  return KEY
    ? `/api/wall/${path}?key=${encodeURIComponent(KEY)}`
    : `/api/gallery/${path}`;
}
function fileUrl(p) {
  return KEY
    ? `/api/wall/file/${p.guest_id}/${p.stored_name}?key=${encodeURIComponent(KEY)}`
    : `/api/gallery/file/${p.guest_id}/${p.stored_name}`;
}

const state = {
  config: { slideSeconds: 7, coupleNames: 'Our Wedding' },
  photos: [],            // all known photos (objects)
  seen: new Set(),       // ids we've loaded
  queue: [],             // display order (ids)
  freshQueue: [],        // ids of just-uploaded photos to show next
  cursor: 0,
  activeStage: 'a',
  slideTimer: null,
  isShowing: false,
};

const el = {
  stageA: document.getElementById('stage-a'),
  stageB: document.getElementById('stage-b'),
  caption: document.getElementById('caption'),
  captionInner: document.querySelector('.caption-inner'),
  captionName: document.getElementById('caption-name'),
  freshBadge: document.getElementById('fresh-badge'),
  coupleNames: document.getElementById('couple-names'),
  emptyCouple: document.getElementById('empty-couple'),
  photoCount: document.getElementById('photo-count'),
  liveDot: document.getElementById('live-dot'),
  overlay: document.getElementById('overlay-message'),
  errorMsg: document.getElementById('error-message'),
};

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const cfgRes = await fetch(apiUrl('config'));
    if (cfgRes.status === 403) return showError();
    state.config = await cfgRes.json();
    el.coupleNames.textContent = state.config.coupleNames;
    el.emptyCouple.textContent = state.config.coupleNames;
    document.title = `${state.config.coupleNames} — Photo Wall`;
  } catch (e) { /* keep defaults */ }

  await loadPhotos(true);
  connectStream();
  setInterval(() => loadPhotos(false), 15000); // polling fallback

  // Tap anywhere to attempt fullscreen (browsers require a gesture)
  document.body.addEventListener('click', requestFullscreen, { once: true });
}

function showError() {
  el.overlay.style.display = 'none';
  el.errorMsg.style.display = 'flex';
}

function requestFullscreen() {
  const elem = document.documentElement;
  if (elem.requestFullscreen) elem.requestFullscreen().catch(() => {});
}

// ─── Load photos ──────────────────────────────────────────────────────────────
async function loadPhotos(isInitial) {
  try {
    const res = await fetch(apiUrl('photos'));
    if (!res.ok) return;
    const data = await res.json();

    const newOnes = [];
    for (const p of data.photos) {
      if (!state.seen.has(p.id)) {
        state.seen.add(p.id);
        state.photos.push(p);
        newOnes.push(p);
      }
    }

    updateCount();

    if (newOnes.length > 0) {
      // Build/extend the shuffled display queue with the new photos
      const shuffledNew = shuffle(newOnes.map(p => p.id));
      state.queue.push(...shuffledNew);

      if (isInitial && state.photos.length > 0) {
        hideOverlay();
        startSlideshow();
      } else if (!state.isShowing && state.photos.length > 0) {
        hideOverlay();
        startSlideshow();
      }
    }
  } catch (e) { /* network hiccup; polling will retry */ }
}

// ─── Live stream (SSE) ─────────────────────────────────────────────────────────
function connectStream() {
  const es = new EventSource(apiUrl('stream'));

  es.addEventListener('open', () => el.liveDot.classList.remove('offline'));

  es.addEventListener('newphotos', (ev) => {
    try {
      const photos = JSON.parse(ev.data);
      const fresh = [];
      for (const p of photos) {
        if (!state.seen.has(p.id)) {
          state.seen.add(p.id);
          state.photos.push(p);
          fresh.push(p.id);
        }
      }
      if (fresh.length > 0) {
        // Newest uploads jump to the front so they appear within ~1 slide
        state.freshQueue.push(...fresh);
        updateCount();
        if (!state.isShowing) { hideOverlay(); startSlideshow(); }
      }
    } catch (e) { /* ignore malformed */ }
  });

  es.addEventListener('error', () => {
    el.liveDot.classList.add('offline');
    // EventSource auto-reconnects; polling keeps us fresh meanwhile
  });

  es.addEventListener('removephoto', (ev) => {
    try {
      const { id } = JSON.parse(ev.data);
      state.photos = state.photos.filter(p => p.id !== id);
      state.queue = state.queue.filter(q => q !== id);
      state.freshQueue = state.freshQueue.filter(q => q !== id);
      state.seen.delete(id);
      updateCount();
    } catch (e) { /* ignore */ }
  });
}

// ─── Slideshow loop ─────────────────────────────────────────────────────────────
function startSlideshow() {
  if (state.isShowing) return;
  state.isShowing = true;
  advance();
}

function nextPhotoId() {
  // Fresh uploads take priority
  if (state.freshQueue.length > 0) {
    return { id: state.freshQueue.shift(), fresh: true };
  }
  // Otherwise cycle the main queue; reshuffle when exhausted
  if (state.cursor >= state.queue.length) {
    state.queue = shuffle(state.photos.map(p => p.id));
    state.cursor = 0;
  }
  const id = state.queue[state.cursor++];
  return { id, fresh: false };
}

function advance() {
  clearTimeout(state.slideTimer);
  if (state.photos.length === 0) { state.isShowing = false; return; }

  const { id, fresh } = nextPhotoId();
  const photo = state.photos.find(p => p.id === id);
  if (!photo) { advance(); return; }

  showPhoto(photo, fresh);
}

function showPhoto(photo, fresh) {
  const current = state.activeStage === 'a' ? el.stageA : el.stageB;
  const next = state.activeStage === 'a' ? el.stageB : el.stageA;

  const isVideo = photo.mime_type && photo.mime_type.startsWith('video/');
  next.innerHTML = '';

  let mediaEl;
  if (isVideo) {
    mediaEl = document.createElement('video');
    mediaEl.src = fileUrl(photo);
    mediaEl.muted = true;
    mediaEl.autoplay = true;
    mediaEl.playsInline = true;
    mediaEl.loop = false;
  } else {
    mediaEl = document.createElement('img');
    mediaEl.src = fileUrl(photo);
  }

  // If media fails to load (e.g. HEIC), skip to the next one
  mediaEl.onerror = () => { state.activeStage = state.activeStage === 'a' ? 'a' : 'b'; advance(); };

  const proceed = () => {
    next.appendChild(mediaEl);
    next.classList.add('active');
    current.classList.remove('active');
    state.activeStage = state.activeStage === 'a' ? 'b' : 'a';

    // Caption
    el.captionInner.classList.remove('show');
    el.freshBadge.classList.toggle('show', !!fresh);
    el.captionName.textContent = `Shared by ${photo.guest_name}`;
    // Reflow then show
    void el.captionInner.offsetWidth;
    el.captionInner.classList.add('show');

    // Schedule next slide
    if (isVideo) {
      const maxMs = 14000;
      const fallback = setTimeout(advance, maxMs);
      mediaEl.onended = () => { clearTimeout(fallback); advance(); };
    } else {
      state.slideTimer = setTimeout(advance, state.config.slideSeconds * 1000);
    }
  };

  if (isVideo) {
    mediaEl.onloadeddata = proceed;
    mediaEl.play().catch(() => {});
  } else if (mediaEl.complete) {
    proceed();
  } else {
    mediaEl.onload = proceed;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function updateCount() {
  const n = state.photos.length;
  el.photoCount.textContent = `${n} ${n === 1 ? 'memory' : 'memories'}`;
}

function hideOverlay() {
  el.overlay.classList.add('hidden');
}

init();