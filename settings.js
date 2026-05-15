/**
 * Persona Management Extended - Settings Module
 * Adds extension settings UI and migration from User Persona Extended.
 */

import { saveSettingsDebounced } from "/script.js";
import {
  extension_settings,
  renderExtensionTemplateAsync,
} from "../../../extensions.js";
import { accountStorage } from "/scripts/util/AccountStorage.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { power_user } from "/scripts/power-user.js";

import { PME } from "./src/core/constants.js";

/**
 * Extension settings key
 */
const SETTINGS_KEY = "personaManagementExtended";

/**
 * Legacy extension storage key prefix (User Persona Extended)
 */
const LEGACY_STORAGE_KEY_PREFIX = "user_persona_extended_";

const PREVIOUS_DEFAULT_PERSONA_GENERATOR_PROMPT = `You are a SillyTavern persona designer. Given the current character card's raw data, create a strong user persona that fits the card, scenario, tone, relationship hooks, and likely story role.

Write the persona as the user's playable character, not as the assistant character. Make it immediately usable in roleplay: concrete identity, role in the scenario, motivations, temperament, boundaries, speaking style, relationship to the card character, and any relevant skills/status/secrets. Keep it specific to the card instead of generic.

Avoid copying the assistant character's name or identity. Do not write instructions for the AI model. Do not mention that this was generated.

Return JSON only with these fields:
{
  "name": "short user persona name",
  "title": "short display title",
  "description": "complete first-person persona description for SillyTavern"
}
The description should be detailed enough to guide behavior, but compact enough for regular chat use.`;

export const DEFAULT_PERSONA_GENERATOR_PROFILE = Object.freeze({
  id: "default",
  name: "Default linked persona",
  baseInstruction: `You are an expert persona designer for roleplay scenarios. Based on the provided character card context, your task is to design a cohesive, compelling persona profile for the human user (represented as {{user}} in chat context) who will interact with {{card_name}}.

CRITICAL REQUIREMENT:
The profile you write defines the user's own identity. It must be written strictly in the first-person perspective ("I am...", "My name is...", "I wear...") as a direct self-introduction. Do not refer to {{user}} in the third person, and do not create a third-party character separate from the user. When the chat AI reads this description, it must immediately recognize that these traits belong to its direct conversational partner.

In your first-person description, detail the following aspects:
- Core Identity: My name, age, gender, species/race (if relevant to the setting), occupation, or title, and my established connection or history with {{card_name}}.
- Appearance: My build, facial features, eye/hair color, distinct marks/scars, typical attire, and any carried items or signature equipment.
- Personality & Demeanor: My temperament, speech habits, personal boundaries, core values, flaws, and hidden secrets.
- Capabilities & Strengths: My practical skills, combat or non-combat proficiencies, specialized knowledge, and resources.
- Powers or Special Abilities (only if fitting the card's setting/genre): The nature of my abilities, unique traits, and their respective limitations or costs.
- Current Motivations: My immediate goals within the scenario, what drives my actions, and the dynamic or underlying tension I bring to interactions with {{card_name}}.

Strict Constraints:
- Write the description entirely in the first person ("I").
- Do NOT copy, mirror, or assume the identity or abilities of {{card_name}}.
- Do NOT include system instructions, AI formatting directives, or meta-commentary.
- Do NOT mention that this profile was generated or reference the user interface.

Return valid JSON only with the following structure:
{
  "name": "Short persona name",
  "title": "Short display title or role",
  "description": "Complete first-person persona description following the criteria above"
}
Ensure the description is dense with flavorful details to guide rich roleplay, yet concise enough to serve efficiently as active chat context.`,
  modalInstruction: "",
  includeFields: {
    description: true,
    personality: true,
    scenario: true,
    firstMessage: true,
    examples: true,
    creatorNotes: false,
    systemPrompt: false,
    postHistoryInstructions: false,
  },
  responseLength: 700,
  outputFormat: "json",
  aiConnectionProfile: "",
  connectionMode: "character",
  clearExistingConnections: true,
  autoSelectAfterSave: true,
  // Default OFF: wiping power_user.default_persona on save is the main reason
  // generated personas appeared to "go global" — with no default set, any chat
  // that lacks its own linked persona stays stuck on whatever was last active.
  // The personaScopeGuard module + this default jointly keep generated personas
  // strictly scoped to their source card.
  removeDefaultEligibility: false,
});

