"""omml.py — MathML → OMML：把 KaTeX 的公式变成 PowerPoint 能编辑的原生公式。

Office 的公式既不是图片也不是 LaTeX 文本，而是 OMML（Office Math Markup Language）：
一棵 `<m:oMath>` 树，分数、上下标、求和号都是结构化的节点。PowerPoint 里它挂在
文本段落上（`<a14:m>`，见 fill_deck），双击就能进公式编辑器改——这正是「可编辑
PPTX」要的东西，也是栅格成图片永远给不了的。

两条转换路子，按可靠性排序：

 1. **Office 自带的 `MML2OMML.XSL`**（Word 用的那份）。它产出的 XML 与 Word 逐字
    一致，栅栏括号、nary 算子、矩阵、重音这些边角情况全对。装了 Office 就走它。
    找不到也**不能**把文件塞进仓库（那是微软的资产），所以下面有内置兜底。
 2. **内置兜底**：覆盖 KaTeX 会输出的常用 MathML 节点，认不出的节点退化成文字——
    宁可排版朴素，也不能丢内容，更不能写出让 PowerPoint 报「文件有问题」的 XML。

输入是 ir.js 从 `.katex-mathml` 里取出来的 MathML 字符串；LaTeX 源码跟在
`<annotation encoding="application/x-tex">` 里，只用于转换失败时的兜底展示。
"""

import os

from lxml import etree

# OMML 与宿主容器所在的命名空间
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
A14 = "http://schemas.microsoft.com/office/drawing/2010/main"
MML = "http://www.w3.org/1998/Math/MathML"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

_NSMAP = {"m": M}

# 大字算子（∑ ∏ ∫ …）：它们的上下限在 OMML 里是 `<m:nary>`，不是 `<m:sSub>`/`<m:sSup>`。
# 写错的话求和号会变成「∑ 后面跟一个小下标」，上下限也不上下排，一眼就看得出。
NARY_CHARS = set("∑∏∐∫∬∭∮⋀⋁⋂⋃⨀⨁⨂⨃⨄⨅⨆")

# 上下限**真的**上下排的只有求和/求积这类；积分号（∫）在排版惯例里是贴角的，
# 写成 undOvr 会把 0 和 1 摞在积分号正上下，一眼就是错的。
UND_OVR_CHARS = NARY_CHARS - set("∫∬∭∮")

# 叶子节点（直接进 <m:r> 的文字节点）
TOKEN_TAGS = ("mi", "mn", "mo", "mtext", "ms")

# 透明容器：自己不产生结构，只把孩子摊平（mstyle 的 mathvariant 要往下传）
PASS_THROUGH = ("mrow", "mstyle", "mpadded", "mphantom", "msrow", "mscarries")


# ---------------- XSL 发现 ----------------

def find_mml2omml():
    """找 Office 的 MML2OMML.XSL；找不到返回 None（调用方走内置兜底）。

    只在本机 Office 安装目录里找：把 XSL 复制进仓库是分发微软的资产，不做。
    `MD2SLIDES_MML2OMML` 指向哪里都行（测试、绿色版 Office、WPS 都靠它）。
    """
    env = os.environ.get("MD2SLIDES_MML2OMML")
    if env and os.path.exists(env):
        return env

    roots = [
        os.environ.get("ProgramFiles") or r"C:\Program Files",
        os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)",
        os.environ.get("LOCALAPPDATA") or "",
    ]
    # Microsoft Office 有 `root/Office16/`、`Office15/`，也有老式的 `Office16/` 直挂；
    # WPS 把同一份 XSL 放在 `…/WPS Office/<ver>/office6/` 下。
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for base in (
            os.path.join(root, "Microsoft Office", "root"),
            os.path.join(root, "Microsoft Office"),
            os.path.join(root, "Kingsoft", "WPS Office"),
        ):
            if not os.path.isdir(base):
                continue
            try:
                entries = sorted(os.listdir(base), reverse=True)
            except OSError:
                continue
            for entry in entries:
                for rel in ("MML2OMML.XSL", os.path.join("office6", "MML2OMML.XSL")):
                    hit = os.path.join(base, entry, rel)
                    if os.path.exists(hit):
                        return hit
    return None


# ---------------- 转换 ----------------

_MISSING = object()
_XSLT = _MISSING
_XSL_PATH = _MISSING


