/**
 * 端到端测试用的「假模型」：一个 Messages 协议兼容的本地服务（DSH 的 DeepSeek 适配器说的就是这个协议）。
 *
 * 它不是随机应答，而是照着三个 Agent 的人设「演」一遍：
 *   - 看到 bilibili_search / youtube_search 工具 → 我是检索 Agent：先调工具，拿到结果后按格式汇报；
 *   - 看到 bilibili_agent / youtube_agent 工具   → 我是管理 Agent：分派 → 等两份汇报 → 保存文档 → 交付 → 收尾。
 * 这样就能在没有 API Key 的情况下，让真实的 DSH 把「管理 → 委派 → 工具 → 通知 → 汇总」整条链路跑一遍。
 * 它验证的是插件与 DSH 的对接，不代表真实模型的表现。
 */
import http from 'node:http'

/** 把一条消息的 content（字符串或块数组）拍平成文本。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block?.type === 'text') return block.text ?? ''
      if (block?.type === 'tool_result') return textOf(block.content)
      return ''
    })
    .join('\n')
}

const toolUses = (messages) =>
  messages.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use') : []))
const toolResults = (messages) =>
  messages.flatMap((m) => (m.role === 'user' && Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []))
const userTexts = (messages) =>
  messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '')))

/** 检索 Agent：第一步调检索工具，第二步把工具结果整理成汇报。 */
function searchAgent(request, toolName, label) {
  const results = toolResults(request.messages)
  if (!results.length) {
    const task = userTexts(request.messages).join('\n')
    const keyword = task.match(/关键词[：:]\s*([^\n，。,]+)/)?.[1]?.trim() ?? 'unknown'
    return { text: `开始在 ${label} 检索「${keyword}」。`, calls: [{ name: toolName, input: { keyword, limit: 5 } }] }
  }
  const last = results.at(-1)
  const output = textOf(last.content)
  if (last.is_error) return { text: `${label} 检索失败：${output}` }
  return { text: `${label} 检索结果汇报\n\n${output}\n\n本平台首选：第 1 个，与关键词最相关。` }
}

/** 管理 Agent：按人设里的 8 个步骤往下走，走到哪一步完全由对话历史决定。 */
function managerAgent(request) {
  const messages = request.messages
  const uses = toolUses(messages)
  const texts = userTexts(messages)
  const used = (name) => uses.filter((use) => use.name === name)

  if (!used('bilibili_agent').length) {
    // 用户输入是第一条用户消息的第一个文本块（后面跟着的是 DSH 附加的运行时上下文）
    const keyword = texts[0]?.trim() ?? ''
    const prompt = (site) => `请在${site}检索视频。关键词：${keyword}\n需要 4–5 个最相关的视频，按约定格式汇报。`
    return {
      text: `收到关键词「${keyword}」，同时分派给两个检索 Agent。`,
      calls: [
        { name: 'bilibili_agent', input: { description: `B站检索：${keyword}`, prompt: prompt(' B 站') } },
        { name: 'youtube_agent', input: { description: `YouTube检索：${keyword}`, prompt: prompt(' YouTube ') } },
      ],
    }
  }

  // 子 Agent 完成后，DSH 会以用户消息的形式送来通知："Background subagent <名字或 id> finished …" + 它的最终答复
  const reported = texts.filter((t) => /^Background subagent \S+ finished/.test(t)).length
  if (reported < 2) {
    return { text: reported ? '已收到一份汇报，继续等另一个检索 Agent。' : '两个检索 Agent 已经出发，等它们汇报。' }
  }

  const saves = used('save_video_report')
  const results = toolResults(messages)
  const resultOf = (use) => results.find((r) => r.tool_use_id === use.id)
  if (!saves.length) {
    const all = texts.join('\n')
    const bili = all.match(/https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]{10}/)?.[0]
    const tube = all.match(/https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}/)?.[0]
    const keyword = used('bilibili_agent')[0].input.prompt.match(/关键词[：:]\s*([^\n]+)/)?.[1]?.trim() ?? ''
    return {
      text: '两份汇报都到齐了，各取一个最相关的，生成推荐文档。',
      calls: [{
        name: 'save_video_report',
        input: {
          keyword,
          summary: 'B 站的结果以系统的中文课程为主，YouTube 的结果讲解更直观；两边各取相关度最高的一个。',
          picks: [bili && { url: bili, reason: 'B 站检索 Agent 的首选，与关键词最相关。' }, tube && { url: tube, reason: 'YouTube 检索 Agent 的首选，讲解直观。' }].filter(Boolean),
        },
      }],
    }
  }
  const saved = resultOf(saves.at(-1))
  const savedText = textOf(saved?.content)
  const file = savedText.match(/推荐文档已保存：(.+)/)?.[1]?.trim()
  if (saved?.is_error || !file) return { text: `文档保存失败：${savedText}` }
  if (!used('present').length) return { text: '', calls: [{ name: 'present', input: { files: [{ path: file, description: '视频推荐文档' }] } }] }
  const links = [...savedText.matchAll(/^\d+\. (.+) (https:\/\/\S+)$/gm)].map((m) => `- ${m[1]}\n  ${m[2]}`)
  return { text: `推荐如下：\n${links.join('\n')}\n\n完整的推荐文档已保存：${file}` }
}

