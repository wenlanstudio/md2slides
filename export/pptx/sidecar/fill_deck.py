"""fill_deck.py — 模板 + Slide IR → deck.pptx。

它的全部职责就是"照着 IR 把内容摆到模板里"：
  · 几何：IR 的实测英寸坐标直接落位，不重新排版、不重新分页；
  · 样式：块级样式逐块应用，颜色优先写**主题槽位**（换配色仍生效），
    只有主题色板里没有的颜色（如语法高亮的 token 色）才写字面色；
  · 可编辑性：文本走流式（开启"溢出时缩排"），图/表/代码走锚定；段落保持完整，
    **绝不按视觉行拆段**——拆段会让改一个字就全乱，那是像素一致路线的做法。

内容准确性在这里再验一次：写完重开成品，逐页比对文本是否与 IR 一致。
"""

import argparse
import json
import os
from datetime import datetime

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_THEME_COLOR
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn
from pptx.text.text import Font
from pptx.util import Pt

import omml
from design_token import build_token, hex_to_rgb, in_to_emu

# 公式转换失败的登记处（fill_deck 开头清空、结尾收进 report）。
# 不往函数签名里塞第四个参数：_runs_into 在段落 / 列表 / 表格三条路上都被调，
# 逐层透传一个几乎永远为空的列表，读起来比它解决的问题还重。
_MATH_FAILS = []

# 主题色板槽位 → 写进 PPTX 的 schemeClr 名。dk1/lt1 走 tx1/bg1（clrMap 里的映射），
# 这样"换配色"时正文色/背景色跟着变。
SLOT_OF = {"dk1": "TEXT_1", "lt1": "BACKGROUND_1", "accent1": "ACCENT_1", "accent2": "ACCENT_2", "accent3": "ACCENT_3"}

XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

FLOW_TYPES = {"heading", "paragraph", "list"}

# 项目符号悬挂量（bullet / 编号落在文字左侧多远）：浏览器把符号挂在 ul 的 padding 里，
# 这里按字号取 em——符号的精确位置是装饰，文字列的位置和宽度才是排版。编号比圆点宽
# （"10." 约 1.4em），单独给一档，免得编号右沿压住文字。
BULLET_HANG_EM = 0.75
ORDERED_HANG_EM = 1.5

# 出片自检容差（pt）：浏览器行数 × 行距 + 段距 + 纵向 inset，对照量好的框高，
# 差值在容差内算舍入误差，超出即报警——"内容在 Office 里压住下一块"先在构建期拦一次。
FIT_TOL_PT = 1.5


# ---------------- 样式 ----------------

def _slot_by_color(token):
    """颜色 → 主题槽位名（用于优先写 schemeClr）"""
    table = {}
    for slot, color in (token.get("clrScheme") or {}).items():
        name = SLOT_OF.get(slot)
        if name and color:
            table[color.lower()] = name
    return table


def _apply_color(font, color, slot_table):
    if not color:
        return
    name = slot_table.get(color.lower())
    if name:
        font.color.theme_color = getattr(MSO_THEME_COLOR, name)
        return
    font.color.rgb = RGBColor.from_string(hex_to_rgb(color))


def _ensure_ea(rPr, name):
    """中文要补 `<a:ea>`：只写 `<a:latin>` 时中文会掉回默认字体"""
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = parse_xml(f'<a:ea {nsdecls("a")} typeface="{name}"/>')
        latin = rPr.find(qn("a:latin"))
        if latin is not None:
            latin.addnext(ea)
        else:
            rPr.append(ea)
    else:
        ea.set("typeface", name)


def _set_typeface(run, name):
    if not name:
        return
    run.font.name = name          # latin 由 python-pptx 放到正确的 schema 位置
    _ensure_ea(run.font._rPr, name)


