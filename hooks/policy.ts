/**
 * jev-model-router — pure decision logic.
 *
 * No `$` and no I/O here: this module only builds the request the decision
 * API takes, reads its answer, and turns that answer into a model id. The
 * hooks module does every call on `$` at its own call site.
 *
 * Two backends speak to the same model with different wire shapes:
 *
 *   typesafe  POST https://api.typesafe.ai/v1/systemone
 *             `{ model, state, questions }`; a yes/no question is a `noul`
 *             and every answer carries its own `confidence`.
 *   gateway   POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model
 *             `{ state, questions }` with the model in a header; a yes/no
 *             question is a `boolean`, and there is no `confidence` field —
 *             it has to be derived from an optional distribution.
 *
 * The Gateway shape is not documented publicly; it was read from
 * @ai-sdk/gateway and @ai-sdk/provider.
 */

export type Provider = 'typesafe' | 'gateway'

export type Tier = 'fast' | 'balanced' | 'deep'

export interface Tiers {
  fast: string
  balanced: string
  deep: string
}

export interface Decision {
  tier: Tier
  /** Confidence in the tier, or null when the backend reported none. */
  confidence: number | null
  /** P(true) that carrying the task out would itself be costly or final. */
  risky: number | null
  /** 0..3 along the effort rubric, or null when absent. */
  effort: number | null
  /** Confidence in the effort, or null when the backend reported none. */
  effortConfidence: number | null
}

/** The reasoning levels a turn can ask for, cheapest first. */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const

export type RoutedEffort = (typeof EFFORT_ORDER)[number]
export type Effort = RoutedEffort | 'max'

export const TIER_ORDER: readonly Tier[] = ['fast', 'balanced', 'deep']

/**
 * How each tier is described to the decision model. Deliberately about the
 * shape of the work, not about model names: the model never sees an id.
 */
const TIER_CRITERIA: Record<Tier, string> = {
  fast: 'Mechanical and local: read or summarise a file, run one command, rename a symbol, answer something already in context.',
  balanced:
    'Ordinary engineering: implement a well-specified change across a few files, write tests, fix a clearly described bug, review a small diff.',
  deep: 'Hard or high-stakes: architecture and design, debugging a failure whose cause is unknown, security, data migrations, concurrency, anything touching production or money.',
}

const EFFORT_RUBRIC = ['almost none', 'some', 'a lot', 'as much as possible'] as const

export const DEFAULT_BASE_URL: Record<Provider, string> = {
  typesafe: 'https://api.typesafe.ai',
  gateway: 'https://ai-gateway.vercel.sh/v4/ai',
}

/**
 * The Gateway's own protocol version, sent as `ai-gateway-protocol-version`.
 * Tracks the `AI_GATEWAY_PROTOCOL_VERSION` of `@ai-sdk/gateway` (4.0.87).
 */
const AI_GATEWAY_PROTOCOL_VERSION = '0.0.1'

export const DEFAULT_MODEL: Record<Provider, string> = {
  typesafe: 'jev-latest',
  gateway: 'typesafe-ai/jev',
}

/**
 * Which backend a configuration asks for, or null for the built-in
 * classifier. `auto` prefers TypeSafe, since it is the only one that reports
 * a calibrated confidence; a forced backend whose key is missing resolves to
 * null rather than falling through to the other one's key.
 */
export function selectProvider(
  forced: string,
  typesafeKey: string,
  gatewayKey: string,
): Provider | null {
  if (forced === 'builtin') return null
  if (forced === 'typesafe') return typesafeKey ? 'typesafe' : null
  if (forced === 'gateway') return gatewayKey ? 'gateway' : null
  if (typesafeKey) return 'typesafe'
  if (gatewayKey) return 'gateway'
  return null
}

/** The full endpoint a backend posts to. */
export function endpoint(provider: Provider, baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return provider === 'typesafe' ? `${root}/v1/systemone` : `${root}/evaluation-model`
}

