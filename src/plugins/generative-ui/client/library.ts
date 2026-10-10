import { h, type Component, type FunctionalComponent } from 'vue'
import type { ComponentRenderer, Library } from '@openuidev/vue-lang'
import { buildLibrary, type ComponentName } from '../library'
import type { NodeProps } from './runtime'
import UiButton from './components/ui-button.vue'
import UiButtons from './components/ui-buttons.vue'
import UiCallout from './components/ui-callout.vue'
import UiCard from './components/ui-card.vue'
import UiChart, { type ChartKind } from './components/ui-chart.vue'
import UiForm from './components/ui-form.vue'
import UiFormControl from './components/ui-form-control.vue'
import UiHtmlApp from './components/ui-html-app.vue'
import UiInput from './components/ui-input.vue'
import UiProgress from './components/ui-progress.vue'
import UiRow from './components/ui-row.vue'
import UiSelect from './components/ui-select.vue'
import UiSeparator from './components/ui-separator.vue'
import UiSlider from './components/ui-slider.vue'
import UiStack from './components/ui-stack.vue'
import UiStat from './components/ui-stat.vue'
import UiTable from './components/ui-table.vue'
import UiTabs from './components/ui-tabs.vue'
import UiTag from './components/ui-tag.vue'
import UiTextContent from './components/ui-text-content.vue'
import UiToggle from './components/ui-toggle.vue'

type Props = NodeProps<Record<string, unknown>>

/** Read by its parent (a chart, a Select, Tabs) and never drawn on its own. */
const Nothing: FunctionalComponent = () => null

function chart(kind: ChartKind): FunctionalComponent<Props> {
  const component: FunctionalComponent<Props> = props => h(UiChart, { kind, chart: props.props })
  component.props = ['props', 'renderNode']
  return component
}

function withProps(target: Component, extra: Record<string, unknown>): FunctionalComponent<Props> {
  const component: FunctionalComponent<Props> = props => h(target, { ...props, ...extra })
  component.props = ['props', 'renderNode']
  return component
}

const renderers: Record<ComponentName, Component> = {
  Stack: UiStack,
  Row: UiRow,
  Card: UiCard,
  Separator: UiSeparator,
  Tabs: UiTabs,
  TabItem: Nothing,
  TextContent: UiTextContent,
  Callout: UiCallout,
  Stat: UiStat,
  Tag: UiTag,
  Progress: UiProgress,
  Table: UiTable,
  BarChart: chart('bar'),
  LineChart: chart('line'),
  AreaChart: chart('area'),
  PieChart: chart('pie'),
  Series: Nothing,
  Button: UiButton,
  Buttons: UiButtons,
  Form: UiForm,
  FormControl: UiFormControl,
  Input: UiInput,
  TextArea: withProps(UiInput, { multiline: true }),
  Select: UiSelect,
  SelectItem: Nothing,
  Slider: UiSlider,
  Switch: withProps(UiToggle, { kind: 'switch' }),
  Checkbox: withProps(UiToggle, { kind: 'checkbox' }),
  HtmlApp: UiHtmlApp,
}

export const clientLibrary = buildLibrary(name => renderers[name] as ComponentRenderer) as Library
