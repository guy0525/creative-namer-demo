#!/usr/bin/env python3
"""创意洞察 - 本地服务（仅依赖 Python 3 标准库）"""
import base64
import csv
import datetime
import io
import json
import mimetypes
import os
import random
import re
import shutil
import sqlite3
import subprocess
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
UPLOADS = os.path.join(DATA, "uploads")
STATIC = os.path.join(BASE, "static")
DB_PATH = os.environ.get("DB_PATH", os.path.join(DATA, "app.db"))
PORT = int(os.environ.get("PORT", "8818"))
READONLY = os.environ.get("READONLY") == "1"
READONLY_ALLOW = ("/api/decode", "/api/names/preview")

SECRET_KEYS = ("ai_api_key", "meta_token")

DEFAULT_SETTINGS = {
    "separator": "_",
    "name_lang": "en",
    "code_width": "2",
    "ai_tags_in_name": "1",
    "ai_tags_max": "3",
    "ai_tag_joiner": "+",
    "ai_base_url": "https://api.openai.com/v1",
    "ai_model": "gpt-4o-mini",
    "ai_api_key": "",
    "meta_api_version": "v21.0",
    "meta_token": "",
    "meta_catalog_id": "",
    "meta_ad_account": "",
    "shopify_domain": "",
    "default_designer": "",
    "currency": "USD",
    "seq_counter": "0",
}

DEFAULT_SPEC = [
    {"key": "spu", "name_cn": "SPU", "name_en": "SPU", "type": "product", "in_short": 0,
     "description": "商品款号，来自商品库", "values": []},
    {"key": "material_type", "name_cn": "素材类型", "name_en": "Type", "type": "enum", "in_short": 1,
     "description": "素材文件类型", "values": [
         ("图片", "IMG", "IM"), ("视频", "VID", "VI"), ("GIF", "GIF", "GF")]},
    {"key": "expression", "name_cn": "表达方式", "name_en": "Expression", "type": "enum", "in_short": 1,
     "description": "素材拍摄/制作方式：模拍=有模特出镜，纯产品=无模特只拍产品，AI=AI生成，混剪=多素材剪辑", "values": [
         ("实拍模拍", "Shoot-MP", "SM"), ("AI模拍", "AI-MP", "AM"), ("实拍纯产品", "Shoot-PD", "SP"),
         ("AI纯产品", "AI-PD", "AP"), ("混剪", "Remix", "RX")]},
    {"key": "selling_point", "name_cn": "主卖点", "name_en": "SellingPoint", "type": "enum", "in_short": 1,
     "description": "素材主要传达的产品卖点", "values": [
         ("柔软", "Soft", "SO"), ("透气", "Breathable", "BR"), ("冰感", "Cooling", "CO"), ("弹力", "Stretch", "ST"),
         ("高级感", "Premium", "PR"), ("抗皱", "WrinkleFree", "WF")]},
    {"key": "scene", "name_cn": "场景", "name_en": "Scene", "type": "enum", "in_short": 1,
     "description": "素材拍摄或呈现的场景", "values": [
         ("外景", "Outdoor", "OD"), ("棚拍", "Studio", "SD"), ("室内搭景", "Indoor", "ID"), ("通勤", "Commute", "CM"),
         ("咖啡厅", "Cafe", "CF"), ("家居", "Home", "HM"), ("街拍", "Street", "SR"), ("商务", "Business", "BS"),
         ("健身", "Gym", "GY"), ("度假", "Resort", "RS")]},
    {"key": "designer", "name_cn": "设计师", "name_en": "Designer", "type": "enum", "in_short": 0,
     "description": "素材制作人", "values": [("浩贤", "HX", "HX")]},
    {"key": "date", "name_cn": "日期", "name_en": "Date", "type": "date", "in_short": 1,
     "description": "制作日期 YYMMDD", "values": []},
    {"key": "version", "name_cn": "版本", "name_en": "Version", "type": "version", "in_short": 1,
     "description": "同一脚本70%类似表达为同一个模版，用版本号区分", "values": []},
    {"key": "ai_tags", "name_cn": "AI标签", "name_en": "AITags", "type": "ai_tags", "in_short": 0,
     "description": "AI 识别出的知识库以外的补充标签", "values": []},
]

FIELD_TYPES = ("enum", "text", "product", "date", "version", "ai_tags")
SHORT_TYPES = ("enum", "date", "version", "text")
DATE_WIDTH = 6
VERSION_WIDTH = 2
DUP_SUFFIX = "ABCDEFGHJKLMNPQRSTUWXYZ"


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


# ---------------------------------------------------------------- db