def _set_typeface_on(rPr, name):
    """给裸的 `<a:endParaRPr>`/`<a:defRPr>` 元素写字体（公式段落用，那里没有 run）"""
    if not name:
        return
    latin = rPr.find(qn("a:latin"))
    if latin is None:
        rPr.append(parse_xml(f'<a:latin {nsdecls("a")} typeface="{name}"/>'))
    else:
        latin.set("typeface", name)
    _ensure_ea(rPr, name)


def _style_rpr(rPr, style, slot_table, default_font):
    """字号 / 字体 / 颜色写进一个字符属性元素（`<a:endParaRPr>`）。

    公式段落里可能一个普通 run 都没有（整块公式），而 OMML 的 `<m:r>` 自己不带字号——
    PowerPoint 拿段落的默认字符属性渲染公式。不写它，公式会按模板默认字号冒出来，
    比正文小一截。顺序也不能反：`<a:solidFill>` 必须在 `<a:latin>` 之前。
    """
    font = Font(rPr)
    if style.get("fontSizePt"):
        font.size = Pt(style["fontSizePt"])
    _apply_color(font, style.get("color"), slot_table)
    _set_typeface_on(rPr, style.get("font") or default_font)


def _style_run(run, style, slot_table, default_font):
    size = style.get("fontSizePt")
    if size:
        run.font.size = Pt(size)
    if style.get("bold") is not None:
        run.font.bold = bool(style["bold"])
    if style.get("italic") is not None:
        run.font.italic = bool(style["italic"])
    _set_typeface(run, style.get("font") or default_font)
    _apply_color(run.font, style.get("color"), slot_table)


def _add_math_run(paragraph, math, style, slot_table, default_font, display=False):
    """一行里的公式：OMML 挂成段落的一个 `<a14:m>` 子节点，与普通 run 并列。

    转不动时（MathML 认不出 / 没装 Office 且内置兜底也失败）退化成 LaTeX 文本：
    宁可让用户看见 `\\frac{a}{b}`，也不能把公式整块丢掉。
    """
    omath = omml.mathml_to_omml(math.get("mathml"))
    if omath is None:
        run = paragraph.add_run()
        run.text = math.get("latex") or ""
        _style_run(run, style, slot_table, default_font)
        _MATH_FAILS.append(math.get("latex") or "(空公式)")
        return
    paragraph._p.append(omml.wrap_for_drawingml(omath, display))


def _add_math_block(slide, block, token, slot_table):
    """块级公式（`$$…$$`）：一个只装 OMML 的文本框，居中、不折行、垂直居中。

    框是浏览器量好的位置与高度；公式本体交给 PowerPoint 按字号排——这是可编辑
    路线本来就接受的取舍（文字块同理），换来的是双击能改。
    """
    geo = block["geo"]
    box = slide.shapes.add_textbox(
        in_to_emu(geo["x"]), in_to_emu(geo["y"]), in_to_emu(geo["w"]), in_to_emu(geo["h"])
    )
    frame = box.text_frame
    frame.word_wrap = False
    # 不自动缩放：字号是可编辑路线唯一可控的变量，交给 PowerPoint 按 autofit 改反而飘
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    style = block.get("style") or {}
    display = bool(block.get("display", True))
    para = frame.paragraphs[0]
    if display:
        para.alignment = PP_ALIGN.CENTER
    _add_math_run(para, block, style, slot_table, token["fonts"].get("body"), display=display)
    _style_rpr(para._p.get_or_add_endParaRPr(), style, slot_table, token["fonts"].get("body"))
    return box


def _runs_into(paragraph, runs, base_style, slot_table, default_font):
    for run in runs or []:
        if run.get("br"):
            paragraph.add_run().text = ""
            continue
        if run.get("math"):
            _add_math_run(paragraph, run["math"], base_style, slot_table, default_font)
            continue
        text = run.get("text") or ""
        if not text:
            continue
        pptx_run = paragraph.add_run()
        pptx_run.text = text
        style = dict(base_style)
        style.update(run.get("style") or {})
        _style_run(pptx_run, style, slot_table, default_font)
        if text != text.strip():
            # 代码缩进靠前导空格，PowerPoint 默认会吃掉，必须显式声明保留
            node = pptx_run._r.find(qn("a:t"))
            if node is not None:
                node.set(XML_SPACE, "preserve")


