import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalVideoUrl, resolvePicks, renderReport, reportFileName, md } from '../lib/report-render.js'

const B1 = { platform: 'bilibili', id: 'BV1if4y147hS', title: '【机器学习】动手学深度学习 | 00 预告', url: 'https://www.bilibili.com/video/BV1if4y147hS', author: '跟李沐学AI', views: 2345678, duration: '9:29', published: '2021-03-06' }
const B2 = { platform: 'bilibili', id: 'BV1Pa411X76s', title: '2022吴恩达机器学习', url: 'https://www.bilibili.com/video/BV1Pa411X76s', author: '吴恩达机器学习', views: 9876543, duration: '18:25:36', published: '2022-06-23' }
const Y1 = { platform: 'youtube', id: 'aircAruvnKk', title: 'But what is a neural network?', url: 'https://www.youtube.com/watch?v=aircAruvnKk', author: '3Blue1Brown', views: 21345678, duration: '18:40', published: '8年前' }
const candidates = () => new Map([['bilibili', [B1, B2]], ['youtube', [Y1]]])

test('各种写法的视频链接归一成标准形式', () => {
  assert.equal(canonicalVideoUrl('https://www.bilibili.com/video/BV1if4y147hS/?spm_id_from=333.337'), B1.url)
  assert.equal(canonicalVideoUrl('http://m.bilibili.com/video/BV1if4y147hS'), B1.url)
  assert.equal(canonicalVideoUrl('https://youtu.be/aircAruvnKk?t=10'), Y1.url)
  assert.equal(canonicalVideoUrl('https://www.youtube.com/watch?v=aircAruvnKk&list=PL123'), Y1.url)
  assert.equal(canonicalVideoUrl('https://www.youtube.com/shorts/aircAruvnKk'), Y1.url)
  for (const bad of ['', 'not a url', 'https://example.com/video/BV1if4y147hS', 'https://www.bilibili.com/read/cv1', 'https://www.youtube.com/watch?v=short', 'javascript:alert(1)']) {
    assert.equal(canonicalVideoUrl(bad), null, bad)
  }
})

