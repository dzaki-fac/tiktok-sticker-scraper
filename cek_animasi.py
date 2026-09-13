"""Cek apakah .webp hasil download beneran animasi atau statis.
Usage: python cek_animasi.py "C:/Users/xxx/Downloads/tiktok-stickers"
"""
import sys
from pathlib import Path
from PIL import Image

folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
files = sorted(folder.glob("*.webp"))
if not files:
    print(f"Tidak ada .webp di {folder.resolve()}")
    sys.exit(1)
for p in files:
    try:
        with Image.open(p) as im:
            anim = bool(getattr(im, "is_animated", False))
            n = getattr(im, "n_frames", 1)
            print(f"{p.name}: animated={anim}, frames={n}, size={im.size}, bytes={p.stat().st_size//1024}KB")
    except Exception as e:
        print(f"{p.name}: ERROR {e}")
print("\nKalau frames=1 -> sumbernya memang statis (bukan salah player).")
print("Kalau frames>1 tapi diem -> player Windows yang tidak muter WebP animasi. Coba drag file ke Chrome.")
