import {
    Generate,
    eventSource,
    event_types,
    extension_prompt_types,
    saveSettingsDebounced,
    sendMessageAsUser,
    setExtensionPrompt,
} from "../../../../script.js";
import { extension_settings, renderExtensionTemplateAsync } from "../../../extensions.js";

const EXTENSION_KEY = "clickableInputs";
const PROMPT_KEY = "CLICKABLE_GENERATED_INPUTS";
const IGNORE_ATTRIBUTE = "data-clickable-ignore";
const SUBMIT_ATTRIBUTE = "data-submit";
const ALTERNATE_SUBMIT_ATTRIBUTE = "data-clickable-submit";
const SCOPE_SELECTOR = "[data-clickable-scope], form[data-clickable-form]";

const DEFAULT_INSTRUCTIONS = `<instructions>
**INTERACTIVE CONTROLS**: Put related controls inside a \`<form data-clickable-form>\` or an element with \`data-clickable-scope\`. Use semantic HTML controls wherever possible: \`button\`, \`input\`, \`select\`, \`textarea\`, \`details\`, and \`a\`. Buttons inside an interactive scope are actions. For buttons outside a scope, add \`data-clickable\` so they are explicitly interactive. Keep related inputs together and use \`<label>\` with a \`for\` attribute.
\`\`\`
<form data-clickable-form>
  <label for="name">Name</label>
  <input id="name" name="name" type="text" data-submit-on-enter>
  <label for="mood">Mood</label>
  <select id="mood" name="mood">
    <option>Calm</option>
    <option>Aggressive</option>
  </select>
  <button data-submit>Continue</button>
</form>
\`\`\`
Use \`data-submit\` when a button should include labelled input values in its message. Use \`data-submit-on-enter\` only when pressing Enter in a specific text field should activate the form submit button. Links should navigate normally unless they have \`data-clickable\`.
You may override the text sent/displayed on an action button with \`data-title\`.
</instructions>`;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    appendPrompt: true,
    prompt: DEFAULT_INSTRUCTIONS,
});

let observer = null;
let generationInFlight = false;
let refreshQueued = false;

function getSettings() {
    const current = extension_settings[EXTENSION_KEY];
    if (!current || typeof current !== "object") {
        extension_settings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS };
        return extension_settings[EXTENSION_KEY];
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (current[key] === undefined) current[key] = value;
    }
    return current;
}

function isEnabled() {
    return getSettings().enabled !== false;
}

function shouldAppendPrompt() {
    return isEnabled() && getSettings().appendPrompt !== false;
}

function getPrompt() {
    return String(getSettings().prompt || DEFAULT_INSTRUCTIONS);
}

function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
        refreshQueued = false;
        refreshInputs();
    });
}

function getMessageRoot(element) {
    return element instanceof Element ? element.closest("#chat .mes_text") : null;
}

function getInteractionScope(element, root) {
    return element?.closest?.(SCOPE_SELECTOR) || root;
}

function isAssistantMessage(root) {
    const message = root?.closest(".mes");
    return !message || message.getAttribute("is_user") !== "true";
}

function isIgnoredControl(element) {
    return element.hasAttribute(IGNORE_ATTRIBUTE)
        || element.disabled
        || Boolean(element.closest(".edit_textarea, pre, .mes_buttons"));
}

function isActionControl(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!element.matches("button, input[type=button], input[type=submit], [role=button], a")) return false;
    if (element.matches("a")) return element.hasAttribute("data-clickable");
    if (element.closest(SCOPE_SELECTOR)) return true;
    return element.hasAttribute("data-clickable")
        || element.hasAttribute("data-title")
        || isSubmitButton(element);
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function findLabel(input, root) {
    if (input.id) {
        try {
            const label = root.querySelector(`label[for="${CSS.escape(input.id)}"]`);
            if (label) return cleanText(label.textContent);
        } catch {
            // An invalid generated id should not make the control unusable.
        }
    }

    const wrappingLabel = input.closest("label");
    if (wrappingLabel) return cleanText(wrappingLabel.textContent.replace(input.value, ""));

    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
        const label = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((node) => node.textContent)
            .join(" ");
        if (cleanText(label)) return cleanText(label);
    }

    return cleanText(input.getAttribute("aria-label") || input.getAttribute("data-label") || input.name);
}

function getInputValue(input) {
    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (type === "radio" && !input.checked) return "";
    if (["hidden", "file", "button", "submit", "reset"].includes(type)) return "";

    if (input instanceof HTMLSelectElement) {
        const values = Array.from(input.selectedOptions).map((option) => cleanText(option.textContent));
        return values.join(", ");
    }

    if (type === "checkbox") return input.checked ? "on" : "off";

    const value = cleanText(input.value);
    if (type === "range" && input.max) return `${value}/${input.max}`;
    return value;
}

function inputToString(input, root) {
    if (isIgnoredControl(input)) return "";
    const label = findLabel(input, root);
    if (!label) return "";
    const value = getInputValue(input);
    return `${label}${label.endsWith(":") ? "" : ":"} ${value}\n`;
}

function extractDataInputs(root) {
    return Array.from(root.querySelectorAll("input, select, textarea"))
        .map((input) => inputToString(input, root))
        .filter(Boolean)
        .join("");
}

function getButtonLabel(button) {
    return cleanText(
        button.getAttribute("data-title")
        || button.getAttribute("aria-label")
        || button.value
        || button.textContent,
    );
}

