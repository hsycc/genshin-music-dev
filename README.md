# test-sheets

文本曲谱 → composed v3 JSON 的转换素材，配合 [`textSheetToComposed.js`](./textSheetToComposed.js) 使用。

与仓库自带的 `test-songs/`（上游用来测各版本导入的真实导出文件）区分开：这里放的是**文本谱输入**和**转换产物**。

## 文件

| 文件 | 说明 |
|---|---|
| `你你234你你123你.txt` | 输入文本谱。`曲名:[] 速度:[120] 节拍:[4/4] 调性:[Ab(8vb)] 难度:[4] 曲谱:[...]`，408 时值 / 51 小节 |
| `你你234你你123你.skysheet.json` | 转换产物。378 列 / 471 音符 |
| `note-map.example.json` | 字符 → 音符索引映射表示例，传给 `--map` |
| `adversarial-roundtrip.skysheet.json` | 往返测试的对抗样本 |
| `normalizeSheet.js` | **归一化器**：四种输入格式 → 统一事件流（硬件用） |
| `roundTripCorpus.js` | 对整个曲库跑往返测试，统计损耗分布 |
| `format-versions/` | composed / recorded 各历史版本的结构对照样本 |
| `text-export/` | app 自带文本谱导出格式的渲染样例 |
| `invalid/` | 触发各条报错分支的畸形输入 |
| `text-format-spec.md` | 格式规范：作者原始说明 + 源码核对结论 |
| `reference/琴谱格式转换工具.html` | **作者的转换工具**（原件，未改动） |
| `reference/光遇乐谱编辑器(test_20260820).html` | **作者的编辑器**（原件）。TurboWarp 打包的 Scratch 项目，13.4 MB；解包方法与核对结论见 spec |

## 重新生成

```bash
node test-sheets/textSheetToComposed.js "test-sheets/你你234你你123你.txt"
```

不带 `-o` 时输出落在**输入文件同目录**，文件名取 `曲名` 字段。

## 归一化器 `normalizeSheet.js`

`textSheetToComposed.js` 是**文本谱 → 本仓 JSON** 的单向转换器。硬件侧需要的是反方向：
把任意来源的曲谱读成一条**可直接驱动键盘的事件流**。这是 `normalizeSheet.js`。

```bash
node test-sheets/normalizeSheet.js <file> [--app Sky|Genshin]
                                   [--gate <ms>] [--gate-guard <ms>] [--json] [--pretty]
```

### 支持的输入（自动识别，不看扩展名）

| 输入 | 识别依据 | 曲库占比 |
|---|---|---|
| composed v1/v2/v3 JSON | `type` 或 `data.isComposedVersion` | 78.05% |
| recorded v1/v2 JSON | 同上 | 21.94% |
| smc 文本谱 | 含 `曲谱:[...]` | — |
| Sky Studio ABC txt / Sky ABC1-5 | 存在整行都是 ABC token 的行 | — |

`vsrg` 和 `midi` 类型显式报错，不静默产出空结果。

### 输出结构

```jsonc
{
  "meta": {
    "name", "sourceFormat", "sourceVersion",
    "app", "keyCount", "rows", "cols",          // Sky 3×5=15 / Genshin 3×7=21
    "bpm", "pitch", "transposeSemitones",       // pitch 已折算成半音数
    "meter", "difficulty", "reverb",
    "instruments": [{ "name", "volume", "pitch", "muted", "alias", "icon",
                      "visible", "reverbOverride" }],
    "durationMs", "noteCount", "eventCount", "columnCount",
    "midiRange": [lo, hi],
    "usedLayers": [0, 1, 2],                    // 实际用到的层，可预分配音色
    "mergedCount",                              // 因同时刻同键而合并掉的音符数
    "gate": null                                // 传 --gate 后为 { ms, guardMs, clampedCount, zeroCount }
  },
  "sections": [{ "column", "time" }],           // 小节 / 段落标记 → 时刻
  "events": [{
    "time",          // ms，绝对时刻
    "deltaMs",       // 到下一事件的间隔，定时器直接用这个
    "tempoChanger",  // 该列的变速档 0..3（recorded 来源为 null）
    "column",        // 原列号，用于回溯或滚动显示
    "keys": [{
      "index",       // 0..keyCount-1，游戏内键位编号
      "row", "col",  // 物理行列 —— LED 寻址直接用
      "midi",        // 绝对音高，已含调性移调
      "layer",       // 原始层位掩码（hex 串，最高 52 位）
      "layers": [],  // 展开的层号，对应 meta.instruments 下标
      "slot",        // smc 专有：时值内的行位（0 上 / 1 中 / 2 下）
      "holdMs",      // 仅 --gate：按下时长
      "gateClamped"  // 仅 --gate：该音符被同键的下次触发截短了
    }]
  }],
  "warnings": []
}
```

关键设计：**按同时发声分组**。一个 `event` 就是"这一刻要按下的所有键"，
和弦不用在消费端二次聚合，LED 一次点亮一组。

同一事件内**同一个 `index` 会被合并**（层掩码按位或），因为一个物理键不可能
同时按两次。曲库里实测有 149938 个这样的重复音符（集中在 3 首曲子里）。

### `--gate`：推导按键时长

曲谱格式只有 note-on 没有 note-off（见下方「音符时长」），所以 `holdMs`
**不是从曲谱里提取的，是固件侧策略参数的推导结果** —— 只在显式传 `--gate` 时才出现，
不传就完全没有这个字段，避免被误当成原始数据。

```
holdMs = min(gate, 同一 index 的下次触发时刻 - 当前时刻 - guard)
```

截断按 `index` 而不是 `layer`：同一个物理键被两个层同时触发也只是一个键，
释放必须早于下一次按下，否则电磁铁 / 按键状态机会错乱。`--gate-guard` 是预留的
释放余量，默认 1ms。被截短的音符带 `gateClamped: true`，方便定位哪里门限没吃满。

全曲库的截断率：

| gate | 被截断 | 占比 |
|---|---|---|
| 50ms | 91,476 | 0.87% |
| 80ms | 135,220 | 1.29% |
| 120ms | 387,953 | 3.69% |
| 200ms | 1,055,221 | 10.03% |

**这个表本身就是一次校验。** 没做同键合并之前，80ms 的截断率是 2.56%——
那 149938 个重复音符被当成「同键 0ms 重触发」全部截断，是假象。合并后掉到 1.29%。

另有 83 个音符即使 guard 只有 1ms 也归零，全部来自 `Beat that (Gabe).txt`：
同一个键在 7808 / 7809 / 7810 / 7811ms 连续触发。这是录制时的抖动，
物理键盘按不出来，固件应当直接丢弃而不是尝试执行。

### 音符时长：为什么源数据里没有