def connect():
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    os.makedirs(UPLOADS, exist_ok=True)
    c = connect()
    c.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS fields (
        id INTEGER PRIMARY KEY, key TEXT UNIQUE, name_cn TEXT, name_en TEXT, type TEXT,
        position INTEGER, in_short INTEGER DEFAULT 0, description TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS field_values (
        id INTEGER PRIMARY KEY, field_id INTEGER REFERENCES fields(id) ON DELETE CASCADE,
        cn TEXT, en TEXT, code TEXT, description TEXT DEFAULT '', position INTEGER, source TEXT DEFAULT 'manual');
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY, source TEXT, external_id TEXT, spu TEXT, spu_manual INTEGER DEFAULT 0,
        title TEXT, handle TEXT, image_url TEXT, images_json TEXT, product_type TEXT, url TEXT,
        updated_at TEXT, UNIQUE(source, external_id));
    CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY, seq INTEGER UNIQUE, filename TEXT, ext TEXT, media_type TEXT,
        file_path TEXT, size INTEGER, thumb TEXT, product_id INTEGER, values_json TEXT DEFAULT '{}',
        ai_tags_json TEXT DEFAULT '[]', ai_raw_json TEXT, description TEXT DEFAULT '',
        full_name TEXT DEFAULT '', short_name TEXT DEFAULT '', media_ids TEXT DEFAULT '',
        status TEXT DEFAULT 'uploaded', created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS perf (
        id INTEGER PRIMARY KEY, row_key TEXT UNIQUE, source TEXT, date TEXT, ad_id TEXT, ad_name TEXT,
        creative_id TEXT, media_keys TEXT DEFAULT '', spend REAL DEFAULT 0, impressions REAL DEFAULT 0,
        clicks REAL DEFAULT 0, conversions REAL DEFAULT 0, revenue REAL DEFAULT 0, imported_at TEXT);
    """)
    cols = [r[1] for r in c.execute("PRAGMA table_info(assets)")]
    for col in ("learned_ids", "short_history"):
        if col not in cols:
            c.execute("ALTER TABLE assets ADD COLUMN %s TEXT DEFAULT ''" % col)
    pcols = [r[1] for r in c.execute("PRAGMA table_info(perf)")]
    if "landing_page" not in pcols:
        c.execute("ALTER TABLE perf ADD COLUMN landing_page TEXT DEFAULT ''")
    for col in FUNNEL_COLS:
        if col not in pcols:
            c.execute("ALTER TABLE perf ADD COLUMN %s REAL DEFAULT 0" % col)
    c.execute("CREATE TABLE IF NOT EXISTS lp_meta (lp TEXT PRIMARY KEY, name TEXT DEFAULT '', type TEXT DEFAULT '')")
    for k, v in DEFAULT_SETTINGS.items():
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
    if c.execute("SELECT COUNT(*) FROM fields").fetchone()[0] == 0:
        load_spec(c, DEFAULT_SPEC)
    else:
        migrate_designer_date(c)
    if not get_settings(c).get("default_designer"):
        dd = c.execute("SELECT v.id FROM field_values v JOIN fields f ON f.id=v.field_id "
                       "WHERE f.key='designer' ORDER BY v.position LIMIT 1").fetchone()
        if dd:
            set_setting(c, "default_designer", str(dd[0]))
    if get_settings(c).get("short_format") != "2":
        rebuild_all(c, keep_history=True)
        set_setting(c, "short_format", "2")
    c.commit()
    c.close()


def migrate_designer_date(c):
    """旧版「设计师+日期」合并字段 → 「设计师」字典字段 + 「日期」字段"""
    old = c.execute("SELECT * FROM fields WHERE type='designer_date'").fetchone()
    if not old:
        return
    dkey = "designer" if not c.execute("SELECT 1 FROM fields WHERE key='designer' AND id<>?", (old["id"],)).fetchone() else old["key"]
    c.execute("UPDATE fields SET type='enum', key=?, name_cn=?, in_short=0, description=? WHERE id=?",
              (dkey, "设计师", "素材制作人", old["id"]))
    tkey = "date" if not c.execute("SELECT 1 FROM fields WHERE key='date'").fetchone() else "make_date"
    c.execute("UPDATE fields SET position=position+1 WHERE position>?", (old["position"],))
    c.execute("INSERT INTO fields(key,name_cn,name_en,type,position,in_short,description) VALUES(?,?,?,?,?,?,?)",
              (tkey, "日期", "Date", "date", old["position"] + 1, 1, "制作日期 YYMMDD"))
    for r in c.execute("SELECT id, values_json FROM assets").fetchall():
        vals = json.loads(r["values_json"] or "{}")
        v = vals.pop(old["key"], None)
        if v:
            d = v.pop("date", None)
            vals[dkey] = v
            if d:
                vals[tkey] = {"date": d}
        c.execute("UPDATE assets SET values_json=? WHERE id=?", (json.dumps(vals, ensure_ascii=False), r["id"]))


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def get_settings(c):
    s = dict(DEFAULT_SETTINGS)
    for r in c.execute("SELECT key,value FROM settings"):
        s[r["key"]] = r["value"]
    return s


def set_setting(c, k, v):
    c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, str(v)))


def code_width(s):
    try:
        return max(1, min(4, int(s.get("code_width") or 2)))
    except ValueError:
        return 2


def load_fields(c):
    fields = [dict(r) for r in c.execute("SELECT * FROM fields ORDER BY position, id")]
    vals = {}
    for r in c.execute("SELECT * FROM field_values ORDER BY position, id"):
        vals.setdefault(r["field_id"], []).append(dict(r))
    for f in fields:
        f["values"] = vals.get(f["id"], [])
    return fields


def load_spec(c, spec):
    c.execute("DELETE FROM field_values")
    c.execute("DELETE FROM fields")
    expanded = []
    for f in spec:
        if f.get("type") == "designer_date":
            expanded.append(dict(f, key="designer", name_cn="设计师", type="enum", in_short=0))
            expanded.append({"key": "date", "name_cn": "日期", "name_en": "Date", "type": "date", "in_short": 1,
                             "description": "制作日期 YYMMDD", "values": []})
        else:
            expanded.append(f)
    for i, f in enumerate(expanded):
        cur = c.execute("INSERT INTO fields(key,name_cn,name_en,type,position,in_short,description) VALUES(?,?,?,?,?,?,?)",
                        (f["key"], f["name_cn"], f.get("name_en", ""), f["type"], i, int(f.get("in_short", 0)),
                         f.get("description", "")))
        fid = cur.lastrowid
        for j, v in enumerate(f.get("values", [])):
            if isinstance(v, (list, tuple)):
                v = {"cn": v[0], "en": v[1], "code": v[2]}
            c.execute("INSERT INTO field_values(field_id,cn,en,code,description,position,source) VALUES(?,?,?,?,?,?,?)",
                      (fid, v.get("cn", ""), v.get("en", ""), (v.get("code") or "").upper(), v.get("description", ""), j,
                       v.get("source", "manual")))


# ---------------------------------------------------------------- naming engine

def b36(n, width=0):
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    n = int(n)
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = chars[r] + s
    return (s or "0").rjust(width, "0")


STOPWORDS = {"a", "an", "the", "is", "are", "am", "be", "i", "it", "this", "that", "to", "of", "at", "in", "on", "for",
              "and", "or", "with", "how", "will", "want", "very", "my", "your", "we", "you"}


def gen_code(en, cn, existing, width):
    """为标签值生成固定宽度、字段内唯一的短码（尽量取英文首字母，保留可读性）"""
    existing = {e.upper() for e in existing if e}
    s = re.sub(r"[^A-Za-z0-9\s\-_+]", "", en or "")
    parts = [p for p in re.split(r"[\s\-_+]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", s) if p]
    if len(parts) > width:
        parts = [p for p in parts if p.lower() not in STOPWORDS] or parts
    joined = "".join(parts).upper()
    cands = []
    if len(parts) >= width:
        cands.append("".join(p[0] for p in parts[:width]).upper())
    if parts and len(parts) < width:
        head = "".join(p[0] for p in parts).upper()
        rest = "".join(p[1:] for p in parts).upper()
        cands.append((head + rest)[:width])
    cands.append(joined[:width])
    if joined:
        for ch in joined[1:]:
            cands.append((joined[0] + ch + joined[2:])[:width] if width > 1 else ch)
    first = joined[:1] or "Z"
    for d in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        cands.append((first + d).ljust(width, "X")[:width] if width > 1 else d)
    for cnd in cands:
        cnd = re.sub(r"[^A-Z0-9]", "", cnd)
        if len(cnd) == width and cnd not in existing:
            return cnd
    for i in range(36 ** width):
        cnd = b36(i, width)
        if cnd not in existing:
            return cnd
    return "X" * width


CJK = re.compile(r"[\u3400-\u9fff]")


def icu_transform(text, *transforms):
    """macOS CoreFoundation 的 ICU 转换（离线），如 Any-Latin 转拼音、Hant-Hans 繁转简"""
    try:
        import ctypes
        import ctypes.util
        cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
    except Exception:
        return None
    vp = ctypes.c_void_p
    cf.CFStringCreateWithCString.restype = vp
    cf.CFStringCreateWithCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringCreateMutableCopy.restype = vp
    cf.CFStringCreateMutableCopy.argtypes = [vp, ctypes.c_long, vp]
    cf.CFStringTransform.argtypes = [vp, vp, vp, ctypes.c_bool]
    cf.CFStringGetCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFRelease.argtypes = [vp]
    utf8 = 0x08000100
    s = cf.CFStringCreateWithCString(None, text.encode("utf-8"), utf8)
    m = cf.CFStringCreateMutableCopy(None, 0, s)
    for name in transforms:
        tr = cf.CFStringCreateWithCString(None, name.encode(), utf8)
        cf.CFStringTransform(m, None, tr, False)
        cf.CFRelease(tr)
    buf = ctypes.create_string_buffer(len(text.encode("utf-8")) * 8 + 64)
    ok = cf.CFStringGetCString(m, buf, len(buf), utf8)
    cf.CFRelease(s)
    cf.CFRelease(m)
    return buf.value.decode("utf-8") if ok else None


def to_pascal(text):
    return "".join(w[:1].upper() + w[1:] for w in re.findall(r"[A-Za-z0-9]+", text or ""))


def mymemory(text, src, dst):
    q = urllib.parse.urlencode({"q": text, "langpair": "%s|%s" % (src, dst)})
    data = http_json("https://api.mymemory.translated.net/get?" + q, timeout=10)
    out = ((data or {}).get("responseData") or {}).get("translatedText") or ""
    if not out or "MYMEMORY WARNING" in out.upper() or out.strip() == text.strip():
        return ""
    return out.strip()


def complete_value(s, f, cn, en):
    """只填了中文或英文时自动补全另一项；返回 (cn, en, AI建议短码, 补全方式)"""
    cn, en = (cn or "").strip(), (en or "").strip()
    if en and CJK.search(en) and not cn:
        cn, en = en, ""
    if cn and en:
        return cn, en, None, None
    others = [v for v in f["values"] if v["en"] and not CJK.search(v["en"])]
    abbr_style = bool(others) and all(re.fullmatch(r"[A-Z0-9]{1,3}", v["en"]) for v in others)
    sep = s.get("separator")
    if s.get("ai_api_key"):
        try:
            existing = "; ".join("%s/%s/%s" % (v["cn"], v["en"], v["code"]) for v in f["values"][:60]) or "（暂无）"
            r = ai_chat(s, [{"role": "user", "content": (
                "你在维护广告素材命名字典。字段「%s」%s。已有可选值（中文/英文/短码）：%s\n"
                "用户新增了一个值：中文=\"%s\"，英文=\"%s\"（空表示缺失）。请补全缺失项，风格与已有值一致："
                "英文用于文件命名，PascalCase 或沿用已有的缩写风格，不含空格、下划线和中文；中文简洁。"
                "同时给出 %d 位大写字母/数字的短码，需有含义（通常取英文首字母），不得与已有短码重复。"
                "只输出 JSON：{\"cn\":\"\",\"en\":\"\",\"code\":\"\"}") % (
                f["name_cn"], ("（%s）" % f["description"]) if f.get("description") else "", existing, cn, en, code_width(s))}])
            ai_en = clean_seg(r.get("en") or "", sep)
            if not CJK.search(ai_en):
                cn, en = cn or (r.get("cn") or "").strip(), en or ai_en
                if cn and en:
                    return cn, en, (r.get("code") or "").upper(), "ai"
        except Exception:
            pass
    how = None
    if not en and cn:
        if abbr_style:
            py = icu_transform(cn, "Any-Latin", "Latin-ASCII") or ""
            en, how = "".join(w[0] for w in py.split() if w).upper()[:3], "pinyin"
        if not en:
            try:
                en, how = to_pascal(mymemory(cn, "zh-CN", "en")), "translate"
            except ApiError:
                en = ""
        if not en:
            en, how = to_pascal(icu_transform(cn, "Any-Latin", "Latin-ASCII") or ""), "pinyin"
    if not cn and en:
        try:
            zh = mymemory(re.sub(r"(?<=[a-z])(?=[A-Z])|[-_+]", " ", en), "en", "zh-CN")
            cn, how = (icu_transform(zh, "Hant-Hans") or zh) if zh else "", "translate"
        except ApiError:
            cn = ""
        if not cn:
            cn, how = en, None
    return cn or en, clean_seg(en, sep) or cn, None, how


def code_for(s, f, en, cn, suggested=None, exclude_id=None):
    w = code_width(s)
    existing = [v["code"] for v in f["values"] if v["id"] != exclude_id]
    sug = (suggested or "").upper()
    if re.fullmatch(r"[A-Z0-9]{%d}" % w, sug) and sug != "X" * w and sug not in {e.upper() for e in existing if e}:
        return sug
    return gen_code(en, cn, existing, w)


def clean_seg(text, sep):
    text = re.sub(r"\s+", "", str(text or ""))
    if sep:
        text = text.replace(sep, "-")
    return re.sub(r'[\\/:*?"<>|]', "", text)


def field_segment(f, v, s):
    if not v:
        return ""
    t = f["type"]
    en_first = s.get("name_lang", "en") == "en"
    if t == "product":
        return v.get("spu") or ""
    if t == "enum":
        return (v.get("en") or v.get("cn")) if en_first else (v.get("cn") or v.get("en"))
    if t == "date":
        return v.get("date") or ""
    if t == "version":
        return ("V%s" % v["n"]) if v.get("n") else ""
    if t == "text":
        return v.get("text") or ""
    return ""


def seg_width(f, w):
    return {"date": DATE_WIDTH, "version": VERSION_WIDTH}.get(f["type"], w)


def short_code(f, v, w):
    t = f["type"]
    if t == "version":
        n = int((v or {}).get("n") or 0)
        return "V" + (b36(n) if 0 < n < 36 else "0")
    if t == "date":
        return re.sub(r"\D", "", (v or {}).get("date") or "")[:DATE_WIDTH].ljust(DATE_WIDTH, "X")
    if t == "text":
        return re.sub(r"[^A-Z0-9]", "", ((v or {}).get("text") or "").upper())[:w].ljust(w, "X")
    code = ((v or {}).get("code") or "").upper()
    return code[:w].ljust(w, "X") if code else "X" * w


def build_names(s, fields, seq, values, ai_tags):
    sep = s.get("separator", "_")
    en_first = s.get("name_lang", "en") == "en"
    parts = []
    for f in fields:
        if f["type"] == "ai_tags":
            if s.get("ai_tags_in_name") != "1":
                continue
            enabled = [t for t in (ai_tags or []) if t.get("enabled", True)]
            enabled = enabled[: int(s.get("ai_tags_max") or 3)]
            seg = (s.get("ai_tag_joiner") or "+").join(
                clean_seg((t.get("en") or t.get("cn")) if en_first else (t.get("cn") or t.get("en")), sep)
                for t in enabled)
        else:
            seg = clean_seg(field_segment(f, values.get(f["key"]), s), sep)
        if seg:
            parts.append(seg)
    full = sep.join(parts)
    w = code_width(s)
    codes = "".join(short_code(f, values.get(f["key"]), w) for f in fields
                    if f["in_short"] and f["type"] in SHORT_TYPES)
    return full, codes or ("N" + b36(seq or 0, 4))


def short_layout(s, fields):
    w = code_width(s)
    return [{"key": f["key"], "name": f["name_cn"], "type": f["type"], "width": seg_width(f, w)}
            for f in fields if f["in_short"] and f["type"] in SHORT_TYPES]


def taken_shorts(c, aid):
    taken = set()
    for r in c.execute("SELECT short_name, short_history FROM assets WHERE id<>?", (aid or 0,)):
        if r["short_name"]:
            taken.add(r["short_name"])
        taken.update(x for x in (r["short_history"] or "").split(",") if x)
    return taken


def unique_short(c, aid, base, current=None):
    """短码相同时在末尾追加 1 位字母区分；已分配的后缀保持不变"""
    taken = taken_shorts(c, aid)
    if current and current not in taken and (current == base or (current[:-1] == base and current[-1] in DUP_SUFFIX)):
        return current
    if base not in taken:
        return base
    for ch in DUP_SUFFIX:
        if base + ch not in taken:
            return base + ch
    return base + b36(random.randint(36 ** 2, 36 ** 3 - 1))


def names_for(c, s, fields, asset, values, tags):
    full, base = build_names(s, fields, asset.get("seq"), values, tags)
    return full, unique_short(c, asset.get("id"), base, asset.get("short_name"))


def history_after(asset, new_short):
    """已保存过的素材改了短名称时保留旧名，已投放的广告仍能匹配"""
    hist = [x for x in (asset.get("short_history") or "").split(",") if x]
    old = asset.get("short_name")
    if asset.get("status") == "named" and old and old != new_short and old not in hist:
        hist.append(old)
    return ",".join(h for h in hist if h != new_short)


def rebuild_all(c, keep_history=True):
    s = get_settings(c)
    fields = load_fields(c)
    vals_by_id = {v["id"]: v for f in fields for v in f["values"]}
    prods = {p["id"]: p for p in list_products(c)}
    n = 0
    for r in c.execute("SELECT * FROM assets ORDER BY id").fetchall():
        a = asset_row(r, light=True)
        values = a["values"]
        for f in fields:
            v = values.get(f["key"])
            if not v:
                continue
            if f["type"] == "enum" and v.get("value_id") in vals_by_id:
                d = vals_by_id[v["value_id"]]
                v.update({"cn": d["cn"], "en": d["en"], "code": d["code"]})
                v.pop("is_new", None)
            if f["type"] == "product" and v.get("product_id") in prods:
                v["spu"] = prods[v["product_id"]]["spu"]
        full, short = names_for(c, s, fields, a, values, a["ai_tags"])
        hist = history_after(a, short) if keep_history else a.get("short_history") or ""
        c.execute("UPDATE assets SET values_json=?, full_name=?, short_name=?, short_history=?, updated_at=? WHERE id=?",
                  (json.dumps(values, ensure_ascii=False), full, short, hist, now(), a["id"]))
        n += 1
    c.commit()
    return n


def decode_codes(s, fields, token):
    """不依赖素材库，仅凭短码和当前字典反解标签；不符合短码结构时返回 None"""
    lay = short_layout(s, fields)
    total = sum(x["width"] for x in lay)
    if not lay or len(token) not in (total, total + 1):
        return None
    out = {}
    pos = 0
    byid = {f["key"]: f for f in fields}
    for x in lay:
        seg = token[pos: pos + x["width"]]
        pos += x["width"]
        f = byid[x["key"]]
        if f["type"] == "version":
            if seg[0] != "V":
                return None
            if seg[1] != "0":
                out[f["key"]] = {"n": int(seg[1], 36)}
        elif f["type"] == "date":
            if set(seg) == {"X"}:
                continue
            if not seg.isdigit():
                return None
            out[f["key"]] = {"date": seg}
        elif set(seg) == {"X"}:
            continue
        elif f["type"] == "text":
            out[f["key"]] = {"text": seg}
        else:
            m = next((v for v in f["values"] if (v["code"] or "").upper() == seg), None)
            if not m:
                return None
            out[f["key"]] = {"value_id": m["id"], "cn": m["cn"], "en": m["en"], "code": m["code"]}
    return out if out else None


def value_label(f, v):
    if not v:
        return None
    t = f["type"]
    if t == "product":
        return v.get("spu") or None
    if t in ("enum",):
        if v.get("cn") and v.get("en") and v["cn"] != v["en"]:
            return "%s (%s)" % (v["cn"], v["en"])
        return v.get("cn") or v.get("en")
    if t == "date":
        return v.get("date") or None
    if t == "version":
        return ("V%s" % v["n"]) if v.get("n") else None
    if t == "text":
        return v.get("text") or None
    return None


# ---------------------------------------------------------------- assets

def asset_row(r, light=False):
    d = dict(r)
    d["values"] = json.loads(d.pop("values_json") or "{}")
    d["ai_tags"] = json.loads(d.pop("ai_tags_json") or "[]")
    raw = d.pop("ai_raw_json", None)
    if not light:
        d["ai_raw"] = json.loads(raw) if raw else None
    d["media_ids"] = [x for x in (d.get("media_ids") or "").split(",") if x]
    d["learned_ids"] = [x for x in (d.get("learned_ids") or "").split(",") if x]
    d["history"] = [x for x in (d.get("short_history") or "").split(",") if x]
    return d


def get_asset(c, aid):
    r = c.execute("SELECT * FROM assets WHERE id=?", (aid,)).fetchone()
    if not r:
        raise ApiError("素材不存在", 404)
    return asset_row(r)


def next_seq(c):
    s = get_settings(c)
    cur = max(int(s.get("seq_counter") or 0),
              c.execute("SELECT COALESCE(MAX(seq),0) FROM assets").fetchone()[0])
    set_setting(c, "seq_counter", cur + 1)
    return cur + 1


def media_type_of(filename, hint=""):
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    if ext == "gif":
        return "gif"
    if hint in ("image", "video", "gif"):
        return hint
    if ext in ("mp4", "mov", "m4v", "webm", "avi", "mkv"):
        return "video"
    return "image"


MEDIA_CODE = {"image": ("IMG", "图片"), "video": ("VID", "视频"), "gif": ("GIF", "GIF")}


def enum_pick(f, text):
    if not text:
        return None
    t = str(text).strip().lower()
    for v in f["values"]:
        if t in ((v["en"] or "").lower(), (v["cn"] or "").lower(), (v["code"] or "").lower()):
            return v
    return None


def enum_value(v, source, conf=None, reason=""):
    d = {"value_id": v["id"], "cn": v["cn"], "en": v["en"], "code": v["code"], "source": source}
    if conf is not None:
        d["confidence"] = conf
    if reason:
        d["reason"] = reason
    return d


def default_values(c, s, fields, asset, product):
    """不依赖 AI 的确定性预填：素材类型、设计师、日期、商品"""
    vals = {}
    for f in fields:
        if f["type"] == "product" and product:
            vals[f["key"]] = {"product_id": product["id"], "spu": product["spu"], "title": product["title"],
                              "source": "match"}
        elif f["type"] == "enum" and f["key"] == "material_type":
            en, cn = MEDIA_CODE.get(asset["media_type"], ("IMG", "图片"))
            v = enum_pick(f, en) or enum_pick(f, cn)
            if v:
                vals[f["key"]] = enum_value(v, "file", 1.0, "由文件类型确定")
        elif f["type"] == "enum" and f["key"] == "designer":
            dv = next((v for v in f["values"] if str(v["id"]) == str(s.get("default_designer"))), None) or \
                (f["values"][0] if f["values"] else None)
            if dv:
                vals[f["key"]] = enum_value(dv, "default")
        elif f["type"] == "date":
            vals[f["key"]] = {"date": datetime.date.today().strftime("%y%m%d"), "source": "default"}
        elif f["type"] == "version":
            vals[f["key"]] = {"n": 1, "source": "default"}
    return vals


def suggest_version(c, fields, asset_id, values):
    """同 SPU + 同组合标签已存在时版本号自增，避免重名"""
    keys = [f["key"] for f in fields if f["type"] in ("enum", "product", "text")]

    def sig(vals):
        out = []
        for k in keys:
            v = vals.get(k) or {}
            out.append(str(v.get("spu") or v.get("en") or v.get("text") or ""))
        return "|".join(out)

    me = sig(values)
    vkey = next((f["key"] for f in fields if f["type"] == "version"), None)
    if not vkey:
        return None
    mx = 0
    for r in c.execute("SELECT id, values_json FROM assets WHERE id<>?", (asset_id,)):
        vals = json.loads(r["values_json"] or "{}")
        if sig(vals) == me:
            mx = max(mx, int((vals.get(vkey) or {}).get("n") or 0))
    return mx + 1


def match_product_by_filename(products, filename):
    low = filename.lower()
    best = None
    for p in products:
        for key in (p["spu"], p["handle"]):
            if key and len(key) >= 4 and key.lower() in low:
                if not best or len(key) > best[1]:
                    best = (p, len(key))
    return best[0] if best else None


def list_products(c):
    return [dict(r) for r in c.execute("SELECT * FROM products ORDER BY id DESC")]


# ---------------------------------------------------------------- http helpers / AI

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"


def http_json(url, data=None, headers=None, timeout=60):
    h = {"User-Agent": UA, "Accept": "application/json"}
    h.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if data is None and e.code in (403, 429) and shutil.which("curl"):
            # 部分站点（如 Shopify）按 TLS 指纹拦截 Python 请求，改用系统 curl
            p = subprocess.run(["curl", "-sS", "-L", "--max-time", str(timeout), "-A", UA, "-H", "Accept: application/json",
                                "-w", "\n%{http_code}", url], capture_output=True)
            out, _, code = p.stdout.decode("utf-8", "ignore").rpartition("\n")
            if p.returncode == 0 and code == "200":
                return json.loads(out)
            e.code = int(code) if code.isdigit() else e.code
        detail = e.read().decode("utf-8", "ignore")[:500]
        raise ApiError("请求失败 %s: %s" % (e.code, detail), 502)
    except urllib.error.URLError as e:
        raise ApiError("网络错误: %s" % e.reason, 502)


def parse_json_loose(txt):
    txt = (txt or "").strip()
    txt = re.sub(r"^```(?:json)?|```$", "", txt, flags=re.M).strip()
    try:
        return json.loads(txt)
    except ValueError:
        a, b = txt.find("{"), txt.rfind("}")
        if a >= 0 and b > a:
            return json.loads(txt[a: b + 1])
        raise ApiError("AI 返回内容无法解析为 JSON", 502)


def ai_chat(s, messages):
    key = s.get("ai_api_key")
    if not key:
        raise ApiError("未配置 AI API Key", 400)
    base = (s.get("ai_base_url") or "https://api.openai.com/v1").rstrip("/")
    body = {"model": s.get("ai_model") or "gpt-4o-mini", "messages": messages, "temperature": 0.2,
            "response_format": {"type": "json_object"}}
    data = http_json(base + "/chat/completions", body, {"Authorization": "Bearer " + key}, timeout=180)
    return parse_json_loose(data["choices"][0]["message"]["content"])


def img_part(url, detail="low"):
    if "cdn.shopify.com" in url and "width=" not in url:
        url += ("&" if "?" in url else "?") + "width=400"
    return {"type": "image_url", "image_url": {"url": url, "detail": detail}}


def spec_prompt(fields):
    lines = []
    for f in fields:
        if f["type"] in ("product", "date", "version", "ai_tags") or f["key"] == "designer":
            continue
        if f["type"] == "enum":
            opts = "; ".join("%s=%s" % (v["en"], v["cn"]) + ("(%s)" % v["description"] if v["description"] else "")
                             for v in f["values"])
            lines.append('- "%s"（%s）%s\n  可选值(英文=中文): %s' % (f["key"], f["name_cn"],
                                                             ("说明: " + f["description"]) if f["description"] else "", opts))
        else:
            lines.append('- "%s"（%s）自由文本 %s' % (f["key"], f["name_cn"], f["description"] or ""))
    return "\n".join(lines)


def analyze_asset(c, aid, frames):
    s = get_settings(c)
    fields = load_fields(c)
    asset = get_asset(c, aid)
    products = list_products(c)
    by_id = {p["id"]: p for p in products}
    product = match_product_by_filename(products, asset["filename"])
    product_reason = "文件名包含 SPU/handle" if product else ""
    values = default_values(c, s, fields, asset, product)
    ai_tags = []
    description = ""
    raw = None
    mode = "ai"

    if not s.get("ai_api_key"):
        mode = "offline"
        low = asset["filename"].lower()
        for f in fields:
            if f["type"] == "enum" and f["key"] not in values:
                for v in f["values"]:
                    if (v["en"] and len(v["en"]) > 2 and v["en"].lower() in low) or (v["cn"] and v["cn"] in asset["filename"]):
                        values[f["key"]] = enum_value(v, "filename", 0.6, "文件名包含该词")
                        break
        description = "未配置 AI Key：已按文件类型/文件名预填，其余请手动选择（在「设置」中配置后可自动识别）"
    else:
        media_desc = {"image": "图片", "video": "视频（以下为按时间顺序抽取的关键帧）", "gif": "GIF 动图"}[asset["media_type"]]
        plist = "\n".join("%d | %s | %s" % (p["id"], p["spu"] or "-", p["title"] or "") for p in products[:400])
        prompt = """你是资深的跨境电商广告素材分析师。请识别这份广告素材，并按照命名规范输出结构化标签。

素材类型：%s；原始文件名：%s

【命名规范字典】请为每个字段选择最贴切的一个值，优先使用已有可选值（输出其英文值）；如果没有任何可选值贴切，可以提出新值并标记 is_new=true（英文值请用 PascalCase 或已有风格，不含空格和下划线）。
%s

【商品库】格式：id | SPU | 标题。请根据画面中的商品判断最可能是哪几款（按可能性排序，最多5个）。没有商品库或无法判断时返回空数组。
%s

【AI 补充标签】在规范之外，补充 3~6 个对广告分析有价值的标签（如：人物性别/人种、主色调、镜头景别、开头钩子类型、是否有字幕/口播、氛围情绪、产品展示角度等），每个标签需有分类 category（中文）、中文 cn、英文 en（PascalCase，无空格）。

