/**
 * DSH 插件入口：给「管理 Agent」注册 save_video_report —— 把最终推荐写成一份带链接的 Markdown 文档。
 *
 * 分工：管理 Agent 只需要说「选哪 1–2 个、为什么」；链接是否真的来自检索结果、
 * 标题/作者/播放量这些事实、文档的版式，都由这里的代码保证（见 run-store.js）。
 * 文件固定写到会话工作目录下的 video-scout/ 里，文件名由关键词和时间生成，模型不能指定路径。
 *
 * 可选配置：
 *   dir       相对会话工作目录的输出子目录，默认 video-scout
 *   maxPicks  最多推荐几个视频，默认 2
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { candidatesOf, runKeyOf } from './run-store.js'
import { renderReport, reportFileName, resolvePicks } from './report-render.js'

export const name = 'video-scout-report'
export const inject = ['tools']

/** 会话的工作目录：优先问宿主的 workingDirectory 服务，问不到就用进程的当前目录。 */
async function sessionCwd(ctx, exec) {
  try {
    const cwd = exec?.agent ? await ctx.get?.('workingDirectory')?.ensure?.(exec.agent, exec.signal) : undefined
    if (typeof cwd === 'string' && cwd) return cwd
  } catch (error) {
    if (exec?.signal?.aborted) throw error
  }
  return process.cwd()
}

export function createReportTool(ctx, config = {}) {
  const dir = typeof config.dir === 'string' && config.dir.trim() ? config.dir.trim() : 'video-scout'
  if (path.isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) throw new Error('video-scout-report: dir 必须是工作目录内的相对路径')
  const maxPicks = Number.isInteger(config.maxPicks) && config.maxPicks > 0 ? config.maxPicks : 2

  return {
    name: 'save_video_report',
    description:
      '把最终推荐保存成一份带链接的 Markdown 文档（写入当前工作目录的 video-scout/ 下），返回文件路径。'
      + `两个检索 Agent 都汇报完之后调用一次：给出关键词、综合结论，以及最终推荐的 1–${maxPicks} 个视频（链接 + 理由）。`
      + '标题、作者、播放量等信息工具会按检索记录自动补全，并附上全部候选的对照表；链接必须原样取自子 Agent 的汇报。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['keyword', 'summary', 'picks'],
      properties: {
        keyword: { type: 'string', description: '用户给的检索关键词或主题。' },
        summary: { type: 'string', description: '2–4 句综合结论：两个平台的结果各有什么特点，为什么最终推荐这几个。' },
        picks: {
          type: 'array',
          description: `最终推荐的 1–${maxPicks} 个视频，最值得看的排在前面。`,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['url', 'reason'],
            properties: {
              url: { type: 'string', description: '视频链接，原样复制子 Agent 汇报里的链接。' },
              reason: { type: 'string', description: '推荐理由，1–2 句，说清它为什么比其他候选更值得看。' },
              title: { type: 'string', description: '视频标题（可选；有检索记录时以记录为准）。' },
            },
          },
        },
        notes: { type: 'string', description: '可选。需要用户知道的异常，例如某个平台检索失败及原因。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          picks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { platform: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } },
              required: ['platform', 'title', 'url'],
            },
          },
          candidateCount: { type: 'integer' },
        },
        required: ['path', 'picks', 'candidateCount'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `推荐文档已保存：${value.path}`,
          `（收录推荐 ${value.picks.length} 个，候选对照 ${value.candidateCount} 个）`,
          ...value.picks.map((pick, index) => `${index + 1}. ${pick.title} ${pick.url}`),
          '',
          `下一步：调用 present 把这个文件交付给用户（files: [{ "path": ${JSON.stringify(value.path)} }]），然后给出简短的最终答复。`,
        ].join('\n'),
      }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const keyword = typeof args?.keyword === 'string' ? args.keyword.trim() : ''
      if (!keyword) throw new Error('save_video_report: 参数 keyword 必须是非空字符串')
      const candidates = candidatesOf(runKeyOf(ctx, exec))
      const { picks, errors } = resolvePicks(args.picks, candidates, maxPicks)
      if (errors.length) throw new Error(`save_video_report: 没有保存，请修正后重试。\n${errors.join('\n')}`)

      const date = new Date()
      const markdown = renderReport({ keyword, summary: args.summary, picks, candidates, notes: args.notes, date })
      const file = path.join(await sessionCwd(ctx, exec), dir, reportFileName(keyword, date))
      exec?.signal?.throwIfAborted()
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, markdown, 'utf8')
      return {
        path: file,
        picks: picks.map(({ platform, title, url }) => ({ platform, title, url })),
        candidateCount: [...candidates.values()].reduce((total, videos) => total + videos.length, 0),
      }
    },
  }
}

export function apply(ctx, config) {
  ctx.tools.register(createReportTool(ctx, config ?? {}))
}
