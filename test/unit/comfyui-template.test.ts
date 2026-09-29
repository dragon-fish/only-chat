import { describe, expect, it } from 'vitest'
import {
  applyTemplate, parseApiWorkflow, summarizeTemplate, TemplateError, type ApiWorkflow,
} from '@/plugins/comfyui/server/template'

/** ckpt → two prompts → KSampler → decode → save, with node ids that line up across fixtures. */
function base(): ApiWorkflow {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'test.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'pos prompt', clip: ['1', 1] }, _meta: { title: 'Positive' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'neg prompt', clip: ['1', 1] }, _meta: { title: 'Negative' } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'test' } },
  }
}

function withPool(): ApiWorkflow {
  const workflow = base()
  workflow['100'] = { class_type: 'LoraLoader', inputs: { lora_name: 'loraA.safetensors', strength_model: 0.8, strength_clip: 0.8 } }
  workflow['101'] = { class_type: 'LoraLoader', inputs: { lora_name: 'loraB.safetensors', strength_model: 0.5, strength_clip: 0.5 } }
  return workflow
}

function locked(): ApiWorkflow {
  const workflow = withPool()
  workflow['100']!.inputs.model = ['1', 0]
  workflow['100']!.inputs.clip = ['1', 1]
  workflow['2']!.inputs.clip = ['100', 1]
  workflow['3']!.inputs.clip = ['100', 1]
  workflow['5']!.inputs.model = ['100', 0]
  return workflow
}

/** Model from a UNETLoader and clip from a separate CLIPLoader, so the two sources differ. */
function splitSources(): ApiWorkflow {
  const workflow = withPool()
  workflow['1'] = { class_type: 'UNETLoader', inputs: { unet_name: 'model.safetensors', weight_dtype: 'default' } }
  workflow['10'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors', type: 'stable_diffusion' } }
  workflow['11'] = { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } }
  workflow['2']!.inputs.clip = ['10', 0]
  workflow['3']!.inputs.clip = ['10', 0]
  workflow['6']!.inputs.vae = ['11', 0]
  return workflow
}

/** Shaped like a subgraph export: string ids, and the latent size fed by a ResolutionSelector. */
function resolutionSelector(): ApiWorkflow {
  return {
    '65:44': { class_type: 'UNETLoader', inputs: { unet_name: 'anima.safetensors', weight_dtype: 'default' } },
    '65:45': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors', type: 'stable_diffusion' } },
    '65:15': { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } },
    '65:69': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '1:1 (Square)', megapixels: 1, multiple: 16 } },
    '65:28': { class_type: 'EmptyLatentImage', inputs: { width: ['65:69', 0], height: ['65:69', 1], batch_size: 1 } },
    '66:62': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece', clip: ['65:45', 0] }, _meta: { title: 'Prompt' } },
    '66:12': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality', clip: ['65:45', 0] }, _meta: { title: 'Negative Prompt' } },
    '67:19': {
      class_type: 'KSampler',
      inputs: {
        seed: 1, steps: 25, cfg: 6, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1,
        model: ['65:44', 0], positive: ['66:62', 0], negative: ['66:12', 0], latent_image: ['65:28', 0],
      },
    },
    '67:60:8': { class_type: 'VAEDecode', inputs: { samples: ['67:19', 0], vae: ['65:15', 0] } },
    '68': { class_type: 'SaveImage', inputs: { filename_prefix: 'anima', images: ['67:60:8', 0] } },
  }
}

describe('parseApiWorkflow', () => {
  it('accepts an API-format workflow', () => {
    expect(parseApiWorkflow(base())['5']!.class_type).toBe('KSampler')
  })

  it('rejects the UI format, which ComfyUI cannot execute', () => {
    expect(() => parseApiWorkflow({ last_node_id: 9, nodes: [], links: [], version: 0.4 })).toThrow(TemplateError)
  })

  it.each([
    ['an array', [1, 2]],
    ['an empty object', {}],
    ['a node without class_type', { 1: { inputs: {} } }],
    ['a node without inputs', { 1: { class_type: 'KSampler' } }],
    ['a non-object node', { 1: 'nope' }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseApiWorkflow(value)).toThrow(TemplateError)
  })
})