只输出 JSON：
{
 "description": "一两句中文描述素材内容",
 "product_hint": "画面中商品的简要描述（品类/颜色/款式）",
 "product_candidates": [{"id": 0, "confidence": 0.0, "reason": ""}],
 "fields": {"<字段key>": {"value": "<英文值>", "cn": "<中文值>", "is_new": false, "confidence": 0.0, "reason": "<简短依据>"}},
 "ai_tags": [{"category": "", "cn": "", "en": ""}]
}""" % (media_desc, asset["filename"], spec_prompt(fields), plist or "（商品库为空）")
        content = [{"type": "text", "text": prompt}] + [img_part(f, "low" if len(frames) > 2 else "high") for f in frames[:8]]
        raw = ai_chat(s, [{"role": "system", "content": "You are a precise ad creative tagging assistant. Reply with JSON only."},
                          {"role": "user", "content": content}])
        description = raw.get("description") or ""

        cands = []
        for cd in raw.get("product_candidates") or []:
            try:
                pid = int(cd.get("id"))
            except (TypeError, ValueError):
                continue
            if pid in by_id:
                cands.append((by_id[pid], float(cd.get("confidence") or 0), cd.get("reason") or ""))
        if not product and cands:
            product, conf, product_reason = cands[0]
            with_img = [x for x in cands[:6] if x[0].get("image_url")]
            if len(with_img) > 1:
                content2 = [{"type": "text", "text": "以下先给出广告素材画面，然后是若干候选商品主图。请仔细对比款式、颜色、面料、细节，判断素材中的商品是哪一个候选。"
                                                     "只输出 JSON: {\"id\": 候选id, \"confidence\": 0~1, \"reason\": \"中文依据\"}"}]
                content2 += [img_part(f) for f in frames[:3]]
                for p, _, _ in with_img:
                    content2.append({"type": "text", "text": "候选商品 id=%d SPU=%s 标题=%s" % (p["id"], p["spu"], p["title"])})
                    content2.append(img_part(p["image_url"]))
                try:
                    pick = ai_chat(s, [{"role": "user", "content": content2}])
                    pid = int(pick.get("id"))
                    if pid in by_id:
                        product = by_id[pid]
                        product_reason = "图像比对：" + (pick.get("reason") or "")
                        raw["product_pick"] = pick
                except Exception as e:  # 比对失败时沿用第一候选
                    raw["product_pick_error"] = str(e)
        if product:
            pf = next((f for f in fields if f["type"] == "product"), None)
            if pf:
                values[pf["key"]] = {"product_id": product["id"], "spu": product["spu"], "title": product["title"],
                                     "source": "ai", "reason": product_reason}

        w = code_width(s)
        for f in fields:
            if f["type"] not in ("enum", "text") or f["key"] == "designer":
                continue
            r = (raw.get("fields") or {}).get(f["key"])
            if not isinstance(r, dict) or not r.get("value"):
                continue
            conf = float(r.get("confidence") or 0)
            if f["type"] == "text":
                values[f["key"]] = {"text": str(r["value"]), "source": "ai", "confidence": conf}
                continue
            if f["key"] == "material_type" and f["key"] in values:
                continue
            v = enum_pick(f, r.get("value")) or enum_pick(f, r.get("cn"))
            if v:
                values[f["key"]] = enum_value(v, "ai", conf, r.get("reason") or "")
            else:
                en = clean_seg(r.get("value"), s.get("separator"))
                values[f["key"]] = {"value_id": None, "cn": r.get("cn") or en, "en": en,
                                    "code": gen_code(en, r.get("cn"), [x["code"] for x in f["values"]], w),
                                    "is_new": True, "source": "ai", "confidence": conf, "reason": r.get("reason") or ""}
        mx = int(s.get("ai_tags_max") or 3)
        for i, t in enumerate(raw.get("ai_tags") or []):
            if isinstance(t, dict) and (t.get("cn") or t.get("en")):
                ai_tags.append({"category": t.get("category") or "其他", "cn": t.get("cn") or t.get("en"),
                                "en": clean_seg(t.get("en") or t.get("cn"), s.get("separator")), "enabled": i < mx})

    vkey = next((f["key"] for f in fields if f["type"] == "version"), None)
    if vkey:
        values[vkey] = {"n": suggest_version(c, fields, aid, values) or 1, "source": "auto"}
    full, short = names_for(c, s, fields, asset, values, ai_tags)
    c.execute("UPDATE assets SET values_json=?, ai_tags_json=?, ai_raw_json=?, description=?, product_id=?, "
              "full_name=?, short_name=?, short_history=?, status='analyzed', updated_at=? WHERE id=?",
              (json.dumps(values, ensure_ascii=False), json.dumps(ai_tags, ensure_ascii=False),
               json.dumps(raw, ensure_ascii=False) if raw else None, description,
               product["id"] if product else None, full, short, history_after(asset, short), now(), aid))
    c.commit()
    out = get_asset(c, aid)
    out["mode"] = mode
    return out


# ---------------------------------------------------------------- product catalog

def spu_from_skus(skus, fallback):
    skus = [x.strip() for x in skus if x and x.strip()]
    if not skus:
        return fallback
    if len(set(skus)) == 1:
        return skus[0]
    pre = os.path.commonprefix(skus).rstrip("-_./ ")
    return pre if len(pre) >= 4 else skus[0]


def upsert_product(c, source, ext_id, spu, title, handle, images, ptype, url):
    row = c.execute("SELECT id, spu_manual FROM products WHERE source=? AND external_id=?", (source, ext_id)).fetchone()
    img = images[0] if images else ""
    if row:
        if row["spu_manual"]:
            c.execute("UPDATE products SET title=?, handle=?, image_url=?, images_json=?, product_type=?, url=?, updated_at=? WHERE id=?",
                      (title, handle, img, json.dumps(images[:6]), ptype, url, now(), row["id"]))
        else:
            c.execute("UPDATE products SET spu=?, title=?, handle=?, image_url=?, images_json=?, product_type=?, url=?, updated_at=? WHERE id=?",
                      (spu, title, handle, img, json.dumps(images[:6]), ptype, url, now(), row["id"]))
        return False
    c.execute("INSERT INTO products(source,external_id,spu,title,handle,image_url,images_json,product_type,url,updated_at) "
              "VALUES(?,?,?,?,?,?,?,?,?,?)", (source, ext_id, spu, title, handle, img, json.dumps(images[:6]), ptype, url, now()))
    return True


def sync_shopify(c, domain):
    d = re.sub(r"^https?://", "", (domain or "").strip()).split("/")[0]
    if not d:
        raise ApiError("请填写 Shopify 店铺域名")
    set_setting(c, "shopify_domain", d)
    added = updated = 0
    warning = ""
    for page in range(1, 41):
        data = None
        for attempt in range(4):
            try:
                data = http_json("https://%s/products.json?limit=250&page=%d" % (d, page))
                break
            except ApiError as e:
                if "429" not in str(e) or attempt == 3:
                    if page == 1:
                        raise
                    warning = "第 %d 页获取失败，已保留前面的商品：%s" % (page, str(e)[:120])
                    break
                time.sleep(2 * (attempt + 1))
        if data is None:
            break
        ps = data.get("products") or []
        for p in ps:
            skus = [v.get("sku") for v in p.get("variants") or []]
            images = [i.get("src") for i in p.get("images") or [] if i.get("src")]
            new = upsert_product(c, "shopify", str(p["id"]), spu_from_skus(skus, p.get("handle")), p.get("title"),
                                 p.get("handle"), images, p.get("product_type"), "https://%s/products/%s" % (d, p.get("handle")))
            added += new
            updated += (not new)
        if len(ps) < 250:
            break
        time.sleep(0.5)
    c.commit()
    return {"added": added, "updated": updated, "warning": warning}


def graph_get(s, path, params):
    params = dict(params)
    params["access_token"] = s.get("meta_token")
    if not params["access_token"]:
        raise ApiError("未配置 Meta Access Token（设置页）")
    url = "https://graph.facebook.com/%s/%s?%s" % (s.get("meta_api_version") or "v21.0", path.lstrip("/"),
                                                   urllib.parse.urlencode(params))
    return http_json(url, timeout=120)


def graph_pages(s, path, params, limit_pages=50):
    data = graph_get(s, path, params)
    out = list(data.get("data") or [])
    n = 1
    while (data.get("paging") or {}).get("next") and n < limit_pages:
        data = http_json(data["paging"]["next"], timeout=120)
        out += data.get("data") or []
        n += 1
    return out


def sync_meta_catalog(c, catalog_id):
    s = get_settings(c)
    catalog_id = (catalog_id or s.get("meta_catalog_id") or "").strip()
    if not catalog_id:
        raise ApiError("请填写 Meta 商品目录 ID")
    set_setting(c, "meta_catalog_id", catalog_id)
    items = graph_pages(s, "%s/products" % catalog_id,
                        {"fields": "id,name,retailer_id,retailer_product_group_id,image_url,url,product_type", "limit": 500})
    groups = {}
    for it in items:
        gid = it.get("retailer_product_group_id") or it.get("retailer_id") or it.get("id")
        groups.setdefault(gid, []).append(it)
    added = updated = 0
    for gid, its in groups.items():
        first = its[0]
        spu = gid if first.get("retailer_product_group_id") else spu_from_skus([i.get("retailer_id") for i in its], gid)
        images = [i.get("image_url") for i in its if i.get("image_url")]
        new = upsert_product(c, "meta", gid, spu, first.get("name"), first.get("retailer_id"), images,
                             first.get("product_type"), first.get("url"))
        added += new
        updated += (not new)
    c.commit()
    return {"added": added, "updated": updated}


# ---------------------------------------------------------------- performance data

ALIASES = {
    "date": ["date", "day", "日期", "报告开始日期", "reporting starts", "天", "date_start"],
    "ad_name": ["ad name", "ad_name", "广告名称", "广告名", "adname"],
    "ad_id": ["ad id", "ad_id", "广告编号", "广告 id", "广告id"],
    "creative_id": ["creative id", "creative_id", "素材id", "素材 id", "素材编号", "media id", "video id", "image hash",
                    "视频编号", "图片哈希"],
    "spend": ["amount spent", "spend", "cost", "花费金额", "花费", "消耗", "已花费金额"],
    "impressions": ["impressions", "展示次数", "曝光", "曝光量", "展示"],
    "clicks": ["link clicks", "clicks", "链接点击量", "点击量", "点击", "clicks (all)", "点击量（全部）"],
    "conversions": ["purchases", "conversions", "results", "购买次数", "购物次数", "转化", "成效", "购买", "订单"],
    "revenue": ["purchase conversion value", "purchases conversion value", "revenue", "conversion value", "购物转化价值",
                "转化价值", "收入", "gmv", "销售额"],
    "atc": ["adds to cart", "add to cart", "adds to cart (all)", "加入购物车", "加购次数", "加购"],
    "checkout": ["checkouts initiated", "initiate checkout", "initiated checkout", "发起结账", "结账发起次数", "结账"],
    "v3s": ["3-second video plays", "3 second video plays", "video plays at 3s", "3 秒视频播放量", "3秒视频播放量", "3秒播放"],
    "thruplay": ["thruplays", "thruplay", "thruplay 次数", "完播次数", "视频完播"],
    "landing_page": ["website url", "link url", "landing page", "destination url", "final url", "link", "url",
                     "落地页", "目标网址", "网址", "链接"],
}


def norm_header(h):
    h = re.sub(r"[\(（].*?[\)）]", "", (h or "").strip().lower()).strip()
    return h


def to_num(x):
    x = re.sub(r"[^\d.\-eE]", "", str(x or ""))
    try:
        return float(x) if x not in ("", "-", ".") else 0.0
    except ValueError:
        return 0.0


def norm_date(x):
    x = (x or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%Y%m%d", "%Y.%m.%d"):
        try:
            return datetime.datetime.strptime(x[:10], fmt).date().isoformat()
        except ValueError:
            pass
    return x[:10]


def insert_perf(c, rows, source):
    n = 0
    for r in rows:
        key = "|".join([source, r.get("date") or "", r.get("ad_id") or r.get("ad_name") or "", r.get("creative_id") or ""])
        c.execute("""INSERT INTO perf(row_key,source,date,ad_id,ad_name,creative_id,media_keys,spend,impressions,clicks,conversions,revenue,landing_page,imported_at,
                     atc,checkout,v3s,thruplay)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(row_key) DO UPDATE SET ad_name=excluded.ad_name, creative_id=excluded.creative_id,
                     media_keys=excluded.media_keys, spend=excluded.spend, impressions=excluded.impressions,
                     clicks=excluded.clicks, conversions=excluded.conversions, revenue=excluded.revenue,
                     atc=excluded.atc, checkout=excluded.checkout, v3s=excluded.v3s, thruplay=excluded.thruplay,
                     landing_page=CASE WHEN excluded.landing_page<>'' THEN excluded.landing_page ELSE perf.landing_page END,
                     imported_at=excluded.imported_at""",
                  (key, source, r.get("date"), r.get("ad_id"), r.get("ad_name"), r.get("creative_id"),
                   ",".join(r.get("media_keys") or []), r.get("spend", 0), r.get("impressions", 0), r.get("clicks", 0),
                   r.get("conversions", 0), r.get("revenue", 0), (r.get("landing_page") or "").strip(), now(),
                   r.get("atc", 0), r.get("checkout", 0), r.get("v3s", 0), r.get("thruplay", 0)))
        n += 1
    c.commit()
    learn_media_ids(c)
    return n


def import_csv(c, text, source):
    text = text.lstrip("\ufeff")
    rd = csv.reader(io.StringIO(text))
    rows = list(rd)
    if not rows:
        raise ApiError("CSV 为空")
    headers = [norm_header(h) for h in rows[0]]
    col = {}
    for exact in (True, False):
        for k, names in ALIASES.items():
            if k in col:
                continue
            for nm in names:
                for i, h in enumerate(headers):
                    if i not in col.values() and (h == nm if exact else h.startswith(nm)) \
                            and not (k in FUNNEL_COLS and re.search(r"value|价值|cost|成本|费用|rate|率", h)):
                        col.setdefault(k, i)
                if k in col:
                    break
    if "ad_name" not in col and "creative_id" not in col:
        raise ApiError("CSV 中未找到「广告名称」或「素材ID」列，识别到的表头：%s" % ", ".join(rows[0]))
    out = []
    for r in rows[1:]:
        if not any(x.strip() for x in r):
            continue
        g = lambda k: r[col[k]] if k in col and col[k] < len(r) else ""
        cid = g("creative_id").strip()
        out.append({"date": norm_date(g("date")), "ad_id": g("ad_id").strip(), "ad_name": g("ad_name").strip(),
                    "creative_id": cid, "media_keys": [cid] if cid else [],
                    "spend": to_num(g("spend")), "impressions": to_num(g("impressions")), "clicks": to_num(g("clicks")),
                    "conversions": to_num(g("conversions")), "revenue": to_num(g("revenue")),
                    "atc": to_num(g("atc")), "checkout": to_num(g("checkout")), "v3s": to_num(g("v3s")),
                    "thruplay": to_num(g("thruplay")), "landing_page": g("landing_page").strip()})
    return {"imported": insert_perf(c, out, source or "csv"), "columns": {k: rows[0][i] for k, i in col.items()}}


def pull_meta(c, since, until):
    s = get_settings(c)
    acc = (s.get("meta_ad_account") or "").strip().replace("act_", "")
    if not acc:
        raise ApiError("请在设置中填写 Meta 广告账户 ID")
    ins = graph_pages(s, "act_%s/insights" % acc, {
        "level": "ad", "time_increment": 1, "limit": 500,
        "fields": "ad_id,ad_name,spend,impressions,inline_link_clicks,clicks,actions,action_values,date_start,"
                  "video_thruplay_watched_actions",
        "time_range": json.dumps({"since": since, "until": until})})
    ad_ids = sorted({r["ad_id"] for r in ins if r.get("ad_id")})
    creatives = {}
    for i in range(0, len(ad_ids), 50):
        chunk = ad_ids[i: i + 50]
        data = graph_get(s, "", {"ids": ",".join(chunk),
                                 "fields": "creative{id,video_id,image_hash,object_story_spec,asset_feed_spec}"})
        for aid, v in data.items():
            cr = v.get("creative") or {}
            keys = [cr.get("id"), cr.get("video_id"), cr.get("image_hash")]
            oss = cr.get("object_story_spec") or {}
            vd = oss.get("video_data") or {}
            ld = oss.get("link_data") or {}
            keys += [vd.get("video_id"), ld.get("image_hash")]
            afs = cr.get("asset_feed_spec") or {}
            link = (ld.get("link") or ((vd.get("call_to_action") or {}).get("value") or {}).get("link")
                    or ((ld.get("call_to_action") or {}).get("value") or {}).get("link")
                    or next((u.get("website_url") for u in afs.get("link_urls") or [] if u.get("website_url")), None)
                    or "")
            creatives[aid] = (cr.get("id"), [k for k in keys if k], link)

    def act(lst, types):
        m = {a.get("action_type"): to_num(a.get("value")) for a in lst or []}
        for t in types:
            if t in m:
                return m[t]
        return 0.0

    ptypes = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]
    rows = []
    for r in ins:
        cid, keys, link = creatives.get(r.get("ad_id"), ("", [], ""))
        rows.append({"date": r.get("date_start"), "ad_id": r.get("ad_id"), "ad_name": r.get("ad_name"),
                     "creative_id": cid or "", "media_keys": keys, "landing_page": link, "spend": to_num(r.get("spend")),
                     "impressions": to_num(r.get("impressions")),
                     "clicks": to_num(r.get("inline_link_clicks") or r.get("clicks")),
                     "conversions": act(r.get("actions"), ptypes), "revenue": act(r.get("action_values"), ptypes),
                     "atc": act(r.get("actions"), ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"]),
                     "checkout": act(r.get("actions"), ["omni_initiated_checkout", "initiate_checkout",
                                                        "offsite_conversion.fb_pixel_initiate_checkout"]),
                     "v3s": act(r.get("actions"), ["video_view"]),
                     "thruplay": act(r.get("video_thruplay_watched_actions"), ["video_view"])})
    return {"imported": insert_perf(c, rows, "meta")}


class Matcher:
    def __init__(self, c):
        self.s = get_settings(c)
        self.fields = load_fields(c)
        self.assets = [asset_row(r, light=True) for r in c.execute("SELECT * FROM assets")]
        self.by_media = {}
        self.by_learned = {}
        self.by_short = {}
        self.legacy = []
        for a in self.assets:
            for m in a["media_ids"]:
                self.by_media[m] = a
            for m in a["learned_ids"]:
                self.by_learned[m] = a
            for h in a["history"]:
                if re.fullmatch(r"[A-Za-z0-9]+", h):
                    self.by_short.setdefault(h.upper(), a)
                else:
                    self.legacy.append((h, a))
        for a in self.assets:
            if a["short_name"]:
                self.by_short[a["short_name"].upper()] = a
        self.full_names = sorted([a for a in self.assets if a["full_name"]], key=lambda a: -len(a["full_name"]))

    def match(self, ad_name, media_keys, use_learned=True):
        ad_name = ad_name or ""
        for k in media_keys:
            if k in self.by_media:
                return self.by_media[k], "media_id", None
        tokens = [t for t in re.split(r"[^A-Za-z0-9]+", ad_name.upper()) if t]
        for t in tokens:
            if t in self.by_short:
                return self.by_short[t], "short_name", t
        for h, a in self.legacy:
            if h in ad_name:
                return a, "short_name", h
        for a in self.full_names:
            if a["full_name"] in ad_name:
                return a, "full_name", None
        if use_learned:
            for k in media_keys:
                if k in self.by_learned:
                    return self.by_learned[k], "learned_id", None
        for t in tokens:
            d = decode_codes(self.s, self.fields, t)
            if d:
                return None, "code_decode", {"short": t, "values": d}
        return None, "unmatched", None


def learn_media_ids(c):
    """按名称匹配成功的广告，把它的媒体素材ID自动绑定回素材，后续可直接按ID匹配"""
    mt = Matcher(c)
    add = {}
    for r in c.execute("SELECT ad_name, media_keys FROM perf WHERE media_keys<>''"):
        keys = r["media_keys"].split(",")
        a, how, _ = mt.match(r["ad_name"], keys, use_learned=False)
        if a and how in ("short_name", "full_name"):
            add.setdefault(a["id"], set(a["learned_ids"])).update(k for k in keys if k not in mt.by_media)
    for aid, ids in add.items():
        c.execute("UPDATE assets SET learned_ids=? WHERE id=?", (",".join(sorted(ids)), aid))
    c.commit()


FUNNEL_COLS = ("atc", "checkout", "v3s", "thruplay")
SUM_KEYS = ("spend", "impressions", "clicks", "conversions", "revenue") + FUNNEL_COLS + ("vimp",)


def metrics(m):
    sp, im, cl, cv, rv = m["spend"], m["impressions"], m["clicks"], m["conversions"], m["revenue"]
    m.update({"ctr": cl / im if im else None, "cpc": sp / cl if cl else None, "cpm": sp / im * 1000 if im else None,
              "cvr": cv / cl if cl else None, "cpa": sp / cv if cv else None, "roas": rv / sp if sp else None})
    atc, co, v3, tp, vi = (m.get(k, 0) for k in ("atc", "checkout", "v3s", "thruplay", "vimp"))
    m.update({"atc_rate": atc / cl if cl and atc else None, "checkout_rate": co / atc if atc and co else None,
              "purchase_rate": cv / co if co else None, "hook_rate": v3 / vi if vi and v3 else None,
              "hold_rate": tp / v3 if v3 and tp else None, "aov": rv / cv if cv else None})
    return m


def zero():
    return dict({k: 0.0 for k in SUM_KEYS}, rows=0)


def add_to(m, r):
    for k in ("spend", "impressions", "clicks", "conversions", "revenue") + FUNNEL_COLS:
        m[k] += r.get(k) or 0
    if r.get("v3s"):
        m["vimp"] += r.get("impressions") or 0
    m["rows"] += 1


def parse_ymd(s):
    try:
        return datetime.datetime.strptime((s or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def day_bucket():
    return {"spend": 0.0, "revenue": 0.0}


def add_day(bucket, day, r):
    if not day:
        return
    b = bucket.setdefault(day, day_bucket())
    b["spend"] += r.get("spend") or 0
    b["revenue"] += r.get("revenue") or 0


def fill_trend(bucket, days):
    out = []
    for d in days:
        b = bucket.get(d) or day_bucket()
        sp, rv = b["spend"], b["revenue"]
        out.append({"date": d, "spend": sp, "roas": (rv / sp) if sp else None})
    return out


def period_metrics(bucket, days):
    sp = rv = 0.0
    for d in days:
        b = bucket.get(d) or day_bucket()
        sp += b["spend"]
        rv += b["revenue"]
    return {"spend": sp, "revenue": rv, "roas": (rv / sp) if sp else None}


def lp_norm(url):
    u = (url or "").strip()
    if not u:
        return ""
    if not re.match(r"^[a-z][a-z0-9+.\-]*://", u, re.I):
        u = "https://" + u
    p = urllib.parse.urlparse(u)
    host = (p.netloc or "").lower().split("@")[-1]
    if host.startswith("www."):
        host = host[4:]
    path = re.sub(r"/+$", "", urllib.parse.unquote(p.path or "")) or "/"
    return host + path


def lp_type(key):
    i = key.find("/")
    path = key[i:] if i >= 0 else "/"
    if path == "/":
        return "home"
    if re.search(r"/products/[^/]+", path):
        return "product"
    if re.search(r"/collections(/|$)", path):
        return "collection"
    if re.search(r"/(pages|blogs|lp|landing)/", path + "/"):
        return "page"
    return "other"


def lp_handle(key):
    m = re.search(r"/products/([^/]+)", key)
    return m.group(1).lower() if m else None


ADVICE_SKIP = ("date", "version", "designer")


def build_advice(out_dims, assets, total_spend, avg_roas):
    """素材生产建议：黄金组合 / 值得加产 / 建议止损"""
    ts = total_spend or 0
    distinct = {}
    for a in assets:
        for lab in a.get("_labels") or []:
            distinct.setdefault(lab[2], set()).add(lab[1])
    combos = {}
    for a in assets:
        labs = [lab for lab in a.get("_labels") or [] if len(distinct[lab[2]]) > 1]
        for i in range(len(labs)):
            for j in range(i + 1, len(labs)):
                if labs[i][0] == labs[j][0]:
                    continue
                x, y = sorted([labs[i], labs[j]])
                g = combos.setdefault((x, y), {"spend": 0.0, "revenue": 0.0, "assets": 0, "ids": []})
                g["spend"] += a["spend"]
                g["revenue"] += a["revenue"]
                g["assets"] += 1
                g["ids"].append(a["short_name"])
    min_sp = max(ts * 0.03, 20)
    combo_out = []
    for (x, y), g in combos.items():
        if g["assets"] < 2 or g["spend"] < min_sp or not g["spend"]:
            continue
        roas = g["revenue"] / g["spend"]
        combo_out.append({"fields": [x[0], y[0]], "labels": [x[1], y[1]], "dims": [x[2], y[2]],
                          "assets": g["assets"], "spend": g["spend"], "share": g["spend"] / ts if ts else 0,
                          "roas": roas, "lift": (roas / avg_roas - 1) if avg_roas else None,
                          "short_names": sorted(g["ids"])})
    combo_out.sort(key=lambda z: -(z["roas"] * min(1.0, 0.6 + z["share"] * 4)))
    picked, used = [], set()
    for z in combo_out:
        sig = tuple(z["short_names"])
        if sig in used:
            continue
        used.add(sig)
        picked.append(z)
        if len(picked) >= 5:
            break

    scale, cut = [], []
    for d in out_dims:
        if d["type"] in ("date", "version", "lp") or d["key"] in ADVICE_SKIP:
            continue
        dsp = sum(v["spend"] for v in d["values"]) or 1
        for v in d["values"]:
            if v["label"] == "（未标注）" or v["roas"] is None or not avg_roas:
                continue
            share = v["spend"] / dsp
            lift = v["roas"] / avg_roas - 1
            item = {"dim": d["key"], "dim_name": d["name"], "dim_type": d["type"], "label": v["label"],
                    "assets": v["assets"], "spend": v["spend"], "share": share, "roas": v["roas"], "lift": lift}
            if lift >= 0.15 and share < 0.15 and v["spend"] >= ts * 0.01:
                scale.append(item)
            elif lift <= -0.15 and share >= 0.08:
                cut.append(item)
    scale.sort(key=lambda z: -z["lift"])
    cut.sort(key=lambda z: -z["spend"] * -z["lift"])
    return {"combos": picked, "scale": scale[:5], "cut": cut[:5], "avg_roas": avg_roas}


def analytics(c, q):
    mt = Matcher(c)
    fields = mt.fields
    pid = str(q.get("product_id") or "")
    lpf = q.get("lp") or ""
    prods = {p["id"]: p for p in list_products(c)}
    by_handle = {}
    for p in prods.values():
        for k in (p.get("handle"), p.get("spu")):
            if k:
                by_handle.setdefault(k.lower(), p)
    pfield = next((f for f in fields if f["type"] == "product"), None)

    def product_of(a, values):
        if a and a.get("product_id"):
            return a["product_id"]
        if pfield:
            return (values.get(pfield["key"]) or {}).get("product_id")
        return None

    filter_from = parse_ymd(q.get("from"))
    filter_to = parse_ymd(q.get("to"))

    max_d = c.execute("SELECT MAX(date) FROM perf").fetchone()[0]
    end = filter_to or parse_ymd(max_d) or datetime.date.today()
    d30_start = end - datetime.timedelta(days=29)
    recent7 = [ (end - datetime.timedelta(days=i)).isoformat() for i in range(6, -1, -1) ]
    prior7 = [ (end - datetime.timedelta(days=i)).isoformat() for i in range(13, 6, -1) ]
    days30 = [ (d30_start + datetime.timedelta(days=i)).isoformat() for i in range(30) ]

    # 汇总窗口用筛选；趋势窗口固定过去 30 日（结束日往前）
    sql_from = min(filter_from or d30_start, d30_start)
    sql_to = end
    rows = [dict(r) for r in c.execute("SELECT * FROM perf WHERE date>=? AND date<=?",
                                       (sql_from.isoformat(), sql_to.isoformat()))]

    total = zero()
    how_m = {}
    per_asset = {}
    dims = {}
    unmatched = {}
    trend = {}
    for f in fields:
        if f["type"] != "ai_tags":
            dims[f["key"]] = {"key": f["key"], "name": f["name_cn"], "type": f["type"], "values": {}}

    def ensure_dim_val(dkey, dname, dtype, label):
        d = dims.setdefault(dkey, {"key": dkey, "name": dname, "type": dtype, "values": {}})
        return d["values"].setdefault(label, dict(zero(), label=label, assets=set(), _days={}))

    def bump(dkey, dname, dtype, label, r, aid, in_filter, day):
        v = ensure_dim_val(dkey, dname, dtype, label)
        if in_filter:
            add_to(v, r)
            if aid is not None:
                v["assets"].add(aid)
        add_day(v["_days"], day, r)

    per_prod, per_lp = {}, {}

    def agg(store, key, r, in_filter, day, akey, other):
        g = store.setdefault(key, dict(zero(), _assets=set(), _others=set(), _ads=set(), _days={}))
        if in_filter:
            add_to(g, r)
            if akey:
                g["_assets"].add(akey)
            if other:
                g["_others"].add(other)
            g["_ads"].add(r.get("ad_id") or r.get("ad_name"))
        add_day(g["_days"], day, r)

    for r in rows:
        day = (r.get("date") or "")[:10]
        day_d = parse_ymd(day)
        in_trend = day_d and d30_start <= day_d <= end
        in_filter = True
        if filter_from and day_d and day_d < filter_from:
            in_filter = False
        if filter_to and day_d and day_d > filter_to:
            in_filter = False
        if not in_filter and not in_trend:
            continue

        a, how, extra = mt.match(r["ad_name"], [k for k in (r["media_keys"] or "").split(",") if k] or
                                 ([r["creative_id"]] if r["creative_id"] else []))
        prod_id = product_of(a, a["values"] if a else ((extra or {}).get("values") or {}))
        lpk = lp_norm(r.get("landing_page"))
        if pid and str(prod_id or "") != pid:
            continue
        if lpf and lpk != lpf:
            continue

        if in_filter:
            add_to(total, r)
            hm = how_m.setdefault(how, zero())
            add_to(hm, r)
            t = trend.setdefault(day, zero())
            add_to(t, r)
        akey0 = ("a%d" % a["id"]) if a else (("s" + extra["short"]) if how == "code_decode" else None)
        tday = day if in_trend else None
        if lpk:
            agg(per_lp, lpk, r, in_filter, tday, akey0, prod_id)
        if prod_id:
            agg(per_prod, prod_id, r, in_filter, tday, akey0, lpk)
        if how == "unmatched":
            if in_filter:
                u = unmatched.setdefault(r["ad_name"] or "(空)", zero())
                add_to(u, r)
            continue

        if a:
            values, tags, akey = a["values"], a["ai_tags"], "a%d" % a["id"]
            pa = per_asset.setdefault(akey, dict(zero(), asset_id=a["id"], short_name=a["short_name"],
                                                 full_name=a["full_name"], thumb=a["thumb"], media_type=a["media_type"],
                                                 values=values, ai_tags=[t for t in tags if t.get("enabled", True)],
                                                 match=set(), _days={}, _lps=set(), product_id=prod_id))
        else:
            values, tags, akey = extra["values"], [], "s" + extra["short"]
            pa = per_asset.setdefault(akey, dict(zero(), asset_id=None, short_name=extra["short"],
                                                 full_name="（库中无此素材，按短码解码）",
                                                 thumb=None, media_type=None, values=values, ai_tags=[], match=set(),
                                                 _days={}, _lps=set(), product_id=prod_id))
        if in_filter:
            add_to(pa, r)
            pa["match"].add(how)
            if lpk:
                pa["_lps"].add(lpk)
        if in_trend:
            add_day(pa["_days"], day, r)

        labels = []
        for f in fields:
            if f["type"] == "ai_tags":
                for tg in tags:
                    if tg.get("enabled", True):
                        lab = tg.get("cn") if not tg.get("en") or tg.get("cn") == tg.get("en") else "%s (%s)" % (tg["cn"], tg["en"])
                        cat = tg.get("category") or "其他"
                        bump("ai:" + cat, "AI·" + cat, "ai", lab, r, akey, in_filter, tday)
                        labels.append(("AI·" + cat, lab, "ai:" + cat))
                continue
            lab = value_label(f, values.get(f["key"])) or "（未标注）"
            bump(f["key"], f["name_cn"], f["type"], lab, r, akey, in_filter, tday)
            if f["type"] in ("enum", "product") and f["key"] not in ADVICE_SKIP and lab != "（未标注）":
                labels.append((f["name_cn"], lab, f["key"]))
        pa["_labels"] = labels

    out_dims = []
    for d in dims.values():
        vals = []
        for v in d["values"].values():
            days_map = v.pop("_days", {})
            v["assets"] = len(v["assets"])
            v["trend_30"] = fill_trend(days_map, days30)
            v["_recent"] = period_metrics(days_map, recent7)
            v["_prior"] = period_metrics(days_map, prior7)
            vals.append(metrics(v))
        vals.sort(key=lambda x: -x["spend"])
        fs = sum(v["spend"] for v in vals) or 1
        eligible = [v for v in vals if v["roas"] is not None and v["spend"] >= fs * 0.05 and v["label"] != "（未标注）"]
        best_v = max(eligible, key=lambda x: x["roas"] or -1) if eligible else None
        sig = [v["roas"] for v in eligible]
        best_detail = None
        if best_v:
            best_detail = {"label": best_v["label"], "spend": best_v["spend"], "roas": best_v["roas"],
                           "trend_30": best_v["trend_30"]}
        out_dims.append({"key": d["key"], "name": d["name"], "type": d["type"], "values": vals,
                         "roas_spread": (max(sig) - min(sig)) if len(sig) >= 2 else None,
                         "best": best_v["label"] if best_v else None,
                         "best_detail": best_detail})

    assets = []
    for v in per_asset.values():
        days_map = v.pop("_days", {})
        v["match"] = sorted(v["match"])
        v["lps"] = sorted(v.pop("_lps", set()))
        v["trend_30"] = fill_trend(days_map, days30)
        v["_recent"] = period_metrics(days_map, recent7)
        v["_prior"] = period_metrics(days_map, prior7)
        assets.append(metrics(v))
    assets.sort(key=lambda x: -x["spend"])

    def finish(g):
        days_map = g.pop("_days", {})
        g["assets"] = len(g.pop("_assets"))
        g["ads"] = len(g.pop("_ads"))
        others = g.pop("_others")
        g["trend_30"] = fill_trend(days_map, days30)
        rec, pri = period_metrics(days_map, recent7), period_metrics(days_map, prior7)
        g["recent7"] = rec
        g["prior7"] = pri
        g["delta_roas"] = (rec["roas"] - pri["roas"]) if rec["roas"] is not None and pri["roas"] is not None else None
        return metrics(g), others

    products_out = []
    for k, g in per_prod.items():
        g, others = finish(g)
        p = prods.get(k) or {}
        g.update(product_id=k, spu=p.get("spu") or "#%s" % k, title=p.get("title") or "", image=p.get("image_url"),
                 url=p.get("url") or "", handle=p.get("handle") or "", lps=len(others))
        products_out.append(g)
    products_out.sort(key=lambda x: -x["spend"])

    lps_out = []
    for k, g in per_lp.items():
        g, others = finish(g)
        hp = by_handle.get(lp_handle(k) or "")
        g.update(lp=k, lp_type=lp_type(k), products=len(others),
                 lp_product={"product_id": hp["id"], "spu": hp["spu"], "title": hp["title"], "image": hp["image_url"]} if hp else None)
        lps_out.append(g)
    lps_out.sort(key=lambda x: -x["spend"])

    insights = build_insights(out_dims, assets, recent7, prior7)
    s_total = metrics(dict(total))
    advice = build_advice(out_dims, assets, total["spend"], s_total["roas"])

    for d in out_dims:
        for v in d["values"]:
            v.pop("_recent", None)
            v.pop("_prior", None)
    for a in assets:
        a.pop("_recent", None)
        a.pop("_prior", None)
        a.pop("_labels", None)

    scope = None
    if pid:
        p = prods.get(int(pid)) if pid.isdigit() else None
        scope = {"kind": "spu", "product_id": int(pid) if pid.isdigit() else pid,
                 "spu": p["spu"] if p else pid, "title": p["title"] if p else "",
                 "image": p["image_url"] if p else None, "url": p["url"] if p else ""}
    elif lpf:
        hp = by_handle.get(lp_handle(lpf) or "")
        scope = {"kind": "lp", "lp": lpf, "lp_type": lp_type(lpf),
                 "lp_product": {"product_id": hp["id"], "spu": hp["spu"], "title": hp["title"],
                                "image": hp["image_url"]} if hp else None}

    return {
        "summary": metrics(total),
        "match": {k: metrics(v) for k, v in how_m.items()},
        "dims": out_dims,
        "assets": assets,
        "unmatched": sorted([dict(metrics(v), ad_name=k) for k, v in unmatched.items()], key=lambda x: -x["spend"])[:200],
        "trend": [dict(metrics(v), date=k) for k, v in sorted(trend.items())],
        "insights": insights,
        "advice": advice,
        "products": products_out,
        "lps": lps_out,
        "lp_missing": sum(v["spend"] for k, v in how_m.items()) - sum(g["spend"] for g in lps_out),
        "scope": scope,
        "window": {"end": end.isoformat(), "d30_start": d30_start.isoformat(),
                   "recent7": [recent7[0], recent7[-1]], "prior7": [prior7[0], prior7[-1]]},
        "fields": [{"key": f["key"], "name": f["name_cn"], "type": f["type"]} for f in fields],
    }


def build_insights(dims, assets, recent7, prior7):
    """近 7 日 vs 前 7 日：爆款维度 / 衰退 / 爆品 SPU / 爆款素材"""
    cands = []

    for d in dims:
        if d["type"] in ("date", "version") or d["key"] in ("date", "version", "designer"):
            continue
        for v in d["values"]:
            if v["label"] == "（未标注）":
                continue
            rec, pri = v.get("_recent") or {}, v.get("_prior") or {}
            rsp, psp = rec.get("spend") or 0, pri.get("spend") or 0
            rroas, proas = rec.get("roas"), pri.get("roas")
            if rsp < 15 and psp < 15:
                continue
            delta = (rroas - proas) if (rroas is not None and proas is not None) else None
            share_up = rsp > psp * 1.25 and rsp >= 30
            if delta is not None and delta >= 0.35 and (share_up or rsp >= 60):
                kind = "spu" if d["type"] == "product" else "breakout"
                cands.append({
                    "type": kind, "score": abs(delta) * (1 + rsp / 200),
                    "title": ("爆款落地页：%s" % v["label"]) if d["type"] == "lp"
                             else "爆款维度：%s · %s" % (d["name"], v["label"]) if kind == "breakout"
                             else "爆品 SPU：%s" % v["label"],
                    "detail": "近7日 ROAS %s → %s（Δ%+.2f），消耗 %s → %s" % (
                        "%.2f" % proas if proas is not None else "-",
                        "%.2f" % rroas if rroas is not None else "-", delta,
                        "%.0f" % psp, "%.0f" % rsp),
                    "dim": d["key"], "label": v["label"], "delta_roas": delta, "spend": rsp,
                })
            if delta is not None and delta <= -0.4 and psp >= 30:
                cands.append({
                    "type": "decline", "score": abs(delta) * (1 + psp / 200),
                    "title": ("落地页衰退：%s" % v["label"]) if d["type"] == "lp"
                             else "衰退：%s · %s" % (d["name"], v["label"]),
                    "detail": "近7日 ROAS %s → %s（Δ%+.2f），消耗 %s → %s" % (
                        "%.2f" % proas, "%.2f" % rroas if rroas is not None else "-", delta,
                        "%.0f" % psp, "%.0f" % rsp),
                    "dim": d["key"], "label": v["label"], "delta_roas": delta, "spend": rsp,
                })

    for a in assets[:80]:
        rec, pri = a.get("_recent") or {}, a.get("_prior") or {}
        rsp, psp = rec.get("spend") or 0, pri.get("spend") or 0
        rroas, proas = rec.get("roas"), pri.get("roas")
        if rsp < 30 and psp < 30:
            continue
        delta = (rroas - proas) if (rroas is not None and proas is not None) else None
        if delta is not None and delta >= 0.5 and rsp >= 50:
            cands.append({
                "type": "creative", "score": abs(delta) * (1 + rsp / 150),
                "title": "爆款素材：%s" % a["short_name"],
                "detail": "近7日 ROAS %s → %s（Δ%+.2f），消耗 %s → %s" % (
                    "%.2f" % proas if proas is not None else "-",
                    "%.2f" % rroas, delta, "%.0f" % psp, "%.0f" % rsp),
                "short_name": a["short_name"], "delta_roas": delta, "spend": rsp,
            })
        if delta is not None and delta <= -0.6 and psp >= 50:
            cands.append({
                "type": "decline", "score": abs(delta) * (1 + psp / 150),
                "title": "素材衰退：%s" % a["short_name"],
                "detail": "近7日 ROAS %s → %s（Δ%+.2f），消耗 %s → %s" % (
                    "%.2f" % proas, "%.2f" % rroas if rroas is not None else "-", delta,
                    "%.0f" % psp, "%.0f" % rsp),
                "short_name": a["short_name"], "delta_roas": delta, "spend": rsp,
            })

    cands.sort(key=lambda x: -x["score"])
    seen, out = set(), []
    for x in cands:
        key = (x["type"], x.get("dim"), x.get("label"), x.get("short_name"))
        if key in seen:
            continue
        seen.add(key)
        x.pop("score", None)
        out.append(x)
        if len(out) >= 5:
            break
    return out


# ---------------------------------------------------------------- 独立视角：落地页分析 / 商品(SPU)分析

LP_TYPE_NAME = {"product": "商品详情页", "collection": "类目/集合页", "home": "官网首页", "page": "活动页", "other": "其他"}
STAGES = [("hook_rate", "3秒完播率", "视频曝光→3秒"), ("ctr", "点击率", "曝光→点击"), ("atc_rate", "加购率", "点击→加购"),
          ("checkout_rate", "结账率", "加购→结账"), ("purchase_rate", "支付率", "结账→购买")]
SLIM_KEYS = ("spend", "revenue", "impressions", "clicks", "conversions", "atc", "checkout", "v3s", "thruplay", "vimp",
             "roas", "ctr", "cvr", "cpa", "cpm", "atc_rate", "checkout_rate", "purchase_rate", "hook_rate", "hold_rate", "aov")


def slim(m):
    return {k: m.get(k) for k in SLIM_KEYS}


class PerfCtx:
    """加载窗口内投放行，一次性完成素材匹配、SPU 与落地页归属"""

    def __init__(self, c, q):
        self.mt = mt = Matcher(c)
        self.fields = mt.fields
        self.prods = {p["id"]: p for p in list_products(c)}
        self.by_handle = {}
        for p in self.prods.values():
            for k in (p.get("handle"), p.get("spu")):
                if k:
                    self.by_handle.setdefault(k.lower(), p)
        self.lpmeta = {r["lp"]: dict(r) for r in c.execute("SELECT * FROM lp_meta")}
        pfield = next((f for f in self.fields if f["type"] == "product"), None)
        ff, ft = parse_ymd(q.get("from")), parse_ymd(q.get("to"))
        max_d = c.execute("SELECT MAX(date) FROM perf").fetchone()[0]
        end = ft or parse_ymd(max_d) or datetime.date.today()
        td = datetime.timedelta
        self.end, self.d30 = end, end - td(days=29)
        self.days30 = [(self.d30 + td(days=i)).isoformat() for i in range(30)]
        self.recent7 = [(end - td(days=i)).isoformat() for i in range(6, -1, -1)]
        self.prior7 = [(end - td(days=i)).isoformat() for i in range(13, 6, -1)]
        sql_from = min(ff or self.d30, end - td(days=59))
        self.rows = []
        self._labels = {}
        for r in c.execute("SELECT * FROM perf WHERE date>=? AND date<=?", (sql_from.isoformat(), end.isoformat())):
            r = dict(r)
            day = (r.get("date") or "")[:10]
            dd = parse_ymd(day)
            r["_day"] = day
            r["_f"] = bool(dd) and (not ff or dd >= ff) and (not ft or dd <= ft) and (ff is not None or dd >= self.d30)
            r["_t"] = bool(dd) and self.d30 <= dd <= end
            keys = [k for k in (r["media_keys"] or "").split(",") if k] or ([r["creative_id"]] if r["creative_id"] else [])
            a, how, extra = mt.match(r["ad_name"], keys)
            values = a["values"] if a else ((extra or {}).get("values") or {})
            r["_a"], r["_how"], r["_values"] = a, how, values
            r["_tags"] = [t for t in a["ai_tags"] if t.get("enabled", True)] if a else []
            r["_akey"] = ("a%d" % a["id"]) if a else (("s" + extra["short"]) if how == "code_decode" else None)
            r["_short"] = a["short_name"] if a else ((extra or {}).get("short") or "")
            pid = a.get("product_id") if a else None
            if not pid and pfield:
                pid = (values.get(pfield["key"]) or {}).get("product_id")
            r["_pid"] = pid if pid in self.prods else None
            r["_lp"] = lp_norm(r.get("landing_page"))
            self.rows.append(r)

    def labels(self, r):
        """素材的创意标签（字典字段 + AI 标签），不含 SPU / 日期 / 版本 / 设计师"""
        k = r["_akey"]
        if k in self._labels:
            return self._labels[k]
        out = []
        for f in self.fields:
            if f["type"] == "ai_tags":
                for tg in r["_tags"]:
                    cat = tg.get("category") or "其他"
                    lab = tg.get("cn") if not tg.get("en") or tg.get("cn") == tg.get("en") else "%s (%s)" % (tg["cn"], tg["en"])
                    out.append(("ai:" + cat, "AI·" + cat, "ai", lab))
            elif f["type"] == "enum" and f["key"] not in ADVICE_SKIP:
                lab = value_label(f, r["_values"].get(f["key"]))
                if lab:
                    out.append((f["key"], f["name_cn"], "enum", lab))
        self._labels[k] = out
        return out

    def lp_type(self, k):
        t = (self.lpmeta.get(k) or {}).get("type")
        return t if t in LP_TYPE_NAME else lp_type(k)

    def lp_name(self, k):
        return (self.lpmeta.get(k) or {}).get("name") or ""

    def lp_product(self, k):
        p = self.by_handle.get(lp_handle(k) or "")
        return {"product_id": p["id"], "spu": p["spu"], "title": p["title"], "image": p["image_url"]} if p else None

    def product_info(self, pid):
        p = self.prods.get(pid) or {}
        return {"product_id": pid, "spu": p.get("spu") or "#%s" % pid, "title": p.get("title") or "",
                "image": p.get("image_url"), "url": p.get("url") or "", "product_type": p.get("product_type") or ""}

    def asset_info(self, r):
        a = r["_a"]
        return {"key": r["_akey"], "asset_id": a["id"] if a else None, "short_name": r["_short"],
                "full_name": a["full_name"] if a else "（库中无此素材，按短码解码）", "thumb": a["thumb"] if a else None,
                "media_type": a["media_type"] if a else None, "product_id": r["_pid"],
                "labels": [{"dim": x[1], "label": x[3], "ai": x[2] == "ai"} for x in self.labels(r)]}

    def window(self):
        return {"end": self.end.isoformat(), "d30_start": self.d30.isoformat(),
                "recent7": [self.recent7[0], self.recent7[-1]], "prior7": [self.prior7[0], self.prior7[-1]]}


def new_agg():
    return dict(zero(), _assets=set(), _days={})


def acc(g, r):
    if r["_f"]:
        add_to(g, r)
        if r["_akey"]:
            g["_assets"].add(r["_akey"])
    if r["_t"]:
        add_to(g["_days"].setdefault(r["_day"], zero()), r)


def period(days, ds):
    m = zero()
    for d in ds:
        b = days.get(d)
        if b:
            for k in SUM_KEYS:
                m[k] += b[k]
    m = metrics(m)
    return {k: m[k] for k in ("spend", "revenue", "conversions", "roas", "cvr", "ctr", "atc_rate")}


def fin(ctx, g):
    days = g.pop("_days", {})
    g["assets"] = len(g.pop("_assets", ()))
    trend = []
    for d in ctx.days30:
        b = metrics(dict(days.get(d) or zero()))
        trend.append({"date": d, "spend": b["spend"], "revenue": b["revenue"], "roas": b["roas"],
                      "orders": b["conversions"], "cvr": b["cvr"]})
    out = slim(metrics(g))
    out["assets"] = g["assets"]
    out["trend_30"] = trend
    rec, pri = period(days, ctx.recent7), period(days, ctx.prior7)
    out["recent7"], out["prior7"] = rec, pri
    out["delta_roas"] = (rec["roas"] - pri["roas"]) if rec["roas"] is not None and pri["roas"] is not None else None
    out["rev_growth"] = (rec["revenue"] / pri["revenue"] - 1) if pri["revenue"] else None
    return out


def diagnose(m, base, base_name):
    stages = []
    for key, name, step in STAGES:
        v, b = m.get(key), base.get(key)
        if v is None or not b:
            continue
        stages.append({"key": key, "name": name, "step": step, "value": v, "base": b, "ratio": v / b})
    after_click = [s for s in stages if s["key"] in ("atc_rate", "checkout_rate", "purchase_rate")]
    worst = min(stages, key=lambda s: s["ratio"]) if stages else None
    worst_lp = min(after_click, key=lambda s: s["ratio"]) if after_click else None
    return {"base_name": base_name, "stages": stages,
            "worst": worst if worst and worst["ratio"] < 0.92 else None,
            "worst_after_click": worst_lp if worst_lp and worst_lp["ratio"] < 0.92 else None}


def lp_overview(c, q):
    ctx = PerfCtx(c, q)
    total, all_rows = zero(), zero()
    per, types, fit, dim_meta, top = {}, {}, {}, {}, {}
    for r in ctx.rows:
        if r["_f"]:
            add_to(all_rows, r)
        if not r["_lp"]:
            continue
        t = ctx.lp_type(r["_lp"])
        if r["_f"]:
            add_to(total, r)
        acc(per.setdefault(r["_lp"], new_agg()), r)
        if r["_t"] and r["_akey"]:
            e = top.setdefault(r["_lp"], {}).get(r["_akey"])
            if e is None:
                e = top[r["_lp"]][r["_akey"]] = {"r": r, "spend": 0.0, "revenue": 0.0}
            e["spend"] += r["spend"] or 0
            e["revenue"] += r["revenue"] or 0
        acc(types.setdefault(t, new_agg()), r)
        if r["_f"] and r["_akey"]:
            for dk, dn, dt, lab in ctx.labels(r):
                dim_meta[dk] = (dn, dt)
                cell = fit.setdefault(dk, {}).setdefault(lab, {}).setdefault(t, dict(zero(), _a=set()))
                add_to(cell, r)
                cell["_a"].add(r["_akey"])
    tot = metrics(total)
    lps = []
    for k, g in per.items():
        g = fin(ctx, g)
        g.update(lp=k, lp_type=ctx.lp_type(k), name=ctx.lp_name(k), lp_product=ctx.lp_product(k),
                 drop=diagnose(g, tot, "全部落地页")["worst_after_click"])
        g["top_assets"] = []
        for e in sorted((top.get(k) or {}).values(), key=lambda e: -e["spend"])[:3]:
            info = ctx.asset_info(e["r"])
            g["top_assets"].append({"asset_id": info["asset_id"], "short_name": info["short_name"], "thumb": info["thumb"],
                                    "media_type": info["media_type"], "spend": e["spend"],
                                    "roas": e["revenue"] / e["spend"] if e["spend"] else None})
        lps.append(g)
    lps.sort(key=lambda x: -x["spend"])
    types_out = {}
    for t, g in types.items():
        g = fin(ctx, g)
        g.update(type=t, name=LP_TYPE_NAME[t], pages=sum(1 for x in lps if x["lp_type"] == t))
        types_out[t] = g
    type_list = sorted(types_out.values(), key=lambda x: -x["spend"])

    min_cell = max(tot["spend"] * 0.01, 30)
    min_rule = max(tot["spend"] * 0.02, 60)
    site_roas = tot["roas"]
    fit_out, rules = [], []
    best_for = {t: [] for t in types_out}
    avoid_for = {t: [] for t in types_out}
    for dk, labs in fit.items():
        dn, dt = dim_meta[dk]
        vals = []
        for lab, cells in labs.items():
            row_m, assets, out_cells = zero(), set(), {}
            for cl in cells.values():
                assets |= cl["_a"]
                for k in SUM_KEYS:
                    row_m[k] += cl[k]
            rm = metrics(row_m)
            # 适配指数 = 格子 ROAS / (页面类型 ROAS × 标签整体 ROAS / 全站 ROAS)：剔除标签本身强弱与页面本身强弱，只看搭配效应
            lab_k = rm["roas"] / site_roas if rm["roas"] and site_roas else None
            for t, cl in cells.items():
                ca = cl.pop("_a")
                m = metrics(cl)
                base = types_out[t]["roas"]
                exp = base * lab_k if base and lab_k else None
                idx = m["roas"] / exp if m["roas"] is not None and exp else None
                ok = m["spend"] >= min_cell and len(ca) >= 2
                solid = ok and len(ca) >= 3 and m["spend"] >= min_rule
                out_cells[t] = {"spend": m["spend"], "roas": m["roas"], "cvr": m["cvr"], "atc_rate": m["atc_rate"],
                                "index": idx, "vs_type": m["roas"] / base if m["roas"] is not None and base else None,
                                "ok": ok, "solid": solid, "assets": len(ca)}
            vals.append({"label": lab, "spend": rm["spend"], "roas": rm["roas"], "cvr": rm["cvr"],
                         "assets": len(assets), "cells": out_cells})
            valid = [(t, cl) for t, cl in out_cells.items() if cl["solid"] and cl["index"] is not None]
            alt = max(valid, key=lambda x: x[1]["index"]) if valid else None
            for t, cl in valid:
                item = {"dim": dk, "dim_name": dn, "label": lab, "index": cl["index"], "roas": cl["roas"],
                        "label_roas": rm["roas"], "cvr": cl["cvr"], "spend": cl["spend"], "assets": cl["assets"]}
                if cl["index"] >= 1.05:
                    best_for[t].append(dict(item, score=cl["spend"] * (cl["index"] - 1)))
                elif cl["index"] <= 0.9:
                    better = alt if alt and alt[0] != t and alt[1]["index"] >= 1 else None
                    avoid_for[t].append(dict(item, score=cl["spend"] * (1 - cl["index"]),
                                             alt_type=better[0] if better else None,
                                             alt_roas=better[1]["roas"] if better else None))
            if len(valid) >= 2:
                bt, bc = max(valid, key=lambda x: x[1]["index"])
                wt, wc = min(valid, key=lambda x: x[1]["index"])
                common = {"dim": dk, "dim_name": dn, "label": lab, "label_roas": rm["roas"],
                          "spread": bc["index"] / wc["index"] if wc["index"] else None,
                          "best_type": bt, "best_type_name": LP_TYPE_NAME[bt], "best_roas": bc["roas"],
                          "worst_type": wt, "worst_type_name": LP_TYPE_NAME[wt], "worst_roas": wc["roas"]}
                if bc["index"] >= 1.1:
                    rules.append(dict(common, kind="fit", type=bt, type_name=LP_TYPE_NAME[bt], index=bc["index"],
                                      vs_type=bc["vs_type"], roas=bc["roas"], cvr=bc["cvr"], atc_rate=bc["atc_rate"],
                                      spend=bc["spend"], assets=bc["assets"], score=bc["spend"] * (bc["index"] - 1)))
                if wc["index"] <= 0.88 and wt != bt:
                    rules.append(dict(common, kind="misfit", type=wt, type_name=LP_TYPE_NAME[wt], index=wc["index"],
                                      vs_type=wc["vs_type"], roas=wc["roas"], cvr=wc["cvr"], atc_rate=wc["atc_rate"],
                                      spend=wc["spend"], assets=wc["assets"], score=wc["spend"] * (1 - wc["index"])))
        vals.sort(key=lambda x: -x["spend"])
        fit_out.append({"key": dk, "name": dn, "type": dt, "values": vals})
    order = {f["key"]: i for i, f in enumerate(ctx.fields)}
    fit_out.sort(key=lambda d: (d["type"] == "ai", order.get(d["key"], 99), d["key"]))
    rules.sort(key=lambda x: -x["score"])
    for t in best_for:
        best_for[t] = sorted(best_for[t], key=lambda x: -x["score"])[:5]
        avoid_for[t] = sorted(avoid_for[t], key=lambda x: -x["score"])[:3]
    return {"summary": slim(tot), "all_spend": all_rows["spend"], "lps": lps, "types": type_list,
            "fit": fit_out, "rules": rules[:12], "best_for": best_for, "avoid_for": avoid_for, "type_names": LP_TYPE_NAME, "window": ctx.window()}


def lp_detail(c, q):
    ctx = PerfCtx(c, q)
    key = q.get("lp") or ""
    t = ctx.lp_type(key)
    site, same, g = zero(), zero(), new_agg()
    assets, dims, prods, peers, lab_site = {}, {}, {}, {}, {}
    for r in ctx.rows:
        if not r["_lp"]:
            continue
        if r["_f"]:
            add_to(site, r)
            if r["_akey"]:
                for dk, dn, dt, lab in ctx.labels(r):
                    add_to(lab_site.setdefault((dk, lab), zero()), r)
            if ctx.lp_type(r["_lp"]) == t:
                add_to(same, r)
                add_to(peers.setdefault(r["_lp"], zero()), r)
        if r["_lp"] != key:
            continue
        acc(g, r)
        if r["_akey"]:
            pa = assets.get(r["_akey"])
            if pa is None:
                pa = assets[r["_akey"]] = dict(new_agg(), info=ctx.asset_info(r))
            acc(pa, r)
            for dk, dn, dt, lab in ctx.labels(r):
                d = dims.setdefault(dk, {"key": dk, "name": dn, "type": dt, "values": {}})
                acc(d["values"].setdefault(lab, new_agg()), r)
        if r["_pid"]:
            acc(prods.setdefault(r["_pid"], new_agg()), r)
    site_m, same_m = metrics(site), metrics(same)
    m = fin(ctx, g)
    a_out = []
    for k, pa in assets.items():
        info = pa.pop("info")
        x = fin(ctx, pa)
        x.update(info)
        a_out.append(x)
    a_out.sort(key=lambda x: -x["spend"])
    d_out, good, bad = [], [], []
    for d in dims.values():
        vals = []
        for lab, v in d["values"].items():
            x = fin(ctx, v)
            x["label"] = lab
            x["share"] = x["spend"] / m["spend"] if m["spend"] else 0
            x["index"] = x["roas"] / m["roas"] if x["roas"] is not None and m["roas"] else None
            ls = metrics(dict(lab_site.get((d["key"], lab)) or zero()))
            x["site_roas"] = ls["roas"]
            # 适配 = 该标签在本页的相对表现 ÷ 该标签在全站的相对表现
            x["fit"] = (x["index"] / (ls["roas"] / site_m["roas"])
                        if x["index"] is not None and ls["roas"] and site_m["roas"] else None)
            vals.append(x)
            if x["share"] >= 0.05 and x["fit"] is not None and x["assets"] >= 2:
                item = {"dim": d["key"], "dim_name": d["name"], "label": lab, "index": x["fit"], "vs_lp": x["index"],
                        "roas": x["roas"], "site_roas": ls["roas"], "cvr": x["cvr"], "atc_rate": x["atc_rate"],
                        "share": x["share"], "assets": x["assets"], "score": x["spend"] * (x["fit"] - 1)}
                if x["fit"] >= 1.1:
                    good.append(item)
                elif x["fit"] <= 0.9:
                    bad.append(item)
        vals.sort(key=lambda x: -(x["roas"] or 0))
        d_out.append(dict(d, values=vals))
    order = {f["key"]: i for i, f in enumerate(ctx.fields)}
    d_out.sort(key=lambda d: (d["type"] == "ai", order.get(d["key"], 99), d["key"]))
    p_out = []
    for pid, v in prods.items():
        x = fin(ctx, v)
        x.update(ctx.product_info(pid))
        p_out.append(x)
    p_out.sort(key=lambda x: -x["spend"])
    peer_out = sorted([dict(slim(metrics(v)), lp=k, name=ctx.lp_name(k), current=(k == key)) for k, v in peers.items()],
                      key=lambda x: -x["spend"])
    return {"lp": key, "lp_type": t, "type_name": LP_TYPE_NAME[t], "name": ctx.lp_name(key),
            "lp_product": ctx.lp_product(key), "summary": m, "site": slim(site_m), "same_type": slim(same_m),
            "diag_site": diagnose(m, site_m, "全部落地页"), "diag_type": diagnose(m, same_m, "同类页面"),
            "assets": a_out, "dims": d_out, "fit_good": sorted(good, key=lambda x: -x["score"])[:6],
            "fit_bad": sorted(bad, key=lambda x: x["score"])[:6], "products": p_out, "peers": peer_out,
            "type_names": LP_TYPE_NAME, "window": ctx.window()}


def lp_meta_put(c, body):
    lp = (body.get("lp") or "").strip()
    if not lp:
        raise ApiError("缺少落地页")
    t = body.get("type") or ""
    if t and t not in LP_TYPE_NAME:
        raise ApiError("未知的落地页类型")
    c.execute("INSERT INTO lp_meta(lp,name,type) VALUES(?,?,?) ON CONFLICT(lp) DO UPDATE SET name=excluded.name, type=excluded.type",
              (lp, (body.get("name") or "").strip(), t))
    c.commit()
    return {"ok": True}


SPU_STATUS = {"new": "新品", "breakout": "爆款", "decline": "衰退", "hot": "热卖", "potential": "潜力", "steady": "平稳"}


def spu_overview(c, q, ctx=None):
    ctx = ctx or PerfCtx(c, q)
    total, per, first, feats = zero(), {}, {}, {}
    for r in ctx.rows:
        pid = r["_pid"]
        if not pid:
            continue
        if r["_day"]:
            first[pid] = min(first.get(pid, r["_day"]), r["_day"])
        if not (r["_f"] or r["_t"]):
            continue
        acc(per.setdefault(pid, new_agg()), r)
        if r["_f"]:
            add_to(total, r)
            if r["_akey"]:
                for dk, dn, dt, lab in ctx.labels(r):
                    cell = feats.setdefault((dk, dn, dt, lab), {}).setdefault(pid, dict(zero(), _a=set()))
                    add_to(cell, r)
                    cell["_a"].add(r["_akey"])
    tot = metrics(total)
    avg = tot["roas"]
    out = []
    for pid, g in per.items():
        x = fin(ctx, g)
        x.update(ctx.product_info(pid))
        x["first_seen"] = first.get(pid)
        fs = parse_ymd(first.get(pid))
        x["age_days"] = (ctx.end - fs).days + 1 if fs else None
        x["share"] = x["spend"] / tot["spend"] if tot["spend"] else 0
        x["rev_share"] = x["revenue"] / tot["revenue"] if tot["revenue"] else 0
        out.append(x)
    out.sort(key=lambda x: -x["revenue"])
    cum, n = 0.0, len(out) or 1
    for x in out:
        hot_zone = cum < 0.6
        cum += x["rev_share"]
        rec, pri = x["recent7"], x["prior7"]
        reasons = []
        if x["age_days"] is not None and x["age_days"] <= 14:
            st = "new"
            reasons.append("首次投放 %s，上线 %d 天" % (x["first_seen"], x["age_days"]))
        elif (x["rev_growth"] or 0) >= 0.5 and (rec["roas"] or 0) >= (avg or 0) * 0.95 and rec["revenue"] >= 100:
            st = "breakout"
            reasons.append("近7日 GMV %+.0f%%，ROAS %.2f" % (x["rev_growth"] * 100, rec["roas"]))
        elif pri["spend"] >= 50 and ((x["rev_growth"] is not None and x["rev_growth"] <= -0.25) or (x["delta_roas"] or 0) <= -0.35):
            st = "decline"
            reasons.append("近7日 GMV %s，ROAS %s → %s" % (
                "%+.0f%%" % (x["rev_growth"] * 100) if x["rev_growth"] is not None else "-",
                "%.2f" % pri["roas"] if pri["roas"] is not None else "-", "%.2f" % rec["roas"] if rec["roas"] is not None else "-"))
        elif hot_zone and (x["roas"] or 0) >= (avg or 0) * 0.8:
            st = "hot"
            reasons.append("贡献 %.0f%% GMV" % (x["rev_share"] * 100))
        elif (x["roas"] or 0) >= (avg or 0) * 1.15 and x["share"] < 1.0 / n:
            st = "potential"
            reasons.append("ROAS 高于均值 %.0f%%，消耗占比仅 %.0f%%" % (((x["roas"] or 0) / avg - 1) * 100 if avg else 0, x["share"] * 100))
        else:
            st = "steady"
        x["status"], x["status_name"], x["reason"] = st, SPU_STATUS[st], "；".join(reasons)

    # 每个 SPU 的制胜标签（素材侧宣传方向）
    by_pid = {}
    for (dk, dn, dt, lab), cells in feats.items():
        for pid, cl in cells.items():
            m = metrics(dict(cl))
            by_pid.setdefault(pid, []).append({"dim": dk, "dim_name": dn, "label": lab, "spend": m["spend"], "roas": m["roas"]})
    for x in out:
        lst = [t for t in by_pid.get(x["product_id"], []) if x["spend"] and t["spend"] >= x["spend"] * 0.1 and t["roas"] is not None]
        lst.sort(key=lambda t: -t["roas"])
        seen, top = set(), []
        for t in lst:
            if t["dim"] in seen:
                continue
            seen.add(t["dim"])
            top.append(dict(t, share=t["spend"] / x["spend"]))
            if len(top) >= 3:
                break
        x["win_tags"] = top

    # 爆品素材共性：热卖/爆款 SPU 的素材 vs 其余 SPU
    winners = {x["product_id"] for x in out if x["status"] in ("hot", "breakout")}
    if not winners and out:
        winners = {max(out, key=lambda x: x["roas"] or 0)["product_id"]}
    decliners = {x["product_id"] for x in out if x["status"] == "decline"}
    others = {x["product_id"] for x in out} - winners
    sp_of = {x["product_id"]: x["spend"] for x in out}
    W = sum(sp_of[p] for p in winners) or 1
    O = sum(sp_of[p] for p in others) or 1
    features = []
    for (dk, dn, dt, lab), cells in feats.items():
        w = zero()
        for p in winners & set(cells):
            for k in SUM_KEYS:
                w[k] += cells[p][k]
        o_sp = sum(cells[p]["spend"] for p in others & set(cells))
        wm = metrics(w)
        sw, so = w["spend"] / W, o_sp / O
        if others and sw - so >= 0.06 and (wm["roas"] or 0) >= (avg or 0):
            features.append({"dim": dk, "dim_name": dn, "label": lab, "share_win": sw, "share_other": so,
                             "roas_win": wm["roas"], "cvr_win": wm["cvr"], "spus": len(winners & set(cells)),
                             "score": (sw - so) * (wm["roas"] or 0)})
    features.sort(key=lambda x: -x["score"])

    # 衰退款素材疲劳：衰退商品的各创意标签，近7日 vs 前7日 ROAS / 消耗变化
    rec_set, pri_set = set(ctx.recent7), set(ctx.prior7)
    fat, pri_total = {}, 0.0
    for r in ctx.rows:
        if r["_pid"] not in decliners or not r["_akey"] or r["_day"] not in rec_set | pri_set:
            continue
        side = "rec" if r["_day"] in rec_set else "pri"
        if side == "pri":
            pri_total += r["spend"] or 0
        for dk, dn, dt, lab in ctx.labels(r):
            e = fat.setdefault((dk, dn, lab), {"rec": zero(), "pri": zero(), "_a": set()})
            add_to(e[side], r)
            e["_a"].add(r["_akey"])
    warn = []
    for (dk, dn, lab), e in fat.items():
        pm, rm = metrics(e["pri"]), metrics(e["rec"])
        if pm["spend"] < max(50, pri_total * 0.05) or not pm["roas"]:
            continue
        drop = (rm["roas"] or 0) / pm["roas"] - 1
        if drop <= -0.2:
            warn.append({"dim": dk, "dim_name": dn, "label": lab, "prior_roas": pm["roas"], "recent_roas": rm["roas"],
                         "drop": drop, "prior_spend": pm["spend"], "recent_spend": rm["spend"],
                         "prior_cvr": pm["cvr"], "recent_cvr": rm["cvr"], "prior_ctr": pm["ctr"], "recent_ctr": rm["ctr"],
                         "assets": len(e["_a"]), "_set": frozenset(e["_a"]), "also": [],
                         "score": pm["spend"] * -drop})
    warn.sort(key=lambda x: (-round(x["score"], 2), x["dim"] in ("material_type",), x["dim"].startswith("ai:")))
    merged = {}
    for w in warn:
        k = w.pop("_set")
        if k in merged:
            merged[k]["also"].append({"dim_name": w["dim_name"], "label": w["label"]})
        else:
            merged[k] = w
    warn = list(merged.values())

    groups = {}
    for x in out:
        gk = x["product_type"] or "未分类"
        g = groups.setdefault(gk, {"name": gk, "spus": 0, "spend": 0.0, "revenue": 0.0, "conversions": 0.0})
        g["spus"] += 1
        g["spend"] += x["spend"]
        g["revenue"] += x["revenue"]
        g["conversions"] += x["conversions"] or 0
    for g in groups.values():
        g["roas"] = g["revenue"] / g["spend"] if g["spend"] else None
    counts = {k: sum(1 for x in out if x["status"] == k) for k in SPU_STATUS}
    return {"summary": slim(tot), "products": out, "features": features[:8], "decline_features": warn[:6],
            "groups": sorted(groups.values(), key=lambda g: -g["revenue"]), "counts": counts,
            "status_names": SPU_STATUS, "window": ctx.window()}


def spu_detail(c, q):
    ctx = PerfCtx(c, q)
    try:
        pid = int(q.get("id"))
    except (TypeError, ValueError):
        raise ApiError("缺少 SPU")
    ov = spu_overview(c, q, ctx)
    me = next((x for x in ov["products"] if x["product_id"] == pid), None)
    site, g, other_n = zero(), new_agg(), {}
    assets, dims, lps = {}, {}, {}
    for r in ctx.rows:
        if r["_f"] and r["_pid"]:
            add_to(site, r)
        if r["_pid"] != pid:
            if r["_f"] and r["_pid"] and r["_akey"]:
                for dk, dn, dt, lab in ctx.labels(r):
                    cell = other_n.setdefault((dk, dn, dt, lab), dict(zero(), _p=set()))
                    add_to(cell, r)
                    cell["_p"].add(r["_pid"])
            continue
        acc(g, r)
        if r["_akey"]:
            pa = assets.get(r["_akey"])
            if pa is None:
                pa = assets[r["_akey"]] = dict(new_agg(), info=ctx.asset_info(r), _lps=set())
            acc(pa, r)
            if r["_lp"] and r["_f"]:
                pa["_lps"].add(r["_lp"])
            for dk, dn, dt, lab in ctx.labels(r):
                d = dims.setdefault(dk, {"key": dk, "name": dn, "type": dt, "values": {}})
                acc(d["values"].setdefault(lab, new_agg()), r)
        if r["_lp"]:
            acc(lps.setdefault(r["_lp"], new_agg()), r)
    m = fin(ctx, g)
    site_m = metrics(site)
    a_out, fatigue, rising = [], [], []
    for k, pa in assets.items():
        info, lp_set = pa.pop("info"), pa.pop("_lps")
        x = fin(ctx, pa)
        x.update(info)
        x["lps"] = sorted(lp_set)
        a_out.append(x)
        if x["delta_roas"] is not None and x["prior7"]["spend"] >= 30:
            if x["delta_roas"] <= -0.4:
                fatigue.append(x)
            elif x["delta_roas"] >= 0.4 and x["recent7"]["spend"] >= 30:
                rising.append(x)
    a_out.sort(key=lambda x: -x["spend"])
    d_out, brief, mine = [], [], {}
    for d in dims.values():
        vals = []
        for lab, v in d["values"].items():
            x = fin(ctx, v)
            x["label"] = lab
            x["share"] = x["spend"] / m["spend"] if m["spend"] else 0
            x["index"] = x["roas"] / m["roas"] if x["roas"] is not None and m["roas"] else None
            vals.append(x)
            mine[(d["key"], lab)] = x["share"]
        vals.sort(key=lambda x: -(x["roas"] or 0))
        ok = [v for v in vals if v["share"] >= 0.08 and v["roas"] is not None]
        if ok:
            b = ok[0]
            if (b["index"] or 0) >= 1.0:
                brief.append({"dim": d["key"], "dim_name": d["name"], "label": b["label"], "roas": b["roas"],
                              "index": b["index"], "share": b["share"], "assets": b["assets"]})
        d_out.append(dict(d, values=vals))
    order = {f["key"]: i for i, f in enumerate(ctx.fields)}
    d_out.sort(key=lambda d: (d["type"] == "ai", order.get(d["key"], 99), d["key"]))
    brief.sort(key=lambda b: (b["dim"].startswith("ai:"), order.get(b["dim"], 99)))
    o_tot = sum(v["spend"] for v in other_n.values()) or 1
    o_avg = None
    if other_n:
        sp = sum(v["spend"] for k, v in other_n.items())
        o_avg = (sum(v["revenue"] for v in other_n.values()) / sp) if sp else None
    to_test = []
    for (dk, dn, dt, lab), v in other_n.items():
        om = metrics(dict(v))
        if om["roas"] is None or not o_avg or v["spend"] < max(30, o_tot * 0.02):
            continue
        if om["roas"] >= o_avg * 1.15 and mine.get((dk, lab), 0) < 0.05:
            to_test.append({"dim": dk, "dim_name": dn, "label": lab, "roas_other": om["roas"],
                            "lift": om["roas"] / o_avg - 1, "spus": len(v["_p"]), "my_share": mine.get((dk, lab), 0)})
    to_test.sort(key=lambda x: -x["lift"])
    l_out = []
    for k, v in lps.items():
        x = fin(ctx, v)
        x.update(lp=k, lp_type=ctx.lp_type(k), name=ctx.lp_name(k))
        l_out.append(x)
    l_out.sort(key=lambda x: -x["spend"])
    peers = [dict(x) for x in ov["products"] if me and x["product_type"] == me["product_type"]]
    for x in peers:
        x.pop("trend_30", None)
    return {"product": ctx.product_info(pid), "status": me, "summary": m, "site": slim(site_m),
            "diag": diagnose(m, site_m, "全部 SPU"), "assets": a_out, "dims": d_out, "brief": brief,
            "to_test": to_test[:6], "fatigue": sorted(fatigue, key=lambda x: x["delta_roas"])[:5],
            "rising": sorted(rising, key=lambda x: -x["delta_roas"])[:5], "lps": l_out, "peers": peers,
            "type_names": LP_TYPE_NAME, "window": ctx.window()}


def decode_ad_name(c, ad_name):
    mt = Matcher(c)
    a, how, extra = mt.match(ad_name, [])
    res = {"match": how, "fields": []}
    if a:
        res["asset"] = {k: a[k] for k in ("id", "short_name", "full_name", "thumb", "media_type")}
        values, tags = a["values"], a["ai_tags"]
    elif extra:
        res["short"] = extra["short"]
        values, tags = extra["values"], []
    else:
        return res
    for f in mt.fields:
        if f["type"] == "ai_tags":
            res["fields"].append({"name": f["name_cn"], "value": "、".join(
                "%s:%s" % (t.get("category"), t.get("cn")) for t in tags if t.get("enabled", True)) or None})
        else:
            res["fields"].append({"name": f["name_cn"], "value": value_label(f, values.get(f["key"]))})
    return res


# ---------------------------------------------------------------- demo

def svg_uri(text, sub, color):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400"><rect width="100%%" height="100%%" fill="%s"/>'
           '<text x="50%%" y="46%%" font-size="34" text-anchor="middle" fill="#fff" font-family="Arial" font-weight="bold">%s</text>'
           '<text x="50%%" y="58%%" font-size="20" text-anchor="middle" fill="#fff" font-family="Arial">%s</text></svg>') % (color, text, sub)
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


def seed_demo(c):
    s = get_settings(c)
    fields = load_fields(c)
    fk = {f["key"]: f for f in fields}
    rnd = random.Random(42)
    c.execute("DELETE FROM perf WHERE source='demo'")
    c.execute("DELETE FROM assets WHERE description='演示素材' AND filename LIKE 'demo\\_%' ESCAPE '\\'")
    # (SPU, 标题, 颜色, 品类, 客单价, 生命周期)
    demo_products = [("FI-20250489", "Ice Silk Stretch Yoga Pants", "#6c5ce7", "下装", 42, "breakout"),
                     ("FI-20250512", "Breathable Linen Shirt", "#00b894", "上装", 62, "hot"),
                     ("FI-20250533", "Wrinkle-Free Business Blazer", "#2d3436", "外套", 68, "decline"),
                     ("FI-20250601", "Cooling Quick-Dry Sports Tee", "#0984e3", "上装", 32, "steady"),
                     ("FI-20250688", "Seamless Shaping Bodysuit", "#e84393", "内衣", 48, "new")]
    prods = []
    for spu, title, color, ptype, aov, life in demo_products:
        upsert_product(c, "demo", spu, spu, title, spu.lower(), [svg_uri(spu, title[:18], color)], ptype,
                       "https://demo-store.com/products/" + spu.lower())
        p = c.execute("SELECT * FROM products WHERE source='demo' AND external_id=?", (spu,)).fetchone()
        prods.append((p, aov, life))
    directions = [("折扣促销", "Discount"), ("多品展示", "MultiProduct"), ("单品卖点", "SingleFocus"), ("场景种草", "Lifestyle")]
    tag_pool = [("人物", "女性", "Female"), ("人物", "男性", "Male"), ("主色调", "黑色", "Black"), ("主色调", "白色", "White"),
                ("主色调", "卡其", "Khaki"), ("景别", "特写", "CloseUp"), ("景别", "全身", "FullBody"),
                ("开头钩子", "痛点提问", "PainQuestion"), ("开头钩子", "效果对比", "BeforeAfter"), ("口播", "有口播", "Voiceover")]
    boost = {"Gym": 1.3, "Commute": 1.15, "Studio": 0.85, "Resort": 1.05, "Stretch": 1.25, "Cooling": 1.15, "Premium": 0.85,
             "Shoot-MP": 1.2, "AI-PD": 0.8, "Remix": 1.05, "Female": 1.05, "Voiceover": 1.08}
    # 创意方向 × 落地页类型 的适配系数（作用于加购率）
    fit = {"Discount": {"product": 1.35, "collection": 1.0, "home": 0.72, "page": 1.15},
           "MultiProduct": {"product": 0.78, "collection": 1.45, "home": 1.1, "page": 1.2},
           "SingleFocus": {"product": 1.25, "collection": 0.85, "home": 0.8, "page": 0.95},
           "Lifestyle": {"product": 0.95, "collection": 0.95, "home": 1.4, "page": 1.05}}
    colors = {"image": "#e17055", "video": "#6c5ce7", "gif": "#fdcb6e"}
    created = []
    for i in range(48):
        p, aov, life = prods[i % len(prods)] if i < 10 else rnd.choice(prods)
        mtype = rnd.choice(["video", "video", "video", "image", "gif"])
        seq = next_seq(c)
        vals = {"spu": {"product_id": p["id"], "spu": p["spu"], "title": p["title"], "source": "demo"}}
        for key in ("expression", "selling_point", "scene"):
            if key in fk and fk[key]["values"]:
                vals[key] = enum_value(rnd.choice(fk[key]["values"]), "demo")
        if "material_type" in fk:
            v = enum_pick(fk["material_type"], MEDIA_CODE[mtype][0])
            if v:
                vals["material_type"] = enum_value(v, "file")
        if "designer" in fk and fk["designer"]["values"]:
            vals["designer"] = enum_value(rnd.choice(fk["designer"]["values"]), "demo")
        if "date" in fk:
            back = rnd.randint(2, 9) if life == "new" else rnd.randint(20, 60)
            vals["date"] = {"date": (datetime.date.today() - datetime.timedelta(days=back)).strftime("%y%m%d")}
        if "version" in fk:
            vals["version"] = {"n": rnd.choice([1, 1, 1, 2, 3])}
        dcn, den = directions[i % 4] if i < 8 else rnd.choice(directions)
        cats = rnd.sample(sorted({t[0] for t in tag_pool}), 2)
        tags = [{"category": "创意方向", "cn": dcn, "en": den, "enabled": True}] + \
               [{"category": t[0], "cn": t[1], "en": t[2], "enabled": True}
                for t in (rnd.choice([x for x in tag_pool if x[0] == cat]) for cat in cats)]
        full, short = names_for(c, s, fields, {"id": 0, "seq": seq}, vals, tags)
        thumb = svg_uri(MEDIA_CODE[mtype][0], short, colors[mtype])
        cur = c.execute("""INSERT INTO assets(seq,filename,ext,media_type,file_path,size,thumb,product_id,values_json,ai_tags_json,
                           description,full_name,short_name,media_ids,status,created_at,updated_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (seq, "demo_%02d.%s" % (i, {"video": "mp4", "image": "jpg", "gif": "gif"}[mtype]),
                         {"video": "mp4", "image": "jpg", "gif": "gif"}[mtype], mtype, "", 0, thumb, p["id"],
                         json.dumps(vals, ensure_ascii=False), json.dumps(tags, ensure_ascii=False),
                         "演示素材", full, short, "", "named", now(), now()))
        mult = 1.0
        for v in list(vals.values()) + tags:
            mult *= boost.get(v.get("en", ""), 1.0)
        hook = 0.26 * {"BeforeAfter": 1.4, "PainQuestion": 1.2}.get(next((t["en"] for t in tags if t["category"] == "开头钩子"), ""), 1.0)
        created.append(dict(aid=cur.lastrowid, short=short, full=full, mult=mult, handle=p["handle"], aov=aov,
                            life=life, direction=den, mtype=mtype, hook=hook,
                            remix=(vals.get("expression") or {}).get("en") == "Remix"))
    rows = []
    today = datetime.date.today()
    camps = ["ASC", "Broad", "LAL1", "Retarget"]
    shop = "https://demo-store.com"
    lp_pool = [("product", 0.40), ("/collections/summer-sale", 0.18), ("/", 0.15), ("/pages/summer-campaign", 0.15),
               ("/pages/bundle-deal", 0.12)]
    lp_base = {"product": (0.13, 0.52, 0.64), "collection": (0.085, 0.5, 0.62), "home": (0.06, 0.42, 0.6),
               "page": (0.10, 0.5, 0.66)}

    def life_factor(life, d):
        """返回 (消耗系数, 转化质量系数)；d=0 为昨天"""
        if life == "breakout":
            return 1 + 0.9 * max(0, 14 - d) / 14, 1 + 0.35 * max(0, 10 - d) / 10
        if life == "decline":
            return (0.7, 0.62) if d < 7 else (1.25, 1.12)
        if life == "hot":
            return 1.6, 1.05
        return 1.0, 1.0

    for x in created:
        nads = rnd.randint(1, 3)
        base = rnd.uniform(25, 120)
        for k in range(nads):
            camp = rnd.choice(camps)
            r0, lp = rnd.random(), None
            for path, w in lp_pool:
                r0 -= w
                if r0 <= 0:
                    lp = path
                    break
            lp = lp or "product"
            if lp == "product":
                lp = "/products/%s" % x["handle"]
            lt = lp_type("demo-store.com" + lp)
            landing = shop + lp + ("?utm_source=meta&utm_campaign=%s" % camp.lower() if rnd.random() < 0.5 else "")
            style = rnd.random()
            cid = "23%013d" % rnd.randint(0, 10 ** 12)
            if style < 0.7:
                ad_name = "US_%s_%s_%s" % (camp, x["short"], today.strftime("%m%d"))
            elif style < 0.85:
                ad_name = "US_%s_%s" % (camp, x["full"])
            else:
                ad_name = "US_%s_Creative%d" % (camp, x["aid"])
                c.execute("UPDATE assets SET media_ids=? WHERE id=?", (cid, x["aid"]))
            wave = (x["aid"] * 7 + k) % 12
            f_fit = fit[x["direction"]][lt] * (1.15 if x["remix"] and lt == "collection" else 1.0)
            atc_b, co_b, pur_b = lp_base[lt]
            aov = x["aov"] * (1.3 if "bundle" in lp else 1.0)
            for d in range(30):
                if x["life"] == "new" and d >= 10:
                    continue
                recent = d < 7
                t_sp = t_q = 1.0
                if wave < 3:
                    t_sp, t_q = (1.4, 1.3) if recent else (0.9, 0.92)
                elif wave >= 10:
                    t_sp, t_q = (0.75, 0.6) if recent else (1.1, 1.15)
                l_sp, l_q = life_factor(x["life"], d)
                sp = max(0.0, base * rnd.uniform(0.65, 1.35) / nads * t_sp * l_sp)
                imp = sp / rnd.uniform(8, 14) * 1000
                video = x["mtype"] == "video"
                hook = x["hook"] * rnd.uniform(0.85, 1.15) if video else 0
                ctr = 0.0135 * (x["mult"] ** 0.5) * ((hook / 0.26) ** 0.5 if video else 0.92) * rnd.uniform(0.85, 1.15)
                clk = imp * ctr
                q = (x["mult"] ** 0.5) * f_fit * t_q * l_q
                atc = clk * atc_b * q * rnd.uniform(0.85, 1.15)
                co = atc * co_b * rnd.uniform(0.9, 1.1)
                conv = co * pur_b * rnd.uniform(0.9, 1.1)
                rev = conv * aov * rnd.uniform(0.9, 1.1)
                v3 = imp * hook
                renamed = style < 0.2 and d < 5
                rows.append({"date": (today - datetime.timedelta(days=d + 1)).isoformat(), "ad_id": "demo%d_%d" % (x["aid"], k),
                             "ad_name": ("US_%s_Refresh%d" % (camp, k)) if renamed else ad_name, "creative_id": cid,
                             "media_keys": [cid], "landing_page": landing, "spend": round(sp, 2),
                             "impressions": round(imp), "clicks": round(clk), "atc": round(atc, 1), "checkout": round(co, 1),
                             "conversions": round(conv, 2), "revenue": round(rev, 2), "v3s": round(v3),
                             "thruplay": round(v3 * rnd.uniform(0.22, 0.38))})
    for j in range(3):
        for d in range(10):
            rows.append({"date": (today - datetime.timedelta(days=d + 1)).isoformat(), "ad_id": "demo_unk%d" % j,
                         "ad_name": "US_Test_OldCreative_%d" % j, "creative_id": "", "media_keys": [],
                         "landing_page": shop + "/collections/new-arrivals", "spend": round(rnd.uniform(5, 30), 2),
                         "impressions": 1500, "clicks": 20, "atc": 2, "checkout": 1.2, "conversions": 1, "revenue": 40})
    c.commit()
    insert_perf(c, rows, "demo")
    return {"products": len(prods), "assets": len(created), "perf_rows": len(rows)}


