# Message Widgets

An independent SillyTavern extension for using interactive controls generated in assistant messages. Native controls remain typable and selectable, while interactive buttons can send actions through SillyTavern. A submit button can include the labelled input values in the same message.

Controls are scoped to their containing `.mes_text` block, so inputs in separate wrappers are collected in document order. Rendering is event-driven and works with newly rendered, swiped, edited, and loaded messages without polling.

## Installation and Usage

### Installation

Just use the installer.

### Usage

Use semantic HTML controls inside `data-clickable-scope` or `form data-clickable-form`. Standard buttons and submit controls in assistant messages are interactive automatically; standalone custom widgets can opt in with `data-clickable`. Custom widgets should use `role="button" tabindex="0"` for keyboard access. Text fields, sliders, checkboxes, radio buttons, dropdowns, textareas, and native disclosure widgets remain usable without changing presets or the normal composer. Add `data-submit` to a button when its form values should be sent with the action. Add `data-submit-on-enter` to a specific text field to opt in to Enter-to-submit.

## Prerequisites

A current SillyTavern installation that can install third-party extensions.

## Support and Contributions

Bug reports and improvements are welcome. Please include your SillyTavern version and the generated message markup when reporting an issue.

## License

AGPL v3
