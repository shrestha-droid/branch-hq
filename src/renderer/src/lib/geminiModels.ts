// NEW: single shared list of real, current Gemini model options, used
// by every model picker in the app (the primary/fallback fields and
// all five per-agent overrides in SettingsModal.tsx, and the five
// per-chat overrides in App.tsx's Model modal) -- one place to update
// rather than the same array duplicated and drifting across a dozen
// dropdowns.
//
// Confirmed current as of Sep 2026 (Google's own docs, gemini-3.8-flash
// GA as of Sep 2, 2026). This WILL go stale -- Google ships a new Flash
// tier roughly every 3 weeks right now. Two things make that a minor
// problem rather than a real one: the "-latest" aliases at the top
// never go stale by design (Google's own words: "hot-swapped with
// every new release of a specific model variation"), and every picker
// built on this list always includes a "Custom" option, so nothing
// here is ever a hard ceiling -- worst case, you type the new model
// string once until this list gets refreshed.
//
// Deliberately excludes the Gemini 2.5 family (Pro/Flash/Flash-Lite):
// confirmed shutting down October 16, 2026 (Developer API) / October
// 20, 2026 (Agent Platform). Offering an option that stops working in
// weeks isn't a real option.

export interface GeminiModelOption {
  value: string
  label: string
}

export const CURRENT_GEMINI_MODELS: GeminiModelOption[] = [
  { value: 'gemini-flash-latest', label: 'Latest Flash (recommended -- always current)' },
  { value: 'gemini-pro-latest', label: 'Latest Pro (recommended -- always current)' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (pinned)' },
  { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash (pinned)' },
  { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (pinned)' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (pinned)' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite -- cheap/fast (pinned)' },
  { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro -- strongest reasoning (pinned)' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (pinned)' },
]