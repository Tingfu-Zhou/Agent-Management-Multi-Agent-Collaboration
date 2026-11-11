/**
 * YouTube 关键词检索。两条路，自动选择：
 *
 *   A. 配了 YOUTUBE_API_KEY → 走官方 Data API v3（search.list + videos.list），最稳定；
 *   B. 没配 Key（默认）   → 走网页端自己用的 InnerTube 接口 youtubei/v1/search，不需要任何凭据；
 *      InnerTube 失败时再退一步：抓搜索结果页，从页面里的 ytInitialData 解析（同一套解析逻辑）。
 *
 * 国内网络需要代理：DSH 会让 fetch 自动遵循 HTTPS_PROXY，无需在这里处理。
 */
import { USER_AGENT, VideoSearchError, request, cleanText, truncate, parseCount, formatDuration, clampLimit } from './shared.js'

export const YOUTUBE_ORIGIN = 'https://www.youtube.com'
export const YOUTUBE_DATA_API = 'https://www.googleapis.com/youtube/v3'
const PLATFORM = 'youtube'
const CLIENT_VERSION = '2.20250101.00.00'
// 搜索过滤器（protobuf → base64）：只要「视频」，可选叠加排序
const FILTERS = { relevance: 'EgIQAQ%3D%3D', views: 'CAMSAhAB', newest: 'CAISAhAB' }
const DATA_API_ORDER = { relevance: 'relevance', views: 'viewCount', newest: 'date' }
const NETWORK_HINT = '请确认本机能访问 YouTube（国内需要代理：启动 DSH 前导出 HTTPS_PROXY）；也可以配置 YOUTUBE_API_KEY 改走官方 Data API。'

const textOf = (node) => {
  if (!node) return ''
  if (typeof node.simpleText === 'string') return node.simpleText
  if (Array.isArray(node.runs)) return node.runs.map((run) => run?.text ?? '').join('')
  return ''
}

/** 把一个 videoRenderer 归一化成两个平台通用的结构；不是普通视频就返回 null。 */
export function normalizeVideoRenderer(renderer) {
  const id = String(renderer?.videoId ?? '')
  if (!/^[\w-]{11}$/.test(id)) return null
  const snippet = (renderer.detailedMetadataSnippets ?? []).map((s) => textOf(s?.snippetText)).filter(Boolean).join(' ')
  const live = (renderer.badges ?? []).some((b) => /LIVE/.test(b?.metadataBadgeRenderer?.style ?? ''))
  return {
    platform: PLATFORM,
    id,
    title: cleanText(textOf(renderer.title)),
    url: `https://www.youtube.com/watch?v=${id}`,
    author: cleanText(textOf(renderer.ownerText) || textOf(renderer.longBylineText) || textOf(renderer.shortBylineText)),
    views: parseCount(textOf(renderer.viewCountText) || textOf(renderer.shortViewCountText)),
    duration: live ? '直播中' : textOf(renderer.lengthText),
    published: textOf(renderer.publishedTimeText),
    description: truncate(cleanText(snippet || textOf(renderer.descriptionSnippet)), 160),
  }
}

/** 从 InnerTube / ytInitialData 的响应里按页面顺序取出视频（跳过广告、Shorts 货架、频道、播放列表）。 */
export function extractVideos(data) {
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents
  const direct = []
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const entry of section?.itemSectionRenderer?.contents ?? []) {
      const video = normalizeVideoRenderer(entry?.videoRenderer)
      if (video) direct.push(video)
    }
  }
  if (direct.length) return dedupe(direct)
  // 页面结构变了就退化成「整棵树里找 videoRenderer」，保证尽量有结果
  const found = []
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 14 || found.length >= 30) return
    if (Array.isArray(node)) return void node.forEach((child) => walk(child, depth + 1))
    if (node.videoRenderer) {
      const video = normalizeVideoRenderer(node.videoRenderer)
      if (video) found.push(video)
      return
    }
    for (const child of Object.values(node)) walk(child, depth + 1)
  }
  walk(data?.contents, 0)
  return dedupe(found)
}

const dedupe = (videos) => [...new Map(videos.map((v) => [v.id, v])).values()]

