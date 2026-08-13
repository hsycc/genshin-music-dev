#!/usr/bin/env node
/**
 * composed → recorded → composed 往返测试
 *
 * 忠实移植：
 *   ComposedSong.toRecordedSong(offset)   src/lib/Songs/ComposedSong.ts:144
 *   RecordedSong.toComposedSong(precision) src/lib/Songs/RecordedSong.ts:135
 *   groupByNotes()                         src/lib/utils/Utilities.ts:238
 *
 * 用法: node scripts/roundTripTest.js <composed.json> [precision]
 */

import fs from 'node:fs'

const TEMPO_CHANGERS = [1, 1 / 2, 1 / 4, 1 / 8]   // Config.ts:746
const roundTime = (t) => Math.round(t)             // Song.roundTime

// --- 反序列化 ------------------------------------------------------------
/** v1 的 layer 是倒序二进制串，v2/v3 是十六进制 */
function parseLayer(raw, version) {
    if (version === 1) return BigInt('0b' + [...raw].reverse().join(''))
    return BigInt('0x' + raw)
}

function loadComposed(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const song = Array.isArray(raw) ? raw[0] : raw
    const version = song.version ?? 1
    return {
        name: song.name,
        bpm: song.bpm,
        version,
        columns: song.columns.map(([tempoChanger, notes]) => ({
            tempoChanger,
            notes: notes.map(([index, layer]) => ({index, layer: parseLayer(layer, version)})),
        })),
    }
}

// --- columns → notes -----------------------------------------------------
function toRecordedSong(song, offset = 100) {
    const msPerBeat = 60000 / song.bpm
    let totalTime = offset
    const notes = []
    for (const column of song.columns) {
        for (const note of column.notes) {
            notes.push({index: note.index, time: totalTime, layer: note.layer})
        }
        totalTime += roundTime(msPerBeat * TEMPO_CHANGERS[column.tempoChanger])
    }
    return {bpm: song.bpm, notes}
}

// --- notes → columns -----------------------------------------------------
/** Utilities.ts:238 —— 注意它会消耗（mutate）传入数组 */
function groupByNotes(notes, threshold) {
    const result = []
    while (notes.length > 0) {
        const row = [notes.shift()]
        let amount = 0
        for (let i = 0; i < notes.length; i++) {
            if (row[0].time > notes[i].time - threshold) amount++
        }
        result.push([...row, ...notes.splice(0, amount)])
    }
    return result
}

function toComposedSong(recorded, precision = 4) {
    const bpmToMs = 60000 / recorded.bpm
    const notes = recorded.notes.map(n => ({...n}))
    const converted = []
    const grouped = groupByNotes(notes, bpmToMs / 9)
    const combinations = [
        Math.floor(bpmToMs),
        Math.floor(bpmToMs / 2),
        Math.floor(bpmToMs / 4),
        Math.floor(bpmToMs / 8),
    ]
    for (let i = 0; i < grouped.length; i++) {
        const column = {tempoChanger: 0, notes: grouped[i].map(n => ({index: n.index, layer: n.layer}))}
        // 原实现：最后一组取 [[0,0,0]]，next[0].time 为 undefined → difference 为 NaN → 不进循环
        const next = grouped[i + 1] || [[0, 0, 0]]
        const paddingColumns = []
        let difference = next[0].time - grouped[i][0].time
        while (difference >= combinations[3]) {
            if (difference / combinations[0] >= 1) {
                difference -= combinations[0]
                paddingColumns.push(0)
            } else if (difference / combinations[1] >= 1) {
                difference -= combinations[1]
                if (precision <= 1) continue
                paddingColumns.push(1)
            } else if (difference / combinations[2] >= 1) {
                difference -= combinations[2]
                if (precision <= 2) continue
                paddingColumns.push(2)
            } else if (difference / combinations[3] >= 1) {
                difference -= combinations[3]
                if (precision <= 3) continue
                paddingColumns.push(3)
            }
        }
        column.tempoChanger = paddingColumns.shift() || 0
        const finalPadding = paddingColumns.map(tc => ({tempoChanger: tc, notes: []}))
        converted.push(column, ...finalPadding)
    }
    // 合并同列内索引相同的音符，layer 按位或
    for (const col of converted) {
        const grouped = {}
        for (const note of col.notes) {
            if (grouped[note.index]) grouped[note.index].layer |= note.layer
            else grouped[note.index] = {...note}
        }
        col.notes = Object.values(grouped)
    }
    return {bpm: recorded.bpm, columns: converted}
}