# ---------------------------------------------------------------- routes

def r_state(h, c, q):
    s = get_settings(c)
    pub = {k: v for k, v in s.items() if k not in SECRET_KEYS}
    for k in SECRET_KEYS:
        pub[k + "_set"] = bool(s.get(k))
    fields = load_fields(c)
    return {"settings": pub, "fields": fields, "short_layout": short_layout(s, fields), "readonly": READONLY,
            "counts": {"products": c.execute("SELECT COUNT(*) FROM products").fetchone()[0],
                       "assets": c.execute("SELECT COUNT(*) FROM assets").fetchone()[0],
                       "perf": c.execute("SELECT COUNT(*) FROM perf").fetchone()[0]}}


def r_settings(h, c, q):
    body = h.json()
    for k, v in body.items():
        if k not in DEFAULT_SETTINGS or k == "seq_counter":
            continue
        if k in SECRET_KEYS and not v:
            continue
        if k == "separator" and not v:
            raise ApiError("分隔符不能为空")
        set_setting(c, k, v)
    c.commit()
    return r_state(h, c, q)


def r_field_add(h, c, q):
    b = h.json()
    t = b.get("type") or "enum"
    if t not in FIELD_TYPES:
        raise ApiError("未知字段类型")
    if t in ("product", "ai_tags", "version") and c.execute("SELECT 1 FROM fields WHERE type=?", (t,)).fetchone():
        raise ApiError("该类型字段只能有一个")
    if not (b.get("name_cn") or "").strip():
        raise ApiError("请填写字段名称")
    key = re.sub(r"[^a-z0-9_]", "", re.sub(r"[\s\-]+", "_", (b.get("key") or b.get("name_en") or "").strip().lower()))
    if not key or c.execute("SELECT 1 FROM fields WHERE key=?", (key,)).fetchone():
        key = (key or "field") + "_" + b36(random.randint(36 ** 2, 36 ** 3))
        key = key.lower()
    pos = c.execute("SELECT COALESCE(MAX(position),0)+1 FROM fields").fetchone()[0]
    c.execute("INSERT INTO fields(key,name_cn,name_en,type,position,in_short,description) VALUES(?,?,?,?,?,?,?)",
              (key, b["name_cn"].strip(), b.get("name_en", ""), t, pos,
               int(bool(b.get("in_short"))) if t in SHORT_TYPES else 0, b.get("description", "")))
    c.commit()
    return r_state(h, c, q)


