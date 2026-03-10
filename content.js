// YouTube Watch Later Swiper - Content Script

(function () {
  if (window.__swipeLaterLoaded) return;
  window.__swipeLaterLoaded = true;

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'SWIPE_LATER_LAUNCH') initSwiper();
  });

  // ─── Persistent memory ────────────────────────────────────────────────────
  const STORAGE_KEY = 'swipeLater_decisions';

  function loadMemory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveDecision(videoId, action) {
    const mem = loadMemory();
    mem[videoId] = { action, ts: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mem));
  }

  function getMemoryStats() {
    const mem = loadMemory();
    const vals = Object.values(mem);
    return {
      kept:    vals.filter(v => v.action === 'keep').length,
      removed: vals.filter(v => v.action === 'remove').length,
      skipped: vals.filter(v => v.action === 'skip').length,
      total:   vals.length,
    };
  }

  function clearMemory() { localStorage.removeItem(STORAGE_KEY); }

  // ─── State ────────────────────────────────────────────────────────────────
  let videos          = [];
  let currentIndex    = 0;
  let sessionDecisions = [];
  let isDragging      = false;
  let dragStartX      = 0;
  let dragCurrentX    = 0;
  let overlay         = null;
  let isAnimating     = false;

  // videoId → setVideoId map, populated once on launch from the page HTML
  let setVideoIdMap   = {};

  // ─── Read InnerTube config embedded in the page ───────────────────────────
  function getYtCfg() {
    try { return window.ytcfg?.data_ || window.yt?.config_ || {}; }
    catch { return {}; }
  }

  // ─── Pre-fetch ALL setVideoIds by loading the WL playlist page HTML ───────
  // YouTube embeds the full playlist JSON as ytInitialData inside the page.
  // We fetch the raw HTML (same origin, cookies included) and extract it.
  async function prefetchSetVideoIds() {
    try {
      const resp = await fetch('https://www.youtube.com/playlist?list=WL', {
        credentials: 'include',
        headers: { 'Accept': 'text/html' },
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      const html = await resp.text();

      // ytInitialData is a JS variable assignment in a <script> tag
      const marker = 'var ytInitialData = ';
      const start = html.indexOf(marker);
      if (start === -1) throw new Error('ytInitialData not found');

      // Find the end of the JSON object (the semicolon after the closing brace)
      let depth = 0, i = start + marker.length, end = -1;
      for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end === -1) throw new Error('Could not find end of ytInitialData');

      const json = JSON.parse(html.slice(start + marker.length, end));
      const map  = {};
      extractSetVideoIds(json, map);
      // Also store full video metadata from the parsed JSON
      extractVideoMetadata(json, map);

      console.log('[SwipeLater] Loaded playlist data:', Object.keys(map).length, 'entries');
      return map;
    } catch (err) {
      console.warn('[SwipeLater] prefetchSetVideoIds error:', err);
      return {};
    }
  }

  // ─── Walk ytInitialData to extract all videoId→setVideoId pairs ───────────
  function extractSetVideoIds(obj, map) {
    if (!obj || typeof obj !== 'object') return;
    // If this object has both videoId and setVideoId, record the pair
    if (obj.videoId && obj.setVideoId) {
      map[obj.videoId] = obj.setVideoId;
    }
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) val.forEach(item => extractSetVideoIds(item, map));
      else if (val && typeof val === 'object') extractSetVideoIds(val, map);
    }
  }

  // ─── Extract full video metadata from ytInitialData ─────────────────────
  // videoMetaMap: videoId -> { title, channel, duration, thumbnail }
  const videoMetaMap = {};

  function extractVideoMetadata(obj, _map) {
    if (!obj || typeof obj !== 'object') return;

    // playlistVideoRenderer has all the info we need
    if (obj.playlistVideoRenderer) {
      const r = obj.playlistVideoRenderer;
      const videoId = r.videoId;
      if (videoId) {
        const title = r.title?.runs?.[0]?.text
                   || r.title?.simpleText
                   || '';
        const channel = r.shortBylineText?.runs?.[0]?.text
                     || r.longBylineText?.runs?.[0]?.text
                     || '';
        const duration = r.lengthText?.simpleText
                      || r.lengthText?.runs?.[0]?.text
                      || '';
        const thumbnail = r.thumbnail?.thumbnails?.slice(-1)[0]?.url
                       || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        videoMetaMap[videoId] = { title, channel, duration, thumbnail };
      }
    }

    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) val.forEach(item => extractVideoMetadata(item, _map));
      else if (val && typeof val === 'object') extractVideoMetadata(val, _map);
    }
  }

  // ─── Remove video by clicking YouTube's own menu button ─────────────────
  // We target the inner <button> element (not yt-icon-button) to avoid the
  // Polymer toUpperCase crash. XPath finds "Remove from" in any language.
  async function removeVideoNow(video) {
    try {
      // Find the playlist item for this video in the live DOM
      const items = document.querySelectorAll('ytd-playlist-video-renderer');
      let targetItem = null;
      for (const item of items) {
        const link = item.querySelector('a#thumbnail, a#wc-endpoint');
        if (link?.href?.includes(video.id)) { targetItem = item; break; }
      }

      if (!targetItem) {
        console.warn('[SwipeLater] Item not in DOM for', video.id);
        return false;
      }

      // Scroll item into view so YouTube renders its action buttons
      targetItem.scrollIntoView({ block: 'center' });
      await wait(200);

      // The working selector from community scripts — targets the inner <button>
      // inside the menu renderer, NOT the yt-icon-button wrapper
      const menuBtn = targetItem.querySelector('#primary button[aria-label], ytd-menu-renderer button, #menu button');
      if (!menuBtn) {
        console.warn('[SwipeLater] Menu button not found for', video.id);
        return false;
      }

      menuBtn.click();
      await wait(600);

      // Use XPath to find "Remove from" text — works in any language
      const xpath = '//span[starts-with(normalize-space(text()),"Remove from") or starts-with(normalize-space(text()),"Usuń") or starts-with(normalize-space(text()),"Entfernen") or starts-with(normalize-space(text()),"Supprimer")]';
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const removeSpan = result.singleNodeValue;

      if (removeSpan) {
        removeSpan.click();
        console.log('[SwipeLater] ✓ Removed via DOM click:', video.title);
        await wait(300);
        return true;
      }

      // Fallback: find any menu item whose text contains "remove" case-insensitively
      const menuItems = document.querySelectorAll('ytd-menu-service-item-renderer');
      for (const mi of menuItems) {
        if (mi.textContent?.toLowerCase().includes('remove')) {
          mi.querySelector('tp-yt-paper-item, yt-formatted-string')?.click() ?? mi.click();
          console.log('[SwipeLater] ✓ Removed via fallback click:', video.title);
          await wait(300);
          return true;
        }
      }

      // Close the menu if we couldn't find remove
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      console.warn('[SwipeLater] Remove menu item not found for', video.title);
      return false;

    } catch (err) {
      console.warn('[SwipeLater] removeVideoNow error:', err);
      return false;
    }
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Build video list from ytInitialData (primary) + DOM (for ordering) ──
  function scrapeVideos() {
    const mem = loadMemory();

    // If we have metadata from ytInitialData, use it — covers all videos
    // including those not yet rendered by YouTube's virtual scroller
    if (Object.keys(videoMetaMap).length > 0) {
      return Object.entries(videoMetaMap)
        .filter(([videoId]) => !mem[videoId])
        .map(([videoId, meta]) => ({
          id:        videoId,
          title:     meta.title     || 'Unknown Title',
          channel:   meta.channel   || 'Unknown Channel',
          thumbnail: meta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          duration:  meta.duration  || '',
        }));
    }

    // Fallback: scrape the DOM (only covers rendered items)
    const items = document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer');
    const results = [];
    items.forEach((item, idx) => {
      try {
        const linkEl  = item.querySelector('a#wc-endpoint, a.ytd-playlist-panel-video-renderer, a#thumbnail');
        const href    = linkEl?.href || '';
        const idMatch = href.match(/[?&]v=([^&]+)/);
        const videoId = idMatch ? idMatch[1] : `video_${idx}`;
        if (mem[videoId]) return;

        const titleEl    = item.querySelector('#video-title, .title');
        const channelEl  = item.querySelector('#channel-name a, #byline-container a, .ytd-channel-name a');
        const thumbEl    = item.querySelector('img#img, img.yt-img-shadow, yt-image img');
        const durationEl = item.querySelector('span.ytd-thumbnail-overlay-time-status-renderer, #overlays span, badge-shape span');

        results.push({
          id:        videoId,
          title:     titleEl?.textContent?.trim()    || 'Unknown Title',
          channel:   channelEl?.textContent?.trim()  || 'Unknown Channel',
          thumbnail: thumbEl?.src || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          duration:  durationEl?.textContent?.trim() || '',
        });
      } catch { /* skip broken items */ }
    });
    return results;
  }

  // ─── Build overlay HTML ───────────────────────────────────────────────────
  function buildOverlay() {
    const stats = getMemoryStats();
    overlay = document.createElement('div');
    overlay.id = 'sl-overlay';
    overlay.innerHTML = `
      <div id="sl-backdrop"></div>
      <div id="sl-panel">
        <div id="sl-header">
          <div id="sl-logo">SWIPE<span>LATER</span></div>
          <div id="sl-counter"><span id="sl-current">1</span> / <span id="sl-total">0</span></div>
          <button id="sl-close" title="Close">✕</button>
        </div>
        <div id="sl-progress-bar"><div id="sl-progress-fill"></div></div>
        <div id="sl-session-info">
          <span id="sl-session-prev">${stats.total > 0 ? `📦 ${stats.total} already decided` : '✨ Fresh start'}</span>
          <button id="sl-btn-reset-memory">Reset history</button>
        </div>
        <div id="sl-card-area">
          <div id="sl-hint-remove" class="sl-hint">✕ REMOVE</div>
          <div id="sl-hint-keep" class="sl-hint">♥ KEEP</div>
          <div id="sl-card">
            <div id="sl-card-inner">
              <div id="sl-thumb-wrap">
                <img id="sl-thumb" src="" alt="">
                <div id="sl-duration-badge"></div>
                <div id="sl-overlay-label" class="sl-overlay-label"></div>
              </div>
              <div id="sl-info">
                <div id="sl-title"></div>
                <div id="sl-channel"></div>
              </div>
            </div>
          </div>
          <div id="sl-next-peek"></div>
        </div>
        <div id="sl-removing-toast">
          <span class="sl-spinner">⟳</span> Removing from playlist…
        </div>
        <div id="sl-actions">
          <button class="sl-action-btn sl-remove" id="sl-btn-remove" title="Remove (←)">
            <span class="sl-action-icon">✕</span>
            <span class="sl-action-label">Remove</span>
          </button>
          <button class="sl-action-btn sl-skip" id="sl-btn-skip" title="Skip (↑)">
            <span class="sl-action-icon">—</span>
            <span class="sl-action-label">Skip</span>
          </button>
          <button class="sl-action-btn sl-keep" id="sl-btn-keep" title="Keep (→)">
            <span class="sl-action-icon">♥</span>
            <span class="sl-action-label">Keep</span>
          </button>
        </div>
        <div id="sl-stats-bar">
          <span id="sl-stat-keep">♥ 0 kept</span>
          <span id="sl-stat-remove">✕ 0 removed</span>
          <span id="sl-stat-skip">— 0 skipped</span>
        </div>
      </div>

      <div id="sl-loading-panel">
        <div id="sl-loading-inner">
          <div class="sl-loading-spinner">⟳</div>
          <div id="sl-loading-text">Loading playlist data…</div>
        </div>
      </div>

      <div id="sl-results-panel" style="display:none">
        <div id="sl-results-inner">
          <div id="sl-results-title">Session Complete!</div>
          <div id="sl-results-subtitle">Here's what happened this session</div>
          <div id="sl-results-stats">
            <div class="sl-stat-card sl-stat-keep-card">
              <div class="sl-stat-num" id="res-keep">0</div>
              <div class="sl-stat-lbl">Kept</div>
            </div>
            <div class="sl-stat-card sl-stat-remove-card">
              <div class="sl-stat-num" id="res-remove">0</div>
              <div class="sl-stat-lbl">Removed</div>
            </div>
            <div class="sl-stat-card sl-stat-skip-card">
              <div class="sl-stat-num" id="res-skip">0</div>
              <div class="sl-stat-lbl">Skipped</div>
            </div>
          </div>
          <div id="sl-all-time-wrap">
            <div id="sl-all-time-label">All-time across sessions</div>
            <div id="sl-all-time-stats"></div>
          </div>
          <div id="sl-results-actions">
            <button id="sl-btn-close-results">✓ Done</button>
            <button id="sl-btn-reset-memory-results">🗑 Clear All History</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('sl-visible'));
  }

  function showPanel(id) {
    ['sl-panel', 'sl-loading-panel', 'sl-results-panel'].forEach(p => {
      const el = document.getElementById(p);
      if (el) el.style.display = (p === id) ? (p === 'sl-panel' ? 'flex' : 'flex') : 'none';
    });
  }

  // ─── Render card ──────────────────────────────────────────────────────────
  function renderCard(index) {
    if (index >= videos.length) { showResults(); return; }

    const v     = videos[index];
    const total = videos.length;
    const card  = document.getElementById('sl-card');

    document.getElementById('sl-thumb').src             = v.thumbnail;
    document.getElementById('sl-title').textContent     = v.title;
    document.getElementById('sl-channel').textContent   = v.channel;
    document.getElementById('sl-duration-badge').textContent = v.duration;
    document.getElementById('sl-current').textContent   = index + 1;
    document.getElementById('sl-total').textContent     = total;
    document.getElementById('sl-progress-fill').style.width = `${(index / total) * 100}%`;
    document.getElementById('sl-overlay-label').className   = 'sl-overlay-label';
    document.getElementById('sl-overlay-label').textContent = '';

    card.style.transition = 'none';
    card.style.transform  = '';
    card.style.opacity    = '1';

    const peek = document.getElementById('sl-next-peek');
    if (index + 1 < videos.length) {
      peek.style.backgroundImage = `url(${videos[index + 1].thumbnail})`;
      peek.style.display = 'block';
    } else {
      peek.style.display = 'none';
    }

    updateStats();
  }

  function updateStats() {
    const kept    = sessionDecisions.filter(d => d.action === 'keep').length;
    const removed = sessionDecisions.filter(d => d.action === 'remove').length;
    const skipped = sessionDecisions.filter(d => d.action === 'skip').length;
    document.getElementById('sl-stat-keep').textContent   = `♥ ${kept} kept`;
    document.getElementById('sl-stat-remove').textContent = `✕ ${removed} removed`;
    document.getElementById('sl-stat-skip').textContent   = `— ${skipped} skipped`;
  }

  // ─── Handle a swipe decision ──────────────────────────────────────────────
  async function decide(action) {
    if (isAnimating) return;
    isAnimating = true;

    const video        = videos[currentIndex];
    const card         = document.getElementById('sl-card');
    const label        = document.getElementById('sl-overlay-label');
    const removingToast = document.getElementById('sl-removing-toast');

    card.style.transition = 'transform 0.32s ease, opacity 0.32s ease';
    if (action === 'keep') {
      label.textContent = '♥ KEEP';
      label.className   = 'sl-overlay-label sl-label-keep sl-label-show';
      card.style.transform = 'translateX(140%) rotate(22deg)';
    } else if (action === 'remove') {
      label.textContent = '✕ REMOVE';
      label.className   = 'sl-overlay-label sl-label-remove sl-label-show';
      card.style.transform = 'translateX(-140%) rotate(-22deg)';
    } else {
      label.textContent = '— SKIP';
      label.className   = 'sl-overlay-label sl-label-skip sl-label-show';
      card.style.transform = 'translateY(-110%) scale(0.88)';
    }
    card.style.opacity = '0';

    saveDecision(video.id, action);
    sessionDecisions.push({ ...video, action });

    if (action === 'remove') {
      removingToast.classList.add('sl-toast-visible');
      removeVideoNow(video).then(success => {
        removingToast.classList.remove('sl-toast-visible');
        if (!success) showWarning(`⚠ Couldn't remove "${video.title.slice(0, 40)}" — remove manually`);
      });
    }

    await wait(340);
    currentIndex++;
    isAnimating = false;
    renderCard(currentIndex);
  }

  function showWarning(msg) {
    const n = document.createElement('div');
    n.className = 'sl-notif sl-notif-warn';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 5000);
  }

  // ─── Drag ─────────────────────────────────────────────────────────────────
  function onDragStart(e) {
    if (isAnimating) return;
    isDragging   = true;
    dragStartX   = e.touches ? e.touches[0].clientX : e.clientX;
    dragCurrentX = dragStartX;
    document.getElementById('sl-card').style.transition = 'none';
  }

  function onDragMove(e) {
    if (!isDragging) return;
    dragCurrentX  = e.touches ? e.touches[0].clientX : e.clientX;
    const diff    = dragCurrentX - dragStartX;
    const card    = document.getElementById('sl-card');
    const label   = document.getElementById('sl-overlay-label');
    const hintR   = document.getElementById('sl-hint-remove');
    const hintK   = document.getElementById('sl-hint-keep');

    card.style.transform = `translateX(${diff}px) rotate(${diff * 0.07}deg)`;

    if (diff > 40) {
      label.textContent = '♥ KEEP';
      label.className   = 'sl-overlay-label sl-label-keep sl-label-show';
      hintK.style.opacity = Math.min(1, diff / 100);
      hintR.style.opacity = 0;
    } else if (diff < -40) {
      label.textContent = '✕ REMOVE';
      label.className   = 'sl-overlay-label sl-label-remove sl-label-show';
      hintR.style.opacity = Math.min(1, -diff / 100);
      hintK.style.opacity = 0;
    } else {
      label.className   = 'sl-overlay-label';
      hintR.style.opacity = 0;
      hintK.style.opacity = 0;
    }
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    const diff = dragCurrentX - dragStartX;
    document.getElementById('sl-hint-remove').style.opacity = 0;
    document.getElementById('sl-hint-keep').style.opacity   = 0;

    if (diff > 80)       decide('keep');
    else if (diff < -80) decide('remove');
    else {
      const card = document.getElementById('sl-card');
      card.style.transition = 'transform 0.3s ease';
      card.style.transform  = '';
      document.getElementById('sl-overlay-label').className = 'sl-overlay-label';
    }
  }

  // ─── Results screen ───────────────────────────────────────────────────────
  function showResults() {
    document.getElementById('sl-panel').style.display         = 'none';
    document.getElementById('sl-results-panel').style.display = 'flex';

    const kept    = sessionDecisions.filter(d => d.action === 'keep').length;
    const removed = sessionDecisions.filter(d => d.action === 'remove').length;
    const skipped = sessionDecisions.filter(d => d.action === 'skip').length;
    document.getElementById('res-keep').textContent   = kept;
    document.getElementById('res-remove').textContent = removed;
    document.getElementById('res-skip').textContent   = skipped;

    const all = getMemoryStats();
    document.getElementById('sl-all-time-stats').innerHTML = `
      <span class="at-keep">♥ ${all.kept} kept</span>
      <span class="at-remove">✕ ${all.removed} removed</span>
      <span class="at-skip">— ${all.skipped} skipped</span>
      <span class="at-total">${all.total} total</span>
    `;

    document.getElementById('sl-btn-close-results').addEventListener('click', closeOverlay);
    document.getElementById('sl-btn-reset-memory-results').addEventListener('click', () => {
      if (confirm('Clear all swipe history? You\'ll see all undecided videos again next time.')) {
        clearMemory(); closeOverlay();
      }
    });
  }

  // ─── Close ────────────────────────────────────────────────────────────────
  function closeOverlay() {
    document.removeEventListener('keydown', onKeyDown);
    if (overlay) {
      overlay.classList.remove('sl-visible');
      setTimeout(() => { overlay?.remove(); overlay = null; window.__swipeLaterLoaded = false; }, 400);
    }
  }

  function onKeyDown(e) {
    if (!overlay || isAnimating) return;
    if      (e.key === 'ArrowLeft')  decide('remove');
    else if (e.key === 'ArrowRight') decide('keep');
    else if (e.key === 'ArrowUp')    decide('skip');
    else if (e.key === 'Escape')     closeOverlay();
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  async function initSwiper() {
    if (overlay) return;

    // Build overlay immediately so user sees feedback
    buildOverlay();

    // Show loading state while we fetch setVideoIds
    document.getElementById('sl-panel').style.display         = 'none';
    document.getElementById('sl-loading-panel').style.display = 'flex';
    document.getElementById('sl-results-panel').style.display = 'none';

    // Fetch the full playlist HTML to extract all setVideoId values
    setVideoIdMap = await prefetchSetVideoIds();

    const mapSize = Object.keys(setVideoIdMap).length;
    if (mapSize === 0) {
      document.getElementById('sl-loading-text').textContent =
        '⚠ Could not load playlist data. Make sure you\'re logged in and on the Watch Later page.';
      return;
    }

    // Scrape visible videos from the DOM, excluding already-decided ones
    videos = scrapeVideos();
    const allStats = getMemoryStats();

    if (videos.length === 0) {
      const msg = allStats.total > 0
        ? `All visible videos already decided (${allStats.total} total). Scroll down to load more, or reset history.`
        : 'No Watch Later videos found. Make sure you\'re on youtube.com/playlist?list=WL';
      document.getElementById('sl-loading-text').textContent = msg;
      return;
    }

    currentIndex     = 0;
    sessionDecisions = [];

    // Switch to main panel
    document.getElementById('sl-loading-panel').style.display = 'none';
    document.getElementById('sl-panel').style.display         = 'flex';
    renderCard(0);

    // Wire up buttons
    document.getElementById('sl-btn-keep').addEventListener('click',   () => decide('keep'));
    document.getElementById('sl-btn-remove').addEventListener('click', () => decide('remove'));
    document.getElementById('sl-btn-skip').addEventListener('click',   () => decide('skip'));
    document.getElementById('sl-close').addEventListener('click', closeOverlay);
    document.getElementById('sl-backdrop').addEventListener('click', (e) => {
      if (e.target === document.getElementById('sl-backdrop')) closeOverlay();
    });
    document.getElementById('sl-btn-reset-memory').addEventListener('click', () => {
      if (confirm('Clear all swipe history? You\'ll see all videos again next time.')) {
        clearMemory(); closeOverlay();
        setTimeout(() => initSwiper(), 500);
      }
    });

    const card = document.getElementById('sl-card');
    card.addEventListener('mousedown', onDragStart);
    card.addEventListener('touchstart', onDragStart, { passive: true });
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('touchmove', onDragMove, { passive: true });
    document.addEventListener('mouseup', onDragEnd);
    document.addEventListener('touchend', onDragEnd);
    document.addEventListener('keydown', onKeyDown);
  }
})();
