#!/usr/bin/env node
/**
 * 端到端测试：在「真实的 DSH」里把整条多 Agent 链路跑一遍。
 *
 *   全新的 DSH_HOME → dsh plugin add 安装本插件 → 启动 dsh web
 *   → 用浏览器走用户路径：选工作区 → 选「视频侦察」预设 → 输入关键词 → 等结果
 *   → 检查：管理 Agent 派出了两个子 Agent、两个检索工具都真的发了请求、
 *           生成的文档里是检索到的真实链接、文档作为交付物出现在界面上。
 *
 * 模型和视频站都是本地假的（fake-llm.mjs / fake-sites.mjs），所以不需要 API Key 和外网，
 * 结果可复现。它验证的是插件和 DSH 的对接，不是真实模型的发挥。
 *
 * 用法：npm run e2e
 * 需要：Node ≥ 24.9（DSH 的要求）、dsh 命令、playwright（npm i -g playwright && npx playwright install chromium）
 * 环境变量：
 *   DSH_BIN           dsh 可执行文件的路径（默认用 PATH 里的 dsh）
 *   E2E_PLUGIN_SPEC   传给 dsh plugin add 的安装来源（默认是本仓库目录；可以换成 npm pack 出来的 .tgz 或 github:用户/仓库）
 *   E2E_REAL_SITES=1  检索工具访问真实的 B 站 / YouTube（模型仍然是假的），用来验证本机网络下工具可用
 *   E2E_REAL_MODEL=1  用真实的 DeepSeek 模型（需要 DEEPSEEK_API_KEY），看三个 Agent 在真模型下的实际表现；
 *                     这时结果不固定，只检查「生成了文档、推荐了 1–2 个、链接都对得上检索记录」
 *   E2E_KEYWORD       关键词（默认「机器学习入门」）
 *   E2E_SHOTS         截图输出目录（默认不截图）
 *   E2E_KEEP=1        结束后保留临时目录，方便排查
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { startFakeLlm } from './fake-llm.mjs'
import { startFakeSites } from './fake-sites.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const DSH = process.env.DSH_BIN || 'dsh'
const KEYWORD = process.env.E2E_KEYWORD || '机器学习入门'
const REAL_SITES = process.env.E2E_REAL_SITES === '1'
const REAL_MODEL = process.env.E2E_REAL_MODEL === '1'
if (REAL_MODEL && !process.env.DEEPSEEK_API_KEY) {
  console.error('E2E_REAL_MODEL=1 需要同时设置 DEEPSEEK_API_KEY')
  process.exit(2)
}
const step = (message) => console.log(`\n▶ ${message}`)
const ok = (message) => console.log(`  ✓ ${message}`)

let chromium
try {
  ;({ chromium } = createRequire(import.meta.url)('playwright'))
} catch {
  console.error('找不到 playwright。先安装：npm i -g playwright && npx playwright install chromium')
  process.exit(2)
}

/** 跑一个命令到结束，返回输出；非 0 退出则抛错。 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) => reject(new Error(`无法运行 ${command}：${error.message}（用 DSH_BIN 指定 dsh 的路径）`)))
    child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}\n${output}`))))
  })
}

const work = await mkdtemp(path.join(os.tmpdir(), 'video-scout-e2e-'))
const workspace = path.join(work, 'workspace')
await mkdir(workspace)
const cleanups = []
let failed = false
let page // 失败时用来截图

try {
  step('准备模型和视频站')
  const llm = await startFakeLlm()
  const sites = await startFakeSites()
  cleanups.push(() => llm.close(), () => sites.close())
  const env = {
    ...process.env,
    DSH_HOME: path.join(work, 'dsh-home'),
    // 默认把 DSH 的 DeepSeek 适配器指向假模型；E2E_REAL_MODEL=1 时用环境里的 Key 访问真实接口
    ...(REAL_MODEL ? {} : { DEEPSEEK_API_KEY: 'fake-key-for-e2e', DEEPSEEK_BASE_URL: llm.baseUrl }),
    DSH_TELEMETRY_MODE: 'DISABLED',
    // 检索工具默认指向假视频站；E2E_REAL_SITES=1 时不覆盖，走真实站点
    ...(REAL_SITES ? {} : { VIDEO_SCOUT_BILIBILI_API: sites.url, VIDEO_SCOUT_YOUTUBE_ORIGIN: sites.url }),
  }
  if (REAL_SITES) {
    delete env.VIDEO_SCOUT_BILIBILI_API
    delete env.VIDEO_SCOUT_YOUTUBE_ORIGIN
  } else {
    delete env.BILIBILI_COOKIE
    delete env.YOUTUBE_API_KEY
  }
  if (REAL_MODEL) delete env.DEEPSEEK_BASE_URL
  ok(`${REAL_MODEL ? '真实的 DeepSeek 模型' : `假模型 ${llm.baseUrl}`}，${REAL_SITES ? '真实的 B 站 / YouTube' : `假视频站 ${sites.url}`}`)

  step('把插件装进一个全新的 DSH（dsh plugin --profile web add）')
  const version = (await run(DSH, ['--version'], { env })).trim()
  await run(DSH, ['plugin', '--profile', 'web', 'add', process.env.E2E_PLUGIN_SPEC || REPO], { env, cwd: work })
  const profile = JSON.parse(await readFile(path.join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes('dsh-video-scout'), '组合包应当出现在 profile 的 bundles 里')
  const dump = await run(DSH, ['--profile', 'web', '--dump-config'], { env, cwd: work })
  for (const id of ['video-scout', 'video-scout-bilibili', 'video-scout-youtube']) assert.match(dump, new RegExp(`\\bid: ${id}\\n`), `缺少预设 ${id}`)
  ok(`DSH ${version}：已安装，三个预设都在组合出的配置里`)

  step('启动 dsh web')
  const server = spawn(DSH, ['web', '--no-open', '--port', '0'], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = ''
  cleanups.push(() => new Promise((resolve) => { server.once('exit', resolve); server.kill('SIGTERM'); setTimeout(() => server.kill('SIGKILL'), 5000).unref() }))
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web 60 秒内没有启动\n${serverLog}`)), 60_000)
    const onData = (chunk) => {
      serverLog += chunk
      const match = serverLog.match(/dsh web: (\S+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    server.stdout.on('data', onData)
    server.stderr.on('data', onData)
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dsh web 提前退出（${code}）\n${serverLog}`)) })
  })
  ok(`已启动：${url.replace(/token=.*/, 'token=…')}`)

  step('用浏览器走一遍用户路径')
  const browser = await chromium.launch()
  cleanups.push(() => browser.close())
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN' })
  const shots = process.env.E2E_SHOTS
  if (shots) await mkdir(shots, { recursive: true })
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }) }

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // 首次打开会有一个「预览版说明」，点掉
  const notice = page.getByRole('button', { name: '继续' })
  await notice.click({ timeout: 20_000 }).catch(() => {})

  // 选工作区：在目录选择框里直接填路径
  await page.getByRole('button', { name: '选择工作区' }).click()
  await page.getByRole('button', { name: '编辑路径' }).click()
  const pathInput = page.locator('[role=dialog] input').first()
  await pathInput.fill(workspace)
  await pathInput.press('Enter')
  await page.getByRole('button', { name: '打开' }).click()
  // 目录选择框关闭、工作区按钮显示出目录名之后，工作区才算绑定完成
  await page.locator('[role=dialog]').waitFor({ state: 'detached', timeout: 20_000 })
  await page.locator('button[aria-label="选择工作区"]', { hasText: path.basename(workspace) }).waitFor({ timeout: 20_000 })
  ok('已选择工作区')

  // 选预设：三个预设都应该出现在模式菜单里。预设是 DSH 启动后异步挂载的，菜单里没有就关掉重开，最多等 30 秒
  const presetButton = page.locator('button[title="选择新任务使用的 Agent 预设"]')
  const wanted = ['视频侦察 Video Scout', 'B 站检索 Agent', 'YouTube 检索 Agent']
  let menu = []
  for (const deadline = Date.now() + 30_000; ;) {
    await presetButton.click()
    const opened = await page.getByRole('menuitem').first().waitFor({ timeout: 3_000 }).then(() => true, () => false)
    menu = opened ? await page.getByRole('menuitem').allInnerTexts() : []
    if (wanted.every((name) => menu.some((item) => item.startsWith(name))) || Date.now() > deadline) break
    if (opened) await page.keyboard.press('Escape')
    await page.waitForTimeout(1000)
  }
  for (const name of wanted) {
    assert.ok(menu.some((item) => item.startsWith(name)), `模式菜单里缺少「${name}」，当前菜单：${menu.map((item) => item.split('\n')[0]).join(' / ')}`)
  }
  await shot('1-presets')
  await page.getByRole('menuitem', { name: /视频侦察 Video Scout/ }).click()
  ok('模式菜单里有三个预设，已选择「视频侦察 Video Scout」')

  // 输入关键词并发送
  await page.locator('[contenteditable=true]').first().click()
  await page.keyboard.type(KEYWORD)
  await page.getByRole('button', { name: '发送消息' }).click()
  const bodyText = () => page.evaluate(() => document.body.innerText)
  const giveUp = async (what) => { throw new Error(`${what}。界面内容：\n${(await bodyText()).slice(-2000)}`) }
  if (REAL_MODEL) {
    // 真模型的措辞不固定：等文档落盘，再等界面内容稳定下来（连续 8 秒不再变化）就算这一轮结束
    const reportDir = path.join(workspace, 'video-scout')
    const deadline = Date.now() + 10 * 60_000
    let files = []
    while (!files.length) {
      if (Date.now() > deadline) await giveUp('10 分钟内没有生成文档')
      await page.waitForTimeout(3000)
      files = await readdir(reportDir).catch(() => [])
    }
    for (let previous = '', stableSince = Date.now(); ;) {
      await page.waitForTimeout(2000)
      const current = await bodyText()
      if (current !== previous) { previous = current; stableSince = Date.now() }
      else if (Date.now() - stableSince >= 8000 && current.includes(files[0])) break
      if (Date.now() > deadline) await giveUp('文档已生成，但管理 Agent 一直没有收尾')
    }
  } else {
    // 假模型在成功时会说「完整的推荐文档已保存」；其他结局（检索失败、保存失败）直接把对话内容报出来
    await page.getByText('完整的推荐文档已保存').waitFor({ timeout: 180_000 }).catch(() => giveUp('没有等到最终答复'))
    await page.waitForTimeout(1500) // 等交付卡片渲染出来
  }
  await shot('2-result')
  const body = await bodyText()
  ok('管理 Agent 给出了最终答复')
  if (shots) {
    // 顺手截一张子智能体列表（点开标题栏的「2 个子智能体」）；截不到不算失败
    await page.getByText(/\d+ 个子智能体/).first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(800)
    await shot('3-subagents')
    await page.keyboard.press('Escape').catch(() => {})
  }

  step('检查结果')
  assert.match(body, /2 个子智能体/, '界面应显示管理 Agent 派出了 2 个子智能体')
  ok('界面显示「2 个子智能体」')

  if (!REAL_MODEL) {
    // 假模型记录了 DSH 发来的每个请求，可以看到每个 Agent 实际拿到了哪些工具
    const toolsets = llm.requests.map((request) => (request.body.tools ?? []).map((tool) => tool.name))
    const manager = toolsets.find((tools) => tools.includes('bilibili_agent'))
    assert.ok(manager, '管理 Agent 应当向模型发过请求')
    for (const tool of ['bilibili_agent', 'youtube_agent', 'save_video_report', 'present']) assert.ok(manager.includes(tool), `管理 Agent 缺少工具 ${tool}`)
    assert.ok(!manager.includes('bilibili_search') && !manager.includes('youtube_search'), '管理 Agent 不应该直接拥有检索工具')
    const biliAgent = toolsets.find((tools) => tools.includes('bilibili_search'))
    const tubeAgent = toolsets.find((tools) => tools.includes('youtube_search'))
    assert.ok(biliAgent && tubeAgent, '两个检索 Agent 都应当向模型发过请求')
    assert.ok(!biliAgent.includes('youtube_search') && !tubeAgent.includes('bilibili_search'), '两个检索 Agent 各自只有自己平台的检索工具')
    assert.ok(![biliAgent, tubeAgent].some((tools) => tools.includes('bilibili_agent') || tools.includes('save_video_report')), '检索 Agent 不应该有管理 Agent 的工具')
    ok(`三个 Agent 的工具各不相同：管理 [${manager.join(', ')}]；B 站 [${biliAgent.join(', ')}]；YouTube [${tubeAgent.join(', ')}]`)
  }

  if (!REAL_SITES) {
    assert.ok(sites.hits.some((hit) => hit.endsWith('/x/web-interface/wbi/search/type')), 'B 站检索工具应当请求过搜索接口')
    assert.ok(sites.hits.includes('POST /youtubei/v1/search'), 'YouTube 检索工具应当请求过搜索接口')
    ok('两个检索工具都真的发出了请求')
  }

  const reports = await readdir(path.join(workspace, 'video-scout'))
  assert.equal(reports.length, 1, '应当生成一份文档')
  const report = await readFile(path.join(workspace, 'video-scout', reports[0]), 'utf8')
  if (process.env.E2E_SHOTS) await writeFile(path.join(process.env.E2E_SHOTS, 'report.md'), report)
  assert.match(report, /^# 「.+」视频推荐/)
  const picks = [...report.matchAll(/^### \d+\. \[.+\]\((https:\/\/www\.(?:bilibili\.com\/video\/BV[0-9A-Za-z]{10}|youtube\.com\/watch\?v=[\w-]{11}))\)$/gm)].map((match) => match[1])
  assert.ok(picks.length >= 1 && picks.length <= 2, `文档应当推荐 1–2 个视频，实际 ${picks.length} 个`)
  // 子 Agent 汇报的比检索到的少时，开头写的是「检索到 N 个、汇报 M 个」；一样多时写「从 … 候选里精选出」
  assert.match(report, /哔哩哔哩检索到 \d+ 个、汇报 \d+ 个；YouTube 检索到 \d+ 个、汇报 \d+ 个。管理 Agent 从中精选出 [12] 个|从哔哩哔哩 \d+ 个、YouTube \d+ 个候选里精选出 [12] 个/)
  assert.ok(!report.includes('没有对上检索记录'), '子 Agent 的检索记录应当能被管理 Agent 的写文档工具查到')
  if (!REAL_MODEL) {
    // 假模型固定各取一个：第 1 个来自 B 站，第 2 个来自 YouTube
    assert.equal(picks.length, 2)
    assert.match(picks[0], /bilibili\.com/)
    assert.match(picks[1], /youtube\.com/)
  }
  if (!REAL_SITES && !REAL_MODEL) {
    // 假视频站的内容是固定的，可以精确核对标题与链接
    assert.match(report, /### 1\. \[【机器学习】动手学深度学习 \\\| 00 预告 & 课程安排\]\(https:\/\/www\.bilibili\.com\/video\/BV1if4y147hS\)/)
    assert.match(report, /### 2\. \[But what is a neural network\? \\\| Deep learning chapter 1\]\(https:\/\/www\.youtube\.com\/watch\?v=aircAruvnKk\)/)
    // 假模型的子 Agent 各检索到 5 个、只汇报 4 个：DSH 的 subagent/end 事件被插件收到，候选表各列 4 行
    assert.match(report, /哔哩哔哩检索到 5 个、汇报 4 个；YouTube 检索到 5 个、汇报 4 个。管理 Agent 从中精选出 2 个/)
    assert.equal((report.match(/^\| \d+ \| /gm) ?? []).length, 8, '候选表应当只列子 Agent 汇报的 4 + 4 个')
    assert.ok(!report.includes('BV1Wv411h7kN') && !report.includes('LIVEstrm00A'), '没被汇报的第 5 个不应出现在文档里')
  }
  ok(`文档 ${reports[0]}：推荐了 ${picks.length} 个视频，标题、链接都来自检索记录，并附子 Agent 所汇报视频的对照表`)

  assert.ok(body.includes(reports[0]), '文档应当作为交付物出现在界面上')
  ok('文档作为交付物出现在对话里')

  console.log('\n端到端测试通过 ✓')
} catch (error) {
  failed = true
  console.error(`\n端到端测试失败 ✗\n${error.stack ?? error}`)
  if (page && process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'failure.png') }).catch(() => {})
} finally {
  for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {})
  if (process.env.E2E_KEEP === '1') console.log(`临时目录保留在：${work}`)
  else await rm(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
