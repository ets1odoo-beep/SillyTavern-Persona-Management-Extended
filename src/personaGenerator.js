import {
  characters,
  chat_metadata,
  default_user_avatar,
  generateQuietPrompt,
  getCurrentChatId,
  getRequestHeaders,
  saveSettingsDebounced,
  this_chid,
} from "/script.js";
import { saveMetadataDebounced } from "/scripts/extensions.js";
import {
  getCurrentConnectionObj,
  getUserAvatars,
  initPersona,
  setUserAvatar,
} from "/scripts/personas.js";
import { power_user } from "/scripts/power-user.js";
import { Popup, POPUP_TYPE } from "/scripts/popup.js";
import { SlashCommandParser } from "/scripts/slash-commands/SlashCommandParser.js";

import {
  getPersonaGeneratorProfiles,
  getSelectedPersonaGeneratorProfile,
  isPersonaGeneratorEnabled,
} from "../settings.js";
import { UI_EVENTS } from "./ui/uiBus.js";

const GENERATED_SOURCE = "pme_dynamic_persona_generator";
let wandBus = null;

function slugifyName(name) {
  const slug = String(name ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48);
  return slug || "Persona";
}

function getCurrentCharacter() {
  const idx = Number(this_chid);
  if (!Number.isFinite(idx) || !Array.isArray(characters)) return null;
  return characters[idx] ?? null;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function fieldBlock(label, value) {
  const text = normalizeText(value);
  return text ? `## ${label}\n${text}` : "";
}

function collectCardContext(profile) {
  const char = getCurrentCharacter();
  if (!char) return null;

  const fields = profile?.includeFields ?? {};
  const blocks = [fieldBlock("Card name", char.name)];

  if (fields.description !== false) {
    blocks.push(fieldBlock("Description", char.description));
  }
  if (fields.personality !== false) {
    blocks.push(fieldBlock("Personality", char.personality));
  }
  if (fields.scenario !== false) {
    blocks.push(fieldBlock("Scenario", char.scenario));
  }
  if (fields.firstMessage !== false) {
    blocks.push(fieldBlock("First message", char.first_mes));
  }
  if (fields.examples !== false) {
    blocks.push(fieldBlock("Example dialogue", char.mes_example));
  }
  if (fields.creatorNotes === true) {
    blocks.push(fieldBlock("Creator notes", char.creator_notes));
  }
  if (fields.systemPrompt === true) {
    blocks.push(fieldBlock("System prompt", char.system_prompt));
  }
  if (fields.postHistoryInstructions === true) {
    blocks.push(
      fieldBlock("Post-history instructions", char.post_history_instructions)
    );
  }

  return {
    character: char,
    cardText: blocks.filter(Boolean).join("\n\n"),
  };
}

function applyMacros(template, values) {
  let out = String(template ?? "");
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(String(value ?? ""));
  }
  return out;
}

function buildPrompt({ profile, userInstructions, previousDraft, modifier }) {
  const context = collectCardContext(profile);
  if (!context) throw new Error("No current character card is selected.");

  const char = context.character;
  const macros = {
    card_name: normalizeText(char.name),
    card_description: normalizeText(char.description),
    card_personality: normalizeText(char.personality),
    card_scenario: normalizeText(char.scenario),
    card_first_message: normalizeText(char.first_mes),
    card_examples: normalizeText(char.mes_example),
    user_instructions: normalizeText(userInstructions),
    previous_draft: normalizeText(previousDraft),
  };

  const baseInstruction = applyMacros(profile.baseInstruction, macros);
  const modalInstruction = applyMacros(profile.modalInstruction, macros);
  const outputInstruction =
    profile.outputFormat === "text"
      ? "If JSON is impossible, return a complete persona description with a clear name line."
      : "Return valid JSON only. Do not wrap it in markdown fences.";

  return [
    baseInstruction,
    modalInstruction ? `Additional profile instruction:\n${modalInstruction}` : "",
    `Current card context:\n${context.cardText}`,
    userInstructions
      ? `User requested changes for this persona:\n${userInstructions}`
      : "",
    previousDraft
      ? `Previous generated draft:\n${previousDraft}\n\nRegenerate it using this modifier:\n${modifier}`
      : "",
    outputInstruction,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function stripCodeFence(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : raw;
}

function parseDraft(reply) {
  const raw = stripCodeFence(reply);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        name: normalizeText(parsed.name),
        title: normalizeText(parsed.title),
        description: normalizeText(parsed.description),
        raw,
      };
    }
  } catch {
    // Plain-text fallback below.
  }

  const lines = raw.split(/\r?\n/);
  const nameLine = lines.find((line) => /^name\s*:/i.test(line));
  const titleLine = lines.find((line) => /^title\s*:/i.test(line));
  const name = nameLine?.replace(/^name\s*:/i, "").trim() || "";
  const title = titleLine?.replace(/^title\s*:/i, "").trim() || "";
  const description = raw
    .replace(/^name\s*:.*$/gim, "")
    .replace(/^title\s*:.*$/gim, "")
    .trim();

  return { name, title, description: description || raw, raw };
}