function isSubmitButton(button) {
    return button.hasAttribute(SUBMIT_ATTRIBUTE)
        || button.hasAttribute(ALTERNATE_SUBMIT_ATTRIBUTE)
        || (button instanceof HTMLInputElement
            && button.type === "submit"
            && Boolean(button.closest(SCOPE_SELECTOR)));
}

function prepareControl(control) {
    if (control instanceof HTMLButtonElement) {
        const title = cleanText(control.getAttribute("data-title"));
        if (title && !control.getAttribute("aria-label")) control.setAttribute("aria-label", title);
    }
}

function processMessageRoot(root) {
    if (!root || !isAssistantMessage(root) || root.querySelector(".edit_textarea")) return;
    root.querySelectorAll("button, input, select, textarea").forEach(prepareControl);
}

function refreshInputs() {
    const enabled = isEnabled();
    if (enabled) document.querySelectorAll("#chat .mes_text:not(:has(.edit_textarea))").forEach(processMessageRoot);
    setExtensionPrompt(
        PROMPT_KEY,
        shouldAppendPrompt() ? getPrompt() : "",
        extension_prompt_types.IN_PROMPT,
        1,
    );
}

async function submitButton(button, root, event) {
    event.preventDefault();
    event.stopPropagation();
    if (generationInFlight) return;
    const label = getButtonLabel(button);
    if (!label) return;

    const scope = getInteractionScope(button, root);
    const output = `${isSubmitButton(button) ? extractDataInputs(scope) : ""}${label}`.trim();
    if (!output) return;

    generationInFlight = true;
    if (button instanceof HTMLButtonElement) button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
        await sendMessageAsUser(output, "");
        await Generate("normal");
    } catch (error) {
        console.error("Message Widgets: failed to submit button action", error);
    } finally {
        if (button instanceof HTMLButtonElement) button.disabled = false;
        button.removeAttribute("aria-busy");
        generationInFlight = false;
    }
}

function handleClick(event) {
    if (!isEnabled()) return;
    const control = event.target.closest?.("button, input[type=button], input[type=submit], [role=button], a");
    const root = getMessageRoot(control);
    if (!control || !root || !isAssistantMessage(root) || !isActionControl(control) || isIgnoredControl(control)) return;
    void submitButton(control, root, event);
}

function handleKeydown(event) {
    if (!isEnabled()) return;
    const target = event.target;
    const root = getMessageRoot(target);
    if (!root || !isAssistantMessage(root) || isIgnoredControl(target)) return;

    if (target.matches?.("input[data-submit-on-enter], textarea[data-submit-on-enter]") && event.key === "Enter" && !event.shiftKey) {
        const scope = getInteractionScope(target, root);
        const submit = scope.querySelector(`button[${SUBMIT_ATTRIBUTE}], button[${ALTERNATE_SUBMIT_ATTRIBUTE}]`);
        if (submit) {
            event.preventDefault();
            void submitButton(submit, root, event);
        }
        return;
    }

    if (target.matches?.("[role=button][data-clickable], a[data-clickable]") && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        void submitButton(target, root, event);
    }
}

async function initSettings() {
    const settings = getSettings();
    const container = document.getElementById("extensions_settings");
    if (!container || document.getElementById("clickable_inputs_settings")) return;

    try {
        const html = await renderExtensionTemplateAsync("third-party/Message-Widgets", "settings");
        container.insertAdjacentHTML("beforeend", html);
    } catch (error) {
        console.error("Message Widgets: failed to render settings", error);
        return;
    }

    const enabled = document.getElementById("clickable_inputs_enabled");
    const promptEnabled = document.getElementById("clickable_inputs_prompt_enabled");
    const prompt = document.getElementById("clickable_inputs_prompt");
    const restore = document.getElementById("clickable_inputs_prompt_restore");
    if (!enabled || !promptEnabled || !prompt || !restore) return;

    enabled.checked = settings.enabled;
    promptEnabled.checked = settings.appendPrompt;
    prompt.value = settings.prompt;

    const syncDisabled = () => {
        promptEnabled.disabled = !enabled.checked;
        prompt.disabled = !enabled.checked || !promptEnabled.checked;
    };
    syncDisabled();

    enabled.addEventListener("change", () => {
        settings.enabled = enabled.checked;
        syncDisabled();
        refreshInputs();
        saveSettingsDebounced();
    });
    promptEnabled.addEventListener("change", () => {
        settings.appendPrompt = promptEnabled.checked;
        syncDisabled();
        refreshInputs();
        saveSettingsDebounced();
    });
    prompt.addEventListener("input", () => {
        settings.prompt = prompt.value;
        refreshInputs();
        saveSettingsDebounced();
    });
    restore.addEventListener("click", () => {
        settings.prompt = DEFAULT_INSTRUCTIONS;
        prompt.value = DEFAULT_INSTRUCTIONS;
        refreshInputs();
        saveSettingsDebounced();
    });
}

function initObserver() {
    const chat = document.getElementById("chat");
    if (!chat || observer) return;
    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                queueRefresh();
                break;
            }
        }
    });
    observer.observe(chat, { childList: true, subtree: true });
}

function initEvents() {
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeydown, true);

    const refreshEvents = [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.CHAT_CHANGED,
    ];
    for (const eventName of refreshEvents) {
        if (eventName) eventSource.on(eventName, queueRefresh);
    }
}

async function init() {
    getSettings();
    await initSettings();
    initEvents();
    initObserver();
    refreshInputs();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
    void init();
}
