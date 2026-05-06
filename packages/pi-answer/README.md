# @monochromatti/pi-answer

Pi extension that adds `/answer`: an interactive question extraction and Q&A flow for the last assistant message.

## Load

```bash
pi -e /Users/monochromatti/code/pi-extensions/packages/pi-answer
```

## Command

- `/answer` — extract questions from the last assistant message and answer them in a custom TUI

## Flow

1. Finds the last completed assistant message on the current branch
2. Extracts questions as structured JSON with a model, using recent conversation only to clarify context
3. Classifies each question as freeform, single-choice, or multi-choice
4. If the assistant clearly included explicit options (for example A/B/C), shows those choices with optional descriptions
5. Autosaves draft answers and can restore them when `/answer` is rerun for the same assistant message
6. Opens an interactive multi-question answer UI with freeform text fields, choice controls, and custom “Other” text for choices
7. Sends provided answers back into the session and triggers a turn; unanswered questions are skipped

## Controls

- `Tab` / `Enter` — next question
- `Shift+Tab` — previous question
- `Shift+Enter` — newline in freeform answer
- `A` / `B` / `C` / ... or `1` / `2` / `3` / ... — choose/toggle displayed option(s) for choice questions
- `↑` / `↓` — move option selection when custom text is empty
- `Esc` — cancel

## Configuration

Reads `answer` settings from global `~/.pi/agent/settings.json` and project `.pi/settings.json` (project overrides global):

```json
{
  "answer": {
    "systemPrompt": "Custom extraction prompt...",
    "extractionModels": [
      { "provider": "openai-codex", "id": "gpt-5.4-mini" },
      { "provider": "anthropic", "id": "claude-haiku-4-5" }
    ],
    "drafts": {
      "enabled": true,
      "autosaveMs": 1000,
      "promptOnRestore": true
    }
  }
}
```
