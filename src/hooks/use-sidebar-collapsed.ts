'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Whether the desktop sidebar shows icons only. Kept in localStorage so the
// choice survives a refresh and a new login on the same browser. It is a
// per-device preference, not an account setting.
//
// useSyncExternalStore instead of useState + an effect: the server renders
// "expanded", the browser then switches to the stored value without a
// hydration warning, and a second tab stays in step through the `storage`
// event.

const KEY = 'WA-CRM:sidebar-collapsed';
const CHANGE_EVENT = 'WA-CRM:sidebar-collapsed-change';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function readStored(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Private mode / blocked storage: behave as "expanded".
    return false;
  }
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(subscribe, readStored, () => false);

  const toggle = useCallback(() => {
    try {
      window.localStorage.setItem(KEY, readStored() ? '0' : '1');
    } catch {
      // Storage unavailable: the choice just won't persist.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [collapsed, toggle];
}
