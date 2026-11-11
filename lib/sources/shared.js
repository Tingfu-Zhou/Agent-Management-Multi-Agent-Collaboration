/**
 * 两个平台检索模块共用的小工具：错误类型、带超时的 fetch、文本清洗、数字格式化。
 * 这里不依赖 DSH，任何 Node 18+ 环境都能直接 import（方便单测和命令行调试）。
 */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 检索失败时抛出的错误：message 面向模型/用户，hint 给出可操作的排障建议。 */
export class VideoSearchError extends Error {
  constructor(message, { platform, hint, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'VideoSearchError'
    this.platform = platform
    this.hint = hint
  }
}

/**
 * 发一次带超时的请求，并把「网络层失败」统一翻译成 VideoSearchError。
 * @param {typeof fetch} fetchImpl 注入的 fetch（测试里换成假的）
 */
export async function request(fetchImpl, url, { platform, timeoutMs = 15_000, signal, ...init } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    return await fetchImpl(url, { ...init, signal: combined })
  } catch (error) {
    if (signal?.aborted) throw error // 调用方主动取消，原样抛出
    const host = safeHost(url)
    const why = timeout.aborted ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : `网络请求失败（${error?.cause?.code ?? error?.name ?? 'unknown'}）`
    throw new VideoSearchError(`${why}：${host}`, {
      platform,
      hint: `请确认本机能访问 ${host}；需要代理时在启动 DSH 前导出 HTTPS_PROXY。`,
      cause: error,
    })
  }
}

function safeHost(url) {
  try { return new URL(url).host } catch { return String(url) }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** 去掉 HTML 标签（B 站搜索结果里的 <em class="keyword">）并解码常见实体。 */
export function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
      if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? whole
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截断过长文本（按码点截，不切坏 emoji）。 */
export function truncate(text, max) {
  const points = Array.from(String(text ?? ''))
  return points.length <= max ? points.join('') : points.slice(0, max - 1).join('') + '…'
}

/** 「12,345」「1.2万」「3.4M views」「123万次观看」→ 数字；认不出来返回 null。 */
export function parseCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
  const text = String(value ?? '').replace(/,/g, '')
  const match = text.match(/(\d+(?:\.\d+)?)\s*(万|亿|[kmb])?/i)
  if (!match) return null
  const unit = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 亿: 1e8 }[(match[2] ?? '').toLowerCase()] ?? 1
  return Math.round(parseFloat(match[1]) * unit)
}

/** 数字 → 中文读法：12345 → 「1.2万」，123456789 → 「1.2亿」。 */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value >= 1e8) return trimZero(value / 1e8) + '亿'
  if (value >= 1e4) return trimZero(value / 1e4) + '万'
  return String(value)
}

function trimZero(n) {
  return n.toFixed(1).replace(/\.0$/, '')
}

/** 秒数 → 「M:SS」或「H:MM:SS」。 */
export function formatDuration(totalSeconds) {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds < 0) return ''
  const s = Math.round(totalSeconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** 把 limit 夹到 [1, max] 的整数。 */
export function clampLimit(value, fallback = 5, max = 10) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(n)))
}
