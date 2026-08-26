#!/usr/bin/env node
/**
 * MIDI 转换链路失真分析
 *
 * 复现 src/components/pages/Composer/MidiParser/index.tsx 的 convertMidi()
 * 以及 src/lib/Songs/SongClasses.ts 的 MidiNote.fromMidi()
 *
 * 用法:
 *   node test-sheets/midiChainTest.js --map                 # 穷举 0..127 的映射分析
 *   node test-sheets/midiChainTest.js <file.mid> [Sky|Genshin]
 */

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

// --- 从 Config.ts 抽取常量，避免手抄 ------------------------------------
function loadMidiConfig(app) {
    const src = fs.readFileSync(findConfigTs(), 'utf-8')
    const blk = src.slice(src.indexOf('export const MIDI_MAP_TO_NOTE'), src.indexOf('export const MIDI_BOUNDS'))
    const qi = blk.indexOf('?')
    const ci = blk.indexOf(': {', blk.indexOf('}', qi))
    const chosen = app === 'Sky' ? blk.slice(qi, ci) : blk.slice(ci)
    const map = new Map()
    for (const [, midi, note, acc] of chosen.matchAll(/(\d+): \[(-?\d+), (true|false)\]/g)) {
        map.set(Number(midi), [Number(note), acc === 'true'])
    }
    const bounds = app === 'Genshin' ? {upper: 84, lower: 48} : {upper: 84, lower: 60}
    return {map, bounds}
}

/** SongClasses.ts:309 MidiNote.fromMidi 的忠实复现 */
function fromMidi(midiNote, octavesScale, {map, bounds}) {
    for (let i = 0; i < octavesScale; i++) {
        if (midiNote < bounds.lower) midiNote += 8      // ← 原样照抄：是 8 不是 12
        if (midiNote > bounds.upper) midiNote -= 8
    }
    const [note, isAccidental] = map.get(midiNote) ?? [-1, false]
    let outOfRangeBound = 0
    if (midiNote > bounds.upper) outOfRangeBound = 1
    if (midiNote < bounds.lower) outOfRangeBound = -1
    return {note, isAccidental, outOfRangeBound, finalMidi: midiNote}
}

// --- 最小 SMF 解析器（只取 note-on） --------------------------------------
function parseMidi(buf) {
    let p = 0
    const u32 = () => (buf[p++] << 24 | buf[p++] << 16 | buf[p++] << 8 | buf[p++]) >>> 0
    const u16 = () => (buf[p++] << 8 | buf[p++])
    const vlq = () => {
        let v = 0, b
        do { b = buf[p++]; v = (v << 7) | (b & 0x7f) } while (b & 0x80)
        return v
    }
    if (buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('不是 MIDI 文件（缺少 MThd）')
    p = 4
    u32()                       // header length
    const format = u16()
    const ntrks = u16()
    const division = u16()
    const tracks = []
    let tempo = 500000          // 默认 120 bpm，微秒/四分音符

    for (let t = 0; t < ntrks && p < buf.length; t++) {
        if (buf.toString('ascii', p, p + 4) !== 'MTrk') break
        p += 4
        const len = u32()
        const end = p + len
        const notes = []
        let tick = 0, running = 0, name = ''
        while (p < end) {
            tick += vlq()
            let status = buf[p]
            if (status & 0x80) { p++; running = status } else { status = running }
            const type = status & 0xf0
            if (status === 0xff) {                       // meta
                const meta = buf[p++]
                const l = vlq()
                if (meta === 0x51) tempo = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]
                if (meta === 0x03) name = buf.toString('utf8', p, p + l)
                p += l
            } else if (status === 0xf0 || status === 0xf7) {
                p += vlq()
            } else if (type === 0x90 || type === 0x80) {
                const pitch = buf[p++], vel = buf[p++]
                if (type === 0x90 && vel > 0) notes.push({midi: pitch, tick, velocity: vel})
            } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
                p += 2
            } else if (type === 0xc0 || type === 0xd0) {
                p += 1
            } else { p = end; break }
        }
        p = end
        tracks.push({name: name || `Track n.${t + 1}`, notes})
    }
    const secPerTick = (tempo / 1e6) / division
    for (const tr of tracks) for (const n of tr.notes) n.time = n.tick * secPerTick
    return {format, division, tempo, bpm: 6e7 / tempo, tracks}
}