/**
 * Default settings
 */
export const defaultSettings = {
  enabled: true,
  personaGeneratorEnabled: true,
  selectedPersonaGeneratorProfile: "default",
  personaGeneratorProfiles: [{ ...DEFAULT_PERSONA_GENERATOR_PROFILE }],
};

let settingsUIInitialized = false;

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneDefaultGeneratorProfile() {
  return JSON.parse(JSON.stringify(DEFAULT_PERSONA_GENERATOR_PROFILE));
}

function normalizeGeneratorProfile(profile, index = 0) {
  const base = cloneDefaultGeneratorProfile();
  const source = profile && typeof profile === "object" ? profile : {};
  const normalized = {
    ...base,
    ...source,
    id: String(source.id ?? "").trim() || (index === 0 ? "default" : makeId()),
    name:
      String(source.name ?? "").trim() ||
      (index === 0 ? base.name : `Persona profile ${index + 1}`),
    baseInstruction: String(source.baseInstruction ?? base.baseInstruction),
    modalInstruction: String(source.modalInstruction ?? ""),
    includeFields: { ...base.includeFields, ...(source.includeFields ?? {}) },
    responseLength: Number(source.responseLength ?? base.responseLength),
    outputFormat:
      source.outputFormat === "text" || source.outputFormat === "json"
        ? source.outputFormat
        : base.outputFormat,
    aiConnectionProfile: normalizeAiConnectionProfileId(
      source.aiConnectionProfile ?? ""
    ),
    connectionMode: [
      "character",
      "chat",
      "character_and_chat",
      "manual",
    ].includes(source.connectionMode)
      ? source.connectionMode
      : base.connectionMode,
    clearExistingConnections: source.clearExistingConnections !== false,
    autoSelectAfterSave: source.autoSelectAfterSave !== false,
    // Treat undefined as false (new safer default); only honor an explicit `true`.
    removeDefaultEligibility: source.removeDefaultEligibility === true,
  };

  if (normalized.id === "default" && isLegacyDefaultPersonaPrompt(normalized.baseInstruction)) {
    normalized.baseInstruction = base.baseInstruction;
  }

  if (!Number.isFinite(normalized.responseLength) || normalized.responseLength < 100) {
    normalized.responseLength = base.responseLength;
  }

  return normalized;
}

function isLegacyDefaultPersonaPrompt(prompt) {
  const text = String(prompt ?? "").trim();
  if (!text) return true;
  if (text === PREVIOUS_DEFAULT_PERSONA_GENERATOR_PROMPT.trim()) return true;
  if (text.includes("create a persona description that will be injected as {{user}}'s identity during roleplay.")) return true;

  const lower = text.toLowerCase();
  return (
    lower.includes("create a new sillytavern user persona") &&
    lower.includes('"name": "short persona name"') &&
    lower.includes("the persona must describe the user's character")
  );
}

function normalizeGeneratorSettings(settings) {
  if (!Array.isArray(settings.personaGeneratorProfiles)) {
    settings.personaGeneratorProfiles = [cloneDefaultGeneratorProfile()];
  }

  settings.personaGeneratorProfiles =
    settings.personaGeneratorProfiles.map(normalizeGeneratorProfile);

  if (!settings.personaGeneratorProfiles.length) {
    settings.personaGeneratorProfiles.push(cloneDefaultGeneratorProfile());
  }

  const selected = String(settings.selectedPersonaGeneratorProfile ?? "").trim();
  if (!settings.personaGeneratorProfiles.some((p) => p.id === selected)) {
    settings.selectedPersonaGeneratorProfile =
      settings.personaGeneratorProfiles[0].id;
  }

  if (typeof settings.personaGeneratorEnabled !== "boolean") {
    settings.personaGeneratorEnabled = true;
  }
}