test('picks 对上检索记录后，标题、作者、数据以记录为准', () => {
  const { picks, errors } = resolvePicks(
    [
      { url: 'https://youtu.be/aircAruvnKk', reason: '动画直观', title: '模型乱写的标题' },
      { url: B2.url + '/', reason: '课程系统' },
    ],
    candidates(),
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(picks.map((p) => [p.title, p.url, p.reason, p.verified]), [
    [Y1.title, Y1.url, '动画直观', true],
    [B2.title, B2.url, '课程系统', true],
  ])
})

test('检索记录里没有的链接会被拒绝，并列出可选链接', () => {
  const { errors } = resolvePicks([{ url: 'https://www.bilibili.com/video/BV1xx411c7mD', reason: '编的' }], candidates())
  assert.match(errors[0], /不在子 Agent 的检索结果里/)
  assert.match(errors.at(-1), /可选的链接：[\s\S]*BV1if4y147hS[\s\S]*aircAruvnKk/)
})

test('数量与格式校验：空、超过 2 个、缺理由、不是视频链接', () => {
  assert.match(resolvePicks([], candidates()).errors[0], /至少要有 1 个/)
  assert.match(resolvePicks(undefined, candidates()).errors[0], /至少要有 1 个/)
  const three = resolvePicks([B1, B2, Y1].map((v) => ({ url: v.url, reason: 'r' })), candidates())
  assert.ok(three.errors.some((e) => /最多只能推荐 2 个/.test(e)))
  assert.ok(resolvePicks([{ url: B1.url, reason: ' ' }], candidates()).errors.some((e) => /reason 不能为空/.test(e)))
  assert.ok(resolvePicks([{ url: 'https://example.com', reason: 'r' }], candidates()).errors.some((e) => /不是 B 站或 YouTube 的视频链接/.test(e)))
  // 同一个视频写两遍只算一个
  assert.equal(resolvePicks([{ url: B1.url, reason: 'a' }, { url: B1.url + '?p=1', reason: 'b' }], candidates()).picks.length, 1)
})

test('没有任何检索记录时放行合法链接，但标记为未核对', () => {
  const { picks, errors } = resolvePicks([{ url: Y1.url, reason: 'r', title: 'T' }], new Map())
  assert.deepEqual(errors, [])
  assert.equal(picks[0].verified, false)
  assert.equal(picks[0].title, 'T')
  assert.equal(picks[0].platform, 'youtube')
})

test('渲染出的文档包含推荐、链接、理由和全部候选对照表', () => {
  const { picks } = resolvePicks([{ url: Y1.url, reason: '动画直观，适合入门' }, { url: B1.url, reason: '中文课程，配套教材' }], candidates())
  const doc = renderReport({ keyword: '机器学习', summary: 'B 站偏系统课程，YouTube 偏直观讲解。', picks, candidates: candidates(), notes: '', date: new Date(2026, 10, 11, 19, 30, 5) })

  assert.match(doc, /^# 「机器学习」视频推荐\n/)
  assert.match(doc, /由 Video Scout 多 Agent 协作生成 · 2026-11-11 19:30/)
  assert.match(doc, /从哔哩哔哩 2 个、YouTube 1 个候选里精选出 2 个/)
  assert.match(doc, /## 综合结论\n\nB 站偏系统课程，YouTube 偏直观讲解。/)
  assert.match(doc, /### 1\. \[But what is a neural network\?\]\(https:\/\/www\.youtube\.com\/watch\?v=aircAruvnKk\)/)
  assert.match(doc, /- \*\*平台\*\*：YouTube\n- \*\*作者\*\*：3Blue1Brown\n- \*\*数据\*\*：播放 2134\.6万 · 时长 18:40 · 发布 8年前\n- \*\*推荐理由\*\*：动画直观，适合入门\n- \*\*链接\*\*：<https:\/\/www\.youtube\.com\/watch\?v=aircAruvnKk>/)
  // 标题里的 | 和 [] 被转义，不会破坏表格和链接
  assert.match(doc, /### 2\. \[【机器学习】动手学深度学习 \\\| 00 预告\]\(https:\/\/www\.bilibili\.com\/video\/BV1if4y147hS\)/)
  assert.match(doc, /\| 1 \| ⭐ \[【机器学习】动手学深度学习 \\\| 00 预告\]\(.*\) \| 跟李沐学AI \| 234\.6万 \| 9:29 \| 2021-03-06 \|/)
  assert.match(doc, /\| 2 \| \[2022吴恩达机器学习\]/)
  assert.ok(!doc.includes('## 备注'))
  assert.ok(!doc.includes('没有对上检索记录'))
})

test('备注、未核对标记、没有候选时的版式', () => {
  const { picks } = resolvePicks([{ url: Y1.url, reason: 'r' }], new Map())
  const doc = renderReport({ keyword: 'k', summary: '', picks, candidates: new Map(), notes: 'B 站检索失败：风控', date: new Date(2026, 0, 2, 3, 4, 5) })
  assert.match(doc, /综合 B 站、YouTube 两个检索 Agent 的汇报，精选出 1 个/)
  assert.match(doc, /## 综合结论\n\n（无）/)
  assert.match(doc, /没有对上检索记录/)
  assert.ok(!doc.includes('## 全部候选'))
  assert.match(doc, /## 备注\n\nB 站检索失败：风控\n$/)
})

test('文件名只保留文字和数字，带时间戳', () => {
  const date = new Date(2026, 10, 11, 19, 30, 5)
  assert.equal(reportFileName('机器学习 入门/教程?', date), '机器学习-入门-教程-20261111-193005.md')
  assert.equal(reportFileName('../../etc/passwd', date), 'etc-passwd-20261111-193005.md')
  assert.equal(reportFileName('???', date), 'video-20261111-193005.md')
  assert.equal(reportFileName('a'.repeat(100), date), `${'a'.repeat(30)}-20261111-193005.md`)
})

test('Markdown 转义', () => {
  assert.equal(md('a|b [c] *d* _e_ `f` <g>\nh'), 'a\\|b \\[c\\] \\*d\\* \\_e\\_ \\`f\\` \\<g\\> h')
})
