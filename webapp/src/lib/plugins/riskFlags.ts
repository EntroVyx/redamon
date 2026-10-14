import { diffLines } from './textDiff'

/**
 * A plugin proposes agent-prompt text, and per tool call the scope is enforced only by that
 * text (RV-32). These heuristics flag an added line a reviewer should look at twice: one that
 * moves data out, names a network location, or tells the agent to drop a guardrail. They are
 * advisory — the reviewer always sees the whole line — so a false positive costs only
 * attention, and the list errs toward flagging.
 */
export const RISK_FLAGS = ['exfiltration', 'url_or_host', 'guardrail_bypass'] as const
export type RiskFlag = (typeof RISK_FLAGS)[number]

export interface RiskLine {
  /** 1-based line number on the proposed (after) side. */
  line: number
  text: string
  flags: RiskFlag[]
}

// "send/post/upload/exfiltrate/leak/beacon/transmit … (the data/results/output/token/…)"
const EXFIL = /\b(exfiltrat(?:e|ing|ion)|upload|post|send|transmit|leak|beacon|ping back|phone home|dump)\b/i
const EXFIL_OBJECT = /\b(data|result|results|output|dump|loot|token|tokens|credential|credentials|secret|secrets|finding|findings|file|files|report)\b/i

const URL_OR_HOST =
  /(https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|org|net|io|dev|co|info|xyz|example|internal|local)\b)/i

const BYPASS =
  /\b(ignore|disregard|bypass|override|relax|skip|disable|turn off|without asking|do not ask|no confirmation)\b/i
const GUARD =
  /\b(scope|out[- ]of[- ]scope|guardrail|guard rail|rules of engagement|roe|confirmation|approval|consent|the user|permission)\b/i

export function lineRiskFlags(line: string): RiskFlag[] {
  const flags: RiskFlag[] = []
  if (EXFIL.test(line) && EXFIL_OBJECT.test(line)) flags.push('exfiltration')
  if (URL_OR_HOST.test(line)) flags.push('url_or_host')
  if (BYPASS.test(line) && GUARD.test(line)) flags.push('guardrail_bypass')
  return flags
}

/**
 * The risky lines a proposal ADDS over the current text. The diff isolates the insertions, so
 * a risky line already in the factory text is not blamed on the plugin. If the diff is refused
 * (too large / too different), the whole proposed text is scanned instead: better to over-flag
 * than to miss an inserted instruction.
 */
export function addedRiskLines(before: string, after: string): RiskLine[] {
  const diff = diffLines(before, after)
  const out: RiskLine[] = []
  if (diff.ok) {
    for (const op of diff.ops) {
      if (op.type !== 'insert') continue
      const flags = lineRiskFlags(op.text)
      if (flags.length) out.push({ line: op.afterLine!, text: op.text, flags })
    }
    return out
  }
  after.split(/\r\n|\r|\n/).forEach((text, i) => {
    const flags = lineRiskFlags(text)
    if (flags.length) out.push({ line: i + 1, text, flags })
  })
  return out
}