// --- 分析：穷举映射 -------------------------------------------------------
function analyzeMap(app) {
    const cfg = loadMidiConfig(app)
    console.log(`\n=== ${app}：MIDI 音高 → 键位索引 的映射覆盖 ===`)
    console.log(`MIDI_BOUNDS: ${cfg.bounds.lower} .. ${cfg.bounds.upper}   映射表条目: ${cfg.map.size}`)
    let clean = 0, acc = 0, miss = 0
    const missed = []
    for (let m = cfg.bounds.lower; m <= cfg.bounds.upper; m++) {
        const e = cfg.map.get(m)
        if (!e) { miss++; missed.push(m) }
        else if (e[1]) acc++
        else clean++
    }
    const span = cfg.bounds.upper - cfg.bounds.lower + 1
    console.log(`界内 ${span} 个半音: 本位音 ${clean} / 变化音 ${acc} / 无映射 ${miss}${missed.length ? ' → ' + missed.join(',') : ''}`)
    console.log(`界外 (0..${cfg.bounds.lower - 1} 和 ${cfg.bounds.upper + 1}..127) 共 ${128 - span} 个半音，maxScaling=0 时全部丢弃`)

    console.log(`\n--- 八度折叠验证 (maxScaling=1)，正确的八度应该是 ±12 半音 ---`)
    console.log('原始MIDI  折叠后  映射到键位  正确八度折叠应得')
    for (const m of [cfg.bounds.lower - 5, cfg.bounds.lower - 1, cfg.bounds.upper + 1, cfg.bounds.upper + 5]) {
        const got = fromMidi(m, 1, cfg)
        const correctMidi = m < cfg.bounds.lower ? m + 12 : m - 12
        const correct = cfg.map.get(correctMidi) ?? [-1, false]
        const mark = got.note === correct[0] ? '' : '   ← 不一致'
        console.log(`${String(m).padEnd(9)} ${String(got.finalMidi).padEnd(7)} ${String(got.note).padEnd(11)} ${correct[0]}${mark}`)
    }
}

