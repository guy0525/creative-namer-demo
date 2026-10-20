"""本地切镜 + 抽关键帧（与前端 detectCuts/buildClips 同一算法），供无 API Key 时人工/Agent 分析使用。

用法: .venv_tools/bin/python tools/local_cut.py showcase_input/*.mp4
输出: showcase_work/<序号>/{meta.json, k_XX.jpg, t_XX.jpg, thumb.jpg, sheet.jpg}
"""
import json
import math
import os
import re
import subprocess
import sys

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw

FF = imageio_ffmpeg.get_ffmpeg_exe()
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "showcase_work")


def probe(path):
    r = subprocess.run([FF, "-i", path], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    v = re.search(r"Video: .*?, (\d{2,5})x(\d{2,5})", r.stderr)
    return dur, (int(v.group(1)), int(v.group(2))) if v else (0, 0), "Audio:" in r.stderr


def sample_sigs(path, step):
    w, h = 48, 27
    cmd = [FF, "-v", "error", "-i", path, "-vf", f"fps={1 / step},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // (w * h * 3)
    arr = np.frombuffer(raw[: n * w * h * 3], dtype=np.uint8).reshape(n, w * h, 3).astype(np.float32)
    return arr


def sig_diff(a, b):
    p = np.abs(a - b).sum() / (a.size * 255)
    ha = np.concatenate([np.bincount((a[:, c] // 16).astype(int), minlength=16) for c in range(3)])
    hb = np.concatenate([np.bincount((b[:, c] // 16).astype(int), minlength=16) for c in range(3)])
    return 0.5 * p + 0.5 * np.abs(ha - hb).sum() / (a.shape[0] * 6)


def detect_cuts(path, duration):
    step = max(0.2, min(duration, 180) / 160)
    sigs = sample_sigs(path, step)
    ds = [(i * step, sig_diff(sigs[i - 1], sigs[i])) for i in range(1, len(sigs))]
    vals = sorted(d for _, d in ds)
    med = vals[len(vals) // 2] if vals else 0
    thr = max(0.12, med * 4)
    cuts = []
    for i, (t, d) in enumerate(ds):
        lo = ds[i - 1][1] if i > 0 else 0
        hi = ds[i + 1][1] if i + 1 < len(ds) else 0
        if d > thr and d >= lo and d >= hi and t - (cuts[-1] if cuts else 0) >= 0.45 and t < duration - 0.1:
            cuts.append(round(t, 2))
    drift, soft, b = max(0.15, med * 2.5), [], [0] + cuts + [duration]
    for st, en in zip(b, b[1:]):
        ia = round(st / step)
        i = ia + 1
        while i < len(sigs) and i * step < en - 0.6:
            if (i - ia) * step >= 1 and sig_diff(sigs[ia], sigs[i]) > drift:
                soft.append(round(i * step, 2))
                ia = i
            i += 1
    return cuts, soft


def build_clips(cuts, soft, duration):
    b = [0] + cuts + [duration]
    clips = []
    for i in range(len(b) - 1):
        st, en = b[i], b[i + 1]
        subs = [st] + [t for t in soft if st < t < en] + [en]
        if len(subs) > 2:
            clips += [{"start": round(subs[k], 2), "end": round(subs[k + 1], 2), "cont": k > 0} for k in range(len(subs) - 1)]
            continue
        parts = max(1, math.ceil((en - st) / 5))
        for k in range(parts):
            clips.append({"start": round(st + (en - st) * k / parts, 2), "end": round(st + (en - st) * (k + 1) / parts, 2), "cont": k > 0})
    while len(clips) > 40:
        span = lambda i: clips[i]["end"] - clips[i]["start"] + clips[i + 1]["end"] - clips[i + 1]["start"]
        mi = min(range(len(clips) - 1), key=span)
        clips[mi: mi + 2] = [{"start": clips[mi]["start"], "end": clips[mi + 1]["end"], "cont": clips[mi]["cont"]}]
    return clips


def grab(path, t, width, out, q=4):
    subprocess.run([FF, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1",
                    "-vf", f"scale='min({width},iw)':-2", "-q:v", str(q), out], check=True)


def sheet(files, labels, out, cols=4, w=300):
    ims = [Image.open(f).convert("RGB") for f in files]
    ims = [im.resize((w, int(im.height * w / im.width))) for im in ims]
    h = max(im.height for im in ims) + 22
    rows = math.ceil(len(ims) / cols)
    S = Image.new("RGB", (cols * w, rows * h), "white")
    d = ImageDraw.Draw(S)
    for i, im in enumerate(ims):
        x, y = (i % cols) * w, (i // cols) * h
        S.paste(im, (x, y + 22))
        d.text((x + 4, y + 4), labels[i], fill="black")
    S.save(out, quality=85)


def main(paths):
    os.makedirs(OUT, exist_ok=True)
    for idx, path in enumerate(sorted(paths), 1):
        dur, (vw, vh), audio = probe(path)
        cuts, soft = detect_cuts(path, dur)
        clips = build_clips(cuts, soft, dur)
        d = os.path.join(OUT, f"{idx:02d}")
        os.makedirs(d, exist_ok=True)
        big = 448 if len(clips) > 16 else 640
        ks = []
        for i, c in enumerate(clips, 1):
            t = min(dur - 0.05, (c["start"] + c["end"]) / 2)
            k, th = os.path.join(d, f"k_{i:02d}.jpg"), os.path.join(d, f"t_{i:02d}.jpg")
            grab(path, t, big, k)
            grab(path, t, 200, th, 6)
            ks.append(k)
        grab(path, min(0.1, dur / 2), 320, os.path.join(d, "thumb.jpg"))
        sheet(ks, [f"#{i} {c['start']:.1f}-{c['end']:.1f}s{' (cont)' if c['cont'] else ''}" for i, c in enumerate(clips, 1)],
              os.path.join(d, "sheet.jpg"))
        meta = {"source": os.path.abspath(path), "filename": os.path.basename(path), "duration": round(dur, 2),
                "size": [vw, vh], "has_audio": audio, "cuts": cuts, "soft": soft, "clips": clips}
        json.dump(meta, open(os.path.join(d, "meta.json"), "w"), ensure_ascii=False, indent=1)
        print(f"{idx:02d} {os.path.basename(path)}  {dur:.1f}s {vw}x{vh} audio={audio}  cuts={len(cuts)} clips={len(clips)}")


if __name__ == "__main__":
    main(sys.argv[1:])
