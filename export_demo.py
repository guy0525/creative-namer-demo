"""导出可部署到 GitHub Pages 的静态演示站：用全新的演示库生成全部只读接口数据。

用法：python3 export_demo.py [输出目录，默认 ./docs]
"""
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "docs"))
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
    meth = os.path.join(HERE, "methodology-efd7.md")
    if os.path.isfile(meth):
        shutil.copy(meth, os.path.join(OUT, "methodology-efd7.md"))
    c.close()
    shutil.rmtree(TMP, ignore_errors=True)
    print("已导出 %d 个数据文件到 %s" % (n, OUT))


if __name__ == "__main__":
    main()
