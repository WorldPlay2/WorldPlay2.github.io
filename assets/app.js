/* WorldPlay2 — standalone page interactions. No framework or build step. */
(() => {
  'use strict';
  const { overview, demos, comparisons } = window.WORLDPLAY_CONTENT;
  // Bypass video/poster entries already cached by an older local preview session.
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    const revision = Date.now().toString(36);
    const refreshMedia = value => {
      if (!value || typeof value !== 'object') return;
      Object.entries(value).forEach(([key, item]) => {
        if ((key === 'src' || key === 'poster' || key === 'hero') && typeof item === 'string') {
          value[key] = `${item}${item.includes('?') ? '&' : '?'}preview=${revision}`;
        } else refreshMedia(item);
      });
    };
    refreshMedia({ overview, demos, comparisons });
  }
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = value => String(value).padStart(2, '0');
  const shapes = {
    play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke-width="0"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  };
  // Every clip is rendered at 832x448; displaying wider than that is pure upscale.
  const NATIVE_FRAME_WIDTH = 832;
  const icon = name => `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
  const videoHTML = (media, title, controls = false) => `<video src="${escape(media.src)}" poster="${escape(media.poster)}" ${controls ? 'controls' : 'muted'} playsinline preload="metadata" aria-label="${escape(title)}"></video>`;

  // Keep the cover visible until a decoded frame reaches the compositor.
  // A play event alone does not mean the first video frame is ready to display.
  function protectFirstFrame(video) {
    const cover = new Image();
    cover.className = 'video-cover';
    cover.alt = '';
    cover.setAttribute('aria-hidden', 'true');
    cover.src = video.poster;
    video.after(cover);
    let frameRequest;
    let ready = false;
    function reveal() {
      if (ready || video.error || video.readyState < 2) return;
      ready = true;
      if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
      cover.classList.add('is-ready');
      video.removeEventListener('playing', fallback);
    }
    function fallback() {
      requestAnimationFrame(() => requestAnimationFrame(reveal));
    }
    if ('requestVideoFrameCallback' in video) frameRequest = video.requestVideoFrameCallback(reveal);
    // An opaque cover can suppress compositor callbacks; playing + two paint
    // opportunities is the fallback once HAVE_CURRENT_DATA confirms decoding.
    video.addEventListener('playing', fallback);
    video.addEventListener('error', () => {
      if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
      video.removeEventListener('playing', fallback);
      cover.remove();
    }, { once: true });
  }

  // Expanded videos retain their playback position and return keyboard focus.
  const dialog = document.createElement('dialog');
  dialog.className = 'lightbox';
  document.body.append(dialog);
  let returnFocus;
  let previousOverflow = '';
  let filmVideo;
  function openMedia(media, title, time = 0) {
    pauseFilm();
    returnFocus = document.activeElement;
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `<div class="lightbox-content"><div class="lightbox-heading"><span>${escape(title)}</span><button class="icon-button" aria-label="Close expanded view">${icon('close')}</button></div><div class="lightbox-player"></div><p class="lightbox-source">WorldPlay2 · ${escape(media.source)}</p></div>`;
    renderMedia($('.lightbox-player', dialog), media, title, false, time);
    $('.icon-button', dialog).onclick = () => dialog.close();
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    updateHeroPlayback();
  }
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    $$('video', dialog).forEach(video => video.pause());
    dialog.innerHTML = '';
    document.body.style.overflow = previousOverflow;
    returnFocus?.focus();
  });

  function renderMedia(host, media, title, expandable = true, time = 0) {
    host.innerHTML = `<div class="frame-viewer"><div class="media-stage">${videoHTML(media, title, true)}${expandable ? `<button class="media-expand" aria-label="Expand ${escape(title)}">${icon('expand')}</button>` : ''}</div></div>`;
    const video = $('video', host);
    protectFirstFrame(video);
    video.addEventListener('loadedmetadata', () => {
      if (time) video.currentTime = Math.min(time, Math.max(0, video.duration - 0.05));
    }, { once: true });
    video.addEventListener('error', () => {
      video.replaceWith(Object.assign(document.createElement('img'), { src: media.poster, alt: `${title} — preview` }));
      $('.media-stage', host).insertAdjacentHTML('beforeend', '<span class="media-kind">Video unavailable · frame preview</span>');
    }, { once: true });
    const expand = $('.media-expand', host);
    if (expand) expand.onclick = () => { video.pause(); openMedia(media, title, video.currentTime); };
  }

  // Overview video: a poster with one large play button. Nothing is requested
  // until the click; the video is then embedded from YouTube (or, if no
  // YouTube id is configured, played from the local file) with sound.
  const film = $('.film-frame');
  function pauseFilm() {
    if (!filmVideo) return;
    if (filmVideo.tagName === 'IFRAME') {
      filmVideo.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
    } else filmVideo.pause();
  }
  function playFilm() {
    if (!film || !overview) return;
    if (filmVideo) {
      if (filmVideo.tagName === 'VIDEO') filmVideo.play().catch(() => {});
      return;
    }
    // Always play inline. Note: YouTube refuses embeds without an HTTP Referer
    // (error 153), so a page opened from disk via file:// cannot play it; the
    // deployed https page (or a local http server) plays normally.
    if (overview.youtube) {
      // Same plain embed parameters as other project pages (no JS API / origin).
      const params = new URLSearchParams({ autoplay: '1', mute: '0', playsinline: '1', controls: '1', rel: '0' });
      filmVideo = Object.assign(document.createElement('iframe'), {
        src: `https://www.youtube.com/embed/${encodeURIComponent(overview.youtube)}?${params}`,
        title: 'Overview video',
        allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
        allowFullscreen: true,
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
    } else {
      filmVideo = Object.assign(document.createElement('video'), {
        src: overview.src, poster: overview.poster, controls: true, playsInline: true, preload: 'auto',
      });
      filmVideo.setAttribute('aria-label', 'Overview video');
      filmVideo.addEventListener('error', () => {
        film.insertAdjacentHTML('beforeend', '<span class="media-kind">Video unavailable</span>');
      }, { once: true });
    }
    $('.film-poster', film)?.remove();
    $('.film-play', film)?.remove();
    film.prepend(filmVideo);
    film.classList.add('is-playing');
    if (filmVideo.tagName === 'VIDEO') filmVideo.play().catch(() => {});
    filmVideo.focus({ preventScroll: true });
  }
  $('.film-play', film || document)?.addEventListener('click', playFilm);
  $$('[data-play-film]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    playFilm();
    film?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }));

  // Navigation and section highlighting.
  const navigation = $('.main-nav');
  const menu = $('.mobile-menu');
  function setMenu(open) {
    navigation.classList.toggle('is-open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    menu.innerHTML = icon(open ? 'close' : 'menu');
  }
  menu.onclick = () => setMenu(menu.getAttribute('aria-expanded') !== 'true');
  $$('a', navigation).forEach(link => link.addEventListener('click', () => setMenu(false)));
  const sectionObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      $$('a', navigation).forEach(link => {
        const active = link.hash === `#${entry.target.id}`;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    });
  }, { rootMargin: '-12% 0px -65% 0px' });
  $$('main > section[id]').forEach(section => sectionObserver.observe(section));

  // Two independent leftward loops: long-horizon above, interaction below.
  const hero = $('.hero');
  const heroControl = $('.hero-playback');
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const heroBackground = document.createElement('div');
  heroBackground.className = 'hero-background';
  heroBackground.setAttribute('aria-hidden', 'true');
  heroBackground.inert = true;
  $('.hero-image', hero)?.remove();
  hero.prepend(heroBackground);
  let heroPaused = motionPreference.matches;
  let heroVisible = false;
  let heroWidth = 0;
  let heroRequest = 0;
  let heroLastTime = 0;
  let heroMediaTime = 0;
  const heroSpeed = 180; // CSS pixels per second, independent of frame rate.
  function createHeroTile(media) {
    const tile = document.createElement('div');
    tile.className = 'hero-tile';
    tile.dataset.id = media.id;
    tile.innerHTML = `<video data-src="${escape(media.hero || media.src)}" poster="${escape(media.poster)}" muted loop playsinline preload="none"></video>`;
    const video = $('video', tile);
    video.muted = true;
    protectFirstFrame(video);
    video.addEventListener('error', () => {
      video.pause();
      video.replaceWith(Object.assign(document.createElement('img'), { src: video.poster, alt: '' }));
    }, { once: true });
    return tile;
  }
  const heroRows = [demos.revisit, demos.interaction].map((items, index) => {
    const row = document.createElement('div');
    row.className = 'hero-row';
    row.dataset.section = index === 0 ? 'long-horizon' : 'interaction';
    const track = document.createElement('div');
    track.className = 'hero-track';
    items.forEach(media => track.append(createHeroTile(media)));
    row.append(track);
    heroBackground.append(row);
    return { row, track, items, offset: 0, stride: 0 };
  });
  function heroRunning() {
    return !heroPaused && heroVisible && !document.hidden && !dialog.open;
  }
  function updateHeroControl() {
    heroControl.setAttribute('aria-label', heroPaused ? 'Play background video strips' : 'Pause background video strips');
    heroControl.innerHTML = icon(heroPaused ? 'play' : 'pause');
  }
  function updateHeroMedia() {
    heroRows.forEach(({ track, stride, offset }) => {
      [...track.children].forEach((tile, i) => {
        const video = $('video', tile);
        if (!video) return;
        const left = i * stride - offset;
        const onScreen = left < heroWidth && left + stride > 0;
        const approaching = left < heroWidth + stride * 0.35;
        if (heroVisible && approaching && !video.hasAttribute('src')) {
          video.preload = 'metadata';
          video.src = video.dataset.src;
        }
        if (!heroRunning() || !onScreen) { video.pause(); return; }
        if (video.paused) video.play().catch(error => {
          if (error.name === 'NotAllowedError' && heroRunning()) {
            heroPaused = true;
            updateHeroPlayback();
          }
        });
      });
    });
  }
  function animateHero(time) {
    if (!heroRunning()) { heroRequest = 0; return; }
    const elapsed = heroLastTime ? Math.min((time - heroLastTime) / 1000, 0.1) : 0;
    heroLastTime = time;
    heroRows.forEach(state => {
      state.offset += elapsed * heroSpeed;
      if (state.stride > 0 && state.offset >= state.stride) {
        state.offset -= state.stride;
        state.track.append(state.track.firstElementChild);
      }
      state.track.style.transform = `translate3d(${-state.offset}px, 0, 0)`;
    });
    if (time - heroMediaTime > 150) { heroMediaTime = time; updateHeroMedia(); }
    heroRequest = requestAnimationFrame(animateHero);
  }
  function updateHeroPlayback() {
    updateHeroControl();
    if (heroRunning()) {
      if (!heroRequest) { heroLastTime = 0; heroRequest = requestAnimationFrame(animateHero); }
    } else {
      cancelAnimationFrame(heroRequest);
      heroRequest = 0;
      heroLastTime = 0;
    }
    updateHeroMedia();
  }
  heroControl.onclick = () => { heroPaused = !heroPaused; updateHeroPlayback(); };
  new ResizeObserver(() => {
    heroWidth = hero.clientWidth;
    heroRows.forEach(state => {
      // Fit the whole 832×448 frame in its row; never enlarge beyond native size.
      const width = Math.min(832, state.row.clientHeight * 832 / 448);
      state.track.style.setProperty('--hero-tile-width', `${width}px`);
      const stride = width + parseFloat(getComputedStyle(state.track).gap);
      if (state.stride) state.offset = state.offset / state.stride * stride;
      state.stride = stride;
      // Whole repeated sequences ensure there is no empty edge on ultrawide displays.
      while (state.track.children.length * stride < heroWidth + stride) {
        const ordered = [...state.track.children].slice(0, state.items.length);
        ordered.forEach(tile => state.track.append(createHeroTile(state.items.find(media => media.id === tile.dataset.id))));
      }
      state.track.style.transform = `translate3d(${-state.offset}px, 0, 0)`;
    });
    updateHeroMedia();
  }).observe(heroBackground);
  new IntersectionObserver(([entry]) => { heroVisible = entry.isIntersecting; updateHeroPlayback(); }).observe(hero);
  document.addEventListener('visibilitychange', updateHeroPlayback);
  dialog.addEventListener('close', updateHeroPlayback);
  motionPreference.addEventListener('change', event => { heroPaused = event.matches; updateHeroPlayback(); });
  updateHeroControl();

  // A full-width, scroll-snapping filmstrip with one centered card and visible neighbors.
  function setupCarousel(section, items) {
    const carousel = $('.demo-carousel', section);
    const viewport = $('.carousel-viewport', carousel);
    const label = $('h3', carousel).textContent;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const clampIndex = value => Math.max(0, Math.min(items.length - 1, value));
    let index = 0;
    let visible = false;
    let dragging = false;
    let settleTimer;
    let ignoreClick = false;
    let selected = false;
    const paused = items.map(() => reducedMotion.matches);
    viewport.classList.add('filmstrip');
    viewport.innerHTML = items.map((item, itemIndex) => {
      return `<article class="carousel-slide" data-index="${itemIndex}" role="group" aria-roledescription="slide" aria-label="${itemIndex + 1} of ${items.length}"><div class="frame-viewer"><div class="media-stage"><video data-src="${escape(item.src)}" poster="${escape(item.poster)}" muted loop playsinline preload="none" aria-label="${escape(item.title)}"></video><button class="media-expand" aria-label="Expand ${escape(item.title)}">${icon('expand')}</button><button class="slide-playback" aria-label="Play ${escape(item.title)}">${icon('play')}</button></div></div></article>`;
    }).join('');
    const caption = document.createElement('div');
    caption.className = 'demo-caption-stack';
    caption.innerHTML = items.map(item => `<div class="demo-caption" aria-hidden="true" inert><div class="demo-caption-text"><h4>${escape(item.title)}</h4><p>${escape(item.description)}</p></div><dl class="demo-context"><div><dt>SCENE</dt><dd>${escape(item.scene)}</dd></div><div><dt>Character</dt><dd>${escape(item.subject)}</dd></div><div><dt>Event</dt><dd>${escape(item.control)}</dd></div></dl></div>`).join('');
    viewport.after(caption);
    const captions = $$('.demo-caption', caption);
    const cards = $$('.carousel-slide', viewport);
    const videos = cards.map(card => $('video', card));
    videos.forEach(protectFirstFrame);
    const dots = $('.carousel-dots', carousel);
    dots.innerHTML = items.map(item => `<button aria-label="Show ${escape(item.title)}" aria-pressed="false"></button>`).join('');

    function updatePlayback() {
      videos.forEach((video, physical) => {
        const isActive = physical === index;
        if (!isActive || !visible || paused[index] || document.hidden || dialog.open) { video.pause(); return; }
        if (!video.hasAttribute('src')) video.src = video.dataset.src;
        video.play().catch(error => {
          if (error.name === 'NotAllowedError' && physical === index) paused[index] = true;
        });
      });
    }
    function select(next) {
      next = clampIndex(next);
      if (selected && next === index) return;
      index = next;
      selected = true;
      captions.forEach((panel, i) => {
        panel.classList.toggle('is-current', i === index);
        panel.setAttribute('aria-hidden', String(i !== index));
        panel.inert = i !== index;
      });
      cards.forEach((card, physical) => {
        const active = physical === index;
        card.classList.toggle('is-active', active);
        card.inert = !active;
      });
      buttons[0].disabled = index === 0;
      buttons[1].disabled = index === items.length - 1;
      $('.slide-count', carousel).innerHTML = `${pad(index + 1)} <span>/ ${pad(items.length)}</span>`;
      $$('button', dots).forEach((button, i) => { button.classList.toggle('active', i === index); button.setAttribute('aria-pressed', String(i === index)); });
      $('.carousel-bottom > span', carousel).innerHTML = `${escape(items[index].source)} <span class="source-dot">·</span> WorldPlay2`;
      $('[aria-live]', carousel).textContent = `${items[index].title}, example ${index + 1} of ${items.length}`;
      updatePlayback();
    }
    function target(physical) {
      const rect = cards[physical].getBoundingClientRect();
      const container = viewport.getBoundingClientRect();
      return viewport.scrollLeft + rect.left - container.left - (viewport.clientWidth - rect.width) / 2;
    }
    function goTo(physical, smooth = true) {
      viewport.scrollTo({ left: target(clampIndex(physical)), behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant' });
    }
    function nearest() {
      let best = 0;
      cards.forEach((_, i) => { if (Math.abs(target(i) - viewport.scrollLeft) < Math.abs(target(best) - viewport.scrollLeft)) best = i; });
      return best;
    }
    function settle() {
      clearTimeout(settleTimer);
      if (dragging) return;
      select(nearest());
    }
    viewport.addEventListener('scroll', () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, 150);
    }, { passive: true });
    viewport.addEventListener('scrollend', settle);

    const buttons = $$('.carousel-navigation button', carousel);
    buttons[0].onclick = () => goTo(index - 1);
    buttons[1].onclick = () => goTo(index + 1);
    $$('button', dots).forEach((button, i) => { button.onclick = () => goTo(i); });
    viewport.onkeydown = event => {
      if (event.target !== viewport || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const physical = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1);
      goTo(physical);
    };

    cards.forEach((card, physical) => {
      const video = videos[physical];
      const item = items[physical];
      const playButton = $('.slide-playback', card);
      const reflectPlayback = () => {
        playButton.innerHTML = icon(video.paused ? 'play' : 'pause');
        playButton.setAttribute('aria-label', `${video.paused ? 'Play' : 'Pause'} ${item.title}`);
      };
      video.addEventListener('play', reflectPlayback);
      video.addEventListener('pause', reflectPlayback);
      video.addEventListener('error', () => {
        video.pause();
        video.hidden = true;
        const image = Object.assign(document.createElement('img'), { src: item.poster, alt: `${item.title} — preview` });
        $('.media-stage', card).prepend(image);
        $('.media-stage', card).insertAdjacentHTML('beforeend', '<span class="media-kind">Video unavailable · frame preview</span>');
        playButton.hidden = true;
      }, { once: true });
      playButton.onclick = () => { paused[physical] = !video.paused; updatePlayback(); };
      $('.media-expand', card).onclick = () => {
        video.pause();
        openMedia(item, item.title, video.currentTime);
      };
    });
    dialog.addEventListener('close', updatePlayback);
    document.addEventListener('visibilitychange', updatePlayback);
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; updatePlayback(); }, { threshold: 0.15 }).observe(viewport);

    // Native touch/trackpad scrolling; pointer dragging adds the same behavior for a mouse.
    let pointer;
    viewport.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('button, input, a')) return;
      pointer = { id: event.pointerId, x: event.clientX, scroll: viewport.scrollLeft };
    });
    viewport.addEventListener('pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const distance = event.clientX - pointer.x;
      if (!dragging && Math.abs(distance) > 6) {
        dragging = true;
        viewport.classList.add('is-dragging');
        viewport.setPointerCapture(event.pointerId);
      }
      if (dragging) { event.preventDefault(); viewport.scrollLeft = pointer.scroll - distance; }
    });
    function finishDrag(event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (dragging) {
        dragging = false;
        ignoreClick = true;
        const physical = nearest();
        viewport.classList.remove('is-dragging');
        goTo(physical);
        setTimeout(() => { ignoreClick = false; }, 0);
      }
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      pointer = null;
    }
    viewport.addEventListener('pointerup', finishDrag);
    viewport.addEventListener('pointercancel', finishDrag);
    viewport.addEventListener('click', event => {
      if (ignoreClick) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.target.closest('button, input, a')) return;
      const x = event.clientX;
      const physical = cards.findIndex(card => { const rect = card.getBoundingClientRect(); return x >= rect.left && x <= rect.right; });
      if (physical >= 0 && physical !== index) goTo(physical);
    });
    viewport.addEventListener('dragstart', event => event.preventDefault());

    let lastWidth = -1;
    let lastFullWidth = -1;
    function resize() {
      const width = carousel.clientWidth;
      const fullWidth = document.documentElement.clientWidth;
      // Caption/video height changes must never interrupt an in-flight scroll.
      if (width === lastWidth && fullWidth === lastFullWidth) return;
      lastWidth = width;
      lastFullWidth = fullWidth;
      // Never scale a card past the clips' native 832px frame. Once the column
      // is wide enough the card locks to 1:1; below that it keeps the 13/15
      // peek ratio so neighbouring slides stay visible on small screens.
      const card = width >= NATIVE_FRAME_WIDTH ? NATIVE_FRAME_WIDTH : width * 13 / 15;
      viewport.style.setProperty('--card-width', `${card}px`);
      viewport.style.setProperty('--strip-width', `${fullWidth}px`);
      viewport.style.width = `${fullWidth}px`;
      viewport.style.marginLeft = `${(width - fullWidth) / 2}px`;
      goTo(index, false);
    }
    new ResizeObserver(resize).observe(carousel);
    resize();
    select(0);
  }
  setupCarousel($('#flexible-control'), demos.interaction);
  setupCarousel($('#long-horizon'), demos.revisit);

  // Baselines come first, ours last. All videos share one actual time axis.
  function renderPair(host, pair) {
    const entries = [
      ...(pair.baselines || [{ name: pair.baseline, media: pair.theirs }]),
      { name: 'WorldPlay2', media: pair.ours, ours: true },
    ];
    const videoLabel = entries.length === 2 ? 'both videos' : 'all videos';
    let alive = true;
    let playing = false;
    let duration = 0;
    let progress = 0;
    let request = 0;
    let failed = false;
    host.innerHTML = `<div class="pair-grid${entries.length > 2 ? ' multi-videos' : ''}" style="--video-count:${entries.length}">${entries.map(({ name, media, ours }) => {
      return `<div class="pair-column ${ours ? 'ours' : ''}"><div class="pair-label"><span>${ours ? '<span class="status-dot"></span>' : ''}${escape(name)}</span><span class="pair-tag">${ours ? 'OURS' : 'BASELINE'}</span></div><div class="media-stage">${videoHTML(media, `${name}: ${pair.title}`)}<button class="media-expand" aria-label="Expand ${escape(name)} comparison">${icon('expand')}</button></div></div>`;
    }).join('')}</div><div class="pair-controls"><button class="round-button" aria-label="Play ${videoLabel}" disabled>${icon('play')}</button><span class="pair-control-label">SYNCHRONIZED PLAYBACK</span><input type="range" min="0" max="100" step="0.1" value="0" aria-label="${escape(pair.title)} comparison progress" style="--progress:0%"><span class="frame-count">0s / 0s</span></div><div class="pair-note"><span>Same scene · shared playback controls</span><span>${escape(pair.ours.source)}</span></div>`;
    const videos = $$('video', host);
    videos.forEach(video => { video.muted = true; protectFirstFrame(video); });
    // Comparison clips are only requested once the section is near the viewport.
    videos.forEach(video => { video.dataset.src = video.getAttribute('src'); video.removeAttribute('src'); });
    const lazyLoad = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      videos.forEach(video => { if (!video.hasAttribute('src')) video.src = video.dataset.src; });
      lazyLoad.disconnect();
    }, { rootMargin: '400px 0px' });
    lazyLoad.observe(host);
    const playButton = $('.pair-controls button', host);
    const slider = $('input', host);
    function display() {
      slider.value = progress;
      slider.style.setProperty('--progress', `${progress}%`);
      $('.frame-count', host).textContent = `${Math.floor(duration * progress / 100)}s / ${Math.floor(duration)}s`;
      playButton.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${videoLabel}`);
      playButton.innerHTML = icon(playing ? 'pause' : 'play');
    }
    function stop() {
      playing = false;
      cancelAnimationFrame(request);
      videos.forEach(video => video.pause());
      display();
    }
    function seek(value) {
      progress = Number(value);
      if (duration) videos.forEach(video => { video.currentTime = duration * progress / 100; });
      display();
    }
    function tick() {
      if (!playing || !alive) return;
      const [a, ...others] = videos;
      if (a.currentTime >= duration - 0.06) { progress = 100; stop(); return; }
      others.forEach(video => {
        if (Math.abs(a.currentTime - video.currentTime) > 0.2) video.currentTime = a.currentTime;
      });
      progress = a.currentTime / duration * 100;
      display();
      request = requestAnimationFrame(tick);
    }
    playButton.onclick = async () => {
      if (playing) { stop(); return; }
      if (progress >= 99.9) seek(0);
      playing = true;
      display();
      try {
        await Promise.all(videos.map(video => video.play()));
        if (!alive || !playing) { videos.forEach(video => video.pause()); return; }
        tick();
      } catch { if (alive) stop(); }
    };
    slider.oninput = () => seek(slider.value);
    videos.forEach(video => {
      video.addEventListener('loadedmetadata', () => {
        if (failed || !videos.every(v => Number.isFinite(v.duration) && v.duration > 0)) return;
        duration = Math.min(...videos.map(v => v.duration));
        playButton.disabled = false;
        display();
      });
      video.addEventListener('ended', () => { progress = 100; stop(); });
      video.addEventListener('error', () => {
        if (failed || !alive) return;
        failed = true;
        stop();
        playButton.disabled = true;
        slider.disabled = true;
        videos.forEach((v, i) => v.replaceWith(Object.assign(document.createElement('img'), { src: entries[i].media.poster, alt: `${entries[i].name} — preview` })));
        $('.pair-note > span', host).textContent = 'Video unavailable. Showing preview frames.';
        $('.pair-control-label', host).textContent = 'VIDEO PREVIEWS';
      });
    });
    $$('.media-expand', host).forEach((button, i) => {
      button.onclick = () => { stop(); openMedia(entries[i].media, `${entries[i].name} — ${pair.title}`, videos[i].currentTime); };
    });
    return () => { alive = false; lazyLoad.disconnect(); stop(); };
  }

  function setPairIntro(section, pair) {
    $('.pair-intro h3', section).textContent = pair.title;
    $('.pair-intro p', section).textContent = pair.description;
  }
  const comparisonSection = $('#comparisons');
  const comparisonButtons = $$('.baseline-options button');
  let disposeComparison = () => {};
  function selectComparison(index) {
    disposeComparison();
    comparisonButtons.forEach((button, i) => {
      button.classList.toggle('selected', i === index);
      button.setAttribute('aria-pressed', String(i === index));
    });
    setPairIntro(comparisonSection, comparisons[index]);
    disposeComparison = renderPair($('.pair-viewer', comparisonSection), comparisons[index]);
  }
  comparisonButtons.forEach((button, i) => { button.onclick = () => selectComparison(i); });
  selectComparison(0);


})();
