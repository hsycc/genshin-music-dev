#!/usr/bin/env node
/**
 * 曲谱归一化器 —— 把各种输入统一成硬件可直接消费的事件流
 *
 * 输入（自动识别）
 *   - composed v1/v2/v3 JSON   社区曲库 78%
 *   - recorded  v1/v2   JSON   社区曲库 22%
 *   - smc 文本谱                曲名:[] 速度:[] … 曲谱:[1FD …]
 *   - Sky Studio ABC txt / Sky ABC1-5
 *
 * 输出：见文件末尾的结构说明。按「同时发声」分组成事件，
 *       每个键带物理行列、绝对 MIDI 音高、层归属。
 *
 * 用法:
 *   node test-sheets/normalizeSheet.js <file> [--app Sky|Genshin] [--json] [--pretty]
 */

import fs from 'node:fs'

// ---------------------------------------------------------------------------
// 常量（与本仓 src/Config.ts 一致）
// ---------------------------------------------------------------------------
const PITCHES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const TEMPO_CHANGERS = [1, 1 / 2, 1 / 4, 1 / 8]
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]

const APPS = {
    // 键位索引 0 在 pitch=C 时的 MIDI，来自 Config.ts 的 NOTE_MAP_TO_MIDI
    Sky:     {keys: 15, cols: 5, baseMidi: 60},
    Genshin: {keys: 21, cols: 7, baseMidi: 48},
}

/** smc 文本谱的字符表（作者确认：中音1→倍高音1 = DRMFSLX12345678） */
const SMC_MAP = {
    D: 0, R: 1, M: 2, F: 3, S: 4, L: 5, X: 6,
    '1': 7, '2': 8, '3': 9, '4': 10, '5': 11, '6': 12, '7': 13, '8': 14,
}
const SMC_REST = new Set(['0', ' ', '-', '_'])

/** Sky ABC1-5 标签，A1–A5 / B1–B5 / C1–C5 → 0..14 */
const ABC_LABELS = ['A', 'B', 'C'].flatMap(r => [1, 2, 3, 4, 5].map(c => `${r}${c}`))
const ABC_TO_INDEX = Object.fromEntries(ABC_LABELS.map((l, i) => [l, i]))
const ABC_CHORD = /^(?:[ABC][1-5])+$/
const ABC_REPEAT = /^(.+?)\*(\d+)$/
const ABC_REST = new Set(['.', '-', '_'])

const warnings = []
const warn = (m) => { if (!warnings.includes(m)) warnings.push(m) }

// ---------------------------------------------------------------------------
// 各格式 → 统一的中间形态 {meta, columns:[{tempoChanger, notes:[{index, layer}]}]}
// ---------------------------------------------------------------------------

/**
 * composed v1/v2/v3 —— v1 的 layer 是倒序二进制串，v2/v3 是十六进制。
 * 本仓 NoteLayer 用 BigInt（BASE_LAYER_LIMIT = 52），实测曲库里出现过
 * 2895426433843200（≈2^51），Number 位运算会静默丢高位，必须走 BigInt。
 */
function fromComposed(s) {
    const v = s.version ?? 1
    const parseLayer = (raw) => {
        if (typeof raw !== 'string' || !raw) return 1n
        try {
            const b = v === 1
                ? BigInt('0b' + ([...raw].reverse().join('') || '1'))
                : BigInt('0x' + raw)
            return b || 1n
        } catch { warn(`无法解析层掩码 ${JSON.stringify(raw)}，按第 0 层处理`); return 1n }
    }
    return {
        meta: {
            name: s.name, bpm: Number(s.bpm) || 220, pitch: s.pitch || 'C',
            appName: s.data?.appName, reverb: !!s.reverb,
            sourceFormat: 'composed', sourceVersion: v,
            instruments: normInstruments(s.instruments, v),
            breakpointColumns: (s.breakpoints || []).filter(Number.isFinite),
        },
        columns: (s.columns || []).map(([tc, notes]) => ({
            tempoChanger: Number(tc) || 0,
            notes: (notes || []).map(([i, raw]) => ({index: i, layer: parseLayer(raw)})),
        })),
    }
}