// --- diff ----------------------------------------------------------------
const fmtCol = (c) => c
    ? `tc=${c.tempoChanger} [${c.notes.map(n => `${n.index}:${n.layer.toString(16)}`).join(' ') || '空'}]`
    : '(不存在)'

function diff(before, after) {
    const max = Math.max(before.columns.length, after.columns.length)
    const rows = []
    for (let i = 0; i < max; i++) {
        const a = before.columns[i], b = after.columns[i]
        if (fmtCol(a) !== fmtCol(b)) rows.push({i, a: fmtCol(a), b: fmtCol(b)})
    }
    return rows
}

const stats = (song) => {
    const tc = {}
    let notes = 0, empty = 0
    for (const c of song.columns) {
        tc[c.tempoChanger] = (tc[c.tempoChanger] ?? 0) + 1
        notes += c.notes.length
        if (c.notes.length === 0) empty++
    }
    return {列数: song.columns.length, 音符数: notes, 空列: empty, 变速档分布: tc}
}

// --- main ----------------------------------------------------------------
const file = process.argv[2]
const precision = Number(process.argv[3] ?? 4)
if (!file) {
    console.error('用法: node scripts/roundTripTest.js <composed.json> [precision=4]')
    process.exit(1)
}

const original = loadComposed(file)
const recorded = toRecordedSong(original)
const back = toComposedSong(recorded, precision)

console.log(`曲目: ${original.name} | bpm ${original.bpm} | 格式 v${original.version} | precision=${precision}`)
console.log(`一拍 = ${60000 / original.bpm}ms，四档步长 = [${[1, 2, 4, 8].map(d => Math.floor(60000 / original.bpm / d)).join(', ')}]ms\n`)

console.log('原始   ', JSON.stringify(stats(original), null, 0))
console.log('中间态  recorded: %d 个音符，时间跨度 %dms', recorded.notes.length,
    (recorded.notes.at(-1)?.time ?? 0) - (recorded.notes[0]?.time ?? 0))
console.log('往返后 ', JSON.stringify(stats(back), null, 0))

// 差异分类：把「尾部空列截断」「列内顺序」这类噪音和真实差异分开
const trimTrailingEmpty = (cols) => {
    const c = [...cols]
    while (c.length && c[c.length - 1].notes.length === 0) c.pop()
    return c
}
const sortNotes = (c) => ({
    tempoChanger: c.tempoChanger,
    notes: [...c.notes].sort((x, y) => x.index - y.index),
})

const origTrim = trimTrailingEmpty(original.columns)
const backTrim = trimTrailingEmpty(back.columns)

console.log(`\n【1】尾部空列: 原始 ${original.columns.length} 列 → 去尾 ${origTrim.length} 列`
    + ` | 往返后 ${back.columns.length} → ${backTrim.length}`)

const norm = (cols) => cols.map(c => fmtCol(sortNotes(c)))
const A = norm(origTrim), B = norm(backTrim)
const real = []
for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) real.push({i, a: A[i] ?? '(不存在)', b: B[i] ?? '(不存在)'})
}

// 只差顺序的列数
const orderOnly = origTrim.filter((c, i) => {
    const b = backTrim[i]
    if (!b) return false
    return fmtCol(c) !== fmtCol(b) && fmtCol(sortNotes(c)) === fmtCol(sortNotes(b))
}).length
console.log(`【2】仅列内音符顺序不同: ${orderOnly} 列（往返后按 index 升序，因 Object.values 的整数键迭代顺序）`)

console.log(`\n【3】归一化后的真实差异: ${real.length} 列`)
if (real.length) {
    console.log('\n列#   原始                              →  往返后')
    console.log('-'.repeat(78))
    for (const r of real.slice(0, 30)) {
        console.log(`${String(r.i).padEnd(5)} ${r.a.padEnd(33)} →  ${r.b}`)
    }
    if (real.length > 30) console.log(`... 另有 ${real.length - 30} 处`)
} else {
    console.log('去掉尾部空列、统一音符顺序后，两者完全一致 ✓')
}

// 音符集合是否守恒（与列位置无关）
const bag = (cols) => cols.flatMap(c => c.notes.map(n => `${n.index}:${n.layer.toString(16)}`)).sort().join(',')
console.log(`\n【4】音符集合守恒: ${bag(original.columns) === bag(back.columns) ? '是 ✓' : '否 ✗'}`)
