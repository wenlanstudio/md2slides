"""build_pptx.py — 一次性出片入口：Slide IR → 模板 → 可编辑 deck.pptx。

把 P1/P2 串成一条命令，省得每次手敲三条：
    python build_pptx.py --ir ir.json --out deck.pptx

模板按 `<主题>-<cssHash>.pptx` 缓存在 IR 同级的 templates/ 下：主题没变就复用，
变了才重建——模板是资产，不该每次导出都从零造一遍。
"""

import argparse
import json
import os

from build_template import build_template
from design_token import build_token
from fill_deck import fill_deck, verify


def main():
    parser = argparse.ArgumentParser(description="Slide IR → 可编辑 deck.pptx（模板 + 填充一次做完）")
    parser.add_argument("--ir", required=True, help="Slide IR JSON")
    parser.add_argument("--out", required=True, help="输出 pptx")
    parser.add_argument("--media", help="图片目录，默认取 IR 同级的 media/")
    parser.add_argument("--template", help="指定模板；不给则按主题缓存自动生成")
    parser.add_argument("--rebuild-template", action="store_true", help="强制重建模板")
    parser.add_argument("--report", help="把结果写成 JSON，供调用方（Typora 插件）读取")
    args = parser.parse_args()

    ir_path = os.path.abspath(args.ir)
    base = os.path.dirname(ir_path)
    media_dir = args.media or os.path.join(base, "media")

    with open(ir_path, "r", encoding="utf-8") as fh:
        ir = json.load(fh)

    template = args.template
    if not template:
        token = build_token(ir)
        theme = (token.get("theme") or {}).get("name") or "deck"
        css_hash = (token.get("theme") or {}).get("cssHash") or "none"
        template = os.path.join(base, "templates", f"{theme}-{css_hash[:8]}.pptx")
        if args.rebuild_template or not os.path.exists(template):
            os.makedirs(os.path.dirname(template), exist_ok=True)
            build_template(token, template)
            print(f"[build] 模板：{template}")
        else:
            print(f"[build] 复用模板：{template}")

    report = fill_deck(ir, template, media_dir, args.out)
    print(f"[build] 已生成：{args.out}")
    for line in report:
        print(f"[build] 提示：{line}")

    issues, pending = verify(ir, args.out)
    print(f"[build] 文本校验：{len(issues)} 处不一致")
    for issue in issues:
        print(" -", issue)
    if pending:
        print(f"[build] 待办：{len(pending)} 页含未进 PPTX 的内容")
        for line in pending[:20]:
            print(" -", line)

    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(
                {"out": args.out, "template": template, "issues": issues, "pending": pending, "notes": report},
                fh, ensure_ascii=False, indent=2,
            )


if __name__ == "__main__":
    main()