function ensureSettings() {
  if (!extension_settings[SETTINGS_KEY]) {
    extension_settings[SETTINGS_KEY] = { ...defaultSettings };
    saveSettingsDebounced();
  }

  let shouldSave = false;
  for (const key in defaultSettings) {
    if (!(key in extension_settings[SETTINGS_KEY])) {
      extension_settings[SETTINGS_KEY][key] = defaultSettings[key];
      shouldSave = true;
    }
  }
  normalizeGeneratorSettings(extension_settings[SETTINGS_KEY]);
  if (shouldSave) saveSettingsDebounced();
  return extension_settings[SETTINGS_KEY];
}

export function getSettings() {
  return ensureSettings();
}

export function getPersonaGeneratorProfiles() {
  const settings = ensureSettings();
  normalizeGeneratorSettings(settings);
  return settings.personaGeneratorProfiles;
}

export function getSelectedPersonaGeneratorProfile() {
  const settings = ensureSettings();
  const profiles = getPersonaGeneratorProfiles();
  return (
    profiles.find((p) => p.id === settings.selectedPersonaGeneratorProfile) ??
    profiles[0]
  );
}

export function isPersonaGeneratorEnabled() {
  const settings = ensureSettings();
  return (
    isExtensionEnabled() &&
    settings.personaGeneratorEnabled !== false &&
    getPersonaGeneratorProfiles().length > 0
  );
}

function saveGeneratorProfiles(profiles, selectedId) {
  const settings = ensureSettings();
  settings.personaGeneratorProfiles = profiles.map(normalizeGeneratorProfile);
  if (selectedId) settings.selectedPersonaGeneratorProfile = selectedId;
  normalizeGeneratorSettings(settings);
  saveSettingsDebounced();
  renderGeneratorProfileSettings();
}

export function loadSettings() {
  ensureSettings();

  const $checkbox = $("#pme-enabled");
  if ($checkbox.length) {
    $checkbox.prop(
      "checked",
      extension_settings[SETTINGS_KEY].enabled !== false
    );
  }

  renderGeneratorProfileSettings();
}

export function isExtensionEnabled() {
  if (!extension_settings[SETTINGS_KEY]) {
    loadSettings();
  }
  return extension_settings[SETTINGS_KEY]?.enabled !== false;
}

async function clearAllExtensionData() {
  const confirmed = await callGenericPopup(
    `<div class="text_pole">
      <p><strong>Are you sure you want to delete all extension data?</strong></p>
      <p>This will permanently delete:</p>
      <p>- All saved Additional Descriptions blocks for all personas</p>
      <p>- Extension settings (will be reset to defaults)</p>
      <p>This action cannot be undone.</p>
    </div>`,
    POPUP_TYPE.CONFIRM,
    "",
    { wide: true }
  );

  if (!confirmed) return;

  try {
    const personaDescriptions = power_user?.persona_descriptions ?? {};
    let deletedPersonaCount = 0;

    for (const avatarId in personaDescriptions) {
      const desc = personaDescriptions?.[avatarId];
      if (desc && typeof desc === "object" && "pme" in desc) {
        delete desc.pme;
        deletedPersonaCount++;
      }
    }

    // Reset extension settings to defaults
    extension_settings[SETTINGS_KEY] = { ...defaultSettings };

    // Reset local UI prefs
    accountStorage.removeItem(PME.storage.advancedModeKey);
    accountStorage.removeItem(PME.storage.personaSortKey);

    saveSettingsDebounced();
    loadSettings();

    toastr.success(
      `Deleted PME data for ${deletedPersonaCount} persona(s) and reset settings`,
      "Data Cleared"
    );
  } catch (err) {
    console.error("[PME]: Error clearing data:", err);
    toastr.error("Failed to clear extension data", "Error");
  }
}

