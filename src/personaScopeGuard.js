/**
 * Persona Scope Guard
 *
 * When the chat changes, ST's loadPersonaForCurrentChat picks a persona using:
 *   (1) chat_metadata.persona lock, (2) a persona whose connections list the
 *   current card, (3) power_user.default_persona. If none of those match, ST
 *   leaves whatever persona was previously active — meaning a persona linked
 *   to Card A can bleed into Card B's chat.
 *
 * This guard runs AFTER ST's auto-select and enforces:
 *   • If the active persona is linked (has any connections) but NONE of those
 *     connections match the current card/group, switch away from it.
 *   • Prefer power_user.default_persona; fall back to ST's built-in
 *     default_user_avatar if no default is set.
 *   • Respect manual chat locks (chat_metadata.persona) — those are explicit
 *     and shouldn't be overridden.
 *   • Personas with empty connections are treated as "global" personas and
 *     left alone (user picked them on purpose).
 */

import {
  chat_metadata,
  default_user_avatar,
  eventSource,
  event_types,
  this_chid,
  user_avatar,
  characters,
} from "/script.js";
import {
  getCurrentConnectionObj,
  setUserAvatar,
} from "/scripts/personas.js";
import { power_user } from "/scripts/power-user.js";

import { log } from "./core/log.js";

function safeGetCurrentConnection() {
  try {
    return getCurrentConnectionObj();
  } catch {
    return null;
  }
}

/**
 * Returns true if the current page has no active card/group context (e.g. the
 * welcome screen). The guard should not run in that state — there's nothing
 * to compare against.
 */
function noActiveContext() {
  const idx = Number(this_chid);
  const hasCharacter = Number.isFinite(idx) && Array.isArray(characters) && !!characters[idx];
  // selected_group is exposed implicitly via getCurrentConnectionObj()
  return !hasCharacter && !safeGetCurrentConnection();
}

async function applyScopeGuard() {
  // Skip when nothing is loaded — happens on initial app boot and during
  // chat-switch tear-down.
  if (noActiveContext()) return;

  // Read the live globals — `user_avatar` is a live binding from script.js
  // and reflects whatever ST's auto-select just set it to.
  const activeAvatar = user_avatar;
  if (!activeAvatar) return;

  // Manual chat lock — explicit user choice, never override.
  if (chat_metadata?.persona && chat_metadata.persona === activeAvatar) return;

  const descriptor = power_user?.persona_descriptions?.[activeAvatar];
  if (!descriptor) return;

  const connections = Array.isArray(descriptor.connections) ? descriptor.connections : [];

  // No connections → "global" persona, leave it alone. ST's default-persona
  // pathway and explicit user selections both land here.
  if (connections.length === 0) return;

  const current = safeGetCurrentConnection();
  if (!current) return;

  const matchesCurrent = connections.some(
    (c) => c && c.type === current.type && c.id === current.id
  );
  if (matchesCurrent) return; // persona is correctly scoped to this card/group

  // Active persona is linked to OTHER cards/groups but not this one.
  // Step it down to the global default, or ST's built-in avatar.
  const fallback =
    power_user?.default_persona && power_user.default_persona !== activeAvatar
      ? power_user.default_persona
      : default_user_avatar;

  if (!fallback || fallback === activeAvatar) return;

  log(
    `Scope guard: active persona "${activeAvatar}" is linked to a different ` +
      `card/group than the current one (${current.type}:${current.id}); ` +
      `falling back to "${fallback}".`
  );

  try {
    await setUserAvatar(fallback, {
      toastPersonaNameChange: false,
      navigateToCurrent: true,
    });
  } catch (err) {
    console.warn("[PME] Scope guard failed to apply fallback persona", err);
  }
}

let installed = false;

export function installPersonaScopeGuard() {
  if (installed) return;
  installed = true;

  // Run AFTER ST's loadPersonaForCurrentChat (also a CHAT_CHANGED handler).
  // ST's handler is async but reads/writes synchronously in its hot path;
  // a microtask + small timeout is enough to land after it without depending
  // on registration order.
  eventSource.on(event_types.CHAT_CHANGED, () => {
    setTimeout(() => {
      applyScopeGuard().catch((err) =>
        console.warn("[PME] Scope guard error", err)
      );
    }, 100);
  });
}
