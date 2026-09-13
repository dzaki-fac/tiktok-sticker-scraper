"""Convert .webp/.gif hasil download extension -> .mp4 (H.264, yuv420p, faststart).

Kenapa tidak `ffmpeg -i in.webp out.mp4` langsung?
  Decoder webp bawaan ffmpeg gagal pada webp animasi TikTok
  ("image data not found"). Script ini decode frame via Pillow
  (mesin libwebp yang sama dengan Chrome, jadi selalu bisa dibuka)
  lalu pipe raw frames ke ffmpeg untuk di-encode jadi MP4.

- WebP/GIF animasi -> MP4 dengan durasi asli per frame
  (duration 0/durasi hilang, yang umum di stiker TikTok, dianggap 120ms),
  lalu loop-nya diulang sampai total >= --min-dur (default 2.0 detik)
  supaya videonya tidak cuma kedip 0.1 detik.
- Gambar statis -> MP4 sepanjang --hold detik (default 3.0).
- Transparansi di-flatten ke background putih (H.264 tidak support alpha).
- Output selalu SQUARE 1:1 (tambah pixel putih, tanpa crop).

Butuh: pip install Pillow + ffmpeg terinstall.

Usage:
  python webp_to_mp4.py "C:/Users/xxx/Downloads/tiktok-stickers/history" -o mp4-out
  python webp_to_mp4.py folder -o mp4-out --hold 2 --fps 30 --crf 20 --bg white
"""
import argparse
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageSequence

DEFAULT_FRAME_MS = 120  # fallback kalau duration frame 0 / hilang


def check_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise SystemExit("ffmpeg tidak ketemu di PATH. Install dulu (mis. choco install ffmpeg).")
    return exe


def load_frames(src: Path):
    """-> (frames RGB, durs_ms, size). Frames di-pad jadi SQUARE 1:1
    (tambah pixel, tanpa crop) lalu di-flatten ke RGB."""
    with Image.open(src) as im:
        w, h = im.size
        w -= w % 2
        h -= h % 2  # H.264 yuv420p butuh dimensi genap
        s = max(w, h)  # sisi square (tetap genap karena w & h genap)
        dx, dy = (s - w) // 2, (s - h) // 2
        frames, durs = [], []
        for f in ImageSequence.Iterator(im):
            fr = f.convert("RGBA")
            if (fr.width, fr.height) != (w, h):
                fr = fr.resize((w, h), Image.LANCZOS)
            sq = Image.new("RGBA", (s, s), (0, 0, 0, 0))
            sq.alpha_composite(fr, (dx, dy))
            bg = Image.new("RGBA", (s, s), (255, 255, 255, 255))
            flat = Image.alpha_composite(bg, sq).convert("RGB")
            frames.append(flat)
            d = f.info.get("duration", 0) or 0
            durs.append(d if d > 0 else DEFAULT_FRAME_MS)
        animated = getattr(im, "is_animated", False) and len(frames) > 1
        return frames, durs, (s, s), animated


def webp_to_mp4(ffmpeg: str, src: Path, dst: Path, fps: int, hold: float,
                 crf: int, min_dur: float):
    frames, durs, (w, h), animated = load_frames(src)
    if animated:
        repeats = [max(1, round(d / 1000 * fps)) for d in durs]
    else:
        repeats = [max(1, round(hold * fps))]
    total = sum(repeats)
    loops = 1
    if animated and min_dur > 0:
        # loop pendek (mis. 3 frame @40ms = 0.12s) diulang biar jadi video wajar
        loops = min(50, max(1, -(-int(min_dur * fps) // total)))  # ceil div
    total *= loops
    cmd = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
        "-framerate", str(fps), "-i", "-",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", str(crf), "-preset", "veryfast",
        "-movflags", "+faststart",
        str(dst),
    ]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(loops):
            for fr, rep in zip(frames, repeats):
                raw = fr.tobytes()
                for _ in range(rep):
                    p.stdin.write(raw)
        p.stdin.close()
    except BrokenPipeError:
        pass
    err = p.stderr.read().decode("utf-8", "replace")
    rc = p.wait()
    if rc != 0 or not dst.exists() or dst.stat().st_size == 0:
        raise RuntimeError(f"ffmpeg gagal (rc={rc}): {err.strip()[-500:]}")
    kind = f"anim {len(frames)} frame x{loops} loop" if animated else "statis"
    return f"{kind} -> {total / fps:.2f}s"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="folder hasil download extension")
    ap.add_argument("-o", "--out", default="mp4-out")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--hold", type=float, default=3.0,
                    help="durasi detik untuk gambar statis")
    ap.add_argument("--min-dur", type=float, default=2.0,
                    help="animasi pendek di-loop sampai total minimal sekian detik (0 = tanpa loop)")
    ap.add_argument("--crf", type=int, default=20, help="kualitas (kecil = bagus)")
    args = ap.parse_args()

    ffmpeg = check_ffmpeg()
    src, out = Path(args.src), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = [p for ext in ("*.webp", "*.gif", "*.png", "*.jpg", "*.jpeg")
             for p in sorted(src.glob(ext))]
    if not files:
        print(f"Tidak ada gambar di {src.resolve()}")
        return
    ok, fail = 0, []
    for p in files:
        dst = out / (p.stem + ".mp4")
        try:
            info = webp_to_mp4(ffmpeg, p, dst, args.fps, args.hold, args.crf, args.min_dur)
            print(f"OK {p.name} -> {dst.name} [{info}] ({dst.stat().st_size // 1024}KB)")
            ok += 1
        except Exception as e:
            fail.append((p.name, str(e)))
            print(f"FAIL {p.name}: {e}")
    print(f"\nSelesai: {ok} ok, {len(fail)} gagal -> folder {out.resolve()}")


if __name__ == "__main__":
    main()