# ---------------- 段落 ----------------

def _set_bullet(pPr, ordered, marLIn, indentIn):
    """项目符号：python-pptx 没有高层 API，只能自己按 schema 顺序塞进 <a:pPr>。

    顺序：lnSpc → spcBef → spcAft → buClr* → buSz* → buFont → (buNone|buAutoNum|buChar) → tabLst → defRPr
    插错位置 PowerPoint 会判文件损坏，所以这里严格插在 tabLst/defRPr 之前。

    marL = 文字列相对文本框内容左边（lIns）的偏移，由 ir.js 量的 li 文字起点减去
    ul padding 得来——浏览器文字从哪起排，PPT 就从哪起排，文字列宽度因此逐英寸一致
    （2026-10-24：marL 在 lIns 之上又叠 0.375"，97% 满行的列表项被挤成两行）。
    indent 取负即悬挂：符号落在文字左侧 indentIn 处。
    """
    for tag in ("a:buNone", "a:buAutoNum", "a:buChar", "a:buFont"):
        old = pPr.find(qn(tag))
        if old is not None:
            pPr.remove(old)
    font = parse_xml(f'<a:buFont {nsdecls("a")} typeface="Arial"/>')
    mark = parse_xml(
        f'<a:buAutoNum {nsdecls("a")} type="arabicPeriod"/>' if ordered
        else f'<a:buChar {nsdecls("a")} char="•"/>'
    )
    anchor = None
    for tag in ("a:tabLst", "a:defRPr", "a:extLst"):
        anchor = pPr.find(qn(tag))
        if anchor is not None:
            break
    if anchor is not None:
        anchor.addprevious(mark)
        anchor.addprevious(font)
    else:
        pPr.append(font)
        pPr.append(mark)
    pPr.set("marL", str(in_to_emu(marLIn)))
    pPr.set("indent", str(-in_to_emu(indentIn)))


# ---------------- 块 ----------------

