"use strict"

/**
 * blockSource.js — chart/wavedrom 一族「块配置头」的解析，从 wenlan muya 的
 * src/utils/diagram/blockSource.ts 移植（deck 出图与编辑器预览同规格，所见一致）。
 *
 * Typora 带火的块配置是 JS 片段而不是 JSON：
 *
 * ```chart
 * // ==BlockCodeConfig==
 * // @height           300px
 * // @backgroundColor  transparent
 * // ==/BlockCodeConfig==
 *
 * config = { type: "bar", data: { ... } }
 * ```
 *
 * 直接 JSON.parse 必挂。这里先把展示选项从头部拎出来，剥掉注释与赋值，
 * 再容忍手写配置里的尾逗号。逐字符扫描而不是正则一把梭：URL（http://…）
 * 里既有 `//` 又有像注释结尾的字符。
 *
 * 与编辑器的差异只有一处**刻意**的：编辑器在 CSP 下拒绝 eval，这里也一样——
 * 不接受计算值/展开/函数，那样的块按语法错误报。
 */

/** 块配置头里小写化的 `@` 选项。 */
const parseDiagramBlock = code => {
    const options = {}
    const lines = []
    let inConfig = false

    for (const rawLine of String(code ?? "").split("\n")) {
        const line = rawLine.replace(/\r$/, "")
        const trimmed = line.trim()
        // `//` 只在行首开注释，别吃掉配置里每个 URL 的 `//`。
        const comment = trimmed.startsWith("//") ? trimmed.slice(2).trim() : null

        if (comment !== null) {
            if (comment === "==BlockCodeConfig==") {
                inConfig = true
            }
            else if (comment === "==/BlockCodeConfig==") {
                inConfig = false
            }
            else if (inConfig && comment.startsWith("@")) {
                const [key, ...rest] = comment.slice(1).trim().split(/\s+/)
                if (key)
                    options[key.toLowerCase()] = rest.join(" ").trim()
            }
            continue
        }

        // 收尾标记丢了的头部，在第一行真代码处结束——别把整个块吃进头部。
        if (inConfig)
            inConfig = false

        lines.push(line)
    }

    return { options, body: lines.join("\n").trim() }
}

/** 掉一个行首的 `x = `，剩下就是值本身。 */
const stripAssignment = src =>
    src.replace(/^\s*(?:(?:const|let|var)\s+[\w$]+|[\w$]+(?:\.[\w$]+)*)\s*=(?!=)/, "").trim()

/** 引号串跳多远（含转义）。 */
function skipString(src, start) {
    const quote = src[start]
    let i = start + 1
    while (i < src.length) {
        if (src[i] === "\\") {
            i += 2
            continue
        }
        if (src[i] === quote)
            return i + 1
        i++
    }
    return src.length
}

/** 无引号属性名能用的字符段。 */
const IDENTIFIER = /^[A-Z_$][\w$]*/i

/** 扫描所在的容器栈，逗号才知道自己在分隔键还是值。 */
function trackStructure(ch, state, out) {
    switch (ch) {
        case "{":
            state.stack.push("object")
            state.expectKey = true
            state.comma = -1
            break

        case "[":
            state.stack.push("array")
            state.expectKey = false
            state.comma = -1
            break

        case "}":
        case "]":
            // 逗号后面没跟元素——尾逗号，JSON 不收。删掉。
            if (state.comma !== -1) {
                out.splice(state.comma, 1)
                state.comma = -1
            }
            state.stack.pop()
            state.expectKey = false
            break

        case ":":
            state.expectKey = false
            state.comma = -1
            break

        case ",":
            state.comma = out.length - 1
            state.expectKey = state.stack[state.stack.length - 1] === "object"
            break

        default:
            if (!/\s/.test(ch))
                state.comma = -1
    }
}

/**
 * 把 JS 对象字面量里合法而 JSON 不收的写法改写成 JSON：注释、尾逗号、无引号键。
 */
function relaxJson(src) {
    const out = []
    const state = { stack: [], comma: -1, expectKey: false }
    let i = 0

    while (i < src.length) {
        const ch = src[i]

        if (ch === '"' || ch === "'") {
            const end = skipString(src, i)
            out.push(src.slice(i, end))
            i = end
            state.comma = -1
            continue
        }

        if (ch === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n")
                i++
            continue
        }

        if (ch === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2)
            i = end === -1 ? src.length : end + 2
            continue
        }

        const name = state.expectKey ? IDENTIFIER.exec(src.slice(i))?.[0] : undefined
        if (name) {
            out.push(`"${name}"`)
            i += name.length
            state.expectKey = false
            state.comma = -1
            continue
        }

        out.push(ch)
        i++
        trackStructure(ch, state, out)
    }

    return out.join("")
}

/**
 * 读一个图表块：展示选项 + 它求值出的对象字面量。
 *
 * @throws SyntaxError 块里没有对象时抛出——调用方把错误报给作者。
 */
const parseJsonBlock = code => {
    const { options, body } = parseDiagramBlock(code)
    const value = JSON.parse(relaxJson(stripAssignment(body)))

    return { options, value }
}

/**
 * 读出 `@width`/`@height` 形如 `300px` 的数值。其余（含缺省的 `auto`）返回 null。
 */
const pixelSize = value => {
    const match = /^([\d.]+)px$/.exec(value ?? "")

    return match ? Number.parseFloat(match[1]) : null
}

module.exports = { parseDiagramBlock, parseJsonBlock, stripAssignment, relaxJson, pixelSize }
