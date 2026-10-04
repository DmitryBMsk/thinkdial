/**
 * jev-model-router — Claude Mod (EARLY ACCESS)
 *
 * Picks the model each task runs on with TypeSafe's Jev, a System One
 * decision model: unstructured state in, a typed choice with a probability
 * distribution out.
 *
 * Jev is reached one of two ways, whichever key is configured: TypeSafe's
 * own API (`typesafeApiKey`), which reports a calibrated confidence per
 * answer, or the Vercel AI Gateway (`gatewayApiKey`), which does not. With
 * neither, the engine's own `$.model.classify` stands in, so the mod is
 * useful without any account.
 *
 * Four things it can set, each on its own switch:
 *   agent.spawn  — the model of each subagent (on by default)
 *   turn.step    — the reasoning effort of each Claude subagent (on by default)
 *   turn.step    — the reasoning effort of the main loop (on by default)
 *   turn.step    — the model of the main loop (off by default: switching
 *                  models mid-session invalidates the prompt cache, which can
 *                  cost more than the cheaper tier saves)
 *
 * Every one of them moves in both directions: a task the decision model reads
 * as mechanical is routed down, one it reads as hard is routed up. The two
 * mistakes do not cost the same, so they do not clear the same confidence bar
 * (see `minUpgradeConfidence` / `minDowngradeConfidence` in policy.ts).
 *
 * The Agent tool has no effort parameter; a subagent's first turn.step sets it.
 *
 * The prompt is classified at `prompt.submit`, which runs before the turn
 * starts, and the decision is applied at the turn's first request.
 *
 * Every failure path is fail-open: a classification that errors or runs past
 * the latency budget leaves the request exactly as the engine built it.
 *
 * The API key comes from the plugin's options (userConfig "typesafeApiKey"
 * or "gatewayApiKey"). Never hardcode it in this file.
 *
 * Needs CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 (Claude Code >= 2.1.259). Typed
 * against Anthropic's declarations: https://github.com/anthropics/claude-code/tree/main/mods
 *
 * Privacy: with a key set, the prompt text is sent to whichever backend the
 * key belongs to.
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  definitionDirs,
  definitionMatches,
  definitionModel,
  definitionEffort,
  pluginAgentDirs,
  describeDecision,
  describeSetup,
  codexFlags,
  describeStatus,
  gateMainModel,
  rankOf,
  endpoint,
  pendingDecisions,
  readDecision,
  selectProvider,
  requestBody,
  requestHeaders,
  requestModelId,
  route,
  EFFORT_ORDER,
  TIER_ORDER,
  bareCommand,
} from './policy.ts'
import type { Decision, Effort, PolicyConfig, Provider, Tier } from './policy.ts'

export const register: Register = (on, options) => {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback

  // TypeSafe's own API is preferred when both keys are set: it is the only
  // one that reports a calibrated confidence, which the policy's threshold
  // reads. `provider` forces one, including "builtin" to use neither.
  const typesafeKey = text('typesafeApiKey', '')
  const gatewayKey = text('gatewayApiKey', '')
  const forced = text('provider', 'auto')
  const active: Provider | null = selectProvider(forced, typesafeKey, gatewayKey)

  // Each backend keeps its own URL and model, so an override written for one
  // can never be sent to the other when `auto` picks differently than expected.
  const apiKey = active === 'typesafe' ? typesafeKey : active === 'gateway' ? gatewayKey : ''
  const modelId = !active
    ? ''
    : active === 'typesafe'
      ? text('typesafeModel', DEFAULT_MODEL.typesafe)
      : text('gatewayModel', DEFAULT_MODEL.gateway)
  const url = !active
    ? ''
    : active === 'typesafe'
      ? endpoint('typesafe', text('typesafeBaseUrl', DEFAULT_BASE_URL.typesafe))
      : endpoint('gateway', text('gatewayBaseUrl', DEFAULT_BASE_URL.gateway))

  // A backend named in the options but missing its key degrades to the
  // built-in classifier, which is silent; say so once, when a hook first runs.
  let unusableReported = forced === 'auto' || forced === 'builtin' || active !== null

  const timeoutMs = number('timeoutMs', 800)
  const routeSubagentModel = flag('routeSubagentModel', true)
  const routeSubagentEffort = flag('routeSubagentEffort', true)
  // A spawn of the Codex rescue agent gets `--model` / `--effort` for Codex
  // itself from the same decision; the agent forwards them. Its own model is
  // left alone: it only relays, so a bigger one would be money for nothing.
  const routeCodexDelegation = flag('routeCodexDelegation', true)
  const codexAgentTypes = text('codexAgentTypes', 'codex:codex-rescue').split(',').map((type) => type.trim())
  const codexLadder: Record<Tier, string> = {
    fast: text('codexFastModel', 'gpt-6-luna'),
    balanced: text('codexBalancedModel', 'gpt-6-sol'),
    deep: text('codexDeepModel', 'gpt-6-sol'),
  }
  const routeMainEffort = flag('routeMainEffort', true)
  const routeMainModel = flag('routeMainModel', false)
  // Above this many context tokens a main-loop model switch likely costs more
  // than it saves (a heuristic, see gateMainModel); only a return to the
  // starting model, a floor raise or a risk-forced switch passes.
  const mainModelMaxContextTokens = number('mainModelMaxContextTokens', 80_000)
  const routeMainLoop = routeMainEffort || routeMainModel
  const logDecisions = flag('logDecisions', true)
  // The debug log exists only under --debug, so an interactive session leaves
  // no trace of what was routed. This one does: one JSONL file per session in
  // `decisionLogDir` (default ~/.claude/jev-router), one line per decision.
  // `$.fs` has no append, so writes are chained and the file is rewritten
  // whole; a session is the only writer of its own file.
  const decisionLog: DecisionLog = {
    enabled: flag('decisionLog', true),
    dir: text('decisionLogDir', ''),
    queue: Promise.resolve(),
  }

  const policy: PolicyConfig = {
    tiers: {
      fast: text('fastModel', 'haiku'),
      balanced: text('balancedModel', 'sonnet'),
      deep: text('deepModel', 'opus'),
    },
    minUpgradeConfidence: number('minUpgradeConfidence', 0.3),
    minDowngradeConfidence: number('minDowngradeConfidence', 0.6),
  }
  // The main loop answers the person directly and carries the whole session,
  // so its model has a floor and a stricter bar to go down; subagents keep
  // the ordinary policy, haiku included. Effort is routed on `policy`'s bars.
  const mainFloor = text('mainModelFloor', 'balanced')
  const effortOption = (key: string): Effort | undefined => {
    const value = text(key, '')
    return (EFFORT_ORDER as readonly string[]).includes(value) ? (value as Effort) : undefined
  }
  const mainPolicy: PolicyConfig = {
    ...policy,
    routeModel: routeMainModel,
    modelFloor: (TIER_ORDER as readonly string[]).includes(mainFloor) ? (mainFloor as Tier) : undefined,
    minModelDowngradeConfidence: number('mainMinModelDowngradeConfidence', 0.9),
    effortFloor: effortOption('mainEffortFloor'),
    balancedEffortFloor: effortOption('mainBalancedEffortFloor'),
    effortCeiling: effortOption('mainEffortCeiling'),
  }
  const subagentEffortPolicy: PolicyConfig = { ...mainPolicy, routeModel: false }
  const subagentEffort = new Map<string, { decision: Decision | null; pinned: Effort | null; agentType: string }>()
  const subagentApplied = new Map<string, Effort | null>()
  const inFlightSpawns = new Set<Promise<unknown>>()

  // The classification waiting for the turn that reads its prompt, and what
  // the current turn settled on. Both are single slots: main-loop turns run
  // one at a time, so nothing accumulates over a long session. `pending`
  // reports no decision when two prompts are waiting at once, rather than
  // routing a turn on a decision made for a different prompt.
  const pending = pendingDecisions()
  // Said once, the first time a hook runs. A router that loaded and one that
  // never loaded are otherwise told apart only by the absence of later lines,
  // and absence is not evidence: the policy leaves most turns alone anyway.
  let announced = false
  let appliedTurnId: string | undefined
  let applied: { model?: string; effort?: Effort } | null = null
  // The main loop's model at its first routed turn, before any rewrite: the
  // one a late switch may still return to. Kept in `$.store` by session id,
  // since a resume or a reload starts this module over on whatever model the
  // last turn was switched to.
  let baseModel: string | undefined

  on('prompt.submit', async ($, e, next) => {
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[jev-model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              subagentEffort: routeSubagentEffort,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }
    if (!routeMainLoop) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[jev-model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    // A slash command alone gives the decision model only the command's name.
    // Its turn keeps the session's model and effort; the null put keeps a
    // previous prompt's decision from reaching it.
    if (bareCommand(e.text)) {
      if (logDecisions) $.ui.log('[jev-model-router] a command with nothing after it; leaving the turn alone')
      pending.put(null)
      return next(e)
    }

    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(active, { prompt: e.text }, modelId),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[jev-model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[jev-model-router] classification passed ${timeoutMs}ms; leaving the turn alone`)
      } catch (error) {
        $.ui.log(`[jev-model-router] classification failed: ${String(error)}`)
      }
    } else {
      // No backend: the engine's own small-model classifier answers the same
      // question, without the confidence the policy's threshold reads.
      try {
        const label = await $.model.classify(e.text, TIER_ORDER)
        if (label) {
          decision = {
            tier: label as Tier,
            confidence: null,
            risky: null,
            effort: null,
            effortConfidence: null,
          }
        }
      } catch (error) {
        $.ui.log(`[jev-model-router] built-in classifier failed: ${String(error)}`)
      }
    }

    // What the decision model actually answered, whatever the policy then
    // does with it. This is the line that proves the classification ran.
    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`[jev-model-router] jev: ${describeDecision(decision, ms)}`)
    }

    pending.put(decision)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      if (!routeSubagentEffort) return yield* next(e)
      let effort: Effort | null = null
      try {
        if (subagentApplied.has(e.agentId)) {
          effort = subagentApplied.get(e.agentId) ?? null
        } else {
          if (!subagentEffort.has(e.agentId) && inFlightSpawns.size) {
            await Promise.race([Promise.allSettled([...inFlightSpawns]), $.clock.sleep(timeoutMs)])
          }
          const spawn = subagentEffort.get(e.agentId)
          if (spawn) {
            const routing = spawn.pinned
              ? { effort: null, reason: `effort pinned by definition (${spawn.pinned})` }
              : route(spawn.decision, { model: e.model, effort: e.effort }, subagentEffortPolicy)
            effort = routing.effort
            record($, decisionLog, {
              event: 'subagent', agentType: spawn.agentType, ...spawn.decision,
              from: { model: e.model, effort: e.effort },
              applied: effort ? { effort } : null, reason: routing.reason,
            })
            if (logDecisions) $.ui.log(
              `[jev-model-router] ${spawn.agentType}${effort ? ` → effort ${effort}` : ''}: ${routing.reason}`,
            )
            subagentApplied.set(e.agentId, effort)
            subagentEffort.delete(e.agentId)
          }
        }
      } catch (error) {
        effort = null
        try {
          $.ui.log(`[jev-model-router] subagent effort routing failed: ${String(error)}`)
        } catch {
          // A failed diagnostic must not block the agent's request.
        }
      }
      return yield* next(effort ? { ...e, effort } : e)
    }
    if (!routeMainLoop) return yield* next(e)

    // Every request after the first reuses what the turn settled on, so
    // neither the model nor the effort changes under its own tool loop.
    if (e.index > 0 && e.turnId === appliedTurnId) {
      return yield* next(applied ? { ...e, ...applied } : e)
    }

    baseModel ??= await startingModel($, e.model)
    const decision = pending.take()
    const routing = route(decision, { model: e.model, effort: e.effort }, mainPolicy)
    const change: { model?: string; effort?: Effort } = {}
    let held: string | undefined
    // The main loop's `model` is sent to the API as written, so an alias
    // becomes its id here; a subagent's (agent.spawn) may stay an alias.
    if (routeMainModel && routing.model) {
      let contextTokens: number | undefined
      try {
        contextTokens = (await $.session.usage()).context.tokens
      } catch {
        // No reading: gate on nothing rather than block the turn.
      }
      // A loop already below its floor (switched there before the floor
      // existed) is raised whatever the context: the floor is about quality.
      const current = rankOf(e.model, policy.tiers)
      const floor = mainPolicy.modelFloor ? TIER_ORDER.indexOf(mainPolicy.modelFloor) : 0
      if (current !== null && current < floor) contextTokens = undefined
      // Risk forcing the deep tier is not a cost question; the limit is.
      if (routing.forced) contextTokens = undefined
      const gated = gateMainModel(requestModelId(routing.model), contextTokens, mainModelMaxContextTokens, baseModel)
      if (gated.model && gated.model !== e.model) change.model = gated.model
      held = gated.reason
    }
    if (routeMainEffort && routing.effort) change.effort = routing.effort

    appliedTurnId = e.turnId
    applied = Object.keys(change).length > 0 ? change : null
    // A row in the transcript scrolls away; this line stays on screen.
    if (logDecisions) $.ui.status(describeStatus(decision, applied))
    record($, decisionLog, { event: 'main', ...decision, from: { model: e.model, effort: e.effort }, applied, reason: held ? `${routing.reason}; ${held}` : routing.reason })

    if (!applied) {
      // A turn left alone is the common case, and it used to be silent, which
      // made a working mod look like one that never loaded. Say what happened.
      if (logDecisions) {
        const suppressed = held ? ` (${held})` : routing.model && !routeMainModel ? ' (main-loop model routing off)' : ''
        $.ui.log(`[jev-model-router] main loop: ${routing.reason}${suppressed}`)
      }
      return yield* next(e)
    }
    if (logDecisions) {
      const what = [change.model, change.effort && `effort ${change.effort}`]
        .filter(Boolean)
        .join(', ')
      $.ui.log(`[jev-model-router] main loop → ${what}: ${routing.reason}`)
    }
    return yield* next({ ...e, ...change })
  })

  on('agent.spawn', async ($, e, next) => {
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[jev-model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              subagentEffort: routeSubagentEffort,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }

    // A fork inherits its parent's model; `model` is ignored for it.
    const codexType = codexAgentTypes.includes(e.subagentType)
    const codexSpawn = routeCodexDelegation && codexType
    const effortEnabled = routeSubagentEffort && !codexType
    if ((!routeSubagentModel && !effortEnabled && !codexSpawn) || e.fork) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[jev-model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(
              active,
              { prompt: e.prompt, description: e.description, agentType: e.subagentType },
              modelId,
            ),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[jev-model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[jev-model-router] classification passed ${timeoutMs}ms; leaving the subagent alone`)
      } catch (error) {
        $.ui.log(`[jev-model-router] classification failed: ${String(error)}`)
      }
    } else {
      try {
        const label = await $.model.classify(e.prompt, TIER_ORDER)
        if (label) {
          decision = {
            tier: label as Tier,
            confidence: null,
            risky: null,
            effort: null,
            effortConfidence: null,
          }
        }
      } catch (error) {
        $.ui.log(`[jev-model-router] built-in classifier failed: ${String(error)}`)
      }
    }

    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`[jev-model-router] jev (${e.subagentType}): ${describeDecision(decision, ms)}`)
    }

    // What the subagent would run on untouched: the model the caller named,
    // else the one its definition pins, else the parent's. That is what a
    // change is measured from. Effort pinned by a definition is kept.
    const definition = e.model && !effortEnabled ? null : await definedAgent($, e.subagentType)
    const defined = definition?.model ?? null
    const current = e.model ?? defined ?? e.parentModel
    const source = e.model ? 'call' : defined ? 'definition' : 'parent'
    const routed = codexSpawn || !routeSubagentModel ? null : route(decision, { model: current }, policy)
    const model = routed?.model ?? null
    const codex = codexSpawn ? codexFlags(decision, e.prompt, codexLadder) : null
    const reason = codexSpawn
      ? codex
        ? `codex ${codex.model}/${codex.effort} (${decision?.tier ?? 'no decision, default'})`
        : 'codex flags already in the prompt'
      : (routed?.reason ?? 'no decision')
    const applied = model || codex ? { ...(model ? { model } : {}), ...(codex ? { codex } : {}) } : null
    if (codexSpawn || model || !effortEnabled) {
      record($, decisionLog, { event: 'subagent', agentType: e.subagentType, ...decision, from: { model: current, source }, applied, reason })
    }
    if (!applied) {
      if (logDecisions && !effortEnabled) $.ui.log(`[jev-model-router] ${e.subagentType}: ${reason}`)
    } else if (logDecisions) {
      $.ui.log(`[jev-model-router] ${e.subagentType} → ${[model, codex && `codex ${codex.model}/${codex.effort}`].filter(Boolean).join(', ')}: ${reason}`)
    }
    const changed = {
      ...e,
      ...(model ? { model } : {}),
      ...(codex ? { prompt: `--model ${codex.model} --effort ${codex.effort} ${e.prompt}` } : {}),
    }
    if (!effortEnabled) return next(applied ? changed : e)
    const startedPromise = next(changed).then((started) => {
      if (started.agentId) subagentEffort.set(started.agentId, {
        decision, pinned: definition?.effort ?? null, agentType: e.subagentType,
      })
      return started
    })
    inFlightSpawns.add(startedPromise)
    try {
      return await startedPromise
    } finally {
      inFlightSpawns.delete(startedPromise)
    }
  })
}

// The debug log exists only under --debug, so an interactive session leaves
// no trace of what was routed. This one does: one JSONL file per session in
// `decisionLogDir` (default ~/.claude/jev-router), one line per decision.
// `$.fs` has no append, so writes are chained and the file is rewritten
// whole; a session is the only writer of its own file.
type DecisionLog = { enabled: boolean; dir: string; queue: Promise<void>; path?: string }
type Engine = EngineInterface

// An agent type's definition pins these values, or leaves them unset. Answers
// are cached for a minute per type, so a burst of spawns scans folders once.
const DEFINITION_TTL_MS = 60_000
type AgentDefinition = { model: string | null; effort: Effort | null }
const definitionCache = new Map<string, AgentDefinition & { at: number }>()

async function definedAgent($: Engine, subagentType: string): Promise<AgentDefinition> {
  const now = await $.clock.now()
  const cached = definitionCache.get(subagentType)
  if (cached && now - cached.at < DEFINITION_TTL_MS) return cached
  const definition: AgentDefinition = { model: null, effort: null }
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const pluginDirs: string[] = []
    const colon = subagentType.indexOf(':')
    if (colon > 0) {
      const registry = `${home}/.claude/plugins/installed_plugins.json`
      if (await $.fs.exists(registry)) {
        const plugins = JSON.parse(await $.fs.read(registry)).plugins ?? {}
        const prefix = `${subagentType.slice(0, colon)}@`
        const installs = Object.entries(plugins)
          .filter(([key]) => key.startsWith(prefix))
          .flatMap(([, entries]) => (entries as { installPath?: string }[]).map((entry) => entry.installPath ?? ''))
          .filter(Boolean)
        for (const install of installs) {
          let manifest: unknown = {}
          try {
            const manifestPath = `${install}/.claude-plugin/plugin.json`
            if (await $.fs.exists(manifestPath)) manifest = JSON.parse(await $.fs.read(manifestPath))
          } catch {
            // An unreadable manifest still leaves the default agents/ folder.
          }
          pluginDirs.push(...pluginAgentDirs(install, manifest))
        }
      }
    }
    const { agent, dirs } = definitionDirs(subagentType, await $.session.root(), home, pluginDirs)
    const budget = { reads: DEFINITION_READ_BUDGET }
    for (const dir of dirs) {
      const found = await findDefinition($, dir, agent, budget)
      if (found !== undefined) {
        definition.model = definitionModel(found)
        definition.effort = definitionEffort(found)
        break
      }
    }
  } catch (error) {
    $.ui.log(`[jev-model-router] reading the ${subagentType} definition failed: ${String(error)}`)
  }
  definitionCache.set(subagentType, { ...definition, at: now })
  return definition
}

// The text of the definition in `dir` (or up to two folders below it) that
// defines `agent`, else undefined. In each folder the file named after the
// agent is tried first, the common case. A file or folder that cannot be read
// is skipped, not fatal. `budget` caps the files read across one lookup.
const DEFINITION_READ_BUDGET = 300

async function findDefinition(
  $: Engine,
  dir: string,
  agent: string,
  budget: { reads: number },
  depth = 0,
): Promise<string | undefined> {
  const read = async (path: string): Promise<string | undefined> => {
    if (budget.reads <= 0) return undefined
    budget.reads--
    try {
      return await $.fs.read(path)
    } catch {
      return undefined
    }
  }
  let entries: Awaited<ReturnType<Engine['fs']['list']>>
  try {
    if (!(await $.fs.exists(dir))) return undefined
    entries = await $.fs.list(dir)
  } catch {
    return undefined
  }
  const guess = `${agent}.md`
  const files = entries.filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md'))
  for (const entry of [...files.filter((f) => f.name === guess), ...files.filter((f) => f.name !== guess)]) {
    const text = await read(`${dir}/${entry.name}`)
    if (text !== undefined && definitionMatches(text, entry.name, agent)) return text
  }
  if (depth >= 2) return undefined
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const found = await findDefinition($, `${dir}/${entry.name}`, agent, budget, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

// The session's starting model from `$.store`, recorded on first sight, one
// key per session so two sessions starting at once cannot overwrite each
// other. Entries unused for 30 days are dropped; each is re-read just before
// deletion, so only a session idle that long and resuming in the same instant
// could lose its entry. A map under the old shared key is still read, never
// written. Any failure answers `current`.
const STARTING_MODEL_PREFIX = 'start:'
const STARTING_MODEL_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LEGACY_STARTING_MODELS = 'startingModels'
type StartingModel = { model: string; at: number }

function readStarting(value: unknown): StartingModel | null {
  if (typeof value === 'string') return { model: value, at: 0 }
  const entry = value as Partial<StartingModel> | null
  return entry && typeof entry.model === 'string' ? { model: entry.model, at: Number(entry.at) || 0 } : null
}

async function startingModel($: Engine, current: string): Promise<string> {
  try {
    const now = await $.clock.now()
    const sessionId = await $.session.id()
    const key = `${STARTING_MODEL_PREFIX}${sessionId}`
    const legacy = ((await $.store.get(LEGACY_STARTING_MODELS)) ?? {}) as Record<string, string>
    const start = readStarting(await $.store.get(key))?.model ?? legacy[sessionId] ?? current
    await $.store.set(key, { model: start, at: now } satisfies StartingModel)
    for (const other of await $.store.keys()) {
      if (other === key || !other.startsWith(STARTING_MODEL_PREFIX)) continue
      const entry = readStarting(await $.store.get(other))
      if (entry && entry.at > 0 && now - entry.at > STARTING_MODEL_TTL_MS) await $.store.delete(other)
    }
    return start
  } catch (error) {
    $.ui.log(`[jev-model-router] starting model not stored: ${String(error)}`)
  }
  return current
}

function record($: Engine, log: DecisionLog, entry: Record<string, unknown>): void {
  if (!log.enabled) return
  const ts = new Date().toISOString()
  log.queue = log.queue
    .then(async () => {
      if (!log.path) {
        const dir = log.dir || `${(await $.env.get('HOME')) ?? '.'}/.claude/jev-router`
        log.path = `${dir}/${await $.session.id()}.jsonl`
      }
      const previous = (await $.fs.exists(log.path)) ? await $.fs.read(log.path) : ''
      await $.fs.write(log.path, `${previous}${JSON.stringify({ ts, ...entry })}\n`)
    })
    .catch((error) => $.ui.log(`[jev-model-router] decision log failed: ${String(error)}`))
}
