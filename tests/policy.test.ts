import { expect, test } from 'bun:test'
import {
  codexFlags,
  definitionModel,
  definitionEffort,
  gateMainModel,
  definitionDirs,
  definitionMatches,
  pluginAgentDirs,
  effortLevel,
  effortRank,
  endpoint,
  questions,
  describeDecision,
  describeSetup,
  describeStatus,
  pendingDecisions,
  rankOf,
  readDecision,
  requestBody,
  requestHeaders,
  requestModelId,
  route,
  subagentEffortRouting,
  selectProvider,
  bareCommand,
} from '../hooks/policy.ts'
import type { Decision, PolicyConfig } from '../hooks/policy.ts'

const config: PolicyConfig = {
  tiers: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
}

const gatewayAnswer = (
  tier: string,
  probabilities?: Record<string, number>,
  risky = 0.01,
  effort = 1.4,
) =>
  JSON.stringify({
    answers: {
      tier: { type: 'choice', choice: tier, ...(probabilities ? { probabilities } : {}) },
      effort: { type: 'score', score: effort, probabilities: { '1': 0.9 } },
      risky: { type: 'boolean', probability: risky },
    },
    usage: { inputTokens: 120, outputTokens: 0 },
  })

/** The current state of a request, as turn.step hands it over. */
const on = (model: string, effort?: string) => ({ model, effort })

test('confidence is the highest probability, since the Gateway sends no confidence field', () => {
  const decision = readDecision(gatewayAnswer('balanced', { fast: 0.1, balanced: 0.85, deep: 0.05 }))
  expect(decision?.tier).toBe('balanced')
  expect(decision?.confidence).toBeCloseTo(0.85)
  expect(decision?.effort).toBeCloseTo(1.4)
})

test('a distribution is optional in the response schema, so confidence may be absent', () => {
  const decision = readDecision(gatewayAnswer('deep'))
  expect(decision?.tier).toBe('deep')
  expect(decision?.confidence).toBeNull()
})

test('malformed or unexpected payloads read as no decision rather than throwing', () => {
  expect(readDecision('not json')).toBeNull()
  expect(readDecision('{}')).toBeNull()
  expect(readDecision(JSON.stringify({ answers: { tier: { type: 'choice', choice: 'cheap' } } }))).toBeNull()
})

test('spending less needs the high bar; the same confidence is enough to spend more', () => {
  // 0.51 sits between the two bars: too low to downgrade, high enough to upgrade.
  const down = readDecision(gatewayAnswer('fast', { fast: 0.51, balanced: 0.4, deep: 0.09 }))
  expect(route(down, on('claude-sonnet-5'), config).model).toBeNull()

  const up = readDecision(gatewayAnswer('deep', { deep: 0.51, balanced: 0.4, fast: 0.09 }))
  expect(route(up, on('claude-sonnet-5'), config).model).toBe('opus')
})

test('both directions are available once the bar is cleared', () => {
  const down = readDecision(gatewayAnswer('fast', { fast: 0.95, balanced: 0.04, deep: 0.01 }))
  expect(route(down, on('claude-opus-5'), config).model).toBe('haiku')

  const up = readDecision(gatewayAnswer('deep', { deep: 0.9, balanced: 0.08, fast: 0.02 }))
  expect(route(up, on('claude-haiku-4-5-20251001'), config).model).toBe('opus')
})

test('effort moves in both directions too, on its own confidence', () => {
  const low = readDecision(gatewayAnswer('fast', { fast: 0.95 }, 0.01, 0.1))
  expect(route(low, on('claude-haiku-4-5-20251001', 'high'), config).effort).toBe('low')

  const high = readDecision(gatewayAnswer('deep', { deep: 0.95 }, 0.01, 2.8))
  expect(route(high, on('claude-opus-5', 'low'), config).effort).toBe('xhigh')
})

test('a numeric effort is the caller\'s own scale and is left alone', () => {
  const decision = readDecision(gatewayAnswer('deep', { deep: 0.95 }, 0.01, 2.8))
  expect(route(decision, { model: 'claude-opus-5', effort: 4000 }, config).effort).toBeNull()
})

