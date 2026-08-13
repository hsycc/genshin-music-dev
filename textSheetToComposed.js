#!/usr/bin/env node
/**
 * 把文本曲谱转换成 composed v3 JSON（可直接导入 Sky / Genshin music）
 *
 * 输入格式:
 *   曲名:[...] 速度:[120] 节拍:[4/4] 调性:[Ab(8vb)] 难度:[4] 曲谱:[1FD 1FD ... 000<]
 *
 * 曲谱规则:
 *   - 一个「时值」= 4 个字符: 前 3 字符是同时按下的 3 个音（'0' 表示该槽位无音），
 *     第 4 字符是小节拍号标记
 *   - 8 个时值 = 1 小节，时值总数必须是 8 的倍数
 *   - 每小节第 8 个时值的第 4 字符: '>' = 4/4 拍（保留 8 拍）
 *                                   '<' = 3/4 拍（删去该小节后 2 拍）
 *     前 7 个时值的第 4 字符无意义（通常是空格）
 *   - 默认一个时值 = 八分音符
 *
 * 用法:
 *   node scripts/textSheetToComposed.js <input.txt> [options]
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// ---------------------------------------------------------------------------
// 字符 → 音符索引 映射
// ---------------------------------------------------------------------------
// 音符索引是目标应用的键位下标: Sky 0..14（3 行 × 5），Genshin 0..20（3 行 × 7）。
//
// 默认映射按「低音区用唱名首字母 / 中音区用简谱数字 / 8 = 高音 do」推导，
// 依据是样本里 6 个和弦 1FD / 8LM / LS0 / 0FD / 0M0 / 000 在该映射下
// 槽位音高严格递减（7>3>0, 14>5>2, 5>4, 3>0），且值域恰好铺满 Sky 的 0..14。
// 如果你的谱子用的是别的字符体系，用 --map 传一个 {"字符": 索引} 的 JSON 覆盖。
const DEFAULT_NOTE_MAP = {
    // 低音区 do re mi fa sol la ti
    D: 0, R: 1, M: 2, F: 3, S: 4, L: 5, T: 6,
    B: 6,  // si 的另一种写法，与 T 同音
    // 中音区 1..7
    '1': 7, '2': 8, '3': 9, '4': 10, '5': 11, '6': 12, '7': 13,
    // 高音 do
    '8': 14,
}

const REST_CHARS = new Set(['0', ' ', '-', '_'])

const BEATS_PER_MEASURE = 8
const NOTES_PER_COLUMN = {Sky: 15, Genshin: 21}
const DEFAULT_INSTRUMENT = {Sky: 'Piano', Genshin: 'Lyre'}
const DEFAULT_VOLUME = {Sky: 100, Genshin: 90}
const ICONS = ['border', 'circle', 'line']
const PITCHES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const USAGE = `
用法: node scripts/textSheetToComposed.js <input.txt> [options]

  -o, --out <file>          输出路径（默认与输入同目录，<曲名>.skysheet.json）
      --app <Sky|Genshin>   目标应用，决定键位上限 15/21（默认 Sky）
      --subdivision <n>     一个时值代表几分音符: 4 / 8 / 16（默认 8）
      --bpm <n>             直接指定输出 bpm，覆盖 subdivision 推算
      --pitch <P>           覆盖调性（即 1 = 该音），取值 ${PITCHES.join(' ')}
      --instrument <name>   乐器名（默认 Sky=Piano, Genshin=Lyre）
      --map <file.json>     自定义字符→音符索引映射，形如 {"1": 7, "D": 0}
      --breakpoints <none|measure>  是否给每个小节起点打断点（默认 none）
      --name <s>            覆盖曲名
      --raw                 输出裸对象，不用数组包一层
      --dry                 只打印统计，不写文件
  -h, --help                显示本帮助
`.trim()

function parseArgs(argv) {
    const opts = {
        app: 'Sky', subdivision: 8,
        breakpoints: 'none', raw: false, dry: false,
    }
    const positional = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const next = () => {
            const v = argv[++i]
            if (v === undefined) fail(`选项 ${a} 缺少参数`)
            return v
        }
        switch (a) {
            case '-h': case '--help': console.log(USAGE); process.exit(0); break
            case '-o': case '--out': opts.out = next(); break
            case '--app': opts.app = next(); break
            case '--subdivision': opts.subdivision = Number(next()); break
            case '--bpm': opts.bpm = Number(next()); break
            case '--pitch': opts.pitch = next(); break
            case '--instrument': opts.instrument = next(); break
            case '--map': opts.map = next(); break
            case '--breakpoints': opts.breakpoints = next(); break
            case '--name': opts.name = next(); break
            case '--raw': opts.raw = true; break
            case '--dry': opts.dry = true; break
            default:
                if (a.startsWith('-')) fail(`未知选项 ${a}`)
                positional.push(a)
        }
    }
    opts.input = positional[0]
    return opts
}

function fail(msg) {
    console.error(`[错误] ${msg}`)
    process.exit(1)
}

function warn(msg) {
    console.error(`[警告] ${msg}`)
}

// ---------------------------------------------------------------------------
// 解析头部字段
// ---------------------------------------------------------------------------
function readField(text, label) {
    // 曲谱正文里可能有空格，但不会有 ']'，所以 [^\]]* 是安全的
    const m = text.match(new RegExp(`${label}:\\[([^\\]]*)\\]`))
    return m ? m[1] : null
}

function parseHeader(text) {
    const body = readField(text, '曲谱')
    if (body === null) fail('没找到 曲谱:[...] 字段')
    return {
        name: readField(text, '曲名'),
        speed: readField(text, '速度'),
        meter: readField(text, '节拍'),
        key: readField(text, '调性'),
        difficulty: readField(text, '难度'),
        body,
    }
}

/** 调性 "Ab(8vb)" → "Ab"；无法识别时回退 C */
/** 音名 → 相对 C 的半音数 */
const SEMITONE = {
    C: 0, 'B#': 0, Db: 1, 'C#': 1, D: 2, Eb: 3, 'D#': 3, E: 4, Fb: 4,
    F: 5, 'E#': 5, Gb: 6, 'F#': 6, G: 7, Ab: 8, 'G#': 8, A: 9,
    Bb: 10, 'A#': 10, B: 11, Cb: 11,
}