async function importFromUserPersonaExtended() {
  const confirmed = await callGenericPopup(
    `<div class="text_pole">
      <p><strong>Import Additional Descriptions from "User Persona Extended"?</strong></p>
      <p>This will:</p>
      <p>- Read legacy data from account storage</p>
      <p>- Import legacy entries as individual items (flat list)</p>
      <p>- Preserve item order (title/description/enabled)</p>
      <p>No existing PME items will be deleted.</p>
    </div>`,
    POPUP_TYPE.CONFIRM,
    "",
    { wide: true }
  );

  if (!confirmed) return;

  try {
    const state = accountStorage.getState();
    const keys = Object.keys(state || {}).filter((k) =>
      String(k).startsWith(LEGACY_STORAGE_KEY_PREFIX)
    );

    if (!keys.length) {
      toastr.info("No legacy data found to import", "Import");
      return;
    }

    const personaDescriptions = (power_user.persona_descriptions ??= {});
    let importedPersonaCount = 0;
    let importedItemCount = 0;

    for (const storageKey of keys) {
      const avatarId = String(storageKey).slice(
        LEGACY_STORAGE_KEY_PREFIX.length
      );
      if (!avatarId) continue;

      const raw = accountStorage.getItem(storageKey);
      if (!raw) continue;

      let legacy = null;
      try {
        legacy = JSON.parse(raw);
      } catch {
        legacy = null;
      }
      if (!Array.isArray(legacy) || legacy.length === 0) continue;

      const items = legacy
        .filter((x) => x && typeof x === "object")
        .map((x, idx) => {
          const title = String(x.title ?? "").trim() || `Item ${idx + 1}`;
          const text = String(x.description ?? "");
          const enabled = x.enabled !== false;
          const id = String(x.id ?? "").trim() || makeId();
          return { type: "item", id, title, text, enabled, collapsed: false };
        })
        .filter(
          (it) =>
            String(it.text ?? "").trim().length > 0 ||
            String(it.title ?? "").trim().length > 0
        );

      if (!items.length) continue;

      personaDescriptions[avatarId] ??= {};
      const target = personaDescriptions[avatarId];
      target.pme ??= { version: 1, blocks: [] };
      target.pme.version = 1;
      target.pme.blocks ??= [];

      // Flat import: legacy extension had no group semantics
      target.pme.blocks.push(...items);

      importedPersonaCount++;
      importedItemCount += items.length;
    }

    if (importedPersonaCount === 0) {
      toastr.info(
        "Legacy data was found, but nothing could be imported",
        "Import"
      );
      return;
    }

    saveSettingsDebounced();

    toastr.success(
      `Imported ${importedItemCount} item(s) into ${importedPersonaCount} persona(s)`,
      "Import Complete"
    );
  } catch (err) {
    console.error("[PME]: Import failed:", err);
    toastr.error("Failed to import legacy data", "Error");
  }
}

function getProfileEditorValues() {
  const current = getSelectedPersonaGeneratorProfile();
  return normalizeGeneratorProfile({
    ...current,
    name: $("#pme-generator-profile-name").val(),
    baseInstruction: $("#pme-generator-base-instruction").val(),
    modalInstruction: $("#pme-generator-modal-instruction").val(),
    responseLength: Number($("#pme-generator-response-length").val()),
    outputFormat: $("#pme-generator-output-format").val(),
    aiConnectionProfile: $("#pme-generator-ai-connection-profile").val(),
    connectionMode: $("#pme-generator-connection-mode").val(),
    clearExistingConnections: $("#pme-generator-clear-connections").prop(
      "checked"
    ),
    autoSelectAfterSave: $("#pme-generator-auto-select").prop("checked"),
    removeDefaultEligibility: $("#pme-generator-remove-default").prop("checked"),
    includeFields: {
      description: $("#pme-gen-field-description").prop("checked"),
      personality: $("#pme-gen-field-personality").prop("checked"),
      scenario: $("#pme-gen-field-scenario").prop("checked"),
      firstMessage: $("#pme-gen-field-first-message").prop("checked"),
      examples: $("#pme-gen-field-examples").prop("checked"),
      creatorNotes: $("#pme-gen-field-creator-notes").prop("checked"),
      systemPrompt: $("#pme-gen-field-system-prompt").prop("checked"),
      postHistoryInstructions: $("#pme-gen-field-post-history").prop("checked"),
    },
  });
}

