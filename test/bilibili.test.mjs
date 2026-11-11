import test from 'node:test'
import assert from 'node:assert/strict'
import { mixinKey, signWbi, normalizeDuration, searchBilibili, resetBilibiliSession } from '../lib/sources/bilibili.js'
import { VideoSearchError } from '../lib/sources/shared.js'
import { fixture, fakeFetch } from './helpers.mjs'

const routes = () => ({
  '/x/frontend/finger/spi': fixture('bilibili-spi.json'),
  '/x/web-interface/nav': fixture('bilibili-nav.json'),
  '/x/web-interface/wbi/search/type': fixture('bilibili-search.json'),
})

test.beforeEach(() => resetBilibiliSession())

test('WBI 签名与官方文档给出的样例一致', () => {
  // 样例出自 bilibili-API-collect 的 WBI 签名文档
  const key = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45')
  assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8')
  assert.equal(
    signWbi({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169000),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
  )
})

test('签名时过滤 !\'()* 并对中文做 URL 编码', () => {
  const query = signWbi({ keyword: "机器学习!'()*" }, 'k'.repeat(32), 0)
  assert.match(query, /^keyword=%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0&wts=0&w_rid=[0-9a-f]{32}$/)
})

test('时长统一成 M:SS / H:MM:SS', () => {
  assert.equal(normalizeDuration('9:29'), '9:29')
  assert.equal(normalizeDuration('1105:36'), '18:25:36')
  assert.equal(normalizeDuration('1:2:3'), '1:02:03')
  assert.equal(normalizeDuration(''), '')
})

test('检索：依次取匿名 Cookie、签名密钥，再带签名搜索，并归一化结果', async () => {
  const fetch = fakeFetch(routes())
  const result = await searchBilibili(' 机器学习 ', { fetch, cookie: '' })

  assert.deepEqual(fetch.calls.map((c) => new URL(c.url).pathname), [
    '/x/frontend/finger/spi',
    '/x/web-interface/nav',
    '/x/web-interface/wbi/search/type',
  ])
  const search = new URL(fetch.calls[2].url)
  assert.equal(search.searchParams.get('keyword'), '机器学习')
  assert.equal(search.searchParams.get('search_type'), 'video')
  assert.equal(search.searchParams.get('order'), 'totalrank')
  assert.match(search.searchParams.get('w_rid'), /^[0-9a-f]{32}$/)
  assert.match(fetch.calls[2].headers.cookie, /buvid3=8F0E1B2C-/)
  assert.equal(fetch.calls[2].headers.referer, 'https://search.bilibili.com/')

  assert.equal(result.platform, 'bilibili')
  assert.equal(result.keyword, '机器学习')
  assert.equal(result.videos.length, 5, '默认只取前 5 条')
  assert.deepEqual(result.videos[0], {
    platform: 'bilibili',
    id: 'BV1if4y147hS',
    title: '【机器学习】动手学深度学习 | 00 预告 & 课程安排',
    url: 'https://www.bilibili.com/video/BV1if4y147hS',
    author: '跟李沐学AI',
    views: 2345678,
    duration: '9:29',
    published: '2021-03-06',
    description: '动手学深度学习 v2 课程预告，课程主页与教材链接见置顶评论。',
    danmaku: 12345,
    likes: 56789,
    favorites: 98765,
    tags: ['机器学习', '深度学习', '人工智能', 'PyTorch', '公开课'],
  })
  assert.equal(result.videos[1].duration, '18:25:36')
  assert.equal(result.videos[4].views, null, '播放量为 "--" 时记为未知')
})

test('limit 与 order 生效；第二次检索复用缓存的会话', async () => {
  const fetch = fakeFetch(routes())
  const first = await searchBilibili('机器学习', { fetch, cookie: '', limit: 2, order: 'views' })
  assert.equal(first.videos.length, 2)
  assert.equal(new URL(fetch.calls.at(-1).url).searchParams.get('order'), 'click')
  await searchBilibili('深度学习', { fetch, cookie: '', limit: 99 })
  assert.equal(fetch.calls.length, 4, '第二次只多打 1 个请求')
})

test('自带 buvid3 的 Cookie 会原样使用，不再请求匿名标识', async () => {
  const fetch = fakeFetch(routes())
  await searchBilibili('x', { fetch, cookie: 'SESSDATA=abc; buvid3=MINE' })
  assert.equal(fetch.calls.length, 2)
  assert.equal(fetch.calls[1].headers.cookie, 'SESSDATA=abc; buvid3=MINE')
})

test('风控（HTTP 412 / code -412）给出可操作的提示', async () => {
  const blocked = fakeFetch({ ...routes(), '/x/web-interface/wbi/search/type': () => new Response('blocked', { status: 412 }) })
  await assert.rejects(searchBilibili('x', { fetch: blocked, cookie: '' }), (error) => {
    assert.ok(error instanceof VideoSearchError)
    assert.match(error.message, /风控/)
    assert.match(error.hint, /BILIBILI_COOKIE/)
    return true
  })
  resetBilibiliSession()
  const coded = fakeFetch({ ...routes(), '/x/web-interface/wbi/search/type': { code: -412, message: '请求被拦截' } })
  await assert.rejects(searchBilibili('x', { fetch: coded, cookie: '' }), /风控（code=-412）/)
})

test('签名密钥过期（-403）时刷新密钥重试一次', async () => {
  let attempts = 0
  const fetch = fakeFetch({
    ...routes(),
    '/x/web-interface/wbi/search/type': () => (++attempts === 1 ? { code: -403, message: '访问权限不足' } : fixture('bilibili-search.json')),
  })
  const result = await searchBilibili('x', { fetch, cookie: '' })
  assert.equal(result.videos.length, 5)
  assert.equal(attempts, 2)
})

test('空关键词、接口报错、网络失败都抛 VideoSearchError', async () => {
  await assert.rejects(searchBilibili('  ', { fetch: fakeFetch(routes()) }), /关键词不能为空/)
  const failing = fakeFetch({ ...routes(), '/x/web-interface/wbi/search/type': { code: -400, message: '请求错误' } })
  await assert.rejects(searchBilibili('x', { fetch: failing, cookie: '' }), /code=-400 请求错误/)
  resetBilibiliSession()
  const offline = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) }
  await assert.rejects(searchBilibili('x', { fetch: offline, cookie: '' }), (error) => {
    assert.ok(error instanceof VideoSearchError)
    assert.match(error.message, /网络请求失败（ENOTFOUND）：api\.bilibili\.com/)
    return true
  })
})
