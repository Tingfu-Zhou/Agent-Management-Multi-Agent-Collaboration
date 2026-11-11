/**
 * DSH 插件入口：给「YouTube 检索 Agent」注册它唯一的工具 youtube_search。
 *
 * 挂在 cordis.patch.yml 里 video-scout-youtube 这个预设下面，所以只有那个子 Agent 看得到它。
 * 可选配置（都可以不填）：
 *   apiKey   YouTube Data API v3 的 Key；不填则读环境变量 YOUTUBE_API_KEY，再没有就走免 Key 检索
 *   hl / gl  界面语言与地区，默认 zh-CN / US
 *   origin / apiBase  仅测试用（指向本地假服务）
 */
import { searchYouTube } from './sources/youtube.js'
import { createSearchTool } from './search-tool.js'

export const name = 'video-scout-youtube'
export const inject = ['tools']

export function apply(ctx, config) {
  const fixed = {
    apiKey: config?.apiKey || undefined,
    hl: config?.hl || undefined,
    gl: config?.gl || undefined,
    origin: config?.origin || process.env.VIDEO_SCOUT_YOUTUBE_ORIGIN || undefined,
    apiBase: config?.apiBase || process.env.VIDEO_SCOUT_YOUTUBE_API || undefined,
  }
  ctx.tools.register(createSearchTool(ctx, {
    name: 'youtube_search',
    platform: 'youtube',
    description:
      '在 YouTube 按关键词检索视频，返回标题、链接、频道、播放量、时长、发布时间和简介。'
      + '结果里的链接是真实可打开的，引用时必须原样复制。',
    search: (keyword, options) => searchYouTube(keyword, { ...options, ...fixed }),
  }))
}
