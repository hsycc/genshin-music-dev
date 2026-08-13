// 忠实移植 src/lib/Songs/VisualSong.ts 的 toText 逻辑（ComposedSong 分支）
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

/** 定位本仓（genshin-music）的 src/Config.ts —— 本目录是独立 git 仓，
 *  但脚本仍需读取父仓的配置。按脚本自身位置向上找，找不到则明确报错。 */
function findConfigTs() {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
        path.join(here, '..', 'src', 'Config.ts'),   // test-sheets/ 在仓库内
        path.join(process.cwd(), 'src', 'Config.ts'), // 从仓库根调用
    ]
    for (const p of candidates) if (fs.existsSync(p)) return p
    throw new Error(
        '找不到 src/Config.ts。本脚本需要 genshin-music 仓库的配置文件，\n' +
        '请把 test-sheets/ 放在该仓库根目录下，或从仓库根目录调用。\n' +
        '已尝试:\n  ' + candidates.join('\n  ')
    )
}

const THRESHOLDS = {joined: 50, pause: 400}
const TEMPO_CHANGER_2 = new Map([
    [0, ['', '']], [1, ['(', ')']], [2, ['[', ']']], [3, ['{', '}']],
])
/**
 * 直接从 Config.ts 解析 LAYOUT_KINDS.defaultSky，避免手抄组合字符出错
 * （简谱的八度点 ̇ / ̣ 是组合符号，肉眼看不出抄错）
 */
function loadSkyLayouts(configPath) {
    const src = fs.readFileSync(configPath, 'utf-8')
    const block = src.slice(src.indexOf('defaultSky: {'), src.indexOf('skySFX6: {'))
    const pick = (key) => {
        const m = block.match(new RegExp(`${key}: \\(([\\s\\S]*?)\\)\\.split`))
        if (!m) throw new Error(`Config.ts 里找不到 defaultSky.${key}`)
        // 把 "a b " + "c d" 这样的拼接还原成一整个字符串，
        // 并把源码里的 \uXXXX 字面量转成真实字符（简谱的八度点就是这么写的）
        const joined = [...m[1].matchAll(/"([^"]*)"/g)]
            .map(x => x[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))))
            .join('')
        return joined.split(' ').filter(Boolean)
    }
    return {
        'ABC': pick('abcLayout'),
        '1 2 3': pick('numberLayout'),
        'Keyboard layout': pick('keyboardLayout'),
        'Playstation': pick('playstationLayout'),
        'Switch': pick('switchLayout'),
    }
}

/** v1/v2/v3 通用：只取 tempoChanger 和音符 index，文本谱用不到 layer */
function parseColumns(song) {
    return song.columns.map(([tempoChanger, notes]) => ({
        tempoChanger,
        notes: notes.map(n => n[0]),
    }))
}

function visualSongFrom(columns, bpm, flattenEmptyChunks) {
    const chunks = []
    const addChunk = (chunk, delay) => {
        const n = Math.floor(delay / THRESHOLDS.pause)
        chunks.push(chunk, ...Array.from({length: n}, () => ({tempoChanger: 0, columns: []})))
    }
    const mkChunk = (cols, tc) => ({
        tempoChanger: tc ?? cols[0]?.tempoChanger ?? 0,
        endingTempoChanger: tc ?? cols[0]?.tempoChanger ?? 0,
        columns: cols.map(c => ({notes: c.notes})),
    })

    const first = columns[0]
    if (!first) return {chunks, bpm}
    const stack = []
    let lastTempoChanger = first.tempoChanger
    for (const column of columns) {
        if (lastTempoChanger === 0 && column.tempoChanger === 0) {
            addChunk(mkChunk([column]), 0)
        } else if (lastTempoChanger > column.tempoChanger) {
            stack.push(column)
            const chunk = mkChunk(stack.splice(0, stack.length))
            chunk.endingTempoChanger = column.tempoChanger
            addChunk(chunk, 0)
        } else if (lastTempoChanger < column.tempoChanger) {
            if (lastTempoChanger === 0) stack.push(column)
            else {
                addChunk(mkChunk(stack.splice(0, stack.length)), 0)
                stack.push(column)
            }
        } else {
            stack.push(column)
        }
        lastTempoChanger = column.tempoChanger
    }
    if (stack.length) addChunk(mkChunk(stack.splice(0, stack.length)), 0)

    // 去掉首尾空白 chunk
    let lastChunkWithNotes = -1
    for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].columns.some(c => c.notes.length > 0)) {
            if (lastChunkWithNotes === -1) {
                chunks.splice(0, i)
                i = 0
            }
            lastChunkWithNotes = i
        }
    }
    chunks.splice(lastChunkWithNotes + 1)

    if (flattenEmptyChunks) {
        let counter = 0
        const final = []
        for (const chunk of chunks) {
            if (chunk.columns.every(c => c.notes.length === 0)) counter++
            else {
                const last = final[final.length - 1]
                if (last) {
                    last.emptyAhead = counter
                    counter = 0
                }
                final.push(chunk)
            }
        }
        return {chunks: final, bpm}
    }
    return {chunks, bpm}
}

function chunkToText(chunk, layout) {
    const [start, end] = TEMPO_CHANGER_2.get(chunk.tempoChanger) ?? ['', '']
    const notes = chunk.columns
        .map(col => col.notes.map(i => layout[i] ?? '').join(''))
        .join(' ')
        .trim()
    if (!notes) return ''
    return `${start}${notes}${end}`
}

function toText(vs, layout) {
    const rendered = vs.chunks.map(c => chunkToText(c, layout))
    const tokens = []
    let empties = 0
    for (const chunk of rendered) {
        if (chunk === '') {
            empties++
        } else {
            if (empties) {
                const voids = Math.round((60000 / (empties * vs.bpm)) / THRESHOLDS.pause)
                if (voids <= 2) tokens.push(Array.from({length: voids}, () => '-').join(' '))
                else tokens.push('\n\n'.repeat(Math.round(voids / 2)))
                empties = 0
            }
            tokens.push(chunk)
        }
    }
    return tokens.join(' ').trim()
}

const file = process.argv[2]
const layoutName = process.argv[3] ?? 'ABC'
const flatten = process.argv[4] === 'flatten'
const LAYOUTS = loadSkyLayouts(findConfigTs())
const layout = LAYOUTS[layoutName]
if (!layout) throw new Error(`未知记谱体系 "${layoutName}"，可选: ${Object.keys(LAYOUTS).join(' / ')}`)
const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
const song = Array.isArray(raw) ? raw[0] : raw
const columns = parseColumns(song)
const vs = visualSongFrom(columns, song.bpm, flatten)
console.error(`# ${song.name} | bpm ${song.bpm} | ${columns.length} 列 → ${vs.chunks.length} 个 chunk`)
console.error(`# 记谱 ${layoutName} (${layout.length} 键): ${layout.join(' ')}${flatten ? ' | flatten' : ''}`)
console.log(toText(vs, layout))