def r_field_put(h, c, q, fid):
    b = h.json()
    f = c.execute("SELECT * FROM fields WHERE id=?", (fid,)).fetchone()
    if not f:
        raise ApiError("字段不存在", 404)
    for k in ("name_cn", "name_en", "description"):
        if k in b:
            c.execute("UPDATE fields SET %s=? WHERE id=?" % k, (b[k], fid))
    if "in_short" in b:
        c.execute("UPDATE fields SET in_short=? WHERE id=?", (int(bool(b["in_short"])) if f["type"] in SHORT_TYPES else 0, fid))
    c.commit()
    return r_state(h, c, q)


def r_field_del(h, c, q, fid):
    c.execute("DELETE FROM fields WHERE id=?", (fid,))
    c.commit()
    return r_state(h, c, q)


def r_field_order(h, c, q):
    for i, fid in enumerate(h.json().get("ids") or []):
        c.execute("UPDATE fields SET position=? WHERE id=?", (i, fid))
    c.commit()
    return r_state(h, c, q)


def check_code(c, fid, code, vid, w):
    code = (code or "").upper().strip()
    if not re.fullmatch(r"[A-Z0-9]{%d}" % w, code):
        raise ApiError("短码必须是 %d 位字母或数字" % w)
    if code == "X" * w:
        raise ApiError("%s 为保留的空值码" % code)
    dup = c.execute("SELECT 1 FROM field_values WHERE field_id=? AND upper(code)=? AND id<>?", (fid, code, vid or 0)).fetchone()
    if dup:
        raise ApiError("短码 %s 在该字段中已被使用" % code)
    return code