四种格式**全部只存 note-on，没有 note-off**。游戏乐器是 one-shot 采样，
按一下播完固定衰减，「按住」这个概念本来就不存在。

想从「到下一个音符的间隔」倒推时长会撞上一个无解的歧义：同一个键在 0ms 和
500ms 各触发一次，可以是「连按两次短音」，也可以是「按住 500ms 再按一次」——
数据里这两者完全一样。推出来的 duration 是编造的，不是提取的。

上游自己也承认这点，导 MIDI 时直接写死占位符：

```ts
// src/lib/Songs/RecordedSong.ts:295
track.addNote({ time: note.time / 1000, duration: 1, midi: note.toMidi() || 0 })
```

所以归一化器默认不产出音符时长，`--gate` 是让这个推导**变显式**，而不是替你猜。

### `durationMs` 的一处不对称

| 来源 | 取值 |
|---|---|
| composed / smc / abc | `max(最后音符时刻, 最后一列时刻)` —— 含尾部空列 |
| recorded | 最后一个音符的时刻 —— 没有列的概念，尾部留白无从得知 |

同一首曲子走两条路径，`durationMs` 可能差几百毫秒。下面交叉验证的三条路径
都没暴露这个（都是网格系），不是它验证过了。

### 交叉验证

同一首曲子的三种表示喂进去，结果完全一致：

| 输入 | 事件 | 音符 | bpm | 调性 | MIDI 范围 |
|---|---|---|---|---|---|
| `Call Of Silence.smc` | 189 | 471 | 240 | Ab | 68–92 |
| `你你234你你123你.skysheet.json`（composed v3） | 189 | 471 | 240 | Ab | 68–92 |
| `text-export/你你234你你123你.skystudio.txt`（ABC） | 189 | 471 | 240 | Ab | 68–92 |

三条独立路径收敛，说明 smc 字符表、调性折算、时值换算三处都没有偏差。

### 全曲库压测

对 `Sky1984-Sheets-Collection`（16101 个文件）：

```
成功 16090 / 失败 11
事件 6,212,968   音符 10,522,649（合并同键重复 149,938 后）   段落标记 3,125
格式分布  composed v3: 12560   recorded v2: 3530
索引上限 14   MIDI 60–95   最长 layer 掩码 0x1000000000000（52 bit）
```

11 个失败全部是真的不支持，不是解析缺陷：`vsrg` 2、缺 `type` 字段 4、
非曲谱文本 4、JSON 本身损坏 1。

### 压测暴露的两个真 bug（已修）

**1. layer 位掩码溢出。** 曲库里实际存在 `0x1000000000000`（2^48）的层掩码。
本仓 `NoteLayer` 用 BigInt，`BASE_LAYER_LIMIT = 52`；用 `parseInt` + `1 << b`
读它会静默出错 —— JS 的移位运算把右操作数取模 32，`1 << 48` 等于 `1 << 16`，
层号会被算成 16。改为全程 BigInt，`layer` 以 hex 串输出保证可 JSON 序列化。

**2. `Math.min(...arr)` 爆栈。** 曲库里有一首 16 万音符的曲子，
展开成参数列表直接 `Maximum call stack size exceeded`。改成循环累计。
这一首贡献了 164212 音符 / 4545 事件 —— 修掉后总音符数从 1050 万涨到 1067 万。

## 字符映射（需要人工确认）

原始曲谱没有附带映射表，`note-map.example.json` 里的默认值是从数据反推的：

- 字母 `D R M F S L X` = 中音 1–7 → 索引 `0..6`
- 数字 `1..7` = 高音 1–7 → 索引 `7..13`
- `8` = 倍高音 1 → 索引 `14`

依据是样本里 6 个和弦 `1FD` `8LM` `LS0` `0FD` `0M0` `000` 在该映射下槽位音高严格递减
（`7>3>0`、`14>5>2`、`5>4`、`3>0`），且值域恰好铺满 Sky 的 15 键 `0..14`。

> ✅ **该映射已由格式作者工具的简谱渲染截图确证。**
>
> 用此映射把样本渲染成同样的三行堆叠格式，与截图逐位吻合
> （第 2 小节中行 `6 4 6 4 6 4 6 4`、下行 `3 1 3 1 3 1 3 1`，
> 第 1 小节上行 `1̇ 1̇ 1̇ 6`）。详见
> [`text-format-spec.md`](./text-format-spec.md)。
>
> **已由格式作者确认**（2026-08）：从中音 1 到倍高音 1 对应 `DRMFSLX12345678`。
> 注意第 7 个字符是 **`X`** —— 我曾按唱名首字母外推成 `T`，是错的，已改正。

遇到映射表以外的字符脚本会直接报错并指出小节/拍/槽位，不会静默产出错音；
换映射只需改 `--map` 传入的 JSON，不用改脚本。

## format-versions/

上游 `test-songs/` 里只有 v1 和远古格式的样本，缺 v2/v3。这三个文件是按
`ComposedSong.serialize()` / `RecordedSong.serialize()` 的实际逻辑从 v1 样本转换出来的，
用于肉眼对照结构差异：

| 文件 | 与前一版的差异 |
|---|---|
| `composed-v2.json` | 层掩码从**倒序二进制字符串**（`"100"`）改为**十六进制**（`"1"`） |
| `composed-v3.json` | `instruments` 从字符串数组改为对象数组（`volume` / `pitch` / `icon` / `muted` / `reverbOverride` 等），同时解除固定 4 层限制 |
| `recorded-v2.json` | note 元组从 `[index, time]` 补齐为 `[index, time, layer]` |

对照用的 v1 原件在 `../test-songs/new-format-composed.skysheet.json` 和
`../test-songs/new-format-recorded.skysheet.json`。

## invalid/

| 文件 | 预期报错 |
|---|---|
| `beats-not-multiple-of-8.txt` | `时值总数 2 不是 8 的倍数，小节不完整` |
| `unknown-char.txt` | `第 1 小节第 2 拍 出现未知字符 "Z"（第 3 个槽位）` |
| `missing-meter-marker.txt` | 警告 `第 1 小节末尾标记是 " "…按 4/4 处理`，随后正常转换 |

## text-export/

app 自带的文本谱导出格式（`/sheet-visualizer` 页面），**和上面那个第三方文本谱格式无关**，
是反方向的产物：本项目歌曲 → 文本。

格式规则由 2023-05-13 Discord `#polls` 投票选定（方案 2，64 票 vs 5 / 2），
实现在 `src/lib/Songs/VisualSong.ts`：

