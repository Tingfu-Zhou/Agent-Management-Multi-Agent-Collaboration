import test from 'node:test'
import assert from 'node:assert/strict'
import { searchYouTube, extractVideos, parseInitialData, parseIsoDuration } from '../lib/sources/youtube.js'
import { VideoSearchError, parseCount } from '../lib/sources/shared.js'
import { fixture, fakeFetch } from './helpers.mjs'

test('免 Key 检索：POST InnerTube，只取普通视频并归一化', async () => {
  const fetch = fakeFetch({ '/youtubei/v1/search': fixture('youtube-innertube.json') })
  const result = await searchYouTube('machine learning', { fetch, apiKey: '' })

  assert.equal(fetch.calls.length, 1)
  const call = fetch.calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(new URL(call.url).origin, 'https://www.youtube.com')
  const body = JSON.parse(call.body)
  assert.equal(body.query, 'machine learning')
  assert.equal(body.params, 'EgIQAQ%3D%3D', '带「只要视频」过滤器')
  assert.equal(body.context.client.clientName, 'WEB')

  assert.equal(result.via, 'innertube')
  assert.deepEqual(result.videos.map((v) => v.id), ['aircAruvnKk', 'i_LwzRVP7bg', 'ukzFI9rgwfU', 'Gv9_4yMHFhI', 'LIVEstrm00A'])
  assert.deepEqual(result.videos[0], {
    platform: 'youtube',
    id: 'aircAruvnKk',
    title: 'But what is a neural network? | Deep learning chapter 1',
    url: 'https://www.youtube.com/watch?v=aircAruvnKk',
    author: '3Blue1Brown',
    views: 21345678,
    duration: '18:40',
    published: '8年前',
    description: 'What are the neurons, why are there layers, and what is the math underlying it?',
  })
  assert.equal(result.videos[1].description, 'Learn Machine Learning in a way that is accessible to absolute beginners.')
  assert.equal(result.videos[3].views, 1200000, '英文缩写的播放量也能解析')
  assert.equal(result.videos[4].duration, '直播中')
})

test('广告、Shorts 货架、推荐货架、频道都被跳过', () => {
  const ids = extractVideos(fixture('youtube-innertube.json')).map((v) => v.id)
  assert.equal(ids.length, 6)
  assert.ok(!ids.includes('SHELFvide01'))
})

test('页面结构变化时退化为全树查找', () => {
  const odd = { contents: { somethingNew: { list: [{ wrapper: { videoRenderer: { videoId: 'abcdefghijk', title: { simpleText: 'T' } } } }] } } }
  assert.deepEqual(extractVideos(odd).map((v) => v.id), ['abcdefghijk'])
  assert.deepEqual(extractVideos({}), [])
})

test('InnerTube 失败时退回解析搜索结果页', async () => {
  const data = fixture('youtube-innertube.json')
  const html = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script><script>var x = "}";</script></html>`
  const fetch = fakeFetch({ '/youtubei/v1/search': () => new Response('nope', { status: 403 }), '/results': html })
  const result = await searchYouTube('机器学习', { fetch, apiKey: '', limit: 3, order: 'newest' })
  assert.equal(result.videos.length, 3)
  const page = new URL(fetch.calls[1].url)
  assert.equal(page.searchParams.get('search_query'), '机器学习')
  assert.equal(page.searchParams.get('sp'), 'CAISAhAB')
})

test('ytInitialData 的解析能处理字符串里的花括号和转义', () => {
  const html = 'x window["ytInitialData"] = {"a":"}\\"{","b":{"c":1}};</script>'
  assert.deepEqual(parseInitialData(html), { a: '}"{', b: { c: 1 } })
  assert.equal(parseInitialData('<html>no data</html>'), null)
})

test('两条路都失败时报错并提示代理 / API Key', async () => {
  const fetch = fakeFetch({ '/youtubei/v1/search': () => new Response('', { status: 429 }), '/results': () => new Response('', { status: 429 }) })
  await assert.rejects(searchYouTube('x', { fetch, apiKey: '' }), (error) => {
    assert.ok(error instanceof VideoSearchError)
    assert.match(error.message, /InnerTube HTTP 429；结果页 HTTP 429/)
    assert.match(error.hint, /HTTPS_PROXY/)
    return true
  })
})

test('配了 API Key 就走官方 Data API，并补齐播放量与时长', async () => {
  const fetch = fakeFetch({ '/search?': fixture('youtube-data-search.json'), '/videos?': fixture('youtube-data-videos.json') })
  const result = await searchYouTube('machine learning', { fetch, apiKey: 'TEST_KEY', limit: 2, order: 'views' })

  assert.equal(result.via, 'data-api')
  const search = new URL(fetch.calls[0].url)
  assert.equal(search.origin + search.pathname, 'https://www.googleapis.com/youtube/v3/search')
  assert.equal(search.searchParams.get('type'), 'video')
  assert.equal(search.searchParams.get('maxResults'), '2')
  assert.equal(search.searchParams.get('order'), 'viewCount')
  assert.equal(new URL(fetch.calls[1].url).searchParams.get('id'), 'aircAruvnKk,i_LwzRVP7bg')
  assert.deepEqual(result.videos[1], {
    platform: 'youtube',
    id: 'i_LwzRVP7bg',
    title: 'Machine Learning for Everybody – Full Course',
    url: 'https://www.youtube.com/watch?v=i_LwzRVP7bg',
    author: 'freeCodeCamp.org',
    views: 9876543,
    duration: '3:53:53',
    published: '2022-09-26',
    description: 'Learn Machine Learning in a way that is accessible to absolute beginners.',
  })
})

test('Data API 报错时不泄露 Key', async () => {
  const fetch = fakeFetch({
    '/search?': () => new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 }),
  })
  await assert.rejects(searchYouTube('x', { fetch, apiKey: 'SECRET_KEY_123' }), (error) => {
    assert.match(error.message, /HTTP 403（quotaExceeded）/)
    assert.ok(!error.message.includes('SECRET_KEY_123') && !error.hint.includes('SECRET_KEY_123'))
    return true
  })
})

test('小工具：ISO 时长与播放量解析', () => {
  assert.equal(parseIsoDuration('PT18M40S'), '18:40')
  assert.equal(parseIsoDuration('PT3H53M53S'), '3:53:53')
  assert.equal(parseIsoDuration('P1DT2S'), '24:00:02')
  assert.equal(parseIsoDuration('oops'), '')
  assert.equal(parseCount('21,345,678次观看'), 21345678)
  assert.equal(parseCount('2134万次观看'), 21340000)
  assert.equal(parseCount('1.2M views'), 1200000)
  assert.equal(parseCount('3.4亿'), 340000000)
  assert.equal(parseCount('无人观看'), null)
  assert.equal(parseCount('--'), null)
})
