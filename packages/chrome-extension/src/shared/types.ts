// extension-specific types

/** captured element context from the content script */
export interface CapturedElement {
  /** html tag name */
  tagName: string;
  /** css selector path */
  selector: string;
  /** outerhtml of the element (truncated) */
  html: string;
  /** react component tree if detected */
  reactTree: ReactComponentNode | null;
  /** page url where element was captured */
  pageUrl: string;
  /** timestamp of capture */
  capturedAt: number;
}

/** serialized react component node */
export interface ReactComponentNode {
  /** component display name or tag */
  name: string;
  /** subset of props (serialized) */
  props: Record<string, string>;
  /** child component nodes */
  children: ReactComponentNode[];
}

/** messages between content script and extension */
export type ContentMessage =
  | { type: "WRENCH_START_PICKER" }
  | { type: "WRENCH_CANCEL_PICKER" }
  | { type: "WRENCH_ELEMENT_CAPTURED"; payload: CapturedElement }
  | { type: "WRENCH_PICKER_CANCELLED" }
  | { type: "WRENCH_PING" }
  | { type: "WRENCH_PONG" };

/** sidebar view state */
export type SidebarView = "sessions" | "chat" | "new-session";
