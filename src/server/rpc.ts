/** Cloudflare binding calls can return RPC stubs that must not wait for garbage collection. */
export function disposeRpcStub(stub: object): void {
  const dispose = Reflect.get(stub, Symbol.dispose)
  if (typeof dispose === 'function') dispose.call(stub)
}
