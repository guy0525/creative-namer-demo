"""导出可部署到 GitHub Pages 的静态演示站：用全新的演示库生成全部只读接口数据。

用法：
  python3 export_demo.py [输出目录，默认 ./docs]
  python3 export_demo.py --showcase 12,15,VISM3A   从本地 data/app.db 选素材（id 或短名称）作为「真实案例」一起导出
  python3 export_demo.py --showcase none            清空真实案例
可选：--hide-metrics   不导出判断层里的账户历史投放数字（消耗 / ROAS 基准）
      --max-video-mb N 超过 N MB 的视频只导出缩略图（默认 40）
真实案例的选择保存在 showcase.json，之后直接运行 export_demo.py 会沿用。
"""
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[1:]


def take_opt(name, has_value=True):
    if name not in ARGS:
        return None
    i = ARGS.index(name)
    val = ARGS[i + 1] if has_value and i + 1 < len(ARGS) else True
    del ARGS[i: i + (2 if has_value else 1)]
    return val


SHOWCASE_ARG = take_opt("--showcase")
HIDE_METRICS = bool(take_opt("--hide-metrics", False))
MAX_VIDEO_MB = float(take_opt("--max-video-mb") or 40)
OUT = os.path.abspath(ARGS[0] if ARGS else os.path.join(HERE, "docs"))
REAL_DB = os.environ.get("SHOWCASE_DB") or os.path.join(HERE, "data", "app.db")
SHOWCASE_FILE = os.path.join(HERE, "showcase.json")
SHOWCASE_ID_BASE = 100000
TMP = tempfile.mkdtemp(prefix="cn_demo_")
os.environ["DB_PATH"] = os.path.join(TMP, "demo.db")
sys.path.insert(0, HERE)

import server  # noqa: E402

server.READONLY = True


def key_file(path, q):
    ps = sorted((k, v) for k, v in q.items() if v != "")
    key = path + ("?" + "&".join("%s=%s" % kv for kv in ps) if ps else "")
    return re.sub(r"^_|_$", "", re.sub(r"[^A-Za-z0-9]+", "_", key)) + ".json"


def call(c, path, q=None):
    q = q or {}
    for m, pat, fn in server.ROUTES:
        mm = re.fullmatch(pat, path) if m == "GET" else None
        if mm:
            return fn(None, c, q, *mm.groups())
    raise KeyError(path)


def showcase_selection():
    if SHOWCASE_ARG is not None:
        keys = [] if str(SHOWCASE_ARG).lower() == "none" else [x.strip() for x in str(SHOWCASE_ARG).split(",") if x.strip()]
        with open(SHOWCASE_FILE, "w", encoding="utf-8") as fp:
            json.dump(keys, fp, ensure_ascii=False)
        return keys
    if os.path.isfile(SHOWCASE_FILE):
        with open(SHOWCASE_FILE, encoding="utf-8") as fp:
            return json.load(fp)
    return []


def export_showcase(keys):
    """从本地真实库导出选中的素材（含视频、三层理解、命名），返回列表行。"""
    if not keys:
        return []
    if not os.path.isfile(REAL_DB):
        sys.exit("找不到本地数据库 %s，请先启动 server.py 上传并分析素材" % REAL_DB)
    rc = sqlite3.connect(REAL_DB)
    rc.row_factory = sqlite3.Row
    os.makedirs(os.path.join(OUT, "media"), exist_ok=True)
    rows = []
    for k in keys:
        r = rc.execute("SELECT id FROM assets WHERE id=? OR short_name=?", (int(k) if str(k).isdigit() else -1, k)).fetchone()
        if not r:
            sys.exit("本地库中找不到素材：%s（可填素材 id 或短名称）" % k)
        a = server.get_asset(rc, r["id"])
        u = a.get("understanding")
        if not u or not u.get("fact") or u.get("legacy"):
            sys.exit("素材 %s 还没有三层理解结果，请在本地点「AI 重新识别」后再导出" % k)
        if HIDE_METRICS and u.get("judgment"):
            u["judgment"].pop("benchmark", None)
        nid = SHOWCASE_ID_BASE + a["id"]
        src, a["file_path"] = a.get("file_path"), ""
        if src and os.path.isfile(src):
            mb = os.path.getsize(src) / 1048576
            if a["media_type"] != "video" or mb <= MAX_VIDEO_MB:
                ext = os.path.splitext(src)[1].lower() or ".mp4"
                shutil.copy(src, os.path.join(OUT, "media", "%d%s" % (nid, ext)))
                a["file_path"] = "media/%d%s" % (nid, ext)
            else:
                print("  %s 视频 %.0fMB 超过 %.0fMB，只导出缩略图" % (a["short_name"], mb, MAX_VIDEO_MB))
        a.update(id=nid, showcase=True, ai_raw={"understanding": u}, understanding=u)
        with open(os.path.join(OUT, "data", key_file("/api/assets/%d" % nid, {})), "w", encoding="utf-8") as fp:
            json.dump(a, fp, ensure_ascii=False, separators=(",", ":"))
        light = {k2: v for k2, v in a.items() if k2 not in ("ai_raw", "understanding")}
        pred = (u.get("judgment") or {}).get("prediction") or {}
        light["card"] = {"one_liner": u.get("one_liner") or "", "clips": len(u["fact"].get("clips") or []),
                         "tier": pred.get("spend_tier"), "roas_low": pred.get("roas_low"), "roas_high": pred.get("roas_high")}
        rows.append(light)
        print("  真实案例：%s（%d 个分镜）" % (a["short_name"], light["card"]["clips"]))
    rc.close()
    return rows


