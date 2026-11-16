import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { focusLost, typing } from "./focus.ts";

/**
 * A message that appears as the answer to what the person just did gets focus, so it is read out and scrolled into view. Put the ref
 * on it, with tabIndex -1. Someone already typing in a field again (an answer that came late) keeps their place: the message is
 * still announced (role="alert") and scrolled into view.
 */
export function useAlertFocus<T extends HTMLElement>(message: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!message || !ref.current) return;
    if (typing()) ref.current.scrollIntoView({ block: "nearest" });
    else ref.current.focus();
  }, [message]);
  return ref;
}

/**
 * When `busy` ends, the result (a message with tabIndex -1) gets focus if the button that started the work was disabled
 * meanwhile and focus fell to the page. A person who moved on to something else is left there.
 */
export function useFocusResult<T extends HTMLElement>(busy: boolean): RefObject<T | null> {
  const ref = useRef<T>(null);
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy && focusLost()) ref.current?.focus();
    was.current = busy;
  }, [busy]);
  return ref;
}