def r_value_add(h, c, q, fid):
    b = h.json()
    s = get_settings(c)
    w = code_width(s)
    if not (b.get("cn") or b.get("en")):
        raise ApiError("请至少填写中文或英文值")
    f = next((x for x in load_fields(c) if str(x["id"]) == str(fid)), None)
    if not f:
        raise ApiError("字段不存在", 404)
    cn, en, sug, how = complete_value(s, f, b.get("cn"), clean_seg(b.get("en") or "", s["separator"]))
    code = check_code(c, fid, b["code"], None, w) if b.get("code") else code_for(s, f, en, cn, sug)
    pos = c.execute("SELECT COALESCE(MAX(position),0)+1 FROM field_values WHERE field_id=?", (fid,)).fetchone()[0]
    cur = c.execute("INSERT INTO field_values(field_id,cn,en,code,description,position,source) VALUES(?,?,?,?,?,?,?)",
                    (fid, cn, en, code, b.get("description", ""), pos, b.get("source") or "manual"))
    c.commit()
    st = r_state(h, c, q)
    st["created"] = dict(c.execute("SELECT * FROM field_values WHERE id=?", (cur.lastrowid,)).fetchone())
    st["completed"] = how
    return st


def needs_completion(v):
    return not v["cn"] or not v["en"] or bool(CJK.search(v["en"] or ""))