function getDraftFromUi(content) {
  return {
    name: normalizeText(content.querySelector("#pme-gen-name")?.value),
    title: normalizeText(content.querySelector("#pme-gen-title")?.value),
    description: normalizeText(
      content.querySelector("#pme-gen-description")?.value
    ),
  };
}

function setDraftToUi(content, draft) {
  content.querySelector("#pme-gen-name").value = draft.name ?? "";
  content.querySelector("#pme-gen-title").value = draft.title ?? "";
  content.querySelector("#pme-gen-description").value = draft.description ?? "";
}

async function uploadDefaultAvatar(avatarId) {
  const fetchResult = await fetch(default_user_avatar);
  const blob = await fetchResult.blob();
  const file = new File([blob], "avatar.png", { type: "image/png" });
  const formData = new FormData();
  formData.append("avatar", file);
  formData.append("overwrite_name", avatarId);

  const response = await fetch("/api/avatars/upload", {
    method: "POST",
    headers: getRequestHeaders({ omitContentType: true }),
    cache: "no-cache",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload persona avatar: ${response.statusText}`);
  }

  await getUserAvatars(true, avatarId);
}

function resolveConnectionMode(profile, content) {
  if (profile.connectionMode !== "manual") return profile.connectionMode;
  const selected = content.querySelector("#pme-gen-save-connection")?.value;
  return String(selected || "character");
}

function connectionModeLabel(mode) {
  switch (mode) {
    case "chat":
      return "Current chat only";
    case "character_and_chat":
      return "Character and chat";
    case "manual":
      return "Ask on save";
    case "character":
    default:
      return "Current character card only";
  }
}

function getAiConnectionProfiles() {
  return /** @type {any[]} */ (
    SillyTavern.getContext()?.extensionSettings?.connectionManager?.profiles ??
    []
  );
}

function getAiProfileName(profileIdOrName) {
  const raw = normalizeText(profileIdOrName);
  if (!raw) return "";
  const profile = getAiConnectionProfiles().find(
    (p) => p?.id === raw || p?.name === raw
  );
  return normalizeText(profile?.name ?? raw);
}

async function getCurrentAiProfileName() {
  try {
    const cmd = SlashCommandParser.commands["profile"];
    if (!cmd) return "";
    const result = await cmd.callback(/** @type {any} */ ({}), "");
    return (typeof result === "string" ? result : "").trim();
  } catch {
    return "";
  }
}

async function switchAiProfile(name) {
  const profileName = normalizeText(name);
  if (!profileName) return;
  try {
    const cmd = SlashCommandParser.commands["profile"];
    if (cmd) await cmd.callback(/** @type {any} */ ({}), profileName);
  } catch (err) {
    console.warn("[PME] Failed to switch AI connection profile", err);
  }
}

function applyConnectionProfile({ avatarId, profile, content }) {
  const descriptor = power_user.persona_descriptions?.[avatarId];
  if (!descriptor) return null;

  const mode = resolveConnectionMode(profile, content);
  const currentConnection = getCurrentConnectionObj();

  if (profile.clearExistingConnections !== false) {
    descriptor.connections = [];
  } else {
    descriptor.connections ??= [];
  }

  if ((mode === "character" || mode === "character_and_chat") && currentConnection) {
    descriptor.connections = [currentConnection];
  }

  if (mode === "chat" || mode === "character_and_chat") {
    chat_metadata.persona = avatarId;
    saveMetadataDebounced();
  }

  if (profile.removeDefaultEligibility !== false && power_user.default_persona === avatarId) {
    power_user.default_persona = null;
  }

  return { mode, currentConnection };
}

async function saveDraft({ content, profile, bus }) {
  const draft = getDraftFromUi(content);
  const char = getCurrentCharacter();
  if (!draft.description) {
    toastr.warning("Generate or enter a persona description first.", "PME");
    return;
  }

  const baseName =
    draft.name ||
    `${normalizeText(char?.name) || "Card"} Persona`;
  const avatarId = `${Date.now()}-${slugifyName(baseName)}.png`;

  await initPersona(avatarId, baseName, draft.description, draft.title, {
    silent: false,
  });
  await uploadDefaultAvatar(avatarId);

  const descriptor = power_user.persona_descriptions[avatarId];
  descriptor.pme ??= {};
  descriptor.pme.linkedToNative = true;

  const connection = applyConnectionProfile({ avatarId, profile, content });
  descriptor.pme.generated = {
    source: GENERATED_SOURCE,
    profileId: profile.id,
    profileName: profile.name,
    connectionMode: connection?.mode ?? profile.connectionMode,
    connectionTarget: connection?.currentConnection ?? null,
    characterName: normalizeText(char?.name),
    characterAvatar: normalizeText(char?.avatar),
    chatId: getCurrentChatId?.() ?? null,
    createdAt: new Date().toISOString(),
  };

  saveSettingsDebounced();

  if (profile.autoSelectAfterSave !== false) {
    await setUserAvatar(avatarId, {
      toastPersonaNameChange: false,
      navigateToCurrent: false,
    });
  }

  bus?.emit?.(UI_EVENTS.PERSONA_LIST_INVALIDATED, {});
  bus?.emit?.(UI_EVENTS.PERSONA_CHANGED, { avatarId });
  toastr.success(`Saved and linked ${baseName}`, "PME");
}

async function generateDraft({ content, previousDraft = "" }) {
  const profileId = content.querySelector("#pme-gen-profile")?.value;
  const profile =
    getPersonaGeneratorProfiles().find((p) => p.id === profileId) ??
    getSelectedPersonaGeneratorProfile();
  const userInstructions = content.querySelector("#pme-gen-instruction")?.value;
  const modifier = content.querySelector("#pme-gen-modifier")?.value;
  const prompt = buildPrompt({
    profile,
    userInstructions,
    previousDraft,
    modifier,
  });

  const jsonSchema =
    profile.outputFormat === "json"
      ? {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
          },
          required: ["name", "description"],
        }
      : null;

  const targetProfile = getAiProfileName(profile.aiConnectionProfile);
  let previousProfile = "";
  if (targetProfile) {
    previousProfile = await getCurrentAiProfileName();
    if (previousProfile !== targetProfile) {
      await switchAiProfile(targetProfile);
    } else {
      previousProfile = "";
    }
  }

  let reply = "";
  try {
    reply = await generateQuietPrompt({
      quietPrompt: prompt,
      responseLength: Number(profile.responseLength) || 700,
      jsonSchema,
      trimToSentence: false,
    });
  } finally {
    if (previousProfile) {
      await switchAiProfile(previousProfile);
    }
  }

  const draft = parseDraft(reply);
  if (!draft.name) {
    draft.name = `${normalizeText(getCurrentCharacter()?.name) || "Card"} Persona`;
  }
  setDraftToUi(content, draft);
  content.dataset.previousDraft = JSON.stringify(draft);
}

function setBusy(content, busy) {
  content.classList.toggle("pme-gen-busy", busy);
  content
    .querySelectorAll("button, input, select, textarea")
    .forEach((node) => {
      if (node.id === "pme-gen-close") return;
      node.disabled = busy;
    });
}

function buildGeneratorModal(bus) {
  const content = document.createElement("div");
  content.className = "pme-generator-modal";
  const profiles = getPersonaGeneratorProfiles();
  const selected = getSelectedPersonaGeneratorProfile();

  content.innerHTML = `
    <div class="pme-gen-header">
      <div>
        <div class="pme-card-title">Generate Linked Persona</div>
        <div class="pme-adv-help">Creates a normal SillyTavern persona from the current card, then applies the selected connection profile.</div>
      </div>
    </div>
    <label>Persona generation profile</label>
    <select id="pme-gen-profile" class="text_pole"></select>
    <div class="pme-generator-grid">
      <label>Max response length<input id="pme-gen-response-length-view" class="text_pole" type="text" readonly /></label>
      <label>AI connection profile<input id="pme-gen-ai-profile-view" class="text_pole" type="text" readonly /></label>
      <label>Persona link target<input id="pme-gen-connection-view" class="text_pole" type="text" readonly /></label>
    </div>
    <label>Profile prompt</label>
    <textarea id="pme-gen-prompt-view" class="text_pole textarea_compact" rows="5" readonly></textarea>
    <label>Your requested persona changes</label>
    <textarea id="pme-gen-instruction" class="text_pole textarea_compact" rows="4"></textarea>
    <div class="pme-gen-actions">
      <button id="pme-gen-generate" class="menu_button" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
      <button id="pme-gen-regenerate" class="menu_button" type="button"><i class="fa-solid fa-rotate"></i> Regenerate</button>
    </div>
    <div class="pme-generator-grid">
      <label>Name<input id="pme-gen-name" class="text_pole" type="text" /></label>
      <label>Title<input id="pme-gen-title" class="text_pole" type="text" /></label>
      <label id="pme-gen-manual-wrap">Connection<select id="pme-gen-save-connection" class="text_pole">
        <option value="character">Current character card only</option>
        <option value="chat">Current chat only</option>
        <option value="character_and_chat">Character and chat</option>
      </select></label>
    </div>
    <label>Persona description</label>
    <textarea id="pme-gen-description" class="text_pole textarea_compact" rows="10"></textarea>
    <label>Modifier for regenerate</label>
    <textarea id="pme-gen-modifier" class="text_pole textarea_compact" rows="3"></textarea>
    <div class="pme-gen-actions">
      <button id="pme-gen-save" class="menu_button" type="button"><i class="fa-solid fa-link"></i> Save & Link</button>
    </div>
  `;

  const profileSelect = content.querySelector("#pme-gen-profile");
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    profileSelect.appendChild(option);
  }
  profileSelect.value = selected.id;

  function activeProfile() {
    return (
      getPersonaGeneratorProfiles().find((p) => p.id === profileSelect.value) ??
      getSelectedPersonaGeneratorProfile()
    );
  }

  function refreshProfileNote() {
    const profile = activeProfile();
    content.querySelector("#pme-gen-instruction").value =
      profile.modalInstruction ?? "";
    content.querySelector("#pme-gen-response-length-view").value = String(
      profile.responseLength ?? ""
    );
    content.querySelector("#pme-gen-connection-view").value =
      connectionModeLabel(profile.connectionMode);
    content.querySelector("#pme-gen-ai-profile-view").value =
      getAiProfileName(profile.aiConnectionProfile) || "<Same as current>";
    content.querySelector("#pme-gen-prompt-view").value =
      profile.baseInstruction ?? "";
    content
      .querySelector("#pme-gen-manual-wrap")
      .classList.toggle("displayNone", profile.connectionMode !== "manual");
  }

  profileSelect.addEventListener("change", refreshProfileNote);
  refreshProfileNote();

  content.querySelector("#pme-gen-generate").addEventListener("click", async () => {
    try {
      setBusy(content, true);
      await generateDraft({ content });
    } catch (err) {
      console.error("[PME] Persona generation failed", err);
      toastr.error(String(err?.message ?? err), "Persona generation failed");
    } finally {
      setBusy(content, false);
    }
  });

  content
    .querySelector("#pme-gen-regenerate")
    .addEventListener("click", async () => {
      try {
        setBusy(content, true);
        const previousDraft =
          content.dataset.previousDraft ||
          JSON.stringify(getDraftFromUi(content));
        await generateDraft({ content, previousDraft });
      } catch (err) {
        console.error("[PME] Persona regeneration failed", err);
        toastr.error(String(err?.message ?? err), "Persona regeneration failed");
      } finally {
        setBusy(content, false);
      }
    });

  content.querySelector("#pme-gen-save").addEventListener("click", async () => {
    try {
      setBusy(content, true);
      await saveDraft({ content, profile: activeProfile(), bus });
    } catch (err) {
      console.error("[PME] Persona save failed", err);
      toastr.error(String(err?.message ?? err), "Persona save failed");
    } finally {
      setBusy(content, false);
    }
  });

  return content;
}

export async function openPersonaGenerator({ bus = null } = {}) {
  if (!isPersonaGeneratorEnabled()) {
    toastr.warning("Persona generator is disabled in PME settings.", "PME");
    return;
  }
  if (!getCurrentCharacter()) {
    toastr.warning("Open a character chat before generating a persona.", "PME");
    return;
  }

  const popup = new Popup(buildGeneratorModal(bus), POPUP_TYPE.TEXT, "", {
    wide: true,
    large: true,
    okButton: "Close",
    cancelButton: null,
    allowVerticalScrolling: true,
  });
  await popup.show();
}

export function installPersonaGeneratorWandButton({ bus = null } = {}) {
  if (bus) wandBus = bus;
  if (document.getElementById("pme-wand-generate-persona")) return;

  const menu = document.getElementById("extensionsMenu");
  if (!menu) return;

  const container = document.createElement("div");
  container.id = "pme_wand_container";
  container.className = "extension_container";
  container.innerHTML = `
    <div id="pme-wand-generate-persona" class="list-group-item flex-container flexGap5" title="Generate linked PME persona">
      <div class="fa-solid fa-user-plus extensionsMenuExtensionButton"></div>
      <span>Generate Linked Persona</span>
    </div>
  `;
  menu.appendChild(container);

  container
    .querySelector("#pme-wand-generate-persona")
    ?.addEventListener("click", () => openPersonaGenerator({ bus: wandBus }));
}
