// 会话 taskNote 的持久化格式：JSON 数组，元素 = 一次「生成总结」运行记录。
//
// 旧模型：每次生成都新建一个 `工作总结（周期）` 会话，taskNote 直接存本次运行
// 的建议文件名（字符串），一个会话 = 一张卡片。新模型改为「一次生成 = 一张卡片，
// 多次生成共用一个会话」，taskNote 存生成记录数组：
//   [{ t: 生成时间戳, f: 建议文件名, pt: 周期类型, a: 执行 CLI 适配器 }]
// 卡片列表（含历史生成）从 `session:list` 的 taskNote 即可完整还原，无需新增表。
// 兼容旧格式：非 JSON 数组的 taskNote 按单个旧生成记录解析，旧会话各自呈现一张卡。
//
// 注意：taskNote 内容来自会话记录，是 UI 数据而非执行指令。

// 解析 taskNote 为生成记录数组。兼容旧版单文件名字符串格式。
export function parseTaskNote(taskNote) {
  if (!taskNote || typeof taskNote !== 'string') return []
  const trimmed = taskNote.trim()
  if (!trimmed.startsWith('[')) {
    // 旧格式：单个建议文件名
    return [{ t: 0, f: trimmed }]
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed
        .filter((g) => g && typeof g === 'object' && typeof g.f === 'string')
        .map((g) => ({
          t: Number.isFinite(g.t) ? g.t : 0,
          f: g.f,
          pt: typeof g.pt === 'string' ? g.pt : null,
          a: typeof g.a === 'string' ? g.a : null
        }))
    }
  } catch {
    // 非法 JSON → 视为无生成记录
  }
  return []
}

// 序列化生成记录数组为 taskNote 字符串。
export function serializeTaskNote(gens) {
  return JSON.stringify(gens || [])
}

// 追加一次生成记录。
export function appendGeneration(taskNote, gen) {
  const gens = parseTaskNote(taskNote)
  gens.push({ t: gen.t, f: gen.f, pt: gen.pt || null, a: gen.a || null })
  return serializeTaskNote(gens)
}

// 摘除一次生成记录（卡片删除后持久化，避免下次挂载复活）。
// genId 格式 `${sessionId}:${t}`，t 唯一标识该次生成。
// 移除后为空数组 → 返回 ''（清空 taskNote）。
export function dropGeneration(taskNote, genId) {
  const gens = parseTaskNote(taskNote)
  const t = Number(String(genId).split(':').pop())
  const next = gens.filter((g) => g.t !== t)
  return next.length ? serializeTaskNote(next) : ''
}

// 判定候选报告文件是否为「本次运行实际写出的成果」。同周期重新生成时磁盘上
// 可能已存在同名旧报告（上一轮留下的），其 mtime 早于本次生成时间 createdAt，
// 不能据此判定本轮已完成——须等 CLI 真正覆盖、mtime 追上 createdAt 之后才算。
// entries 为 listReports 结构（{ name, mtime }）。
export function reportProducedByRun(entries, { suggestedFileName, createdAt }) {
  if (!suggestedFileName) return false
  const htmlFileName = suggestedFileName.replace(/\.md$/i, '.html')
  const hit = (entries || []).find((entry) =>
    entry.name === suggestedFileName || entry.name === htmlFileName)
  return Boolean(hit && hit.mtime >= (createdAt || 0))
}

// 卡片显示名：工作总结（周期）生成时间，如 工作总结（每周）2026-08-21 15:30。
export function buildCardName(periodLabel, createdAt) {
  if (!createdAt) return `工作总结（${periodLabel}）`
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return `工作总结（${periodLabel}）`
  const pad = (n) => String(n).padStart(2, '0')
  return `工作总结（${periodLabel}）${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
