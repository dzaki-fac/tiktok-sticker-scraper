"""Convert hasil download extension (.webp) -> .gif.
Menjaga animasi kalau sumbernya memang webp animasi.
Kalau sumbernya statis, hasilnya gif statis (tidak bisa jadi gerak).

Usage:
  pip install Pillow
  python webp_to_gif.py "C:/Users/xxx/Downloads/tiktok-stickers" -o gif-out
"""
import argparse
from pathlib import Path
from PIL import Image, ImageSequence

def webp_to_gif(src: Path, dst: Path):
    with Image.open(src) as im:
        if getattr(im, "is_animated", False):
            frames = [f.copy().convert("RGBA") for f in ImageSequence.Iterator(im)]
            durations = [f.info.get("duration", 80) for f in ImageSequence.Iterator(im)]
            # GIF max 256 warna -> quantize per frame (method=2 = Fast Octree, support RGBA)
            paletted = [f.quantize(colors=256, method=2) for f in frames]
            paletted[0].save(dst, "GIF", save_all=True, append_images=paletted[1:],
                             duration=durations, loop=0, disposal=2)
            return f"anim {len(frames)} frame"
        else:
            im.convert("RGBA").save(dst, "GIF")
            return "statis"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="folder hasil download extension")
    ap.add_argument("-o", "--out", default="gif-out")
    args = ap.parse_args()
    src, out = Path(args.src), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(src.glob("*.webp"))
    if not files:
        print(f"Tidak ada .webp di {src.resolve()}"); return
    for p in files:
        dst = out / (p.stem + ".gif")
        try:
            info = webp_to_gif(p, dst)
            print(f"OK {p.name} -> {dst.name} [{info}] ({dst.stat().st_size//1024}KB)")
        except Exception as e:
            print(f"FAIL {p.name}: {e}")
    print(f"\nSelesai -> {out.resolve()}")

if __name__ == "__main__":
    main()
