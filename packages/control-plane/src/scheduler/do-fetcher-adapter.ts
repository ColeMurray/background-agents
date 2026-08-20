/**
 * Adapts a DurableObjectNamespace + name to the fetch-only callback interface.
 *
 * Used to route automation callbacks to the SchedulerDO via the existing
 * CallbackNotificationService.
 */

import type { FetchClient } from "../platform-ports";

export class DOFetcherAdapter implements FetchClient {
  constructor(
    private readonly ns: DurableObjectNamespace,
    private readonly name: string
  ) {}

  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const stub = this.ns.get(this.ns.idFromName(this.name));
    return stub.fetch(input, init);
  }
}
