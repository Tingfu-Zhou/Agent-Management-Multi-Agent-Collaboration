/** 测试公用：读夹具、造一个按路由应答并记录请求的假 fetch。 */
import { readFileSync } from 'node:fs'

export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

/**
 * 假 fetch：routes 的 key 是 URL 里要包含的片段，value 是应答（对象 → JSON；函数 → 自定义）。
 * 返回的函数带 calls 数组，记录每次请求的 url / method / headers / body。
 */
export function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body }
    calls.push(call)
    for (const [fragment, reply] of Object.entries(routes)) {
      if (!call.url.includes(fragment)) continue
      const value = typeof reply === 'function' ? await reply(call) : reply
      if (value instanceof Response) return value
      return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': typeof value === 'string' ? 'text/html' : 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }
  fn.calls = calls
  return fn
}
