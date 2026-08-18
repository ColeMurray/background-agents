import type { ClientInfo } from "../types";
import type { ConnectionClassification } from "./ports";

/** Runtime-neutral lifecycle and transport operations for session sockets. */
export interface SocketRegistry<Connection> {
  createUpgradeSockets(): { client: Connection; server: Connection };
  configureAutoPing(request: string, response: string): void;
  acceptClientSocket(connection: Connection, wsId: string): void;
  acceptAndSetSandboxSocket(connection: Connection, sandboxId?: string): { replaced: boolean };
  classify(connection: Connection): ConnectionClassification;
  getSandboxSocket(): Connection | null;
  clearSandboxSocket(): void;
  detachSandboxSocket(code: number, reason: string): void;
  clearSandboxSocketIfMatch(connection: Connection): boolean;
  setClient(connection: Connection, info: ClientInfo): void;
  getClient(connection: Connection): ClientInfo | null;
  removeClient(connection: Connection): ClientInfo | null;
  setClientSynchronizing(connection: Connection, synchronizing: boolean): void;
  isClientSynchronizing(connection: Connection): boolean;
  isClientAuthenticated(connection: Connection): boolean;
  send(connection: Connection, message: string | object): boolean;
  close(connection: Connection, code: number, reason: string): void;
  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (connection: Connection) => void
  ): void;
  enforceAuthTimeout(connection: Connection, wsId: string): Promise<void>;
  getAuthenticatedClients(): IterableIterator<ClientInfo>;
  getConnectedClientCount(): number;
}