| 元素 | 含义 |
|---|---|
| `B5` | 单音，此处是 ABC 记谱 = 第 B 行第 5 列 |
| `A3B1` | 和弦，同时按下的音**直接拼接**，无分隔符 |
| 空格 | 分隔相邻列（一拍） |
| `(...)` | 变速 1/2 拍块 |
| `[...]` | 变速 1/4 拍块 |
| `{...}` | 变速 1/8 拍块 |
| `-` | 短停顿 |
| 空行 | 长停顿 |

括号档位与 composed 格式的 `tempoChanger` 字段一一对应（`0`=原速无括号，`1`/`2`/`3` 依次）。
`VisualSong.ts:171` 还留着一个 `TEMPO_CHANGERS` 表，是落选的方案 1（`*` `~` `^`），已无引用。

两份样例都来自 `../docs/assets/Example_Composed-Wintergatan-TOWRPN.skysheet.json`
（bpm 294，373 列，`tempoChanger` 全为 0，所以看不到括号）：

| 文件 | 记谱体系 | 15 键映射 |
|---|---|---|
| `Wintergatan-TOWRPN.ABC.txt` | ABC | `A1..A5` / `B1..B5` / `C1..C5`（按键盘三行分组） |
| `Wintergatan-TOWRPN.numbered.txt` | 简谱 `1 2 3` | `1..7` / `1̇..7̇` / `1̇̇`（按音阶走，八度点是 U+0307 组合字符） |

app 共支持 9 种记谱体系，定义在 `src/Config.ts` 的 `NoteNameType` / `LAYOUT_KINDS`：
`Note name` / `Keyboard layout` / `Your Keyboard layout` / `Do Re Mi` / `ABC` / `1 2 3` /
`No Text`，Sky 另有 `Playstation` / `Switch`（手柄按键）。

> 注意：格子谱和文本谱都**忽略歌曲的 `pitch` 和 `instruments` 字段** ——
> `SheetFrame2.tsx:111` 把 pitch 硬编码为 `'C'`。这只影响 `Note name` 和 `Do Re Mi`
> 两种按调性查表的记谱，其余按键位索引取名的不受影响。

## 往返测试 columns ↔ notes ↔ columns

`roundTripTest.js` 忠实移植了 `ComposedSong.toRecordedSong()` 和
`RecordedSong.toComposedSong()`，用来实测两种谱面表示互转的损耗。

```bash
node test-sheets/roundTripTest.js <composed.json> [precision=4]
```

### 结论：**单向无损** —— 方向不对称

| 方向 | 是否无损 |
|---|---|
| **composed → recorded** | ✅ **完全无损**。确定性展开，逐列累加时间戳，不合并、不量化、不丢弃 |
| **recorded → composed** | ⚠️ **有损**。需从时间间隔反推网格，是近似过程 |

```js
// composed → recorded：每列的音符打上累计时刻，一一对应
let t = 100
for (const col of columns) {
  for (const n of col.notes) notes.push({index: n.index, time: t})
  t += Math.round(msPerBeat * TEMPO_CHANGERS[col.tempoChanger])
}
```

### 反向的损耗 —— 全量实测

`roundTripCorpus.js` 对社区曲库逐首做 `composed → recorded → composed`
（样本：`Sky1984-Sheets-Collection` 前 2000 个文件中的 **1484 首 composed**）：

| 结果 | 数量 | 占比 |
|---|---:|---:|
| 完全一致 | 1024 | 69.0% |
| 仅尾部空列差异 | 37 | 2.5% |
| **网格结构变化** | **420** | **28.3%** |
| **音符集合不守恒** | **3** | **0.2%** |

```bash
node test-sheets/roundTripCorpus.js /path/to/Sky1984-Sheets-Collection [最大文件数]
```

> ⚠️ **本文档早期版本据 2 首样本断言「真实曲子上是无损的」，该结论已推翻。**
> 扩大到 1484 首后，近三成会发生网格结构变化。两首样本恰好都是变速规整的曲子，
> 不具代表性 —— **小样本上的"零差异"不能外推成"无损"**。

### 丢音符的三首：全是极端文件

| 文件 | bpm | 一拍 | 合并阈值 | 音符 |
|---|---:|---:|---:|---|
| `bm_ouranos` | 1276 | 47ms | 5.2ms | 164212 → 丢 125883 |
| `bm_ouranos`（变体） | 1276 | 47ms | 5.2ms | 63021 → 丢 24014 |
| `Touhou IN - Gensokyo…` | 650 | 92ms | 10.3ms | 1330 → 丢 41 |

成因：`toComposedSong` 用 `bpmToMs / 9` 作为和弦合并阈值。bpm 极高时阈值缩到 5ms，
**原本分处不同时刻的音符被并进同一列，再按索引去重就丢了**。
`bm_ouranos` 平均每列 28 个音符而乐器只有 15 个键，说明源文件同列存在重复索引，
去重必然丢——属病态文件，非常规情况。

### 对硬件/播放场景的意义

**只需要 `composed → 时间戳` 这个方向，而它是精确的。**

```
composed v3  ──精确──→  [(index, timeMs)]
recorded v2  ──直接就是──↗
```

反向转换只有作曲器需要。上面那 28.3% 的网格变化与 0.2% 的丢音符**都不影响播放**。

### 两类无害差异

1. **尾部空列被截断** —— 作曲器新建曲子默认填 100 列，往返后只保留到最后一个有音符的列。
   时间轴上不存在"末尾的空列"这个概念，重新打开编辑器会自动补齐。
2. **列内音符顺序变为索引升序** —— `RecordedSong.ts:233` 的 `Object.values(grouped)`，
   JS 对象的整数型键强制按数值升序迭代。同列内音符无序，语义等价。

### 真正的失败模式：连续同档变速列被合并

`toRecordedSong` 只把变速档折算成时间戳，变速信息本身不进 recorded 格式。
回来时靠 `RecordedSong.ts:196-213` 的贪心法从时间间隔重建，**从最大单位开始扣**：

```js
while (difference >= combinations[3]) {                              // ≥ 1/8 拍就继续
    if (difference / combinations[0] >= 1) { ... push(0) }           // 先试整拍
    else if (difference / combinations[1] >= 1) { ... push(1) }      // 再试 1/2
    ...
}
```

所以任何能凑成更大单位的连续同档列，都会被合并。对抗样本覆盖的情况：

| 构造 | 原始 | 往返后 |
|---|---|---|
| 两个 1/2 拍列，音符只在第一列 | `tc=1[音] tc=1[空]` | `tc=0[音]` |
| 八个 1/8 拍列，音符只在第一列 | `tc=3[音] + 7×tc=3[空]` | `tc=0[音]` |
| 两个 1/4 拍列 | `tc=2[音] tc=2[空]` | `tc=1[音]` |
| 整拍空列（对照组） | `tc=0[音] tc=0[空]×2 tc=0[音]` | 原样保留 ✓ |