/** The `questions` map, in the shape the backend's schema names. */
export function questions(provider: Provider): Record<string, unknown> {
  return {
    tier: {
      type: 'choice',
      instructions: 'Which is the cheapest tier that can complete this coding task well?',
      criteria: TIER_CRITERIA,
    },
    effort: {
      type: 'score',
      instructions: 'How much step-by-step reasoning does this task need?',
      criteria: EFFORT_RUBRIC,
    },
    risky: {
      // The same question under two names: `noul` on TypeSafe's own API,
      // `boolean` in the AI SDK's evaluation schema.
      type: provider === 'typesafe' ? 'noul' : 'boolean',
      // Asked about the act, not the subject. The first wording ("the task
      // touches production, money, credentials") scored 0.96 on "add a
      // refund endpoint that calls Stripe" — ordinary code that happens to be
      // about money — and would have escalated it past a 0.98-confidence
      // answer of the balanced tier.
      instructions:
        'Carrying out this task would itself change production, move real money, or alter data that cannot be restored. Writing or testing code that deals with such things, without running it against the real system, does not count.',
    },
  }
}

/** The request body. The Gateway carries the model in a header instead. */
export function requestBody(
  provider: Provider,
  state: Record<string, unknown>,
  model: string,
): string {
  const body =
    provider === 'typesafe'
      ? { model, state, questions: questions(provider) }
      : { state, questions: questions(provider) }
  return JSON.stringify(body)
}

/** The request headers. */
export function requestHeaders(
  provider: Provider,
  apiKey: string,
  model: string,
): Record<string, string> {
  const common = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  if (provider === 'typesafe') return common
  return {
    ...common,
    'ai-gateway-auth-method': 'api-key',
    'ai-model-id': model,
    // The Gateway rejects any request that does not name the protocol it
    // speaks: 400 "Unsupported gateway protocol version". Every other header
    // here is accepted without it, so the omission fails the whole backend.
    'ai-gateway-protocol-version': AI_GATEWAY_PROTOCOL_VERSION,
    'ai-evaluation-model-specification-version': '4',
  }
}

function isTier(value: unknown): value is Tier {
  return value === 'fast' || value === 'balanced' || value === 'deep'
}

/**
 * Reads a response from either backend.
 *
 * TypeSafe's own API reports a `confidence` per answer and a `noul` number
 * for a yes/no question. The Gateway reports neither: confidence has to come
 * from the highest probability of a distribution that is itself optional, and
 * a yes/no answer arrives as `probability`. Both are handled, and a missing
 * confidence reads as null rather than as a number the policy would trust.
 */
export function readDecision(responseText: string): Decision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return null
  }
  const answers = (parsed as { answers?: Record<string, Record<string, unknown>> }).answers
  if (!answers) return null

  const tierAnswer = answers.tier
  if (!tierAnswer || !isTier(tierAnswer.choice)) return null

  const effortAnswer = answers.effort
  const riskyAnswer = answers.risky
  const risky =
    typeof riskyAnswer?.noul === 'number'
      ? riskyAnswer.noul
      : typeof riskyAnswer?.probability === 'number'
        ? riskyAnswer.probability
        : null

  return {
    tier: tierAnswer.choice,
    confidence: confidenceOf(tierAnswer),
    effort: typeof effortAnswer?.score === 'number' ? effortAnswer.score : null,
    effortConfidence: effortAnswer ? confidenceOf(effortAnswer) : null,
    risky,
  }
}

/**
 * How sure an answer is. TypeSafe reports it; the Gateway does not, so there
 * it is the highest probability of a distribution that is itself optional.
 */
function confidenceOf(answer: Record<string, unknown>): number | null {
  if (typeof answer.confidence === 'number') return answer.confidence
  const probabilities = answer.probabilities as Record<string, number> | undefined
  const values = probabilities ? Object.values(probabilities) : []
  return values.length > 0 ? Math.max(...values) : null
}

/** The rubric score (0..3) as a reasoning level. */
export function effortLevel(score: number): RoutedEffort {
  const index = Math.min(EFFORT_ORDER.length - 1, Math.max(0, Math.round(score)))
  return EFFORT_ORDER[index]!
}

/**
 * Where a reasoning level sits on the ladder, or null when its place cannot
 * be known. `max` is above every rung the rubric can produce, so it ranks
 * above them without joining EFFORT_ORDER, which is also the set of values
 * this router is allowed to ask for.
 */
export function effortRank(effort: string | number | undefined): number | null {
  if (typeof effort !== 'string') return null
  if (effort === 'max') return EFFORT_ORDER.length
  const index = EFFORT_ORDER.findIndex((level) => level === effort)
  return index === -1 ? null : index
}

/**
 * Where a model id sits on the tier ladder, by matching it against the
 * configured tier names first and then the family words. Null when it matches
 * none, in which case the change is treated as an upgrade rather than guessed
 * at: an unrecognised id gets the gentler threshold, never the strict one.
 */