/** 从搜索结果页 HTML 里抠出 ytInitialData 这个 JSON。 */
export function parseInitialData(html) {
  const marker = String(html).match(/(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*/)
  if (!marker) return null
  const start = marker.index + marker[0].length
  // 从第一个 { 开始做括号配对（跳过字符串内容），比正则贪婪匹配可靠
  let depth = 0
  let inString = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

async function searchInnerTube(query, { limit, order, fetchImpl, origin, hl, gl, signal }) {
  const headers = {
    'user-agent': USER_AGENT,
    'accept-language': `${hl},en;q=0.8`,
    // 欧洲等地区会先跳「同意 Cookie」页，带上这个就不会被拦
    cookie: 'SOCS=CAI; CONSENT=YES+1',
  }
  const errors = []
  try {
    const response = await request(fetchImpl, `${origin}/youtubei/v1/search?prettyPrint=false`, {
      platform: PLATFORM,
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', origin, 'x-youtube-client-name': '1', 'x-youtube-client-version': CLIENT_VERSION },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl, gl } }, query, params: FILTERS[order] }),
      signal,
    })
    if (response.ok) {
      const videos = extractVideos(await response.json())
      if (videos.length) return videos.slice(0, limit)
      errors.push('InnerTube 返回 0 条')
    } else errors.push(`InnerTube HTTP ${response.status}`)
  } catch (error) {
    if (signal?.aborted) throw error
    errors.push(error.message)
  }

  try {
    const url = `${origin}/results?search_query=${encodeURIComponent(query)}&sp=${FILTERS[order]}&hl=${hl}&gl=${gl}`
    const response = await request(fetchImpl, url, { platform: PLATFORM, headers, signal })
    if (response.ok) {
      const data = parseInitialData(await response.text())
      if (data) return extractVideos(data).slice(0, limit) // 这里的 0 条是真的没有结果
      errors.push('结果页里没有 ytInitialData')
    } else errors.push(`结果页 HTTP ${response.status}`)
  } catch (error) {
    if (signal?.aborted) throw error
    errors.push(error.message)
  }
  throw new VideoSearchError(`YouTube 检索失败：${errors.join('；')}`, { platform: PLATFORM, hint: NETWORK_HINT })
}

/** ISO 8601 时长（PT1H2M3S）→ 「1:02:03」。 */
export function parseIsoDuration(value) {
  const match = String(value ?? '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!match) return ''
  const [, d = 0, h = 0, m = 0, s = 0] = match.map((n) => Number(n ?? 0))
  return formatDuration(d * 86400 + h * 3600 + m * 60 + s)
}

async function searchDataApi(query, { limit, order, fetchImpl, apiBase, apiKey, signal }) {
  const get = async (path, params) => {
    const url = `${apiBase}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`
    const response = await request(fetchImpl, url, { platform: PLATFORM, headers: { accept: 'application/json' }, signal })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      // 报错信息里不带 URL，避免把 Key 写进日志
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? ''
      throw new VideoSearchError(`YouTube Data API 返回 HTTP ${response.status}${reason ? `（${reason}）` : ''}`, {
        platform: PLATFORM,
        hint: '检查 YOUTUBE_API_KEY 是否有效、是否已启用 YouTube Data API v3、当日配额是否用完；去掉 Key 可改走免 Key 检索。',
      })
    }
    return body
  }
  const found = await get('search', { part: 'snippet', type: 'video', q: query, maxResults: String(limit), order: DATA_API_ORDER[order] })
  const items = (found?.items ?? []).filter((item) => /^[\w-]{11}$/.test(item?.id?.videoId ?? ''))
  if (!items.length) return []
  // search.list 不带播放量和时长，再用 videos.list 一次补齐
  const details = await get('videos', { part: 'statistics,contentDetails', id: items.map((item) => item.id.videoId).join(',') })
  const byId = new Map((details?.items ?? []).map((item) => [item.id, item]))
  return items.map((item) => {
    const id = item.id.videoId
    const detail = byId.get(id)
    return {
      platform: PLATFORM,
      id,
      title: cleanText(item.snippet?.title),
      url: `https://www.youtube.com/watch?v=${id}`,
      author: cleanText(item.snippet?.channelTitle),
      views: parseCount(detail?.statistics?.viewCount ?? ''),
      duration: parseIsoDuration(detail?.contentDetails?.duration),
      published: String(item.snippet?.publishedAt ?? '').slice(0, 10),
      description: truncate(cleanText(item.snippet?.description), 160),
    }
  })
}

/**
 * 按关键词检索 YouTube 视频。
 * @param {string} keyword 关键词
 * @param {object} [options]
 * @param {number} [options.limit=5] 返回条数（1–10）
 * @param {'relevance'|'views'|'newest'} [options.order='relevance'] 排序
 * @param {string} [options.apiKey] YouTube Data API Key（不传则读 YOUTUBE_API_KEY；都没有就走免 Key 检索）
 * @param {string} [options.origin] 网页端根地址（测试时指向本地假服务）
 * @param {string} [options.apiBase] Data API 根地址（测试时指向本地假服务）
 * @param {string} [options.hl='zh-CN'] 界面语言（影响「x 年前」「次观看」这类文案）
 * @param {string} [options.gl='US'] 地区
 * @param {typeof fetch} [options.fetch] 注入的 fetch
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{platform:'youtube', keyword:string, order:string, via:string, videos:object[]}>}
 */
export async function searchYouTube(keyword, options = {}) {
  const query = String(keyword ?? '').trim()
  if (!query) throw new VideoSearchError('关键词不能为空', { platform: PLATFORM })
  const order = Object.hasOwn(FILTERS, options.order ?? '') ? options.order : 'relevance'
  const common = { limit: clampLimit(options.limit), order, fetchImpl: options.fetch ?? globalThis.fetch, signal: options.signal }
  const apiKey = (options.apiKey ?? process.env.YOUTUBE_API_KEY ?? '').trim()
  if (apiKey) {
    const apiBase = (options.apiBase || YOUTUBE_DATA_API).replace(/\/+$/, '')
    return { platform: PLATFORM, keyword: query, order, via: 'data-api', videos: await searchDataApi(query, { ...common, apiBase, apiKey }) }
  }
  const origin = (options.origin || YOUTUBE_ORIGIN).replace(/\/+$/, '')
  const videos = await searchInnerTube(query, { ...common, origin, hl: options.hl || 'zh-CN', gl: options.gl || 'US' })
  return { platform: PLATFORM, keyword: query, order, via: 'innertube', videos }
}
