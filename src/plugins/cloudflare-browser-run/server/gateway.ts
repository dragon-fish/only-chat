import type { GatewayProps } from '../runtime/protocol'

/**
 * The one rule the gateway enforces, kept free of Worker imports so it can be tested as a function:
 * a sandbox may open exactly one thing, a WebSocket to the browser session it was created for.
 */
export function gatewayAllows(url: URL, upgrade: string | null, props: GatewayProps): boolean {
  return url.pathname === `/v1/devtools/browser/${props.sessionId}` && upgrade?.toLowerCase() === 'websocket'
}