export function rankOf(model: string, tiers: Tiers): number | null {
  const lowered = model.toLowerCase()
  for (let index = 0; index < TIER_ORDER.length; index++) {
    const tier = TIER_ORDER[index] as Tier
    const configured = tiers[tier].toLowerCase()
    if (configured && lowered.includes(configured)) return index
  }
  if (lowered.includes('haiku')) return 0
  if (lowered.includes('sonnet')) return 1
  if (lowered.includes('opus')) return 2
  return null
}

/** Recheck the effort ceiling against the model on this request. */
export function effortForModel(effort: Effort | undefined, model: string, config: PolicyConfig): Effort | null {
  if (effort === undefined) return null
  const ceiling = config.effortCeiling
  if (ceiling && rankOf(model, config.tiers) !== TIER_ORDER.indexOf('deep') && effortRank(effort)! > effortRank(ceiling)!) {
    return ceiling
  }
  return effort
}

/**
 * The full id a family alias names on the main loop.
 *
 * `agent.spawn` takes an alias (`haiku`) the way the Agent tool does, but
 * `turn.step`'s `model` is the id the engine already resolved for the request
 * and goes to the API as written: an alias there is refused ("There's an
 * issue with the selected model (haiku)"). So the tiers stay aliases in the
 * options, and only a main-loop rewrite resolves them, here.
 *
 * A stale entry here is a silent downgrade: `opus` sat on `claude-opus-5`
 * (Opus 5, not 5.5) for the whole time Opus 5.5 was current, so every
 * `routeMainModel` upgrade to `deep` landed one point release behind. Bump
 * this table whenever Anthropic ships a new point release in a family the
 * tiers use — checked each time, not guessed: `claude --restricted -p
 * --model <alias> --output-format json "OK"` names the id the engine itself
 * resolves the alias to in `modelUsage` (`--restricted` keeps this router
 * from rewriting the probe).
 * Last checked 2026-09-28, against Opus 5.5 / Sonnet 5.5 / Haiku 4.5.
 */
const ALIAS_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

/**
 * What to write into `turn.step`'s `model`: a full id as given, or the id
 * behind a family alias. Anything else is returned unchanged for the engine
 * to judge.
 */
export function requestModelId(model: string): string {
  return ALIAS_IDS[model.trim().toLowerCase()] ?? model
}

export interface PolicyConfig {
  tiers: Tiers
  /** Whether the policy may change the request's model. Defaults to true. */
  routeModel?: boolean
  /**
   * How sure the decision must be to spend more (a bigger model, more
   * reasoning). Being wrong here costs money, so the bar is low.
   */
  minUpgradeConfidence: number
  /**
   * How sure it must be to spend less. Being wrong here means a task handled
   * by too small a model or too little thought, so the bar is high.
   */
  minDowngradeConfidence: number
  /**
   * The lowest tier the model may be routed to; absent, any. Effort is not
   * floored. The main loop sets `balanced`: a turn's prompt can read as
   * mechanical ("проверь") while the work around it is not, and a haiku
   * answer there was measured wrong (2026-09-26).
   */
  modelFloor?: Tier
  /**
   * The lowest reasoning level a turn may be routed to; absent, any. Unlike
   * a moved level this is not a guess about the prompt, so a low reading is
   * lifted to it without a confidence check. A downgrade stops here.
   */
  effortFloor?: Effort
  /** A higher floor for a balanced reading; the larger of the two applies. */
  balancedEffortFloor?: Effort
  /**
   * The highest level while the loop runs below the deep tier, so xhigh and
   * max belong to opus. Like the floor it is policy: a level above it comes
   * down without a confidence check.
   */
  effortCeiling?: Effort
  /**
   * The downgrade bar for the model alone, when it should differ from
   * `minDowngradeConfidence`, which then still governs effort.
   */
  minModelDowngradeConfidence?: number
}

export interface Routing {
  /** The model to run on, or null to leave the request as it is. */
  model: string | null
  /** The classified model even when this route cannot change it. */
  wantedModel: string | null
  /** The reasoning level to ask for, or null to leave it as it is. */
  effort: Effort | null
  /** Why, for the log line. */
  reason: string
  /**
   * True when risk forced the deep tier past the thresholds. A caller's own
   * gate (the main loop's context limit) must let such a change through too:
   * risk is the one case that is not a cost question.
   */
  forced: boolean
}