test('a model without effort never receives an effort parameter', () => {
  const decision = readDecision(gatewayAnswer('deep', { deep: 0.95 }, 0.01, 2.8))
  expect(route(decision, { model: 'claude-haiku-4-5-20251001' }, config).effort).toBeNull()
})

test('the rubric score maps onto the reasoning ladder', () => {
  expect(effortLevel(0)).toBe('low')
  expect(effortLevel(0.4)).toBe('low')
  expect(effortLevel(1.4)).toBe('medium')
  expect(effortLevel(2.04)).toBe('high')
  expect(effortLevel(3)).toBe('xhigh')
  expect(effortLevel(99)).toBe('xhigh')
})

test('a risky task takes the deep tier and real reasoning, past both thresholds', () => {
  const decision = readDecision(gatewayAnswer('fast', { fast: 0.97, balanced: 0.02, deep: 0.01 }, 0.93))
  const routing = route(decision, on('claude-sonnet-5', 'low'), config)
  expect(routing.model).toBe('opus')
  expect(routing.effort).toBe('high')
  expect(routing.reason).toContain('risk')
})

test('no decision, and a decision that changes nothing, both leave the request as it is', () => {
  expect(route(null, on('claude-sonnet-5'), config).model).toBeNull()
  const same = readDecision(gatewayAnswer('balanced', { balanced: 0.9 }, 0.01, 1.4))
  const routing = route(same, on('sonnet', 'medium'), config)
  expect(routing.model).toBeNull()
  expect(routing.effort).toBeNull()
})

test('without a confidence a change may only go up, never down', () => {
  // The Gateway may omit the distribution, and the built-in classifier has none.
  const noDistribution = readDecision(
    JSON.stringify({ answers: { tier: { type: 'choice', choice: 'fast' } } }),
  )
  expect(route(noDistribution, on('claude-opus-5'), config).model).toBeNull()

  const up = readDecision(JSON.stringify({ answers: { tier: { type: 'choice', choice: 'deep' } } }))
  expect(route(up, on('claude-haiku-4-5-20251001'), config).model).toBe('opus')
})

test('an unrecognised model id is treated as an upgrade, not guessed at', () => {
  expect(rankOf('some-other-vendor-model', config.tiers)).toBeNull()
  const decision = readDecision(gatewayAnswer('fast', { fast: 0.35, balanced: 0.4, deep: 0.25 }))
  // 0.35 clears the upgrade bar only; an undecidable direction gets that one.
  expect(route(decision, on('some-other-vendor-model'), config).model).toBe('haiku')
})

test('the Gateway request carries the model id and spec version it matches on', () => {
  const headers = requestHeaders('gateway', 'key-under-test', 'typesafe-ai/jev')
  expect(headers['ai-model-id']).toBe('typesafe-ai/jev')
  expect(headers['ai-evaluation-model-specification-version']).toBe('4')
  expect(headers.authorization).toBe('Bearer key-under-test')
})

// Omitting this one is not a degraded request, it is a rejected one: the
// Gateway answers 400 "Unsupported gateway protocol version" before it looks
// at anything else, so the whole backend silently falls back to routing
// nothing.
test('the Gateway request names the protocol version, without which it is refused', () => {
  const headers = requestHeaders('gateway', 'k', 'typesafe-ai/jev')
  expect(headers['ai-gateway-protocol-version']).toBe('0.0.1')
})

test('the protocol version is a Gateway header and is never sent to TypeSafe', () => {
  const headers = requestHeaders('typesafe', 'k', 'jev-latest')
  expect(headers['ai-gateway-protocol-version']).toBeUndefined()
})

// --- TypeSafe's own API ------------------------------------------------------
//
// Same model, different wire shape: a yes/no question is a `noul` rather than a
// `boolean`, every answer reports its own `confidence`, and the model rides in
// the body instead of a header.

const typesafeAnswer = (tier: string, confidence: number, noul = 0.01) =>
  JSON.stringify({
    model: 'jev-1.13',
    answers: {
      tier: { type: 'choice', choice: tier, confidence, probabilities: { [tier]: confidence } },
      effort: { type: 'score', score: 2.1, confidence: 0.8 },
      risky: { type: 'noul', noul },
    },
    usage: { input_tokens: 120, output_tokens: 0 },
  })