def _add_text_block(slide, block, token, slot_table, shape=None, first=False):
    geo = block["geo"]
    box = shape
    if box is None:
        box = slide.shapes.add_textbox(
            in_to_emu(geo["x"]), in_to_emu(geo["y"]), in_to_emu(geo["w"]), in_to_emu(geo["h"])
        )
    box.left, box.top = in_to_emu(geo["x"]), in_to_emu(geo["y"])
    box.width, box.height = in_to_emu(geo["w"]), in_to_emu(geo["h"])

    frame = box.text_frame
    if block["type"] in FLOW_TYPES:
        # 可编辑性的兜底：改字变长时 PowerPoint 自动缩排，而不是溢出出框
        frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE

    style = block.get("style") or {}
    # inset 清零：浏览器里文字贴内容盒边，而 PowerPoint 文本框默认左右各 0.1"、
    # 上下各 0.05"——shape 宽度是浏览器实测的块宽（含 padding），inset 一吃就少
    # 0.2"，页码「11 / 31」当场折成「11 /」+「31」，页眉书名掉字，封面标题折行。
    # 块有 padding 时把它映射成 inset：浏览器文字从 padding 后起排，PPT 同理，
    # 起始位置与可用宽度才同时与浏览器一致（padding 由 ir.js 量好后放进 style）。
    frame.margin_left = in_to_emu(style.get("paddingLeftIn") or 0)
    frame.margin_right = in_to_emu(style.get("paddingRightIn") or 0)
    frame.margin_top = in_to_emu(style.get("paddingTopIn") or 0)
    frame.margin_bottom = in_to_emu(style.get("paddingBottomIn") or 0)
    # 单行文本（IR 的 singleLine：浏览器里视觉行数就是 1）不许 PowerPoint 折行——
    # 字体度量微差导致的重排，折行即破版（家具/封面），溢出反而无感。
    frame.word_wrap = not block.get("singleLine")
    default_font = token["fonts"].get("body")
    align = style.get("align")
    # 行距是 ir.js 量的**绝对磅值**（浏览器行盒的 pt 数），照写 spcPts（精确行距）：
    # PPT 的 spcPct 是"字体自然行高的倍数"，CSS 的 line-height 是"字号的倍数"，
    # 把倍数当百分比写进去，PPT 行高会比浏览器高一截，多行块集体冲出量好的框。
    line_spacing_pt = style.get("lineSpacingPt")

    if block["type"] == "code":
        for line in block.get("lines", []):
            para = frame.add_paragraph()
            if line_spacing_pt:
                para.line_spacing = Pt(line_spacing_pt)
            _runs_into(para, line, style, slot_table, token["fonts"].get("mono") or style.get("font"))
        _drop_empty_first(frame)
        return box

    pools = [block.get("runs", [])] if block["type"] != "list" else [item.get("runs", []) for item in block.get("items", [])]
    items = block.get("items") or []
    for i, pool in enumerate(pools):
        para = frame.paragraphs[0] if (i == 0 and not first) else frame.add_paragraph()
        if align:
            para.alignment = {"left": 1, "center": 2, "right": 3, "justify": 4}.get(align, None)
        item = items[i] if block["type"] == "list" else None
        # 列表逐项取自己的样式：行高/段距/文字起点都以 li 的实测为准——
        # ul 自己的 line-height 是继承来的，条目里真正起排的是 li 的那份。
        item_style = {**style, **(item.get("style") or {})} if item is not None else style
        item_line_pt = item_style.get("lineSpacingPt") or line_spacing_pt
        if item_line_pt:
            para.line_spacing = Pt(item_line_pt)
        if item is not None:
            # 条目间距用 ir.js 量的**实测间隔**（gapBeforeIn），不拿 li 的 margin 拼：
            # 浏览器里相邻 li 的 margin 会折叠（6.3+6.3→6.3），首/末条的 margin 在
            # 嵌套容器里还会逃出 ul 边框盒——PPT 的 spcBef/spcAft 不折叠，按 margin
            # 直写每条目都多算一份，整块高出框、压住下一块。实测值两种场合都对。
            gap = item.get("gapBeforeIn")
            if gap:
                para.space_before = Pt(gap * 72)
            level = item.get("level", 0)
            para.level = min(8, level)
            pad_left = style.get("paddingLeftIn") or 0
            # marL = li 文字起点 − ul padding（嵌套列表的缩进也在里面）；量不到就按
            # 层级估一档，总比在 lIns 上再叠一份、把文字列挤窄好。
            marL = (item.get("indentIn") if item.get("indentIn") is not None else pad_left + 0.375 * level) - pad_left
            em = item_style.get("fontSizePt") or style.get("fontSizePt") or 18
            hang = em * (ORDERED_HANG_EM if block.get("ordered") else BULLET_HANG_EM) / 72
            _set_bullet(para._p.get_or_add_pPr(), block.get("ordered", False), max(0, marL), hang)
        _runs_into(para, pool, style, slot_table, default_font)
    _drop_empty_first(frame)
    # 末条之后的实测间距（块级）：末 li 的 margin-bottom 在不在 ul 边框盒里，
    # 浏览器两种场合都有，照写才不差这一截。
    if block["type"] == "list" and frame.paragraphs:
        gap_after = block.get("gapAfterIn")
        if gap_after:
            frame.paragraphs[-1].space_after = Pt(gap_after * 72)
    return box


