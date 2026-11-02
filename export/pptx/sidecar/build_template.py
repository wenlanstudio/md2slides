"""build_template.py — DesignToken → template.pptx（母版 + 版式）。

产出的是**真正的 .pptx 模板文件**：用户可以在 PowerPoint 里打开它、改母版配色、
改版式、加 Logo，之后每次导出只是"套模板填内容"。这正是选 python-pptx 而不是
纯 JS 生成器的原因——PptxGenJS 只能写、不能读，给不了可复用的模板资产。

模板只定五件事：画布尺寸、背景、主题色板、字体、页码占位符 + 8 个版式。
内容长什么样、放在哪，一概不管（那是 IR 和 filler 的事）。

用法：
    python build_template.py --ir ir.json --out template.pptx
"""

import argparse
import json

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn

from design_token import build_token, hex_to_rgb, in_to_emu, pt_to_emu

# 版式名 → 复用 python-pptx 自带模板里的哪个版式。
# 复用而不是从零造：新建 layout 要在包里加 part，python-pptx 没这个 API；
# 自带版式数量足够，结构我们清空后自己填，效果一样。
LAYOUT_SOURCES = [
    ("title", "Title Slide"),
    ("title+body", "Title and Content"),
    ("two-col", "Two Content"),
    ("code", "Title Only"),
    ("table", "Comparison"),
    ("figure", "Picture with Caption"),
    ("mixed", "Content with Caption"),
    ("blank", "Blank"),
]

# 版式里的占位符（英寸）。只是给 PowerPoint 一个说得过去的骨架：
# filler 永远用 IR 的实测几何覆盖，这里的值只影响用户手工在 PowerPoint 里排版式时看到的样子。
BOX = {
    "title": (0.6, 0.5, 12.13, 1.2),
    "body": (0.6, 1.9, 12.13, 4.9),
    "body-left": (0.6, 1.9, 5.90, 4.9),
    "body-right": (6.83, 1.9, 5.90, 4.9),
    "pic": (2.0, 1.9, 9.33, 4.9),
    "sldNum": (11.9, 6.6, 0.9, 0.5),
}

PLACEHOLDERS = {
    "title": [("title", "title", None, "Title")],
    "title+body": [("title", "title", None, "Title"), ("body", "body", 1, "Content")],
    "two-col": [
        ("title", "title", None, "Title"),
        ("body-left", "body", 1, "Left Column"),
        ("body-right", "body", 2, "Right Column"),
    ],
    "code": [("title", "title", None, "Title"), ("body", "body", 1, "Code")],
    "table": [("title", "title", None, "Title"), ("body", "body", 1, "Table")],
    "figure": [("title", "title", None, "Title"), ("pic", "pic", 1, "Picture")],
    "mixed": [("title", "title", None, "Title"), ("body", "body", 1, "Content")],
    "blank": [],
}


def _sp_xml(shape_id, name, ph_type, ph_idx, box):
    x, y, w, h = box
    # 图片占位符没有文本框（PowerPoint 生成的也是空的 <p:spPr/>）
    body = (
        '<p:txBody><a:bodyPr/><a:lstStyle/>'
        '<a:p><a:r><a:rPr lang="zh-CN"/><a:t></a:t></a:r></a:p></p:txBody>'
    ) if ph_type != "pic" else ""
    # title/sldNum 这类占位符 PowerPoint 惯例不带 idx；body 才用 idx 区分多个
    ph = f'<p:ph type="{ph_type}"/>' if ph_idx is None else f'<p:ph type="{ph_type}" idx="{ph_idx}"/>'
    return (
        f'<p:sp {nsdecls("p", "a", "r")}>'
        f'<p:nvSpPr><p:cNvPr id="{shape_id}" name="{name}"/>'
        f'<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        f'<p:nvPr>{ph}</p:nvPr></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{in_to_emu(x)}" y="{in_to_emu(y)}"/>'
        f'<a:ext cx="{in_to_emu(w)}" cy="{in_to_emu(h)}"/></a:xfrm></p:spPr>'
        f"{body}</p:sp>"
    )


def _layout_name(part):
    """版式名。python-pptx 的 layout part 没有 `.element`，只能从 blob 里读"""
    try:
        return parse_xml(part.blob).find(qn("p:cSld")).get("name")
    except Exception:
        return None


def _clear_layout(layout):
    sp_tree = layout._element.find(qn("p:cSld")).find(qn("p:spTree"))
    for child in list(sp_tree):
        if child.tag in (qn("p:sp"), qn("p:pic"), qn("p:graphicFrame"), qn("p:cxnSp"), qn("p:grpSp")):
            sp_tree.remove(child)
    return sp_tree


