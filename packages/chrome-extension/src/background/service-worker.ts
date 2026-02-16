import { DEFAULT_WEB_APP_URL } from "@/lib/constants";
import type { ContentMessage } from "@/shared/types";

// open sidepanel when the extension action button is clicked
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// enable side panel on all pages
chrome.sidePanel.setOptions({ enabled: true });

// route messages between content script and sidepanel
chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    // forward captured elements from content script to sidepanel
    if (message.type === "WRENCH_ELEMENT_CAPTURED") {
      // sidepanel listens via chrome.runtime.onMessage too
      // the message is automatically broadcast to all extension contexts
      sendResponse({ received: true });
    }

    if (message.type === "WRENCH_PICKER_CANCELLED") {
      sendResponse({ received: true });
    }

    if (message.type === "WRENCH_PING") {
      sendResponse({ type: "WRENCH_PONG" });
    }

    // return true to indicate we may respond asynchronously
    return true;
  }
);

// detect real sign-in / sign-out by tracking whether the session cookie exists.
// ignore silent cookie refreshes (nextauth re-signs the jwt on every read) to
// avoid an infinite loop: checkAuth → cookie refresh → onChanged → checkAuth …
let hadSessionCookie = false;

chrome.cookies.onChanged.addListener((changeInfo) => {
  const { cookie, removed, cause } = changeInfo;

  if (
    cookie.name !== "next-auth.session-token" &&
    cookie.name !== "__Secure-next-auth.session-token"
  ) {
    return;
  }

  // "overwrite" means the cookie is being replaced — ignore both the removal
  // and the subsequent set since this is just a token refresh, not a state change
  if (cause === "overwrite") return;

  const nowHasCookie = !removed;

  // only broadcast when auth state actually flips (signed-in ↔ signed-out)
  if (nowHasCookie === hadSessionCookie) return;
  hadSessionCookie = nowHasCookie;

  chrome.runtime.sendMessage({ type: "WRENCH_AUTH_CHANGED" }).catch(() => {
    // no listeners - that's fine
  });
});

// open the web app login page when requested
chrome.runtime.onMessage.addListener(
  (
    message: { type: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (message.type === "WRENCH_OPEN_LOGIN") {
      chrome.tabs.create({ url: `${DEFAULT_WEB_APP_URL}/api/auth/signin` });
      sendResponse({ opened: true });
    }
    return true;
  }
);
