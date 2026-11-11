/**
 * 端到端测试用的「假视频站」：一个本地 HTTP 服务，同时扮演 B 站 API 和 YouTube 网页端，
 * 用 test/fixtures 里的夹具应答。这样端到端测试不依赖外网，结果也完全可复现。
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

/**
 * @returns {Promise<{url:string, hits:string[], close:() => Promise<void>}>} hits 记录被访问过的路径
 */
export async function startFakeSites() {
  const hits = []
  const routes = {
    '/x/frontend/finger/spi': fixture('bilibili-spi.json'),
    '/x/web-interface/nav': fixture('bilibili-nav.json'),
    '/x/web-interface/wbi/search/type': fixture('bilibili-search.json'),
    '/youtubei/v1/search': fixture('youtube-innertube.json'),
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    hits.push(`${request.method} ${url.pathname}`)
    request.resume()
    const body = routes[url.pathname]
    // 搜索接口必须带 WBI 签名，顺便验证插件确实签了名
    if (url.pathname.endsWith('/wbi/search/type') && !/^[0-9a-f]{32}$/.test(url.searchParams.get('w_rid') ?? '')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"code":-403,"message":"missing w_rid"}')
      return
    }
    if (body === undefined) return void response.writeHead(404).end('not found')
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
