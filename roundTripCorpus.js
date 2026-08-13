#!/usr/bin/env node
/**
 * composed ↔ recorded 全量往返测试
 *
 * 对整个曲库逐首做 composed → recorded → composed，统计损耗类型。
 * 移植自 roundTripTest.js（单曲版），逻辑与本仓
 * ComposedSong.toRecordedSong() / RecordedSong.toComposedSong() 一致。
 *
 * 用法: node test-sheets/roundTripCorpus.js <曲库根目录> [最大文件数]
 */

import fs from 'node:fs'
import path from 'node:path'

const TEMPO_CHANGERS = [1, 1 / 2, 1 / 4, 1 / 8]
const roundTime = (t) => Math.round(t)

/** columns → notes（ComposedSong.toRecordedSong，offset 100） */
function toRecorded(columns, bpm, offset = 100) {
    const msPerBeat = 60000 / bpm
    let t = offset
    const notes = []
    for (const col of columns) {
        for (const n of col.notes) notes.push({index: n.index, time: t, layer: n.layer})
        t += roundTime(msPerBeat * TEMPO_CHANGERS[col.tempoChanger])
    }
    return notes
}

/** Utilities.groupByNotes —— 会消耗传入数组 */
function groupByNotes(notes, threshold) {
    const result = []
    while (notes.length > 0) {
        const row = [notes.shift()]
        let amount = 0
        for (let i = 0; i < notes.length; i++) if (row[0].time > notes[i].time - threshold) amount++
        result.push([...row, ...notes.splice(0, amount)])
    }
    return result
}

/** notes → columns（RecordedSong.toComposedSong，precision 4） */
function toComposed(notes, bpm, precision = 4) {
    const bpmToMs = 60000 / bpm
    const grouped = groupByNotes(notes.map(n => ({...n})), bpmToMs / 9)
    const comb = [Math.floor(bpmToMs), Math.floor(bpmToMs / 2), Math.floor(bpmToMs / 4), Math.floor(bpmToMs / 8)]
    const out = []
    for (let i = 0; i < grouped.length; i++) {
        const col = {tempoChanger: 0, notes: grouped[i].map(n => ({index: n.index, layer: n.layer}))}
        const next = grouped[i + 1] || [[0, 0, 0]]
        const pad = []
        let diff = next[0].time - grouped[i][0].time
        while (diff >= comb[3]) {
            if (diff / comb[0] >= 1) { diff -= comb[0]; pad.push(0) }
            else if (diff / comb[1] >= 1) { diff -= comb[1]; if (precision <= 1) continue; pad.push(1) }
            else if (diff / comb[2] >= 1) { diff -= comb[2]; if (precision <= 2) continue; pad.push(2) }
            else if (diff / comb[3] >= 1) { diff -= comb[3]; if (precision <= 3) continue; pad.push(3) }
        }
        col.tempoChanger = pad.shift() || 0
        out.push(col, ...pad.map(tc => ({tempoChanger: tc, notes: []})))
    }
    // 合并同列内索引相同的音符
    for (const col of out) {
        const g = {}
        for (const n of col.notes) {
            if (g[n.index]) g[n.index].layer |= n.layer
            else g[n.index] = {...n}
        }
        col.notes = Object.values(g)
    }
    return out
}

const trimTail = (cols) => {
    const c = [...cols]
    while (c.length && c[c.length - 1].notes.length === 0) c.pop()
    return c
}
const sig = (cols) => cols
    .map(c => `${c.tempoChanger}:${[...c.notes].sort((a, b) => a.index - b.index).map(n => n.index).join(',')}`)
    .join('|')
const bag = (cols) => cols.flatMap(c => c.notes.map(n => n.index)).sort((a, b) => a - b).join(',')

// ---------------------------------------------------------------------------
const root = process.argv[2]
const limit = Number(process.argv[3] || Infinity)
if (!root) {
    console.error('用法: node test-sheets/roundTripCorpus.js <曲库根目录> [最大文件数]')
    process.exit(1)
}

const files = []
;(function walk(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        if (e.name === '.git' || e.name === '.vscode') continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.toLowerCase().endsWith('.txt')) files.push(p)
    }
})(root)

const stat = {
    总数: 0, composed: 0, 跳过_非composed: 0, 解析失败: 0,
    完全一致: 0, 仅尾部空列: 0, 网格结构变化: 0, 音符集合不守恒: 0,
}
const examples = []

for (const f of files.slice(0, limit)) {
    stat.总数++
    let songs
    try { songs = JSON.parse(fs.readFileSync(f, 'utf-8')) } catch { stat.解析失败++; continue }
    for (const s of (Array.isArray(songs) ? songs : [songs])) {
        if (s?.type !== 'composed' || !Array.isArray(s.columns)) { stat.跳过_非composed++; continue }
        stat.composed++
        const bpm = Number(s.bpm) || 220
        const cols = s.columns.map(([tc, ns]) => ({
            tempoChanger: tc,
            notes: ns.map(([i, hex]) => ({index: i, layer: parseInt(hex, 16) || 1})),
        }))
        const back = toComposed(toRecorded(cols, bpm), bpm)

        if (bag(cols) !== bag(back)) {
            stat.音符集合不守恒++
            if (examples.length < 5) examples.push({f: path.basename(f), 类型: '音符不守恒',
                原: cols.flatMap(c => c.notes).length, 后: back.flatMap(c => c.notes).length})
            continue
        }
        const a = trimTail(cols), b = trimTail(back)
        if (sig(a) === sig(b)) {
            stat[sig(cols) === sig(back) ? '完全一致' : '仅尾部空列']++
        } else {
            stat.网格结构变化++
            if (examples.length < 5) examples.push({f: path.basename(f), 类型: '网格变化',
                原列: a.length, 后列: b.length})
        }
    }
}

console.log(`\n=== composed ↔ recorded 全量往返测试 ===`)
console.log(`曲库: ${root}`)
for (const [k, v] of Object.entries(stat)) console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}`)
const ok = stat.完全一致 + stat.仅尾部空列
if (stat.composed) {
    console.log(`\n音符集合守恒率: ${((stat.composed - stat.音符集合不守恒) / stat.composed * 100).toFixed(3)}%`)
    console.log(`网格结构保持率: ${(ok / stat.composed * 100).toFixed(3)}%`)
}
if (examples.length) { console.log('\n差异样本:'); console.table(examples) }