def _drop_empty_first(frame):
    """用不上的空首段要删掉：留着它 PowerPoint 会显示一个空的可编辑框。

    段里只有公式（`a14:m`，不是 `a:r`）时不算空——那是一整块公式，删了就丢内容。
    """
    first = frame.paragraphs[0] if frame.paragraphs else None
    if first is None or first.runs:
        return
    if first._p.find(f"{{{omml.A14}}}m") is not None:
        return
    p = first._p
    p.getparent().remove(p)


def _preview(block):
    """块文本预览（自检报警用，截头去尾）"""
    if block["type"] == "math":
        return "$" + (block.get("latex") or "")[:23]
    if block["type"] == "list":
        text = " / ".join("".join(r.get("text", "") for r in item.get("runs", [])) for item in block.get("items", []))
    elif block["type"] == "code":
        text = "".join("".join(r.get("text", "") for r in line) for line in block.get("lines", []))
    else:
        text = "".join(r.get("text", "") for r in block.get("runs", []))
    return text[:24] + ("…" if len(text) > 24 else "")


def _check_fit(block, index, report):
    """出片自检：浏览器行数 × 行距 + 段距 + 纵向 inset，装不装得进量好的框。

    框高是浏览器实测，行距（spcPts）、文字列宽度（lIns + marL）、段距都按同一份
    实测复刻，两者该严严合缝。装不下只可能是某处复刻漂了——漂的后果就是 Office
    里内容压住下一块（2026-10-24 的列表重叠：行距被写成百分比、文字列被 marL
    挤窄，两条叠加）。这里先在构建期炸出来，不等用户打开文件。
    """
    style = block.get("style") or {}
    line_pt = style.get("lineSpacingPt")
    count = len(block.get("lines") or []) if block["type"] == "code" else block.get("lines")
    if not count or not line_pt:
        return
    if block["type"] == "list":
        content = 0.0
        for item in block.get("items") or []:
            item_style = {**style, **(item.get("style") or {})}
            content += (item.get("lines") or 1) * (item_style.get("lineSpacingPt") or line_pt)
            content += (item.get("gapBeforeIn") or 0) * 72
        content += (block.get("gapAfterIn") or 0) * 72
    else:
        content = count * line_pt
    insets = ((style.get("paddingTopIn") or 0) + (style.get("paddingBottomIn") or 0)) * 72
    box_pt = ((block.get("geo") or {}).get("h") or 0) * 72
    total = content + insets
    if total > box_pt + FIT_TOL_PT:
        report.append(
            f"第 {index + 1} 页：文本块装不进量好的框（需 {total:.1f}pt / 框 {box_pt:.1f}pt）：{_preview(block)}"
        )


def _add_image(slide, block, media_dir, report, index):
    src = block.get("src")
    if not src:
        report.append(f"第 {index + 1} 页：图片缺失，跳过")
        return
    path = os.path.join(media_dir, src)
    if not os.path.exists(path):
        report.append(f"第 {index + 1} 页：图片文件不存在 {path}")
        return
    geo = block["geo"]
    slide.shapes.add_picture(path, in_to_emu(geo["x"]), in_to_emu(geo["y"]), in_to_emu(geo["w"]), in_to_emu(geo["h"]))


def _add_table(slide, block, token, slot_table, report, index):
    rows = block.get("rows") or []
    if not rows:
        return
    cols = max(len(row.get("cells", [])) for row in rows)
    geo = block["geo"]
    shape = slide.shapes.add_table(
        len(rows), cols, in_to_emu(geo["x"]), in_to_emu(geo["y"]), in_to_emu(geo["w"]), in_to_emu(geo["h"])
    )
    table = shape.table
    widths = block.get("colWidths") or []
    for c, width in enumerate(widths[:cols]):
        table.columns[c].width = in_to_emu(width)
    for r, row in enumerate(rows):
        if row.get("heightIn"):
            table.rows[r].height = in_to_emu(row["heightIn"])
        for c, cell in enumerate(row.get("cells", [])[:cols]):
            target = table.cell(r, c)
            target.text = ""
            para = target.text_frame.paragraphs[0]
            style = dict(cell.get("style") or {})
            if cell.get("header") or row.get("header"):
                style["bold"] = True
            _runs_into(para, cell.get("runs", []), style, slot_table, token["fonts"].get("body"))