const NOTHING: Routing = { model: null, wantedModel: null, effort: null, reason: 'no decision', forced: false }

/**
 * Whether a change of rank passes its threshold. Both directions are allowed;
 * they just do not have to clear the same bar, because the two mistakes do not
 * cost the same. A move whose direction cannot be told (an unrecognised
 * current value) is treated as an upgrade.
 */
function allowed(
  wanted: number,
  current: number | null,
  confidence: number | null,
  config: PolicyConfig,
  downgradeBar: number = config.minDowngradeConfidence,
): boolean {
  if (current !== null && wanted === current) return false
  const isDowngrade = current !== null && wanted < current
  const bar = isDowngrade ? downgradeBar : config.minUpgradeConfidence
  // A backend that reports no confidence (the Gateway without a distribution,
  // or the built-in classifier) clears the upgrade bar but never the
  // downgrade one: spending less on an unmeasured hunch is the bad trade.
  if (confidence === null) return !isDowngrade
  return confidence >= bar
}

/**
 * Turns a decision into a model and a reasoning level, either of which may be
 * null to leave the request as it is. Both can move in either direction.
 */
export function route(
  decision: Decision | null,
  current: { model: string; effort?: string | number },
  config: PolicyConfig,
): Routing {
  if (!decision) return NOTHING

  let tier = decision.tier
  let effortScore = decision.effort
  let forced = false

  // Carrying out something final is never worth the saving: take the deep
  // tier and real reasoning, whatever the cheaper answer said, and skip the
  // thresholds — this is the one case that is not a confidence question.
  if (decision.risky !== null && decision.risky > 0.7) {
    tier = 'deep'
    effortScore = Math.max(effortScore ?? 0, 2)
    forced = true
  }

  const floor = config.modelFloor ? TIER_ORDER.indexOf(config.modelFloor) : 0
  const wantedTier = Math.max(TIER_ORDER.indexOf(tier), floor)
  const currentTier = rankOf(current.model, config.tiers)
  const wantedModel = config.tiers[TIER_ORDER[wantedTier] as Tier]
  const modelBar = config.minModelDowngradeConfidence ?? config.minDowngradeConfidence

  const model =
    config.routeModel !== false &&
    wantedModel &&
    wantedModel !== current.model &&
    (forced || allowed(wantedTier, currentTier, decision.confidence, config, modelBar))
      ? wantedModel
      : null

  let effort: Effort | null = null
  // An absent effort means this model cannot accept the API parameter.
  if (effortScore !== null && current.effort !== undefined) {
    const currentRank = effortRank(current.effort)
    let wantedRank = EFFORT_ORDER.indexOf(effortLevel(effortScore))
    const rankOfLevel = (level: Effort | undefined, none: number) => (level ? effortRank(level) ?? none : none)
    const floorRank = Math.max(
      rankOfLevel(config.effortFloor, 0),
      tier === 'balanced' ? rankOfLevel(config.balancedEffortFloor, 0) : 0,
    )
    // An unknown model has no proof that it belongs to the deep tier.
    const runsTier = model ? wantedTier : (currentTier ?? 0)
    const ceilingRank = runsTier < TIER_ORDER.indexOf('deep') ? rankOfLevel(config.effortCeiling, Infinity) : Infinity
    const lifted = wantedRank < floorRank && currentRank !== null && currentRank < floorRank
    const capped = currentRank !== null && currentRank > ceilingRank
    wantedRank = Math.min(Math.max(wantedRank, floorRank), ceilingRank)

    // Risk raises the floor; it must never lower one. Forcing only skips the
    // thresholds, so without this clamp a task already at `xhigh` or `max`
    // and rated mechanically simple would be pulled down to `high` with no
    // confidence check at all — the opposite of what the rule is for.
    if (forced && currentRank !== null) wantedRank = Math.max(wantedRank, currentRank)

    // A numeric effort is the caller's own scale, not this ladder; leave it.
    const comparable = typeof current.effort !== 'number'
    const wanted = EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, wantedRank)]!
    if (
      comparable &&
      wantedRank !== currentRank &&
      (forced || lifted || capped || allowed(wantedRank, currentRank, decision.effortConfidence, config))
    ) {
      effort = wanted
    }
  }

  const said = decision.confidence === null ? 'confidence n/d' : `confidence ${decision.confidence.toFixed(2)}`

  if (!model && !effort) {
    // Naming what it wanted and what it kept is the whole point of this line.
    // Without it, a mod that classified and decided to leave the request alone
    // is indistinguishable from one that never loaded.
    const wantedEffort = effortScore === null ? null : effortLevel(effortScore)
    const kept = `${current.model}${current.effort === undefined ? '' : `/${current.effort}`}`
    const wanted = `${wantedModel}${wantedEffort ? `/${wantedEffort}` : ''}`
    const floored = wantedTier > TIER_ORDER.indexOf(tier) ? `, ${tier} floored to ${TIER_ORDER[wantedTier]}` : ''
    return { model: null, wantedModel, effort: null, reason: `kept ${kept}, wanted ${wanted}${floored} (${said})`, forced }
  }

  const label = wantedTier > TIER_ORDER.indexOf(tier) ? `${tier}, floored to ${TIER_ORDER[wantedTier]}` : tier
  return { model, wantedModel, effort, reason: forced ? (config.routeModel === false ? 'effort forced by risk' : `${label}, forced by risk`) : `${label} (${said})`, forced }
}

