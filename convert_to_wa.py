"""Batch convert hasil download extension -> WhatsApp sticker pack compliant.
Syarat WA: WebP 512x512 exact, statis <=100KB, animasi <=500KB.

Usage:
  pip install Pillow
  python convert_to_wa.py "C:/Users/xxx/Downloads/tiktok-stickers" -o wa-pack
"""
import argparse
from pathlib import Path
from PIL import Image, ImageSequence

SIZE = 512
STATIC_LIMIT = 100 * 1024
ANIM_LIMIT = 500 * 1024

def fit_exact(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    img.thumbnail((SIZE - 32, SIZE - 32), Image.LANCZOS)  # 16px margin
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2))
    return canvas

def save_static(img: Image.Image, out: Path):
    base = fit_exact(img)
    for q in (80, 70, 60, 50, 40, 30):
        base.save(out, "WEBP", quality=q, method=6)
        if out.stat().st_size <= STATIC_LIMIT:
            return q
    raise ValueError(f"{out.name} masih >100KB setelah q=30")

def save_animated(img: Image.Image, out: Path):
    frames, durations = [], []
    for f in ImageSequence.Iterator(img):
        frames.append(fit_exact(f))
        durations.append(f.info.get("duration", 80))
    frames = frames[:30]  # jaga ukuran + durasi
    durations = durations[:30]
    for q in (60, 50, 40, 30):
        frames[0].save(out, "WEBP", save_all=True, append_images=frames[1:],
                       duration=durations, loop=0, quality=q, method=4, minimize_size=True)
        if out.stat().st_size <= ANIM_LIMIT:
            return q
    raise ValueError(f"{out.name} masih >500KB setelah q=30")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="folder hasil download extension")
    ap.add_argument("-o", "--out", default="wa-pack")
    args = ap.parse_args()
    src, out = Path(args.src), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ok, fail = 0, []
    for p in sorted(src.glob("*.webp")) + sorted(src.glob("*.png")) + sorted(src.glob("*.jpg")):
        dst = out / (p.stem + ".webp")
        try:
            with Image.open(p) as im:
                if getattr(im, "is_animated", False):
                    save_animated(im, dst)
                else:
                    save_static(im, dst)
            ok += 1
            print(f"OK {p.name} -> {dst.name} ({dst.stat().st_size//1024}KB)")
        except Exception as e:
            fail.append((p.name, str(e)))
            print(f"FAIL {p.name}: {e}")
    print(f"\nSelesai: {ok} ok, {len(fail)} gagal -> folder {out.resolve()}")
    print("Syarat pack: min 3, max 30 per pack, jangan campur statis+animasi.")

if __name__ == "__main__":
    main()