/**
 * 解析 `调性` 字段 → composed 格式的 `pitch`
 *
 * 前提：谱面数字是**首调记谱（movable do）**，`1` 即调性主音。
 * composed 的 `pitch` 是「相对 C 的半音移调量」，所以
 *     pitch = 能让 `1` 落到该音高上的移调值 = 「1 =」右边的那个音。
 *
 * 大小调的处理：简谱惯例把调号写成 `1 = 关系大调主音`
 * （a 小调写 `1=C`，而不是 `1=A`），所以只要字段给的是「1=」的值，
 * 大调小调都无需换算。但若字段给的是**调式主音**（写成 `Am` / `a小调`），
 * 就必须换算到关系大调（小调主音 + 3 个半音），否则整首会差三度。
 *
 * 支持的写法：`Ab` `bA` `A♭` `1=bA` `1=Ab` `Am` `a小调` `Ab minor` …
 */
function parseKey(raw) {
    if (!raw) return {pitch: 'C', octave: null, note: null}

    // 八度记号 8va / 8vb / 15ma / 15mb
    const octave = raw.match(/\((\d+(?:v[ab]|m[ab]))\)/i)
    let body = raw.replace(/\(.*?\)/g, '').trim()

    // 简谱惯用前缀「1=」，出现即表示右边就是 do 的音高，无需大小调换算
    const explicit1Eq = /^\s*1\s*[=＝]/.test(body)
    if (explicit1Eq) body = body.replace(/^\s*1\s*[=＝]\s*/, '')

    // 小调标记
    const minorMark = /(m(in(or)?)?|小调|moll)\s*$/i.test(body) && !/^[A-G]?maj/i.test(body)
    if (minorMark) body = body.replace(/(m(in(or)?)?|小调|moll)\s*$/i, '').trim()
    body = body.replace(/(大调|major|maj|dur)\s*$/i, '').trim()

    // 归一化：Unicode 升降号、前缀式 bA / #F、大小写
    let n = body.replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s+/g, '')
    if (/^[b#][A-Ga-g]$/.test(n)) n = n[1].toUpperCase() + n[0]      // bA → Ab
    else if (n.length) n = n[0].toUpperCase() + n.slice(1)

    if (!(n in SEMITONE)) {
        warn(`调性 "${raw}" 无法识别，回退为 C（可用 --pitch 指定）`)
        return {pitch: 'C', octave: octave ? octave[1] : null, note: null}
    }

    let semi = SEMITONE[n]
    // 小调且没有「1=」前缀 → 字段给的是调式主音，换算到关系大调
    if (minorMark && !explicit1Eq) {
        semi = (semi + 3) % 12
        warn(`调性 "${raw}" 识别为小调，按关系大调换算：1 = ${PITCHES[semi]}`)
    }
    return {pitch: PITCHES[semi], octave: octave ? octave[1] : null, note: n}
}

// ---------------------------------------------------------------------------
// 解析曲谱正文
// ---------------------------------------------------------------------------
/**
 * 切成 4 字符一组的时值。注意不能 trim——最后一组的第 4 字符
 * 可能就是有意义的空格，缺位时补空格。
 */
function splitBeats(body) {
    const beats = []
    for (let i = 0; i < body.length; i += 4) {
        beats.push(body.slice(i, i + 4).padEnd(4, ' '))
    }
    return beats
}

/** 按小节切分，并按第 8 拍的标记裁掉 3/4 小节的后 2 拍 */
function applyMeters(beats) {
    if (beats.length % BEATS_PER_MEASURE !== 0) {
        fail(`时值总数 ${beats.length} 不是 ${BEATS_PER_MEASURE} 的倍数，小节不完整`)
    }
    const measures = []
    let threeFourCount = 0
    for (let i = 0; i < beats.length; i += BEATS_PER_MEASURE) {
        const measure = beats.slice(i, i + BEATS_PER_MEASURE)
        const marker = measure[BEATS_PER_MEASURE - 1][3]
        const index = i / BEATS_PER_MEASURE
        let kept
        if (marker === '<') {
            kept = measure.slice(0, 6)
            threeFourCount++
        } else if (marker === '>') {
            kept = measure
        } else {
            warn(`第 ${index + 1} 小节末尾标记是 ${JSON.stringify(marker)}（既非 '<' 也非 '>'），按 4/4 处理`)
            kept = measure
        }
        measures.push({index, marker, beats: kept})
    }
    return {measures, threeFourCount}
}

/** 一个时值 → [{slot, index}]，'0' 视为休止 */
function beatToNotes(beat, noteMap, maxNote, location) {
    const notes = []
    for (let slot = 0; slot < 3; slot++) {
        const ch = beat[slot]
        if (REST_CHARS.has(ch)) continue
        const index = noteMap[ch] ?? noteMap[ch.toUpperCase()]
        if (index === undefined) {
            fail(`${location} 出现未知字符 ${JSON.stringify(ch)}（第 ${slot + 1} 个槽位）。`
                + `\n       已知字符: ${Object.keys(noteMap).join(' ')}`
                + `\n       用 --map <file.json> 提供完整的字符→音符索引映射`)
        }
        if (!Number.isInteger(index) || index < 0 || index >= maxNote) {
            fail(`${location} 字符 ${JSON.stringify(ch)} 映射到索引 ${index}，超出范围 0..${maxNote - 1}`)
        }
        notes.push({slot, index})
    }
    return notes
}

// ---------------------------------------------------------------------------
// 构建 composed v3
// ---------------------------------------------------------------------------
function buildSong(parsed, opts) {
    const maxNote = NOTES_PER_COLUMN[opts.app]
    const noteMap = opts.noteMap

    const beats = splitBeats(parsed.body)
    const {measures, threeFourCount} = applyMeters(beats)

    const columns = []
    const breakpoints = [0]
    const usedChars = new Set()
    let noteCount = 0

    for (const measure of measures) {
        if (opts.breakpoints === 'measure' && columns.length > 0) {
            breakpoints.push(columns.length)
        }
        measure.beats.forEach((beat, beatIdx) => {
            const location = `第 ${measure.index + 1} 小节第 ${beatIdx + 1} 拍`
            const notes = beatToNotes(beat, noteMap, maxNote, location)
            for (let i = 0; i < 3; i++) if (!REST_CHARS.has(beat[i])) usedChars.add(beat[i])

            // 同一列里同一个音符索引可能来自多个槽位，去重即可（槽位语义未定，不做分层）
            const layerByIndex = new Map()
            for (const {index} of notes) {
                layerByIndex.set(index, 1)
            }
            noteCount += layerByIndex.size
            const serializedNotes = [...layerByIndex.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([index, layer]) => [index, layer.toString(16)])
            // tempoChanger 固定 0（= 1 倍速），时长统一由 bpm 控制
            columns.push([0, serializedNotes])
        })
    }

    const instruments = [{
        name: opts.instrument,
        volume: DEFAULT_VOLUME[opts.app],
        pitch: '',
        visible: true,
        icon: ICONS[1],
        alias: '',
        muted: false,
        reverbOverride: null,
    }]

    const song = {
        name: opts.name ?? parsed.name ?? 'Untitled',
        type: 'composed',
        bpm: opts.bpm,
        pitch: opts.pitch,
        version: 3,
        folderId: null,
        data: {isComposed: true, isComposedVersion: true, appName: opts.app},
        reverb: false,
        breakpoints,
        instruments,
        columns,
        id: null,
    }
    return {song, stats: {measures, threeFourCount, beats, columns, noteCount, usedChars}}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
    const opts = parseArgs(process.argv.slice(2))
    if (!opts.input) {
        console.error(USAGE)
        process.exit(1)
    }
    if (!NOTES_PER_COLUMN[opts.app]) fail(`--app 只能是 Sky 或 Genshin，收到 ${opts.app}`)
    if (!['none', 'measure'].includes(opts.breakpoints)) fail(`--breakpoints 只能是 none 或 measure`)
    if (![4, 8, 16, 32].includes(opts.subdivision)) fail(`--subdivision 只能是 4 / 8 / 16 / 32`)

    const text = fs.readFileSync(opts.input, 'utf-8')
    const parsed = parseHeader(text)

    // 字符映射
    opts.noteMap = {...DEFAULT_NOTE_MAP}
    if (opts.map) {
        const custom = JSON.parse(fs.readFileSync(opts.map, 'utf-8'))
        opts.noteMap = custom
    }

    // bpm: 每个 column 的时长 = 60000/bpm 毫秒（tempoChanger 恒为 1 倍速）。
    // 想让 1 个 column 对应 1/subdivision 音符，就要 bpm = 速度 × subdivision / 4
    const speed = Number(parsed.speed)
    if (!opts.bpm) {
        if (!Number.isFinite(speed) || speed <= 0) {
            fail(`速度 "${parsed.speed}" 不是有效数字，请用 --bpm 指定`)
        }
        opts.bpm = Math.round(speed * opts.subdivision / 4)
    }
    if (opts.bpm > 10000) warn(`bpm ${opts.bpm} 超出应用设置上限 10000`)

    // 调性
    const parsedKey = parseKey(parsed.key)
    opts.pitch = opts.pitch ?? parsedKey.pitch
    if (!PITCHES.includes(opts.pitch)) fail(`--pitch 只能是 ${PITCHES.join(' ')}`)
    if (parsedKey.octave) {
        warn(`调性里的 "${parsedKey.octave}" 八度记号无法表达（composed 格式无八度字段），已忽略`)
    }

    opts.instrument = opts.instrument ?? DEFAULT_INSTRUMENT[opts.app]

    const {song, stats} = buildSong(parsed, opts)

    // 报告
    const durationMs = stats.columns.length * (60000 / opts.bpm)
    const mm = Math.floor(durationMs / 60000)
    const ss = Math.round((durationMs % 60000) / 1000)
    console.error([
        `曲名        ${song.name}`,
        `目标应用    ${opts.app}（键位 0..${NOTES_PER_COLUMN[opts.app] - 1}）`,
        `速度/节拍   ${parsed.speed ?? '?'} / ${parsed.meter ?? '?'}  →  输出 bpm ${opts.bpm}（1 列 = ${opts.subdivision} 分音符）`,
        `调性        ${parsed.key ?? '?'}  →  pitch "${opts.pitch}"`,
        `小节        ${stats.measures.length}（其中 3/4 拍 ${stats.threeFourCount} 个，各删去后 2 拍）`,
        `时值        ${stats.beats.length} → 列数 ${stats.columns.length}`,
        `音符        ${stats.noteCount}`,
        `估算时长    ${mm}:${String(ss).padStart(2, '0')}`,
        `字符映射    ${[...stats.usedChars].sort().map(c => `${c}→${opts.noteMap[c] ?? opts.noteMap[c.toUpperCase()]}`).join('  ')}`,
    ].join('\n'))

    if (opts.dry) {
        console.error('\n--dry 模式，未写文件')
        return
    }

    const ext = opts.app === 'Sky' ? 'skysheet.json' : 'genshinsheet.json'
    const out = opts.out ?? path.join(
        path.dirname(path.resolve(opts.input)),
        `${song.name.replace(/[/\\:*?"<>|]/g, '_')}.${ext}`
    )
    const payload = opts.raw ? song : [song]
    fs.writeFileSync(out, JSON.stringify(payload, null, 1), 'utf-8')
    console.error(`\n已写入 ${out}`)
}

main()
