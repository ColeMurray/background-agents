/**
 * main content script entry point.
 * listens for messages from the extension sidepanel/background
 * and activates the element picker on demand.
 */

import { startPicker, stopPicker } from "@/content/element-picker";
import type { ContentMessage, CapturedElement } from "@/shared/types";

// listen for messages from the extension
chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    switch (message.type) {
      case "WRENCH_START_PICKER":
        startPicker((captured: CapturedElement) => {
          // send captured element back to extension
          chrome.runtime.sendMessage({
            type: "WRENCH_ELEMENT_CAPTURED",
            payload: captured,
          } satisfies ContentMessage);
        });
        sendResponse({ started: true });
        break;

      case "WRENCH_CANCEL_PICKER":
        stopPicker();
        sendResponse({ cancelled: true });
        break;

      case "WRENCH_PING":
        sendResponse({ type: "WRENCH_PONG" });
        break;

      default:
        break;
    }

    // return true to indicate we may respond asynchronously
    return true;
  }
);

// log that the content script loaded (useful for debugging)
console.debug("[wrench] content script loaded");
