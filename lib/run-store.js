/**
 * 「本次任务检索到了哪些视频」的进程内登记簿。
 *
 * 为什么需要它：两个检索 Agent 用自然语言把结果汇报给管理 Agent，管理 Agent 再挑 1–2 个写进文档。
 * 这一来一回里，模型可能把链接抄错甚至编一个。所以检索工具每次返回结果时都在这里登记一份，
 * 写文档的工具只认登记过的链接，标题、作者、播放量也以登记的为准 —— 模型负责「选哪个、为什么」，
 * 事实由代码兜底。
 *
 * 登记簿按「任务」分组：一棵 Agent 树（管理 Agent + 它派出的子 Agent）共用根 Agent 的会话 id。
 * 挂在 globalThis 上是为了让插件的三个入口（哪怕被宿主分别加载）始终看到同一份数据。
 *
 * 除了「检索到了什么」，还记一笔「子 Agent 最终汇报了哪几个」（recordReport）：检索工具可能返回十几条，
 * 子 Agent 只挑 4–5 个上报，文档的候选表列的是上报的那些。
 */

const STORE_KEY = Symbol.for('dsh-video-scout.run-store')
const MAX_RUNS = 50
const MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * @typedef {object} Run
 * @property {number} at 最近一次写入的时间
 * @property {{agentId:string, platform:string, keyword:string, videos:object[]}[]} searches 每次检索的结果
 * @property {Set<string>} reported 子 Agent 在最终汇报里提到的视频链接
 */
/** @returns {Map<string, Run>} */
function store() {
  return (globalThis[STORE_KEY] ??= new Map())
}

/**
 * 算出「这次工具调用属于哪个任务」：子 Agent 归到它所在 Agent 树的根，直接对话时就是自己。
 *
 * 两种办法，按宿主版本自动选：
 *   1. 新版 DSH 的 subagents.rootOf(agent) 直接给出根 Agent；
 *   2. 否则顺着会话头里记录的 parentSession 一层层往上找（0.2.2-rc.1 用的是这条路）。
 * @param {object} ctx 插件上下文（用来拿宿主的 subagents / agents 服务；拿不到也没关系）
 * @param {object} [exec] 工具执行上下文（exec.agent 是发起调用的 Agent）
 */
export function runKeyOf(ctx, exec) {
  const agent = exec?.agent
  if (!agent) return 'no-agent'
  const service = (name) => {
    try { return ctx?.get?.(name) } catch { return undefined }
  }
  try {
    const root = service('subagents')?.rootOf?.(agent)
    if (root?.id) return String(root.id)
  } catch {
    // 这个 Agent 不归 subagents 管（例如用户直接和它对话）：继续用会话血缘判断
  }
  let rootId = String(agent.id ?? 'no-agent')
  const seen = new Set([rootId])
  let parentId = agent.session?.header?.parentSession
  while (parentId !== undefined && parentId !== null && !seen.has(String(parentId))) {
    rootId = String(parentId)
    seen.add(rootId)
    let parent
    try { parent = service('agents')?.get?.(parentId) } catch { parent = undefined }
    parentId = parent?.session?.header?.parentSession
  }
  return rootId
}

/**
 * 登记一次检索结果。
 * @param {string} runKey 任务（见 runKeyOf）
 * @param {{platform:string, keyword:string, videos:object[]}} search 检索结果
 * @param {string} [agentId] 发起检索的 Agent 的会话 id，用来把它之后的汇报对回这个任务
 */
export function recordSearch(runKey, { platform, keyword, videos }, agentId) {
  const runs = store()
  const now = Date.now()
  for (const [key, run] of runs) if (now - run.at > MAX_AGE_MS) runs.delete(key)
  const run = runs.get(runKey) ?? { at: now, searches: [], reported: new Set() }
  run.at = now
  run.searches.push({ agentId: String(agentId ?? ''), platform, keyword, videos })
  runs.delete(runKey) // 重新插入以保持「最近使用在后」
  runs.set(runKey, run)
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value)
}

/**
 * 登记一个子 Agent 的最终汇报：它检索到的视频里，哪些的 id 出现在了汇报文本中。
 * 这个 Agent 没检索过（对不上任何任务）就什么都不做。
 * @param {string} agentId 子 Agent 的会话 id
 * @param {string} text 它的最终答复
 */
export function recordReport(agentId, text) {
  const id = String(agentId ?? '')
  if (!id || !text) return
  for (const run of store().values()) {
    for (const search of run.searches) {
      if (search.agentId !== id) continue
      for (const video of search.videos) if (text.includes(video.id)) run.reported.add(video.url)
    }
  }
}

/** 某个任务里，子 Agent 们最终汇报过的视频链接；没有任何汇报记录时是空集。 */
export function reportedOf(runKey) {
  return new Set(store().get(runKey)?.reported ?? [])
}

/** 取出某个任务登记过的全部候选（按平台分组、按检索顺序去重）。 */
export function candidatesOf(runKey) {
  const byPlatform = new Map()
  for (const search of store().get(runKey)?.searches ?? []) {
    const seen = byPlatform.get(search.platform) ?? new Map()
    for (const video of search.videos) if (!seen.has(video.url)) seen.set(video.url, video)
    byPlatform.set(search.platform, seen)
  }
  return new Map([...byPlatform].map(([platform, videos]) => [platform, [...videos.values()]]))
}

/** 仅测试用：清空登记簿。 */
export function clearRuns() {
  store().clear()
}
