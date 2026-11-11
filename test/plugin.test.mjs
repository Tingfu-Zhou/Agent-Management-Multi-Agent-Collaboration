/**
 * 插件入口的单测：用一个假的 DSH 上下文（只有 tools.register 和 get）加载三个入口，
 * 像宿主那样调用工具，验证「检索 → 登记 → 写文档」这条线，以及两棵 Agent 树互不串数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as bilibiliPlugin from '../lib/bilibili.js'
import * as youtubePlugin from '../lib/youtube.js'
import * as reportPlugin from '../lib/report.js'
import { clearRuns } from '../lib/run-store.js'
import { resetBilibiliSession } from '../lib/sources/bilibili.js'
import { fixture, fakeFetch } from './helpers.mjs'

/** 假宿主：记录注册的工具；subagents.rootOf 按 agent.root 返回根；workingDirectory.ensure 返回 agent.cwd。 */
function fakeHost() {
  const tools = new Map()
  const services = {
    subagents: { rootOf: (agent) => agent.root ?? agent },
    workingDirectory: { ensure: async (agent) => agent.cwd },
  }
  const listeners = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    get: (name) => services[name],
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
  }
  return { ctx, tools, services, emit: (event, payload) => listeners.get(event)?.(payload) }
}

async function withSites(run) {
  const realFetch = globalThis.fetch
  globalThis.fetch = fakeFetch({
    '/x/frontend/finger/spi': fixture('bilibili-spi.json'),
    '/x/web-interface/nav': fixture('bilibili-nav.json'),
    '/x/web-interface/wbi/search/type': fixture('bilibili-search.json'),
    '/youtubei/v1/search': fixture('youtube-innertube.json'),
  })
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'video-scout-test-'))
  try {
    return await run(cwd)
  } finally {
    globalThis.fetch = realFetch
    await rm(cwd, { recursive: true, force: true })
  }
}

const textOf = (tool, args, value) => tool.output.render(args, value).map((block) => block.text).join('\n')

test.beforeEach(() => { clearRuns(); resetBilibiliSession() })

test('三个入口都按 DSH 插件的形状导出，各注册一个工具', () => {
  const host = fakeHost()
  for (const plugin of [bilibiliPlugin, youtubePlugin, reportPlugin]) {
    assert.equal(typeof plugin.name, 'string')
    assert.deepEqual(plugin.inject, ['tools'])
    plugin.apply(host.ctx, undefined)
  }
  assert.deepEqual([...host.tools.keys()], ['bilibili_search', 'youtube_search', 'save_video_report'])
  assert.deepEqual(host.tools.get('bilibili_search').parameters.properties.order.enum, ['relevance', 'views', 'newest'])
  assert.deepEqual(host.tools.get('youtube_search').parameters.properties.order.enum, ['relevance', 'views'])
  for (const tool of host.tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.description.length > 20)
  }
})

