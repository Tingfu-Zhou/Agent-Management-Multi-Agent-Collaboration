/**
 * 两个检索工具（bilibili_search / youtube_search）共用的工具定义。
 *
 * 这里直接按 DSH 的原始 ToolDefinition 形状写（name / description / parameters / output / execute），
 * 不 import 宿主的任何包 —— 所以插件零依赖，`dsh plugin add` 之后不用再装别的东西。
 */
import { formatCount, clampLimit } from './sources/shared.js'
import { recordSearch, runKeyOf } from './run-store.js'
import { PLATFORM_LABEL } from './report-render.js'

const ORDER_LABEL = { relevance: '综合', views: '播放量', newest: '最新发布' }
const ORDER_HINT = { relevance: '综合相关度', views: '播放量最高', newest: '最新发布' }

/** 把一条视频渲染成给模型看的几行文字。 */
export function renderVideo(video, index) {
  const stats = [
    video.author && `${video.platform === 'bilibili' ? 'UP主' : '频道'}：${video.author}`,
    typeof video.views === 'number' && `播放：${formatCount(video.views)}`,
    typeof video.danmaku === 'number' && `弹幕：${formatCount(video.danmaku)}`,
    video.duration && `时长：${video.duration}`,
    video.published && `发布：${video.published}`,
  ].filter(Boolean)
  return [
    `${index + 1}. ${video.title}`,
    `   链接：${video.url}`,
    stats.length ? `   ${stats.join('｜')}` : '',
    video.description ? `   简介：${video.description}` : '',
    video.tags?.length ? `   标签：${video.tags.join('、')}` : '',
  ].filter(Boolean).join('\n')
}

/** 把一次检索的结果渲染成给模型看的文本。 */
export function renderSearchResult(result) {
  const label = PLATFORM_LABEL[result.platform] ?? result.platform
  if (!result.videos.length) {
    return `${label}没有检索到「${result.keyword}」相关的视频。可以换一个更常见的说法再检索一次。`
  }
  return [
    `${label}「${result.keyword}」检索结果，共 ${result.videos.length} 条（排序：${ORDER_LABEL[result.order] ?? result.order}）：`,
    '',
    result.videos.map(renderVideo).join('\n\n'),
  ].join('\n')
}

const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    platform: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    author: { type: 'string' },
    duration: { type: 'string' },
    published: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['platform', 'id', 'title', 'url'],
}

/**
 * 生成一个检索工具定义。
 * @param {object} ctx 插件上下文
 * @param {object} spec
 * @param {string} spec.name 工具名
 * @param {'bilibili'|'youtube'} spec.platform 平台
 * @param {string} spec.description 给模型看的工具说明
 * @param {(keyword:string, options:object) => Promise<object>} spec.search 实际的检索函数
 * @param {string[]} [spec.orders] 这个平台支持的排序，默认三种都支持
 */
export function createSearchTool(ctx, { name, platform, description, search, orders = Object.keys(ORDER_LABEL) }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['keyword'],
      properties: {
        keyword: { type: 'string', description: '检索关键词。用简短的词或短语，不要写成一句话。' },
        limit: { type: 'integer', description: '返回几条，1–10，默认 5。' },
        order: {
          type: 'string',
          enum: orders,
          description: `排序方式，默认 relevance：${orders.map((order) => `${order} ${ORDER_HINT[order]}`).join('、')}。`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          keyword: { type: 'string' },
          order: { type: 'string' },
          videos: { type: 'array', items: VIDEO_SCHEMA },
        },
        required: ['platform', 'keyword', 'order', 'videos'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true, // 只读请求，可以和别的工具调用并行
    async execute(args, exec) {
      const keyword = typeof args?.keyword === 'string' ? args.keyword.trim() : ''
      if (!keyword) throw new Error(`${name}: 参数 keyword 必须是非空字符串`)
      let result
      try {
        const order = orders.includes(args.order) ? args.order : 'relevance'
        result = await search(keyword, { limit: clampLimit(args.limit), order, signal: exec?.signal })
      } catch (error) {
        if (exec?.signal?.aborted) throw error
        // 把排障建议一起交给模型，让它如实汇报而不是编结果
        throw new Error([error.message, error.hint].filter(Boolean).join(' 建议：'), { cause: error })
      }
      // 去掉 null 字段，保证返回值是干净的 JSON
      const videos = result.videos.map((video) => Object.fromEntries(Object.entries(video).filter(([, v]) => v !== null && v !== undefined)))
      const value = { platform, keyword: result.keyword, order: result.order, videos }
      recordSearch(runKeyOf(ctx, exec), value, exec?.agent?.id)
      return value
    },
  }
}
