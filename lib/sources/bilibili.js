/**
 * B 站关键词检索（不需要登录）。
 *
 * 一次检索打 3 个请求，前两个带进程内缓存：
 *   1. /x/frontend/finger/spi        → 匿名设备标识 buvid3（不带它搜索接口直接 -412）
 *   2. /x/web-interface/nav          → WBI 签名用的两把密钥（未登录也会返回）
 *   3. /x/web-interface/wbi/search/type?search_type=video&…&w_rid=…   → 结果
 *
 * 可选：传入登录后的 Cookie（配置 cookie 或环境变量 BILIBILI_COOKIE）能降低被风控的概率。
 */
import crypto from 'node:crypto'
import { USER_AGENT, VideoSearchError, request, cleanText, truncate, parseCount, formatDuration, clampLimit } from './shared.js'

export const BILIBILI_API = 'https://api.bilibili.com'
const PLATFORM = 'bilibili'
const SESSION_TTL_MS = 10 * 60 * 1000 // WBI 密钥会轮换，缓存 10 分钟
const ORDERS = { relevance: 'totalrank', views: 'click', newest: 'pubdate' }
// 这些 code 都是「被风控」的不同说法
const RISK_CODES = new Set([-412, -352, -799, -509])

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

/** 由 nav 接口返回的两把密钥算出 32 位混合密钥。 */
export function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey
  if (raw.length !== 64) throw new VideoSearchError('B 站 WBI 签名密钥格式异常', { platform: PLATFORM })
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32)
}