20 列 → 11 列，变速档分布 `{0:8, 1:2, 2:2, 3:8}` → `{0:10, 1:1}`。
**听感和总时长完全一致**，变的只是网格结构。

真实创作里这种写法罕见——在编辑器里连写两个半拍空列，和直接用一个整拍列是等价操作，
所以两首真实曲子毫发无伤。

### 守恒性汇总

| 维度 | composed → recorded | recorded → composed |
|---|---|---|
| 音符集合（index + layer） | ✅ 精确 | ⚠️ 99.8% 守恒（极端高 bpm 文件会丢） |
| 音符时刻 | ✅ 精确 | ⚠️ 量化到网格 |
| 尾部空列 | — | ❌ 丢失（无害） |
| 列内音符顺序 | — | ❌ 变为升序（无害） |
| 网格结构（变速档序列） | — | ❌ 28.3% 会变 |
| `breakpoints` | ❌ 不携带 | ❌ 不重建 |

## 为什么 composed 和 recorded 是两种格式

分离不是后来的重构，从作曲器诞生那天就存在：

```
2021-04-15  Added song recording, menu and song playback     ← 应用最初只有 recorded
2021-04-18  Started composer, added song type selection (recorded / composed)
```

两者是**互不包含**的信息模型，不是冗余：

| | `recorded` | `composed` |
|---|---|---|
| 语义 | 演奏记录 | 乐谱 |
| 时间 | 绝对毫秒时间戳，每音符自带 | 网格序号，时长由 `bpm × tempoChanger` 推导 |
| 产生方式 | 用户实时弹奏（播放器录制） | 用户在画布上编辑 / MIDI 导入 |
| 可编辑性 | 只能整体重录 | 任意插入、删除、移调、复制列 |
| 独有信息 | 人手的非量化节奏偏差 | 变速档、`breakpoints` 小节标记 |

`recorded` 存不下变速档，`composed` 存不下非量化时间——这是分离的根本原因。
文件体积也有差别：Wintergatan 那首 481 个音符，composed 只需 373 个列序号，
recorded 要存 481 个毫秒值。

`new ComposedSong(...)` 全仓库只有 3 处调用，全在作曲器和 MIDI 导入器；
播放器录制走 `RecordedSong`。

## MIDI 转换链路与失真

`midiChainTest.js` 复现了 `MidiParser/index.tsx` 的 `convertMidi()` 和
`SongClasses.ts` 的 `MidiNote.fromMidi()`，内含一个最小 SMF 解析器（不依赖 node_modules）。

```bash
node test-sheets/midiChainTest.js --map              # 穷举 0..127 的映射覆盖
node test-sheets/midiChainTest.js <file.mid> [Sky|Genshin]
```

### 链路

```
.mid 文件 ──┐
            ├→ Midi 对象 → convertMidi() → MidiNote.fromMidi() → NoteColumn[] → ComposedSong
音频/视频 ──┘   （@spotify/basic-pitch 先转 MIDI）

ComposedSong → toRecordedSong() → RecordedSong.toMidi() → .mid 导出
```

### 实测失真（`../test-songs/` 里的三个 .mid）

| 文件 | 音符数 | 可映射 | 丢弃率 |
|---|---:|---:|---:|
| `The_Sound_of_Silence.mid` | 3314 | 1448 | **56.3%** |
| `MIDI Test.mid` | 15 | 8 | 46.7% |
| `new song.mid` | 15 | 15 | 0% |

Sound of Silence 六条轨里**三条整轨全灭**（1295 个音符全部超范围），典型是贝斯和低音声部。

主要损失来源：

1. **音高范围截断** —— Sky 只认 MIDI `60..84`（25 个半音），Genshin `48..84`。
   界外音符直接丢弃，`maxScaling=0`（默认）时不做任何折叠。
2. **变化音（黑键）** —— Sky 25 个半音里 15 本位音 / 10 变化音。
   关闭 UI 的 "include accidentals" 后，Sound of Silence 从 1448 再砍到 **238**（原始的 7.2%）。
   乐器本身是全音阶的（15/21 键 = do..ti），这是物理约束。
3. **力度 velocity** —— 格式无此字段，全丢。
4. **音符时长 duration** —— 只存起始时刻；导出时统一写死 `duration: 1`（`RecordedSong.ts:295`）。
   重叠音、延音无法表达。
5. **时间量化** —— 按 `bpmToMs / 9` 合并成列。Sound of Silence 阈值 27.8ms，1448 音符 → 615 列，
   列内先后关系被抹平。
6. **bpm ×4** —— `Math.floor(bpm * 4)`，因为一列代表 1/4 拍。这是刻意换算，
   但小数 bpm 会被 floor 吃掉。

### 与 composed↔recorded 往返的对比

| 转换 | 损失程度 |
|---|---|
| `composed → recorded` | **精确无损** |
| `recorded → composed` | 28.3% 网格结构变化，0.2% 丢音符 |
| `MIDI → composed` | **典型丢 50%+ 音符**，力度/时长/延音全丢 |
| `composed → MIDI` | 只剩本位音（`NOTE_MAP_TO_MIDI` 只收 `isAccidental === false` 的条目），时长写死 |

信息落差的根源是目标乐器只有 15/21 个全音阶键位，而 MIDI 是 128 个半音的通用协议。
这部分是物理约束，不是实现问题。但下面两条是可修的实现缺陷。

### 发现的两个实现缺陷

**① 八度折叠用了 ±8 半音而非 ±12**（`SongClasses.ts:311`，引入于 2022-11-09 `903df790`）

```js
if (midiNote < MIDI_BOUNDS.lower) midiNote += 8   // 一个八度是 12 个半音
if (midiNote > MIDI_BOUNDS.upper) midiNote -= 8
```

`±8` 是小六度，折叠后音名改变。实测四个边界点 Sky/Genshin 全部与正确八度折叠不一致：

| 原始 MIDI | `±8` 得到键位 | `±12` 应得 |
|---:|---:|---:|
| 55 | 1 | 4 |
| 59 | 4 | 6 |
| 85 | 10 | 7 |
| 89 | 12 | 10 |

默认 `maxScaling = 0`，只有用户手动调了 UI 上的 scaling 滑块才触发。

实测（`../test-songs/The_Sound_of_Silence.mid`，Sky，`maxScaling=1`，界外 1866 / 3314）：

```bash
node test-sheets/midiChainTest.js --scaling "test-songs/The_Sound_of_Silence.mid" Sky 1
```

**唯一该看的指标是「实际发声音高相对源音的音级偏差」**（差值模 12，纯八度移调记 0）。
按键位统计白键/黑键数量是伪指标，会得出相反结论。