/** One Claude subagent's effort decision, including definition pins. */
export function subagentEffortRouting(
  spawn: { decision: Decision | null; pinned: Effort | null },
  current: { model: string; effort?: string | number },
  config: PolicyConfig,
  sessionEffort?: string | number,
): Pick<Routing, 'effort' | 'reason'> {
  if (spawn.pinned) return { effort: null, reason: `effort pinned by definition (${spawn.pinned})` }
  // A definition pinned to the session's level cannot be distinguished here.
  if (current.effort !== undefined && sessionEffort !== undefined && current.effort !== sessionEffort) {
    return { effort: null, reason: `effort set by agent definition (${current.effort}, session ${sessionEffort})` }
  }
  if (current.effort === undefined) return { effort: null, reason: 'model takes no effort' }
  const { effort, reason } = route(spawn.decision, current, { ...config, routeModel: false })
  return { effort, reason }
}

/**
 * Whether a prompt is a slash command and nothing else (`/simplify`). The
 * decision model sees only the name, never the skill or command it runs:
 * measured on TypeSafe (three calls each), `/simplify`, `/run` and `/github`
 * came back fast with effort 0.1 to 0.5, low effort for a multi-step skill,
 * while `/code-review` and `/security-review` came back balanced and deep.
 * With text after the name there is a task to read, and it is classified.
 * A one-segment path alone (`/etc`) matches too; nobody sends one as a task.
 */
export function bareCommand(text: string): boolean {
  return /^\/[^\s/]+$/.test(text.trim())
}

/**
 * Holds a prompt's classification until the turn that reads that prompt
 * starts.
 *
 * Nothing ties a decision to the turn it belongs to. Prompts can be queued
 * while the model is busy, a peer session's message can be delivered inside a
 * running turn, and `prompt.submit` carries no turn id at all while the
 * session is idle. So when more than one prompt is waiting, `take` reports
 * none: running a turn on another prompt's decision is a worse outcome than
 * not routing it, and not routing is what every other failure path here does.
 */
export function pendingDecisions(): {
  put(decision: Decision | null): void
  take(): Decision | null
} {
  let held: Decision | null = null
  let waiting = 0

  return {
    put(decision) {
      waiting += 1
      // Past the first, which prompt a turn will read is unknowable, so the
      // slot is emptied instead of holding a decision that may not fit.
      held = waiting === 1 ? decision : null
    },
    take() {
      const decision = waiting === 1 ? held : null
      held = null
      waiting = 0
      return decision
    },
  }
}

/** A number for the log, or `n/d` when the backend reported none. */
function reported(value: number | null): string {
  return value === null ? 'n/d' : value.toFixed(2)
}

/**
 * The one-time line that says the router is alive, which backend answers it,
 * and which routing switches are on.
 *
 * Without this, a router that loaded and a router that never loaded are told
 * apart only by the absence of later lines, which is not evidence of anything.
 */
