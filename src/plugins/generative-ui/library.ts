/**
 * The component library the model writes against, shared by both halves: the server builds it with
 * null renderers to parse and to generate the prompt, the client swaps in Vue renderers. Neither
 * Vue nor `@openuidev/vue-lang` may be imported here — the Durable Object loads this file.
 *
 * Component names, descriptions, prop schemas, the action schema and several prompt notes are
 * adapted from OpenUI's `packages/react-ui/src/genui-lib/` (https://github.com/thesysdev/openui),
 * Copyright (c) 2011-2024 Thesys Inc., MIT License. See NOTICE.md.
 */
import { z } from 'zod'
import {
  createLibrary,
  defineComponent,
  markReactive,
  tagSchemaId,
  type ComponentGroup,
  type DefinedComponent,
  type Library,
  type PromptOptions,
} from '@openuidev/lang-core'

export const ROOT_COMPONENT = 'Stack'

/** lang-core's equivalent of react-lang's `reactive()`: the prop accepts a `$variable` binding. */
function reactive<T extends z.ZodType>(schema: T): T {
  markReactive(schema)
  return schema
}

function component<T extends z.ZodObject>(name: string, description: string, props: T) {
  return defineComponent<T, null>({ name, description, props, component: null })
}

const actionSchema = z.union([
  z.object({ type: z.literal('open_url'), url: z.string() }),
  z.object({ type: z.literal('continue_conversation'), context: z.string().optional() }),
  z.object({ type: z.string(), params: z.record(z.string(), z.any()).optional() }),
])
tagSchemaId(actionSchema, 'ActionExpression')

const rulesSchema = z.object({
  required: z.boolean().optional(),
  email: z.boolean().optional(),
  url: z.boolean().optional(),
  numeric: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
}).optional()

const children = z.array(z.any())
const gap = z.enum(['none', 's', 'm', 'l']).optional()

// ── Layout ──

const Stack = component('Stack', 'Vertical layout; the root of every UI. gap: "none"|"s"|"m"|"l" (default "m").', z.object({
  children,
  gap,
}))
const Row = component('Row', 'Horizontal layout. Children share the width equally and wrap onto new lines on a narrow (phone) screen. Use for side-by-side Stats, Cards or Tags.', z.object({
  children,
  gap,
  align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
}))
const Card = component('Card', 'Bordered container grouping related content, with an optional title and description. Cards placed in a Row share the width.', z.object({
  children,
  title: z.string().optional(),
  description: z.string().optional(),
}))
const Separator = component('Separator', 'Horizontal divider between sections.', z.object({}))
const TabItem = component('TabItem', 'value is a unique id, trigger is the tab label, content is an array of components.', z.object({
  value: z.string(),
  trigger: z.string(),
  content: children,
}))
const Tabs = component('Tabs', 'Tabbed container for alternative views of the same topic.', z.object({
  items: z.array(TabItem.ref),
}))

// ── Content ──

const TextContent = component('TextContent', 'Text block; supports markdown. size: "small"|"default"|"large"|"small-heavy"|"large-heavy".', z.object({
  text: z.string(),
  size: z.enum(['small', 'default', 'large', 'small-heavy', 'large-heavy']).optional(),
}))
const Callout = component('Callout', 'Highlighted banner for a tip, result, warning or error.', z.object({
  variant: z.enum(['info', 'success', 'warning', 'error', 'neutral']),
  title: z.string(),
  description: z.string().optional(),
}))
const Stat = component('Stat', 'One key number (KPI) with a label. value may be an expression over $variables. delta is a short change such as "+12%", coloured by trend.', z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  delta: z.string().optional(),
  trend: z.enum(['up', 'down', 'neutral']).optional(),
  hint: z.string().optional(),
}))
const Tag = component('Tag', 'Small coloured badge.', z.object({
  text: z.string(),
  variant: z.enum(['neutral', 'info', 'success', 'warning', 'danger']).optional(),
}))
const Progress = component('Progress', 'Horizontal progress bar; value out of max (default 100).', z.object({
  value: z.number(),
  max: z.number().optional(),
  label: z.string().optional(),
}))
const Table = component('Table', 'Row-oriented data table: columns are header labels, each row is an array of cells in column order. A cell may be text, a number or a Tag. Scrolls sideways on narrow screens.', z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.any())),
}))

// ── Charts ──

const Series = component('Series', 'One named data series; values align with the chart labels.', z.object({
  category: z.string(),
  values: z.array(z.number()),
}))
const BarChart = component('BarChart', 'Vertical bars; compare values across categories with one or more series.', z.object({
  labels: z.array(z.string()),
  series: z.array(Series.ref),
  variant: z.enum(['grouped', 'stacked']).optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
}))
const LineChart = component('LineChart', 'Lines over categories; trends and continuous data over time.', z.object({
  labels: z.array(z.string()),
  series: z.array(Series.ref),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
}))
const AreaChart = component('AreaChart', 'Filled area under lines; cumulative totals or volume over time.', z.object({
  labels: z.array(z.string()),
  series: z.array(Series.ref),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
}))
const PieChart = component('PieChart', 'Share of a whole; labels and values are parallel arrays.', z.object({
  labels: z.array(z.string()),
  values: z.array(z.number()),
  variant: z.enum(['pie', 'donut']).optional(),
}))

