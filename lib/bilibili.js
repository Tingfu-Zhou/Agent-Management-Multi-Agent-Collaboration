/**
 * DSH 插件入口：给「B 站检索 Agent」注册它唯一的工具 bilibili_search。
 *
 * 挂在 cordis.patch.yml 里 video-scout-bilibili 这个预设下面，所以只有那个子 Agent 看得到它。
 * 可选配置（都可以不填）：
 *   cookie   登录后的 B 站 Cookie，降低风控概率；不填则读环境变量 BILIBILI_COOKIE，再没有就匿名检索
 *   apiBase  API 根地址，仅测试用（指向本地假服务）
 */
import { searchBilibili } from './sources/bilibili.js'
import { createSearchTool } from './search-tool.js'

export const name = 'video-scout-bilibili'
export const inject = ['tools']

export function apply(ctx, config) {
  const cookie = config?.cookie || undefined
  const apiBase = config?.apiBase || process.env.VIDEO_SCOUT_BILIBILI_API || undefined
  ctx.tools.register(createSearchTool(ctx, {
    name: 'bilibili_search',
    platform: 'bilibili',
    description:
      '在哔哩哔哩（B 站）按关键词检索视频，返回标题、链接、UP 主、播放量、弹幕数、时长、发布日期和简介。'
      + '结果里的链接是真实可打开的，引用时必须原样复制。',
    search: (keyword, options) => searchBilibili(keyword, { ...options, cookie, apiBase }),
  }))
}