def _apply_theme_colors(prs, clr_scheme):
    """改主题色板：让占位符默认色、强调色跟着主题走，用户在 PPT 里换配色才有效。

    python-pptx 把 theme 当成普通二进制 Part（没有 `.element`），所以这里是
    "读 blob → 改 XML → 写回 blob"。
    """
    for part in prs.part.package.iter_parts():
        if not str(part.partname).endswith("theme1.xml"):
            continue
        root = parse_xml(part.blob)
        scheme = root.find(qn("a:themeElements")).find(qn("a:clrScheme"))
        for slot, color in clr_scheme.items():
            node = scheme.find(qn(f"a:{slot}"))
            if node is None:
                continue
            for fill in node.iter():
                # 自带模板的 dk1/lt1 是 `<a:sysClr val="windowText"/>`（跟随系统主题色），
                # 必须换成字面色，否则"主题色板"里的正文色/背景色根本不受我们控制
                if fill.tag in (qn("a:srgbClr"), qn("a:scrgbClr"), qn("a:sysClr")):
                    for attr in list(fill.attrib):
                        del fill.attrib[attr]
                    fill.tag = qn("a:srgbClr")
                    fill.set("val", hex_to_rgb(color))
        part.blob = etree.tostring(root, xml_declaration=True, standalone=True, encoding="UTF-8")
        return True
    return False


def _apply_theme_fonts(prs, fonts):
    """把字体写进主题 fontScheme。

    中文字体要改三档，少改一档就会掉回宋体：
      1. `<a:latin>` 西文；
      2. `<a:ea>`    东亚兜底；
      3. `<a:font script="Hans">` **简体中文的脚本级覆盖——优先级高于 `<a:ea>`**，
         自带模板里这一档写的是宋体，所以只改 ea 时中文照样是宋体。

    majorFont=标题，minorFont=正文。
    """
    for part in prs.part.package.iter_parts():
        if not str(part.partname).endswith("theme1.xml"):
            continue
        root = parse_xml(part.blob)
        scheme = root.find(qn("a:themeElements")).find(qn("a:fontScheme"))
        if scheme is None:
            return False
        for group, name in (("a:majorFont", fonts.get("heading")), ("a:minorFont", fonts.get("body"))):
            node = scheme.find(qn(group))
            if node is None or not name:
                continue
            for tag in ("a:latin", "a:ea"):
                el = node.find(qn(tag))
                if el is not None:
                    el.set("typeface", name)
            for font in node.findall(qn("a:font")):
                if font.get("script") in ("Hans", "Hant"):
                    font.set("typeface", name)
        part.blob = etree.tostring(root, xml_declaration=True, standalone=True, encoding="UTF-8")
        return True
    return False


def build_template(token, out_path):
    prs = Presentation()
    canvas = token["canvas"]
    prs.slide_width = in_to_emu(canvas["widthIn"])
    prs.slide_height = in_to_emu(canvas["heightIn"])

    master = prs.slide_masters[0]
    try:
        master.background.fill.solid()
        master.background.fill.fore_color.rgb = RGBColor.from_string(hex_to_rgb(token["background"]))
    except Exception as exc:  # 背景不是必须项，失败了也不该拖垮出片
        print(f"[template] 母版背景设置失败：{exc}")

    _apply_theme_colors(prs, token.get("clrScheme", {}))
    _apply_theme_fonts(prs, token.get("fonts", {}))

    # 页码不进模板：页码由 furniture 以真实文本块进 IR、随内容填充（见
    # core/paginate/furniture.js）。母版页脚占位符（<p:hf sldNum>）与
    # 「::after 伪元素读数 + slidenum 域」两条旧路已删（均渲染不出/从未生效）。
    by_name = {layout.name: layout for layout in master.slide_layouts}

    for target, source in LAYOUT_SOURCES:
        layout = by_name.get(source)
        if layout is None:
            print(f"[template] 缺少基础版式 {source}，跳过 {target}")
            continue
        layout.name = target

        sp_tree = _clear_layout(layout)
        shape_id = 2
        for box_key, ph_type, ph_idx, ph_name in PLACEHOLDERS.get(target, []):
            sp_tree.append(parse_xml(_sp_xml(shape_id, ph_name, ph_type, ph_idx, BOX[box_key])))
            shape_id += 1


    # 没用到的自带版式从母版目录里摘掉：PowerPoint 的版式面板不该出现一堆来历不明的版式
    keep = {name for name, _ in LAYOUT_SOURCES}
    id_list = master._element.find(qn("p:sldLayoutIdLst"))
    if id_list is not None:
        for entry in list(id_list):
            r_id = entry.get(qn("r:id"))
            try:
                part = master.part.related_part(r_id)
            except Exception:
                continue
            if _layout_name(part) not in keep:
                id_list.remove(entry)
                # 关系必须一起摘：只删条目会留下"有关系但未注册"的孤儿版式，
                # PowerPoint 会直接判文件损坏要求修复
                master.part.drop_rel(r_id)

    prs.save(out_path)
    return out_path


def main():
    parser = argparse.ArgumentParser(description="Slide IR / DesignToken → PPTX 模板")
    parser.add_argument("--ir", help="Slide IR JSON（内部派生 DesignToken）")
    parser.add_argument("--token", help="已派生好的 DesignToken JSON")
    parser.add_argument("--out", default="template.pptx", help="输出模板路径")
    args = parser.parse_args()

    if args.token:
        with open(args.token, "r", encoding="utf-8") as fh:
            token = json.load(fh)
    elif args.ir:
        with open(args.ir, "r", encoding="utf-8") as fh:
            token = build_token(json.load(fh))
    else:
        parser.error("需要 --ir 或 --token")

    build_template(token, args.out)
    print(f"[template] 已生成：{args.out}")


if __name__ == "__main__":
    main()