def r_values_complete(h, c, q):
    """补全只有中文或只有英文的已有值，并为它们重算有含义的短码"""
    s = get_settings(c)
    changed = []
    for f in load_fields(c):
        if f["type"] != "enum":
            continue
        for v in f["values"]:
            if not needs_completion(v):
                continue
            cn_in = v["cn"] if CJK.search(v["cn"] or "") else ""
            en_in = "" if CJK.search(v["en"] or "") else v["en"]
            if not cn_in and not en_in:
                cn_in, en_in = v["cn"], ""
            cn, en, sug, how = complete_value(s, f, cn_in, en_in)
            if not how:
                continue
            code = v["code"]
            if re.fullmatch(r"Z[0-9A-Z]", code or "") or not code:
                code = code_for(s, f, en, cn, sug, exclude_id=v["id"])
            c.execute("UPDATE field_values SET cn=?, en=?, code=? WHERE id=?", (cn, en, code, v["id"]))
            v.update({"cn": cn, "en": en, "code": code})
            changed.append({"field": f["name_cn"], "cn": cn, "en": en, "code": code, "how": how})
    c.commit()
    if changed:
        rebuild_all(c, keep_history=True)
    st = r_state(h, c, q)
    st["changed"] = changed
    return st


def r_value_put(h, c, q, vid):
    b = h.json()
    s = get_settings(c)
    v = c.execute("SELECT * FROM field_values WHERE id=?", (vid,)).fetchone()
    if not v:
        raise ApiError("值不存在", 404)
    if "code" in b:
        c.execute("UPDATE field_values SET code=? WHERE id=?", (check_code(c, v["field_id"], b["code"], vid, code_width(s)), vid))
    if "en" in b:
        c.execute("UPDATE field_values SET en=? WHERE id=?", (clean_seg(b["en"], s["separator"]), vid))
    for k in ("cn", "description"):
        if k in b:
            c.execute("UPDATE field_values SET %s=? WHERE id=?" % k, (b[k], vid))
    c.commit()
    return r_state(h, c, q)


