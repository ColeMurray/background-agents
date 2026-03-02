/**
 * Adapts a DurableObjectNamespace + name to a Fetcher-compatible interface.
 *
 * Used to route automation callbacks to the SchedulerDO via the existing
 * CallbackNotificationService, which expects a `Fetcher` binding.
 */

export class DOFetcherAdapter implements Fetcher {
  constructor(
    private readonly ns: DurableObjectNamespace,
    private readonly name: string
  ) {}

  fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const stub = this.ns.get(this.ns.idFromName(this.name));
    return stub.fetch(input, init);
  }

  connect(_address: string | SocketAddress, _options?: SocketOptions): Socket {
    throw new Error("DOFetcherAdapter does not support connect()");
  }
}
