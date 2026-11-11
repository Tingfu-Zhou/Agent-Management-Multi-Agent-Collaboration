#!/usr/bin/env node
/**
 * 不经过 DSH、直接在命令行里试两个检索模块 —— 用来确认「这台机器能不能搜到 B 站 / YouTube」。
 *
 *   node bin/video-scout.mjs bilibili 机器学习
 *   node bin/video-scout.mjs youtube "machine learning" --limit 3 --order views
 *   node bin/video-scout.mjs both 机器学习 --json
 *
 * 需要代理时：Node 22.21+ / 24+ 加上 NODE_USE_ENV_PROXY=1 就会遵循 HTTPS_PROXY
 * （在 DSH 里运行时不需要，DSH 自己会处理代理）。
 */
import { parseArgs } from 'node:util'
import { searchBilibili } from '../lib/sources/bilibili.js'
import { searchYouTube } from '../lib/sources/youtube.js'
import { renderSearchResult } from '../lib/search-tool.js'

const USAGE = '用法：node bin/video-scout.mjs <bilibili|youtube|both> <关键词> [--limit 5] [--order relevance|views|newest] [--json]'
const SOURCES = { bilibili: searchBilibili, youtube: searchYouTube }

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { limit: { type: 'string' }, order: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  })
} catch (error) {
  console.error(`${error.message}\n${USAGE}`)
  process.exit(2)
}
const [target, ...words] = parsed.positionals
const keyword = words.join(' ')
const platforms = target === 'both' ? Object.keys(SOURCES) : [target]
if (parsed.values.help || !keyword || !platforms.every((name) => Object.hasOwn(SOURCES, name))) {
  console.error(USAGE)
  process.exit(parsed.values.help ? 0 : 2)
}

const options = { limit: parsed.values.limit === undefined ? undefined : Number(parsed.values.limit), order: parsed.values.order }
// 两个平台并行检索；一个失败不影响另一个
const settled = await Promise.allSettled(platforms.map((name) => SOURCES[name](keyword, options)))
let failures = 0
const output = []
settled.forEach((outcome, index) => {
  if (outcome.status === 'fulfilled') return void output.push(outcome.value)
  failures++
  const { message, hint } = outcome.reason
  output.push({ platform: platforms[index], error: message, ...(hint ? { hint } : {}) })
})

if (parsed.values.json) console.log(JSON.stringify(output.length === 1 ? output[0] : output, null, 2))
else {
  console.log(output.map((item) => (item.error ? `[${item.platform}] ${item.error}${item.hint ? `\n建议：${item.hint}` : ''}` : renderSearchResult(item))).join('\n\n────────\n\n'))
}
process.exit(failures ? 1 : 0)
