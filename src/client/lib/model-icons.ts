const LOBE_STATIC_SVG = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons'

const MODEL_BRAND_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:gpt|chatgpt)\b|^(?:o[134](?:[-_.]|$)|codex\b)|\bopenai\b/u, 'openai'],
  [/\bclaude\b/u, 'claude'],
  [/\b(?:gemini|imagen|veo|lyria)\b/u, 'gemini'],
  [/\bgemma\b/u, 'gemma'],
  [/\bdeepseek\b/u, 'deepseek'],
  [/(?:qwen|qwq|qvq|tongyi)/u, 'qwen'],
  [/\b(?:kimi|moonshot)\b|^k3(?:[-_.]|$)/u, 'kimi'],
  [/\b(?:doubao|seedream|seedance)\b|^seed(?:[-_.\d]|$)/u, 'doubao'],
  [/\bhunyuan\b|^hy(?:[-_.\d]|$)/u, 'hunyuan'],
  [/\blongcat\b/u, 'longcat'],
  [/\b(?:llama|meta)\b/u, 'meta'],
  [/\b(?:mistral|mixtral|codestral|pixtral|ministral|magistral|devstral|voxtral)\b/u, 'mistral'],
  [/\b(?:minimax|abab)\b/u, 'minimax'],
  [/\b(?:chatglm|glm)\b/u, 'chatglm'],
  [/(?:ernie|wenxin)/u, 'wenxin'],
  [/\bgrok\b/u, 'grok'],
  [/\b(?:pplx|sonar|perplexity)\b/u, 'perplexity'],
  [/\b(?:command-r|command-a|cohere)\b/u, 'cohere'],
  [/\bflux\b/u, 'flux'],
  [/\b(?:stability|stable-diffusion|sdxl)\b/u, 'stability'],
]

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/:(?:free|cloud)$/u, '') ?? ''
}

function baseModelId(modelId: string | null | undefined): string {
  const parts = normalize(modelId).split('/').filter(Boolean)
  return parts.at(-1) ?? ''
}

function inferredBrand(values: readonly string[]): string | null {
  for (const value of values) {
    for (const [pattern, brand] of MODEL_BRAND_RULES) if (pattern.test(value)) return brand
  }
  return null
}

function genericBrand(value: string): string | null {
  const first = value.split(/[-_.:]/u).find(Boolean)
  return first && /^[a-z0-9]+$/u.test(first) ? first : null
}

/** Lobe owns the SVG catalog; this resolver only bridges model metadata to its stable brand ids. */
export function lobeModelIconSources(input: {
  modelId?: string | null
  family?: string | null
  labId?: string | null
}): string[] {
  const base = baseModelId(input.modelId)
  const family = normalize(input.family)
  const full = normalize(input.modelId)
  const lab = normalize(input.labId)
  const keys = [
    inferredBrand([base, family, full]),
    genericBrand(family),
    genericBrand(base),
    genericBrand(lab),
  ].filter((key): key is string => Boolean(key))

  return [...new Set(keys)].flatMap(key => [
    `${LOBE_STATIC_SVG}/${encodeURIComponent(key)}-color.svg`,
    `${LOBE_STATIC_SVG}/${encodeURIComponent(key)}.svg`,
  ])
}