/** 默认的「大脑」：按可用工具判断自己是哪个 Agent。 */
export function videoScoutBrain(request) {
  const tools = new Set((request.tools ?? []).map((tool) => tool.name))
  if (tools.has('bilibili_search')) return searchAgent(request, 'bilibili_search', 'B 站')
  if (tools.has('youtube_search')) return searchAgent(request, 'youtube_search', 'YouTube')
  if (tools.has('bilibili_agent')) return managerAgent(request)
  return { text: '视频推荐' } // 其他请求（例如给会话起标题）随便答一句
}

/**
 * 启动假模型服务。
 * @param {(request:object) => {text?:string, calls?:{name:string, input:object}[]}} [brain]
 * @returns {Promise<{baseUrl:string, requests:object[], close:() => Promise<void>}>} baseUrl 以 /v1 结尾，交给 DEEPSEEK_BASE_URL
 */
export async function startFakeLlm(brain = videoScoutBrain) {
  const requests = []
  let counter = 0
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (request.method !== 'POST' || !new URL(request.url, 'http://localhost').pathname.endsWith('/messages')) {
      return void response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}')
    }
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return void response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"bad json"}}')
    }
    let reply
    try {
      reply = brain(body)
    } catch (error) {
      reply = { text: `fake-llm brain error: ${error.message}` }
    }
    requests.push({ at: Date.now(), body, reply })

    const blocks = []
    if (reply.text) blocks.push({ type: 'text', text: reply.text })
    for (const call of reply.calls ?? []) blocks.push({ type: 'tool_use', id: `toolu_fake_${++counter}`, name: call.name, input: call.input })
    if (!blocks.length) blocks.push({ type: 'text', text: '好的。' })
    const stopReason = reply.calls?.length ? 'tool_use' : 'end_turn'
    const usage = { input_tokens: 100, output_tokens: 50 }
    const message = { id: `msg_fake_${++counter}`, type: 'message', role: 'assistant', model: body.model ?? 'fake-model' }

    if (body.stream !== true) {
      response.writeHead(200, { 'content-type': 'application/json' })
      return void response.end(JSON.stringify({ ...message, content: blocks, stop_reason: stopReason, stop_sequence: null, usage }))
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    send({ type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } })
    blocks.forEach((block, index) => {
      if (block.type === 'text') {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
      } else {
        send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
        send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      }
      send({ type: 'content_block_stop', index })
    })
    send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
    send({ type: 'message_stop' })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}