/** WBI 签名：参数按 key 排序、过滤 !'()*、拼上 wts，再对「query + 混合密钥」做 MD5。 */
export function signWbi(params, key, nowMs = Date.now()) {
  const values = { ...params, wts: Math.round(nowMs / 1000) }
  const query = Object.keys(values)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

const keyOf = (url) => String(url ?? '').split('/').at(-1).split('.')[0]

// 进程内会话缓存：按「API 地址 + Cookie」区分，测试里可用 resetBilibiliSession() 清掉
const sessions = new Map()
export function resetBilibiliSession() {
  sessions.clear()
}

async function getJson(fetchImpl, url, headers, signal) {
  const response = await request(fetchImpl, url, { platform: PLATFORM, headers, signal })
  if (response.status === 412 || response.status === 429) throw riskError(`HTTP ${response.status}`)
  if (!response.ok) {
    throw new VideoSearchError(`B 站接口返回 HTTP ${response.status}`, { platform: PLATFORM, hint: '可能是接口变更或临时故障，稍后重试。' })
  }
  try {
    return JSON.parse(await response.text())
  } catch {
    throw new VideoSearchError('B 站接口返回了非 JSON 内容（通常是风控页）', { platform: PLATFORM, hint: RISK_HINT })
  }
}

const RISK_HINT = '稍等几分钟再试；仍然失败就设置环境变量 BILIBILI_COOKIE（浏览器登录 B 站后复制的 Cookie）后重启 DSH。'
const riskError = (detail) => new VideoSearchError(`B 站触发了风控（${detail}）`, { platform: PLATFORM, hint: RISK_HINT })

async function openSession(fetchImpl, apiBase, userCookie, signal) {
  const cacheKey = `${apiBase}\n${userCookie ?? ''}`
  const cached = sessions.get(cacheKey)
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached

  const baseHeaders = { 'user-agent': USER_AGENT, referer: 'https://search.bilibili.com/', accept: 'application/json, text/plain, */*' }
  let cookie = userCookie?.trim() || ''
  if (!/(^|;\s*)buvid3=/.test(cookie)) {
    // 没有 buvid3 就向 B 站要一个匿名的；要不到就本地生成（格式与浏览器首访时一致）
    let buvid3
    let buvid4
    try {
      const spi = await getJson(fetchImpl, `${apiBase}/x/frontend/finger/spi`, baseHeaders, signal)
      buvid3 = spi?.data?.b_3
      buvid4 = spi?.data?.b_4
    } catch (error) {
      if (signal?.aborted) throw error
    }
    buvid3 ||= `${crypto.randomUUID().toUpperCase()}infoc`
    cookie = [cookie, `buvid3=${buvid3}`, buvid4 ? `buvid4=${buvid4}` : ''].filter(Boolean).join('; ')
  }
  const headers = { ...baseHeaders, cookie }

  const nav = await getJson(fetchImpl, `${apiBase}/x/web-interface/nav`, headers, signal)
  const wbi = nav?.data?.wbi_img
  if (!wbi?.img_url || !wbi?.sub_url) {
    throw new VideoSearchError(`拿不到 B 站 WBI 签名密钥（code=${nav?.code}）`, { platform: PLATFORM, hint: RISK_HINT })
  }
  const session = { at: Date.now(), headers, key: mixinKey(keyOf(wbi.img_url), keyOf(wbi.sub_url)) }
  sessions.set(cacheKey, session)
  return session
}

/** 「12:34」「125:07」「1:02:03」→ 统一成 M:SS / H:MM:SS。 */
export function normalizeDuration(value) {
  const parts = String(value ?? '').trim().split(':')
  if (parts.some((part) => !/^\d+$/.test(part))) return ''
  return formatDuration(parts.reduce((total, part) => total * 60 + Number(part), 0))
}

/** 把搜索接口的一条原始结果归一化成两个平台通用的结构。 */
export function normalizeBilibiliItem(item) {
  const bvid = String(item?.bvid ?? '')
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null
  const pubdate = Number(item.pubdate)
  return {
    platform: PLATFORM,
    id: bvid,
    title: cleanText(item.title),
    url: `https://www.bilibili.com/video/${bvid}`,
    author: cleanText(item.author),
    views: parseCount(item.play),
    duration: normalizeDuration(item.duration),
    published: Number.isFinite(pubdate) && pubdate > 0 ? new Date(pubdate * 1000).toISOString().slice(0, 10) : '',
    description: truncate(cleanText(item.description), 160),
    danmaku: parseCount(item.video_review ?? item.danmaku),
    likes: parseCount(item.like),
    favorites: parseCount(item.favorites),
    tags: String(item.tag ?? '').split(',').map((t) => cleanText(t)).filter(Boolean).slice(0, 6),
  }
}

/**
 * 按关键词检索 B 站视频。
 * @param {string} keyword 关键词
 * @param {object} [options]
 * @param {number} [options.limit=5] 返回条数（1–10）
 * @param {'relevance'|'views'|'newest'} [options.order='relevance'] 排序
 * @param {string} [options.cookie] 可选的登录 Cookie
 * @param {string} [options.apiBase] API 根地址（测试时指向本地假服务）
 * @param {typeof fetch} [options.fetch] 注入的 fetch
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{platform:'bilibili', keyword:string, order:string, videos:object[]}>}
 */
export async function searchBilibili(keyword, options = {}) {
  const query = String(keyword ?? '').trim()
  if (!query) throw new VideoSearchError('关键词不能为空', { platform: PLATFORM })
  const limit = clampLimit(options.limit)
  const order = Object.hasOwn(ORDERS, options.order ?? '') ? options.order : 'relevance'
  const fetchImpl = options.fetch ?? globalThis.fetch
  const apiBase = (options.apiBase || BILIBILI_API).replace(/\/+$/, '')
  const cookie = options.cookie ?? process.env.BILIBILI_COOKIE

  // 密钥轮换时签名会失效（-403），清掉缓存重来一次
  for (let attempt = 0; ; attempt++) {
    const session = await openSession(fetchImpl, apiBase, cookie, options.signal)
    const signed = signWbi({ search_type: 'video', keyword: query, page: 1, order: ORDERS[order] }, session.key)
    const body = await getJson(fetchImpl, `${apiBase}/x/web-interface/wbi/search/type?${signed}`, session.headers, options.signal)
    if (body?.code === 0) {
      const videos = (Array.isArray(body.data?.result) ? body.data.result : [])
        .map(normalizeBilibiliItem)
        .filter(Boolean)
        .slice(0, limit)
      return { platform: PLATFORM, keyword: query, order, videos }
    }
    sessions.clear()
    if (RISK_CODES.has(Number(body?.code))) throw riskError(`code=${body.code}`)
    if (attempt === 0 && Number(body?.code) === -403) continue
    throw new VideoSearchError(`B 站搜索接口报错：code=${body?.code} ${body?.message ?? ''}`.trim(), { platform: PLATFORM })
  }
}
