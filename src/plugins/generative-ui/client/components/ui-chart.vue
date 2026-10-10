<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue'
import {
  ArcElement, BarController, BarElement, CategoryScale, Chart, DoughnutController, Filler, Legend,
  LinearScale, LineController, LineElement, PieController, PointElement, Tooltip, type ChartConfiguration,
} from 'chart.js'
import { useTheme } from '@/client/composables/use-theme'
import { isElement } from '../runtime'

Chart.register(
  ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Legend,
  LinearScale, LineController, LineElement, PieController, PointElement, Tooltip,
)

export type ChartKind = 'bar' | 'line' | 'area' | 'pie'
interface SeriesProps { category?: string, values?: unknown[] }
interface ChartProps {
  labels?: unknown[]
  series?: unknown[]
  values?: unknown[]
  variant?: string
  xLabel?: string
  yLabel?: string
}

const props = defineProps<{ kind: ChartKind, chart: ChartProps }>()
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const { resolved } = useTheme()
const instance = shallowRef<Chart | null>(null)

/** Canvas wants a concrete colour; the theme speaks oklch() through custom properties. */
function cssColor(variable: string, alpha = 1): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim()
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe || !raw) return `rgba(128, 128, 128, ${alpha})`
  probe.fillStyle = raw
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const labels = computed(() => (props.chart.labels ?? []).map(label => String(label ?? '')))
const series = computed(() => (props.chart.series ?? [])
  .filter(item => isElement<SeriesProps>(item))
  .map(item => ({ name: String(item.props.category ?? ''), values: (item.props.values ?? []).map(Number) })))
const tall = computed(() => props.kind === 'pie' ? 'h-64' : 'h-56')

function config(): ChartConfiguration {
  // The theme's chart ramp is greyscale; lead with the step that contrasts most with the card.
  const order = resolved.value === 'dark' ? [1, 2, 3, 4, 5] : [2, 1, 4, 3, 5]
  const palette = order.map(index => `--chart-${index}`)
  const color = (index: number, alpha = 1) => cssColor(palette[index % palette.length]!, alpha)
  const text = cssColor('--muted-foreground')
  const grid = cssColor('--border')
  const font = { family: getComputedStyle(document.body).fontFamily, size: 11 }
  const legend = { labels: { color: text, font, boxWidth: 10, boxHeight: 10 }, position: 'bottom' as const }
  if (props.kind === 'pie') {
    const values = (props.chart.values ?? []).map(Number)
    return {
      type: props.chart.variant === 'donut' ? 'doughnut' : 'pie',
      data: {
        labels: labels.value,
        datasets: [{ data: values, backgroundColor: values.map((_, index) => color(index)), borderColor: cssColor('--card'), borderWidth: 2 }],
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend } },
    }
  }
  const stacked = props.chart.variant === 'stacked'
  const axis = (title?: string) => ({
    stacked,
    ticks: { color: text, font, maxRotation: 0, autoSkip: true },
    grid: { color: grid },
    border: { display: false },
    title: { display: Boolean(title), text: title ?? '', color: text, font },
  })
  return {
    type: props.kind === 'bar' ? 'bar' : 'line',
    data: {
      labels: labels.value,
      datasets: series.value.map((item, index) => ({
        label: item.name,
        data: item.values,
        backgroundColor: props.kind === 'area' ? color(index, 0.25) : color(index),
        borderColor: color(index),
        borderWidth: props.kind === 'bar' ? 0 : 2,
        borderRadius: props.kind === 'bar' ? 4 : 0,
        fill: props.kind === 'area',
        tension: 0.3,
        pointRadius: props.kind === 'bar' ? 0 : 2,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { ...legend, display: series.value.length > 1 } },
      scales: { x: { ...axis(props.chart.xLabel), grid: { display: false } }, y: axis(props.chart.yLabel) },
    },
  }
}

function draw() {
  instance.value?.destroy()
  instance.value = canvas.value ? new Chart(canvas.value, config()) : null
}

onMounted(draw)
// Rebuilt rather than patched: a theme flip changes every colour, and a reactive expression can
// change the data; both are rare next to the cost of getting a partial update wrong.
watch([() => JSON.stringify(props.chart), () => props.kind, resolved], draw)
onBeforeUnmount(() => instance.value?.destroy())
</script>

<template lang="pug">
.relative.w-full.min-w-0(:class="tall")
  canvas(ref="canvas")
</template>