def _xslt():
    """XSL 只解析一次：一次导出要转几十个公式，别每回都读盘 + 编译。"""
    global _XSLT, _XSL_PATH
    if _XSLT is _MISSING:
        _XSL_PATH = find_mml2omml()
        try:
            _XSLT = etree.XSLT(etree.parse(_XSL_PATH)) if _XSL_PATH else None
        except Exception:  # XSL 坏了/不是 XSLT：退回内置，别让整个导出崩在这
            _XSLT = None
    return _XSLT


def xsl_path():
    """当前用的 XSL 路径（没有就 None）：报告里告诉用户走的是哪条路子。"""
    _xslt()
    return None if _XSL_PATH is _MISSING else _XSL_PATH


def mathml_to_omml(mathml):
    """MathML 字符串 → `<m:oMath>` 元素；两条路子都失败返回 None。

    @param mathml str，形如 `<math xmlns="…MathML">…</math>`
    @returns lxml 元素，或 None（调用方退化成 LaTeX 文本，别丢内容）
    """
    if not mathml:
        return None
    try:
        root = etree.fromstring(mathml.encode("utf-8") if isinstance(mathml, str) else mathml)
    except Exception:
        return None

    transform = _xslt()
    if transform is not None:
        try:
            result = transform(root)
            got = result.getroot()
            if got is not None and got.tag == _q(M, "oMath"):
                return got
        except Exception:
            pass  # XSL 对个别输入会抛（lxml 的 XSLT 与 Office 的不是同一套实现）
    return _builtin(root)


def _q(ns, tag):
    return f"{{{ns}}}{tag}"


def _local(node):
    tag = node.tag
    if not isinstance(tag, str):
        return ""
    return etree.QName(tag).localname


# ---------------- 内置兜底 ----------------

def _run(text, variant=None, mathml_node=None):
    """一个 `<m:r>`：OMML 里文字的最小单位。

    `<m:nor/>` 是「按普通文字渲染」——`\\text{期末}` 这类内容不该被当成变量斜体，
    CJK 尤其明显（落到数学字体上会变豆腐块）。
    """
    r = etree.Element(_q(M, "r"), nsmap=_NSMAP)
    if variant == "normal" or (mathml_node is not None and _local(mathml_node) == "mtext"):
        pr = etree.SubElement(r, _q(M, "rPr"))
        etree.SubElement(pr, _q(M, "nor"))
    elif variant == "bold":
        pr = etree.SubElement(r, _q(M, "rPr"))
        sty = etree.SubElement(pr, _q(M, "sty"))
        sty.set(_q(M, "val"), "b")
    t = etree.SubElement(r, _q(M, "t"))
    t.text = text or ""
    if (text or "") != (text or "").strip():
        t.set(XML_SPACE, "preserve")
    return r


def _wrap(tag, nodes, variant):
    """`<m:num>`/`<m:e>`/`<m:sub>`… 这类「装一串 OMML 元素」的容器"""
    el = etree.Element(_q(M, tag), nsmap=_NSMAP)
    for kid in _children(nodes, variant):
        el.append(kid)
    return el


def _children(nodes, variant):
    """一串 MathML 节点 → 一串 OMML 元素；相邻的叶子合并成一个 `<m:r>`。

    合并是必要的：KaTeX 把 `ab` 拆成两个 `<mi>`，不合并的话 OMML 里就是两个挨着的
    run，PowerPoint 编辑时从中间选字会断，也不像 Word 自己写出来的样子。
    """
    out = []
    buf = []
    variant_now = variant

    def flush():
        if buf:
            out.append(_run("".join(buf), variant_now))
            buf.clear()

    for node in nodes:
        if not isinstance(node.tag, str):
            continue
        tag = _local(node)
        if tag == "annotation":
            continue  # LaTeX 源码，不参与转换
        if tag in TOKEN_TAGS:
            buf.append("".join(node.itertext()))
            continue
        flush()
        out.extend(_conv(node, variant))
    flush()
    return out


def _base_text(node):
    """munder/mover/munderover 的**底**：只在它是单个文字节点时才认得出算子。"""
    kids = [c for c in node if isinstance(c.tag, str) and _local(c) not in ("annotation",)]
    if not kids:
        return "", []
    first = kids[0]
    if _local(first) in TOKEN_TAGS:
        return "".join(first.itertext()).strip(), kids
    return "", kids