describe('summarizeTemplate', () => {
  it('reads prompts, sampler defaults, size and model from a plain workflow', () => {
    expect(summarizeTemplate('t', base())).toEqual({
      name: 't', usable_as_template: true, model: 'test.safetensors',
      prompt: 'pos prompt', negative: 'neg prompt',
      defaults: { steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 },
      size: { width: 512, height: 512 }, loras: [], lora_locked: false,
    })
  })

  it('falls back to _meta.title when the sampler reaches the prompts indirectly', () => {
    const workflow = base()
    workflow['8'] = { class_type: 'ConditioningConcat', inputs: {} }
    workflow['5']!.inputs.positive = ['8', 0]
    workflow['5']!.inputs.negative = ['8', 0]
    expect(summarizeTemplate('t', workflow)).toMatchObject({ prompt: 'pos prompt', negative: 'neg prompt' })
  })

  it('tells two untitled prompts apart by negative-sounding text', () => {
    const workflow = base()
    workflow['8'] = { class_type: 'ConditioningConcat', inputs: {} }
    workflow['5']!.inputs.positive = ['8', 0]
    workflow['5']!.inputs.negative = ['8', 0]
    workflow['2'] = { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, worst quality', clip: ['1', 1] } }
    workflow['3'] = { class_type: 'CLIPTextEncode', inputs: { text: '1girl, masterpiece', clip: ['1', 1] } }
    expect(summarizeTemplate('t', workflow)).toMatchObject({ prompt: '1girl, masterpiece', negative: 'low quality, worst quality' })
  })

  it('still lists a template whose prompts cannot be identified, marked unusable', () => {
    const workflow = base()
    workflow['8'] = { class_type: 'ConditioningConcat', inputs: {} }
    workflow['5']!.inputs.positive = ['8', 0]
    for (const id of ['2', '3']) delete workflow[id]!._meta
    workflow['9'] = { class_type: 'CLIPTextEncode', inputs: { text: 'third', clip: ['1', 1] } }
    const summary = summarizeTemplate('t', workflow)
    expect(summary.usable_as_template).toBe(false)
    expect(summary.problem).toBeTruthy()
    expect(summary.model).toBe('test.safetensors')
  })

  it('is unusable without a KSampler', () => {
    const workflow = base()
    delete workflow['5']
    expect(summarizeTemplate('t', workflow).usable_as_template).toBe(false)
  })

  it('offers dangling LoraLoaders as the pool', () => {
    expect(summarizeTemplate('t', withPool())).toMatchObject({
      lora_locked: false,
      loras: [
        { name: 'loraA.safetensors', strength_model: 0.8, strength_clip: 0.8 },
        { name: 'loraB.safetensors', strength_model: 0.5, strength_clip: 0.5 },
      ],
    })
  })

  it('locks a template with a LoRA already wired in, even with dangling ones beside it', () => {
    expect(summarizeTemplate('t', locked())).toMatchObject({ lora_locked: true, loras: [] })
  })

  it('leaves out pool nodes whose strengths are not literal numbers', () => {
    const workflow = withPool()
    workflow['100']!.inputs.strength_model = ['9', 0]
    workflow['101']!.inputs.strength_clip = true
    expect(summarizeTemplate('t', workflow).loras).toEqual([])
  })

  it('reports no size when the latent is sized by another node', () => {
    expect(summarizeTemplate('t', resolutionSelector())).toMatchObject({ usable_as_template: true, size: null, prompt: 'masterpiece' })
  })
})

describe('applyTemplate', () => {
  it('replaces the prompt, keeps the negative, sets the seed, and leaves the template untouched', () => {
    const template = base()
    const { workflow } = applyTemplate(template, { prompt: 'a cat', seed: 42 })
    expect(workflow['2']!.inputs.text).toBe('a cat')
    expect(workflow['3']!.inputs.text).toBe('neg prompt')
    expect(workflow['5']!.inputs.seed).toBe(42)
    expect(template['2']!.inputs.text).toBe('pos prompt')
    expect(template['5']!.inputs.seed).toBe(0)
  })

  it('overrides negative, steps and cfg when given', () => {
    const { workflow } = applyTemplate(base(), { prompt: 'x', negative: 'ugly', steps: 8, cfg: 4.5, seed: 1 })
    expect(workflow['3']!.inputs.text).toBe('ugly')
    expect(workflow['5']!.inputs).toMatchObject({ steps: 8, cfg: 4.5 })
  })

  it('writes the seed of KSamplerAdvanced to noise_seed', () => {
    const template = base()
    template['5'] = { class_type: 'KSamplerAdvanced', inputs: { ...template['5']!.inputs, noise_seed: 0 } }
    delete template['5'].inputs.seed
    const { workflow } = applyTemplate(template, { prompt: 'x', seed: 99 })
    expect(workflow['5']!.inputs.noise_seed).toBe(99)
    expect('seed' in workflow['5']!.inputs).toBe(false)
  })

  it('sizes by explicit width/height over aspect ratio over the template default', () => {
    expect(applyTemplate(base(), { prompt: 'x', seed: 1 }).size).toEqual({ width: 512, height: 512 })
    expect(applyTemplate(base(), { prompt: 'x', seed: 1, aspect_ratio: 'portrait' }).size).toEqual({ width: 832, height: 1216 })
    const { workflow, size } = applyTemplate(base(), { prompt: 'x', seed: 1, aspect_ratio: 'portrait', width: 1344, height: 768 })
    expect(size).toEqual({ width: 1344, height: 768 })
    expect(workflow['4']!.inputs).toMatchObject({ width: 1344, height: 768 })
  })

  it('rejects a lone width', () => {
    expect(() => applyTemplate(base(), { prompt: 'x', seed: 1, width: 1024 })).toThrow(TemplateError)
  })

  it('replaces a linked latent size with literals', () => {
    const { workflow, size } = applyTemplate(resolutionSelector(), { prompt: 'x', seed: 1, aspect_ratio: 'landscape' })
    expect(workflow['65:28']!.inputs).toMatchObject({ width: 1216, height: 832 })
    expect(size).toEqual({ width: 1216, height: 832 })
  })

  it('keeps a linked latent size when none is requested', () => {
    const { workflow, size } = applyTemplate(resolutionSelector(), { prompt: 'x', seed: 1 })
    expect(workflow['65:28']!.inputs.width).toEqual(['65:69', 0])
    expect(size).toBeNull()
  })

  it('replaces a linked sampler input when it is overridden', () => {
    const template = base()
    template['9'] = { class_type: 'PrimitiveInt', inputs: { value: 20 } }
    template['5']!.inputs.steps = ['9', 0]
    expect(applyTemplate(template, { prompt: 'x', seed: 1, steps: 8 }).workflow['5']!.inputs.steps).toBe(8)
    expect(applyTemplate(template, { prompt: 'x', seed: 1 }).workflow['5']!.inputs.steps).toEqual(['9', 0])
  })

  it('refuses a size on a template without an empty latent', () => {
    const template = base()
    delete template['4']
    expect(() => applyTemplate(template, { prompt: 'x', seed: 1, aspect_ratio: 'square' })).toThrow(TemplateError)
  })

  it('refuses a negative on a template without a negative prompt', () => {
    const template = base()
    delete template['3']
    delete template['5']!.inputs.negative
    expect(() => applyTemplate(template, { prompt: 'x', seed: 1, negative: 'bad' })).toThrow(TemplateError)
  })

  it('refuses an unusable template', () => {
    const template = base()
    delete template['5']
    expect(() => applyTemplate(template, { prompt: 'x', seed: 1 })).toThrow(TemplateError)
  })

  it('reports the model summary', () => {
    expect(applyTemplate(splitSources(), { prompt: 'x', seed: 1 }).model).toBe('model.safetensors + clip.safetensors + vae.safetensors')
  })
})

describe('applyTemplate loras', () => {
  it('without loras leaves the pool dangling and the main path as it was', () => {
    const { workflow } = applyTemplate(withPool(), { prompt: 'x', seed: 1 })
    const bare = applyTemplate(base(), { prompt: 'x', seed: 1 }).workflow
    for (const id of Object.keys(bare)) expect(workflow[id]).toEqual(bare[id])
    expect('model' in workflow['100']!.inputs).toBe(false)
  })

  it('wires one pooled LoRA between the checkpoint and its consumers, with its authored strengths', () => {
    const { workflow } = applyTemplate(withPool(), { prompt: 'x', seed: 1, loras: [{ name: 'loraA.safetensors' }] })
    expect(workflow['100']!.inputs).toMatchObject({ model: ['1', 0], clip: ['1', 1], strength_model: 0.8, strength_clip: 0.8 })
    expect(workflow['5']!.inputs.model).toEqual(['100', 0])
    expect(workflow['2']!.inputs.clip).toEqual(['100', 1])
    expect(workflow['3']!.inputs.clip).toEqual(['100', 1])
    expect(workflow['6']!.inputs.vae).toEqual(['1', 2])
    expect('model' in workflow['101']!.inputs).toBe(false)
  })

  it('chains LoRAs in the given order and applies strength overrides, including zero', () => {
    const { workflow } = applyTemplate(withPool(), {
      prompt: 'x', seed: 1,
      loras: [{ name: 'loraB.safetensors', strength_model: 0 }, { name: 'loraA.safetensors', strength_clip: 0.1 }],
    })
    expect(workflow['101']!.inputs).toMatchObject({ model: ['1', 0], clip: ['1', 1], strength_model: 0, strength_clip: 0.5 })
    expect(workflow['100']!.inputs).toMatchObject({ model: ['101', 0], clip: ['101', 1], strength_model: 0.8, strength_clip: 0.1 })
    expect(workflow['5']!.inputs.model).toEqual(['100', 0])
    expect(workflow['2']!.inputs.clip).toEqual(['100', 1])
  })

  it('wires model and clip from their own providers when they differ', () => {
    const { workflow } = applyTemplate(splitSources(), { prompt: 'x', seed: 1, loras: [{ name: 'loraA.safetensors' }] })
    expect(workflow['100']!.inputs).toMatchObject({ model: ['1', 0], clip: ['10', 0] })
    expect(workflow['5']!.inputs.model).toEqual(['100', 0])
    expect(workflow['3']!.inputs.clip).toEqual(['100', 1])
  })

  it('adds a new LoraLoader for a LoRA outside the pool', () => {
    const { workflow } = applyTemplate(resolutionSelector(), { prompt: 'x', seed: 1, loras: [{ name: 'extra.safetensors', strength_model: 0.6 }] })
    const added = Object.keys(workflow).filter(id => !(id in resolutionSelector()))
    expect(added).toHaveLength(1)
    const id = added[0]!
    expect(workflow[id]).toMatchObject({
      class_type: 'LoraLoader',
      inputs: { lora_name: 'extra.safetensors', strength_model: 0.6, strength_clip: 1, model: ['65:44', 0], clip: ['65:45', 0] },
    })
    expect(workflow['67:19']!.inputs.model).toEqual([id, 0])
    expect(workflow['66:62']!.inputs.clip).toEqual([id, 1])
    expect(workflow['66:12']!.inputs.clip).toEqual([id, 1])
  })

  it('gives each new LoraLoader its own id and chains pooled and new ones together', () => {
    const { workflow } = applyTemplate(withPool(), {
      prompt: 'x', seed: 1,
      loras: [{ name: 'new1.safetensors' }, { name: 'loraA.safetensors' }, { name: 'new2.safetensors' }],
    })
    const added = Object.keys(workflow).filter(id => !(id in withPool()))
    expect(added).toHaveLength(2)
    const [first, last] = added as [string, string]
    expect(workflow[first]!.inputs).toMatchObject({ lora_name: 'new1.safetensors', model: ['1', 0] })
    expect(workflow['100']!.inputs).toMatchObject({ model: [first, 0], clip: [first, 1] })
    expect(workflow[last]!.inputs).toMatchObject({ lora_name: 'new2.safetensors', model: ['100', 0], clip: ['100', 1] })
    expect(workflow['5']!.inputs.model).toEqual([last, 0])
  })

  it('rejects loras on a locked template', () => {
    expect(() => applyTemplate(locked(), { prompt: 'x', seed: 1, loras: [{ name: 'loraB.safetensors' }] })).toThrow(TemplateError)
  })

  it('rejects the same LoRA twice', () => {
    expect(() => applyTemplate(withPool(), { prompt: 'x', seed: 1, loras: [{ name: 'loraA.safetensors' }, { name: 'loraA.safetensors' }] }))
      .toThrow(TemplateError)
  })
})
