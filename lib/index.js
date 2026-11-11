/**
 * dsh-video-scout 的包入口：导出与 DSH 无关的纯逻辑，方便脚本或测试直接调用。
 *
 * 三个 DSH 插件入口各自独立（由 cordis.patch.yml 里的预设引用）：
 *   dsh-video-scout/bilibili  → bilibili_search 工具（B 站检索 Agent 专用）
 *   dsh-video-scout/youtube   → youtube_search 工具（YouTube 检索 Agent 专用）
 *   dsh-video-scout/report    → save_video_report 工具（管理 Agent 专用）
 */
export { searchBilibili } from './sources/bilibili.js'
export { searchYouTube } from './sources/youtube.js'
export { VideoSearchError } from './sources/shared.js'
export { renderReport, resolvePicks, canonicalVideoUrl } from './report-render.js'