export function describeSetup(
  provider: Provider | null,
  url: string,
  switches: { subagentModel: boolean; subagentEffort: boolean; mainEffort: boolean; mainModel: boolean },
  // `provider: "builtin"` is a choice, not a missing key. Reporting it as a
  // credential problem sends someone hunting for a key they meant to omit.
  builtinByChoice = false,
): string {
  const backend = provider
    ? `${provider} (${url})`
    : builtinByChoice
      ? 'the built-in classifier, by choice'
      : 'the built-in classifier, no key set'
  const on = [
    switches.subagentModel && 'subagent model',
    switches.subagentEffort && 'subagent effort',
    switches.mainEffort && 'main effort',
    switches.mainModel && 'main model',
  ].filter(Boolean)
  return `ready on ${backend}; routing ${on.length > 0 ? on.join(', ') : 'nothing, every switch is off'}`
}

/**
 * What the decision model answered, before any policy touches it: the raw
 * tier, effort and risk with their confidences, and how long it took.
 *
 * This is the line that shows the classification happened at all, separately
 * from whether the policy then decided to act on it.
 */
export function describeDecision(decision: Decision | null, ms: number | null): string {
  const took = ms === null ? '' : ` · ${Math.round(ms)}ms`
  if (!decision) return `no answer${took}`

  const parts = [`tier ${decision.tier} (${reported(decision.confidence)})`]
  if (decision.effort !== null) {
    parts.push(
      `effort ${decision.effort.toFixed(1)} → ${effortLevel(decision.effort)} (${reported(decision.effortConfidence)})`,
    )
  }
  if (decision.risky !== null) parts.push(`risky ${reported(decision.risky)}`)
  return parts.join(' · ') + took
}

/**
 * The persistent status line: the last thing the router did, short enough to
 * sit on screen beside the engine's own notices.
 */
export function describeStatus(
  decision: Decision | null,
  change: { model?: string; effort?: Effort } | null,
): string {
  if (!decision) return 'jev · no answer'
  const asked = `${decision.tier} ${reported(decision.confidence)}`
  if (!change) return `jev · ${asked} · unchanged`
  const to = [change.model, change.effort].filter(Boolean).join('/')
  return `jev · ${asked} → ${to}`
}

/**
 * The `model` an agent definition's frontmatter names, or null when it names
 * none or `inherit`: both leave the parent's model to decide. `agent.spawn`
 * reports only the Agent tool's `model` parameter and the parent's model, so
 * without this a definition pinned to `sonnet` is measured as if it ran on
 * the parent's `opus`, and a decision to route it up reads as a no-op.
 */
export function definitionModel(markdown: string): string | null {
  const value = frontmatterField(markdown, 'model')
  return value && value !== 'inherit' ? value : null
}

/** An agent definition's pinned reasoning effort, if it names a supported level. */
export function definitionEffort(markdown: string): Effort | null {
  const value = frontmatterField(markdown, 'effort')
  return value && effortRank(value) !== null ? (value as Effort) : null
}

/** One scalar field of a Markdown file's YAML frontmatter, unquoted; null when absent. */
function frontmatterField(markdown: string, key: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!frontmatter) return null
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter[1])
  const value = line?.[1]
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
  return value || null
}

/**
 * Whether a definition file defines `agent`. Claude Code names an agent by
 * its frontmatter `name`, not its file name (`reviewer-config.md` may define
 * `reviewer`); a file without a `name` falls back to its file name. A file
 * without frontmatter defines no agent.
 */
export function definitionMatches(markdown: string, fileName: string, agent: string): boolean {
  if (!/^---\r?\n/.test(markdown)) return false
  const name = frontmatterField(markdown, 'name')
  return name ? name === agent : fileName === `${agent}.md`
}

/**
 * The folders a plugin keeps agents in: `agents/` by default, plus each path
 * its manifest's `agents` field names (a string or a list, relative to the
 * install). Both are scanned; a name match decides, so a path that turns out
 * to replace the default rather than add to it costs only a wasted scan.
 */
export function pluginAgentDirs(installPath: string, manifest: unknown): string[] {
  const declared = (manifest as { agents?: unknown } | null)?.agents
  const extra = (Array.isArray(declared) ? declared : declared === undefined ? [] : [declared])
    .filter((path): path is string => typeof path === 'string')
    .map((path) => `${installPath}/${path.replace(/^\.\//, '').replace(/\/+$/, '')}`)
  return [`${installPath}/agents`, ...extra.filter((dir) => dir !== `${installPath}/agents`)]
}

/**
 * The agent name to match and the folders to search, most specific first: a
 * `plugin:agent` type in that plugin's agent folders, any other in the
 * project's `.claude/agents`, then the user's. The first definition that
 * matches wins, whether or not it names a model. Managed and `--agents`
 * definitions are not visible here; a miss falls back to the parent's model.
 */
