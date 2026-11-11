/**
 * 推荐文档的「纯逻辑」部分：校验管理 Agent 选中的视频、渲染 Markdown、生成文件名。
 * 不碰文件系统、不依赖 DSH，方便单测。
 */
import { formatCount, truncate } from './sources/shared.js'

export const PLATFORM_LABEL = { bilibili: '哔哩哔哩', youtube: 'YouTube' }
const PLATFORM_ORDER = ['bilibili', 'youtube']

/** 把各种写法的视频链接归一成标准形式；不是 B 站 / YouTube 视频链接返回 null。 */
export function canonicalVideoUrl(value) {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '')
  if (host === 'bilibili.com') {
    const bvid = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1]
    return bvid ? `https://www.bilibili.com/video/${bvid}` : null
  }
  let id = null
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1]
  }
  return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null
}

const platformOfUrl = (url) => (url.includes('bilibili.com') ? 'bilibili' : 'youtube')

/**
 * 把管理 Agent 传来的 picks 对到检索登记簿上。
 * @param {{url:string, reason:string, title?:string}[]} picks
 * @param {Map<string, object[]>} candidates 按平台分组的登记候选
 * @param {number} maxPicks 最多允许几个推荐
 * @returns {{picks: object[], errors: string[]}} errors 非空表示应当拒绝这次保存
 */
export function resolvePicks(picks, candidates, maxPicks = 2) {
  const errors = []
  if (!Array.isArray(picks) || picks.length === 0) return { picks: [], errors: ['picks 至少要有 1 个视频'] }
  const known = new Map()
  for (const videos of candidates.values()) for (const video of videos) known.set(video.url, video)

  const resolved = new Map()
  for (const [index, pick] of picks.entries()) {
    const label = `picks[${index}]`
    const url = canonicalVideoUrl(pick?.url)
    const reason = String(pick?.reason ?? '').trim()
    if (!url) {
      errors.push(`${label}.url 不是 B 站或 YouTube 的视频链接：${truncate(pick?.url, 80)}`)
      continue
    }
    if (!reason) errors.push(`${label}.reason 不能为空`)
    const video = known.get(url)
    if (video) resolved.set(url, { ...video, reason, verified: true })
    else if (known.size > 0) errors.push(`${label}.url 不在子 Agent 的检索结果里（请原样使用检索到的链接）：${url}`)
    else {
      // 登记簿是空的（例如 DSH 重启后续跑旧会话）：放行，但标记为未核对
      const title = String(pick?.title ?? '').trim() || url
      resolved.set(url, { platform: platformOfUrl(url), title, url, author: '', views: null, duration: '', published: '', reason, verified: false })
    }
  }
  if (resolved.size > maxPicks) errors.push(`最多只能推荐 ${maxPicks} 个视频，现在是 ${resolved.size} 个，请再精选`)
  if (errors.length && known.size > 0) {
    errors.push('可选的链接：\n' + [...known.values()].map((v) => `- ${v.url} （${truncate(v.title, 40)}）`).join('\n'))
  }
  return { picks: [...resolved.values()], errors }
}

/** Markdown 行内文本转义（标题里常有 [] | * 之类的字符）。 */
export function md(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>|]/g, '\\$&')
}

/** 模型写的多行文字（综合结论、备注）：逐行转义，保留分段。这样文档里的链接只可能是代码生成的那些。 */
function prose(text) {
  return String(text ?? '').split(/\n+/).map(md).filter(Boolean).join('\n\n')
}

const pad = (n) => String(n).padStart(2, '0')

/** 本地时间 → { stamp: '2026-11-11 19:30', compact: '20261111-193005' }。 */
export function timeParts(date = new Date()) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return {
    stamp: `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    compact: `${day.replaceAll('-', '')}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  }
}

/** 由关键词和时间生成一个各系统都安全的文件名。 */
export function reportFileName(keyword, date = new Date()) {
  const slug = Array.from(String(keyword ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, ''))
    .slice(0, 30)
    .join('')
    .replace(/-+$/, '')
  return `${slug || 'video'}-${timeParts(date).compact}.md`
}

function statLine(video) {
  const parts = []
  if (typeof video.views === 'number') parts.push(`播放 ${formatCount(video.views)}`)
  if (video.duration) parts.push(`时长 ${video.duration}`)
  if (video.published) parts.push(`发布 ${video.published}`)
  return parts.join(' · ')
}

