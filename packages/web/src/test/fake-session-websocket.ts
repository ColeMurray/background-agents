import type { ServerMessage } from "@open-inspect/shared/types/server-messages";

export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  sentMessages: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  serverClose(code: number, wasClean = false) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: "", wasClean } as CloseEvent);
  }

  receiveRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  receive(message: ServerMessage) {
    this.receiveRaw(JSON.stringify(message));
  }
}