function renderGeneratorProfileSettings() {
  if (!$("#pme_settings").length) return;

  const settings = extension_settings[SETTINGS_KEY];
  if (!settings) return;
  normalizeGeneratorSettings(settings);
  const profiles = settings.personaGeneratorProfiles;
  const selected =
    profiles.find((p) => p.id === settings.selectedPersonaGeneratorProfile) ??
    profiles[0];

  $("#pme-persona-generator-enabled").prop(
    "checked",
    settings.personaGeneratorEnabled !== false
  );

  const select = $("#pme-generator-profile-select");
  if (select.length) {
    select.empty();
    for (const profile of profiles) {
      select.append(
        $("<option></option>").attr("value", profile.id).text(profile.name)
      );
    }
    select.val(selected.id);
  }

  $("#pme-generator-profile-name").val(selected.name);
  $("#pme-generator-base-instruction").val(selected.baseInstruction);
  $("#pme-generator-modal-instruction").val(selected.modalInstruction);
  $("#pme-generator-response-length").val(selected.responseLength);
  $("#pme-generator-output-format").val(selected.outputFormat);
  refreshAiConnectionProfileDropdown(selected.aiConnectionProfile);
  $("#pme-generator-connection-mode").val(selected.connectionMode);
  $("#pme-generator-clear-connections").prop(
    "checked",
    selected.clearExistingConnections !== false
  );
  $("#pme-generator-auto-select").prop(
    "checked",
    selected.autoSelectAfterSave !== false
  );
  $("#pme-generator-remove-default").prop(
    "checked",
    selected.removeDefaultEligibility === true
  );

  const fields = selected.includeFields ?? {};
  $("#pme-gen-field-description").prop("checked", fields.description !== false);
  $("#pme-gen-field-personality").prop("checked", fields.personality !== false);
  $("#pme-gen-field-scenario").prop("checked", fields.scenario !== false);
  $("#pme-gen-field-first-message").prop(
    "checked",
    fields.firstMessage !== false
  );
  $("#pme-gen-field-examples").prop("checked", fields.examples !== false);
  $("#pme-gen-field-creator-notes").prop("checked", fields.creatorNotes === true);
  $("#pme-gen-field-system-prompt").prop("checked", fields.systemPrompt === true);
  $("#pme-gen-field-post-history").prop(
    "checked",
    fields.postHistoryInstructions === true
  );
}

function saveCurrentGeneratorProfileFromUi() {
  const current = getProfileEditorValues();
  const profiles = getPersonaGeneratorProfiles().map((p) =>
    p.id === current.id ? current : p
  );
  saveGeneratorProfiles(profiles, current.id);
  toastr.success("Saved persona generator profile", "PME");
}

function getAiConnectionProfiles() {
  return /** @type {any[]} */ (
    extension_settings.connectionManager?.profiles ?? []
  );
}

function normalizeAiConnectionProfileId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const profiles = getAiConnectionProfiles();
  return (
    profiles.find((p) => p?.id === raw)?.id ??
    profiles.find((p) => p?.name === raw)?.id ??
    raw
  );
}

function refreshAiConnectionProfileDropdown(selectedValue = undefined) {
  const select = $("#pme-generator-ai-connection-profile");
  if (!select.length) return;

  const selected =
    selectedValue !== undefined
      ? normalizeAiConnectionProfileId(selectedValue)
      : String(select.val() ?? "");

  select.empty();
  select.append($("<option></option>").attr("value", "").text("<Same as current>"));

  for (const profile of getAiConnectionProfiles()) {
    const id = String(profile?.id ?? "").trim();
    const name = String(profile?.name ?? "").trim();
    if (!id || !name) continue;
    const label = String(profile?.displayName ?? profile?.name ?? name);
    select.append($("<option></option>").attr("value", id).text(label));
  }

  select.val(selected);
}

