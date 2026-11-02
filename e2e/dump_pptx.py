"""dump_pptx.py — 把成品 PPTX 的几何读回成 JSON，供 e2e 断言。

IR 那一侧的几何对了，不代表成品也对了：sidecar 还要把英寸换算成 EMU、照 IR 的
绝对坐标摆放。想知道摆放有没有出界，只能把成品再读一遍——IR 是契约，PPTX 才是结果。

判据与 IR 闸门同款：尺寸为正、且落在画布内。

（文件名别叫 inspect.py：会挡住标准库那个，lxml 导入时就循环了。）

Usage:  python dump_pptx.py deck.pptx > dump.json
"""

import json
import sys

from pptx import Presentation
from pptx.util import Emu

EPS = 0.01  # 英寸容差，只吸收四舍五入


def main():
    prs = Presentation(sys.argv[1])
    width = Emu(prs.slide_width).inches
    height = Emu(prs.slide_height).inches

    slides = []
    total = 0
    for index, slide in enumerate(prs.slides):
        issues = []
        rects = []
        for shape in slide.shapes:
            left = Emu(shape.left).inches
            top = Emu(shape.top).inches
            w = Emu(shape.width).inches
            h = Emu(shape.height).inches
            if w <= 0 or h <= 0:
                issues.append(f"第 {index + 1} 页：{shape.shape_type} 尺寸非正（{w:.3f}×{h:.3f} in）")
                continue
            rects.append((left, top, w, h, str(shape.shape_type)))
            if (
                left < -EPS
                or top < -EPS
                or left + w > width + EPS
                or top + h > height + EPS
            ):
                issues.append(
                    f"第 {index + 1} 页：{shape.shape_type} 越界"
                    f"（L={left:.2f} T={top:.2f} W={w:.2f} H={h:.2f}；画布 {width:.2f}×{height:.2f}）"
                )
        # 形状两两重叠检测：块在浏览器里是竖排的，成品不该叠（微软 Office 叠字
        # 那类破版——量好的数、PPT 自己重排——只有读回成品才抓得到）。
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                l1, t1, w1, h1, n1 = rects[i]
                l2, t2, w2, h2, n2 = rects[j]
                ox = min(l1 + w1, l2 + w2) - max(l1, l2)
                oy = min(t1 + h1, t2 + h2) - max(t1, t2)
                if ox <= EPS or oy <= EPS:
                    continue
                area = ox * oy
                if area > 0.02 and area > min(w1 * h1, w2 * h2) * 0.02:
                    issues.append(
                        f"第 {index + 1} 页：形状重叠（{n1} × {n2}，交叠 {area:.2f} in²）"
                    )
        total += len(issues)
        slides.append({"index": index, "shapes": len(slide.shapes), "issues": issues})

    json.dump(
        {
            "canvas": {"widthIn": round(width, 4), "heightIn": round(height, 4)},
            "slides": slides,
            "issues": total,
        },
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