# ---------------- 页 ----------------

def _layout_for(prs, name):
    for layout in prs.slide_masters[0].slide_layouts:
        if layout.name == name:
            return layout
    return prs.slide_masters[0].slide_layouts[0]


def _parse_date(raw):
    """front-matter 的 date 原样是字符串（IR 只透传，不解析）。

    收四种写法：`2026-10-24` / `2026-10-24 15:55` / `2026-10-24 15:55:26` / ISO T 分隔。
    解析不了返回 None：文件属性缺一项，比整个导出崩掉好。
    """
    if not raw:
        return None
    text = str(raw).strip().replace("/", "-")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _apply_core_properties(prs, meta):
    """IR 的 meta → PPTX 文件属性（右键 → 属性可见）。

    只写四个键，缺项跳过、不猜：title/subtitle/author 原样（subtitle 进"主题"栏），
    date 解析失败记一条提示（调用方把提示带进 report，用户知道为什么属性里没有日期）。
    """
    if not isinstance(meta, dict):
        return []
    notes = []
    cp = prs.core_properties
    title = str(meta.get("title") or "").strip()
    author = str(meta.get("author") or "").strip()
    subtitle = str(meta.get("subtitle") or "").strip()
    if title:
        cp.title = title
    if subtitle:
        cp.subject = subtitle
    if author:
        cp.author = author
        cp.last_modified_by = author
    else:
        # 模板带着 python-pptx 的默认 last_modified_by（"Steve Canny"），
        # 不清就漏进用户的文件属性里
        cp.last_modified_by = ""
    date = _parse_date(meta.get("date"))
    if date:
        cp.created = date
        cp.modified = date
    elif meta.get("date"):
        notes.append(f"日期无法解析，未写入文件属性：{meta['date']}")
    return notes


def _drop_unused_placeholders(slide, keep_title):
    """清掉版式继承来的空占位符，但**保留两类**：
      · 标题占位符（有标题时）——大纲视图、版式语义都靠它；
      · 页码占位符（type=13）——它就是主题的 `section::after` 页码在 PPT 里的对应物，
        删掉等于把页码丢了。
    """
    for shape in list(slide.shapes):
        if not shape.is_placeholder:
            continue
        kind = shape.placeholder_format.type
        # 页码属于"页脚类"占位符，python-pptx 本来就不会把它复制到页上（它由版式提供）；
        # 这行是防御性的：将来若页上真出现一个，也不该被当成没用的空框删掉。
        if kind == 13:  # PP_PLACEHOLDER.SLIDE_NUMBER
            continue
        if kind == 1 and keep_title:  # PP_PLACEHOLDER.TITLE
            continue
        shape._element.getparent().remove(shape._element)