| | 偏差 0 | −4 | −5 | −1 | 已导入 | **平均绝对偏差** |
|---|---:|---:|---:|---:|---:|---:|
| 当前 `±8` | **0** | 436 | 227 | 0 | 663 | **4.34 半音** |
| 修复 `±12` | **124** | 0 | 0 | 1152 | 1276 | **0.90 半音** |

**`±8` 导入的 663 个音，音名正确的是 0 个**，全部走音大三度或四度。
那 436 个"落在白键上"的，偏差全是 −4 —— 白键上弹的是错音。

`±12` 的 1152 个 −1 偏差是**乐器固有限制**（全音阶键盘，黑键并到相邻白键，
`MIDI_MAP_TO_NOTE` 的 `isAccidental` 标记就是干这个的），不是折叠引入的。

所以 `±12` 在两个维度上都更好：导入更多（1276 vs 663，因为 8 半音的步长常常在
`octavesScale` 次循环内跨不进范围），且偏差小 4.8 倍。**不存在权衡。**

UI 标签是 "Max notes octave scaling"，tooltip 明写 "by those **octaves**"
（`en/index.ts:631`），意图无歧义。

唯一的行为变化：关掉 "Include accidentals" 时导入数从 436 降到 124 ——
但那 436 个本来就全是错音，属于"多而全错"变成"少而全对"。

**② Genshin 的 `MIDI_BOUNDS.upper` 比映射表高 1**（次要，影响有条件）

映射表覆盖 MIDI `48..83`，但 `MIDI_BOUNDS.upper = 84`。MIDI 84 落进夹缝：

1. `84 > 84` 为假 → **永远进不了折叠分支**，scaling 滑块拉到多少都没用
2. 映射表查不到 → `note = -1` → 丢弃
3. `outOfRangeBound` 保持 0 → 按轨的 upper/lower 细分不计数

**第 1 条才是实质问题**：`84 - 12 = 72`（甚至当前的 `84 - 8 = 76`）都是合法 Genshin 键位，
这个音本来能被 scaling 救回来，却根本到不了那段代码。

但要诚实评估影响：**不开 scaling（默认）时，修不修都是丢弃，用户看到的结果一样**；
开了 scaling 才有区别，而 scaling 本身还得先修好缺陷 ①。所以这条**是个一致性修正，
不是高影响 bug**，别当成大问题提。

⚠️ 第 3 条是次要的，**别说成"静默丢失"**：`index.tsx:474` 的全局 "Out of range"
统计表显示的是 `outOfRange` 总数，而 `outOfRange++` 在 `note === -1` 分支里无条件执行，
**MIDI 84 会被计入**。用户看得见丢了多少，只是看不出丢在哪个方向。
漏报的只有 `TrackInfo.tsx:141` 的按轨 upper/lower 细分。

Sky 无此问题（映射表和 bounds 都到 84）。

修法只能是把 `upper` 改成 83，**不能给映射表补 84**：Genshin 21 键 = 3×7 全音阶，
覆盖 C3–B5，根本没有第 22 个键；把 C6 映射到 B5 是实质错音，
和黑键近似不是一回事（黑键本来就没有对应键位，C6 却有正确去处——降八度到 C5）。

实测：一个为这类游戏编配好的 MIDI（15 个白键、MIDI 60–84、零升降号）——

| 目标 | 音符 | 可映射 | 丢弃 |
|---|---:|---:|---:|
| Sky | 679 | 679 | **0** |
| Genshin | 679 | 651 | **28** |

丢的 28 个正好等于该文件里 MIDI 84 的出现次数。这类"已适配"的曲子反而是
Issue 2 的高发样本——它们经常刚好用满到 C6。

> 上一轮我曾说导出时 `note.toMidi() || 0` 会静默产生 MIDI 0 错音，**这条不成立**：
> `NOTE_MAP_TO_MIDI` 完整覆盖 Sky `0..14` 和 Genshin `0..20` 全部键位索引，
> 合法音符查表不会失败。`|| 0` 只是防御性兜底，仅在音符索引越界（手改文件等）时才会命中。

## Sky Studio 格式对比

Sky Studio 是光遇玩家最主流的移动端谱子工具（闭源）。核实后的结论：

> **本仓的「远古格式」来自光遇社区，本仓和它的前作都只是消费方，都不是原创者。**

### 三代血缘

```
2020-05-06  thoseSkyModders/SkyMusic   Specy 的第一个应用（HTML/JS）
                                       部署在 sky-music.herokuapp.com（至今可访问）
                                       Specy 380/389 commits
2021-04-12  Specy/genshin-music        重写（Next.js/React），覆盖原神 + 光遇
                                       Specy 886/1039 commits
```

`Utilities.ts:182` 把远古格式命名为 **`'oldSky'`** —— 指的是 **"旧的 Sky Music"
（Specy 自己的前作）**，不是 "旧的 Sky Studio"。前作里 `songNotes` / `pitchLevel` /
`isComposed` / `composedSong` / `bitsPerPage` / `isEncrypted` 六个字段全都有。

### 关键证据：格式在 2020 年就已是"外来品"

Specy 前作 `public/app.js` 里这两个字段的用法暴露了来源：

```js
// bitsPerPage —— 三处全部硬编码 16，只写不读
let song = { name, isComposed: true, bpm, pitchLevel: 0, bitsPerPage: 16, songNotes }

// isEncrypted —— 全仓库仅一处，是「检测并拒绝」
if (inputSongs[0].isEncrypted == "true") {
    showMessage("This song is encrypted, please save it without encryption or ...")
}
```

`== "true"` 是字符串比较，说明源文件里该字段是字符串而非布尔值。
**Specy 从未实现过加密，只能识别并劝退** —— 2020 年他的应用就在消费别人产出的文件。
前作里还有 `convertToOldFormat()`，说明在它之前还有更早一代。

而 Sky Studio 侧这两个字段有完整语义：`isEncrypted` 驱动整条解密链，
`bitsPerPage` 真的换算拍号。

| 断言 | 判定 |
|---|---|
| 本仓是格式原创方 | ❌ 2020 年前作就在用 |
| Specy 前作是原创方 | ❌ 连解密都做不到，且有 `convertToOldFormat()` |
| Sky Studio 是原创方 | ⚠️ **无法证明**，但它是唯一实现完整语义的一方 |
| 格式源自光遇社区、Specy 系是消费方 | ✅ 成立 |

### 字段对应关系

