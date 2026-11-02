"""design_token.py — 从 Slide IR 派生母版用的 DesignToken。

母版只承载五项结构性样式：画布、背景、页码、主题色板、字体。
**内容级样式不在这里**——每段文字的字号/颜色/对齐逐块写在 IR 里，由 filler 直接应用。
这不是偷懒：一旦让 token 去管内容样式，主题改一个字号就得重新生成模板，而 IR 里的
实测值本来就已经是对的（见 ir.js 的注释：内容样式不可能与主题分叉）。

派生的取值口径一律是"用得最多的那个"（众数），不是"第一个"：
一页里的强调色、代码色可能各有几种，母版要的是这个主题的**主色**。

文件名叫 design_token 而不是 token，是为了不遮住 Python 标准库的 `token` 模块。
"""

from collections import Counter

EMU_PER_IN = 914400
EMU_PER_PT = 12700

# PPTX 主题色板（clrScheme）槽位 → 语义名。写主题槽位（而不是字面色）是为了让用户在
# PowerPoint 里"换配色"时，这批颜色跟着变；只有真正特殊的颜色才在 filler 里回落成字面色。
# 注意：tx1/tx2 属于 clrMap（映射关系，不是颜色值），不在这里——改色板只能改 dk1/lt1/accent*。
SLOTS = {
    "dk1": "text",
    "lt1": "background",
    "accent1": "accent1",
    "accent2": "accent2",
    "accent3": "muted",
}


def _most(counter, default=None):
    if not counter:
        return default
    return counter.most_common(1)[0][0]


def _run_pools(block):
    """一个块里所有可能出现 run 的地方（正文、代码行、列表项、表格单元）"""
    kind = block.get("type")
    if kind == "code":
        for line in block.get("lines", []):
            yield line
    elif kind == "list":
        for item in block.get("items", []):
            yield item.get("runs", [])
    elif kind == "table":
        for row in block.get("rows", []):
            for cell in row.get("cells", []):
                yield cell.get("runs", [])
    else:
        yield block.get("runs", [])


def build_token(ir):
    """@param ir 解析后的 Slide IR @returns dict DesignToken"""
    canvas = ir.get("canvas", {})
    width_in = canvas.get("widthIn") or 13.3333
    height_in = canvas.get("heightIn") or 7.5

    background = Counter()
    text_colors = Counter()
    heading_colors = Counter()
    mono_fonts = Counter()
    body_fonts = Counter()
    heading_fonts = Counter()
    run_colors = Counter()

    for slide in ir.get("slides", []):
        color = (slide.get("background") or {}).get("color")
        if color:
            background[color] += 1

        for block in slide.get("blocks", []):
            style = block.get("style") or {}
            kind = block.get("type")
            color = style.get("color")
            font = style.get("font")

            if kind == "heading":
                if color:
                    heading_colors[color] += 1
                if font:
                    heading_fonts[font] += 1
            elif kind == "code":
                if font:
                    mono_fonts[font] += 1
            else:
                if color:
                    text_colors[color] += 1
                if font:
                    body_fonts[font] += 1

            # 强调色 = run 级样式里与所属块**不同**的颜色，正是主题拿来强调的东西。
            # 代码块不算：语法高亮的配色是另一回事（它逐 token 写在 IR 里，本就应当是字面色），
            # 让它参与"主题主色"的众数统计，会把强调色污染成 hljs 的关键字色。
            if kind == "code":
                continue
            base = color
            for pool in _run_pools(block):
                for run in pool:
                    run_color = (run.get("style") or {}).get("color")
                    if run_color and run_color != base:
                        run_colors[run_color] += 1

    body = _most(text_colors, "#000000")
    heading = _most(heading_colors, body)
    accents = [color for color, _ in run_colors.most_common(6)]
    body_font = _most(body_fonts)

    palette = {
        "background": _most(background, "#ffffff"),
        "text": body,
        "heading": heading,
        # 标题色就是主题的强调色（python-mini 的蓝），比从 run 里统计出来的更稳
        "accent1": heading,
        "accent2": accents[0] if accents else heading,
        "muted": accents[1] if len(accents) > 1 else body,
    }

    return {
        "canvas": {
            "widthIn": width_in,
            "heightIn": height_in,
            "widthEmu": int(round(width_in * EMU_PER_IN)),
            "heightEmu": int(round(height_in * EMU_PER_IN)),
        },
        "background": palette["background"],
        "fonts": {
            "body": body_font,
            "heading": _most(heading_fonts) or body_font,
            "mono": _most(mono_fonts),
        },
        "palette": palette,
        "clrScheme": {slot: palette[name] for slot, name in SLOTS.items()},
        "theme": ir.get("theme") or {},
    }


def in_to_emu(inches):
    return int(round((inches or 0) * EMU_PER_IN))


def pt_to_emu(points):
    return int(round((points or 0) * EMU_PER_PT))


def hex_to_rgb(value):
    """#rrggbb / #rgb → PPTX 用的 RRGGBB 字符串"""
    value = (value or "").lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if len(value) != 6:
        return "000000"
    return value.upper()