def r_value_del(h, c, q, vid):
    c.execute("DELETE FROM field_values WHERE id=?", (vid,))
    c.commit()
    return r_state(h, c, q)


def r_value_order(h, c, q, fid):
    for i, vid in enumerate(h.json().get("ids") or []):
        c.execute("UPDATE field_values SET position=? WHERE id=? AND field_id=?", (i, vid, fid))
    c.commit()
    return r_state(h, c, q)


def r_spec_export(h, c, q):
    s = get_settings(c)
    return {"settings": {k: s[k] for k in ("separator", "name_lang", "code_width", "ai_tags_in_name",
                                            "ai_tags_max", "ai_tag_joiner")},
            "fields": [{"key": f["key"], "name_cn": f["name_cn"], "name_en": f["name_en"], "type": f["type"],
                        "in_short": f["in_short"], "description": f["description"],
                        "values": [{"cn": v["cn"], "en": v["en"], "code": v["code"], "description": v["description"]}
                                   for v in f["values"]]} for f in load_fields(c)]}


def r_spec_import(h, c, q):
    b = h.json()
    if not isinstance(b.get("fields"), list):
        raise ApiError("文件格式不正确")
    load_spec(c, b["fields"])
    for k, v in (b.get("settings") or {}).items():
        if k in DEFAULT_SETTINGS:
            set_setting(c, k, v)
    c.commit()
    return r_state(h, c, q)


def r_products(h, c, q):
    rows = list_products(c)
    kw = (q.get("q") or "").lower()
    if kw:
        rows = [p for p in rows if kw in (p["title"] or "").lower() or kw in (p["spu"] or "").lower()]
    for p in rows:
        p["images"] = json.loads(p.pop("images_json") or "[]")
    return rows


def r_product_add(h, c, q):
    b = h.json()
    if not b.get("spu"):
        raise ApiError("请填写 SPU")
    upsert_product(c, "manual", b["spu"], b["spu"], b.get("title") or b["spu"], "", [b["image_url"]] if b.get("image_url") else [], "", "")
    c.commit()
    return {"ok": True}


def r_product_put(h, c, q, pid):
    b = h.json()
    if "spu" in b:
        c.execute("UPDATE products SET spu=?, spu_manual=1 WHERE id=?", (b["spu"].strip(), pid))
    if "title" in b:
        c.execute("UPDATE products SET title=? WHERE id=?", (b["title"], pid))
    c.commit()
    return {"ok": True}


def r_product_del(h, c, q, pid):
    if pid == "all":
        c.execute("DELETE FROM products WHERE source=?", (q.get("source") or "",)) if q.get("source") else c.execute("DELETE FROM products")
    else:
        c.execute("DELETE FROM products WHERE id=?", (pid,))
    c.commit()
    return {"ok": True}


def r_sync_shopify(h, c, q):
    return sync_shopify(c, h.json().get("domain"))


def r_sync_meta(h, c, q):
    return sync_meta_catalog(c, h.json().get("catalog_id"))


def r_assets(h, c, q):
    return [asset_row(r, light=True) for r in c.execute("SELECT * FROM assets ORDER BY id DESC")]


def r_asset_get(h, c, q, aid):
    return get_asset(c, aid)


def r_upload(h, c, q):
    fn = os.path.basename(q.get("filename") or "file")
    data = h.body()
    if not data:
        raise ApiError("空文件")
    mtype = media_type_of(fn, q.get("media_type", ""))
    seq = next_seq(c)
    ext = os.path.splitext(fn)[1].lower()
    cur = c.execute("INSERT INTO assets(seq,filename,ext,media_type,size,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (seq, fn, ext.lstrip("."), mtype, len(data), "uploaded", now(), now()))
    aid = cur.lastrowid
    path = os.path.join(UPLOADS, "%d%s" % (aid, ext))
    with open(path, "wb") as fp:
        fp.write(data)
    s = get_settings(c)
    fields = load_fields(c)
    asset = {"media_type": mtype, "filename": fn}
    product = match_product_by_filename(list_products(c), fn)
    vals = default_values(c, s, fields, asset, product)
    full, short = names_for(c, s, fields, {"id": aid, "seq": seq}, vals, [])
    c.execute("UPDATE assets SET file_path=?, values_json=?, product_id=?, full_name=?, short_name=? WHERE id=?",
              (path, json.dumps(vals, ensure_ascii=False), product["id"] if product else None, full, short, aid))
    c.commit()
    return get_asset(c, aid)


def r_analyze(h, c, q, aid):
    b = h.json()
    if b.get("thumb"):
        c.execute("UPDATE assets SET thumb=? WHERE id=?", (b["thumb"], aid))
        c.commit()
    return analyze_asset(c, int(aid), b.get("frames") or [])


def r_preview(h, c, q):
    b = h.json()
    s = get_settings(c)
    fields = load_fields(c)
    cur = c.execute("SELECT id, seq, short_name FROM assets WHERE id=?", (b.get("id") or 0,)).fetchone()
    asset = dict(cur) if cur else {"id": 0, "seq": b.get("seq") or 0}
    full, short = names_for(c, s, fields, asset, b.get("values") or {}, b.get("ai_tags") or [])
    dup = [dict(r) for r in c.execute("SELECT id, short_name FROM assets WHERE full_name=? AND id<>?", (full, b.get("id") or 0))]
    return {"full_name": full, "short_name": short, "duplicates": dup}


def r_asset_put(h, c, q, aid):
    b = h.json()
    a = get_asset(c, aid)
    s = get_settings(c)
    fields = load_fields(c)
    values = b.get("values", a["values"])
    tags = b.get("ai_tags", a["ai_tags"])
    full, short = names_for(c, s, fields, a, values, tags)
    pf = next((f for f in fields if f["type"] == "product"), None)
    pid = (values.get(pf["key"]) or {}).get("product_id") if pf else a["product_id"]
    media_ids = b.get("media_ids", a["media_ids"])
    if isinstance(media_ids, str):
        media_ids = [x.strip() for x in re.split(r"[,\s，]+", media_ids) if x.strip()]
    c.execute("UPDATE assets SET values_json=?, ai_tags_json=?, product_id=?, description=?, full_name=?, short_name=?, "
              "short_history=?, media_ids=?, status=?, updated_at=? WHERE id=?",
              (json.dumps(values, ensure_ascii=False), json.dumps(tags, ensure_ascii=False), pid,
               b.get("description", a["description"]), full, short, history_after(a, short), ",".join(media_ids),
               b.get("status") or "named", now(), aid))
    c.commit()
    return get_asset(c, aid)


def r_assets_rebuild(h, c, q):
    return {"updated": rebuild_all(c, keep_history=True)}


def r_asset_del(h, c, q, aid):
    a = get_asset(c, aid)
    if a.get("file_path") and os.path.exists(a["file_path"]):
        os.remove(a["file_path"])
    c.execute("DELETE FROM assets WHERE id=?", (aid,))
    c.commit()
    return {"ok": True}


def r_assets_csv(h, c, q):
    fields = load_fields(c)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["短名称", "完整命名", "原文件名"] + [f["name_cn"] for f in fields] + ["媒体素材ID", "描述"])
    for r in c.execute("SELECT * FROM assets ORDER BY id"):
        a = asset_row(r, light=True)
        row = [a["short_name"], a["full_name"], a["filename"]]
        for f in fields:
            if f["type"] == "ai_tags":
                row.append("、".join("%s:%s" % (t.get("category"), t.get("cn")) for t in a["ai_tags"] if t.get("enabled", True)))
            else:
                row.append(value_label(f, a["values"].get(f["key"])) or "")
        row += [",".join(a["media_ids"]), a["description"]]
        w.writerow(row)
    h.send(200, "\ufeff" + buf.getvalue(), "text/csv; charset=utf-8",
           {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote("命名规范表.csv")})


def r_file(h, c, q, aid):
    a = get_asset(c, aid)
    if not a.get("file_path") or not os.path.exists(a["file_path"]):
        raise ApiError("文件不存在", 404)
    with open(a["file_path"], "rb") as fp:
        data = fp.read()
    headers = {}
    if q.get("download"):
        name = (a["full_name"] or os.path.splitext(a["filename"])[0]) + (("." + a["ext"]) if a["ext"] else "")
        headers["Content-Disposition"] = "attachment; filename*=UTF-8''%s" % urllib.parse.quote(name)
    h.send(200, data, mimetypes.guess_type(a["file_path"])[0] or "application/octet-stream", headers)


def r_import_csv(h, c, q):
    b = h.json()
    return import_csv(c, b.get("text") or "", b.get("source") or "csv")


def r_pull_meta(h, c, q):
    b = h.json()
    return pull_meta(c, b.get("since"), b.get("until"))


def r_perf_del(h, c, q):
    c.execute("DELETE FROM perf")
    c.commit()
    return {"ok": True}


def r_analytics(h, c, q):
    return analytics(c, q)


def r_lp_overview(h, c, q):
    return lp_overview(c, q)


def r_lp_detail(h, c, q):
    return lp_detail(c, q)


def r_lp_meta(h, c, q):
    return lp_meta_put(c, h.json())


def r_spu_overview(h, c, q):
    return spu_overview(c, q)


def r_spu_detail(h, c, q):
    return spu_detail(c, q)


def r_decode(h, c, q):
    return decode_ad_name(c, h.json().get("ad_name") or "")


def r_demo(h, c, q):
    return seed_demo(c)


def r_demo_clear(h, c, q):
    c.execute("DELETE FROM perf WHERE source='demo'")
    c.execute("DELETE FROM assets WHERE filename LIKE 'demo\\_%' ESCAPE '\\' AND file_path=''")
    c.execute("DELETE FROM products WHERE source='demo'")
    c.commit()
    return {"ok": True}


ROUTES = [
    ("GET", r"/api/state", r_state),
    ("PUT", r"/api/settings", r_settings),
    ("POST", r"/api/fields", r_field_add),
    ("POST", r"/api/fields/order", r_field_order),
    ("PUT", r"/api/fields/(\d+)", r_field_put),
    ("DELETE", r"/api/fields/(\d+)", r_field_del),
    ("POST", r"/api/fields/(\d+)/values", r_value_add),
    ("POST", r"/api/fields/(\d+)/values/order", r_value_order),
    ("POST", r"/api/values/complete", r_values_complete),
    ("PUT", r"/api/values/(\d+)", r_value_put),
    ("DELETE", r"/api/values/(\d+)", r_value_del),
    ("GET", r"/api/spec/export", r_spec_export),
    ("POST", r"/api/spec/import", r_spec_import),
    ("GET", r"/api/products", r_products),
    ("POST", r"/api/products", r_product_add),
    ("POST", r"/api/products/sync/shopify", r_sync_shopify),
    ("POST", r"/api/products/sync/meta", r_sync_meta),
    ("PUT", r"/api/products/(\d+)", r_product_put),
    ("DELETE", r"/api/products/(\w+)", r_product_del),
    ("GET", r"/api/assets", r_assets),
    ("GET", r"/api/assets/export\.csv", r_assets_csv),
    ("POST", r"/api/assets/upload", r_upload),
    ("POST", r"/api/assets/rebuild", r_assets_rebuild),
    ("POST", r"/api/names/preview", r_preview),
    ("GET", r"/api/assets/(\d+)", r_asset_get),
    ("POST", r"/api/assets/(\d+)/analyze", r_analyze),
    ("PUT", r"/api/assets/(\d+)", r_asset_put),
    ("DELETE", r"/api/assets/(\d+)", r_asset_del),
    ("GET", r"/files/(\d+)", r_file),
    ("POST", r"/api/perf/import_csv", r_import_csv),
    ("POST", r"/api/perf/pull_meta", r_pull_meta),
    ("DELETE", r"/api/perf", r_perf_del),
    ("GET", r"/api/analytics", r_analytics),
    ("GET", r"/api/analytics/lp", r_lp_overview),
    ("GET", r"/api/analytics/lp/detail", r_lp_detail),
    ("PUT", r"/api/lp_meta", r_lp_meta),
    ("GET", r"/api/analytics/spu", r_spu_overview),
    ("GET", r"/api/analytics/spu/detail", r_spu_detail),
    ("POST", r"/api/decode", r_decode),
    ("POST", r"/api/demo/seed", r_demo),
    ("DELETE", r"/api/demo", r_demo_clear),
]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def json(self):
        b = self.body()
        return json.loads(b.decode("utf-8")) if b else {}

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if READONLY and method != "GET" and u.path not in READONLY_ALLOW:
            return self.send(403, {"error": "这是只读分享链接，不能修改数据"})
        c = connect()
        try:
            for m, pat, fn in ROUTES:
                if m != method:
                    continue
                mm = re.fullmatch(pat, u.path)
                if mm:
                    res = fn(self, c, q, *mm.groups())
                    if res is not None:
                        self.send(200, res)
                    return
            if method == "GET":
                return self.static(u.path)
            self.send(404, {"error": "not found"})
        except ApiError as e:
            self.send(e.code, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self.send(500, {"error": "%s: %s" % (type(e).__name__, e)})
        finally:
            c.close()

    def static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self.send(404, {"error": "not found"})
        with open(full, "rb") as fp:
            self.send(200, fp.read(), (mimetypes.guess_type(full)[0] or "application/octet-stream") + "; charset=utf-8")


if __name__ == "__main__":
    init_db()
    host = os.environ.get("HOST", "127.0.0.1")
    srv = ThreadingHTTPServer((host, PORT), Handler)
    print("创意洞察已启动: http://%s:%d%s" % (host, PORT, "（只读）" if READONLY else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
