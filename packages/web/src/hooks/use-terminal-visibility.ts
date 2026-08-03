"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "terminal-visible";
const CHANGE_EVENT = "terminal-visibility-change";

function subscribe(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

function getSnapshot() {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

function getServerSnapshot() {
  return false;
}

export function useTerminalVisibility() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setTerminalVisibility(visible: boolean) {
  localStorage.setItem(STORAGE_KEY, String(visible));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