/** recorded v1/v2 —— v1 的音符元组可能只有 [index, time] */
function fromRecorded(s) {
    const v = s.version ?? 1
    const notes = (s.notes || []).map(([i, t, raw]) => {
        let layer = 1n
        if (typeof raw === 'string' && raw) {
            try { layer = BigInt('0x' + raw) || 1n } catch { warn(`无法解析层掩码 ${JSON.stringify(raw)}，按第 0 层处理`) }
        }
        return {index: i, time: Number(t) || 0, layer}
    }).sort((a, b) => a.time - b.time)
    return {
        meta: {
            name: s.name, bpm: Number(s.bpm) || 220, pitch: s.pitch || 'C',
            appName: s.data?.appName, reverb: !!s.reverb,
            sourceFormat: 'recorded', sourceVersion: v,
            instruments: normInstruments(s.instruments, 3),
            breakpointColumns: [],
        },
        absoluteNotes: notes,          // recorded 直接带时间戳，不走列
    }
}

function normInstruments(list, v) {
    if (!Array.isArray(list)) return []
    return list.map(x => typeof x === 'string'
        ? {name: x, volume: 100, pitch: '', muted: false, alias: '', icon: 'circle'}
        : {
            name: x?.name, volume: x?.volume ?? 100, pitch: x?.pitch ?? '',
            muted: !!x?.muted, alias: x?.alias ?? '', icon: x?.icon ?? 'circle',
            visible: x?.visible !== false, reverbOverride: x?.reverbOverride ?? null,
        })
}

/** smc 文本谱 */
function fromSmc(text) {
    const field = (label) => (text.match(new RegExp(`${label}:\\[([^\\]]*)\\]`)) || [])[1] ?? ''
    // 分组方式与作者编辑器里的 scoreAnalyzer.parseGroups 一致：
    // 先按空白切成 token，再在 token 内部每 4 字符一组。
    // 直接对整串按 4 字符硬切的话，谱面里出现连续两个空格就会让后续全部错位。
    const beats = []
    for (const token of field('曲谱').split(/\s+/)) {
        if (!token) continue
        for (let i = 0; i < token.length; i += 4) beats.push(token.slice(i, i + 4).padEnd(4, ' '))
    }
    if (beats.length % 8) warn(`时值数 ${beats.length} 不是 8 的倍数，末小节不完整`)

    const columns = []
    const breakpointColumns = [0]
    for (let m = 0; m < beats.length; m += 8) {
        const meas = beats.slice(m, m + 8)
        const mark = meas[7]?.[3]
        if (mark !== '<' && mark !== '>') warn(`第 ${m / 8 + 1} 小节末位标记为 ${JSON.stringify(mark)}，按 4/4 处理`)
        const keep = mark === '<' ? meas.slice(0, 6) : meas
        if (columns.length) breakpointColumns.push(columns.length)
        for (const b of keep) {
            const notes = []
            for (let s = 0; s < 3; s++) {
                const ch = b[s]
                if (SMC_REST.has(ch)) continue
                // 作者的 parseGroups 把落进槽位的 < > 也当休止（畸形数据的防御分支）
                if (ch === '<' || ch === '>') {
                    warn(`第 ${columns.length + 1} 列第 ${s + 1} 槽位出现小节标记 ${ch}，按休止处理`)
                    continue
                }
                const idx = SMC_MAP[ch] ?? SMC_MAP[ch.toUpperCase()]
                if (idx === undefined) throw new Error(`未知字符 ${JSON.stringify(ch)}（第 ${columns.length + 1} 列第 ${s + 1} 槽位）`)
                notes.push({index: idx, layer: 1n, slot: s})
            }
            columns.push({tempoChanger: 0, notes})
        }
    }
    const speed = Number(field('速度')) || 120
    return {
        meta: {
            name: field('曲名') || 'Untitled',
            // smc 的一个时值 = 八分音符（作者源码 durationTicks = PPQ/2）
            bpm: speed * 2, pitch: parseSmcKey(field('调性')),
            meter: field('节拍') || '4/4', difficulty: field('难度'),
            appName: 'Sky', reverb: false,
            sourceFormat: 'smc', sourceVersion: null,
            instruments: [], breakpointColumns,
        },
        columns,
    }
}