function addGeneratorProfile() {
  const profiles = getPersonaGeneratorProfiles();
  const profile = normalizeGeneratorProfile({
    ...cloneDefaultGeneratorProfile(),
    id: makeId(),
    name: `Persona profile ${profiles.length + 1}`,
  });
  profiles.push(profile);
  saveGeneratorProfiles(profiles, profile.id);
}

function deleteCurrentGeneratorProfile() {
  const settings = getSettings();
  const profiles = getPersonaGeneratorProfiles();
  if (profiles.length <= 1) {
    toastr.warning("At least one generator profile is required", "PME");
    return;
  }

  const remaining = profiles.filter(
    (p) => p.id !== settings.selectedPersonaGeneratorProfile
  );
  saveGeneratorProfiles(remaining, remaining[0]?.id);
}

export async function initSettingsUI() {
  if (settingsUIInitialized) return;

  // Already mounted by something else
  if ($("#pme_settings").length) {
    settingsUIInitialized = true;
    loadSettings();
    return;
  }

  try {
    const settingsHtml = await renderExtensionTemplateAsync(
      "third-party/SillyTavern-Persona-Management-Extended",
      "settings"
    );

    const getContainer = () =>
      $(
        document.getElementById("pme_settings_container") ??
          document.getElementById("extensions_settings")
      );

    const $container = getContainer();
    if (!$container.length) {
      console.warn("[PME]: Settings container not found, retrying later...");
      return;
    }

    if ($("#pme_settings").length) {
      settingsUIInitialized = true;
      loadSettings();
      return;
    }

    $container.append(settingsHtml);
    settingsUIInitialized = true;

    loadSettings();

    // Enable/disable
    $(document)
      .off("change", "#pme-enabled")
      .on("change", "#pme-enabled", function () {
        extension_settings[SETTINGS_KEY].enabled = $(this).prop("checked");
        saveSettingsDebounced();
      });

    $(document)
      .off("change", "#pme-persona-generator-enabled")
      .on("change", "#pme-persona-generator-enabled", function () {
        extension_settings[SETTINGS_KEY].personaGeneratorEnabled = $(this).prop(
          "checked"
        );
        saveSettingsDebounced();
      });

    $(document)
      .off("change", "#pme-generator-profile-select")
      .on("change", "#pme-generator-profile-select", function () {
        extension_settings[SETTINGS_KEY].selectedPersonaGeneratorProfile =
          String($(this).val() ?? "");
        saveSettingsDebounced();
        renderGeneratorProfileSettings();
      });

    $(document)
      .off("mousedown", "#pme-generator-ai-connection-profile")
      .on("mousedown", "#pme-generator-ai-connection-profile", function () {
        refreshAiConnectionProfileDropdown();
      });

    $(document)
      .off("click", "#pme-generator-profile-save")
      .on("click", "#pme-generator-profile-save", saveCurrentGeneratorProfileFromUi);

    $(document)
      .off("click", "#pme-generator-profile-add")
      .on("click", "#pme-generator-profile-add", addGeneratorProfile);

    $(document)
      .off("click", "#pme-generator-profile-delete")
      .on("click", "#pme-generator-profile-delete", deleteCurrentGeneratorProfile);

    // Import
    $(document)
      .off("click", "#pme-import-from-user-persona-extended")
      .on("click", "#pme-import-from-user-persona-extended", async function () {
        await importFromUserPersonaExtended();
      });

    // Clear all data
    $(document)
      .off("click", "#pme-clear-all-data")
      .on("click", "#pme-clear-all-data", async function () {
        await clearAllExtensionData();
      });
  } catch (err) {
    console.error("[PME]: Settings UI initialization error:", err);
  }
}