/**
 * 决定候选对照表里每个平台列哪些视频：子 Agent 汇报过的，加上被推荐的；
 * 这个平台没有任何汇报记录时，列出检索到的全部。
 * @param {Map<string, object[]>} candidates 登记的全部候选
 * @param {Set<string>} reported 子 Agent 汇报过的视频链接
 * @param {{url:string}[]} picks 最终推荐
 * @returns {Map<string, object[]>} 按平台分组、保持检索顺序
 */
export function shortlist(candidates, reported, picks) {
  const picked = new Set(picks.map((video) => video.url))
  return new Map(PLATFORM_ORDER.filter((p) => candidates.get(p)?.length).map((platform) => {
    const all = candidates.get(platform)
    const any = all.some((video) => reported.has(video.url))
    return [platform, any ? all.filter((video) => reported.has(video.url) || picked.has(video.url)) : all]
  }))
}

/**
 * 渲染最终文档。
 * @param {object} input
 * @param {string} input.keyword 关键词
 * @param {string} input.summary 综合结论
 * @param {object[]} input.picks resolvePicks 的结果
 * @param {Map<string, object[]>} input.candidates 登记的全部候选（检索工具返回过的）
 * @param {Set<string>} [input.reported] 子 Agent 最终汇报过的视频链接；有的话候选表只列这些
 * @param {string} [input.notes] 备注
 * @param {Date} [input.date] 生成时间
 */
export function renderReport({ keyword, summary, picks, candidates, reported = new Set(), notes, date = new Date() }) {
  const picked = new Set(picks.map((video) => video.url))
  // 每个平台：检索到的全部 → 子 Agent 汇报的（没有汇报记录时就是全部）
  const listed = shortlist(candidates, reported, picks)
  const platforms = [...listed.keys()]
  const hasShortlist = platforms.some((p) => listed.get(p).length < candidates.get(p).length)
  const funnel = platforms.map((p) => {
    const found = candidates.get(p).length
    const shown = listed.get(p).length
    // 「YouTube 检索到」中英文之间留一个空格，「哔哩哔哩检索到」不用
    const label = PLATFORM_LABEL[p] + (/[A-Za-z0-9]$/.test(PLATFORM_LABEL[p]) ? ' ' : '')
    return hasShortlist ? `${label}检索到 ${found} 个、汇报 ${shown} 个` : `${PLATFORM_LABEL[p]} ${found} 个`
  })
  const lines = [
    `# 「${md(keyword)}」视频推荐`,
    '',
    `> 由 Video Scout 多 Agent 协作生成 · ${timeParts(date).stamp}`,
    '>',
    !platforms.length
      ? `> 管理 Agent 综合 B 站、YouTube 两个检索 Agent 的汇报，精选出 ${picks.length} 个。`
      : hasShortlist
        ? `> 两个检索 Agent 的工作：${funnel.join('；')}。管理 Agent 从中精选出 ${picks.length} 个。`
        : `> 管理 Agent 把任务分派给 B 站、YouTube 两个检索 Agent，从${funnel.join('、')}候选里精选出 ${picks.length} 个。`,
    '',
    '## 综合结论',
    '',
    prose(summary) || '（无）',
    '',
    '## 推荐视频',
    '',
  ]
  picks.forEach((video, index) => {
    const stats = statLine(video)
    lines.push(
      `### ${index + 1}. [${md(video.title)}](${video.url})`,
      '',
      `- **平台**：${PLATFORM_LABEL[video.platform] ?? video.platform}`,
      ...(video.author ? [`- **作者**：${md(video.author)}`] : []),
      ...(stats ? [`- **数据**：${stats}`] : []),
      `- **推荐理由**：${md(video.reason)}`,
      `- **链接**：<${video.url}>`,
      ...(video.verified ? [] : ['- ⚠️ 这个链接没有对上检索记录，请打开确认。']),
      '',
    )
  })

  if (platforms.length) {
    lines.push('## 候选对照', '', `两个检索 Agent ${hasShortlist ? '汇报' : '找到'}的视频，⭐ 为最终推荐。`, '')
    for (const platform of platforms) {
      lines.push(`### ${PLATFORM_LABEL[platform]}`, '', '| # | 视频 | 作者 | 播放 | 时长 | 发布 |', '| --- | --- | --- | --- | --- | --- |')
      listed.get(platform).forEach((video, index) => {
        const mark = picked.has(video.url) ? '⭐ ' : ''
        lines.push(
          `| ${index + 1} | ${mark}[${md(truncate(video.title, 60))}](${video.url}) | ${md(video.author) || '—'} | ${formatCount(video.views)} | ${video.duration || '—'} | ${md(video.published) || '—'} |`,
        )
      })
      lines.push('')
    }
  }
  if (prose(notes)) lines.push('## 备注', '', prose(notes), '')
  return lines.join('\n')
}