def _nary(chr_text, sub, sup, variant, lim_loc=None):
    """`<m:nary>`：∑/∫ 这类算子的上下限。

    子节点顺序是 sub → sup → e（e 是被作用的表达式，KaTeX 的 MathML 里算子后面
    通常不挂东西，所以这里恒为空）。顺序写反 Office 会判结构错。
    """
    el = etree.Element(_q(M, "nary"), nsmap=_NSMAP)
    pr = etree.SubElement(el, _q(M, "naryPr"))
    if lim_loc is None:
        lim_loc = "undOvr" if chr_text in UND_OVR_CHARS else "subSup"
    chr_el = etree.SubElement(pr, _q(M, "chr"))
    chr_el.set(_q(M, "val"), chr_text)
    loc = etree.SubElement(pr, _q(M, "limLoc"))
    loc.set(_q(M, "val"), lim_loc)
    grow = etree.SubElement(pr, _q(M, "grow"))
    grow.set(_q(M, "val"), "1")
    for tag, on in (("subHide", not sub), ("supHide", not sup)):
        hide = etree.SubElement(pr, _q(M, tag))
        hide.set(_q(M, "val"), "on" if on else "off")
    el.append(_wrap("sub", sub, variant))
    el.append(_wrap("sup", sup, variant))
    el.append(_wrap("e", [], variant))
    return el


def _maybe_nary(tag, node, variant, mathml_children):
    """munder/mover/munderover：底是大字算子就走 nary，否则按 accent / lim 处理。"""
    chr_text, kids = _base_text(node)
    rest = kids[1:]
    if chr_text in NARY_CHARS:
        sub = rest[0:1] if tag in ("munder", "munderover") else []
        sup = (rest[1:2] if tag == "munderover" else rest[0:1]) if tag in ("mover", "munderover") else []
        return _nary(chr_text, sub, sup, variant)
    if tag == "mover":
        # accent="true"（\\hat \\bar \\vec …）→ 重音符号 `<m:acc>`；否则是上界限 `<m:limUpp>`
        if node.get("accent") == "true" and rest:
            acc = etree.Element(_q(M, "acc"), nsmap=_NSMAP)
            pr = etree.SubElement(acc, _q(M, "accPr"))
            chr_el = etree.SubElement(pr, _q(M, "chr"))
            chr_el.set(_q(M, "val"), "".join(rest[0].itertext()).strip())
            acc.append(_wrap("e", kids[0:1], variant))
            return acc
        el = etree.Element(_q(M, "limUpp"), nsmap=_NSMAP)
        el.append(_wrap("e", kids[0:1], variant))
        el.append(_wrap("lim", rest, variant))
        return el
    el = etree.Element(_q(M, "limLow"), nsmap=_NSMAP)
    el.append(_wrap("e", kids[0:1], variant))
    el.append(_wrap("lim", rest, variant))
    return el


def _matrix(node, variant):
    """`<m:m>`：矩阵 / cases。列数取最宽那行，少一个 `<m:e>` 都不行。"""
    el = etree.Element(_q(M, "m"), nsmap=_NSMAP)
    pr = etree.SubElement(el, _q(M, "mPr"))
    jc = etree.SubElement(pr, _q(M, "baseJc"))
    jc.set(_q(M, "val"), "center")
    hide = etree.SubElement(pr, _q(M, "plcHide"))
    hide.set(_q(M, "val"), "on")

    rows = []
    for kid in node:
        if isinstance(kid.tag, str) and _local(kid) == "mtr":
            rows.append([c for c in kid if isinstance(c.tag, str) and _local(c) == "mtd"])
    cols = max((len(r) for r in rows), default=0)
    if cols:
        mcs = etree.SubElement(pr, _q(M, "mcs"))
        mc = etree.SubElement(mcs, _q(M, "mc"))
        mc_pr = etree.SubElement(mc, _q(M, "mcPr"))
        count = etree.SubElement(mc_pr, _q(M, "count"))
        count.set(_q(M, "val"), str(cols))
        mc_jc = etree.SubElement(mc_pr, _q(M, "mcJc"))
        mc_jc.set(_q(M, "val"), "center")
    for row in rows:
        mr = etree.SubElement(el, _q(M, "mr"))
        for cell in row[:cols]:
            mr.append(_wrap("e", [cell], variant))
    return el