test('a TypeSafe answer is read from its own confidence and noul fields', () => {
  const decision = readDecision(typesafeAnswer('deep', 0.91, 0.04))
  expect(decision?.tier).toBe('deep')
  expect(decision?.confidence).toBeCloseTo(0.91)
  expect(decision?.effort).toBeCloseTo(2.1)
  expect(decision?.risky).toBeCloseTo(0.04)
})

test('a low-confidence TypeSafe downgrade is refused, like the Gateway path', () => {
  expect(route(readDecision(typesafeAnswer('fast', 0.42)), on('claude-sonnet-5'), config).model).toBeNull()
})

test('a risky TypeSafe answer forces the deep tier through the noul field', () => {
  const decision = readDecision(typesafeAnswer('fast', 0.98, 0.88))
  expect(route(decision, on('claude-sonnet-5'), config).model).toBe('opus')
})

test('each backend gets its own endpoint, question type and model placement', () => {
  expect(endpoint('typesafe', 'https://api.typesafe.ai/')).toBe('https://api.typesafe.ai/v1/systemone')
  expect(endpoint('gateway', 'https://ai-gateway.vercel.sh/v4/ai')).toBe(
    'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
  )

  expect((questions('typesafe').risky as { type: string }).type).toBe('noul')
  expect((questions('gateway').risky as { type: string }).type).toBe('boolean')

  const typesafeBody = JSON.parse(requestBody('typesafe', { prompt: 'x' }, 'jev-latest'))
  expect(typesafeBody.model).toBe('jev-latest')
  expect(JSON.parse(requestBody('gateway', { prompt: 'x' }, 'typesafe-ai/jev')).model).toBeUndefined()

  expect(requestHeaders('typesafe', 'k', 'jev-latest')['ai-model-id']).toBeUndefined()
})

// --- backend selection -------------------------------------------------------

test('auto prefers TypeSafe, since it is the only backend that reports a confidence', () => {
  expect(selectProvider('auto', 'ts-key', 'gw-key')).toBe('typesafe')
  expect(selectProvider('auto', '', 'gw-key')).toBe('gateway')
  expect(selectProvider('auto', '', '')).toBeNull()
})

test('a forced backend without its own key falls back to the built-in classifier, never to the other key', () => {
  expect(selectProvider('typesafe', '', 'gw-key')).toBeNull()
  expect(selectProvider('gateway', 'ts-key', '')).toBeNull()
})

test('builtin ignores both keys', () => {
  expect(selectProvider('builtin', 'ts-key', 'gw-key')).toBeNull()
})

// --- the two ways a downgrade could have slipped the bar ---------------------

test('risk raises the effort floor but never lowers one', () => {
  // A prod deletion: risky, but mechanically simple, so its own effort is low.
  const decision = readDecision(gatewayAnswer('fast', { fast: 0.99 }, 0.95, 0))
  // Forcing skips the thresholds, so without a clamp this would pull xhigh
  // down to high with no confidence check at all.
  expect(route(decision, on('claude-opus-5', 'xhigh'), config).effort).toBeNull()
  expect(route(decision, on('claude-opus-5', 'max'), config).effort).toBeNull()
  // It still raises a session that is below the floor.
  expect(route(decision, on('claude-opus-5', 'low'), config).effort).toBe('high')
})

test('max ranks above every rung the rubric can produce', () => {
  expect(effortRank('max')).toBeGreaterThan(effortRank('xhigh') as number)
  // Leaving max is a downgrade, so it needs the high bar, not the lenient one.
  const decision = readDecision(gatewayAnswer('fast', { fast: 0.9 }, 0.01, 0))
  const barelyConfident = { ...(decision as NonNullable<typeof decision>), effortConfidence: 0.35 }
  expect(route(barelyConfident, on('claude-sonnet-5', 'max'), config).effort).toBeNull()

  const sure = { ...(decision as NonNullable<typeof decision>), effortConfidence: 0.8 }
  expect(route(sure, on('claude-sonnet-5', 'max'), config).effort).toBe('low')
})

