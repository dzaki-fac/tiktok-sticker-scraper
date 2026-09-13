"""Inspect durasi + beda antar frame webp animasi.
Usage: python inspect_frames.py "C:/path/ke/file.webp" -o frame-out
"""
import argparse
from pathlib import Path
from PIL import Image, ImageSequence, ImageChops

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("-o", "--out", default="frame-out")
args = ap.parse_args()
src, out = Path(args.src), Path(args.out)
out.mkdir(parents=True, exist_ok=True)

with Image.open(src) as im:
    print(f"animated={getattr(im,'is_animated',False)}, frames={getattr(im,'n_frames',1)}, loop={im.info.get('loop')}, size={im.size}")
    prev = None
    for i, f in enumerate(ImageSequence.Iterator(im)):
        dur = f.info.get("duration", "NA")
        fr = f.convert("RGBA")
        fr.save(out / f"frame-{i}.png")
        if prev is not None:
            diff = ImageChops.difference(prev, fr).getbbox()
            print(f"frame {i}: duration={dur}ms, beda_vs_sebelumnya={'YA '+str(diff) if diff else 'TIDAK (duplikat)'}")
        else:
            print(f"frame {i}: duration={dur}ms (pertama)")
        prev = fr
print(f"\nFrame tersimpan di {out.resolve()}")
print("Kalau semua 'TIDAK (duplikat)' -> file memang diem, animasinya palsu.")
print("Kalau duration=0 -> WA anggap statis. Fix: save ulang dengan duration 200ms/frame.")