test('完整链路：两个子 Agent 检索 → 管理 Agent 保存文档', () => withSites(async (cwd) => {
  const host = fakeHost()
  for (const plugin of [bilibiliPlugin, youtubePlugin, reportPlugin]) plugin.apply(host.ctx, {})
  const manager = { id: 'session-root', cwd }
  const signal = new AbortController().signal

  const bili = host.tools.get('bilibili_search')
  const biliValue = await bili.execute({ keyword: '机器学习' }, { agent: { id: 'child-b', root: manager }, signal })
  assert.equal(biliValue.videos.length, 5)
  assert.ok(biliValue.videos.every((v) => Object.values(v).every((x) => x !== null)), '返回值里没有 null 字段')
  const biliText = textOf(bili, {}, biliValue)
  assert.match(biliText, /^哔哩哔哩「机器学习」检索结果，共 5 条（排序：综合）：/)
  assert.match(biliText, /1\. 【机器学习】动手学深度学习 \| 00 预告 & 课程安排\n {3}链接：https:\/\/www\.bilibili\.com\/video\/BV1if4y147hS\n {3}UP主：跟李沐学AI｜播放：234\.6万｜弹幕：1\.2万｜时长：9:29｜发布：2021-03-06/)

  const tube = host.tools.get('youtube_search')
  const tubeValue = await tube.execute({ keyword: 'machine learning', limit: 4 }, { agent: { id: 'child-y', root: manager }, signal })
  assert.equal(tubeValue.videos.length, 4)
  assert.match(textOf(tube, {}, tubeValue), /频道：3Blue1Brown｜播放：2134\.6万｜时长：18:40｜发布：8年前/)

  const save = host.tools.get('save_video_report')
  // 编造的链接被拒绝
  await assert.rejects(
    save.execute({ keyword: '机器学习', summary: 's', picks: [{ url: 'https://www.youtube.com/watch?v=FAKEfake123', reason: 'r' }] }, { agent: manager, signal }),
    /没有保存[\s\S]*不在子 Agent 的检索结果里[\s\S]*可选的链接/,
  )
  const args = {
    keyword: '机器学习',
    summary: 'B 站有系统的中文课程，YouTube 的讲解更直观。',
    picks: [
      { url: 'https://www.youtube.com/watch?v=aircAruvnKk', reason: '动画直观，适合入门' },
      { url: 'https://www.bilibili.com/video/BV1Pa411X76s', reason: '课程最系统' },
    ],
  }
  const value = await save.execute(args, { agent: manager, signal })
  assert.equal(path.dirname(value.path), path.join(cwd, 'video-scout'))
  assert.match(path.basename(value.path), /^机器学习-\d{8}-\d{6}\.md$/)
  assert.equal(value.candidateCount, 9)
  assert.deepEqual(value.picks.map((p) => p.platform), ['youtube', 'bilibili'])
  assert.equal(value.listedCount, 9, '没有汇报记录时，对照表列出检索到的全部')
  assert.match(textOf(save, args, value), /推荐文档已保存：.*\n（文档里有 2 个推荐，以及 9 个候选的对照表；两个平台共检索到 9 个视频）[\s\S]*下一步：调用 present/)

  const doc = await readFile(value.path, 'utf8')
  assert.match(doc, /### 1\. \[But what is a neural network\? \\\| Deep learning chapter 1\]\(https:\/\/www\.youtube\.com\/watch\?v=aircAruvnKk\)/)
  assert.match(doc, /### 2\. \[\(强推\\\|双字\)2022吴恩达机器学习Deeplearning\.ai课程\]\(https:\/\/www\.bilibili\.com\/video\/BV1Pa411X76s\)/)
  assert.match(doc, /### 哔哩哔哩\n[\s\S]*### YouTube\n/)
  assert.equal((doc.match(/⭐/g) ?? []).length, 3, '说明行 1 个 + 两个推荐各 1 个')
}))

test('子 Agent 结束时记下它汇报了哪些视频，文档的候选表只列这些', () => withSites(async (cwd) => {
  const host = fakeHost()
  for (const plugin of [bilibiliPlugin, youtubePlugin, reportPlugin]) plugin.apply(host.ctx, {})
  const manager = { id: 'session-root', cwd }
  const signal = new AbortController().signal
  await host.tools.get('bilibili_search').execute({ keyword: '机器学习', limit: 6 }, { agent: { id: 'child-b', root: manager }, signal })
  await host.tools.get('youtube_search').execute({ keyword: 'ml' }, { agent: { id: 'child-y', root: manager }, signal })

  // DSH 发出的 subagent/end：子 Agent 的会话 id + 它的最终答复
  host.emit('subagent/end', { id: 'child-b', stopReason: 'completed', lastAssistantMessage: [
    { type: 'text', text: 'B 站检索结果\n1. 链接：https://www.bilibili.com/video/BV1if4y147hS\n2. 链接：https://www.bilibili.com/video/BV1Pa411X76s/?spm=1' },
  ] })
  host.emit('subagent/end', { id: 'child-y', lastAssistantMessage: [{ type: 'thinking', thinking: 'aircAruvnKk' }, { type: 'text', text: 'https://youtu.be/i_LwzRVP7bg' }] })
  host.emit('subagent/end', { id: 'someone-else', lastAssistantMessage: [{ type: 'text', text: 'BV1bx411M7Zx' }] })
  host.emit('subagent/end', { id: 'child-b' }) // 没有最终答复（例如被取消）：不应报错

  const value = await host.tools.get('save_video_report').execute(
    { keyword: '机器学习', summary: 's', picks: [{ url: 'https://www.bilibili.com/video/BV1if4y147hS', reason: 'r' }] },
    { agent: manager, signal },
  )
  assert.equal(value.candidateCount, 11, '检索到的总数不变')
  assert.equal(value.listedCount, 3, '对照表只列被汇报的')
  const doc = await readFile(value.path, 'utf8')
  assert.match(doc, /哔哩哔哩检索到 6 个、汇报 2 个；YouTube 检索到 5 个、汇报 1 个。管理 Agent 从中精选出 1 个。/)
  const rows = doc.match(/^\| \d+ \| .*$/gm)
  assert.equal(rows.length, 3)
  assert.match(rows[0], /⭐ .*BV1if4y147hS/)
  assert.match(rows[1], /BV1Pa411X76s/)
  assert.match(rows[2], /i_LwzRVP7bg/, '只认文本块里提到的视频，思考块不算')
}))

test('不同任务（不同的根 Agent）之间不共享检索记录', () => withSites(async (cwd) => {
  const host = fakeHost()
  for (const plugin of [bilibiliPlugin, reportPlugin]) plugin.apply(host.ctx, {})
  const signal = new AbortController().signal
  await host.tools.get('bilibili_search').execute({ keyword: 'a' }, { agent: { id: 'c1', root: { id: 'task-1', cwd } }, signal })

  // 另一个任务里没有登记过任何检索：合法链接放行但标记未核对
  const other = { id: 'task-2', cwd }
  const value = await host.tools.get('save_video_report').execute(
    { keyword: 'b', summary: 's', picks: [{ url: 'https://www.bilibili.com/video/BV1if4y147hS', reason: 'r', title: 'T' }] },
    { agent: other, signal },
  )
  assert.equal(value.candidateCount, 0)
  assert.match(await readFile(value.path, 'utf8'), /没有对上检索记录/)
}))

test('没有 rootOf 的宿主版本：顺着会话头的 parentSession 找到同一个任务', () => withSites(async (cwd) => {
  const host = fakeHost()
  delete host.services.subagents
  // 三层：root ← mid ← leaf；mid 已经下线（agents.get 查不到），仍然能归到它记录的父会话
  const root = { id: 'root-session', cwd, session: { header: {} } }
  const mid = { id: 'mid-session', session: { header: { parentSession: 'root-session' } } }
  const live = new Map([[root.id, root], [mid.id, mid]])
  host.services.agents = { get: (id) => live.get(id) }
  for (const plugin of [bilibiliPlugin, reportPlugin]) plugin.apply(host.ctx, {})
  const signal = new AbortController().signal

  const leaf = { id: 'leaf-session', session: { header: { parentSession: 'mid-session' } } }
  await host.tools.get('bilibili_search').execute({ keyword: 'a' }, { agent: leaf, signal })
  const save = () => host.tools.get('save_video_report').execute(
    { keyword: 'a', summary: 's', picks: [{ url: 'https://www.bilibili.com/video/BV1if4y147hS', reason: 'r' }] },
    { agent: root, signal },
  )
  assert.equal((await save()).candidateCount, 5, '子 Agent 的检索记到了根 Agent 的任务上')

  clearRuns()
  live.delete(mid.id)
  await host.tools.get('bilibili_search').execute({ keyword: 'a' }, { agent: leaf, signal })
  assert.equal((await save()).candidateCount, 0, '中间一层下线后，只能归到它的父会话 mid，而不是 root')
  const direct = { id: 'child', session: { header: { parentSession: 'root-session' } } }
  await host.tools.get('bilibili_search').execute({ keyword: 'a' }, { agent: direct, signal })
  assert.equal((await save()).candidateCount, 5, '直接子 Agent 不依赖 agents 服务也能归到根')
}))

test('宿主没有 subagents / workingDirectory 服务时也能工作', () => withSites(async (cwd) => {
  const host = fakeHost()
  delete host.services.subagents
  delete host.services.workingDirectory
  for (const plugin of [bilibiliPlugin, reportPlugin]) plugin.apply(host.ctx, { dir: 'out' })
  const agent = { id: 'solo' }
  const signal = new AbortController().signal
  await host.tools.get('bilibili_search').execute({ keyword: 'a' }, { agent, signal })
  // 问不到会话工作目录时，退回进程的当前目录
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    const value = await host.tools.get('save_video_report').execute(
      { keyword: 'a', summary: 's', picks: [{ url: 'https://www.bilibili.com/video/BV1if4y147hS', reason: 'r' }] },
      { agent, signal },
    )
    assert.equal(value.candidateCount, 5)
    assert.deepEqual(await readdir(path.join(cwd, 'out')), [path.basename(value.path)])
  } finally {
    process.chdir(previous)
  }
}))

test('参数与配置校验', async () => {
  const host = fakeHost()
  bilibiliPlugin.apply(host.ctx, {})
  reportPlugin.apply(host.ctx, {})
  const signal = new AbortController().signal
  await assert.rejects(host.tools.get('bilibili_search').execute({ keyword: '  ' }, { signal }), /keyword 必须是非空字符串/)
  await assert.rejects(host.tools.get('save_video_report').execute({ picks: [] }, { signal }), /keyword 必须是非空字符串/)
  assert.throws(() => reportPlugin.createReportTool(host.ctx, { dir: '../outside' }), /相对路径/)
  assert.throws(() => reportPlugin.createReportTool(host.ctx, { dir: '/abs' }), /相对路径/)
})

test('检索失败时，报错里带上排障建议', () => withSites(async () => {
  globalThis.fetch = fakeFetch({ '/x/': () => new Response('', { status: 412 }) })
  const host = fakeHost()
  bilibiliPlugin.apply(host.ctx, {})
  await assert.rejects(
    host.tools.get('bilibili_search').execute({ keyword: 'a' }, { signal: new AbortController().signal }),
    /B 站触发了风控（HTTP 412） 建议：.*BILIBILI_COOKIE/,
  )
}))