// ── Buttons ──

const Button = component('Button', 'Clickable button. Without an action it sends its label to the assistant as the user\'s message.', z.object({
  label: z.string(),
  action: actionSchema.optional(),
  variant: z.enum(['primary', 'secondary', 'ghost']).optional(),
}))
const Buttons = component('Buttons', 'Group of Button components. direction: "row" (default) | "column".', z.object({
  buttons: z.array(Button.ref),
  direction: z.enum(['row', 'column']).optional(),
}))

// ── Forms ──

const Input = component('Input', 'Single-line text field.', z.object({
  name: z.string(),
  placeholder: z.string().optional(),
  type: z.enum(['text', 'email', 'number', 'url']).optional(),
  rules: rulesSchema,
  value: reactive(z.string().optional()),
}))
const TextArea = component('TextArea', 'Multi-line text field.', z.object({
  name: z.string(),
  placeholder: z.string().optional(),
  rows: z.number().optional(),
  rules: rulesSchema,
  value: reactive(z.string().optional()),
}))
const SelectItem = component('SelectItem', 'Option for Select.', z.object({
  value: z.string(),
  label: z.string(),
}))
const Select = component('Select', 'Dropdown choice.', z.object({
  name: z.string(),
  items: z.array(SelectItem.ref),
  placeholder: z.string().optional(),
  rules: rulesSchema,
  value: reactive(z.string().optional()),
}))
const Slider = component('Slider', 'Numeric slider showing its current value. Bind value to a $variable to drive live calculations.', z.object({
  name: z.string(),
  min: z.number(),
  max: z.number(),
  step: z.number().optional(),
  value: reactive(z.number().optional()),
  unit: z.string().optional(),
}))
const Switch = component('Switch', 'On/off toggle with a label.', z.object({
  name: z.string(),
  label: z.string(),
  value: reactive(z.boolean().optional()),
  description: z.string().optional(),
}))
const Checkbox = component('Checkbox', 'Checkbox with a label.', z.object({
  name: z.string(),
  label: z.string(),
  value: reactive(z.boolean().optional()),
}))
const FormControl = component('FormControl', 'Field with a label, an input component and optional hint text.', z.object({
  label: z.string(),
  input: z.union([Input.ref, TextArea.ref, Select.ref, Slider.ref, Switch.ref, Checkbox.ref]),
  hint: z.string().optional(),
}))
const Form = component('Form', 'Form container with fields and explicit action buttons; its field values are sent along when a button continues the conversation.', z.object({
  name: z.string(),
  buttons: Buttons.ref,
  fields: z.array(FormControl.ref).default([]),
}))

// ── Escape hatch ──

const HtmlApp = component('HtmlApp', 'A complete self-contained HTML document (inline <style> and <script>, no external requests) run in a sandboxed frame, auto-sized up to about 640px tall. Only for games, simulations or visualisations the other components cannot express. It cannot talk to the chat. Design for a 360px-wide phone screen, support touch input, and set its own background and text colours.', z.object({
  title: z.string(),
  html: z.string(),
}))

export const componentDefinitions = [
  Stack, Row, Card, Separator, Tabs, TabItem,
  TextContent, Callout, Stat, Tag, Progress, Table,
  BarChart, LineChart, AreaChart, PieChart, Series,
  Button, Buttons,
  Form, FormControl, Input, TextArea, Select, SelectItem, Slider, Switch, Checkbox,
  HtmlApp,
] as const

export type ComponentName = (typeof componentDefinitions)[number]['name']

