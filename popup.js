let history = [];
let selected = new Set(); // src yang dicentang

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const histGrid = $("histGrid"), histCount = $("histCount");
const selAllEl = $("selAll"), selCountEl = $("selCount"), dlFmtEl = $("dlFmt");
const dlSelBtn = $("dlSel"), delSelBtn = $("delSel");

function setStatus(msg) { statusEl.textContent = msg || ""; }

// --- deteksi MP4 vs WebP (biar ekstensi file tersimpan benar) ---
function normItem(s) {
  if (typeof s === "string") return { src: s, kind: "" };
  return s;
}
function isMp4(s) {
  s = normItem(s);
  const src = s.src || "";
  if (s.kind === "video" || s.kind === "source") return true;
  if (/^data:video\//i.test(src)) return true;
  return /\.mp4(\?|#|$)/i.test(src) || /mime_type=video/i.test(src);
}
function getExt(s) {
  s = normItem(s);
  if (isMp4(s)) return "mp4";
  const src = s.src || "";
  if (/\.gif(\?|#|$)/i.test(src)) return "gif";
  if (/\.png(\?|#|$)/i.test(src)) return "png";
  if (/\.jpe?g(\?|#|$)/i.test(src)) return "jpg";
  if (/^data:video\//i.test(src)) return "mp4";
  return "webp";
}

function downloadUrl(url, filename) {
  chrome.downloads.download({ url, filename });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function mimeOfKind(kind) {
  return { webp: "image/webp", gif: "image/gif", png: "image/png", jpg: "image/jpeg" }[kind] || "application/octet-stream";
}

// Capture frame pertama <video> -> square 1:1 (padding, tanpa crop).
// -> Blob, atau null kalau gagal (mis. CORS bikin canvas tainted).
function captureVideoFrame(src, target) {
  return new Promise((resolve) => {
    const done = (blob) => {
      clearTimeout(timer);
      try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {}
      resolve(blob || null);
    };
    const timer = setTimeout(() => done(null), 15000);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.crossOrigin = "anonymous";
    const draw = () => {
      try {
        const S = Math.max(v.videoWidth, v.videoHeight);
        if (!(S > 0)) { done(null); return; }
        const c = document.createElement("canvas");
        c.width = S; c.height = S;
        const ctx = c.getContext("2d");
        if (target === "jpg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, S, S); }
        ctx.drawImage(v, (S - v.videoWidth) >> 1, (S - v.videoHeight) >> 1, v.videoWidth, v.videoHeight);
        if (target === "jpg") c.toBlob((b) => done(b), "image/jpeg", 0.92);
        else c.toBlob((b) => done(b), "image/webp", 0.95);
      } catch (_) { done(null); }
    };
    v.onloadeddata = () => {
      try {
        if (v.currentTime > 0.01) { v.onseeked = draw; v.currentTime = 0; }
        else draw();
      } catch (_) { done(null); }
    };
    v.onerror = () => done(null);
    v.src = src;
  });
}

// Video -> target: "webp"/"jpg" capture frame pertama (square),
// "mp4"/gagal-capture -> MP4 asli.
async function downloadVideoAs(s, i, target, prefix = "tiktok-stickers") {
  const fname = (e) => `${prefix}/sticker-${i + 1}.${e}`;
  const blob = await captureVideoFrame(s.src, target);
  if (blob) { downloadBlob(blob, fname(target)); return; }
  downloadUrl(s.src, fname("mp4"));
  setStatus("Capture frame video gagal, download MP4 aslinya.");
}

// Download raster (webp/gif/png/jpg) ATAU frame video sebagai target:
// "webp" | "jpg" — selalu square 1:1 (padding, tanpa crop).
async function downloadRaster(s, i, target, prefix = "tiktok-stickers") {
  s = normItem(s);
  const fname = (e) => `${prefix}/sticker-${i + 1}.${e}`;
  try {
    if (isMp4(s)) { await downloadVideoAs(s, i, target, prefix); return; }
    const res = await fetch(s.src, { mode: "cors" });
    if (!res.ok) throw new Error("fetch HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const kind = sniffExt(buf) || getExt(s);
    if (kind === "mp4") { await downloadVideoAs(s, i, target, prefix); return; }
    let blob = null;
    if (target === "jpg") {
      // JPG tak bisa animasi/transparan -> frame pertama, padding putih.
      blob = await padStaticRasterToSquare(buf, mimeOfKind(kind), "image/jpeg", 0.92, "#ffffff");
    } else if (kind === "webp") {
      if (webpIsAnimated(new Uint8Array(buf))) {
        const patched = patchAnimWebpToSquare(buf);
        if (!patched) throw new Error("animasi gagal di-1:1-kan");
        blob = new Blob([patched], { type: "image/webp" });
      } else {
        blob = await padStaticRasterToSquare(buf, "image/webp", "image/webp", 0.95);
      }
    } else if (kind === "gif") {
      // GIF animasi tak bisa di-encode jadi WebP di browser -> GIF 1:1.
      const patched = patchGifToSquare(buf);
      if (!patched) throw new Error("GIF gagal di-1:1-kan");
      downloadBlob(new Blob([patched], { type: "image/gif" }), fname("gif"));
      setStatus("GIF animasi tidak bisa jadi WebP di browser — download GIF 1:1.");
      return;
    } else if (kind === "png") {
      blob = await padStaticRasterToSquare(buf, "image/png", "image/webp", 0.95);
    } else {
      blob = await padStaticRasterToSquare(buf, "image/jpeg", "image/webp", 0.95);
    }
    if (blob) { downloadBlob(blob, fname(target)); return; }
    downloadUrl(s.src, fname(kind)); // null = sudah 1:1 dari sananya
  } catch (e) {
    downloadUrl(s.src, fname(getExt(s))); // fallback: file asli
    setStatus("1:1 gagal, download asli: " + ((e && e.message) || e));
  }
}

// --- pad 1:1 (tambah pixel, TANPA crop) ---
// Stiker TikTok sering landscape/portrait. Biar siap jadi stiker WA (1:1),
// semua yang didownload diganjal jadi square: WebP animasi & GIF di-patch
// level bytes (animasi utuh, tanpa re-encode), gambar statis via canvas.

function readU16LE(b, o) { return b[o] | (b[o + 1] << 8); }
function writeU16LE(b, o, v) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; }
function readU24LE(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
function writeU24LE(b, o, v) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; }
function fourCC(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

// Tebak tipe dari isi file (URL TikTok sering tanpa ekstensi, jadi
// jangan percaya URL saja — GIF tanpa ".gif" sedekahnya ke mana-mana).
function sniffExt(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 12 && fourCC(b, 0) === "RIFF" && fourCC(b, 8) === "WEBP") return "webp";
  if (b.length >= 6) {
    const h = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
    if (h === "GIF87a" || h === "GIF89a") return "gif";
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xD8) return "jpg";
  if (b.length >= 12 && fourCC(b, 4) === "ftyp") return "mp4"; // video MP4 nyasar
  return null;
}

function webpIsAnimated(u8) {
  for (let i = 0; i + 4 <= u8.length; i++) {
    if (u8[i] === 0x41 && u8[i + 1] === 0x4E && u8[i + 2] === 0x4D && u8[i + 3] === 0x46) return true; // "ANMF"
  }
  return false;
}

// Geser tiap frame ANMF ke tengah + lebarkan canvas VP8X jadi square.
// -> Uint8Array hasil patch, atau null kalau sudah square / bukan animasi / corrupt.
function patchAnimWebpToSquare(buf) {
  const b = new Uint8Array(buf).slice(); // salinan, bytes asli utuh
  if (b.length < 12 || fourCC(b, 0) !== "RIFF" || fourCC(b, 8) !== "WEBP") return null;
  const chunkSize = (off) => (b[off + 4] | (b[off + 5] << 8) | (b[off + 6] << 16) | (b[off + 7] << 24)) >>> 0;
  let vp8x = -1, W = 0, H = 0, off = 12;
  while (off + 8 <= b.length) { // pass 1: baca ukuran canvas dari VP8X
    const size = chunkSize(off);
    if (off + 8 + size > b.length) return null;
    if (fourCC(b, off) === "VP8X") { vp8x = off + 8; break; }
    off += 8 + size + (size & 1);
  }
  if (vp8x < 0 || vp8x + 10 > b.length) return null;
  W = readU24LE(b, vp8x + 4) + 1;
  H = readU24LE(b, vp8x + 7) + 1;
  if (!(W > 0 && H > 0) || W === H) return null;
  const S = Math.max(W, H), dx = (S - W) >> 1, dy = (S - H) >> 1;
  // Spek WebP: koordinat frame aktual = 2 * nilai tersimpan,
  // jadi nilai yang ditulis digeser setengah (sisa 1px kalau ganjil OK).
  let found = false;
  off = 12;
  while (off + 8 <= b.length) { // pass 2: geser tiap frame ke tengah
    const t = fourCC(b, off);
    const size = chunkSize(off);
    if (off + 8 + size > b.length) return null;
    if (t === "ANMF") {
      if (size < 16) return null;
      writeU24LE(b, off + 8, readU24LE(b, off + 8) + (dx >> 1));
      writeU24LE(b, off + 11, readU24LE(b, off + 11) + (dy >> 1));
      found = true;
    }
    off += 8 + size + (size & 1);
  }
  if (!found) return null;
  writeU24LE(b, vp8x + 4, S - 1);
  writeU24LE(b, vp8x + 7, S - 1);
  return b;
}

// Lebarkan Logical Screen GIF jadi square + geser tiap frame ke tengah.
// -> Uint8Array hasil patch, atau null kalau sudah square / corrupt.
function patchGifToSquare(buf) {
  const b = new Uint8Array(buf).slice(); // salinan, bytes asli utuh
  if (b.length < 13) return null;
  const hdr = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
  if (hdr !== "GIF87a" && hdr !== "GIF89a") return null;
  const W = readU16LE(b, 6), H = readU16LE(b, 8), packed = b[10];
  if (!(W > 0 && H > 0) || W === H) return null;
  const S = Math.max(W, H), dx = (S - W) >> 1, dy = (S - H) >> 1;
  let off = 13;
  if (packed & 0x80) off += 3 * (1 << ((packed & 0x07) + 1)); // skip GCT
  const skipSubs = () => { while (off < b.length) { const n = b[off++]; if (n === 0) break; off += n; } };
  let imgs = 0;
  while (off < b.length) {
    const sep = b[off++];
    if (sep === 0x3B) break; // trailer
    if (sep === 0x21) { // extension
      if (off >= b.length) return null;
      off++; // label
      skipSubs();
    } else if (sep === 0x2C) { // image descriptor
      if (off + 9 > b.length) return null;
      writeU16LE(b, off, readU16LE(b, off) + dx);
      writeU16LE(b, off + 2, readU16LE(b, off + 2) + dy);
      const ip = b[off + 8];
      off += 9;
      if (ip & 0x80) off += 3 * (1 << ((ip & 0x07) + 1)); // skip LCT
      if (off >= b.length) return null;
      off++; // LZW min code size
      skipSubs();
      imgs++;
    } else return null; // byte asing -> jangan diutak-atik
  }
  if (!imgs) return null;
  writeU16LE(b, 6, S);
  writeU16LE(b, 8, S);
  return b;
}

// Gambar statis -> canvas square, padding transparan (atau fillStyle, mis. jpg).
// -> Blob hasil, atau null kalau sudah square.
function padStaticRasterToSquare(buf, mime, outMime, quality, fillStyle) {
  return (async () => {
    const bmp = await createImageBitmap(new Blob([buf], { type: mime }));
    try {
      if (bmp.width === bmp.height) return null;
      const S = Math.max(bmp.width, bmp.height);
      const c = document.createElement("canvas");
      c.width = S; c.height = S;
      const ctx = c.getContext("2d");
      if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fillRect(0, 0, S, S); }
      ctx.drawImage(bmp, (S - bmp.width) >> 1, (S - bmp.height) >> 1);
      return await new Promise((res) => c.toBlob(res, outMime, quality));
    } finally { bmp.close(); }
  })();
}

async function downloadOne(s, i, prefix = "tiktok-stickers") {
  s = normItem(s);
  const ext = getExt(s);
  const fname = (e) => `${prefix}/sticker-${i + 1}.${e}`;
  // MP4 tidak bisa di-pad tanpa re-encode realtime -> download apa adanya.
  // (Pakai tombol →MP4 / webp_to_mp4.py yang outputnya sudah 1:1.)
  if (isMp4(s)) { downloadUrl(s.src, fname(ext)); return; }
  try {
    const res = await fetch(s.src, { mode: "cors" });
    if (!res.ok) throw new Error("fetch HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const kind = sniffExt(buf) || ext; // isi file lebih dipercaya dari URL
    if (kind === "mp4") { downloadUrl(s.src, fname("mp4")); return; } // video: langsung asli
    let blob = null, outExt = kind;
    if (kind === "webp") {
      if (webpIsAnimated(new Uint8Array(buf))) {
        const patched = patchAnimWebpToSquare(buf);
        if (!patched) throw new Error("animasi gagal di-1:1-kan");
        blob = new Blob([patched], { type: "image/webp" });
      } else {
        blob = await padStaticRasterToSquare(buf, "image/webp", "image/webp", 0.95);
      }
    } else if (kind === "gif") {
      const patched = patchGifToSquare(buf);
      if (!patched) throw new Error("GIF gagal di-1:1-kan");
      blob = new Blob([patched], { type: "image/gif" });
    } else if (kind === "png") {
      blob = await padStaticRasterToSquare(buf, "image/png", "image/png");
    } else { // jpg & lainnya: padding putih (tidak ada alpha)
      blob = await padStaticRasterToSquare(buf, "image/jpeg", "image/jpeg", 0.92, "#ffffff");
      outExt = "jpg";
    }
    if (blob) { // hasil square -> download blob
      downloadBlob(blob, fname(outExt));
      return;
    }
    downloadUrl(s.src, fname(outExt)); // null = sudah 1:1 dari sananya
  } catch (e) {
    downloadUrl(s.src, fname(ext)); // fallback: file asli, animasi tetap utuh
    setStatus("1:1 gagal, download asli: " + ((e && e.message) || e));
  }
}

// --- convert WebP -> video langsung di popup (best-effort) ---
// Browser yang render animasinya, jadi file aneh yang gagal di ffmpeg pun bisa.
function pickRecordMime() {
  const cands = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  for (const m of cands) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return "";
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("gagal baca hasil rekaman"));
    r.readAsDataURL(blob);
  });
}

async function convertWebpToMp4(s, i, btn, prefix = "tiktok-stickers-mp4") {
  s = normItem(s);
  const label = btn ? btn.textContent : "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Ambil…"; }
    const res = await fetch(s.src, { mode: "cors" });
    if (!res.ok) throw new Error("fetch gagal (HTTP " + res.status + ")");
    const buf = await res.arrayBuffer();
    const ctype = (res.headers.get("content-type") || "").split(";")[0] || "image/webp";

    // Decode SEMUA frame + durasinya via WebCodecs (akurat, tidak tergantung <img>).
    let frames = [];
    try {
      if (typeof ImageDecoder === "undefined") throw new Error("no ImageDecoder");
      const dec = new ImageDecoder({ data: buf, type: ctype });
      await dec.tracks.ready;
      const n = dec.tracks.selectedTrack.frameCount;
      for (let k = 0; k < n; k++) {
        const { image } = await dec.decode({ frameIndex: k });
        frames.push({ bmp: image, durMs: (image.duration || 120000) / 1000 });
      }
      dec.close();
    } catch (e) {
      throw new Error("tidak bisa decode animasi (" + ((e && e.message) || e) + ")");
    }
    if (!frames.length) throw new Error("tidak ada frame");

    const W0 = Math.max(2, ((frames[0].bmp.displayWidth || frames[0].bmp.codedWidth) & ~1));
    const H0 = Math.max(2, ((frames[0].bmp.displayHeight || frames[0].bmp.codedHeight) & ~1));
    // Square 1:1 (tambah pixel, tanpa crop): sisi = max, gambar di tengah.
    const S = Math.max(W0, H0), DX = (S - W0) / 2, DY = (S - H0) / 2;

    // Susun slot 30fps dari durasi asli, loop sampai ~3 detik.
    const FPS = 30;
    let oneLoop = [];
    frames.forEach((f) => {
      const rep = Math.max(1, Math.round(f.durMs / 1000 * FPS));
      for (let k = 0; k < rep; k++) oneLoop.push(f.bmp);
    });
    const need = FPS * 3;
    let slots = [];
    const isAnim = frames.length >= 2; // bedakan dari jumlah frame ASLI, bukan hasil repeat
    if (isAnim) {
      while (slots.length < need) slots = slots.concat(oneLoop);
      slots = slots.slice(0, Math.max(need, oneLoop.length));
    } else {
      slots = new Array(need).fill(oneLoop[0]); // sumber statis: video diem 3 detik
    }

    const canvas = document.createElement("canvas");
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext("2d");
    const mime = pickRecordMime();
    if (!mime) throw new Error("browser tidak support rekam video");
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const stream = canvas.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res, rej) => {
      rec.onstop = res;
      rec.onerror = (e) => rej(new Error("rekam gagal (" + ((e && e.error && e.error.name) || "unknown") + ")"));
    });
    if (btn) btn.textContent = "Rekam…";
    setStatus(isAnim
      ? `Merekam ${frames.length} frame (${(slots.length / FPS).toFixed(1)} dtk)…`
      : "Sumbernya statis (1 frame) — hasilnya video diem. Cari versi MP4-nya aja kalau mau gerak.");
    rec.start(250);
    for (const bmp of slots) {
      // MP4 (H.264) tidak support transparan — tanpa fill, area transparan jadi hitam.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, S, S);
      ctx.drawImage(bmp, DX, DY, W0, H0);
      await sleep(1000 / FPS);
    }
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    frames.forEach((f) => { try { f.bmp.close(); } catch (_) {} });
    if (!chunks.length) throw new Error("rekaman kosong");
    const dataUrl = await blobToDataUrl(new Blob(chunks, { type: mime.split(";")[0] }));
    await chrome.downloads.download({
      url: dataUrl,
      filename: `${prefix}/sticker-${i + 1}.${ext}`,
    });
    if (isAnim) {
      setStatus(ext === "mp4" ? "Tersimpan sebagai MP4." : "Browser ini cuma bisa rekam WebM. Untuk MP4 beneran, pakai webp_to_mp4.py.");
    }
  } catch (e) {
    setStatus("Convert gagal: " + ((e && e.message) || e) + " — download WebP lalu pakai webp_to_mp4.py.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || "→MP4"; }
  }
}

function card(s, i) {
  s = normItem(s);
  const mp4 = isMp4(s);
  const div = document.createElement("div");
  div.className = "card";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.className = "sel";
  chk.title = "Pilih stiker ini";
  chk.checked = selected.has(s.src);
  div.classList.toggle("sel", chk.checked);
  chk.onchange = () => {
    if (chk.checked) selected.add(s.src);
    else selected.delete(s.src);
    div.classList.toggle("sel", chk.checked);
    updateSelUI();
  };
  div.append(chk);
  let prev;
  if (mp4) {
    prev = document.createElement("video");
    prev.src = s.src;
    prev.autoplay = true; prev.loop = true; prev.muted = true; prev.playsInline = true;
  } else {
    prev = document.createElement("img");
    prev.src = s.src;
    prev.loading = "lazy";
  }
  // Klik stiker = centang juga.
  prev.style.cursor = "pointer";
  prev.title = "Klik untuk pilih";
  prev.onclick = () => chk.click();
  const row = document.createElement("div");
  row.className = "btnrow";  const bWebp = document.createElement("button");
  bWebp.textContent = "WebP";
  bWebp.title = "Download 1:1 sebagai WebP";
  bWebp.onclick = () => downloadRaster(s, i, "webp");
  const bMp4 = document.createElement("button");
  bMp4.textContent = "MP4";
  bMp4.title = mp4 ? "Download MP4 aslinya" : "Convert WebP ini jadi video langsung di sini (~3 detik)";
  bMp4.onclick = () => {
    if (mp4) downloadUrl(s.src, `tiktok-stickers/sticker-${i + 1}.mp4`);
    else convertWebpToMp4(s, i, bMp4);
  };
  const bJpg = document.createElement("button");
  bJpg.textContent = "JPG";
  bJpg.title = "Download 1:1 sebagai JPG (frame pertama, background putih)";
  bJpg.onclick = () => downloadRaster(s, i, "jpg");
  row.append(bWebp, bMp4, bJpg);
  div.append(prev, row);
  return div;
}

function renderHistory() {
  histGrid.innerHTML = "";
  histCount.textContent = history.length ? `${history.length} tersimpan total` : "History kosong. Scan dulu.";
  // Terbaru di atas, tanpa mengubah urutan simpan.
  [...history].reverse().forEach((s, i) => histGrid.appendChild(card(s, i)));
  updateSelUI();
}

// --- pilih beberapa (centang) ---
function updateSelUI() {
  const n = selected.size;
  selCountEl.textContent = n ? `${n} dipilih` : "";
  dlSelBtn.textContent = n ? `Download (${n})` : "Download";
  delSelBtn.textContent = n ? `Hapus (${n})` : "Hapus";
  dlSelBtn.disabled = !n;
  delSelBtn.disabled = !n;
  selAllEl.checked = history.length > 0 && n === history.length;
}

// --- history (persist, dedup by src) ---
async function loadHistory() {
  const data = await chrome.storage.local.get("stickerHistory");
  history = Array.isArray(data.stickerHistory) ? data.stickerHistory : [];
  renderHistory();
}

async function mergeIntoHistory(list, pageUrl) {
  if (!list.length) return 0;
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
    history.push({ src: s.src, width: s.width, height: s.height, kind: s.kind || "", firstSeen: now, lastSeen: now, count: 1, page: pageUrl || "" });
    added++;
  }
  await chrome.storage.local.set({ stickerHistory: history });
  renderHistory();
  return added;
}

// --- scan ---
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (_) { /* sudah ter-inject, abaikan */ }
}

async function scan() {
  setStatus("");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });  if (!tab || tab.id == null) { setStatus("Tidak ada tab aktif."); return; }
  if (!/^https:\/\/(www\.)?tiktok\.com\//.test(tab.url || "")) {
    setStatus("Buka tiktok.com/messages dulu.");
    return;
  }
  await ensureContentScript(tab.id);
  chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_VISIBLE_STICKERS" }, async (res) => {
    if (chrome.runtime.lastError) { setStatus(chrome.runtime.lastError.message); return; }
    if (!res || !res.ok) { setStatus((res && res.error) || "Gagal scrape."); return; }
    const list = res.stickers || [];
    const added = await mergeIntoHistory(list, res.url);
    if (list.length) setStatus(added ? `${added} baru masuk History (paling atas).` : "Sudah semua ada di History.");
    else setStatus("Tidak ada stiker terlihat. Scroll lalu Scan lagi.");
  });
}