def _conv(node, variant):
    """一个 MathML 节点 → 一串 OMML 元素（认不出就退化成它的文字）"""
    tag = _local(node)

    if tag == "semantics":
        return _children([c for c in node if _local(c) != "annotation"], variant)

    if tag in PASS_THROUGH:
        return _children(list(node), node.get("mathvariant") or variant)

    if tag in TOKEN_TAGS:
        text = "".join(node.itertext())
        return [_run(text, variant, node)] if text else []

    if tag == "mspace":
        # OMML 没有「宽度」这个维度：退化成一个空格，别让相邻字符粘死
        return [_run(" ", variant)]

    if tag == "mfrac":
        kids = list(node)
        el = etree.Element(_q(M, "f"), nsmap=_NSMAP)
        pr = etree.SubElement(el, _q(M, "fPr"))
        kind = etree.SubElement(pr, _q(M, "type"))
        # \\binom / \\atop 是 linethickness="0"：分数线要关掉，不然是条横线加两堆字
        thick = (node.get("linethickness") or "").strip()
        kind.set(_q(M, "val"), "noBar" if thick in ("0", "0px", "0pt", "0em", "0ex") else "bar")
        el.append(_wrap("num", kids[0:1], variant))
        el.append(_wrap("den", kids[1:2], variant))
        return [el]

    if tag == "msqrt":
        el = etree.Element(_q(M, "rad"), nsmap=_NSMAP)
        pr = etree.SubElement(el, _q(M, "radPr"))
        deg_hide = etree.SubElement(pr, _q(M, "degHide"))
        deg_hide.set(_q(M, "val"), "1")
        el.append(_wrap("deg", [], variant))
        el.append(_wrap("e", list(node), variant))
        return [el]

    if tag == "mroot":
        # mroot 的孩子是「被开方式, 根指数」，与 OMML 的 deg/e 顺序正好相反
        kids = list(node)
        el = etree.Element(_q(M, "rad"), nsmap=_NSMAP)
        el.append(_wrap("deg", kids[1:2], variant))
        el.append(_wrap("e", kids[0:1], variant))
        return [el]

    if tag in ("msub", "msup", "msubsup"):
        kids = list(node)
        # 行内公式里 KaTeX 给 ∑_t 的是 `<msub>`（行间才是 munder）。底是大字算子时
        # 仍要走 nary：写成 sSub，求和号会缩成普通字符大小，上下限也不上下排。
        chr_text, _ = _base_text(node)
        if chr_text in NARY_CHARS:
            sub = kids[1:2] if tag in ("msub", "msubsup") else []
            sup = (kids[2:3] if tag == "msubsup" else kids[1:2]) if tag in ("msup", "msubsup") else []
            return [_nary(chr_text, sub, sup, variant, lim_loc="subSup")]
        names = {
            "msub": ("sSub", ["e", "sub"]),
            "msup": ("sSup", ["e", "sup"]),
            "msubsup": ("sSubSup", ["e", "sub", "sup"]),
        }[tag]
        el = etree.Element(_q(M, names[0]), nsmap=_NSMAP)
        for name, kid in zip(names[1], kids):
            el.append(_wrap(name, [kid], variant))
        return [el]

    if tag in ("munder", "mover", "munderover"):
        return [_maybe_nary(tag, node, variant, list(node))]

    if tag == "mtable":
        return [_matrix(node, variant)]

    # 认不出（menclose / maction / mglyph …）：退化成文字，内容不能丢
    text = "".join(node.itertext()).strip()
    return [_run(text, variant)] if text else []


def _builtin(root):
    """内置兜底：`<math>` → `<m:oMath>`"""
    body = root if _local(root) == "math" else root
    omath = etree.Element(_q(M, "oMath"), nsmap=_NSMAP)
    for kid in _children(list(body), None):
        omath.append(kid)
    return omath if len(omath) else None


# ---------------- PowerPoint 的挂载容器 ----------------

def wrap_for_drawingml(omath, display=False):
    """`<m:oMath>` → 能塞进 `<a:p>` 的 `<a14:m>`。

    PowerPoint 的段落里数学不是 `<m:oMath>` 直接挂上去，而是
    `a14:m > m:oMathPara > m:oMath`——少一层 oMathPara，Office 就不认这是公式
    （会显示成空白或触发修复）。块级公式额外带一个居中的 `m:jc`。
    """
    container = etree.Element(_q(A14, "m"), nsmap={"a14": A14, "m": M})
    para = etree.SubElement(container, _q(M, "oMathPara"))
    if display:
        pr = etree.SubElement(para, _q(M, "oMathParaPr"))
        jc = etree.SubElement(pr, _q(M, "jc"))
        jc.set(_q(M, "val"), "center")
    para.append(omath)
    return container