export const componentGroups: ComponentGroup[] = [
  {
    name: 'Layout',
    components: ['Stack', 'Row', 'Card', 'Separator', 'Tabs', 'TabItem'],
    notes: [
      '- The screen is usually a phone about 360px wide: prefer vertical Stacks, and at most 2-3 items per Row.',
      '- Use Tabs for alternative views (e.g. one tab per product) instead of very wide layouts.',
      '- Show/hide: $mode == "advanced" ? advancedCard : null',
    ],
  },
  {
    name: 'Content',
    components: ['TextContent', 'Callout', 'Stat', 'Tag', 'Progress', 'Table'],
    notes: [
      '- KPI row: Row([Stat("Revenue", "$48.2k", "+8%", "up"), Stat("Churn", "1.8%", "-0.3%", "down")])',
      '- Table: Table(["Model", "Price"], [["A", "$999"], ["B", Tag("Sold out", "danger")]])',
    ],
  },
  {
    name: 'Charts',
    components: ['BarChart', 'LineChart', 'AreaChart', 'PieChart', 'Series'],
    notes: [
      '- Charts take parallel arrays: BarChart(["Q1", "Q2"], [Series("Sales", [120, 150])]). Values must be numbers.',
      '- Wrap a chart in a Card with a title.',
    ],
  },
  {
    name: 'Buttons',
    components: ['Button', 'Buttons'],
    notes: [
      '- A button that continues the conversation: Button("Show me cheaper options", Action([@ToAssistant("Show me cheaper options")])). The message is sent as the user\'s next chat message, so write it in the user\'s voice and language.',
      '- Open a link: Button("Docs", Action([@OpenUrl("https://example.com")]), "secondary")',
      '- Local-only buttons change $variables without messaging anyone: Button("Reset", Action([@Reset($amount)]), "ghost")',
    ],
  },
  {
    name: 'Forms',
    components: ['Form', 'FormControl', 'Input', 'TextArea', 'Select', 'SelectItem', 'Slider', 'Switch', 'Checkbox'],
    notes: [
      '- Form(name, buttons, fields). A @ToAssistant button inside a Form sends the message together with every field value.',
      '- rules is an optional object: {required: true, email: true, minLength: 2}. Errors are shown automatically.',
      '- Inputs work outside a Form too; bind them to $variables to drive expressions elsewhere in the UI.',
    ],
  },
  {
    name: 'Escape hatch',
    components: ['HtmlApp'],
    notes: [
      '- HtmlApp holds one complete HTML document as a single string. Escape double quotes inside it or use single quotes in the HTML.',
    ],
  },
]

export const promptExamples: string[] = [
  `Example 1 — Dashboard:

root = Stack([title, kpis, chartCard, tableCard])
title = TextContent("Q3 Sales", "large-heavy")
kpis = Row([Stat("Revenue", "$1.28M", "+12%", "up"), Stat("Orders", "8,412", "-3%", "down")])
chartCard = Card([chart], "Monthly revenue")
chart = BarChart(["Jul", "Aug", "Sep"], [Series("2024", [390, 410, 480]), Series("2023", [350, 380, 400])])
tableCard = Card([tbl], "Top products")
tbl = Table(["Product", "Units", "Status"], [["Widget Pro", 2410, Tag("Hot", "success")], ["Widget Mini", 980, Tag("New", "info")]])`,

  `Example 2 — Live calculator (sliders update the numbers instantly, no assistant round trip):

$km = 40
$fuel = 7.8
$power = 0.6
root = Stack([title, inputs, result])
title = TextContent("EV vs petrol: yearly fuel cost", "large-heavy")
inputs = Card([kmField, fuelField, powerField])
kmField = FormControl("Daily distance", Slider("km", 5, 200, 5, $km, "km"))
fuelField = FormControl("Petrol price", Slider("fuel", 6, 10, 0.1, $fuel, "¥/L"))
powerField = FormControl("Electricity price", Slider("power", 0.3, 1.5, 0.05, $power, "¥/kWh"))
petrol = $km * 365 / 100 * 7 * $fuel
ev = $km * 365 / 100 * 15 * $power
result = Row([Stat("Petrol", "¥" + @Round(petrol, 0)), Stat("EV", "¥" + @Round(ev, 0)), Stat("You save", "¥" + @Round(petrol - ev, 0), null, "up")])`,

  `Example 3 — Form that answers back:

root = Stack([title, form])
title = TextContent("Plan your trip", "large-heavy")
form = Form("trip", btns, [cityField, daysField, styleField])
cityField = FormControl("Destination", Input("city", "e.g. Kyoto", "text", { required: true }))
daysField = FormControl("Days", Slider("days", 1, 14, 1, 5))
styleField = FormControl("Style", Select("style", [SelectItem("relaxed", "Relaxed"), SelectItem("packed", "Packed")]))
btns = Buttons([Button("Make my itinerary", Action([@ToAssistant("Make my itinerary")]), "primary")])`,
]

export const promptRules: string[] = [
  'When asked about data you do not have, use clearly plausible illustrative data and say so in a TextContent.',
  'Keep text short inside the UI; the UI replaces a prose answer, it does not decorate one.',
  'Use @Reset($var1, $var2) to restore defaults, not @Set($var, "").',
  'Never nest Form inside Form.',
]

export const promptOptions: PromptOptions = {
  preamble: 'OpenUI Lang is the language of the `code` argument of render_ui. It describes a UI as statements of the form `name = Expression`.',
  bindings: true,
  toolCalls: false,
  examples: promptExamples,
  additionalRules: promptRules,
}

export function buildLibrary<C>(renderers: (name: ComponentName) => C): Library<C> {
  return createLibrary<C>({
    root: ROOT_COMPONENT,
    componentGroups,
    components: componentDefinitions.map(definition => ({
      ...definition,
      component: renderers(definition.name),
    })) as DefinedComponent<z.ZodObject, C>[],
  })
}