def fill_deck(ir, template_path, media_dir, out_path):
    token = build_token(ir)
    slot_table = _slot_by_color(token)
    prs = Presentation(template_path)
    report = []
    _MATH_FAILS.clear()

    for index, slide_ir in enumerate(ir.get("slides", [])):
        blocks = slide_ir.get("blocks", [])
        heading = next((b for b in blocks if b.get("type") == "heading"), None)
        slide = prs.slides.add_slide(_layout_for(prs, slide_ir.get("layout") or "mixed"))

        bg = slide_ir.get("background") or {}
        if bg.get("image"):
            # 背景图先加：z 序在最底层，内容后加自然盖在上面
            bg_path = os.path.join(media_dir, bg["image"])
            if os.path.exists(bg_path):
                slide.shapes.add_picture(bg_path, 0, 0, prs.slide_width, prs.slide_height)
            else:
                report.append(f"第 {index + 1} 页：背景图不存在 {bg_path}")
        if bg.get("color") and bg["color"].lower() != (token.get("background") or "").lower():
            try:
                slide.background.fill.solid()
                slide.background.fill.fore_color.rgb = RGBColor.from_string(hex_to_rgb(bg["color"]))
            except Exception:
                pass

        _drop_unused_placeholders(slide, keep_title=bool(heading))
        if heading:
            title = next((s for s in slide.shapes if s.is_placeholder and s.placeholder_format.type == 1), None)
            if title is not None:
                # 标题占位符真的被用上（大纲视图/版式语义都在），不是摆设
                _add_text_block(slide, heading, token, slot_table, shape=title, first=True)

        for block in blocks:
            if block is heading:
                continue
            kind = block.get("type")
            if kind in FLOW_TYPES or kind == "code":
                _add_text_block(slide, block, token, slot_table)
                _check_fit(block, index, report)
            elif kind == "image":
                _add_image(slide, block, media_dir, report, index)
            elif kind == "math":
                _add_math_block(slide, block, token, slot_table)
            elif kind == "table":
                _add_table(slide, block, token, slot_table, report, index)
            elif kind == "custom":
                report.append(f"第 {index + 1} 页：{block.get('raster')} 内容待栅格，已跳过")
            elif kind == "unknown":
                report.append(f"第 {index + 1} 页：未识别元素 <{block.get('tag')}>，已跳过")


        notes = slide_ir.get("notes")
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    if _MATH_FAILS:
        report.append(
            f"{len(_MATH_FAILS)} 个公式没转成 Office 公式，已退化成 LaTeX 文本："
            + "、".join(list(dict.fromkeys(_MATH_FAILS))[:3])
        )
    elif not omml.xsl_path():
        # 没装 Office：内置转换覆盖了常用语法，但边角排版可能朴素，说一声而不是闷声出片
        report.append("未找到 Office 的 MML2OMML.XSL，公式走内置转换（常用语法没问题，边角排版可能朴素）")
    report.extend(_apply_core_properties(prs, ir.get("meta")))
    try:
        prs.save(out_path)
    except PermissionError:
        # 文件正被 PowerPoint / WPS 打开着：Windows 上是独占写锁，连临时文件替身
        # 都换不进去（MoveFile 对打开中的文件同样 EACCES）。只能让用户先关。
        raise SystemExit(
            f"写不进 {out_path} —— 它多半正被 PowerPoint / WPS 打开着。"
            " 关掉再导出（开着文件时任何程序都改不了它，不是转换器的问题）。"
        )
    return report


# ---------------- 验收：成品文本 == IR 文本 ----------------

def _ir_text(slide_ir, include_pending=False):
    out = []
    for block in slide_ir.get("blocks", []):
        kind = block.get("type")
        if kind == "code":
            out.append("".join("".join(r.get("text", "") for r in line) for line in block.get("lines", [])))
        elif kind == "list":
            out.append("".join("".join(r.get("text", "") for r in item.get("runs", [])) for item in block.get("items", [])))
        elif kind == "table":
            out.append("".join(
                "".join(r.get("text", "") for r in cell.get("runs", []))
                for row in block.get("rows", []) for cell in row.get("cells", [])
            ))
        elif kind in ("heading", "paragraph"):
            out.append("".join(r.get("text", "") for r in block.get("runs", [])))
        elif include_pending:
            out.append(block.get("text", ""))
    return "".join(out)


def _deck_text(slide):
    out = []
    for shape in slide.shapes:
        if shape.is_placeholder and shape.placeholder_format.type == 13:
            continue
        if shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    out.append(cell.text)
        elif shape.has_text_frame:
            out.append(shape.text_frame.text)
    return "".join(out)


