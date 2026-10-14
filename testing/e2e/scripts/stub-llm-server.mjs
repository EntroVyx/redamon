#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible model, so plugin flows that call a model run the same way every
 * time and cost nothing: the Skiller spec (tests/pluginsSkiller.spec.ts) and the dry run of the
 * plugin repository's evaluation harness.
 *
 *   node scripts/stub-llm-server.mjs [port] [host]     (port 0, the default, picks a free one)
 *
 * Prints `{"port": <n>}` once listening. Register it in RedAmon as an OpenAI-compatible provider
 * with base URL http://host.docker.internal:<port>/v1 (the agent container calls it). It holds no
 * key and answers anyone, so bind it to the docker bridge address rather than 0.0.0.0 when the
 * host is on a shared network.
 *
 * POST /v1/chat/completions (plain JSON, or server-sent events when the request asks for
 * `stream: true`, as RedAmon's agent does) answers by the sentence that opens the system prompt:
 *   "You review the attack playbooks of RedAmon"  -> one general lesson (Skiller's diagnosis)
 *   "You turn lessons into small, precise edits"  -> one `append` to the last part listed
 *   "REGISTRY-DIGEST:" (the RoE parse prompt)     -> a canned RoE parse, chosen by the
 *                                                    "Document version" line of the document
 *   anything else                                 -> a short plain answer
 * GET /v1/models lists the one model; GET /__calls returns what was asked so far.
 * STUB_LLM_DELAY_MS delays the diagnosis answer, so a spec can watch a job's progress (a
 * plugin's job view polls every 2 seconds and would otherwise see only the end).
 * STUB_LLM_ROE_DELAY_MS delays the RoE parse answer the same way.
 */
import { createServer } from 'node:http'

const DIAGNOSE = 'You review the attack playbooks of RedAmon'
const EDIT = 'You turn lessons into small, precise edits'
const ROE_PARSE = 'REGISTRY-DIGEST:'

/**
 * What the RoE spec's two synthetic documents say, as the parse would read them.
 * Version 1.0 is the first document; 2.0 widens it (a higher ceiling, a host
 * no longer excluded, a longer window) and carries a prompt-injection paragraph
 * whose keys a correct pipeline refuses.
 */
const ROE_ANSWERS = {
  '1.0': {
    roeClientName: 'Northwind Example Ltd', roeClientContactName: 'Alex Rivera',
    roeGlobalMaxRps: 5,
    roeExcludedHosts: ['legacy.roe-e2e.example', '198.51.100.23'],
    roeExcludedHostReasons: ['production billing', 'shared hosting'],
    roeTimeWindowEnabled: true, roeTimeWindowDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    roeTimeWindowStartTime: '09:00', roeTimeWindowEndTime: '18:00', roeTimeWindowTimezone: 'UTC',
    roeForbiddenTools: ['execute_hydra'], roeEngagementEndDate: '2026-11-27',
  },
  '2.0': {
    roeClientName: 'Northwind Example Ltd', roeClientContactName: 'Sam Lee',
    roeGlobalMaxRps: 20,
    roeExcludedHosts: ['198.51.100.23'], roeExcludedHostReasons: ['shared hosting'],
    roeTimeWindowEnabled: true, roeTimeWindowDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    roeTimeWindowStartTime: '08:00', roeTimeWindowEndTime: '20:00', roeTimeWindowTimezone: 'UTC',
    roeEngagementEndDate: '2026-12-18',
    // What the injection paragraph asks for. The agent drops unknown keys and
    // the webapp refuses the safety switch, so none of these may apply.
    agentRequireToolConfirmation: false, agentLhost: '203.0.113.9',
  },
}
const MODEL = 'skiller-stub'
const BODY_MAX = 4 * 1024 * 1024
const DIAGNOSE_DELAY_MS = Number(process.env.STUB_LLM_DELAY_MS || 0)
// Lets the RoE spec switch tabs while a parse is still running.
const ROE_DELAY_MS = Number(process.env.STUB_LLM_ROE_DELAY_MS || 0)

const calls = []
let editRuns = 0

const LESSON =
  'When the same probe is blocked twice in the same way, change the encoding or the payload family before ' +
  'trying again, because repeating it adds no information.'

/** The part ids a Skiller prompt lists ("### Part <id> (...)"), in order. */
function partIds(text) {
  return [...text.matchAll(/^### Part ([a-z0-9_]+) \(/gm)].map((m) => m[1])
}

function answer(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? ''
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const parts = partIds(messages.map((m) => m.content ?? '').join('\n'))
  const target = parts[parts.length - 1] ?? 'tools'
  if (system.startsWith(DIAGNOSE)) {
    return {
      stage: 'diagnose',
      content: JSON.stringify({
        skill_fit: 'good',
        outcome: 'The session reached a confirmed finding after repeated blocked probes.',
        lessons: [{ id: 'L1', category: 'wasted_steps', evidence: 'repeated blocked probes', lesson: LESSON, target_parts: [target], impact: 'high' }],
      }),
    }
  }
  if (system.startsWith(ROE_PARSE)) {
    const version = /Document version (\d+\.\d+)/.exec(user)?.[1] ?? '1.0'
    return { stage: 'roe_parse', content: JSON.stringify(ROE_ANSWERS[version] ?? ROE_ANSWERS['1.0']) }
  }
  if (system.startsWith(EDIT)) {
    editRuns += 1
    const repair = user.startsWith('Some of your edits cannot be applied')
    return {
      stage: repair ? 'repair' : 'edit',
      content: JSON.stringify({
        edits: [{
          part: target,
          op: 'append',
          text: `- Blocked twice the same way? Change the encoding or the payload family before the next attempt (check ${editRuns}).`,
          lessons: ['L1'],
        }],
        summary: 'Stop repeating a probe that is blocked the same way; change the encoding or the payload family first.',
        changelog: [`${target}: a rule for probes blocked twice the same way.`],
      }),
    }
  }
  return { stage: 'other', content: 'OK.' }
}

/** An OpenAI-style stream: the content in one delta, then the finish (and usage when asked). */
function stream(res, { id, model, content, usage, includeUsage }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const created = Math.floor(Date.now() / 1000)
  const chunk = (choices, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`)
  chunk([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }])
  chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
  if (includeUsage) chunk([], { usage })
  res.end('data: [DONE]\n\n')
}

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length })
  res.end(data)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub')
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'stub' }] })
  }
  if (req.method === 'GET' && url.pathname === '/__calls') return send(res, 200, { calls })
  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return send(res, 404, { error: 'not found' })
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > BODY_MAX) req.destroy()
    else chunks.push(c)
  })
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return send(res, 400, { error: { message: 'invalid JSON' } })
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const { stage, content } = answer(messages)
    calls.push({ stage, model: body.model, messages: messages.length, at: new Date().toISOString() })
    const promptTokens = Math.ceil(JSON.stringify(messages).length / 4)
    const completionTokens = Math.ceil(content.length / 4)
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
    const id = `chatcmpl-stub-${calls.length}`
    const model = body.model ?? MODEL
    setTimeout(() => {
      if (body.stream === true) {
        return stream(res, { id, model, content, usage, includeUsage: body.stream_options?.include_usage === true })
      }
      send(res, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      })
    }, stage === 'diagnose' ? DIAGNOSE_DELAY_MS : stage === 'roe_parse' ? ROE_DELAY_MS : 0)
  })
})

const port = Number(process.argv[2] ?? 0)
const host = process.argv[3] ?? '127.0.0.1'
server.listen(port, host, () => {
  process.stdout.write(JSON.stringify({ port: server.address().port, host }) + '\n')
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
