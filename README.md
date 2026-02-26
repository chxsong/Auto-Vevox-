# Auto-Vevox-
Detect Vevox question changes, call OpenAI-compatible API, auto click option and submit.

Tampermonkey-based Vevox auto-answer script:
- Automatically detects changes in Vevox page questions and options.
- Calls OpenAI-compatible APIs.
- Automatically clicks answers and submits (enabled by default).

## Files

- `vevox-auto-answer.user.js`: Main script (the only required file).

## Quick Start

1. Install the **Tampermonkey** browser extension.
2. Create a new user script, paste the content of `vevox-auto-answer.user.js`, and save.
3. Open any Vevox polling page.
4. Set up the configuration via the Tampermonkey script menu:
   - `Set API Key`
   - `Set Endpoint` (e.g., `https://api.openai.com/v1/chat/completions`)
   - `Set Model` (default is `gpt-4o-mini`)
5. Stay on the Vevox page; the script will automatically answer when a new question appears.

## Tampermonkey Menu

- `Set API Key`: Save your key locally (`GM_setValue`), not hardcoded in the source.
- `Set Endpoint`: Configure the OpenAI-compatible API endpoint address.
- `Set Model`: Set the name of the model to use.
- `Toggle Auto Submit`: Turn automatic submission on or off.
- `Toggle Debug`: Toggle console debug logs.
- `Toggle Debug Button`: Toggle the debug button in the bottom right corner (default: ON).
- `Show Config Summary`: Review current configuration (API key is masked).

## Default Behavior

- **Detection**: `MutationObserver + debounce` for detecting new questions.
- **Deduplication**: `hash(question + ordered options)` strategy.
- **Protocol**: OpenAI Chat Completions compatible.
- **Parsing Priority**: `answer_index(JSON)` > `A-H` > `Numeric` > `Text match`.
- **Action**: Automatic option clicking + automatic submission.

## Compatibility

Compatible with any service providing an OpenAI-ready `/v1/chat/completions` endpoint, such as:
- OpenAI
- GLM / ZhipuAI (OpenAI compatible mode)
- DeepSeek
- Other compatible gateways

## Debugging

- Open the browser console and look for `[VevoxAuto]` logs.
- Use the **Copy Debug (...)** button in the bottom right (ON by default) to copy the full debug JSON.
- **Right-click** the debug button to hide it quickly, or use the menu to toggle it.
- **Recognition issues**: If questions/options aren't recognized, adjust the selectors in the script based on Vevox's current DOM.
- **Unexpected submission**: Turn off `Auto Submit` in the menu if needed.
- **API Errors**: Check your `Endpoint`, `API Key`, Model name, and account balance/quota.