// --- 分析：真实文件 -------------------------------------------------------
function analyzeFile(file, app) {
    const cfg = loadMidiConfig(app)
    const midi = parseMidi(fs.readFileSync(file))
    const total = midi.tracks.reduce((a, t) => a + t.notes.length, 0)
    console.log(`\n=== ${file} (${app}) ===`)
    console.log(`格式 ${midi.format} | ${midi.tracks.length} 轨 | division ${midi.division} | bpm ${midi.bpm.toFixed(1)}`)
    console.log(`导入器写入的 bpm = Math.floor(bpm * 4) = ${Math.floor(midi.bpm * 4)}`)

    let acc = 0, out = 0, kept = 0
    const perTrack = []
    for (const tr of midi.tracks) {
        let a = 0, o = 0, k = 0
        for (const n of tr.notes) {
            const r = fromMidi(n.midi, 0, cfg)
            if (r.note === -1) { o++; continue }
            if (r.isAccidental) a++
            k++
        }
        acc += a; out += o; kept += k
        if (tr.notes.length) perTrack.push({轨: tr.name, 音符: tr.notes.length, 可映射: k, 变化音: a, 超范围丢弃: o})
    }
    console.table(perTrack)
    console.log(`合计 ${total} 音符 → 可映射 ${kept} (${(kept / total * 100).toFixed(1)}%)`)
    console.log(`  其中变化音 ${acc}（关闭 "include accidentals" 时这些也会被丢弃，只剩 ${kept - acc}）`)
    console.log(`  超出键位范围直接丢弃 ${out} (${(out / total * 100).toFixed(1)}%)`)

    // 时值信息丢失
    const durations = new Set()
    for (const tr of midi.tracks) for (const n of tr.notes) durations.add(n.velocity)
    console.log(`  力度(velocity) 取值 ${durations.size} 种 → 全部丢弃，格式无此字段`)
    console.log(`  音符时长(duration) → 全部丢弃，导出时统一写死 duration: 1`)

    // 量化：同一列的合并阈值
    const bpm = Math.floor(midi.bpm * 4) || 220
    const bpmToMs = 60000 / bpm
    const all = midi.tracks.flatMap(t => t.notes.map(n => ({...n, ms: Math.floor(n.time * 1000)})))
        .filter(n => fromMidi(n.midi, 0, cfg).note !== -1)
        .sort((a, b) => a.ms - b.ms)
    let groups = 0
    const q = [...all]
    while (q.length) {
        const row = [q.shift()]
        let amount = 0
        for (let i = 0; i < q.length; i++) if (row[0].ms > q[i].ms - bpmToMs / 9) amount++
        q.splice(0, amount)
        groups++
    }
    console.log(`  量化: 阈值 ${(bpmToMs / 9).toFixed(1)}ms（1/9 拍），${all.length} 个音符 → ${groups} 列`)
}

