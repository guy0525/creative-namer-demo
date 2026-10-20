"""无 API Key 时，用人工/Agent 写好的三层 JSON 走完整 analyze_asset 流程入库。

每条素材目录 showcase_work/NN/ 下：meta.json（local_cut.py 生成，含 asr）、k_XX.jpg、t_XX.jpg、thumb.jpg，
以及 fact.json / cognition.json / naming.json / judgment.json（缺失则该步返回空）。
用法: python3 tools/agent_analyze.py 01 02 ...   （已入库的会复用同一 asset，按文件名匹配）
"""
import base64
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

WORK = os.path.join(ROOT, "showcase_work")
CUR = {}


def data_url(p):
    return "data:image/jpeg;base64," + base64.b64encode(open(p, "rb").read()).decode()


def load(name):
    p = os.path.join(CUR["dir"], name + ".json")
    return json.load(open(p)) if os.path.exists(p) else {}


def fake_chat(s, messages):
    sysmsg = messages[0]["content"] if messages[0]["role"] == "system" else ""
    if "script supervisor" in sysmsg:
        return load("fact")
    if "creative strategist" in sysmsg:
        return load("cognition")
    if "name ad creatives" in sysmsg:
        return load("naming")
    if "performance analyst" in sysmsg:
        CUR["bench_prompt"] = messages[1]["content"][0]["text"]
        return load("judgment")
    return {}


def fake_transcribe(s, path):
    asr = CUR["meta"].get("asr") or {}
    segs = [x for x in asr.get("segments") or [] if x.get("text")]
    if not segs:
        return None
    return {"language": asr.get("language") or "", "text": " ".join(x["text"] for x in segs), "segments": segs,
            "engine": "faster-whisper small (local)"}


_get_settings = server.get_settings
server.get_settings = lambda c: dict(_get_settings(c), ai_api_key="agent-local")
server.ai_chat = fake_chat
server.transcribe = fake_transcribe


def ensure_asset(c, meta):
    fn = meta["filename"]
    row = c.execute("SELECT id FROM assets WHERE filename=? AND media_type='video' ORDER BY id DESC", (fn,)).fetchone()
    if row:
        return row[0]
    data = open(meta["source"], "rb").read()

    class H:
        def body(self):
            return data
    return server.r_upload(H(), c, {"filename": fn, "media_type": "video"})["id"]


def run(nn):
    d = os.path.join(WORK, nn)
    meta = json.load(open(os.path.join(d, "meta.json")))
    CUR.clear()
    CUR.update(dir=d, meta=meta)
    c = server.connect()
    aid = ensure_asset(c, meta)
    n = len(meta["clips"])
    frames = [data_url(os.path.join(d, "k_%02d.jpg" % i)) for i in range(1, n + 1)]
    clips = [dict(cl, thumb=data_url(os.path.join(d, "t_%02d.jpg" % i))) for i, cl in enumerate(meta["clips"], 1)]
    c.execute("UPDATE assets SET thumb=? WHERE id=?", (data_url(os.path.join(d, "thumb.jpg")), aid))
    c.commit()
    out = server.analyze_asset(c, aid, frames, {"clips": clips, "duration": meta["duration"]})
    if CUR.get("bench_prompt"):
        open(os.path.join(d, "bench_prompt.txt"), "w").write(CUR["bench_prompt"])
    u = json.loads(c.execute("SELECT ai_raw_json FROM assets WHERE id=?", (aid,)).fetchone()[0])["understanding"]
    b = u["judgment"].get("benchmark") or {}
    print(nn, "asset", aid, out.get("short_name"), "| bench est_roas", b.get("est_roas"), "tier", b.get("est_tier"),
          "avg", b.get("avg_roas"), "matches", [(m["label"], m["roas"], m["assets"]) for m in b.get("matches", [])])


if __name__ == "__main__":
    for nn in sys.argv[1:]:
        run(nn)
