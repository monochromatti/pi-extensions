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
3. If the assistant clearly included explicit options (for example A/B/C), shows those choices alongside each question
4. Opens an interactive multi-question answer UI with freeform replies and multi-select options
5. Sends the compiled answers back into the session and triggers a turn

## Controls

- `Tab` / `Enter` — next question
- `Shift+Tab` — previous question
- `Shift+Enter` — newline in answer
- `A` / `B` / `C` / ... — toggle displayed option(s) while the answer is empty
- `Esc` — cancel