// A prompt classified while another one is still waiting: the turn that
// starts next cannot be tied to either, so neither decision is applied.
const deepDecision: Decision = {
  tier: 'deep',
  confidence: 0.99,
  risky: null,
  effort: null,
  effortConfidence: null,
}
const fastDecision: Decision = { ...deepDecision, tier: 'fast' }

test('a decision is handed to the turn that follows its prompt', () => {
  const pending = pendingDecisions()
  pending.put(deepDecision)
  expect(pending.take()).toEqual(deepDecision)
})

test('two prompts waiting at once yield no decision instead of the wrong one', () => {
  const pending = pendingDecisions()
  pending.put(fastDecision)
  pending.put(deepDecision)
  expect(pending.take()).toBeNull()
})

test('a prompt that failed to classify still shields the next prompt', () => {
  const pending = pendingDecisions()
  pending.put(null)
  pending.put(deepDecision)
  expect(pending.take()).toBeNull()
})

test('the slot empties on take, so a later turn never reuses a decision', () => {
  const pending = pendingDecisions()
  pending.put(deepDecision)
  pending.take()
  expect(pending.take()).toBeNull()
})

test('the slot recovers after an ambiguous round', () => {
  const pending = pendingDecisions()
  pending.put(fastDecision)
  pending.put(deepDecision)
  expect(pending.take()).toBeNull()
  pending.put(deepDecision)
  expect(pending.take()).toEqual(deepDecision)
})

// A turn the router leaves alone still has to say so: a silent no-op and a mod
// that never loaded look identical in the transcript otherwise.
test('a no-change decision reports what it wanted and what it kept', () => {
  const decision: Decision = {
    tier: 'fast',
    confidence: 0.41,
    risky: null,
    effort: 0,
    effortConfidence: 0.41,
  }
  const routing = route(decision, { model: 'sonnet', effort: 'medium' }, config)
  expect(routing.model).toBeNull()
  expect(routing.effort).toBeNull()
  expect(routing.reason).toBe('kept sonnet/medium, wanted haiku/low (confidence 0.41)')
})

test('a no-change decision without a confidence says so rather than going quiet', () => {
  const decision: Decision = {
    tier: 'fast',
    confidence: null,
    risky: null,
    effort: 0,
    effortConfidence: null,
  }
  const routing = route(decision, { model: 'sonnet', effort: 'medium' }, config)
  expect(routing.reason).toBe('kept sonnet/medium, wanted haiku/low (confidence n/d)')
})

test('no classification at all is its own reason, not a no-change', () => {
  expect(route(null, { model: 'sonnet', effort: 'medium' }, config).reason).toBe('no decision')
})

// The transcript is the only place a mod's work is visible, so the lines it
// writes are a contract, not decoration.
test('the setup line names the backend and which switches are on', () => {
  expect(
    describeSetup('typesafe', 'https://api.typesafe.ai/v1/systemone', {
      subagentModel: true,
      subagentEffort: true,
      mainEffort: true,
      mainModel: false,
    }),
  ).toBe(
    'ready on typesafe (https://api.typesafe.ai/v1/systemone); routing subagent model, subagent effort, main effort',
  )
})

test('the setup line says so when there is no backend and when nothing routes', () => {
  expect(
    describeSetup(null, '', { subagentModel: false, subagentEffort: false, mainEffort: false, mainModel: false }),
  ).toBe('ready on the built-in classifier, no key set; routing nothing, every switch is off')
})

// `provider: "builtin"` is a deliberate choice; reporting it as a missing key
// sends someone looking for a credential they meant to leave out.
test('choosing the built-in classifier is not reported as a missing key', () => {
  expect(
    describeSetup(null, '', { subagentModel: true, subagentEffort: true, mainEffort: true, mainModel: false }, true),
  ).toBe('ready on the built-in classifier, by choice; routing subagent model, subagent effort, main effort')
})

test('the decision line carries every answer and the latency', () => {
  const decision = readDecision(gatewayAnswer('deep', { deep: 0.95 }, 0.01, 2.8))
  expect(describeDecision(decision, 249.4)).toBe(
    'tier deep (0.95) · effort 2.8 → xhigh (0.90) · risky 0.01 · 249ms',
  )
})

