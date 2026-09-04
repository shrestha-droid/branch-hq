import { useState, useEffect } from 'react'
import { CURRENT_GEMINI_MODELS } from '../lib/geminiModels'

// NEW: one reusable model picker, used everywhere a model gets chosen
// -- the primary/fallback fields and all per-agent overrides in
// Settings, and all per-chat overrides in the Model modal. Replaces
// free-text typing with a real dropdown of current, real model names,
// while never locking anyone out: picking "Custom" reveals a plain
// text field for anything not in the list yet (a brand-new model
// released after this list was last updated, for instance).

interface ModelSelectProps {
  value: string
  onChange: (value: string) => void
  // When provided, an extra option representing the empty string is
  // shown at the top -- used for every override field, where blank
  // genuinely means "inherit the setting one layer up," not "no
  // model." Omitted for the primary model field, which always has a
  // real, concrete value.
  inheritLabel?: string
  disabled?: boolean
}

const CUSTOM_SENTINEL = '__custom__'
const INHERIT_SENTINEL = '__inherit__'

export default function ModelSelect({ value, onChange, inheritLabel, disabled }: ModelSelectProps) {
  const isKnownModel = CURRENT_GEMINI_MODELS.some((m) => m.value === value)
  const [isCustom, setIsCustom] = useState(!!value && !isKnownModel)

  // Keeps this in sync if the value arrives or changes from outside --
  // e.g. settings finish loading asynchronously after this component
  // already mounted with an empty default.
  useEffect(() => {
    setIsCustom(!!value && !CURRENT_GEMINI_MODELS.some((m) => m.value === value))
  }, [value])

  const selectValue = isCustom ? CUSTOM_SENTINEL : (!value ? INHERIT_SENTINEL : value)

  return (
    <div className="flex flex-col gap-1.5">
      <select
        value={selectValue}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value
          if (v === CUSTOM_SENTINEL) {
            setIsCustom(true)
            return
          }
          setIsCustom(false)
          onChange(v === INHERIT_SENTINEL ? '' : v)
        }}
        className="w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
      >
        {inheritLabel && <option value={INHERIT_SENTINEL}>{inheritLabel}</option>}
        {CURRENT_GEMINI_MODELS.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
        <option value={CUSTOM_SENTINEL}>Custom (type your own)...</option>
      </select>
      {isCustom && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="e.g. a model not in the list yet"
          className="w-full bg-black/30 border border-white/[0.06] rounded-md px-3 py-2 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
        />
      )}
    </div>
  )
}