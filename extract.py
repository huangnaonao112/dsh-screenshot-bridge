"""screenshot-bridge · 题面提取器（无模型、无人工）

用法：
    python extract.py <png 路径>
输出（stdout 一行 JSON）：
    {"ok":true,"mode":"list","text":"...","questions":[...],"stats":{...}}
    {"ok":false,"reason":"...","stats":{...}}

调用方（Host）只需要读 stdout，不关心实现。退出码 0 表示"跑完了"（ok 可能仍为 false）。
"""

import json
import math
import re
import statistics
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
    from rapidocr import RapidOCR
except Exception as exc:  # 没装引擎时不要抛栈，交给调用方降级
    json.dump({"ok": False, "reason": f"engine-unavailable: {exc.__class__.__name__}"}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(2)

# ---------- 题号 / 选项的候选写法（封闭集合，靠本图投票选一个） ----------
STEM_CANDIDATES = {
    "数字顿号": (re.compile(r"^(\d{1,2})\s*[、.．]\s*"), lambda m: int(m.group(1))),
    "括号数字": (re.compile(r"^[（(]\s*(\d{1,2})\s*[)）]\s*"), lambda m: int(m.group(1))),
    "数字右括号": (re.compile(r"^(\d{1,2})\s*[)）]\s*"), lambda m: int(m.group(1))),
    "第N题": (re.compile(r"^第\s*(\d{1,2})\s*[题道]\s*[、.．:：]?\s*"), lambda m: int(m.group(1))),
    "圈号": (re.compile(r"^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*"),
            lambda m: "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳".index(m.group(1)) + 1),
}
OPT_CANDIDATES = {
    "字母点": (re.compile(r"^([A-Fa-f])\s*[.．、]\s*"), 1),
    "括号字母": (re.compile(r"^[（(]\s*([A-Fa-f])\s*[)）]\s*"), 1),
    "字母右括号": (re.compile(r"^([A-Fa-f])\s*[)）]\s*"), 1),
    "圈字母": (re.compile(r"^([ⒶⒷⒸⒹⒺⒻ])\s*"), 1),
}
SECTION_PAT = re.compile(r"^([一二三四五六七八九十]{1,3})\s*[、.．]\s*")
SECTION_WORDS = ("单选", "多选", "判断", "填空", "简答", "问答", "编程", "论述", "计算",
                 "名词解释", "综合", "案例", "分析")
CODE = re.compile(r"(^[#/{}]|^int\s|^return\s|^printf|^#include|^void\s|^//|^/*)")


def cjk_ratio(s):
    return sum(1 for c in s if "\u4e00" <= c <= "\u9fff") / max(1, len(s))


def dominant_height(rows):
    hs = [r["y2"] - r["y"] for r in rows if r["y2"] - r["y"] >= 6]
    if not hs:
        return 18
    best_v, best_c = None, -1
    for v in sorted(set(hs)):
        c = sum(1 for h in hs if abs(h - v) <= 2)
        if c > best_c:
            best_v, best_c = v, c
    return best_v


def anchor_height(rows):
    body = [r for r in rows
            if not (SECTION_PAT.match(r["text"]) and any(w in r["text"] for w in SECTION_WORDS))]
    return dominant_height(body)


def strip_chrome_fragments(rows, lh):
    """A) 一行被切成 ≥4 个超短碎片 → 工具栏/图标条；B) 同 x 连续递增的纯数字 → 行号。"""
    band_tol = max(2, round(lh * 0.2))

    def median_len(rs):
        lens = sorted(len(r["text"]) for r in rs)
        return lens[len(lens) // 2]

    keep, dropped = [], 0
    band = []

    def flush():
        nonlocal dropped
        if not band:
            return
        if len(band) >= 4 and median_len(band) <= 6:
            dropped += len(band)
            band.clear()
            return
        keep.extend(band)
        band.clear()

    for r in sorted(rows, key=lambda r: r["y"]):
        if band and r["y"] - band[0]["y"] > band_tol:
            flush()
        band.append(r)
    flush()

    nums = [r for r in keep if r["text"].isdigit() and len(r["text"]) <= 3]
    gut = set()
    for r in nums:
        same = sorted([n for n in nums if abs(n["x"] - r["x"]) <= lh * 0.5], key=lambda n: n["y"])
        if len(same) >= 3 and sum(1 for a, b in zip(same, same[1:])
                                  if int(b["text"]) - int(a["text"]) == 1) >= len(same) - 1:
            gut.update(id(n) for n in same)
    keep = [r for r in keep if id(r) not in gut]
    return keep, dropped, len(gut)


def build_lines(rows, lh):
    band_tol = max(2, round(lh * 0.2))
    merge_gap = round(lh * 3.6)
    lines, band = [], []

    def flush():
        if not band:
            return
        band.sort(key=lambda r: r["x"])
        cur = None
        for r in band:
            if cur is not None and -round(lh * 0.15) <= r["x"] - cur["x2"] <= merge_gap:
                cur["text"] += r["text"]
                cur["x2"] = max(cur["x2"], r["x2"])
                cur["y2"] = max(cur["y2"], r["y2"])
                cur["frags"].append(r)
                continue
            if cur is not None:
                lines.append(cur)
            cur = {"text": r["text"], "x": r["x"], "y": r["y"], "x2": r["x2"],
                   "y2": r["y2"], "h": r["y2"] - r["y"], "frags": [r]}
        if cur is not None:
            lines.append(cur)
        band.clear()

    for r in sorted(rows, key=lambda r: r["y"]):
        if band and r["y"] - band[0]["y"] > band_tol:
            flush()
        band.append(r)
    flush()
    lines.sort(key=lambda ln: (ln["y"], ln["x"]))
    return lines


def pick_template(lines, candidates, min_hits=2):
    best = None
    for name, (pat, numof) in candidates.items():
        hits, nums = 0, []
        for ln in lines:
            m = pat.match(ln["text"])
            if m:
                hits += 1
                try:
                    nums.append(numof(m))
                except Exception:
                    pass
        if hits < min_hits:
            continue
        mono = 1.0
        if len(nums) >= 3:
            mono = sum(1 for a, b in zip(nums, nums[1:]) if b == a + 1 or b > a) / (len(nums) - 1)
        score = hits * (0.5 + 0.5 * mono)
        if best is None or score > best[1]:
            best = (name, score, pat, numof, hits, mono)
    return best


def is_marker(t):
    return any(p.match(t) for p, _ in STEM_CANDIDATES.values()) \
        or any(p.match(t) for p, _ in OPT_CANDIDATES.values())


def sat_block(img, b):
    x1, y1, x2, y2 = b
    p = img[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
    if p.size == 0:
        return False
    hsv = cv2.cvtColor(p, cv2.COLOR_BGR2HSV)
    return hsv[:, :, 1].mean() / 255 >= 0.35 and hsv[:, :, 2].mean() / 255 >= 0.25


LABEL = __import__("re").compile(r"^[（(]?([A-Ha-h])[)）]?[、.．]?$")


def _merge(comps, gap_y):
    blocks = []
    for c in sorted(comps, key=lambda c: c["y"]):
        for b in blocks:
            overlap = min(b["x2"], c["x2"]) - max(b["x"], c["x"])
            if c["y"] - b["y2"] <= gap_y and overlap > -min(b["x2"] - b["x"], c["x2"] - c["x"]) * 0.5:
                b["x"] = min(b["x"], c["x"]); b["y"] = min(b["y"], c["y"])
                b["x2"] = max(b["x2"], c["x2"]); b["y2"] = max(b["y2"], c["y2"])
                b["ink"] += c["ink"]
                break
        else:
            blocks.append(dict(c))
    changed = True
    while changed:
        changed = False
        for i in range(len(blocks)):
            for j in range(i + 1, len(blocks)):
                a, b = blocks[i], blocks[j]
                if b["y"] - a["y2"] <= gap_y * 0.6 and min(a["x2"], b["x2"]) - max(a["x"], b["x"]) > 0:
                    a["x"] = min(a["x"], b["x"]); a["y"] = min(a["y"], b["y"])
                    a["x2"] = max(a["x2"], b["x2"]); a["y2"] = max(a["y2"], b["y2"])
                    a["ink"] += b["ink"]
                    blocks.pop(j)
                    changed = True
                    break
            if changed:
                break
    return blocks


def detect_figures(img, boxes, lh):
    """"被文字盖住的是字，抹掉字剩下的墨迹就是图" → 圈矩形。

    1) 灰度 < 190 的像素算墨迹；2) 9×9 粘合，把一块图里断开的细线连起来；
    3) 甩掉页面边框（横跨大半画面）、噪点；4) 文字覆盖率高的判为段落；
    5) 上下挨得近的并成一块；6) 挨着的 A/B/C/D 标签吞进图里并记下来。
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ink = (gray < 190).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.dilate(ink, kernel, iterations=1)
    n, _, stats, _ = cv2.connectedComponentsWithStats(closed, 8)
    H, W = img.shape[:2]

    comps = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if w < 24 or h < 12 or area < 120:
            continue
        if w > W * 0.85 or h > H * 0.85:
            continue
        ink_px = int(ink[y:y + h, x:x + w].sum())
        if ink_px < 40:
            continue
        comps.append({"x": int(x), "y": int(y), "x2": int(x + w), "y2": int(y + h), "ink": ink_px})

    figs = []
    for b in _merge(comps, gap_y=max(6, round(lh * 0.7))):
        w = b["x2"] - b["x"]; h = b["y2"] - b["y"]
        # 太小的是图标/工具栏按钮，太大的是整块白卡片，都不是题图。
        if w < 130 or h < 80 or w < lh * 2.2 or h < lh * 2.2:
            continue
        if w * h > W * H * 0.15:
            continue
        if w / h > 8 and h < lh * 4:
            continue
        covered = 0
        inside_chars = 0
        for t in boxes:
            ix = max(0, min(b["x2"], t["x2"]) - max(b["x"], t["x"]))
            iy = max(0, min(b["y2"], t["y2"]) - max(b["y"], t["y"]))
            covered += ix * iy
            # 框中心落在块里的字：图里只有坐标轴标签几个字，成段的字就是段落。
            cx = (t["x"] + t["x2"]) / 2
            cy = (t["y"] + t["y2"]) / 2
            if b["x"] <= cx <= b["x2"] and b["y"] <= cy <= b["y2"]:
                inside_chars += len(t["text"])
        if inside_chars >= 20:
            continue
        cov = covered / max(1, w * h)
        density = b["ink"] / max(1, w * h)
        # 太稀像纸张底纹，太密是实心色块/照片/深色编辑器——两种都不是题图。
        if cov > 0.30 or density < 0.02 or density > 0.45:
            continue
        b["cov"] = round(cov, 3)
        figs.append(b)

    # 选项标签：紧贴左侧（竖直有重叠）或正下方居中的单个字母，一起吞进来
    for f in figs:
        f["label"] = None
        for t in boxes:
            m = LABEL.match(t["text"].strip())
            if not m:
                continue
            cy = (f["y"] + f["y2"]) / 2
            overlap = min(f["y2"], t["y2"]) - max(f["y"], t["y"])
            left_close = 0 < f["x"] - t["x2"] < lh * 6.0 and overlap > (f["y2"] - f["y"]) * 0.4
            below = f["y2"] <= t["y"] < f["y2"] + lh * 1.2 and t["x"] >= f["x"] and t["x2"] <= f["x2"] + lh
            if left_close or below:
                f["label"] = m.group(1).upper()
                f["x"] = min(f["x"], t["x"])
                f["y"] = min(f["y"], t["y"])
                f["x2"] = max(f["x2"], t["x2"])
                f["y2"] = max(f["y2"], t["y2"])
                break
    return figs



def extract(path, engine, fig_dir=None):
    img = cv2.imread(path)
    if img is None:
        return {"ok": False, "reason": "image-unreadable"}
    res = engine(img)
    raw = []
    for box, txt, _ in zip(res.boxes, res.txts, res.scores):
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        raw.append({"x": round(min(xs)), "y": round(min(ys)), "x2": round(max(xs)),
                    "y2": round(max(ys)), "text": re.sub(r"\s+", "", str(txt))})
    if not raw:
        return {"ok": False, "reason": "no-text"}
    all_boxes = [dict(r) for r in raw]

    lh = anchor_height(raw)
    raw, chrome_n, gutter_n = strip_chrome_fragments(raw, lh)

    short = [r["text"] for r in raw if len(r["text"]) <= 14]
    cnt = {}
    for t in short:
        cnt[t] = cnt.get(t, 0) + 1
    rep_thr = max(2, math.ceil((max(cnt.values()) if cnt else 0) * 0.5))
    kept, dup = [], 0
    for r in raw:
        t = r["text"]
        if len(t) <= 14 and cnt.get(t, 0) >= rep_thr and rep_thr >= 3 \
                and not re.match(r"^[0-9A-Fa-f一二三四]", t):
            dup += 1
            continue
        kept.append(r)

    lines = build_lines(kept, lh)

    xs = sorted({ln["x"] for ln in lines})
    groups, cur = [], ([xs[0]] if xs else [])
    for x in xs[1:]:
        if x - cur[-1] <= lh * 0.6:
            cur.append(x)
        else:
            groups.append(cur)
            cur = [x]
    if cur:
        groups.append(cur)

    def stem_like(t):
        return any(p.match(t) for p, _ in STEM_CANDIDATES.values())

    cand = []
    for g in groups:
        mem = [ln for ln in lines if g[0] <= ln["x"] <= g[-1]]
        stems = sum(1 for m in mem if stem_like(m["text"]))
        cjk = sum(cjk_ratio(m["text"]) * len(m["text"]) for m in mem)
        span = (max(m["y2"] for m in mem) - min(m["y"] for m in mem)) if mem else 0
        cand.append((stems, cjk, span, mem))
    members = max(cand, key=lambda t: (t[0], t[1], t[2]))[3]
    base_x = min(m["x"] for m in members)

    stemx = [m["x"] for m in members if re.match(r"^[0-9]{1,2}\s*[、.．]", m["text"])] or [base_x]
    base_x = min(stemx)
    optpat_any = re.compile(r"^[（(]?[A-Fa-f][)）.．、]")
    offs = [ln["x"] - base_x for ln in lines if optpat_any.match(ln["text"]) and 0 < ln["x"] - base_x < lh * 8]
    if offs:
        offs.sort()
        indent = offs[max(0, int(len(offs) * 0.9) - 1)] + lh * 0.6
    else:
        indent = lh * 2.2
    indent = max(lh * 1.2, min(indent, lh * 6))

    inside = [ln for ln in lines
              if (base_x - lh * 2.0) <= ln["x"] <= base_x + indent and ln["y"] >= min(m["y"] for m in members) - lh * 0.5]
    stats = {"lines": len(lines), "chrome": chrome_n, "gutter": gutter_n, "inside": len(inside),
             "lh": round(lh, 1), "col": [base_x, round(base_x + indent)]}

    b = len(inside)
    inside = [ln for ln in inside if ln["h"] >= lh * 0.72 or is_marker(ln["text"])]
    stats["small"] = b - len(inside)

    def codeish(s):
        return bool(CODE.search(s) or re.search(r"[;{}#]|^\s*[a-zA-Z_]\w*\s*\(|^\s*[a-zA-Z_]\w*\s*=\s*", s))

    b = len(inside)
    inside = [ln for ln in inside
              if is_marker(ln["text"]) or not (cjk_ratio(ln["text"]) < 0.25 and codeish(ln["text"]))]
    stats["code"] = b - len(inside)

    b = len(inside)
    inside = [ln for ln in inside
              if not all(sat_block(img, (f["x"], f["y"], f["x2"], f["y2"])) for f in ln["frags"])]
    stats["button"] = b - len(inside)
    stats["dup"] = dup

    stem_t = pick_template(inside, STEM_CANDIDATES, min_hits=2) \
        or pick_template(inside, STEM_CANDIDATES, min_hits=1)
    opt_t = pick_template(inside, OPT_CANDIDATES, min_hits=2) \
        or pick_template(inside, OPT_CANDIDATES, min_hits=1)
    n_stem = stem_t[4] if stem_t else 0
    list_mode = n_stem >= 1
    stats["stem"] = f"{stem_t[0]}({n_stem})" if stem_t else None
    stats["opt"] = opt_t[0] if opt_t else None

    inside.sort(key=lambda ln: (ln["y"], ln["x"]))
    if __import__("os").environ.get("EXTRACT_DEBUG"):
        import sys as _sys
        print(f"[debug] col x={base_x} indent={indent:.0f} lh={lh:.1f} inside={len(inside)}", file=_sys.stderr)
        for ln in inside:
            print(f"[debug]   y={ln['y']:4d} x={ln['x']:4d} h={ln['h']:2d} {ln['text'][:60]}", file=_sys.stderr)
    out, last_no, expect, warns = [], None, None, []
    for ln in inside:
        t = ln["text"]
        m = stem_t[2].match(t) if stem_t else None
        if m:
            try:
                last_no = stem_t[3](m)
            except Exception:
                last_no = (last_no or 0) + 1
            out.append({"txt": f"{last_no}、{t[m.end():]}", "x": ln["x"], "y": ln["y"],
                        "y2": ln["y2"], "h": ln["h"], "kind": "stem"})
            continue
        m = opt_t[2].match(t) if opt_t else None
        if m:
            letter = m.group(1).upper()
            if letter in "ⒶⒷⒸⒹⒺⒻ":
                letter = chr(ord("A") + "ⒶⒷⒸⒹⒺⒻ".index(letter))
            out.append({"txt": f"{letter}. {t[m.end():]}", "x": ln["x"], "y": ln["y"],
                        "y2": ln["y2"], "h": ln["h"], "kind": "opt"})
            continue
        if SECTION_PAT.match(t) and any(w in t for w in SECTION_WORDS):
            out.append({"txt": t, "x": ln["x"], "y": ln["y"], "y2": ln["y2"], "h": ln["h"], "kind": "sec"})
            continue
        if t.startswith(("、", "．", ".")) and any(w in t[:6] for w in SECTION_WORDS):
            n = len([o for o in out if o["kind"] == "sec"])
            pre = f"{'一二三四五六七八九十'[n]}、" if n < 10 else "、"
            out.append({"txt": pre + t.lstrip("、．."), "x": ln["x"], "y": ln["y"],
                        "y2": ln["y2"], "h": ln["h"], "kind": "sec"})
            continue

        prev = out[-1] if out else None
        if prev and prev["kind"] == "stem":
            if (ln["y"] - prev["y2"]) < prev["h"] * 1.6 and abs(ln["x"] - prev["x"]) <= indent \
                    and not prev["txt"].endswith(("。", ".", "？", "?")):
                prev["txt"] += t
                prev["y2"] = ln["y2"]
                continue

        if not list_mode:
            if prev and (ln["y"] - prev["y2"]) < prev["h"] * 1.6:
                prev["txt"] += t
                prev["y2"] = ln["y2"]
            else:
                out.append({"txt": t, "x": ln["x"], "y": ln["y"], "y2": ln["y2"], "h": ln["h"],
                            "kind": "stem" if not out else "other"})
            continue

        if prev and last_no is not None and ln["x"] - base_x >= lh * 0.8 \
                and cjk_ratio(t) >= 0.6 and len(t) >= 15 \
                and (prev["kind"] == "opt" or ln["y"] - prev["y2"] > lh * 1.3):
            last_no += 1
            out.append({"txt": f"{last_no}、（补号）{t}", "x": base_x, "y": ln["y"],
                        "y2": ln["y2"], "h": ln["h"], "kind": "stem"})
            continue

        if prev and ln["y"] - prev["y2"] < prev["h"] * 1.6:
            out.append({"txt": t, "x": ln["x"], "y": ln["y"], "y2": ln["y2"], "h": ln["h"], "kind": "other"})
            continue
        stats["isolated"] = stats.get("isolated", 0) + 1

    for o in out:
        if o["kind"] == "stem":
            expect = "A"
        elif o["kind"] == "opt":
            letter = o["txt"][0]
            if expect and letter != expect:
                warns.append(f"{expect}->{letter}")
            expect = chr(ord(letter) + 1) if letter < "F" else None

    text = "\n".join(("    " if o["kind"] == "opt" else "") + o["txt"] for o in out)
    body = [o for o in out if o["kind"] in ("stem", "opt")]
    ok = bool(body) and not (list_mode and len(warns) > 3)

    # ---------- 图块：找出来、裁出来、按位置插进文本 ----------
    figures = []
    if body:
        figs = detect_figures(img, all_boxes, lh)
        # 只认题目自己那一段里的图：浏览器地址栏、侧栏、摄像头小窗、页面按钮
        # 都在题目区之外，一律不要。
        top = min(o["y"] for o in out) - lh * 1.2
        bottom = max(o["y2"] for o in out) + lh * 2.0
        left = base_x - lh * 4.0
        figs = [f for f in figs
                if top <= (f["y"] + f["y2"]) / 2 <= bottom and f["x2"] > left]
        for f in figs:
            q = None
            for o in out:
                if o["kind"] == "stem" and o["y"] <= f["y"]:
                    q = re.match(r"^(\d+)、", o["txt"])
                    q = int(q.group(1)) if q else q
            f["q"] = q
        figs.sort(key=lambda f: f["y"])
        for index, f in enumerate(figs, 1):
            f["n"] = index
            pad = 8
            x1 = max(0, f["x"] - pad); y1 = max(0, f["y"] - pad)
            x2 = min(img.shape[1], f["x2"] + pad); y2 = min(img.shape[0], f["y2"] + pad)
            record = {"n": index, "q": f["q"], "label": f["label"],
                      "w": x2 - x1, "h": y2 - y1, "cov": f["cov"]}
            if fig_dir is not None:
                fig_dir.mkdir(parents=True, exist_ok=True)
                path = fig_dir / f"{Path(path).stem[:16]}-fig{index}.png"
                cv2.imwrite(str(path), img[y1:y2, x1:x2])
                record["file"] = str(path)
            figures.append(record)

        lines, fi = [], 0
        for o in out:
            while fi < len(figs) and figs[fi]["y"] < o["y"]:
                f = figs[fi]
                mark = f"〔图{f['n']}{'：' + f['label'] if f['label'] else ''}〕"
                lines.append(mark)
                fi += 1
            lines.append(("    " if o["kind"] == "opt" else "") + o["txt"])
        while fi < len(figs):
            f = figs[fi]
            lines.append(f"〔图{f['n']}{'：' + f['label'] if f['label'] else ''}〕")
            fi += 1
        text = "\n".join(lines)

    return {"ok": ok, "mode": "list" if list_mode else "single", "text": text,
            "questions": [o["txt"] for o in out], "figures": figures, "gaps": warns, "stats": stats}


def main():
    if len(sys.argv) < 2:
        json.dump({"ok": False, "reason": "usage: extract.py <png> [figures-dir]"}, sys.stdout)
        return 2
    fig_dir = Path(sys.argv[2]) if len(sys.argv) >= 3 else None
    # 检测边长不能写死：宽图被压小会整行丢掉。按这张图自己的长边来定，上限 2600。
    probe = cv2.imread(sys.argv[1])
    long_side = max(probe.shape[:2]) if probe is not None else 1920
    limit = max(1280, min(2600, int(long_side)))
    try:
        engine = RapidOCR(params={"Det.limit_side_len": limit, "Det.limit_type": "max"})
    except Exception:
        engine = RapidOCR()
    try:
        result = extract(sys.argv[1], engine, fig_dir)
    except Exception as exc:
        result = {"ok": False, "reason": f"failed: {exc.__class__.__name__}: {exc}"[:300]}
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