export function definitionDirs(
  subagentType: string,
  projectRoot: string,
  home: string,
  pluginDirs: readonly string[],
): { agent: string; dirs: string[] } {
  const colon = subagentType.indexOf(':')
  if (colon > 0) return { agent: subagentType.slice(colon + 1), dirs: [...pluginDirs] }
  return { agent: subagentType, dirs: [`${projectRoot}/.claude/agents`, `${home}/.claude/agents`] }
}

/** A model id without its context-window suffix (`[1m]`). */
function withoutWindow(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '')
}

/**
 * Whether the main loop may move to `wanted` given how full the context is.
 *
 * A model switch forfeits the prompt cache: each model keeps its own, so the
 * new one writes the conversation to its cache before it answers (measured
 * 2026-09-26: a haiku → opus switch wrote 69k tokens and read none). Early in
 * a session that is cheap and a mechanical turn on a small model can pay for
 * it; late, the rewrite likely costs more than the smaller model saves. The
 * limit is a heuristic, not a measured break-even: that depends on prices,
 * the turns left and how warm each cache is. Above it the only move allowed
 * is back to the session's starting model, so a session that dropped to a
 * small model early is not stuck there for a hard turn later. Its cache is
 * warm only if it actually answered recently; that is not tracked.
 *
 * The starting model is matched exactly, its `[1m]` suffix aside, and then
 * sent as the starting id, so a 1M session is not cut to 200k by an alias
 * resolving to the same model. Another version of the same family is a
 * different model: it is sent as asked, and held above the limit.
 * `contextTokens` is undefined before the first response of a fresh session:
 * nothing to lose yet. A resumed one has its reading restored by the engine.
 */
export function gateMainModel(
  wanted: string,
  contextTokens: number | undefined,
  maxContextTokens: number,
  baseModel: string | undefined,
): { model: string | null; reason?: string } {
  const isBase = baseModel !== undefined && withoutWindow(wanted) === withoutWindow(baseModel)
  const model = isBase ? (baseModel as string) : wanted
  if (contextTokens === undefined || contextTokens <= maxContextTokens || isBase) return { model }
  return {
    model: null,
    reason: `held model: context ${contextTokens} > ${maxContextTokens}, only the starting model ${baseModel ?? '(unknown)'} is allowed`,
  }
}

/**
 * The `--model` / `--effort` a `codex:codex-rescue` spawn should carry, from
 * the same decision that routed the spawn itself.
 *
 * The rescue agent leaves both unset unless its prompt names them, so every
 * delegation used to run on `~/.codex/config.toml`'s default. Calibrated
 * 2026-09-27: the workhorse (sol) carries all hard work and effort carries
 * the difficulty; the top model is not used by default (the ladder's `deep`
 * rung is sol). Risk above 0.7 takes xhigh; deep takes high at the upgrade
 * bar (0.3, or with no confidence), xhigh when the effort reads xhigh, medium
 * below the bar; a balanced task whose effort reads high or more takes
 * medium; the cheap model needs the downgrade bar (0.6), a measured
 * confidence and low risk (≤ 0.4). Everything else, and no decision at all,
 * is the default: sol at low. Null — prompt left alone — only when the
 * prompt already names either flag: an explicit choice wins.
 */
export function codexFlags(
  decision: Decision | null,
  prompt: string,
  ladder: Record<Tier, string>,
): { model: string; effort: Effort } | null {
  if (/(^|\s)--(model|effort)(\s|=|$)/.test(prompt)) return null
  const fallback = { model: ladder.balanced, effort: 'low' as Effort }
  if (!decision) return fallback
  const { tier, confidence, risky } = decision
  const level = decision.effort === null ? null : effortLevel(decision.effort)
  if (risky !== null && risky > 0.7) return { model: ladder.deep, effort: 'xhigh' }
  if (tier === 'deep') {
    if (confidence === null || confidence >= 0.3) return { model: ladder.deep, effort: level === 'xhigh' ? 'xhigh' : 'high' }
    return { model: ladder.balanced, effort: 'medium' }
  }
  if (tier === 'fast' && confidence !== null && confidence >= 0.6 && (risky === null || risky <= 0.4)) {
    return { model: ladder.fast, effort: 'low' }
  }
  if (tier === 'balanced' && (level === 'high' || level === 'xhigh')) return { model: ladder.balanced, effort: 'medium' }
  return fallback
}