def _math_of_ir(slide_ir):
    """IR 里这一页有几个公式：块级算一个，行内 run 各算一个（段落/列表/代码/表格都要看）"""
    count = 0
    pools = []

    def scan(block):
        pools.append(block.get("runs") or [])
        for item in block.get("items") or []:
            pools.append(item.get("runs") or [])
        # 只有 code 的 lines 是「行的数组」；heading/paragraph 的 lines 是视觉行数（整数）
        if isinstance(block.get("lines"), list):
            pools.extend(block["lines"])
        for row in block.get("rows") or []:
            for cell in row.get("cells") or []:
                pools.append(cell.get("runs") or [])

    for block in slide_ir.get("blocks", []):
        if block.get("type") == "math":
            count += 1
            continue
        scan(block)
    return count + sum(1 for pool in pools for run in pool if isinstance(run, dict) and run.get("math"))


def _math_of_deck(slide):
    """成品里这一页有几个 Office 公式：数 `<a14:m>`（退化成文本的公式不在这里）"""
    count = 0

    def in_frame(text_frame):
        return len(text_frame._txBody.findall(f".//{{{omml.A14}}}m"))

    for shape in slide.shapes:
        if shape.has_table:
            # 表格不是 text_frame，公式挂在单元格里——不进去数就会把"公式没进去"误报成"没进"
            for row in shape.table.rows:
                for cell in row.cells:
                    count += in_frame(cell.text_frame)
        elif shape.has_text_frame:
            count += in_frame(shape.text_frame)
    return count


def _strip(text):
    return "".join((text or "").split())


def verify(ir, deck_path):
    """硬门槛：每一页"该进去的文字"必须逐字进了成品。

    custom/unknown 是**已知**没进去的（待栅格 / 未识别），单独记为待办，
    不混进"文本不一致"——两者性质不同，混在一起会掩盖真正的丢字。
    """
    prs = Presentation(deck_path)
    issues = []
    pending = []
    for index, slide_ir in enumerate(ir.get("slides", [])):
        blocks = slide_ir.get("blocks", [])
        skipped = [b for b in blocks if b.get("type") in ("custom", "unknown")]
        if skipped:
            pending.append(f"第 {index + 1} 页：{len(skipped)} 个待栅格/未识别块未进 PPTX")
        if index >= len(prs.slides):
            issues.append(f"第 {index + 1} 页缺失")
            continue
        expected = _strip(_ir_text(slide_ir))
        actual = _strip(_deck_text(prs.slides[index]))
        if expected != actual:
            issues.append(f"第 {index + 1} 页文本不一致\n  IR : {expected[:160]}\n  PPT: {actual[:160]}")
        # 公式单独数一遍：它不以文字形式进 PPTX，文本比对抓不到"公式没进去"
        want, got = _math_of_ir(slide_ir), _math_of_deck(prs.slides[index])
        if want != got:
            issues.append(
                f"第 {index + 1} 页公式数不一致（IR {want} / 成品 {got}）："
                "转不成 OMML 的公式已退化成 LaTeX 文本"
            )
    return issues, pending


def main():
    parser = argparse.ArgumentParser(description="模板 + Slide IR → 可编辑 deck.pptx")
    parser.add_argument("--ir", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--media", help="图片目录，默认取 IR 同级的 media/")
    args = parser.parse_args()

    with open(args.ir, "r", encoding="utf-8") as fh:
        ir = json.load(fh)
    media_dir = args.media or os.path.join(os.path.dirname(os.path.abspath(args.ir)), "media")

    report = fill_deck(ir, args.template, media_dir, args.out)
    print(f"[fill] 已生成：{args.out}")
    for line in report:
        print(f"[fill] 提示：{line}")

    issues, pending = verify(ir, args.out)
    print(f"[fill] 文本校验：{len(issues)} 处不一致")
    for issue in issues:
        print(" -", issue)
    if pending:
        print(f"[fill] 待办：{len(pending)} 页含未进 PPTX 的内容")
        for line in pending[:20]:
            print(" -", line)


if __name__ == "__main__":
    main()