// --- 分析：scaling 折叠的 ±8 vs ±12 对比 ---------------------------------
/** 正确版本：按真正的八度（12 半音）折叠 */
function fromMidiFixed(midiNote, octavesScale, {map, bounds}) {
    for (let i = 0; i < octavesScale; i++) {
        if (midiNote < bounds.lower) midiNote += 12
        if (midiNote > bounds.upper) midiNote -= 12
    }
    const [note, isAccidental] = map.get(midiNote) ?? [-1, false]
    return {note, isAccidental, finalMidi: midiNote}
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const noteName = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`

function analyzeScaling(file, app, maxScaling) {
    const cfg = loadMidiConfig(app)
    const midi = parseMidi(fs.readFileSync(file))
    const all = midi.tracks.flatMap(t => t.notes)
    const outside = all.filter(n => n.midi < cfg.bounds.lower || n.midi > cfg.bounds.upper)

    console.log(`\n=== ${file} (${app})  scaling=${maxScaling} ===`)
    console.log(`总音符 ${all.length}，其中界外 ${outside.length} 个（${(outside.length / all.length * 100).toFixed(1)}%）`)
    if (!outside.length) {
        console.log('界外音符为 0 → 折叠循环内的 if 永不成立 → Issue 1 不触发')
        return
    }

    // 区分本位音（白键，真正救回）和变化音（黑键，被并到相邻白键，差一个半音）
    const tally = {
        '±8': {白键: 0, 黑键: 0, 仍丢弃: 0},
        '±12': {白键: 0, 黑键: 0, 仍丢弃: 0},
    }
    let same = 0, differ = 0
    const examples = []
    for (const n of outside) {
        const a = fromMidi(n.midi, maxScaling, cfg)
        const b = fromMidiFixed(n.midi, maxScaling, cfg)
        for (const [k, r] of [['±8', a], ['±12', b]]) {
            if (r.note === -1) tally[k].仍丢弃++
            else if (r.isAccidental) tally[k].黑键++
            else tally[k].白键++
        }
        if (a.note === b.note) same++
        else {
            differ++
            if (examples.length < 8 && a.note !== -1 && b.note !== -1) {
                examples.push({
                    源: `${n.midi} ${noteName(n.midi)}`,
                    '±8折叠后': `${a.finalMidi} ${noteName(a.finalMidi)}`,
                    '得到键位': a.note,
                    '±12折叠后': `${b.finalMidi} ${noteName(b.finalMidi)}`,
                    '应得键位': b.note,
                })
            }
        }
    }
    console.log('\n  折叠结果（白键=本位音真正救回，黑键=并到相邻白键、实际低半音）:')
    console.table(tally)

    // 唯一不会被换掉的指标：实际发声音高相对源音的「音级偏差」
    // 键位 → 实际发声的 MIDI（NOTE_MAP_TO_MIDI：只取本位音条目，Config.ts:870）
    const keyToMidi = new Map()
    for (const [m, [n, isAcc]] of cfg.map) if (!isAcc) keyToMidi.set(n, m)
    /** 发声音高与源音的音级差，取到最近的八度倍数，范围 -6..6 */
    const pitchClassError = (sourceMidi, key) => {
        const sounding = keyToMidi.get(key)
        if (sounding === undefined) return null
        let d = (sounding - sourceMidi) % 12
        if (d > 6) d -= 12
        if (d < -6) d += 12
        return d
    }
    const errHist = {'±8': {}, '±12': {}}
    for (const n of outside) {
        for (const [k, r] of [['±8', fromMidi(n.midi, maxScaling, cfg)], ['±12', fromMidiFixed(n.midi, maxScaling, cfg)]]) {
            if (r.note === -1) continue
            const e = pitchClassError(n.midi, r.note)
            if (e === null) continue
            errHist[k][e] = (errHist[k][e] ?? 0) + 1
        }
    }
    console.log('\n  ★ 音级偏差分布（0 = 音名正确，只差整八度；±1 = 差半音；数值越大越走音）:')
    const allKeys = [...new Set([...Object.keys(errHist['±8']), ...Object.keys(errHist['±12'])])]
        .map(Number).sort((a, b) => a - b)
    const rows = {}
    for (const k of ['±8', '±12']) {
        const h = errHist[k]
        const tot = Object.values(h).reduce((a, b) => a + b, 0)
        const weighted = Object.entries(h).reduce((a, [e, c]) => a + Math.abs(Number(e)) * c, 0)
        const row = {}
        for (const e of allKeys) row[`${e > 0 ? '+' : ''}${e}`] = h[e] ?? 0
        row['已导入'] = tot
        row['平均绝对偏差'] = tot ? (weighted / tot).toFixed(2) + ' 半音' : '-'
        rows[k] = row
    }
    console.table(rows)
    console.log(`  两者键位相同 ${same} 个，不同 ${differ} 个 (${(differ / outside.length * 100).toFixed(1)}%)`)
    console.log(`  注: includeAccidentals 默认为 true，黑键会被写进曲子并发出相邻白键的音；`)
    console.log(`      关掉该开关时，上表「黑键」一列全部丢弃。`)

    // 折叠是否会把音符推出范围（±12 步长 vs 音域宽度）
    const width = cfg.bounds.upper - cfg.bounds.lower
    console.log(`\n  音域宽度 ${width} 半音，${width >= 12 ? '≥12 → ±12 折叠不会越到另一端' : '<12 → ±12 可能来回震荡'}`)
    if (examples.length) {
        console.log('\n  走音实例:')
        console.table(examples)
    }
}

const args = process.argv.slice(2)
if (args[0] === '--map') {
    analyzeMap('Sky')
    analyzeMap('Genshin')
} else if (args[0] === '--scaling') {
    analyzeScaling(args[1], args[2] ?? 'Sky', Number(args[3] ?? 1))
} else if (args[0]) {
    analyzeFile(args[0], args[1] ?? 'Sky')
} else {
    console.error('用法:\n'
        + '  node test-sheets/midiChainTest.js --map\n'
        + '  node test-sheets/midiChainTest.js <file.mid> [Sky|Genshin]\n'
        + '  node test-sheets/midiChainTest.js --scaling <file.mid> [Sky|Genshin] [maxScaling=1]')
    process.exit(1)
}