function parseSmcKey(raw) {
    if (!raw) return 'C'
    let b = raw.replace(/\(.*?\)/g, '').trim().replace(/♭/g, 'b').replace(/♯/g, '#')
    b = b.replace(/^\s*1\s*[=＝]\s*/, '')
    if (/^[b#][A-Ga-g]$/.test(b)) b = b[1].toUpperCase() + b[0]
    else if (b) b = b[0].toUpperCase() + b.slice(1)
    const enh = {'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb'}
    b = enh[b] ?? b
    if (!PITCHES.includes(b)) { warn(`调性 ${JSON.stringify(raw)} 无法识别，按 C 处理`); return 'C' }
    return b
}

/** Sky Studio ABC txt / Sky ABC1-5 */
function fromAbc(text) {
    const isTok = (t) => {
        const m = ABC_REPEAT.exec(t)
        const body = m ? m[1] : t
        return ABC_REST.has(body) || body.split('-').every(c => ABC_CHORD.test(c))
    }
    const isNoteLine = (l) => {
        const t = l.trim().split(/\s+/).filter(Boolean)
        return t.length >= 2 && t.every(isTok)
    }
    const lines = text.split(/\r?\n/).filter(l => l.trim())
    const noteLines = lines.filter(isNoteLine)
    const head = lines.filter(l => !isNoteLine(l)).map(l => l.match(/-?\d+/g)).find(n => n && n.length >= 3)
    const [speed, keyNum, meterNum] = head ? head.slice(0, 3).map(Number) : [null, null, null]

    const columns = []
    const TC_OF = {1: 0, 2: 1, 4: 2, 8: 3}
    for (const tok of noteLines.join(' ').split(/\s+/).filter(Boolean)) {
        const m = ABC_REPEAT.exec(tok)
        const repeat = m ? Math.max(1, Number(m[2])) : 1
        const body = m ? m[1] : tok
        const chords = ABC_REST.has(body) ? [null] : body.split('-')
        let tc = TC_OF[chords.length]
        if (tc === undefined) {
            tc = chords.length <= 3 ? 1 : chords.length <= 6 ? 2 : 3
            warn(`${tok}（${chords.length} 连音）无法精确表达，近似为 1/${2 ** tc} 拍`)
        }
        for (let r = 0; r < repeat; r++) {
            for (const c of chords) {
                const labels = c ? (c.match(/[ABC][1-5]/g) || []) : []
                columns.push({
                    tempoChanger: tc,
                    notes: [...new Set(labels.map(l => ABC_TO_INDEX[l]))].sort((a, b) => a - b)
                        .map(index => ({index, layer: 1n})),
                })
            }
        }
    }
    if (!head) warn('ABC 文件无元数据头，bpm 与调性需外部指定')
    return {
        meta: {
            name: null, bpm: speed || 240,
            pitch: (Number.isFinite(keyNum) && PITCHES[keyNum]) || 'C',
            meter: Number.isFinite(meterNum) ? `${meterNum / 4}/4` : '4/4',
            appName: 'Sky', reverb: false,
            sourceFormat: 'abc', sourceVersion: null,
            instruments: [], breakpointColumns: [0],
        },
        columns,
    }
}

// ---------------------------------------------------------------------------
// 中间形态 → 归一化事件流
// ---------------------------------------------------------------------------
function normalize(parsed, opts = {}) {
    const meta = parsed.meta
    const app = opts.app || (meta.appName === 'Genshin' ? 'Genshin' : 'Sky')
    const cfg = APPS[app]
    const semi = PITCHES.indexOf(meta.pitch) >= 0 ? PITCHES.indexOf(meta.pitch) : 0
    const toMidi = (i) => cfg.baseMidi + semi + Math.floor(i / 7) * 12 + MAJOR_SCALE[i % 7]
    // 层掩码是 BigInt（最高 52 层），展开成层号数组；layer 以十六进制串输出保证可 JSON 化
    const layerCache = new Map()
    const layersOf = (bits) => {
        const key = bits.toString(16)
        let hit = layerCache.get(key)
        if (!hit) {
            const out = []
            for (let b = 0n, v = bits; v > 0n; b++, v >>= 1n) if (v & 1n) out.push(Number(b))
            hit = {hex: key, list: out.length ? out : [0]}
            layerCache.set(key, hit)
        }
        return hit
    }
    const decorate = (n, slot) => {
        if (n.index < 0 || n.index >= cfg.keys) {
            warn(`音符索引 ${n.index} 超出 ${app} 的 0..${cfg.keys - 1}，已丢弃`)
            return null
        }
        const L = layersOf(n.layer)
        return {
            index: n.index,
            row: Math.floor(n.index / cfg.cols),      // 物理行（0 上 / 1 中 / 2 下）
            col: n.index % cfg.cols,                  // 物理列
            midi: toMidi(n.index),
            layer: L.hex,                             // 原始位掩码（hex 串）
            layers: L.list,                           // 展开的层号，对应 meta.instruments 下标
            ...(slot !== undefined ? {slot} : {}),
        }
    }

    // 同一时刻的同一个 index 合并成一次按键 —— 一个物理键不可能同时按两次。
    // 层掩码按位或，与本仓 RecordedSong.toComposedSong() 的处理一致。
    // 曲库里实测有 149938 个这样的重复音符（集中在 3 首曲子）。
    let mergedCount = 0
    const dedupe = (notes) => {
        if (notes.length < 2) return notes
        const by = new Map()
        for (const n of notes) {
            const hit = by.get(n.index)
            if (hit) { hit.layer |= n.layer; mergedCount++ }
            else by.set(n.index, {...n})
        }
        return [...by.values()]
    }

    // 组装 (time, keys) 事件
    const events = []
    const colTimes = []
    if (parsed.absoluteNotes) {                        // recorded：按时刻分组
        const byTime = new Map()
        for (const n of parsed.absoluteNotes) {
            if (!byTime.has(n.time)) byTime.set(n.time, [])
            byTime.get(n.time).push(n)
        }
        for (const [time, ns] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
            const keys = dedupe(ns).map(n => decorate(n)).filter(Boolean)
            if (keys.length) events.push({time, keys, tempoChanger: null, column: null})
        }
    } else {                                           // composed / smc / abc：按列展开
        const msPerBeat = 60000 / meta.bpm
        let t = 0
        parsed.columns.forEach((col, ci) => {
            colTimes[ci] = Math.round(t)
            const keys = dedupe(col.notes).map(n => decorate(n, n.slot)).filter(Boolean)
            if (keys.length) events.push({time: Math.round(t), keys, tempoChanger: col.tempoChanger, column: ci})
            t += msPerBeat * (TEMPO_CHANGERS[col.tempoChanger] ?? 1)
        })
    }
    if (mergedCount) warn(`${mergedCount} 个音符与同时刻同键的音符合并（层掩码按位或）`)

    // 事件间隔 + 总时长
    for (let i = 0; i < events.length; i++) {
        events[i].deltaMs = i + 1 < events.length ? events[i + 1].time - events[i].time : 0
    }
    const lastCol = parsed.columns?.length ? colTimes[parsed.columns.length - 1] : 0
    const durationMs = Math.max(events.at(-1)?.time ?? 0, lastCol)

    // 门限时长（--gate）
    //
    // 曲谱格式只有 note-on，没有 note-off —— 「按住」这个概念在源数据里不存在
    // （见 README「音符时长」一节）。holdMs 是**固件侧策略参数的推导结果**，
    // 不是从曲谱里提取的信息，所以只在显式传 gate 时才出现。
    //
    // 截断按 index 而非 layer：同一个物理键被两个层同时触发也只是一个键，
    // 释放必须早于下一次按下，否则电磁铁 / 按键状态机会错乱。
    const gate = Number(opts.gate)
    let gateStats = null
    if (Number.isFinite(gate) && gate > 0) {
        const guard = Number.isFinite(Number(opts.gateGuard)) ? Math.max(0, Number(opts.gateGuard)) : 1
        const nextSame = new Array(cfg.keys).fill(null)   // 逆序扫，记录每个键的下一次触发时刻
        let clamped = 0, dropped = 0
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i]
            for (const k of e.keys) {
                const nxt = nextSame[k.index]
                if (nxt === null) {
                    k.holdMs = gate
                } else {
                    const room = nxt - e.time - guard
                    k.holdMs = Math.min(gate, Math.max(0, room))
                    if (k.holdMs < gate) { k.gateClamped = true; clamped++ }
                    if (k.holdMs === 0) dropped++
                }
            }
            for (const k of e.keys) nextSame[k.index] = e.time
        }
        gateStats = {ms: gate, guardMs: guard, clampedCount: clamped, zeroCount: dropped}
        if (dropped) warn(`${dropped} 个音符的同键重触发间隔 ≤ ${guard}ms，holdMs 归零`)
    }

    // 小节/段落标记 → 时刻
    const sections = (meta.breakpointColumns || [])
        .filter(c => c < colTimes.length)
        .map(c => ({column: c, time: colTimes[c]}))

    // 统计（用循环而非 Math.min(...arr)：万首级曲谱的展开数组会撑爆调用栈）
    let noteCount = 0, loMidi = Infinity, hiMidi = -Infinity
    const usedLayers = new Set()
    for (const e of events) for (const k of e.keys) {
        noteCount++
        if (k.midi < loMidi) loMidi = k.midi
        if (k.midi > hiMidi) hiMidi = k.midi
        for (const l of k.layers) usedLayers.add(l)
    }
    return {
        meta: {
            name: meta.name, sourceFormat: meta.sourceFormat, sourceVersion: meta.sourceVersion,
            app, keyCount: cfg.keys, rows: 3, cols: cfg.cols,
            bpm: meta.bpm, pitch: meta.pitch, transposeSemitones: semi,
            meter: meta.meter ?? null, difficulty: meta.difficulty ?? null,
            reverb: meta.reverb, instruments: meta.instruments,
            durationMs, noteCount, eventCount: events.length,
            columnCount: parsed.columns?.length ?? null,
            midiRange: noteCount ? [loMidi, hiMidi] : null,
            usedLayers: [...usedLayers].sort((a, b) => a - b),
            mergedCount,                       // 因同时刻同键而合并掉的音符数
            gate: gateStats,                   // null = 未启用 --gate，keys 里也不会有 holdMs
        },
        sections,
        events,
        warnings: [...warnings],
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export function parseAny(text, opts = {}) {
    warnings.length = 0
    const trimmed = text.trimStart()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        const raw = JSON.parse(text)
        const s = Array.isArray(raw) ? raw[0] : raw
        const type = s?.type
            ?? (s?.data?.isComposedVersion === true ? 'composed'
              : s?.data?.isComposedVersion === false ? 'recorded' : null)
        if (type === 'composed') return normalize(fromComposed(s), opts)
        if (type === 'recorded') return normalize(fromRecorded(s), opts)
        throw new Error(`不支持的歌曲类型 ${JSON.stringify(type)}（vsrg / midi 等未支持）`)
    }
    if (/曲谱:\[/.test(text)) return normalize(fromSmc(text), opts)
    const looksAbc = text.split(/\r?\n/).some(l => {
        const t = l.trim().split(/\s+/).filter(Boolean)
        return t.length >= 2 && t.every(x => ABC_REST.has(x) || ABC_CHORD.test(x.split('*')[0].split('-')[0]))
    })
    if (looksAbc) return normalize(fromAbc(text), opts)
    throw new Error('无法识别的格式。已支持：composed/recorded JSON、smc 文本谱、Sky Studio ABC txt / Sky ABC1-5')
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2)
    const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
    const file = args.find((a, i) => !a.startsWith('--') && !['--app', '--gate', '--gate-guard'].includes(args[i - 1]))
    if (!file) {
        console.error('用法: node test-sheets/normalizeSheet.js <file> [--app Sky|Genshin]\n' +
            '                                     [--gate <ms>] [--gate-guard <ms>] [--json] [--pretty]\n\n' +
            '  --gate <ms>        为每个音符推导 holdMs（按下时长）。曲谱本身没有音符时长，\n' +
            '                     这是固件侧策略参数：同一物理键的下次触发会截断它。\n' +
            '  --gate-guard <ms>  截断时预留的释放余量，默认 1ms。')
        process.exit(1)
    }
    const r = parseAny(fs.readFileSync(file, 'utf-8'),
        {app: flag('--app'), gate: flag('--gate'), gateGuard: flag('--gate-guard')})
    if (args.includes('--json')) {
        console.log(JSON.stringify(r, null, args.includes('--pretty') ? 1 : 0))
    } else {
        const m = r.meta
        console.log(`曲名      ${m.name ?? '(无)'}`)
        console.log(`来源      ${m.sourceFormat}${m.sourceVersion ? ' v' + m.sourceVersion : ''}`)
        console.log(`乐器      ${m.app}  ${m.keyCount} 键（${m.rows}×${m.cols}）`)
        console.log(`速度/调性 bpm ${m.bpm} / ${m.pitch}（移调 ${m.transposeSemitones} 半音）`)
        console.log(`时长      ${(m.durationMs / 1000).toFixed(1)}s  |  ${m.eventCount} 事件 / ${m.noteCount} 音符`)
        console.log(`音高范围  MIDI ${m.midiRange?.join(' – ') ?? '-'}`)
        console.log(`段落标记  ${r.sections.length} 个  |  使用层 ${m.usedLayers.join(', ')}`)
        if (m.instruments.length) console.log(`乐器配置  ${m.instruments.map(i => i.name + (i.muted ? '(静音)' : '')).join(', ')}`)
        if (m.gate) console.log(`门限时长  ${m.gate.ms}ms（余量 ${m.gate.guardMs}ms）` +
            `  被截断 ${m.gate.clampedCount} / ${m.noteCount}` +
            `（${(m.gate.clampedCount / m.noteCount * 100).toFixed(1)}%）`)
        console.log(`\n前 5 个事件：`)
        for (const e of r.events.slice(0, 5)) {
            console.log(`  ${String(e.time).padStart(6)}ms  Δ${String(e.deltaMs).padStart(4)}  ` +
                e.keys.map(k => `[${k.index} r${k.row}c${k.col} MIDI${k.midi} L${k.layers.join(',')}` +
                    (k.holdMs !== undefined ? ` ⏱${k.holdMs}${k.gateClamped ? '!' : ''}` : '') + ']').join(' '))
        }
        if (r.warnings.length) console.log('\n警告:\n  ' + r.warnings.join('\n  '))
    }
}

/* 输出结构
{
  meta: { name, sourceFormat, sourceVersion, app, keyCount, rows, cols,
          bpm, pitch, transposeSemitones, meter, difficulty, reverb,
          instruments[], durationMs, noteCount, eventCount, columnCount,
          midiRange, usedLayers[],
          gate: null | { ms, guardMs, clampedCount, zeroCount } },
  sections: [{ column, time }],              // 小节/段落标记 → 时刻
  events:   [{ time, deltaMs, tempoChanger, column,
               keys: [{ index,        // 0..keyCount-1，游戏内键位编号
                        row, col,     // 物理行列，直接用于 LED 寻址
                        midi,         // 绝对音高，已含调性移调
                        layer,        // 原始层位掩码（hex 串，最高 52 位）
                        layers[],     // 展开的层号，对应 meta.instruments 下标
                        holdMs?,      // 仅 --gate：按下时长，被同键下次触发截断
                        gateClamped?, // 仅 --gate：该音符的 holdMs 短于设定值
                        slot? }] }],  // smc 专有：该音符在时值内的行位（0 上 /1 中 /2 下）
  warnings: []
}
*/
