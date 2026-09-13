(() => {
  if (window.__stickerScraperInjected) return;
  window.__stickerScraperInjected = true;

  function isInViewport(rect) {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.width > 10 && rect.height > 10 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  function isRendered(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    if (el.offsetParent === null && style.position !== "fixed") return false;
    return true;
  }

  function scrapeVisible() {
    // Stiker TikTok kadang <img alt="sticker"> (statis) tapi animasinya di <video>/<source>
    // di dalam bubble chat yang sama. Ambil keduanya biar tidak cuma dapat thumbnail diem.
    const nodes = document.querySelectorAll(
      'img[alt="sticker"], [data-e2e="dm-new-chat-item"] img, [data-e2e="dm-new-chat-item"] video, [data-e2e="dm-new-chat-item"] video source, [data-e2e="chat-item"] img, [data-e2e="chat-item"] video'
    );
    const out = [];
    const seen = new Set();
    nodes.forEach((el, i) => {
      const tag = (el.tagName || "").toUpperCase();
      let src = "";
      if (tag === "VIDEO") src = el.currentSrc || el.src || "";
      else if (tag === "SOURCE") src = el.src || el.getAttribute("src") || "";
      else src = el.currentSrc || el.src || el.getAttribute("data-src") || "";
      if (!src || seen.has(src)) return;
      // skip avatar kecil / emoji inline
      const holder = tag === "SOURCE" ? el.parentElement : el;
      if (!isRendered(holder || el)) return;
      const rect = (holder || el).getBoundingClientRect();
      if (!isInViewport(rect)) return;
      if (rect.width < 40 || rect.height < 40) return; // avatar & icon
      seen.add(src);
      const kind = tag.toLowerCase(); // img | video | source
      out.push({ src, width: Math.round(rect.width), height: Math.round(rect.height), index: i, kind });
    });
    return out;
  }

  async function mergeIntoHistory(list) {
    if (!list.length) return 0;
    const data = await chrome.storage.local.get(["stickerHistory"]);
    const history = Array.isArray(data.stickerHistory) ? data.stickerHistory : [];
    const seen = new Set(history.map((h) => h.src));
    const now = Date.now();
    let added = 0;
    for (const s of list) {
      if (seen.has(s.src)) {
        const h = history.find((x) => x.src === s.src);
        if (h) { h.lastSeen = now; h.count = (h.count || 1) + 1; }
        continue;
      }
      seen.add(s.src);
      history.push({ src: s.src, width: s.width, height: s.height, kind: s.kind || "", firstSeen: now, lastSeen: now, count: 1, page: location.href });
      added++;
    }
    await chrome.storage.local.set({ stickerHistory: history });
    return added;
  }

  // --- auto-scan: observer + scroll, debounce 1.2s ---
  let autoOn = false;
  let timer = null;
  let observer = null;

  async function autoCollect(reason) {
    try {
      const list = scrapeVisible();
      if (list.length) await mergeIntoHistory(list);
    } catch (_) { /* abaikan */ }
  }

  function schedule() {
    if (!autoOn) return;
    clearTimeout(timer);
    timer = setTimeout(() => autoCollect("debounce"), 1200);
  }

  function startAuto() {
    if (autoOn) return;
    autoOn = true;
    autoCollect("start");
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    if (!observer) {
      observer = new MutationObserver(schedule);
    }
    try { observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] }); } catch (_) {}
  }

  function stopAuto() {
    autoOn = false;
    clearTimeout(timer);
    window.removeEventListener("scroll", schedule, { capture: true });
    window.removeEventListener("resize", schedule);
    try { if (observer) observer.disconnect(); } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "SCRAPE_VISIBLE_STICKERS") {
      try {
        const stickers = scrapeVisible();
        // manual scan juga ikut nabung ke history biar konsisten
        mergeIntoHistory(stickers).then(() => {
          sendResponse({ ok: true, stickers, url: location.href });
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return true;
    }
    if (msg.type === "AUTO_START") { startAuto(); sendResponse({ ok: true, auto: true }); return true; }
    if (msg.type === "AUTO_STOP") { stopAuto(); sendResponse({ ok: true, auto: false }); return true; }
    if (msg.type === "AUTO_STATE") { sendResponse({ ok: true, auto: autoOn }); return true; }
  });

  // lanjutkan auto kalau sebelumnya ON (kesimpan di storage)
  chrome.storage.local.get(["autoScan"]).then((d) => {
    if (d.autoScan) startAuto();
  }).catch(() => {});
})();