第三方工具 [`bilibiliales/skystudio-decrypt`](https://github.com/bilibiliales/skystudio-decrypt)
的 `parseProjectMeta()` 揭示了 Sky Studio 工程文件的字段：

```js
const song = dataArray[0]              // 顶层是数组，取第 0 个
{ name, author, transcribedBy, bpm, bitsPerPage, isEncrypted, keyVersion, songNotes }
getPaizi(bits) => `${Math.floor(bits / 4)}/4`     // bitsPerPage: 16 → 4/4 拍
```

[`ghostlium/genshinSkyLimit`](https://github.com/ghostlium/genshinSkyLimit) 的转换器读
`myObj.songNotes`，key 形如 `"1Key0"` / `"2Key5"`。

对照本仓 `src/types/SongTypes.ts` 的 `OldFormat`：`songNotes` / `bitsPerPage` /
`isEncrypted` **三个字段完全对应**；`pitchLevel` 在解密工具里出现 0 次，是 Specy 的扩展。

所以 `toOldFormat()` 不是"兼容自己的老版本"，而是**导出成 Sky Studio 能读的文件**，
`fromOldFormat()` 则是 Sky Studio 导入口。导出的 `.skysheet.json` 里那份 `songNotes`
冗余数据是**有意的跨工具互操作层**，不是历史包袱。

### 版本时间线

```
2022-06-10  168a8aea  v2 —— 层掩码改十六进制 + 引入 folders(folderId)
2022-06-12  1d4824b5  加入 type: 'composed' 字段
2022-06-15  ac32263a  v3 —— instruments 改对象数组 + 解除 4 层上限
2024-04-05  bdb8df9e  加入 reverb
```

v2 只存活了 **5 天**，野外的 v2 文件极少。

### 字段三方对比

| | Sky Studio | composed **v2** | composed **v3** |
|---|---|---|---|
| 外层 | 数组取 `[0]` | 数组取 `[0]` | 数组取 `[0]` |
| 版本标识 | `keyVersion` | `version: 2` | `version: 3` |
| 类型标识 | ❌ | `type`（06-12 起） | `type: 'composed'` |
| 曲名 | `name` | `name` | `name` |
| 作者 | `author` + `transcribedBy` | ❌ | ❌ |
| 速度 | `bpm` | `bpm` | `bpm` |
| 调性 | ❌ | `pitch` | `pitch` |
| 拍号 | `bitsPerPage`（16→4/4） | ❌ | ❌ |
| 加密 | `isEncrypted` + `keyVersion` | ❌ | ❌ |
| 文件夹 | ❌ | `folderId` | `folderId` |
| 混响 | ❌ | ❌ | `reverb`（2024-04 起） |
| 小节标记 | ❌ | `breakpoints[]` | `breakpoints[]` |
| 谱面 | `songNotes:[{key,time}]` | `columns:[tc,[[i,hex]]]` | 同 v2 |
| 变速 | ❌ | `tempoChanger` 四档 | `tempoChanger` 四档 |

### 分层与乐器（三者差异最大处）

| | Sky Studio | composed v2 | composed v3 |
|---|---|---|---|
| 层数上限 | **2**（双音层） | **4**（固定四元组） | **52**（BigInt）/ 30 |
| 层的编码 | key 前缀 `1`/`2` | 十六进制位掩码，`number` | 十六进制位掩码，`BigInt` |
| 乐器数据 | ❌ 音符不带 | `[名,名,名,名]` 字符串 | 对象数组，8 个字段 |

v2→v3 的实质就是这一栏，`columns` 一字未改，两版谱面数据可直接互读。

`fromOldFormat` 把 key 前缀当**位掩码**解析（`new NoteLayer(Number(data[0]))`），
对 Sky Studio 的双音层恰好正确（`1`→bit 0，`2`→bit 1）。`3Key*` 会被解成
"同时属于第 0 和第 1 层"，是否符合 Sky Studio 原意无证据，不下结论。

### 互转损失

**Sky Studio → 本仓**：丢 `author` / `transcribedBy`、拍号（`bitsPerPage` 只用于往回导出）、
非量化节奏（`isComposed` 为真时按 bpm 重新量化）；加密文件读不了，需先用第三方工具解密。

**本仓 → Sky Studio**：丢变速档、`breakpoints`、乐器配置、超过 2 层的分层；
`pitch` 转成 `pitchLevel` 但 Sky Studio 不读该字段；拍号硬编码 `bitsPerPage: 16`（永远 4/4）。

### 反直觉的一点

三者里**最接近 Sky Studio 的是本仓的 `recorded`**，不是任何一版 composed ——
都是绝对毫秒时间戳的扁平音符流。`fromOldFormat()` 也正是先建 `RecordedSong`
再按需转 composed，走的就是这条最短路径。

## 记谱与量化：与 Sky Studio 生态的横向对比

从 `skystudio-decrypt` 的源码提取，与本仓 `VisualSong` / `Config.ts` 对照。

### ABC 记谱：本仓与 smc 作者一致，第三方解密工具是例外

**本仓与 smc 作者的工具用的是同一套 ABC 标签**（3 行 × 5，按键盘物理布局）：

```
A1 A2 A3 A4 A5   B1 B2 B3 B4 B5   C1 C2 C3 C4 C5      索引 0–14
```

已由端到端核对证实：作者工具导出的 Sky Studio txt 与本仓按此布局推算的
**377 个时值逐位零差异**（详见 `text-format-spec.md` 的端到端核对一节）。

例外是第三方的 [`skystudio-decrypt`](https://github.com/bilibiliales/skystudio-decrypt)，
它用 7+7+1 分组：

```
A1 A2 A3 A4 A5 A6 A7   B1 B2 B3 B4 B5 B6 B7   C1          索引 0–14
```

同一索引 5，本仓与 smc 作者叫 `B1`，该工具叫 `A6` —— **只有它与另外两方不能互读**。

> ⚠️ 本文档早期版本据该解密工具的源码断言「本仓与 Sky Studio 生态的 ABC 互不兼容」，
> 属于**以偏概全** —— 一个第三方工具的选择不代表整个生态。已更正。

### 简谱记谱完全一致 ✓

Sky Studio 的 `getNumberedNotationParts()`：

```js
digit = String((keyIndex % 7) + 1)
dots  = Math.floor(keyIndex / 7)
```

本仓 Sky 的 `numberLayout`：`1 2 3 4 5 6 7 / 1̇ 2̇ 3̇ 4̇ 5̇ 6̇ 7̇ / 1̈`

逐位比对：索引 0–6 → 数字 1–7 无点；7–13 → 1–7 一点；14 → 1 两点。**两边完全相同。**
所以简谱是这两个生态间唯一可靠的交换记法。

### 量化思路完全不同

| | 本仓 `RecordedSong.toComposedSong` | Sky Studio 工具 `buildTimingModel` |
|---|---|---|
| 时值单位 | 从 `bpm` 推导的固定四档（1、1/2、1/4、1/8 拍） | **所有音符间隔的 GCD**，数据驱动 |
| 是否需要 bpm | 需要 | 不需要 |
| 分解方式 | 贪心，从大单位往下扣 | 间隔 ÷ unit 取整 |
| 和弦判定 | 时间差 < `bpmToMs / 9`（约 27.8ms 容差） | **时间戳完全相等**，零容差 |

零容差是合理的——Sky Studio 的谱子由编辑器产出，和弦的时间戳本就精确相同；
本仓要处理手弹录制，必须留容差。

### 可视化：方格谱 vs 格子谱

| | 本仓 `VisualSong` + `SheetFrame2` | Sky Studio 工具 `buildSnapshotGridPages` |
|---|---|---|
| 分组依据 | 按 `tempoChanger` 切 chunk | 按 `slotIndex = round(time / unit)` 铺格 |
| 小节概念 | ❌ 无 | `NOTATION_BEATS_PER_MEASURE = 4` |
| 分页 | 按 `framesPerRow` 排版 | `SNAPSHOT_GRID_COLUMNS = 8` 固定分页 |
| 变速可视化 | 用背景色区分四档 | ❌ 无变速概念 |

本仓没有小节概念（只有 `breakpoints` 手动标记），Sky Studio 侧有固定的
4 拍/小节。这是"网格编辑器"和"传统记谱"两种取向的直接体现。

## Sky Studio 的加密机制

`skystudio-decrypt` 源码里的完整算法（**是混淆，不是密码学加密**）：

```js
const xor_key = 0x5A
const enc_ragus = [0x0E, 0x18, 0x76, ...]   // 32 字节
const enc_tlas  = [0x20, 0x2E, 0x18, ...]   // 32 字节
const RAGUS = decryptKey(enc_ragus)          // 逐字节 XOR 0x5A 还原
const TLAS  = decryptKey(enc_tlas)
```

`RAGUS` = **SUGAR** 倒写，`TLAS` = **SALT** 倒写。

解密本体是**加法型维吉尼亚密码**：

```js
明文字符码 = 密文数字 − RAGUS[i % 32].charCodeAt(0) + 100
// 明文中遇到 TLAS 标记即截断，其后为填充
```

| | |
|---|---|
| 密文位置 | `songNotes` 字段，加密时是**数字数组**而非音符对象数组 |
| 明文 | 一段 JSON 字符串，解出后 `JSON.parse` 得到正常 `songNotes` |
| 密钥 | 32 字节 ASCII，硬编码在客户端，XOR `0x5A` 混淆一层防 grep |
| 其余字段 | `name` / `author` / `bpm` / `bitsPerPage` 等不加密，明文可读 |

安全性为零（固定密钥硬编码在客户端）。它的目的不是保密，而是**防止别人随手改动扒谱者的编曲**
—— 社区里扒谱有署名和劳动投入，`transcribedBy` 字段就是为此存在。

本仓从未实现过加解密：前作只能检测并劝退，当前版本连检测都没有，
导出时恒写 `isEncrypted: false`。

## 相关项目生态

### Specy 系（本仓血缘）

| 时间 | 项目 | 说明 |
|---|---|---|
| 2020-05-06 | [`thoseSkyModders/SkyMusic`](https://github.com/thoseSkyModders/SkyMusic) | ★21，本仓前身，HTML/JS，站点 `sky-music.herokuapp.com` 至今可访问（含账号系统，注册已关闭） |
| 2021-04-12 | `Specy/genshin-music` | ★200，当前仓库 |

主要开发者 **[@Specy](https://github.com/Specy)**（意大利）：前作 380/389 commits，
本仓 886/1039 commits。本仓其他贡献者主要来自中文社区
（`cangerjun` 85、`ptr2019` 24、`GID0317` 19、`qaq1000w` 8）。

### sky-music 组织（独立生态，早于 Specy）

| 时间 | 项目 | 说明 |
|---|---|---|
| 2018-10-15 | `sky-abc-python-transcriber` | ★3，转 ABC 记谱 |
| 2019-05-21 | `old-sky-music` | ★3，已归档 |
| 2019-07-18 | `sky-python-music-sheet-maker` | ★37，Python，生成可视化谱子图片 |
| 2020-05-09 | [`sky-music.github.io`](https://sky-music.github.io) | ★16，谱子网站 |

注意 `skymusic.herokuapp.com`（**无连字符**，该项目的旧 Web 版）已 404，
与 Specy 的 `sky-music.herokuapp.com`（**有连字符**）不是同一个站。

### 自动演奏类（与本项目立场对立）

Discord 规则第 12 条明令禁止宣传这类工具：

| 项目 | 语言 | ★ |
|---|---|---|
| `thatskymod/Sky-CotL-Scripts` | Lua | 779 |
| `jkulvich/COTLTracker` | Go | 31 |
| `Youcomposer/SkyAutoMusic` | Python | 16 |
| `Viwyn/Sky-Music-Player`（已归档） | Python | 11 |

### 格式工具

| 项目 | 说明 |
|---|---|
| [`bilibiliales/skystudio-decrypt`](https://github.com/bilibiliales/skystudio-decrypt) | Sky Studio 加密 txt 解密 + 简谱/方格谱预览 + MP3 导出 |
| [`ghostlium/genshinSkyLimit`](https://github.com/ghostlium/genshinSkyLimit) | Sky Studio JSON → 原神格式 |
| `Ai-Vonie/Sky1984-Sheets-Collection` | ★19，光遇谱子合集 |

## 格式与生态的源流考

### 完整时间线

```
2017-11 ~ 2018-04   Sky 闭测（Sky: Light Awaits）
2018-04             公测开始
2018-10-15  ★       sky-abc-python-transcriber 首次提交 by Tracey
                    现存最早的光遇曲谱工具，比游戏正式上线早 9 个月
2019-02-21          forum.bloomexperiment.com 最早 Wayback 存档（社区论坛）
2019-05-21          曲库仓库建立 by Tracey —— 70 个 songs/*.html
2019-07-18          Sky: CotL 正式上线 iOS
2020-01-02          sky-python-music-sheet-maker by Tracey
2020-04-29          thoseSkyModders/SkyMusic 首次提交 by ThatOneSkyGuy
2020-05-03          Specy 加入该项目（4 天后），最终写下 380/474 提交
2020-05-09/19       曲库迁至 sky-music.github.io
2020-07-16          Sky Studio 上架 App Store（开发者 JoneRyeol Kim）
2021-04-12          Specy/genshin-music 建立（本仓）
```

### ABC 记谱的原始标准来自 2018 年

`sky-abc-python-transcriber` 的 README：

> This is a Python program that outputs Sky songs in the **ABC1-5 notation**.
> Use **QWERT, ASDFG, ZXCVB** as the harp keyboard.

三行各 5 键 → `A1..A5` / `B1..B5` / `C1..C5`，**与本仓的 `keyboardLayout` 和
`abcLayout` 逐字对应**。

所以前面 ABC 记谱那节的结论可以补全：**本仓遵循的是 2018 年 Tracey 定下的
社区原始标准**，smc 作者的工具也用这一套；偏离的只有第三方的
`skystudio-decrypt`（用 `A1..A7 / B1..B7 / C1`）。

### 曲库最早的载体是论坛，不是 GitHub

归档仓库的 README 写明上传入口：

> See here for how to upload: `https://sky.bloomexperiment.com/t/sky-music-sheets-site/13/2`

**topic ID = 13**，是该论坛最早的一批帖子之一；论坛最早 Wayback 存档为
**2019-02-21**，比曲库仓库早 3 个月。README 列出 10 位扒谱者
（Tracey、Sera、Bait、Edpliskin89、Mel、Nezara、Peri、mimizan、Tarhiel、Pod），
是社区协作项目而非个人作品。

### 无法确证的部分

| 问题 | 状态 |
|---|---|
| 论坛 topic 13 原帖内容 | ❌ 该 URL 无任何 Wayback 存档，域名 DNS 已不解析 |
| `songNotes` / `bitsPerPage` / `isEncrypted` 这套 JSON 的源头 | ❌ 2018 的 transcriber 输出 ABC 文本而非该 JSON，中间断了一环 |
| Sky Studio 的真实起源 | ❌ App Store `2020-07-16` 仅为 iOS 首发；安卓侧无官方接口可查 |
| 论坛之前的更早载体（Discord / Reddit / 贴吧） | ❌ 未检索到，这类平台历史内容 Wayback 覆盖极差 |

结论只能给到**「现存可查最早」**：2018-10-15 是 GitHub 上的硬证据，
但游戏 2018 年 4 月就已公测，中间半年社区在哪交流曲谱没有留下可检索痕迹。

### 仓库与站点地址

以下地址均已实测可访问（HTTP 200）。

**sky-music 组织**（Tracey 发起，早于 Specy 系）

| 建立 | 地址 | 说明 |
|---|---|---|
| 2018-10-15 | https://github.com/sky-music/sky-abc-python-transcriber | ABC1-5 转写器，现存最早 |
| 2019-05-21 | https://github.com/sky-music/old-sky-music | 曲库，README 标题为 `Sky Music`；`old-` 是**归档时加的前缀**，非原名 |
| 2020-01-02 | https://github.com/sky-music/sky-python-music-sheet-maker | 可视化谱子生成器 ★37 |
| 2020-05-09 | https://github.com/sky-music/sky-music.github.io | 曲库现址仓库 |
| — | https://sky-music.github.io | 曲库站点 |

**Specy 系**

| 建立 | 地址 | 说明 |
|---|---|---|
| 2020-04-29 | https://github.com/thoseSkyModders/SkyMusic | 本仓前身，发起者 ThatOneSkyGuy |
| — | https://sky-music.herokuapp.com/ | 前身的线上站点，至今可访问（账号注册已关闭） |
| 2021-04-12 | https://github.com/Specy/genshin-music | 本仓 |
| — | https://specy.app | 作者主页与当前部署 |

**Sky Studio 及其工具**

| 地址 | 说明 |
|---|---|
| https://apps.apple.com/us/app/sky-studio/id1522241329 | App Store，首发 2020-07-16，bundleId `com.Maple123.SkyStudio` |
| https://apps.apple.com/us/developer/joneryeol-kim/id1522241331 | 开发者 JoneRyeol Kim |
| https://github.com/bilibiliales/skystudio-decrypt | 加密 txt 解密 + 简谱/方格谱预览 |
| https://bilibiliales.github.io/skystudio-decrypt/ | 上者的在线版 |
| https://github.com/ghostlium/genshinSkyLimit | Sky Studio JSON → 原神格式 |

## 社区曲库的格式实况（全量统计）

对 [`Ai-Vonie/Sky1984-Sheets-Collection`](https://github.com/Ai-Vonie/Sky1984-Sheets-Collection)
做全量扫描（2026-08 快照，**16092 个谱子**，本地副本在
`/Users/hsycc/vibe_coding/Sky1984-Sheets-Collection`）。
该库 README 明确声明服务于 *Sky Music Nightly*（即本仓）。

### 格式分布

| 格式 | 数量 | 占比 |
|---|---:|---:|
| **composed v3** | 12560 | **78.05%** |
| **recorded v2** | 3530 | **21.94%** |
| vsrg v1 | 2 | 0.01% |
| Sky Studio ABC txt | **0** | 0% |
| 加密 JSON | **0** | 0% |
| 远古 songNotes | **0** | 0% |

`appName` 全部为 `Sky`，16092 个无一例外。文件一律用 `.txt` 扩展名，内容是 JSON。

### 三个结论

**① 没有任何 v1，也没有 composed v2。** app 自 2022-06 起只写 v3
（`ComposedSong.serialize()` 恒写 `version: 3`），活跃维护的曲库已全部规范化。
v1 只可能存在于 2022 年年中之前导出、且从未重新保存过的老谱子里。

> 但兼容 v1 仍是**零成本**的：版本差异全在 layer 编码与 `instruments` 结构上，
> 音符元组里 `index` 的位置从未变过。只取 `note[0]`/`note[1]` 天然跨版本。
> 唯一要注意 —— **v1 文件连 `version` 字段都没有**，别写
> `if (song.version !== 3) reject`。

**② ABC txt 与 songNotes 不作为独立格式流通。** 两者在该库出现次数均为 0。
`songNotes` 只作为 `toOldFormat()` 的冗余字段附在 JSON 内部。

**③ 两个分支覆盖 100%。**

```js
const song = Array.isArray(raw) ? raw[0] : raw
if (song.type === 'composed') {                       // 78%
  let t = 0; const ms = 60000 / song.bpm
  const TC = [1, 0.5, 0.25, 0.125]
  for (const [tc, notes] of song.columns) {
    for (const [i] of notes) out.push({index: i, time: Math.round(t)})
    t += ms * TC[tc]
  }
} else if (song.type === 'recorded') {                // 22%
  for (const [i, time] of song.notes) out.push({index: i, time})
}
```

⚠️ 那 2 个 `vsrg` 是音游谱（`tracks` + `hitObjects`，结构完全不同），
判类型时**用白名单而非 else 兜底**，跳过而非崩溃。

### 复现

```bash
git clone --depth 1 https://github.com/Ai-Vonie/Sky1984-Sheets-Collection.git
# 扫描 type / version / appName 字段的统计脚本见本节上方代码思路
```

> ⚠️ 样本局限：这是**一个**曲库，且明确面向本仓，天然偏向本仓格式。
> Sky Studio 用户社群、中文社群（B站/QQ群，多为图片版键位谱）的分布未测。
> 「哪种格式最流通」取决于圈子，本节只能确证：**面向本仓的曲库里本仓格式占 100%**。