$("scan").onclick = scan;
selAllEl.onchange = (e) => {
  if (e.target.checked) history.forEach((h) => selected.add(h.src));
  else selected.clear();
  renderHistory();
};

dlSelBtn.onclick = () => {
  const list = [];
  [...history].reverse().forEach((s, i) => { if (selected.has(s.src)) list.push([s, i]); });
  if (!list.length) { setStatus("Pilih dulu stikernya (centang)."); return; }
  const fmt = dlFmtEl.value; // webp | mp4 | jpg
  const prefix = "tiktok-stickers/history";
  setStatus(`Menyiapkan ${list.length} stiker ${fmt.toUpperCase()} 1:1…`);
  if (fmt === "mp4") {
    // Convert rekam realtime -> jalan berurutan biar tidak berat.
    (async () => {
      for (const [s, i] of list) {
        if (isMp4(s)) downloadUrl(s.src, `${prefix}/sticker-${i + 1}.mp4`);
        else await convertWebpToMp4(s, i, null, prefix);
      }
    })();
  } else {
    // i = nomor urut tampil, sama seperti nama file sticker-N.
    list.forEach(([s, i]) => downloadRaster(s, i, fmt, prefix));
  }
};

delSelBtn.onclick = async () => {
  if (!selected.size) { setStatus("Pilih dulu stikernya (centang)."); return; }
  history = history.filter((h) => !selected.has(h.src));
  selected.clear();
  await chrome.storage.local.set({ stickerHistory: history });
  renderHistory();
  setStatus("Yang dipilih dihapus.");
};

// --- auto toggle ---
async function refreshAutoCheckbox() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(["autoScan"]);
  $("auto").checked = !!stored.autoScan;
  if (!tab || tab.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "AUTO_STATE" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    // kalau content bilang ON tapi storage OFF (misal habis reload), samakan
    if (res.auto !== $("auto").checked) $("auto").checked = res.auto;
  });
}

$("auto").onchange = async (e) => {
  const on = e.target.checked;
  await chrome.storage.local.set({ autoScan: on });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  await ensureContentScript(tab.id);
  chrome.tabs.sendMessage(tab.id, { type: on ? "AUTO_START" : "AUTO_STOP" }, () => {
    setStatus(on ? "Auto-scan ON: scroll aja, History nambah sendiri." : "Auto-scan OFF.");
    if (on) loadHistory();
  });
};

// refresh history tiap popup dibuka (hasil auto-scan terbaru)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stickerHistory) {
    history = changes.stickerHistory.newValue || [];
    renderHistory();
  }
});

loadHistory().then(async () => { await refreshAutoCheckbox(); scan(); });