test('a classification that never answered says that, not nothing', () => {
  expect(describeDecision(null, 800)).toBe('no answer · 800ms')
})

test('the status line distinguishes a change from a deliberate no-change', () => {
  const decision = readDecision(gatewayAnswer('fast', { fast: 0.87 }))
  expect(describeStatus(decision, { model: 'haiku', effort: 'low' })).toBe(
    'jev · fast 0.87 → haiku/low',
  )
  expect(describeStatus(decision, null)).toBe('jev · fast 0.87 · unchanged')
  expect(describeStatus(null, null)).toBe('jev · no answer')
})

// `turn.step`'s `model` goes to the API as written, so a family alias has to
// become an id there; the engine refuses "haiku" on a request.
test('a family alias resolves to a full id for the main loop', () => {
  expect(requestModelId('haiku')).toBe('claude-haiku-4-5-20251001')
  expect(requestModelId('Sonnet')).toBe('claude-sonnet-5-5')
  expect(requestModelId('opus')).toBe('claude-opus-5-5')
})

test('a full id or an unknown name is passed through unchanged', () => {
  expect(requestModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  expect(requestModelId('claude-opus-5[1m]')).toBe('claude-opus-5[1m]')
  expect(requestModelId('my-org/custom')).toBe('my-org/custom')
})

// Staying in the same tier is not a change, so a session on `claude-opus-5[1m]`
// keeps its 1M-context id when the decision is `deep`.
test('a decision for the tier the session already runs keeps its exact id', () => {
  const decision = readDecision(gatewayAnswer('deep', { deep: 0.95 }))
  const routing = route(decision, { model: 'claude-opus-5[1m]', effort: 'medium' }, config)
  expect(routing.model).toBeNull()
})

test('a definition\'s frontmatter model is read, quoted or not', () => {
  expect(definitionModel('---\nname: guard\nmodel: sonnet\neffort: low\n---\nBody')).toBe('sonnet')
  expect(definitionModel('---\nmodel: "claude-haiku-4-5"  # cheap\n---\n')).toBe('claude-haiku-4-5')
})

test('a definition without a model, or with inherit, leaves the parent to decide', () => {
  expect(definitionModel('---\nname: guard\n---\nmodel: opus in the body')).toBeNull()
  expect(definitionModel('---\nmodel: inherit\n---\n')).toBeNull()
  expect(definitionModel('no frontmatter\nmodel: opus')).toBeNull()
})

test('a plain agent type is looked up in the project, then the user folder', () => {
  expect(definitionDirs('golden-test-validator', '/p', '/h', [])).toEqual({
    agent: 'golden-test-validator',
    dirs: ['/p/.claude/agents', '/h/.claude/agents'],
  })
})

test('a plugin agent type is looked up in the agent folders of that plugin', () => {
  expect(definitionDirs('codex:codex-rescue', '/p', '/h', ['/c/codex/1.0.6/agents', '/c/codex/1.0.6/extra'])).toEqual({
    agent: 'codex-rescue',
    dirs: ['/c/codex/1.0.6/agents', '/c/codex/1.0.6/extra'],
  })
})

test('a slash command alone is not a task; with text after it, it is', () => {
  for (const text of ['/simplify', ' /run ', '/code-review\n']) expect(bareCommand(text)).toBe(true)
  for (const text of ['/code-review high', '/simplify the retry loop', '/tmp/log.txt', '/', 'fix /api', 'rename foo'])
    expect(bareCommand(text)).toBe(false)
})

test('below the context limit the main loop may switch to any model', () => {
  expect(gateMainModel('claude-haiku-4-5-20251001', 60_000, 80_000, 'claude-opus-5-5[1m]').model).toBe('claude-haiku-4-5-20251001')
  expect(gateMainModel('claude-haiku-4-5-20251001', undefined, 80_000, 'claude-opus-5-5[1m]').model).toBe('claude-haiku-4-5-20251001')
})

test('above the context limit only a return to the starting model is allowed', () => {
  const held = gateMainModel('claude-haiku-4-5-20251001', 120_000, 80_000, 'claude-opus-5-5[1m]')
  expect(held.model).toBeNull()
  expect(held.reason).toContain('120000')
  expect(gateMainModel('claude-opus-5-5', 120_000, 80_000, 'claude-opus-5-5[1m]').model).toBe('claude-opus-5-5[1m]')
})

test('a model in the starting model\'s family keeps its exact id, 1M window included', () => {
  expect(gateMainModel('claude-opus-5-5', 10_000, 80_000, 'claude-opus-5-5[1m]').model).toBe('claude-opus-5-5[1m]')
  expect(gateMainModel('claude-sonnet-5', 10_000, 80_000, 'claude-opus-5-5[1m]').model).toBe('claude-sonnet-5')
})

test('no starting model known leaves the gate to the context limit alone', () => {
  expect(gateMainModel('claude-opus-5-5', 120_000, 80_000, undefined).model).toBeNull()
  expect(gateMainModel('claude-opus-5-5', 10_000, 80_000, undefined).model).toBe('claude-opus-5-5')
})


const mainConfig: PolicyConfig = { ...config, modelFloor: 'balanced', minModelDowngradeConfidence: 0.9 }
const mechanical = (confidence: number): Decision => ({
  tier: 'fast', confidence, risky: 0.1, effort: 0.1, effortConfidence: confidence,
})

test('the main loop never goes below its model floor', () => {
  expect(route(mechanical(0.99), { model: 'claude-opus-5-5', effort: 'medium' }, mainConfig).model).toBe('sonnet')
})

test('a main-loop model downgrade needs its own, higher confidence', () => {
  expect(route(mechanical(0.8), { model: 'claude-opus-5-5', effort: 'medium' }, mainConfig).model).toBeNull()
  expect(route(mechanical(0.8), { model: 'claude-opus-5-5', effort: 'medium' }, config).model).toBe('haiku')
})

test('the model downgrade bar leaves effort on the ordinary one', () => {
  expect(route(mechanical(0.8), { model: 'claude-opus-5-5', effort: 'medium' }, mainConfig).effort).toBe('low')
})

test('a main loop below its floor is raised to it on the upgrade bar', () => {
  expect(route(mechanical(0.5), { model: 'claude-haiku-4-5-20251001', effort: 'low' }, mainConfig).model).toBe('sonnet')
})

test('a definition is matched by its frontmatter name, else by its file name', () => {
  expect(definitionMatches('---\nname: reviewer\nmodel: sonnet\n---\n', 'reviewer-config.md', 'reviewer')).toBe(true)
  expect(definitionMatches('---\nname: other\n---\n', 'reviewer.md', 'reviewer')).toBe(false)
  expect(definitionMatches('---\nmodel: sonnet\n---\n', 'reviewer.md', 'reviewer')).toBe(true)
  expect(definitionMatches('no frontmatter', 'reviewer-config.md', 'reviewer')).toBe(false)
})

test('a plugin\'s agent folders are its default one plus any its manifest names', () => {
  expect(pluginAgentDirs('/c/p', {})).toEqual(['/c/p/agents'])
  expect(pluginAgentDirs('/c/p', { agents: './custom/agents' })).toEqual(['/c/p/agents', '/c/p/custom/agents'])
  expect(pluginAgentDirs('/c/p', { agents: ['./a', 'b/'] })).toEqual(['/c/p/agents', '/c/p/a', '/c/p/b'])
})

test('risk forcing is reported so a caller can let it past other gates', () => {
  const risky: Decision = { tier: 'fast', confidence: 0.9, risky: 0.95, effort: 0.1, effortConfidence: 0.9 }
  expect(route(risky, { model: 'claude-sonnet-5', effort: 'medium' }, config).forced).toBe(true)
  expect(route(mechanical(0.99), { model: 'claude-opus-5-5', effort: 'medium' }, config).forced).toBe(false)
})

test('a floored tier says so in the reason', () => {
  expect(route(mechanical(0.99), { model: 'claude-opus-5-5', effort: 'medium' }, mainConfig).reason).toContain('floored to balanced')
})

test('the starting model is matched exactly, context suffix aside, not by family word', () => {
  expect(gateMainModel('claude-opus-5-5', 100, 80_000, 'claude-opus-5[1m]').model).toBe('claude-opus-5-5')
  expect(gateMainModel('claude-opus-5-5', 120_000, 80_000, 'claude-opus-5[1m]').model).toBeNull()
  expect(gateMainModel('custom-model', 120_000, 80_000, 'custom-model').model).toBe('custom-model')
  expect(gateMainModel('claude-opus-5-5', 120_000, 80_000, 'my-opus-proxy').model).toBeNull()
})

test('a floored tier says so even when nothing changes', () => {
  expect(route(mechanical(0.99), { model: 'sonnet', effort: 'low' }, mainConfig).reason).toContain('fast floored to balanced')
})

const codexLadder = { fast: 'gpt-6-luna', balanced: 'gpt-6-sol', deep: 'gpt-6-sol' }
const decide = (tier: 'fast' | 'balanced' | 'deep', confidence: number | null, extra: Partial<Decision> = {}): Decision => ({
  tier, confidence, risky: 0.1, effort: 1, effortConfidence: 0.8, ...extra,
})

test('codex flags: sol carries the hard work, effort carries the difficulty', () => {
  expect(codexFlags(decide('deep', 0.5), 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'high' })
  expect(codexFlags(decide('deep', 0.5, { effort: 3 }), 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'xhigh' })
  expect(codexFlags(decide('deep', 0.2), 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'medium' })
  expect(codexFlags(decide('balanced', 0.9, { effort: 2 }), 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'medium' })
})

test('codex flags default to sol/low', () => {
  expect(codexFlags(decide('balanced', 0.9), 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'low' })
  expect(codexFlags(decide('fast', 0.5), 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'low' })
  expect(codexFlags(null, 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'low' })
})

test('codex flags go to luna only when sure and not risky', () => {
  expect(codexFlags(decide('fast', 0.9), 'x', codexLadder)).toEqual({ model: 'gpt-6-luna', effort: 'low' })
  expect(codexFlags(decide('fast', null), 'x', codexLadder)?.model).toBe('gpt-6-sol')
  expect(codexFlags(decide('fast', 0.9, { risky: 0.5 }), 'x', codexLadder)?.model).toBe('gpt-6-sol')
})

test('risk forces sol at xhigh', () => {
  expect(codexFlags(decide('fast', 0.9, { risky: 0.8 }), 'x', codexLadder)).toEqual({ model: 'gpt-6-sol', effort: 'xhigh' })
})

test('explicit codex flags leave the prompt alone', () => {
  expect(codexFlags(decide('deep', 0.9), '--model gpt-6-astra do it', codexLadder)).toBeNull()
  expect(codexFlags(decide('deep', 0.9), 'do it --effort low', codexLadder)).toBeNull()
})

// A floor is policy, not a guess: it lifts a low reading without a confidence
// check; a downgrade still happens, but stops at the floor.
const floored: PolicyConfig = { ...mainConfig, effortFloor: 'medium' }

test('an effort floor lifts a low reading even when the effort confidence is low', () => {
  const low: Decision = { ...mechanical(0.99), effortConfidence: 0.05 }
  expect(route(low, { model: 'claude-sonnet-5-5', effort: 'low' }, floored).effort).toBe('medium')
  expect(route(low, { model: 'claude-sonnet-5-5', effort: 'low' }, mainConfig).effort).toBeNull()
})

test('an effort floor stops a downgrade at the floor, and leaves a level at the floor alone', () => {
  expect(route(mechanical(0.99), { model: 'claude-sonnet-5-5', effort: 'high' }, floored).effort).toBe('medium')
  expect(route(mechanical(0.99), { model: 'claude-sonnet-5-5', effort: 'medium' }, floored).effort).toBeNull()
})

// Grades (2026-09-28): a balanced reading runs at `high` at least, and while
// the loop is below the deep tier nothing goes above `high`; xhigh/max are
// for opus. Both are policy, so neither waits for confidence.
const graded: PolicyConfig = { ...floored, balancedEffortFloor: 'high', effortCeiling: 'high' }
const balanced = (effort: number): Decision => ({ tier: 'balanced', confidence: 0.9, risky: 0.1, effort, effortConfidence: 0.05 })
const deep = (effort: number): Decision => ({ tier: 'deep', confidence: 0.9, risky: 0.1, effort, effortConfidence: 0.9 })

test('a balanced reading is lifted to high, a fast one only to the general floor', () => {
  expect(route(balanced(0.5), on('claude-sonnet-5-5', 'medium'), graded).effort).toBe('high')
  expect(route(mechanical(0.99), on('claude-sonnet-5-5', 'low'), graded).effort).toBe('medium')
})

test('the ceiling holds sonnet at high, whatever it was on', () => {
  expect(route(balanced(3), on('claude-sonnet-5-5', 'xhigh'), graded).effort).toBe('high')
  expect(route(balanced(3), on('claude-sonnet-5-5', 'max'), graded).effort).toBe('high')
})

test('the ceiling does not apply once the loop is on the deep tier', () => {
  expect(route(deep(3), on('claude-opus-5-5', 'high'), graded).effort).toBe('xhigh')
  expect(route(deep(3), on('claude-opus-5-5', 'xhigh'), graded).effort).toBeNull()
})

test('effort-only routing uses the model actually running for its ceiling', () => {
  const effortOnly = { ...graded, routeModel: false }
  const sonnet = route(deep(3), on('claude-sonnet-5-5', 'medium'), effortOnly)
  expect(sonnet.model).toBeNull()
  expect(sonnet.effort).toBe('high')
  expect(sonnet.reason).toBe('deep (confidence 0.90)')
  expect(route(deep(3), on('claude-opus-5-5', 'medium'), effortOnly).effort).toBe('xhigh')
  expect(route(deep(3), on('claude-sonnet-5-5', 'medium'), graded).model).toBe('opus')
})

test('an unknown running model still gets the effort-only ceiling', () => {
  expect(route(deep(3), on('mystery-1', 'medium'), { ...graded, routeModel: false }).effort).toBe('high')
})

test('risk raises effort without changing the model when model routing is off', () => {
  const risky: Decision = { ...mechanical(0.01), risky: 0.9, effort: 0, effortConfidence: 0.01 }
  const result = route(risky, on('claude-sonnet-5-5', 'low'), { ...graded, routeModel: false })
  expect(result.model).toBeNull()
  expect(result.effort).toBe('high')
  expect(result.forced).toBe(true)
  expect(result.reason).toBe('effort forced by risk')
})

test('effort-only routing exposes the model it would have chosen', () => {
  const result = route(deep(3), on('claude-sonnet-5-5', 'medium'), { ...graded, routeModel: false })
  expect(result.wantedModel).toBe('opus')
})

test('definition effort accepts only supported frontmatter values', () => {
  expect(definitionEffort('---\neffort: high\n---\n')).toBe('high')
  expect(definitionEffort('---\neffort: "xhigh"\n---\n')).toBe('xhigh')
  expect(definitionEffort('---\neffort: max\n---\n')).toBe('max')
  expect(definitionEffort('---\nname: reviewer\n---\n')).toBeNull()
  expect(definitionEffort('---\neffort: 1000\n---\n')).toBeNull()
  expect(definitionEffort('---\neffort: lots\n---\n')).toBeNull()
})

test('runtime definition pin wins over a file pin and the classification', () => {
  const spawn = { decision: deep(3), pinned: 'medium' as const }
  expect(subagentEffortRouting(spawn, on('claude-opus-5-5', 'low'), graded, 'high')).toEqual({
    effort: null, reason: 'effort pinned by definition (high)',
  })
})

test('a file definition pin keeps the subagent effort', () => {
  const spawn = { decision: deep(3), pinned: 'medium' as const }
  expect(subagentEffortRouting(spawn, on('claude-opus-5-5', 'low'), graded).effort).toBeNull()
})

test('an unpinned subagent on a model without effort keeps the request untouched', () => {
  const spawn = { decision: deep(3), pinned: null }
  expect(subagentEffortRouting(spawn, on('claude-haiku-4-5'), graded)).toEqual({
    effort: null, reason: 'model takes no effort',
  })
})