def main():
    server.init_db()
    c = server.connect()
    server.seed_demo(c)
    c.commit()

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "data"))
    n = 0

    def dump(path, q=None):
        nonlocal n
        res = call(c, path, q)
        with open(os.path.join(OUT, "data", key_file(path, q or {})), "w", encoding="utf-8") as fp:
            json.dump(res, fp, ensure_ascii=False, separators=(",", ":"))
        n += 1
        return res

    dump("/api/state")
    dump("/api/products")
    dump("/api/spec/export")
    for a in dump("/api/assets"):
        dump("/api/assets/%d" % a["id"])
    showcase = export_showcase(showcase_selection())
    with open(os.path.join(OUT, "data", key_file("/api/showcase", {})), "w", encoding="utf-8") as fp:
        json.dump(showcase, fp, ensure_ascii=False, separators=(",", ":"))
    if showcase:
        with open(os.path.join(OUT, "data", key_file("/api/assets", {})), encoding="utf-8") as fp:
            lst = json.load(fp)
        with open(os.path.join(OUT, "data", key_file("/api/assets", {})), "w", encoding="utf-8") as fp:
            json.dump(showcase + lst, fp, ensure_ascii=False, separators=(",", ":"))
    dump("/api/analytics")
    for lp in dump("/api/analytics/lp")["lps"]:
        dump("/api/analytics/lp/detail", {"lp": lp["lp"]})
    for p in dump("/api/analytics/spu")["products"]:
        dump("/api/analytics/spu/detail", {"id": str(p["product_id"])})

    st = call(c, "/api/state")
    prods = call(c, "/api/products")
    values = {}
    for f in st["fields"]:
        v = f["values"][0] if f.get("values") else None
        if f["type"] == "product":
            values[f["key"]] = {"spu": prods[0]["spu"] if prods else "FI-20250489"}
        elif f["type"] == "enum" and v:
            values[f["key"]] = {"value_id": v["id"], "cn": v["cn"], "en": v["en"], "code": v["code"]}
        elif f["type"] == "date":
            values[f["key"]] = {"date": "260101"}
        elif f["type"] == "version":
            values[f["key"]] = {"n": 1}
        elif f["type"] == "text":
            values[f["key"]] = {"text": "Demo"}
    tags = [{"category": "人物", "cn": "女性", "en": "Female"}, {"category": "主色调", "cn": "黑色", "en": "Black"}]
    full, short = server.names_for(c, server.get_settings(c), server.load_fields(c), {"id": 0, "seq": 1}, values, tags)
    with open(os.path.join(OUT, "data", "spec_example.json"), "w", encoding="utf-8") as fp:
        json.dump({"full_name": full, "short_name": short, "duplicates": []}, fp, ensure_ascii=False)

    for name in os.listdir(server.STATIC):
        if name != "index.html":
            shutil.copy(os.path.join(server.STATIC, name), OUT)
    with open(os.path.join(server.STATIC, "index.html"), encoding="utf-8") as fp:
        html = fp.read()
    html = html.replace('href="/style.css"', 'href="style.css"').replace(
        '<script src="/app.js"></script>', '<script>window.STATIC_DEMO = 1;</script>\n  <script src="app.js"></script>')
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as fp:
        fp.write(html)
    open(os.path.join(OUT, ".nojekyll"), "w").close()
    meth = os.path.join(HERE, "methodology.md")
    if os.path.isfile(meth):
        shutil.copy(meth, os.path.join(OUT, "methodology.md"))
    c.close()
    shutil.rmtree(TMP, ignore_errors=True)
    print("已导出 %d 个数据文件到 %s" % (n, OUT))


if __name__ == "__main__":
    main()
