import { app, BrowserWindow, ipcMain, session, shell, dialog } from 'electron'
import * as path from 'path'
import { pathToFileURL } from 'url'
import * as http from 'http'
import WebSocket from 'ws'
import { getDeviceIdentity, setDeviceName, signPayload, verifySignature } from './deviceIdentity'
import {
  getTrustedPeers, isPeerTrusted, addTrustedPeer, removeTrustedPeer,
  createPendingIncomingRequest, getPendingIncomingRequest, consumePendingIncomingRequest, listPendingIncomingRequests,
  createPendingOutgoingRequest, getPendingOutgoingRequest, markOutgoingAwaitingLocalConfirmation, consumePendingOutgoingRequest,
  createPairingInvite, consumeAndValidateInvite
} from './devicePairing'
import { startDiscovery, stopDiscovery, listDiscoveredDevices } from './deviceDiscovery'
import { spawn, execFile, ChildProcess } from 'child_process'
import { promisify } from 'util'
import * as net from 'net'
import * as os from 'os'
import * as fs from 'fs/promises'
// NEW: for the real ZIP download feature. This is a dependency of Branch
// HQ's own project (the Electron app itself), completely separate from
// the dependency lists Jim/Dwight/Riley's generated code is allowed to
// use -- run `npm install jszip` in the project root once for this.
import JSZip from 'jszip'
// NEW: for real file upload/attachment support -- extracting actual
// text from an uploaded PDF so it can be used as real context, not just
// a filename. Pure JS, no native compilation. Run `npm install
// pdf-parse` in the project root once for this.
// FIXED: confirmed real, well-documented issue -- pdf-parse's own
// TypeScript typings don't reliably expose a default export across
// configurations (TS1192), regardless of esModuleInterop. A plain
// require() sidesteps the whole ES-module interop question entirely,
// since this file compiles to CommonJS anyway.
const pdfParse = require('pdf-parse')
import * as dotenv from 'dotenv'
import {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  renameConversation,
  addMessage,
  ConversationMode
} from './conversationStore'
import { searchRelevantCode } from './vectorStore'
import { generateEmbedding, indexWorkspace } from './indexer'
import { getSettings, updateSettings } from './settingsStore'
import { recordAudit, generateAuditReport, generateClientSummary, markExecutionVerified } from './auditStore'
import { recordLesson, getLearnedGuidance } from './lessonsStore'
import { setGithubToken, hasGithubToken, clearGithubToken, getGithubTokenForInternalUse } from './credentialsStore'
import { AuditResult } from './gate1'
import { auditAndStage, prefixStageableFiles } from './extraction'
import { looksTransient } from './resilience'
import { detectVerticalStarterKit } from './verticals'
import { getClientFacts, setClientFacts } from './clientFactsStore'
import { getStagedFiles, setStagedFiles } from './stagedFilesStore'
import { getConversationModelOverrides, setConversationModelOverrides } from './modelOverridesStore'

dotenv.config()

// 1. Model Provider Abstraction
//
// NEW: previously every call in this file went straight to Google's
// Gemini API, hardcoded -- meaning for a regulated customer, their real
// project code left their building the moment they typed a message, no
// matter what the audit trail said afterward. This layer fixes that by
// making "the model" swap-able: everything else in the pipeline
// (Michael, Jim, Dwight, Riley, Pam, chat, self-healing) just calls
// fetchFrontierAI/fetchChatCompletion exactly as before -- neither of
// those function names or call sites changed. Only what happens INSIDE
// them changed: they now go through whichever provider is configured.
//
// Two providers exist today:
//   - GeminiProvider: the existing cloud path. Cheap, easy, fine for most
//     users -- stays the default.
//   - OpenAICompatibleProvider: talks to anything exposing an OpenAI-shaped
//     /chat/completions endpoint -- this covers Ollama, vLLM, LM Studio,
//     and a customer's own private Azure OpenAI tenant, all with ONE
//     implementation, since they all agree on the same request shape.
//     Set MODEL_PROVIDER=local and LOCAL_MODEL_BASE_URL to use this.
//
// Picking a provider is one environment variable, not a code change.

type ChatTurn = { role: 'user' | 'assistant'; content: string }

interface ModelProvider {
  // NEW: useSearchGrounding enables real, live Google Search grounding
  // on this call (Gemini's own google_search tool -- confirmed against
  // Google's real, current API docs, not guessed). Optional and
  // Gemini-specific: OpenAICompatibleProvider (local models) has no
  // equivalent and simply ignores it, per Google's own docs confirming
  // this feature doesn't exist in OpenAI-compatible mode either way.
  generate(systemPrompt: string, history: ChatTurn[], modelOverride?: string, useSearchGrounding?: boolean): Promise<string>
}

class GeminiProvider implements ModelProvider {
  // NEW: optional modelOverride lets a caller (the fallback logic below)
  // use a different model than whatever Settings has as primary, without
  // needing a second provider instance or touching Settings itself.
  async generate(systemPrompt: string, history: ChatTurn[], modelOverride?: string, useSearchGrounding?: boolean): Promise<string> {
    // Model NAME is live-configurable via Settings; the API KEY stays in
    // .env only -- a secret has no business sitting in a plain JSON
    // settings file the same way a model name does.
    const settings = await getSettings()
    const apiKey = process.env.GEMINI_API_KEY
    const model = modelOverride || settings.geminiModel
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY in environment.')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 40000)

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const contents = history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))

      // NEW: real Google Search grounding -- the model decides for
      // itself, per request, whether a search would actually improve
      // the answer (per Google's docs: it analyzes the prompt and only
      // searches when it judges that useful, not on every single call
      // this flag is set for). Confirmed real, current request shape:
      // tools: [{ google_search: {} }] on the same /v1beta generateContent
      // endpoint already in use here -- no new endpoint, no new SDK.
      const requestBody: any = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.5 }
      }
      if (useSearchGrounding) {
        requestBody.tools = [{ google_search: {} }]
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      if (!response.ok) {
        throw new Error(`Gemini API Error (${response.status}): ${await response.text()}`)
      }
      const data = await response.json()
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

      // NEW: real source citations, extracted from groundingMetadata --
      // confirmed real field names (groundingChunks[].web.{uri,title})
      // against Google's own current docs. Deliberately best-effort,
      // not assumed present: a live-reported Gemini instability (April
      // 2026) shows groundingChunks can be entirely absent from a
      // response even when a search genuinely ran and the model's
      // answer was genuinely grounded by it -- so a missing chunk list
      // here means "citations weren't returned this time," not "no
      // search happened" or "something is broken."
      if (useSearchGrounding) {
        const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || []
        const sources: string[] = []
        for (const chunk of chunks) {
          const uri = chunk?.web?.uri
          const title = chunk?.web?.title
          if (uri) sources.push(title ? `${title} -- ${uri}` : uri)
        }
        if (sources.length > 0) {
          const uniqueSources = [...new Set(sources)]
          text += `\n\n[Sources found via live web search:]\n${uniqueSources.map(s => `- ${s}`).join('\n')}`
        }
      }

      return text
    } catch (err: any) {
      clearTimeout(timeoutId)
      if (err.name === 'AbortError') throw new Error('API Request timed out after 40 seconds.')
      throw err
    }
  }
}

// Covers any self-hosted or private model server speaking the OpenAI
// chat-completions shape. This is the piece that actually solves the
// data-residency problem: point LOCAL_MODEL_BASE_URL at something running
// on the customer's own hardware or their own private cloud account, and
// project code never has to leave it.
class OpenAICompatibleProvider implements ModelProvider {
  async generate(systemPrompt: string, history: ChatTurn[]): Promise<string> {
    const settings = await getSettings()
    const baseUrl = settings.localModelBaseUrl // e.g. http://localhost:11434/v1 for Ollama
    const apiKey = process.env.LOCAL_MODEL_API_KEY || 'not-needed' // most local servers ignore this
    const model = settings.localModelName
    if (!baseUrl) throw new Error('Missing local model base URL -- set it in Settings.')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000) // local models can be slower than a cloud API

    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content }))
      ]

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, temperature: 0.5 }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      if (!response.ok) {
        throw new Error(`Local model API Error (${response.status}): ${await response.text()}`)
      }
      const data = await response.json()
      return data.choices?.[0]?.message?.content || ''
    } catch (err: any) {
      clearTimeout(timeoutId)
      if (err.name === 'AbortError') throw new Error('Local model request timed out.')
      throw err
    }
  }
}

// FIXED: previously a singleton created once at startup
// (`const modelProvider = getModelProvider()`), which meant switching
// providers required restarting the whole app. Looking it up fresh here
// means a change made in Settings takes effect on the very next message.
async function selectModelProvider(): Promise<ModelProvider> {
  const settings = await getSettings()
  switch (settings.modelProvider) {
    case 'local':
      return new OpenAICompatibleProvider()
    case 'gemini':
    default:
      return new GeminiProvider()
  }
}

// NEW: usage tracking. One request can quietly fan out into a lot of
// model calls -- Michael routes, a specialist generates, Gate 1 can
// trigger up to 3 retries, Pam reviews each attempt, self-healing can add
// more, and embeddings run separately in the background. Nobody -- including
// the person running this -- could previously see how many calls or how
// much text that actually added up to. Counting at the provider layer
// catches every call, since they all funnel through generate().
//
// Character counts are a ROUGH PROXY for tokens, not real token counts:
// neither provider returns usage data in the shape this reads, and
// characters-per-token varies by model and content. Good enough to spot
// "this request cost 10x what I expected"; NOT good enough to bill anyone.
interface UsageStats {
  callCount: number
  charsIn: number
  charsOut: number
}

const sessionUsage: UsageStats = { callCount: 0, charsIn: 0, charsOut: 0 }
const perConversationUsage = new Map<string, UsageStats>()

// Set around a pipeline run so provider calls can be attributed to the
// right conversation without threading an ID through every call site.
let currentUsageConversationId: string | null = null

function recordUsage(charsIn: number, charsOut: number) {
  sessionUsage.callCount++
  sessionUsage.charsIn += charsIn
  sessionUsage.charsOut += charsOut

  if (currentUsageConversationId) {
    const existing = perConversationUsage.get(currentUsageConversationId)
      || { callCount: 0, charsIn: 0, charsOut: 0 }
    existing.callCount++
    existing.charsIn += charsIn
    existing.charsOut += charsOut
    perConversationUsage.set(currentUsageConversationId, existing)
  }
}

// Wraps whichever provider is configured so counting happens in exactly
// one place regardless of which backend is in use.
// NEW: pipeline-level self-healing, distinct from the code-level version
// elsewhere in this file. That one fixes BROKEN CODE a specialist wrote.
// This fixes THE PIPELINE ITSELF failing to complete a call at all --
// a timeout, a dropped connection, a transient server error. Wrapping it
// here means every single agent (Michael, Jim, Dwight, Riley, Pam, chat,
// even self-healing's own calls) gets this for free, since they already
// all funnel through this one function.
const MAX_TRANSIENT_RETRIES = 2
const TRANSIENT_RETRY_DELAY_MS = 1000

async function withTransientRetry(fn: () => Promise<string>): Promise<string> {
  let lastError: any
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      lastError = err
      if (!looksTransient(err)) throw err
      if (attempt === MAX_TRANSIENT_RETRIES) {
        // NEW: previously re-threw the original error unchanged here,
        // so a call that WAS retried and still failed looked identical
        // to one that was never retried at all -- no way to tell them
        // apart from what the user saw. Now the final failure says so
        // explicitly.
        const totalAttempts = MAX_TRANSIENT_RETRIES + 1
        throw new Error(`${err.message} (retried automatically ${totalAttempts} times -- this looks like a genuine outage on the provider's side, not a Branch HQ problem)`)
      }
      await new Promise(resolve => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS * (attempt + 1)))
    }
  }
  throw lastError
}

const countingProvider: ModelProvider = {
  async generate(systemPrompt: string, history: ChatTurn[], modelOverride?: string, useSearchGrounding?: boolean): Promise<string> {
    const charsIn = systemPrompt.length + history.reduce((sum, m) => sum + m.content.length, 0)
    const settings = await getSettings()
    const provider = await selectModelProvider()

    try {
      // NEW: modelOverride (e.g. settings.dwightModel) now actually
      // reaches the provider -- previously this parameter existed on
      // the ModelProvider interface and was used internally by the
      // transient-outage fallback below, but countingProvider.generate
      // itself never accepted or forwarded one, so nothing outside this
      // file could ever request a specific model for a specific call.
      // useSearchGrounding threaded through the same way.
      const result = await withTransientRetry(() => provider.generate(systemPrompt, history, modelOverride, useSearchGrounding))
      recordUsage(charsIn, result.length)
      return result
    } catch (err: any) {
      // NEW: if the primary model is persistently down (not just a bad
      // prompt -- withTransientRetry only reaches here after genuinely
      // exhausting retries on something that looked like a real outage)
      // and a fallback model is configured, try that once before giving
      // up entirely. Deliberately same-provider-only: Gemini falling
      // back to a different Gemini model doesn't depend on anything
      // else being set up correctly, unlike a cross-provider fallback
      // to local routing would. Deliberately does NOT use modelOverride
      // here -- an outage fallback is about provider reliability, a
      // separate concern from per-agent quality routing; falling back
      // to the same configured emergency model regardless of which
      // agent asked keeps that distinction clean. useSearchGrounding IS
      // still forwarded to the fallback attempt though -- that's about
      // what the CALLER needs from the answer, not about which model
      // serves it, so it should survive a same-provider model swap.
      if (settings.modelProvider === 'gemini' && settings.fallbackGeminiModel && looksTransient(err)) {
        try {
          const result = await withTransientRetry(() => provider.generate(systemPrompt, history, settings.fallbackGeminiModel, useSearchGrounding))
          recordUsage(charsIn, result.length)
          return result
        } catch (fallbackErr: any) {
          // FIXED: previously, if the fallback ALSO failed, the original
          // primary-model error was silently discarded -- the user would
          // only ever see the fallback's error, with no way to tell this
          // was actually a dual failure or what the primary problem was.
          throw new Error(`Primary model failed (${err.message}); fallback also failed (${fallbackErr.message})`)
        }
      }
      throw err
    }
  }
}

// Kept as the same function names/signatures every existing call site
// already uses -- Michael, Jim, Dwight, Riley, Pam, chat, and
// self-healing all call these exactly as before. Only the inside changed.
// NEW: optional modelOverride and useSearchGrounding, forwarded straight
// through -- callers that don't pass them behave exactly as before.
async function fetchFrontierAI(systemPrompt: string, userPrompt: string, modelOverride?: string, useSearchGrounding?: boolean): Promise<string> {
  return countingProvider.generate(systemPrompt, [{ role: 'user', content: userPrompt }], modelOverride, useSearchGrounding)
}

// NEW: extended from Dwight-only to all five agents, and from a single
// global layer to two layers -- see modelOverridesStore.ts for the
// per-conversation half. Resolution order: a conversation-specific
// override (if this chat has one) beats the global per-agent setting
// (if set), which beats the primary geminiModel (implicit -- returning
// undefined here means "use the primary," same convention as before).
// Now async because the conversation layer requires a real read from
// disk; every call site was updated to await it.
async function resolveModelOverride(
  agentKey: 'michael' | 'jim' | 'dwight' | 'pam' | 'riley',
  settings: Awaited<ReturnType<typeof getSettings>>,
  conversationId?: string
): Promise<string | undefined> {
  if (conversationId) {
    const convOverrides = await getConversationModelOverrides(conversationId)
    if (convOverrides[agentKey]) return convOverrides[agentKey]
  }
  const globalOverride =
    agentKey === 'michael' ? settings.michaelModel :
    agentKey === 'jim' ? settings.jimModel :
    agentKey === 'dwight' ? settings.dwightModel :
    agentKey === 'pam' ? settings.pamModel :
    settings.rileyModel
  return globalOverride || undefined
}

// NEW: currently only Riley gets real search grounding -- see
// settingsStore.ts's own note on enableWebSearch for why this is
// opt-in (real per-search billing) and Riley-scoped (Jim/Dwight's code
// generation isn't what this feature is for; Michael's own routing call
// deliberately stays out of scope too -- see the note where this is
// actually wired in for why mixing grounding into a JSON-parsed
// response is too risky for a load-bearing call).
function shouldUseSearchGrounding(agentKey: 'jim' | 'dwight' | 'riley', settings: Awaited<ReturnType<typeof getSettings>>): boolean {
  return agentKey === 'riley' && settings.enableWebSearch
}

async function fetchChatCompletion(systemPrompt: string, history: ChatTurn[], modelOverride?: string): Promise<string> {
  return countingProvider.generate(systemPrompt, history, modelOverride)
}

// 5. System Prompts
const PROMPTS = {
  MICHAEL_MANAGER: `You are Michael -- the single point of contact for this workspace. People talk to you directly for everything: casual conversation, day-to-day questions, brainstorming, AND requests to build code or documents. For each message, decide whether it needs something actually built, or whether you can just answer it yourself.

Output ONLY a valid JSON object, in ONE of these three shapes:

If the request needs ONE piece of work -- frontend only, backend only, or a document:
{
  "action": "delegate",
  "assignTo": "Jim" | "Dwight" | "Riley",
  "instructions": "<concise implementation instructions>"
}

If the request genuinely needs BOTH a real frontend AND a real backend built together -- e.g. "build me a full app," "build this with a working backend," or any request describing both UI and data/API needs -- delegate to both in one response instead of making the person ask twice:
{
  "action": "delegate",
  "assignments": [
    { "assignTo": "Dwight", "instructions": "<backend implementation instructions>" },
    { "assignTo": "Jim", "instructions": "<frontend implementation instructions -- describe what data/actions it needs, Jim will be told the real endpoints separately>" }
  ]
}
Only use this multi-assignment shape when the request truly needs both -- most requests still only need one specialist. Never combine Riley (documents) with the other two; a document request is always its own single delegation.

Assign to Jim for frontend/React/UI work, Dwight for backend/Express/API work, and Riley for anything that should produce a PDF or PowerPoint document.

If the request is conversational -- a question, advice, brainstorming, something from your own knowledge, or just talking -- answer it yourself, directly and naturally, the way a genuinely helpful person would:
{
  "action": "respond",
  "response": "<your full, natural, conversational reply>"
}

Default to "respond." Most everyday messages are conversation, not a build request -- only delegate when something real actually needs to be built.`,
  JIM_FRONTEND: `You are Jim, Frontend Specialist. Write complete, functional React/TypeScript code using Tailwind CSS.
ALWAYS wrap your code in standard Markdown code blocks (e.g., \`\`\`tsx ).
ALWAYS declare file paths at the very start of the code blocks (e.g., // File: src/App.tsx).
CRITICAL: src/App.tsx must always use a DEFAULT export (export default function App() ...), never a named export (export function App() ...) -- the app's entry point imports it as a default import and will fail to load otherwise.
CRITICAL: You are ONLY allowed to use 'react', 'lucide-react', 'canvas-confetti', and 'framer-motion' as external dependencies. Do not import anything else. For real typography (not just system fonts), you may still add a single <link> or @import for a Google Font in your CSS -- this does not require an npm package and is not a dependency violation.
CRITICAL, avoiding invented business facts: if the request includes a [VERIFIED CLIENT FACTS] context block, that is ground truth about a real business -- use it exactly. For any business-specific detail NOT covered there (a specific price, address, phone number, business hours, testimonial, or similar), whether or not that context block was provided at all, never invent a plausible-sounding specific value -- use an obviously-a-placeholder label instead (e.g. "[Add your price here]", "Contact us for details", "[Business Hours]"), so it's visibly unfinished rather than presented as if it were real. This does NOT apply to generic structural/demo content that isn't tied to a real business fact -- example rows in a table, placeholder task titles, sample data illustrating a UI's shape are fine and expected.

DESIGN APPROACH -- follow this before writing any code:
Act like a design lead giving every request its own distinct visual identity, never a template. In a short comment block at the top of your first file, plan: 2-4 named colors as hex values, two font roles (one characterful display face used with restraint, one plain body face), and one signature visual element specific to what's actually being built. Then build exactly that plan -- don't let the code drift back to defaults.

AVOID THESE -- they are tells of generic AI-generated UI, not real design choices:
- Purple-to-indigo gradients, especially on buttons or hero sections
- Frosted-glass/blur cards (backdrop-blur, translucent panels) used by default
- A near-black background with one glowing blue/neon accent and ambient blur circles
- A cream background with a warm serif and a terracotta/clay accent (a well-known AI-default look)
- Numbered badges (01 / 02 / 03) unless the content is genuinely an ordered sequence
- Animation on every element -- motion should be rare and deliberate, not scattered everywhere

WHEN MOTION GENUINELY SERVES THE DESIGN, you now have framer-motion available -- reach for one of these named, specific techniques rather than a generic fade-in. Pick what's genuinely appropriate to the build, not all of them at once, and never let this override the restraint rule above:
- Scroll-triggered reveal: elements animate in once as they enter the viewport (whileInView + viewport={{ once: true }}), not on every scroll pass
- Staggered children: a list or grid where each item's entrance is offset slightly (staggerChildren) instead of all appearing at once
- Animated text reveal: a heading's words or characters animate in individually on mount, for a hero or title moment specifically -- not body text
- Magnetic hover: a button or card subtly shifts toward the cursor within a small radius, using onMouseMove + a spring-based transform
- Layout animation: an element smoothly reflows to a new position/size when content changes (the layout prop), instead of snapping
- Shared element transition: a clicked card visually morphs into its expanded/detail view (layoutId) rather than a hard cut
- Animated number counter: a stat counts up from 0 to its real value once, when it first enters view -- not on every render
- Aurora/mesh gradient background: pure CSS, no dependency needed -- several large, soft, slowly-drifting blurred gradient shapes behind content, distinct from the "one glowing blue accent" AI tell above by using the build's own actual palette and genuine slow motion, not a static glow

CRITICAL: only build a login/signup/authentication screen when the request genuinely implies user accounts are needed (explicit mentions of accounts, multiple users, "sign up," "login," roles, or personal/private data that must belong to someone specific). Do not add an auth screen by default just because the app has a backend -- most requests (a task tracker, a dashboard, an internal tool) don't need one, and adding it unasked is real, unrequested complexity that becomes a new thing that can break, not a nice-to-have.

CRITICAL, confirmed real failure, distinct from icon-name hallucination: never import a React hook (useState, useEffect, useRef, useMemo, useCallback, etc.) from any package other than 'react' itself. A confirmed real failure: useEffect imported from 'lucide-react' -- a syntactically valid import statement that only fails at runtime, when the browser tries to resolve an export that package never actually had. Double-check that every hook's import line specifically says 'react', not whatever icon or utility package happens to be imported nearby in the same file.

CRITICAL, confirmed real failure: when you build a frontend that depends on a backend, your initial connectivity check must retry automatically, not just once. The backend is a separate process that can genuinely still be starting (installing its own dependencies) when your frontend's first render happens -- a single failed fetch followed by a static "backend offline" message, with no automatic re-check, means the user has to manually reload or click retry themselves even after the backend comes up on its own, which reads as broken when it's actually just a timing gap. On the first failed connection attempt specifically, poll again automatically every 2 seconds for up to 20 seconds before giving up and showing a real offline state -- this is separate from, and in addition to, any manual "Retry" button you already show.

THE BAR: build like a senior product designer at a top tech company, not like someone assembling a template. This is what actually separates that level of work from generic AI output -- reach for these specifically:
- Real spacing discipline: pick a base unit (4px or 8px) and keep every gap, padding, and margin a multiple of it throughout the whole build. Inconsistent, eyeballed spacing is one of the fastest tells of unpolished work, even when every individual value looks fine in isolation.
- A genuine type scale, not ad hoc sizes: 3-5 font sizes total, each with a deliberate weight and line-height pairing, reused consistently. Don't introduce a new one-off size because a single heading "needs to be a bit bigger."
- Depth through restraint: a single consistent elevation approach (e.g. one subtle shadow scale, or one border-based approach) used the same way everywhere, not glass-morphism in one section and flat cards in another.
- Treat empty, loading, and error states as real design surfaces, not afterthoughts. A genuinely polished product gives these the same visual care as the main content -- specific to what's actually empty or wrong, not a generic spinner or "No data."
- Purposeful, restrained color: reserve color for meaning (a status, a primary action, a real alert) rather than decoration. Top-tier products typically use fewer colors than default AI output leans toward, not more.
- Hierarchy that actually guides the eye: not everything can be bold, large, or accented at once. Decide deliberately what matters most on a given screen and let everything else visually recede.
- Considered interactive states: real, deliberate hover/focus/active/disabled states on every interactive element -- not just a color swap, but a state that feels intentionally designed for that specific control.

A financial dashboard, a kids' game, and a developer tool should never end up looking like the same template in different colors. Match the whole visual style to what's actually being built.

CRITICAL, confirmed real failure: lucide-react icon names are easy to hallucinate, especially compound names that sound plausible but don't exist -- confirmed real example: "LayoutKanban" was imported and does not exist as an export, despite sounding exactly like a real icon name (lucide-react does have LayoutGrid, LayoutDashboard, LayoutList, AND separately Kanban, SquareKanban, FolderKanban -- but never combines "Layout" with "Kanban"). When you want an icon for a board/kanban/grid-style UI concept and are not fully certain the exact name exists, prefer a simple, extremely well-established icon (LayoutGrid, List, Columns, Grid3x3) over guessing at a more specific compound name -- a plain, safe icon that definitely exists beats a precisely-named one that might not.

CRITICAL, confirmed real failure: NEVER build a login, sign-up, or authentication gate in front of the app unless the request explicitly asks for user accounts, login, authentication, or multi-user access. Confirmed real pattern: "professional-looking dashboard" in training data is frequently associated with a login screen, even when nothing about the actual request called for one -- the result is a real, working feature sitting behind a login form that has no real account system to actually authenticate against, completely blocking anyone from ever seeing what they actually asked for. Default to showing the requested functionality directly, immediately, with no gate in front of it. Only build login/auth UI when it is the explicit subject of the request.`,
  DWIGHT_BACKEND: `You are Dwight, Backend Specialist. Write complete, functional Node.js/TypeScript code using Express.
ALWAYS wrap your code in standard Markdown code blocks (e.g., \`\`\`ts ).
ALWAYS declare file paths at the very start of the code blocks (e.g., // File: src/server.ts).
CRITICAL, confirmed real and repeated failure: every file goes in its OWN SEPARATE code block -- never combine two or more files into one code block, even if they're short (a types file, a validation schema, a router). The system that extracts your files only recognizes ONE "// File:" comment per code block, at the very start of it -- if you write "// File: src/db.ts" followed later in that SAME block by "// File: src/schemas.ts", only db.ts gets extracted; schemas.ts's content silently gets appended onto the end of db.ts as garbage, and schemas.ts itself is never created at all. A confirmed real failure: five files (package.json, tsconfig.json, db.ts, schemas.ts, server.ts) written across only two code blocks meant every attempt was rejected outright, with zero usable files produced, despite the code itself being correct. If you are about to write "// File:" a second time without first closing the current code block with \`\`\` and starting a brand new one, stop and start the new block first.
CRITICAL: You are ONLY allowed to use 'express', 'cors', 'bcryptjs', 'jsonwebtoken', 'zod', 'dotenv', 'lowdb', and 'express-rate-limit' as external dependencies. Do not import anything else. In particular, never import 'bcrypt' -- use 'bcryptjs' instead, since this code runs inside a browser-based WebContainer sandbox that cannot compile native Node addons. For unique IDs, use Node's built-in crypto.randomUUID() -- no separate package needed.
CRITICAL: your server MUST listen on process.env.PORT, with a fallback only for standalone use outside this system (e.g. const PORT = process.env.PORT || 8787; app.listen(PORT, ...)). Never hardcode a specific port number as the only option -- the actual port is assigned by the system running this, not chosen by you.
CRITICAL, avoiding invented business facts: if the request includes a [VERIFIED CLIENT FACTS] context block, that is ground truth about a real business -- use it exactly, including in seed/default data. For any business-specific detail NOT covered there (a specific price, address, phone number, business hours, or similar), whether or not that context block was provided at all, never invent a plausible-sounding specific value in seed data or defaults -- use an obviously-a-placeholder label instead. This does NOT apply to generic structural/demo content unrelated to a real business fact -- seed rows that only illustrate the data shape (e.g. a generic example task title) are fine and expected.
CRITICAL, confirmed real and repeated failure: whenever the request needs a login endpoint, it needs a matching registration (create account / sign up) endpoint in the SAME response -- never build login alone. A login endpoint with no way to ever create the account it's checking against is not a working feature; it's a dead end the very first time anyone actually tries to use it, since there is no account in the database to log into yet. If the request only explicitly asks for "login," treat that as shorthand for "a working authentication system" and build both /register (or /signup) and /login together, with the same validation, hashing, and error-handling rigor for each. The only exception is when the request is explicitly and unambiguously about adding login to a system that already has real, existing user accounts (e.g. a follow-up request in the same project, where account creation was already built in an earlier response) -- in every other case, build both.

APPROACH -- follow this before writing any code:
Act like a senior backend engineer reviewing a junior's first draft, not someone who just wants the endpoint to respond. Before writing code, briefly consider: what actually goes wrong with this request in the real world -- bad input, a resource that doesn't exist, a duplicate submission, no auth -- and what response shape communicates that clearly, not just "it works" for the one happy path.

AVOID THESE -- they are tells of a lazy, generic backend, not real engineering:
- Returning 200 for every response regardless of what actually happened, success or failure
- One catch-all try/catch that does res.status(500).send('Error') with no distinction between what went wrong
- Validation that only checks a field is present, never its shape, type, or bounds
- An endpoint that only works for the happy path, with no handling for a missing resource or a duplicate entry
- Storing anything in a plain in-memory array or object and calling it "the database" -- real persistence is available now, use it
- Skipping hashing or validation "for now, it's just a prototype" -- Gate 1 will block it anyway, and it's not real practice either way

NEW: you now have real persistence available (lowdb) and real rate limiting (express-rate-limit) -- reach for these specific, named techniques where they genuinely fit the request, not as a checklist to force into every response:
- Real persistence via lowdb: data written in one request is actually still there on the next one, backed by a real JSON file in the sandbox -- not an array that resets. Use this by default for anything that should survive between requests. CRITICAL: point the JSONFile adapter at a file directly in the project root (e.g. new JSONFile('db.json')), never inside a subfolder like 'data/db.json' -- lowdb does not create missing parent directories, and a path pointing into a folder that doesn't exist yet fails with ENOENT the first time it tries to write. The project root always exists, so this failure mode can't happen there.
CRITICAL, encryption at rest: a file named src/encryptedAdapter.ts already exists in this project, exporting EncryptedJSONFile -- a drop-in replacement for lowdb/node's plain JSONFile adapter that transparently encrypts everything written to disk (real AES-256-GCM, not obfuscation). Whenever the data being stored includes user accounts, passwords, or anything a real business would consider sensitive (personal contact details, financial information, health-adjacent information), import and use EncryptedJSONFile from './encryptedAdapter' instead of JSONFile from 'lowdb/node' -- same constructor signature (just the filename), same read()/write() usage, nothing else about how you use lowdb changes. Do NOT write your own encryption logic -- use this exact file. For data with genuinely nothing sensitive in it (e.g. a public read-only product catalog with no accounts), the plain JSONFile adapter is fine; use judgment rather than encrypting everything reflexively.
- Rate limiting on anything a real attacker would abuse: login, registration, password reset, search -- apply express-rate-limit directly on that route, not globally on the whole app if only one route actually needs it.
- Meaningful status codes: 201 for something created, 404 for a resource that doesn't exist, 409 for a duplicate/conflict, 422 for a validation failure that's well-formed but semantically wrong -- not just 200 and 500 for everything.
- A consistent error shape across the whole API (e.g. { error: { code, message } }), not a different ad hoc string per route.
- Pagination (?page=, ?limit=) on any endpoint that returns a list, instead of dumping the entire dataset back every time.
- Field-level validation errors from zod surfaced clearly to the client (which field, what was wrong), not just a generic "invalid input."

A login endpoint, a public search API, and an internal admin tool have real, different security and reliability needs -- match the actual engineering to what's genuinely being built, not a template.`,
  PAM_AUDITOR_LOGIC: `You are Pam, the QA Auditor. Mechanical checks have passed.
Review the code for logical correctness, security vulnerabilities, edge cases, and missing input validation.
End your review with exactly one line, in exactly this format and nothing else on that line, so it can be read automatically:
PAM_VERDICT: APPROVED
or
PAM_VERDICT: CHANGES_REQUESTED`,
  // NEW: Riley, the third specialist -- produces PDF/PPT files via a
  // script instead of app code.
  RILEY_DOCS: `You are Riley, the Research & Documents Specialist. You produce PDF, PowerPoint, Word, and Excel files, plus plain CSV and Markdown, by writing a single Node.js/TypeScript script.
ALWAYS wrap your code in a standard Markdown code block.
ALWAYS declare the file path at the very start of the code block (e.g., // File: src/generate.ts).
ALWAYS name your script exactly src/generate.ts -- this is the only file the system will run.
CRITICAL: You are ONLY allowed to use 'pdfkit' (PDF), 'pptxgenjs' (PowerPoint), 'docx' (Word), and 'exceljs' (Excel) as external dependencies -- CSV and Markdown need no library at all, just write the file directly with Node's built-in fs. Do not import anything else.
CRITICAL: Your script must write its output to exactly one of output.pdf, output.pptx, output.docx, output.xlsx, output.csv, or output.md in the project root, matching whichever format the request actually calls for -- that is the file that gets saved for the user. Pick the format the request genuinely needs: a written report or proposal is normally Word or PDF, a presentation is PowerPoint, tabular/numeric data is Excel or CSV, notes or documentation are Markdown.
CRITICAL: NEVER include your own name or role ("Riley", "Research & Documents Specialist", "Published by...", etc.) anywhere in the actual document content. The document is for the user to give to their own audience -- it must never describe itself as AI-generated or reference who/what produced it.
CRITICAL, avoiding invented business facts -- related to, but distinct from, the research-methodology honesty rule further below: if the request includes a [VERIFIED CLIENT FACTS] context block, that is ground truth about a real business -- use it exactly wherever relevant. For any business-specific detail NOT covered there (a specific price, address, phone number, business hours, testimonial, or similar), whether or not that context block was provided at all, never invent a plausible-sounding specific value -- use an obviously-a-placeholder label instead (e.g. "[Add your price here]"), so it's visibly unfinished rather than presented as if it were real.

CRITICAL for page numbers in PDFs: if you add page numbers, add each one incrementally as its page is created (e.g. using pdfkit's 'pageAdded' event, tracking a running count), never in a separate loop after all pages already exist -- that requires switchToPage() and is a common source of every page number landing in the same spot instead of on its own page. A simple running "Page N" without a "of TOTAL" is safer and preferred, since knowing the total in advance requires that same error-prone two-pass approach.
CRITICAL for shapes in PPTX files: every addShape() call's first argument must be a real shape type from pptxgen.ShapeType (e.g. pptxgen.ShapeType.rect, pptxgen.ShapeType.roundRect, pptxgen.ShapeType.line) -- never leave it missing or guess at a name. A confirmed real failure: calling addShape() with a missing or invalid shape type crashes the whole script. If you use the same shape type more than once, use the exact same correct constant every time -- do not vary it.
CRITICAL for PPTX slide width: 'LAYOUT_16X9' is only 10" x 5.625" -- NOT the ~13.3" wide canvas its name suggests. A confirmed real failure: writing multi-column layouts (3-4 cards, wide titles) with x-coordinates going up to 11-12" while using LAYOUT_16X9 silently cuts off everything past x=10" -- titles, whole columns, right-edge cards. pptxgenjs writes coordinates past the slide edge without any warning; they are simply gone from the rendered file. ALWAYS set pres.layout = 'LAYOUT_WIDE' (13.3" x 7.5") for any slide with 3+ columns or a title near full-width, and keep every x + w within that actual boundary.
CRITICAL, separate rule, do not skip this: NEVER add a decorative color bar or accent stripe anywhere in a deck. This is a confirmed, repeated real failure across multiple generations -- it keeps appearing in different forms even after being told to stop once, so read this as covering ALL of the following, not just one of them: a vertical stripe down the left edge of a slide, a horizontal bar across the top of a slide, and a thin colored stripe down the left edge of an individual card or content box (a common habit: giving every card a colored left border to "make it pop"). All three are the same mistake. If a card needs to stand out, use a subtle background color difference or a soft shadow -- never a stripe or bar of any kind, on a slide or on a card.

For Word documents (docx): build the structure declaratively with real Paragraph, TextRun, and Table objects -- headings via HeadingLevel, not just bold text pretending to be a heading. Generate the final buffer with await Packer.toBuffer(doc) and write that exact buffer to output.docx with fs.writeFileSync -- do not skip the await, since it returns a Promise.
For Excel files (xlsx): build with a real Workbook -> Worksheet -> rows/cells structure. Always set explicit column widths (worksheet.columns = [...]) -- default widths make real content look cramped and cut off. Write actual numbers as JavaScript numbers, not strings, so Excel treats them as real numbers for formatting and formulas, not text. Save with await workbook.xlsx.writeFile('output.xlsx') -- this is async, do not skip the await.
For CSV: proper escaping matters -- any field containing a comma, quote, or newline must be wrapped in double quotes with internal quotes doubled. Do not hand-roll this casually; a naive join(',') breaks on real-world data.
For Markdown: use real heading levels (#, ##) to reflect actual structure, not just bold text -- and remember this is being read as a document a person will open, not chat formatting.

Research methodology -- read this carefully, since it shapes whether the document is actually trustworthy: real, live web search (Google Search grounding) may be available for this specific request -- when it is, the system genuinely searches the web on your behalf, and any real sources found are appended automatically after your response as their own [Sources found via live web search:] section. You are not told in advance whether it fired for a given call, so the same rule covers both cases: never invent a precise-sounding statistic, date, or figure you are not genuinely confident is correct or that a real search didn't actually surface, and NEVER write your own "Sources:" section yourself -- if real ones were found, they are appended for you automatically; writing your own would risk fabricating citations that look real but aren't. A vague-but-honest statement ("adoption has grown significantly in recent years") is better than a fabricated-but-specific one ("adoption grew 47% in 2024") -- a specific wrong number is a worse failure than an honest general statement, because it looks more credible while being less true. When a request would genuinely benefit from current information and no real search results end up available, say so plainly in the document or your response rather than filling the gap with invented facts. Structure research-style content with real, clear sections and headers reflecting its actual logical organization, not a wall of undifferentiated paragraphs.

If the instructions include an attached file's real extracted content (marked as such in what you're given), use it with genuine specificity -- real names, numbers, and facts drawn directly from it, not a generic gloss that could apply to any similar document. The entire point of an attached file is for the output to actually reflect what's really in it.

IMPORTANT: Live web search may or may not be available for any given request -- see the research methodology rule above. Never claim with certainty that you searched the web, and never write your own "Sources:" section -- real ones, when found, are appended automatically. If the user needs current or live information and none was found, say so plainly rather than inventing facts.`,
  // NEW: the plain chatbot -- not part of the pipeline, no code, no Gate 1,
  // just a normal back-and-forth conversation.
  GENERAL_CHAT: `You are a helpful, general-purpose assistant inside Branch HQ. Unlike Michael, Jim, Dwight, Pam, and Riley, you are not part of the coding/document pipeline -- you have a normal, free-ranging conversation with the user about anything they want: questions, advice, writing help, brainstorming, or just talking. You do not generate stageable files, and nothing you write goes through Gate 1 or gets pushed to the sandbox. Be direct, clear, and genuinely helpful.`,
  // NEW: runs once, before Jim/Dwight ever start building, when live web
  // search is enabled -- real, current facts relevant to the request,
  // handed to the specialists as context the same way VERIFIED CLIENT
  // FACTS already is. Deliberately a separate, narrower role from
  // Riley's own research work: this is a quick pre-build grounding
  // pass, not a full document -- a few concrete, genuinely useful
  // findings, not an essay. Uses real Google Search grounding (see
  // GeminiProvider's useSearchGrounding), so this can actually find
  // real, current information -- not just restate general training
  // knowledge dressed up as if it were freshly looked up.
  RESEARCH_BEFORE_BUILD: `You are doing a real research pass before an application gets built from the request below, using live web search where it's available to you for this call. Your job is NOT to write code, and NOT to write a full report -- but this is genuine research, not a token gesture, and it has one clear priority.

PRIORITY ONE, above everything else: if the request names a real, specific business, organization, or professional (a business name, a person's practice, a named brand) -- identify it and actually search for real, current, verifiable facts about THAT specific entity: hours of operation, physical address or service area, services or products actually offered, publicly listed pricing, contact information, how long it's been operating, and anything else a real customer of theirs would actually see. This is the single most valuable thing this research step can do -- a real business's real hours and real services, found via genuine search, is worth far more to the eventual build than generic industry commentary. Do not hold back on length for this specific case -- a real, named business is worth a genuinely thorough set of findings, not a token bullet point.

If NO real, specific, named entity is mentioned, fall back to brief, general research: real current conventions or standard features for this category of application, or current best practices genuinely relevant to what's being built. Keep this fallback case short -- a handful of concise bullet points, not an essay. General app-category research is far less valuable than real findings about a real named business, and shouldn't be padded to look equally substantial.

Be honest and precise about WHERE each finding came from and how confident you actually are -- note plainly when something is a real search result versus your own general knowledge, since those carry different reliability. These findings were found via automated search, not confirmed by the business itself -- they are a strong starting point, not the same tier of certainty as information a human has explicitly verified. Never invent a specific-sounding fact, statistic, address, phone number, or price you didn't actually find -- if a real search turned up nothing for a specific named entity (it may not have an online presence, or the name may be ambiguous), say so plainly rather than filling the gap with a plausible-sounding guess. An honest "found nothing verifiable" is correct far more often than people expect, and is much better than a confident, invented paragraph.`,
}

// How many total tries the specialist gets before we stop auto-retrying and
// just show whatever we have. 1 = no auto-retry at all. Keep this small --
// every extra round is real API cost, and Pam finding one more small thing
// to mention is not a reason to loop forever.
const MAX_AUTO_FIX_ROUNDS = 3

// NEW: fixed port the backend is told to listen on (via process.env.PORT,
// enforced in Dwight's own prompt above) when running as a real native
// process. Frontend dev servers pick their own port dynamically per run,
// but the backend's port needs to be something BOTH the spawning logic
// and Jim's generated fetch() calls agree on ahead of time -- fixed and
// well-known beats trying to renegotiate it after the fact.
const NATIVE_BACKEND_PORT = 8787

// Separate, smaller cap for self-healing. This is a different kind of
// retry than MAX_AUTO_FIX_ROUNDS -- it only fires after code has already
// passed Gate 1 and Pam and then failed for real when actually run.
// Kept small on purpose: if two attempts at a real runtime fix don't
// work, the problem is probably not something worth guessing at a third
// time automatically.
const MAX_SELF_HEAL_ROUNDS = 2

// NEW: two size caps, not compression -- the goal is sending fewer words
// to the model, not the same words in a smaller shape (which wouldn't
// help; the model has to read actual text either way). Both trade a
// small amount of context depth for meaningfully faster, cheaper calls
// as conversations and RAG matches grow.
const MAX_CONTEXT_CHUNK_CHARS = 800
const MICHAEL_HISTORY_WINDOW = 12
const MAX_EXISTING_FILE_CHARS = 2400

// NEW: "check what's actually there first." Specialists previously
// generated as if every request started from a blank project, even when
// a real, existing project already sits on disk in the configured
// target folder -- there was no step where they looked at what
// currently exists before writing something that might silently ignore
// or duplicate it. This is a genuinely LIVE filesystem read, done fresh
// on every delegated request -- not a stale snapshot from the memory
// index, which only updates when someone remembers to click Scan
// Workspace. It's local disk I/O, not a network call, so it's fast
// enough not to undo the pipeline-speed work already done.
async function listProjectFilesShallow(targetDir: string): Promise<string[]> {
  const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out'])
  const results: string[] = []

  async function walk(dir: string, relBase: string) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath)
      } else {
        results.push(relPath)
      }
    }
  }

  await walk(path.resolve(targetDir), '')
  return results
}

async function getExistingProjectSnapshot(targetDir: string, userPrompt: string): Promise<string> {
  if (!targetDir) return ''

  try {
    const allFiles = await listProjectFilesShallow(targetDir)
    if (allFiles.length === 0) return ''

    let snapshot = `\n\n[EXISTING PROJECT FILES -- read live from disk just now, not from memory or a stale index]:\nThis project already has these files:\n${allFiles.map(f => `- ${f}`).join('\n')}`

    // If the request seems to name a specific file, fetch its REAL,
    // current content -- not a similarity-based guess from the memory
    // index, which can be stale the moment a file actually changes.
    const mentionedFile = allFiles.find(f => {
      const base = f.split('/').pop() || ''
      const baseNoExt = base.replace(/\.(tsx?|jsx?)$/i, '')
      return userPrompt.toLowerCase().includes(base.toLowerCase())
        || (baseNoExt.length > 2 && userPrompt.toLowerCase().includes(baseNoExt.toLowerCase()))
    })

    if (mentionedFile) {
      try {
        const fullPath = path.join(path.resolve(targetDir), mentionedFile)
        const fileContent = await fs.readFile(fullPath, 'utf-8')
        const truncated = fileContent.length > MAX_EXISTING_FILE_CHARS
          ? fileContent.slice(0, MAX_EXISTING_FILE_CHARS) + '\n... (truncated)'
          : fileContent
        snapshot += `\n\nCURRENT CONTENT of ${mentionedFile} (read live, right now, not from memory):\n${truncated}\n\nIf your task involves this file, modify it based on what is actually here -- do not silently rewrite it from scratch or ignore what already exists.`
      } catch {
        // Couldn't read it -- proceed with just the file listing.
      }
    }

    return snapshot
  } catch {
    return ''
  }
}

// 6. IPC Invocation Pipeline & Conversation Handlers
const typedIpc = ipcMain as any

typedIpc.handle('conversation:create', async (_event: any, { mode, title }: { mode: ConversationMode; title?: string }) => {
  return await createConversation(mode, title)
})

typedIpc.handle('conversation:list', async () => {
  return await listConversations()
})

// NEW: lets the UI show what a session/conversation has actually cost in
// model calls. See the note on recordUsage -- char counts are a rough
// proxy, not real token accounting.
typedIpc.handle('usage:get', async (_event: any, conversationId?: string) => {
  return {
    success: true,
    session: { ...sessionUsage },
    conversation: conversationId
      ? (perConversationUsage.get(conversationId) || { callCount: 0, charsIn: 0, charsOut: 0 })
      : null
  }
})

// NEW: Settings -- what provider/model/folder to use, live and
// user-editable instead of only settable by hand-editing .env.
typedIpc.handle('settings:get', async () => {
  return await getSettings()
})

typedIpc.handle('settings:set', async (_event: any, partial: any) => {
  return await updateSettings(partial)
})

// NEW: the actual differentiator -- a factual, unedited record of every
// Gate 1 / Pam result for a conversation, with an integrity hash proving
// the report wasn't altered after being generated.
typedIpc.handle('audit:export', async (_event: any, conversationId: string) => {
  try {
    const result = await generateAuditReport(conversationId)
    return { success: true, ...result }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// NEW: the plain-language sibling to audit:export -- same underlying
// records, translated into something a non-technical client can
// actually read and hand to their own stakeholders, rather than a
// developer-facing log of Gate 1 blocker strings.
typedIpc.handle('audit:exportClientSummary', async (_event: any, conversationId: string) => {
  try {
    const result = await generateClientSummary(conversationId)
    return { success: true, ...result }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// NEW: verified real facts about this project's actual client --
// entered once, injected into every generation from then on. See
// clientFactsStore.ts for the full reasoning.
// NEW: what a conversation should actually be reopened with -- see
// stagedFilesStore.ts's own note. Returns null (not an error) when
// nothing has ever successfully completed for this conversation yet.
typedIpc.handle('stagedFiles:get', async (_event: any, conversationId: string) => {
  try {
    const files = await getStagedFiles(conversationId)
    return { success: true, files }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

typedIpc.handle('clientFacts:get', async (_event: any, conversationId: string) => {
  try {
    const facts = await getClientFacts(conversationId)
    return { success: true, facts }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

typedIpc.handle('clientFacts:set', async (_event: any, { conversationId, facts }: { conversationId: string; facts: string }) => {
  try {
    await setClientFacts(conversationId, facts)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// NEW: per-chat model overrides -- see modelOverridesStore.ts's own
// note on how this layers on top of the global per-agent settings.
typedIpc.handle('modelOverrides:get', async (_event: any, conversationId: string) => {
  try {
    const overrides = await getConversationModelOverrides(conversationId)
    return { success: true, overrides }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

typedIpc.handle('modelOverrides:set', async (_event: any, { conversationId, overrides }: { conversationId: string; overrides: Record<string, string> }) => {
  try {
    await setConversationModelOverrides(conversationId, overrides)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// NEW: called from the renderer -- the only place a sandbox actually
// runs -- the moment a generation has genuinely been executed
// successfully (a web app reached server-ready, or a document script
// produced its real output file). Upgrades that specific record from
// "Pam approved" to "confirmed running." Best-effort: a missing/unknown
// id (e.g. an old conversation reopened without healing context) is not
// an error, just nothing to upgrade.
typedIpc.handle('audit:markExecuted', async (_event: any, auditId: string) => {
  try {
    if (!auditId) return { success: true, updated: false }
    const record = await markExecutionVerified(auditId)
    return { success: true, updated: !!record }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

typedIpc.handle('conversation:get', async (_event: any, id: string) => {
  return await getConversation(id)
})

typedIpc.handle('conversation:delete', async (_event: any, id: string) => {
  await deleteConversation(id)
  return { success: true }
})

typedIpc.handle('conversation:rename', async (_event: any, { id, title }: { id: string; title: string }) => {
  await renameConversation(id, title)
  return { success: true }
})

typedIpc.handle('workspace:index', async (_event: any, targetPath?: string) => {
  try {
    const dirToIndex = targetPath || path.join(__dirname, '../../')
    const { indexed, failed, pruned } = await indexWorkspace(dirToIndex)
    return { success: true, indexedFiles: indexed, failedFiles: failed, prunedFiles: pruned }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// FIXED: this channel's real shape (per the actual preload) is
// (conversationId, agentName, prompt) -- agentName was originally meant
// for direct chat with Jim/Dwight/Pam, a feature that was planned but
// never actually built. My first version of this handler only expected
// (conversationId, prompt), which would have silently misread whatever
// the renderer sent as agentName as if it were the prompt. Now it reads
// agentName correctly and branches on it.
typedIpc.handle('agent:invoke', async (_event: any, { conversationId, agentName, prompt }: { conversationId: string; agentName: 'jim' | 'dwight' | 'pam' | 'riley' | 'chat'; prompt: string }) => {
  const newMessages: any[] = []
  try {
    const userMsg = await addMessageAndBroadcast(conversationId, 'user', prompt)
    newMessages.push(userMsg)

    if (agentName === 'chat') {
      const existing = await getConversation(conversationId)
      const history = (existing?.messages || [])
        .filter((m: any) => m.role === 'user' || m.role === 'chat')
        .slice(-MICHAEL_HISTORY_WINDOW)
        .map((m: any) => ({ role: (m.role === 'chat' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }))

      const response = await fetchChatCompletion(PROMPTS.GENERAL_CHAT, history)
      const chatMsg = await addMessageAndBroadcast(conversationId, 'chat', response)
      newMessages.push(chatMsg)
      return { success: true, messages: newMessages }
    }

    // NEW: direct chat with Jim or Dwight -- the actual feature this
    // channel was originally built for, finally implemented. What's
    // genuinely being skipped here is Michael's routing decision and
    // Pam's review -- the whole point of clicking a specific character
    // is a faster, more direct conversation with them. Gate 1 is never
    // skipped for anyone, under any path -- that's a security check, not
    // routing ceremony, and stays non-negotiable regardless of how a
    // generation was reached.
    if (agentName === 'jim' || agentName === 'dwight' || agentName === 'riley') {
      const targetPrompt =
        agentName === 'dwight' ? PROMPTS.DWIGHT_BACKEND :
        agentName === 'riley' ? PROMPTS.RILEY_DOCS :
        PROMPTS.JIM_FRONTEND
      const learnedGuidance = await getLearnedGuidance(agentName)
      const settingsForCall = await getSettings()
      const modelOverride = await resolveModelOverride(agentName, settingsForCall, conversationId)
      const specialistOutput = await fetchFrontierAI(targetPrompt, prompt + learnedGuidance, modelOverride, shouldUseSearchGrounding(agentName, settingsForCall))
      const { staticAudit, stageableFiles } = auditAndStage(specialistOutput, agentName)

      if (!staticAudit.passed) {
        await recordAudit({
          conversationId, agentKey: agentName, attempt: 1,
          gate1Passed: false, perFile: staticAudit.perFile, pamVerdict: 'UNKNOWN'
        })
        const errMsg = await addMessageAndBroadcast(conversationId, 'error', `Gate 1 Hard Blockers Enforced:\n- ${staticAudit.blockers.join('\n- ')}`)
        return { success: false, messages: [...newMessages, errMsg] }
      }

      const agentMsg = await addMessageAndBroadcast(conversationId, agentName, specialistOutput, prefixStageableFiles(stageableFiles, agentName))
      newMessages.push(agentMsg)

      // Recorded honestly: Gate 1 genuinely ran and passed, Pam's
      // verdict is UNKNOWN because she was genuinely never asked, not
      // silently defaulted to an approval she never gave.
      const auditRecord = await recordAudit({
        conversationId, agentKey: agentName, attempt: 1,
        gate1Passed: true, perFile: staticAudit.perFile, pamVerdict: 'UNKNOWN'
      })

      const directChatFiles = prefixStageableFiles(stageableFiles, agentName)
      if (directChatFiles) await setStagedFiles(conversationId, directChatFiles)

      return { success: true, messages: newMessages, files: directChatFiles, agentKey: agentName, instructions: prompt, auditId: auditRecord.id }
    }

    // NEW: direct chat with Pam -- a genuinely different use case from
    // the other two. Not staged code from the pipeline; a real review
    // of whatever the user hands her directly (a pasted snippet, code
    // written by hand, anything), on demand, outside the normal
    // generate-then-review flow.
    if (agentName === 'pam') {
      const settingsForPam = await getSettings()
      const pamReview = await fetchFrontierAI(PROMPTS.PAM_AUDITOR_LOGIC, prompt, await resolveModelOverride('pam', settingsForPam, conversationId))
      const pamMsg = await addMessageAndBroadcast(conversationId, 'pam', pamReview)
      newMessages.push(pamMsg)
      return { success: true, messages: newMessages }
    }

    const errMsg = await addMessageAndBroadcast(conversationId, 'error', `Unrecognized direct chat target: ${agentName}`)
    return { success: false, messages: [...newMessages, errMsg] }
  } catch (error: any) {
    const errMsg = await addMessageAndBroadcast(conversationId, 'error', error.message || 'Chat error.')
    return { success: false, messages: [...newMessages, errMsg] }
  }
})

// NEW: extracted from what used to be inline in ai:invoke, so it can be
// called once per delegation instead of assuming there's always exactly
// one. Logic is unchanged from before -- same Gate1/Pam correction loop,
// same audit recording, same message posting. newMessages is mutated in
// place (pushed onto) so the caller sees every message from every
// delegation in the order they actually happened.
async function runSpecialistPipeline(params: {
  conversationId: string
  agentKey: 'jim' | 'dwight' | 'riley'
  baseInstructions: string
  projectContext: string
  existingProjectSnapshot: string
  newMessages: any[]
}): Promise<{ success: boolean; stageableFiles?: Record<string, string>; auditId: string | null; specialistOutput: string; errorMessage?: string }> {
  const { conversationId, agentKey, baseInstructions, projectContext, existingProjectSnapshot, newMessages } = params
  const targetPrompt =
    agentKey === 'dwight' ? PROMPTS.DWIGHT_BACKEND :
    agentKey === 'riley' ? PROMPTS.RILEY_DOCS :
    PROMPTS.JIM_FRONTEND

  // NEW: self-healing memory. Real, confirmed mistakes this agent has
  // made and already had fixed before -- local to this machine only.
  const learnedGuidance = await getLearnedGuidance(agentKey)
  const settingsForModel = await getSettings()
  const modelOverride = await resolveModelOverride(agentKey, settingsForModel, conversationId)
  let currentInstructions = baseInstructions + projectContext + existingProjectSnapshot + learnedGuidance
  let specialistOutput = ''
  let staticAudit: AuditResult
  let stageableFiles: Record<string, string> | undefined
  let latestAuditId: string | null = null

  for (let round = 1; round <= MAX_AUTO_FIX_ROUNDS; round++) {
    const roundTag = MAX_AUTO_FIX_ROUNDS > 1 ? ` (attempt ${round} of ${MAX_AUTO_FIX_ROUNDS})` : ''

    specialistOutput = await fetchFrontierAI(targetPrompt, currentInstructions, modelOverride, shouldUseSearchGrounding(agentKey, settingsForModel))
    const auditResult = auditAndStage(specialistOutput, agentKey)
    staticAudit = auditResult.staticAudit
    stageableFiles = auditResult.stageableFiles

    if (!staticAudit.passed) {
      if (round < MAX_AUTO_FIX_ROUNDS) {
        newMessages.push(await addMessageAndBroadcast(
          conversationId,
          agentKey,
          `${specialistOutput}\n\n[Gate 1 blocked this attempt${roundTag} -- retrying automatically]`
        ))
        currentInstructions = `${baseInstructions}${projectContext}${existingProjectSnapshot}\n\nYour previous attempt was rejected by the automated security check. Fix ALL of these before trying again:\n- ${staticAudit.blockers.join('\n- ')}`
        continue
      }
      await recordAudit({
        conversationId, agentKey, attempt: round,
        gate1Passed: false, perFile: staticAudit.perFile, pamVerdict: 'UNKNOWN'
      })
      const errMsg = await addMessageAndBroadcast(conversationId, 'error', `Gate 1 Hard Blockers Enforced (after ${round} attempts):\n- ${staticAudit.blockers.join('\n- ')}`)
      newMessages.push(errMsg)
      return { success: false, auditId: null, specialistOutput, errorMessage: `Gate 1 blocked ${agentKey}'s output` }
    }

    // FIXED: confirmed real bug -- the "Generated N files" card in
    // ChatInterface.tsx reads directly from THIS message's own stored
    // files (msg.files), not from the outer merge loop's mergedFiles.
    // Storing Dwight's raw, unprefixed stageableFiles here meant
    // clicking his own card loaded his files into the Staged panel
    // exactly as extracted -- no server/ prefix -- which is the same
    // misidentification bug fixed earlier for direct-chat and
    // self-heal, reachable through a third path this time. Prefixing
    // here too keeps this message's own record consistent with what
    // the real merged/staged result actually contains.
    const agentMsg = await addMessageAndBroadcast(conversationId, agentKey, specialistOutput + roundTag, prefixStageableFiles(stageableFiles, agentKey))
    newMessages.push(agentMsg)

    const warningContext = staticAudit.warnings.length > 0
      ? `\n\n[Gate 1 Heuristic Warnings to Review]:\n- ${staticAudit.warnings.join('\n- ')}`
      : ''

    const pamReview = await fetchFrontierAI(PROMPTS.PAM_AUDITOR_LOGIC, specialistOutput + warningContext, await resolveModelOverride('pam', settingsForModel, conversationId))
    const pamMsg = await addMessageAndBroadcast(conversationId, 'pam', pamReview)
    newMessages.push(pamMsg)

    const verdictMatch = pamReview.match(/PAM_VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/i)
    const approved = verdictMatch ? verdictMatch[1].toUpperCase() === 'APPROVED' : false

    const auditRecord = await recordAudit({
      conversationId, agentKey, attempt: round,
      gate1Passed: true, perFile: staticAudit.perFile,
      pamVerdict: verdictMatch ? (verdictMatch[1].toUpperCase() as 'APPROVED' | 'CHANGES_REQUESTED') : 'UNKNOWN'
    })
    latestAuditId = auditRecord.id

    if (approved || round === MAX_AUTO_FIX_ROUNDS) {
      break
    }

    currentInstructions = `${baseInstructions}${projectContext}${existingProjectSnapshot}\n\nYour previous attempt received this QA feedback -- address it before trying again:\n${pamReview}`
  }

  return { success: true, stageableFiles, auditId: latestAuditId, specialistOutput }
}

// This is now the ONE handler every message goes through -- one chatbox,
// no mode to pick. Michael sees the whole conversation and decides for
// himself whether to just answer, or bring in a specialist.
typedIpc.handle('ai:invoke', async (_event: any, { conversationId, prompt }: { conversationId: string; prompt: string }) => {
  const newMessages: any[] = []
  currentUsageConversationId = conversationId
  try {
    const userMsg = await addMessageAndBroadcast(conversationId, 'user', prompt)
    newMessages.push(userMsg)

    let projectContext = ''
    let retrievedFiles: string[] = []
    try {
      const queryVector = await generateEmbedding(prompt)
      const matches = await searchRelevantCode(queryVector, 3)
      if (matches && matches.length > 0) {
        retrievedFiles = matches.map((m: any) => `${m.filePath} (${m.score.toFixed(3)})`)
        // NEW: cap each chunk's length before sending it. Most chunks
        // from AST-based chunking are already reasonably sized, but an
        // occasional large function isn't -- and every extra character
        // here is something the model has to actually read on every
        // single delegated request, not something that compresses away.
        const truncate = (text: string) => text.length > MAX_CONTEXT_CHUNK_CHARS
          ? text.slice(0, MAX_CONTEXT_CHUNK_CHARS) + '\n... (truncated)'
          : text
        projectContext = `\n\n[RELEVANT PROJECT CONTEXT FROM MEMORY]:\n` +
          matches.map((m: any) => `--- ${m.filePath} (Similarity: ${m.score.toFixed(3)}) ---\n${truncate(m.content)}`).join('\n\n')
      }
    } catch {
      // Proceed without context if retrieval fails.
    }

    // NEW: Michael now sees the whole conversation, not just the latest
    // message -- otherwise casual back-and-forth ("forget the commute
    // one, just compare the other two") wouldn't work here the way it did
    // in the old separate chat mode, since he'd have no memory of what
    // came before. Capped to the most recent turns rather than sending
    // the entire history every time -- a long-running conversation would
    // otherwise mean every single new message resends every message that
    // ever preceded it, growing forever and making even a quick "delegate
    // to Jim" decision slower every time.
    const existing = await getConversation(conversationId)
    const michaelHistory = (existing?.messages || [])
      .filter((m: any) => m.role === 'user' || m.role === 'michael')
      .slice(-MICHAEL_HISTORY_WINDOW)
      .map((m: any) => ({ role: (m.role === 'michael' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }))

    // NEW: pipeline self-healing for routing specifically. Previously a
    // single malformed JSON response killed the whole request instantly
    // -- no retry at all. This matters more now that a local model can
    // be in the loop (see selectModelProvider): weaker/self-hosted
    // models are known to be less reliable at strict JSON output than
    // Gemini, so this failure just got more likely to actually happen,
    // not less.
    const MAX_ROUTING_JSON_RETRIES = 2
    let decision: { action: 'delegate' | 'respond'; assignTo?: string; instructions?: string; assignments?: { assignTo: string; instructions: string }[]; response?: string } | null = null
    let managerResponse = ''

    for (let jsonAttempt = 1; jsonAttempt <= MAX_ROUTING_JSON_RETRIES; jsonAttempt++) {
      const historyForAttempt = jsonAttempt === 1
        ? michaelHistory
        : [
            ...michaelHistory,
            { role: 'assistant' as const, content: managerResponse },
            { role: 'user' as const, content: 'That was not valid JSON. Respond with ONLY the JSON object -- no explanation, no markdown formatting, nothing else.' }
          ]

      const settingsForMichael = await getSettings()
      managerResponse = await fetchChatCompletion(PROMPTS.MICHAEL_MANAGER, historyForAttempt, await resolveModelOverride('michael', settingsForMichael, conversationId))

      try {
        // FIXED: if the model wraps its JSON in a markdown code fence
        // (```json ... ```) with any prose before or after it, the old
        // greedy match-from-first-{-to-last-} could swallow fence
        // markers or extra text along with the real JSON. Stripping
        // fences first is cheap and removes that whole class of failure.
        const withoutFences = managerResponse.replace(/```(?:json)?/gi, '')
        const jsonMatch = withoutFences.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error("No JSON structure found")
        decision = JSON.parse(jsonMatch[0])
        break
      } catch {
        if (jsonAttempt === MAX_ROUTING_JSON_RETRIES) {
          const errMessage = await addMessageAndBroadcast(conversationId, 'error', `Manager routing failed after ${MAX_ROUTING_JSON_RETRIES} attempts: malformed JSON response.`)
          return { success: false, messages: [...newMessages, errMessage] }
        }
        // fall through to the next attempt
      }
    }

    if (!decision) {
      const errMessage = await addMessageAndBroadcast(conversationId, 'error', "Manager routing failed: no valid decision produced.")
      return { success: false, messages: [...newMessages, errMessage] }
    }

    // NEW: Michael can just answer directly -- no specialist, no Gate 1,
    // no Pam. This is the whole reason one chatbox can now do both
    // casual conversation and real build requests without switching.
    if (decision.action === 'respond') {
      const michaelMsg = await addMessageAndBroadcast(conversationId, 'michael', decision.response || '(no response)')
      newMessages.push(michaelMsg)
      return { success: true, messages: newMessages }
    }

    // NEW: normalize into a list regardless of which shape Michael used --
    // the old single assignTo/instructions still works exactly as before,
    // the new assignments array handles the "needs both" case. This is
    // what actually fixes "I always have to give Michael a second
    // command": both specialists now run automatically in the same turn
    // when a request genuinely needs both, instead of only ever picking one.
    const rawDelegations: { assignTo: string; instructions: string }[] =
      decision.assignments && decision.assignments.length > 0
        ? decision.assignments
        : decision.assignTo && decision.instructions
          ? [{ assignTo: decision.assignTo, instructions: decision.instructions }]
          : []

    if (rawDelegations.length === 0) {
      const errMessage = await addMessageAndBroadcast(conversationId, 'error', "Manager routing failed: delegate action had no assignment.")
      return { success: false, messages: [...newMessages, errMessage] }
    }

    // NEW: vertical starter-kit detection -- see verticals.ts for the
    // full reasoning. A no-op for the common case of no match; matched
    // requests get proven, known-good scaffold guidance injected below,
    // and the match is surfaced here for transparency, the same way RAG
    // retrieval results always are, rather than silently steering the
    // request without saying so.
    const detectedVertical = detectVerticalStarterKit(prompt)

    // NEW: research-before-building. Moved the settings fetch earlier
    // (was further down, right before existingProjectSnapshot) so this
    // can decide -- and announce -- whether research actually ran, in
    // the same message as everything else this turn's context already
    // gets announced in. Only attempted when a real code build is
    // actually happening (Jim or Dwight delegated to) -- a Riley-only
    // or pure-chat turn has no use for this and shouldn't pay for a
    // search call it can't use.
    const settingsForSnapshot = await getSettings()
    const involvesRealBuild = rawDelegations.some(d => d.assignTo === 'Jim' || d.assignTo === 'Dwight')
    let researchFindings = ''
    if (settingsForSnapshot.enableWebSearch && involvesRealBuild) {
      try {
        researchFindings = await fetchFrontierAI(PROMPTS.RESEARCH_BEFORE_BUILD, prompt, undefined, true)
      } catch {
        // Best-effort -- a failed research call shouldn't block the
        // actual build; specialists just proceed without it, the same
        // as when the setting is off entirely.
      }
    }
    const researchNote = researchFindings.trim()
      ? `\n\n[RESEARCH -- real findings gathered via live web search before this build, prioritizing any specific named business/organization in the request. These are genuine search results, not invented -- use them, especially real business specifics like hours, services, and contact details. They are NOT the same tier of certainty as VERIFIED CLIENT FACTS below (if present): those were confirmed directly by the actual client; these were found by automated search and could be outdated or about the wrong entity if the name is ambiguous. If the two ever conflict, VERIFIED CLIENT FACTS wins.]\n${researchFindings.trim()}`
      : ''

    const ragNote = retrievedFiles.length > 0
      ? `\n\n[RAG] Retrieved context from: ${retrievedFiles.join(', ')}`
      : `\n\n[RAG] No relevant project context retrieved.`
    const verticalAnnounceNote = detectedVertical
      ? `\n\n[Using a proven "${detectedVertical.name}" starting structure -- a known-good data model from repeat past requests, tailored to what was specifically asked for here.]`
      : ''
    const researchAnnounceNote = researchFindings.trim()
      ? `\n\n[Real research was gathered before this build -- see the specialists' own context for what was found.]`
      : ''
    const michaelMsg = await addMessageAndBroadcast(
      conversationId,
      'michael',
      rawDelegations.length > 1
        ? `Delegating to ${rawDelegations.map(d => d.assignTo).join(' and ')} -- this needs both a real backend and a real frontend, so both are being built together.${ragNote}${verticalAnnounceNote}${researchAnnounceNote}`
        : `Delegating to ${rawDelegations[0].assignTo}: ${rawDelegations[0].instructions}${ragNote}${verticalAnnounceNote}${researchAnnounceNote}`
    )
    newMessages.push(michaelMsg)

    // Dwight first when both are present -- so his actual real endpoints
    // exist before Jim writes anything, and can be described to him
    // instead of Jim falling back to inventing mock data with nothing
    // real to call.
    const orderedDelegations = [...rawDelegations].sort((a, b) => {
      const rank = (name: string) => name === 'Dwight' ? 0 : name === 'Riley' ? 1 : 2
      return rank(a.assignTo) - rank(b.assignTo)
    })

    // NEW: fetched once per turn, same value for every delegation this
    // turn -- unlike existingProjectSnapshot (which varies by what the
    // live filesystem actually contains) this is deliberately identical
    // context handed to every specialist, since the whole point is a
    // single, consistent source of truth about the real client that
    // none of them should ever contradict or invent around.
    const rawClientFacts = await getClientFacts(conversationId)
    const clientFactsNote = rawClientFacts.trim()
      ? `\n\n[VERIFIED CLIENT FACTS -- treat everything below as ground truth about the real business this is being built for. Use these exact details wherever relevant -- do not paraphrase away specifics like exact prices, hours, or policy wording. For any business-specific detail NOT covered here (a price, address, phone number, policy, or similar), do not invent a plausible-sounding specific value -- use an obviously-a-placeholder label instead (e.g. "[Add your price here]", "Contact us for details") so it's visibly unfinished rather than presented as if it were real. This does not apply to generic structural/demo content, like example task titles in a task manager -- only to specifics a real client would actually check against reality.]\n${rawClientFacts}`
      : ''
    // NEW: global, not per-conversation -- who's actually running
    // Branch HQ, not who any one project is for. See settingsStore.ts's
    // own note on this field. Injected into every specialist alongside
    // (never instead of) VERIFIED CLIENT FACTS -- a real conflict
    // between "who I am" and "who this specific project is for" should
    // resolve in favor of the project's own client facts, since those
    // are what the delivered app actually needs to reflect.
    const rawMasterProfile = (settingsForSnapshot.masterProfile || '').trim()
    const masterProfileNote = rawMasterProfile
      ? `\n\n[ABOUT THE PERSON/AGENCY BUILDING THIS -- standing context about who is using Branch HQ, true across every project, not specific to this one. Useful for tone, standard conventions, or defaults this person/agency prefers -- if this conflicts with VERIFIED CLIENT FACTS for this specific project, VERIFIED CLIENT FACTS wins.]\n${rawMasterProfile}`
      : ''
    const mergedFiles: Record<string, string> = {}
    // NEW: tracks which agents' pipelines genuinely succeeded this turn,
    // as opposed to orderedDelegations, which only reflects what Michael
    // DECIDED to route to. Confirmed real failure: a run where Dwight's
    // output was hard-blocked by Gate 1 after all retry rounds still
    // triggered the "Both are done -- backend is included under server/"
    // message below (unchanged until this fix), since that check only
    // ever looked at intent, never outcome -- the message claimed a
    // backend existed while mergedFiles and the actual staged file
    // count both silently reflected a frontend-only result. This set
    // is the source of truth for what actually landed in mergedFiles.
    const succeededAgents = new Set<'jim' | 'dwight' | 'riley'>()
    let dwightRawOutput: string | null = null
    // Tracks the frontend (Jim) delegation's own results specifically --
    // self-healing targets whichever agent's code is actually running
    // live in the sandbox, which is always the frontend when both exist.
    let healTargetAgentKey: 'jim' | 'dwight' | 'riley' | null = null
    let healTargetInstructions = ''
    let healTargetAuditId: string | null = null

    for (const delegation of orderedDelegations) {
      const agentKey: 'jim' | 'dwight' | 'riley' =
        delegation.assignTo === 'Dwight' ? 'dwight' :
        delegation.assignTo === 'Riley' ? 'riley' :
        'jim'

      // FIXED: confirmed real gap -- the previous try/catch only wrapped
      // the runSpecialistPipeline call and its result-handling, NOT this
      // delegation's own setup code above it (existingProjectSnapshot,
      // crossAgentNote, verticalNote). A real failure ruled out
      // existingProjectSnapshot specifically as the likely cause (Dwight
      // runs the identical call and always succeeds), but there's no
      // reason to leave ANY part of one delegation's processing outside
      // this protection when the whole point is that nothing here should
      // ever be able to silently take out the rest of the turn. Wrapping
      // from the top closes every remaining gap at once, and the
      // TRACE line below means the very next occurrence will show
      // exactly how far this delegation got before whatever happens,
      // happens -- turning "still a mystery" into a specific line number
      // to look at, on the first try.
      try {
        // FIXED: this used to run for every agent, including Riley. Riley
        // produces a standalone document script -- there's no legitimate
        // reason for him to see React/Express source from some other,
        // unrelated project sitting in the target folder. Confirmed real
        // failure pattern: after several code projects had been built, a PPT
        // prompt sharing a word with an old project's filename (e.g. "hero
        // section" matching a leftover Hero.tsx) fed that file's actual
        // source code into Riley's instructions, producing broken output.
        // Only Jim and Dwight legitimately need to see what already exists.
        const existingProjectSnapshot = agentKey === 'riley'
          ? ''
          : await getExistingProjectSnapshot(settingsForSnapshot.defaultTargetDir, prompt)

        // NEW: when Jim is running alongside a just-built Dwight backend in
        // this same turn, tell him plainly what real endpoints now exist --
        // otherwise he has no way to know a real backend exists at all, and
        // (reasonably) falls back to mock/hardcoded data in React state,
        // which is real code but not what "build this with a working
        // backend" actually asked for.
        // FIXED: confirmed real, unbounded risk -- this used to inject
        // Dwight's ENTIRE raw output verbatim, no limit at all. For a real
        // multi-file backend (routes, middleware, schemas, server setup)
        // that's easily 10,000+ characters, stacked on top of Jim's own
        // already-large prompt (his extensive design guidance) plus every
        // other context note (client facts, vertical guidance, research,
        // master profile) -- a genuine, real way for the combined request
        // to grow large enough to risk a hard failure on Jim's call
        // specifically.
        const DWIGHT_CONTEXT_CHAR_LIMIT = 6000
        const dwightContextForJim = dwightRawOutput && dwightRawOutput.length > DWIGHT_CONTEXT_CHAR_LIMIT
          ? dwightRawOutput.slice(0, DWIGHT_CONTEXT_CHAR_LIMIT) + '\n\n[...truncated -- the real backend has more routes/files than shown here; call whatever endpoint shape the request logically needs at the base URL below, following the same patterns shown above]'
          : dwightRawOutput
        const crossAgentNote = (agentKey === 'jim' && dwightContextForJim)
          ? `\n\n[A real backend was just built for this same request, and will run at http://localhost:${NATIVE_BACKEND_PORT} -- call its actual endpoints via fetch() using that exact base URL, do not invent mock or hardcoded data. Here is what Dwight wrote:]\n${dwightContextForJim}`
          : ''

        // NEW: vertical starter-kit guidance -- see verticals.ts. Only for
        // Jim/Dwight (the data-model/structure-bearing specialists); Riley
        // produces standalone documents, which this category of guidance
        // doesn't apply to.
        const verticalNote = (detectedVertical && (agentKey === 'jim' || agentKey === 'dwight'))
          ? `\n\n${detectedVertical.guidance}`
          : ''

        const result = await runSpecialistPipeline({
          conversationId,
          agentKey,
          baseInstructions: delegation.instructions + crossAgentNote + verticalNote + clientFactsNote + masterProfileNote + (agentKey !== 'riley' ? researchNote : ''),
          projectContext,
          existingProjectSnapshot,
          newMessages
        })

        if (!result.success) {
          // One delegation failing (e.g. Gate 1 blocked it after every
          // retry) doesn't silently discard the other -- report the
          // failure but let any earlier-completed delegation's files still
          // reach the user rather than losing real, passed work.
          continue
        }

        // FIXED: previously added unconditionally whenever result.success
        // was true. Confirmed real gap: runSpecialistPipeline can return
        // success: true with stageableFiles undefined -- e.g. when
        // extraction yields zero files (see auditAndStage's own fix for
        // the underlying cause) in a way Gate 1 didn't itself block.
        // succeededAgents is what the completion message below trusts to
        // mean "this agent's code is genuinely staged" -- gating it on
        // stageableFiles directly, the same condition the merge below
        // already requires, closes that gap instead of trusting
        // result.success alone.
        if (result.stageableFiles) {
          succeededAgents.add(agentKey)
        }

        if (agentKey === 'dwight') {
          dwightRawOutput = result.specialistOutput
        }

        if (result.stageableFiles) {
          // Jim's files stay at the root -- that's what Vite serves
          // directly in native mode. Dwight's (and Riley's) get
          // namespaced under their own folder so they never collide with
          // Jim's, AND so sandbox:startNative's own hasBackend check
          // (files.some(f => f.startsWith('server/'))) can tell a real
          // backend is present and needs its own spawn alongside the
          // frontend -- both genuinely run together in native mode, not
          // just written to disk for someone to run manually later.
          const prefix = agentKey === 'jim' ? '' : `${agentKey === 'dwight' ? 'server' : 'docs'}/`
          for (const [path, content] of Object.entries(result.stageableFiles)) {
            mergedFiles[`${prefix}${path}`] = content
          }
        }

        if (agentKey === 'jim' || (!healTargetAgentKey)) {
          healTargetAgentKey = agentKey
          healTargetInstructions = delegation.instructions
          healTargetAuditId = result.auditId
        }
      } catch (delegationError: any) {
        newMessages.push(await addMessageAndBroadcast(
          conversationId,
          'error',
          `${delegation.assignTo}'s part of this build failed unexpectedly: ${delegationError.message || 'unknown error'}. Any other agent's work that already completed is still staged below.`
        ))
        continue
      }
    }

    if (Object.keys(mergedFiles).length === 0) {
      const errMsg = await addMessageAndBroadcast(conversationId, 'error', 'All delegated work failed Gate 1 -- nothing to stage.')
      return { success: false, messages: [...newMessages, errMsg] }
    }

    // FIXED: confirmed real bug -- this used to check orderedDelegations
    // (what Michael decided to route to) instead of succeededAgents
    // (what actually made it through Gate 1/Pam and into mergedFiles).
    // When Dwight's pipeline failed -- e.g. hard-blocked by Gate 1 after
    // every retry round -- the loop above just does `continue` and moves
    // on, with no flag telling this block that happened. The old check
    // fired anyway, telling the user "the backend is included under
    // server/" when zero backend files had actually been staged, while
    // the file count and the live sandbox preview both correctly showed
    // a frontend-only result. Now this reflects reality either way.
    const bothWereAttempted = orderedDelegations.some(d => d.assignTo === 'Dwight') && orderedDelegations.some(d => d.assignTo === 'Jim')

    if (bothWereAttempted && succeededAgents.has('dwight') && succeededAgents.has('jim')) {
      // NEW: when a backend was built alongside the frontend, say plainly
      // FIXED: confirmed real, stale text -- this message and comment
      // predated the native execution engine entirely and were never
      // updated once it landed. Native mode genuinely spawns both
      // frontend and backend together as real Node processes (see
      // sandbox:startNative) -- this was telling people to manually run
      // a backend that the app is actually capable of running for them
      // automatically, which is actively misleading, not just outdated.
      newMessages.push(await addMessageAndBroadcast(
        conversationId,
        'michael',
        `Both are done -- the backend is included under server/ in the same push. In Native mode, both should already be running together automatically (check the Container Output log below the preview -- you should see both [frontend] and [backend] activity). If the backend shows as offline in the preview, check that log for what actually happened; it's real, reviewed code either way, and cd server && npm run dev always works as a manual fallback if native mode isn't available.`
      ))
    } else if (bothWereAttempted) {
      // NEW: the honest partial-failure case -- one of the two didn't
      // make it through review. Says which one plainly instead of
      // letting the generic file-count footer imply everything asked
      // for is actually staged.
      const missing = succeededAgents.has('dwight') ? 'frontend' : 'backend'
      const staged = succeededAgents.has('jim') ? 'frontend' : 'backend'
      newMessages.push(await addMessageAndBroadcast(
        conversationId,
        'michael',
        `Only the ${staged} made it through review this time -- the ${missing} failed Gate 1 and isn't included in what's staged (see the error above). Ask me to retry it whenever you want another attempt.`
      ))
    }

    // FIXED: confirmed real bug -- this is the one place that should
    // ever be treated as "the finished result" for this conversation.
    // See stagedFilesStore.ts's own note: without this, reselecting a
    // conversation mid-generation (or on app reload) had no reliable
    // record to load from and would guess using an individual agent's
    // own, possibly-still-in-progress message instead.
    await setStagedFiles(conversationId, mergedFiles)

    return {
      success: true,
      messages: newMessages,
      files: mergedFiles,
      agentKey: healTargetAgentKey || 'jim',
      instructions: healTargetInstructions,
      auditId: healTargetAuditId
    }
  } catch (error: any) {
    const errMsg = await addMessageAndBroadcast(conversationId, 'error', error.message || 'Fatal pipeline error.')
    return { success: false, messages: [...newMessages, errMsg] }
  }
})

// NEW: self-healing. Called from the renderer AFTER code has already
// passed Gate 1 and Pam and been staged, but then actually failed when
// run in the sandbox -- a category of failure neither of those checks
// can see, since neither of them executes anything.
typedIpc.handle('heal:invoke', async (_event: any, {
  conversationId, agentKey, previousInstructions, errorLog, attempt
}: {
  conversationId: string
  agentKey: 'jim' | 'dwight' | 'riley'
  previousInstructions: string
  errorLog: string
  attempt: number
}) => {
  const newMessages: any[] = []
  try {
    if (attempt > MAX_SELF_HEAL_ROUNDS) {
      const errMsg = await addMessageAndBroadcast(
        conversationId,
        'error',
        `Self-healing gave up after ${MAX_SELF_HEAL_ROUNDS} attempts -- the code still doesn't run. This needs a manual look.`
      )
      return { success: false, messages: [errMsg] }
    }

    const targetPrompt =
      agentKey === 'dwight' ? PROMPTS.DWIGHT_BACKEND :
      agentKey === 'riley' ? PROMPTS.RILEY_DOCS :
      PROMPTS.JIM_FRONTEND

    // NEW: the error only points at where execution STOPPED, which can
    // be the first of several identical mistakes, not the only one --
    // confirmed by watching a real case where the same bug moved to a
    // different line between healing attempts instead of disappearing
    // in one try, because only the one instance the error named got
    // fixed each time.
    const healingInstructions = `${previousInstructions}\n\nYour previous code passed review, but FAILED WHEN ACTUALLY RUN. Here is the real error:\n\n${errorLog}\n\nFix the specific problem causing this error. If this exact kind of mistake appears more than once in your code, fix EVERY occurrence, not just the one the error happened to stop at -- the error only shows where execution failed first, which may not be the only instance. If the error says a named export doesn't exist in a library (e.g. an icon name from lucide-react that isn't real), don't guess at another specific, similarly-plausible name -- replace it with a simple, extremely well-established name from that same library that you are highly confident actually exists, since a specific-sounding guess is exactly how this kind of error happens in the first place. Do not change anything else.`

    const settingsForHeal = await getSettings()
    const specialistOutput = await fetchFrontierAI(targetPrompt, healingInstructions, await resolveModelOverride(agentKey, settingsForHeal, conversationId), shouldUseSearchGrounding(agentKey, settingsForHeal))
    const { staticAudit, stageableFiles } = auditAndStage(specialistOutput, agentKey)

    // A self-heal fix still has to clear Gate 1 like anything else -- a
    // repair is not a shortcut around the same safety check everything
    // else goes through.
    if (!staticAudit.passed) {
      const errMsg = await addMessageAndBroadcast(
        conversationId,
        'error',
        `Self-healing attempt ${attempt} was rejected by Gate 1:\n- ${staticAudit.blockers.join('\n- ')}`
      )
      return { success: false, messages: [errMsg] }
    }

    const agentMsg = await addMessageAndBroadcast(
      conversationId,
      agentKey,
      `${specialistOutput}\n\n[Self-healing attempt ${attempt} of ${MAX_SELF_HEAL_ROUNDS} -- fixing a real runtime failure]`,
      prefixStageableFiles(stageableFiles, agentKey)
    )
    newMessages.push(agentMsg)

    // Re-run Pam too -- a runtime fix deserves the same review any other
    // change would get, not a pass just because it's a repair.
    const pamReview = await fetchFrontierAI(PROMPTS.PAM_AUDITOR_LOGIC, specialistOutput, await resolveModelOverride('pam', settingsForHeal, conversationId))
    const pamMsg = await addMessageAndBroadcast(conversationId, 'pam', pamReview)
    newMessages.push(pamMsg)

    // NEW: previously self-healing produced no audit record at all --
    // any conversation where it fired had a genuinely incomplete audit
    // trail, since the corrected version that actually got staged was
    // never recorded anywhere. Recorded the same way the main pipeline
    // does, so this generation can also be upgraded to execution-verified
    // once the renderer confirms it actually runs.
    const verdictMatch = pamReview.match(/PAM_VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/i)
    const auditRecord = await recordAudit({
      conversationId, agentKey, attempt,
      gate1Passed: true, perFile: staticAudit.perFile,
      pamVerdict: verdictMatch ? (verdictMatch[1].toUpperCase() as 'APPROVED' | 'CHANGES_REQUESTED') : 'UNKNOWN'
    })

    // NEW: self-healing memory. Recorded at the same Gate1+Pam bar the
    // rest of the system already treats as real success, not a stricter
    // one invented just for this -- the fix genuinely cleared the same
    // checks any other generation has to. Local-only, see lessonsStore.ts.
    await recordLesson(agentKey, errorLog)

    const healedFiles = prefixStageableFiles(stageableFiles, agentKey)
    if (healedFiles) await setStagedFiles(conversationId, healedFiles)

    return { success: true, messages: newMessages, files: healedFiles, agentKey, instructions: previousInstructions, auditId: auditRecord.id }
  } catch (error: any) {
    const errMsg = await addMessageAndBroadcast(conversationId, 'error', error.message || 'Self-healing failed.')
    return { success: false, messages: [errMsg] }
  }
})

// NEW: dry-run check. Reports which files already exist at the target
// path WITHOUT writing anything, so the UI can warn before overwriting
// rather than silently replacing someone's real work.
typedIpc.handle('fs:checkConflicts', async (_event: any, { targetDirectory, files }: { targetDirectory: string; files: Record<string, string> }) => {
  try {
    const resolvedTarget = path.resolve(targetDirectory)
    const conflicts: string[] = []

    for (const relativePath of Object.keys(files)) {
      const absolutePath = path.resolve(resolvedTarget, relativePath)
      const isInsideTarget =
        absolutePath === resolvedTarget || absolutePath.startsWith(resolvedTarget + path.sep)
      if (!isInsideTarget) continue

      try {
        await fs.access(absolutePath)
        conflicts.push(relativePath)
      } catch {
        // Doesn't exist -- not a conflict, nothing to warn about.
      }
    }

    return { success: true, conflicts }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// ============================================================================
// NATIVE EXECUTION ENGINE (foundation only -- not yet wired to the
// renderer's SandboxPreview, which still runs entirely on WebContainers
// today. This is the main-process half: detecting a real runtime, writing
// real files to a real scratch directory, and spawning/coordinating real
// child processes for frontend + backend together. The renderer-side
// wiring -- deciding when to use this instead of WebContainers, and
// falling back cleanly when it isn't available -- is the next piece, kept
// separate on purpose rather than rushed in alongside this.
//
// HONESTY NOTE, worth reading before trusting this blindly: this is
// fundamentally different from most of what's been built this session.
// Adding a dependency or a prompt section can be traced by hand with real
// confidence. Spawning real OS processes and coordinating two of them
// over real ports cannot be verified the same way without actually
// running it on a real machine. Treat this as a solid, carefully-reasoned
// first version -- not something to trust untested.
// ============================================================================

// NEW: checks for a real Node/npm on PATH. If this comes back false, the
// native engine simply isn't usable and the renderer should stay on
// WebContainers -- no partial/broken native attempt.
function detectNativeRuntime(): Promise<{ available: boolean; nodeVersion?: string; npmVersion?: string }> {
  return new Promise((resolve) => {
    execFile('node', ['--version'], (nodeErr: Error | null, nodeOut: string) => {
      if (nodeErr) return resolve({ available: false })
      execFile('npm', ['--version'], (npmErr: Error | null, npmOut: string) => {
        if (npmErr) return resolve({ available: false })
        resolve({ available: true, nodeVersion: nodeOut.trim(), npmVersion: npmOut.trim() })
      })
    })
  })
}

typedIpc.handle('runtime:detect', async () => {
  return await detectNativeRuntime()
})

// FIXED: the COOP/COEP conflict this variable existed to route around is
// now solved architecturally instead of by guessing at request-level
// exemptions -- see sandboxSession below. willUseWebContainerFallback
// and activeNativePorts (which existed only to feed two increasingly
// convoluted attempts at scoping header-forcing on session.defaultSession)
// are removed entirely: session.defaultSession (native mode's actual
// home) no longer has ANY isolation-header logic attached to it, so
// there's nothing left for either of them to inform.

// NEW: dedicated, non-persistent session partition for anything
// WebContainer-dependent -- Riley's document generation always uses
// this path; Jim/Dwight's web-app preview uses it only when native mode
// isn't available. Deliberately NOT prefixed with 'persist:': this
// session is wiped when the app quits rather than written to disk,
// since it runs arbitrary AI-generated project code that could set its
// own localStorage/cookies, and nothing generated in one run should be
// able to leak into another. This is the actual fix for the COOP/COEP
// tension documented above: native mode's iframe lives entirely in
// session.defaultSession, which never gets isolation headers forced on
// it; WebContainer content lives entirely in this separate partition,
// which gets them forced on it unconditionally. Two sessions, two
// policies -- no per-request exemption logic left to get wrong.
//
// FIXED: confirmed real, currently-occurring crash -- session.fromPartition()
// (and any other session.* call) can only be called after Electron's app
// module fires 'ready'. This used to run at module scope, meaning it
// executed the instant this file was loaded -- BEFORE app.whenReady() --
// throwing "Session can only be received when app is ready" and crashing
// the whole app on launch, every time. The partition NAME (a plain
// string, no Electron API involved) stays at module scope since the
// sandbox-webview:get-config handler below needs it; the actual
// session.fromPartition() call and its header handler are now wrapped in
// this function, which app.whenReady().then(...) calls before
// createWindow() -- see the bottom of this file.
const SANDBOX_WEBVIEW_PARTITION = 'webcontainer-sandbox'

function setupSandboxSession() {
  const sandboxSession = session.fromPartition(SANDBOX_WEBVIEW_PARTITION)

  // FIXED: this exact header-forcing logic used to live on
  // session.defaultSession, gated behind willUseWebContainerFallback /
  // isTopLevelPage / activeNativePorts checks -- three reasoned attempts
  // at making ONE session serve native mode's "no isolation" requirement
  // and WebContainer's "isolation required" requirement at the same time.
  // Each attempt (port exemption, then resourceType scoping, then raw
  // header logging to find what was still slipping through) still left a
  // real ERR_BLOCKED_BY_RESPONSE possible on native mode's frontend,
  // because the problem was architectural, not a targeting bug in the
  // exemption logic. This session now ONLY ever hosts WebContainer
  // content, so these headers apply to every response in it,
  // unconditionally, with no exemptions left to get wrong.
  sandboxSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    delete responseHeaders['Content-Security-Policy']
    delete responseHeaders['content-security-policy']
    responseHeaders['Cross-Origin-Embedder-Policy'] = ['credentialless']
    responseHeaders['Cross-Origin-Opener-Policy'] = ['same-origin']
    responseHeaders['Content-Security-Policy'] = [
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src * data: blob:; worker-src * data: blob:;"
    ]
    callback({ responseHeaders })
  })
}

// NEW: the renderer needs three real, resolved values to actually mount
// the sandbox <webview> -- its preload script's absolute path, the HTML
// page it should load (dev server URL vs. packaged file:// path -- the
// same branching createWindow already does for the main window, kept in
// one place here rather than duplicated in the renderer), and the
// partition name so the webview tag and this session stay the same one.
typedIpc.handle('sandbox-webview:get-config', async () => {
  const preloadPath = pathToFileURL(path.join(__dirname, '../preload/sandboxWebview.js')).toString()
  const src = process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}/sandbox-webview.html`
    : pathToFileURL(path.join(__dirname, '../renderer/sandbox-webview.html')).toString()
  return { preloadPath, src, partition: SANDBOX_WEBVIEW_PARTITION }
})

// Tracks every process spawned for a given run, so it can be torn down
// cleanly -- switching conversations, a fresh generation replacing an old
// one, or the app quitting should never leave orphaned servers running.
interface NativeRun {
  scratchDir: string
  frontend?: ChildProcess
  backend?: ChildProcess
  frontendPort?: number
}
const activeNativeRuns = new Map<string, NativeRun>()

// FIXED: confirmed real, currently-occurring crash -- EADDRINUSE on
// NATIVE_BACKEND_PORT when a new generation's backend tries to start
// while a PREVIOUS generation's backend is still alive and bound to
// that same fixed port. activeNativeRuns tracks processes keyed by a
// randomized runId that's different on every single boot, so
// stopNativeRun(newRunId) at the start of a new run can never actually
// find and kill a previous run's backend -- it's tracked under a
// different key entirely. Relying on React effect cleanup timing on
// the renderer side to always sequence teardown-before-boot perfectly
// is fragile (any race leaves an orphaned process holding the port).
// Since NATIVE_BACKEND_PORT is a single fixed port shared by every run
// (the frontend's generated code always calls it directly), there can
// only ever be ONE legitimate backend process bound to it at a time,
// system-wide -- tracked here separately, keyed to the port itself
// rather than any one run's id, and always killed first before a new
// backend spawns, regardless of which run it originally belonged to.
let currentBackendProcess: ChildProcess | null = null

const execFileAsync = promisify(execFile)

// FIXED: confirmed real, currently-occurring gap in the fix above --
// currentBackendProcess only ever knows about processes THIS running
// app session spawned itself. Confirmed real failure: EADDRINUSE on
// the very FIRST native boot of a session, before this session had
// ever spawned a backend of its own -- meaning nothing tracked here
// could have been the culprit. The actual cause: a backend process
// orphaned by an EARLIER app launch that crashed, was force-quit, or
// was killed by the OS before its own cleanup (stopNativeRun) could
// run, left alive and still bound to the fixed port. This function
// closes that gap directly: ask the OS itself what's on the port,
// regardless of which process (or which app session) put it there,
// and kill it. macOS/Linux via lsof (both ship it by default, unlike
// e.g. the platform SDK 'mdns' package needed); Windows via
// netstat + taskkill, since lsof isn't a Windows tool. Deliberately
// defensive throughout -- this must never crash the app if the
// platform command is missing or behaves unexpectedly. lsof/netstat
// finding nothing (the common, expected case when nothing needs
// clearing) also exits non-zero / throws -- caught and treated as
// "nothing to do," not a real error.
async function killWhateverIsOnPort(port: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano'])
      const pids = new Set<string>()
      for (const line of stdout.split('\n')) {
        if (line.includes(`:${port}`) && line.toUpperCase().includes('LISTENING')) {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && /^\d+$/.test(pid)) pids.add(pid)
        }
      }
      for (const pid of pids) {
        await execFileAsync('taskkill', ['/PID', pid, '/F']).catch(() => {})
      }
      if (pids.size > 0) await new Promise(resolve => setTimeout(resolve, 300))
    } else {
      const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`])
      const pids = stdout.split('\n').map(s => s.trim()).filter(Boolean)
      for (const pid of pids) {
        try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone, or not ours to kill -- either way, nothing more to do */ }
      }
      if (pids.length > 0) await new Promise(resolve => setTimeout(resolve, 300))
    }
  } catch {
    // lsof/netstat not found, or genuinely found nothing listening
    // (lsof's real, documented behavior: exits non-zero when there's
    // no match, which is the common case, not an error) -- either way,
    // silently proceed. The existing EADDRINUSE detection in the spawn
    // logic below still catches and reports it if this genuinely
    // couldn't clear the port for some reason.
  }
}

async function writeFilesToScratch(scratchDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(scratchDir, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf-8')
  }
}

// Genuinely probes the port with a real TCP connection, retried on an
// interval, rather than trusting Express's own log wording -- which
// varies across generations and can't be relied on the way Vite's
// standard "Local: http://..." banner can. This is the same underlying
// principle as execution verification elsewhere in this file: a
// successful connection is real proof, not an inferred signal.
function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' }, () => {
        socket.end()
        resolve(true)
      })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() > deadline) return resolve(false)
        setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

// NEW: confirmed real cause of a genuine failure (npm/cli#9783) -- a
// persistent user-level `allow-scripts` npm config (set earlier for an
// unrelated global install) gets forwarded into every later npm install
// as an environment variable, and a plain project-scoped install
// explicitly rejects that same setting, failing with EALLOWSCRIPTS. Not
// something Branch HQ's own installs should be fragile to just because
// of an unrelated global setting on the host machine -- this strips
// specifically that one inherited value for installs this file spawns,
// without touching the user's actual npm configuration or any other
// legitimately-inherited settings (registry mirrors, auth tokens, etc).
function cleanInstallEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.npm_config_allow_scripts
  return env
}

// NEW: the actual coordination. Writes real files to a real scratch
// directory, then spawns npm install + npm run dev for the frontend
// (root) and, if a server/ subfolder is present in the merged files,
// separately for the backend -- with a fixed, known PORT env var so both
// the process and Jim's generated fetch() calls agree on where it lives.
// Every log line and every readiness signal streams back to the renderer
// via webContents.send, rather than being collected and returned only at
// the end -- the caller needs to see output as it happens, the same way
// the WebContainer path already does.
async function stopNativeRun(runId: string): Promise<void> {
  const run = activeNativeRuns.get(runId)
  if (!run) return
  try { run.frontend?.kill() } catch { /* already gone */ }
  try { run.backend?.kill() } catch { /* already gone */ }
  // Reference-checked -- only clear the shared tracker if it's genuinely
  // THIS run's backend, so stopping an old, already-superseded run can't
  // accidentally clear a newer run's currently-active process.
  if (currentBackendProcess === run.backend) currentBackendProcess = null
  await fs.rm(run.scratchDir, { recursive: true, force: true }).catch(() => {})
  activeNativeRuns.delete(runId)
}

typedIpc.handle('sandbox:startNative', async (event: any, { runId, files }: { runId: string; files: Record<string, string> }) => {
  const sender = event.sender
  const send = (channel: string, payload: any) => {
    if (!sender.isDestroyed()) sender.send(channel, { runId, ...payload })
  }

  try {
    // A stale run under the same id (e.g. a fresh generation replacing an
    // old one) must be fully torn down first -- two processes racing for
    // the same port would just fail confusingly for both.
    await stopNativeRun(runId)

    const scratchDir = path.join(os.tmpdir(), 'branch-hq-sandbox', runId)
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(scratchDir, { recursive: true })

    const hasBackend = Object.keys(files).some(f => f.startsWith('server/'))
    const frontendFiles: Record<string, string> = {}
    const backendFiles: Record<string, string> = {}
    for (const [p, content] of Object.entries(files)) {
      if (p.startsWith('server/')) backendFiles[p.slice('server/'.length)] = content
      else frontendFiles[p] = content
    }
    // FIXED: confirmed real, necessary companion to the prefixing fix
    // above -- once Dwight's (or Riley's) output is correctly prefixed
    // rather than misidentified as frontend content, a direct-chat
    // response with ONLY a backend (no Jim involved at all) genuinely
    // has zero frontend files. Without this check, the code below would
    // still unconditionally try to npm install in an empty scratch
    // directory with no package.json -- trading the original
    // EADDRINUSE-from-misidentification bug for a new, different
    // failure, not actually fixing the underlying scenario. A real
    // frontend always has an injected package.json (see
    // injectFrontendBoilerplate) -- its absence is the honest signal
    // there's nothing to run here.
    const hasFrontend = 'package.json' in frontendFiles

    if (hasFrontend) {
      await writeFilesToScratch(scratchDir, frontendFiles)
    }
    if (hasBackend) await writeFilesToScratch(path.join(scratchDir, 'server'), backendFiles)

    const run: NativeRun = { scratchDir }
    activeNativeRuns.set(runId, run)

    // -------- Frontend (only if one genuinely exists) --------
    if (hasFrontend) {
    send('sandbox:log', { source: 'frontend', line: 'Installing frontend dependencies...' })
    await new Promise<void>((resolve, reject) => {
      const install = spawn('npm', ['install'], { cwd: scratchDir, shell: true, env: cleanInstallEnv() })
      install.stdout.on('data', (d: Buffer) => send('sandbox:log', { source: 'frontend', line: d.toString() }))
      install.stderr.on('data', (d: Buffer) => send('sandbox:log', { source: 'frontend', line: d.toString() }))
      install.on('exit', (code: number | null) => code === 0 ? resolve() : reject(new Error(`Frontend npm install exited with code ${code}`)))
    })

    const frontendDev = spawn('npm', ['run', 'dev'], { cwd: scratchDir, shell: true })
    run.frontend = frontendDev
    let frontendReady = false
    // FIXED: previously matched each stdout chunk in isolation. Node
    // delivers process output in arbitrary chunks, not guaranteed to
    // break on line boundaries -- "Local: http://localhost:3001/" could
    // arrive split across two separate chunks, and a regex checked
    // against each chunk alone would never match either half. Confirmed
    // real failure: Vite genuinely started and reported ready, but
    // detection never fired, so the iframe never got a URL and the
    // preview stayed blank despite the server actually running.
    // Accumulating into a rolling buffer and matching against that
    // survives a split landing anywhere. Only accumulated while not yet
    // ready, so this doesn't grow unbounded for a long-running server.
    let frontendOutputBuffer = ''
    frontendDev.stdout.on('data', (d: Buffer) => {
      const line = d.toString()
      send('sandbox:log', { source: 'frontend', line })
      if (frontendReady) return
      frontendOutputBuffer += line
      // Capped -- Vite's ready banner appears within the first couple KB
      // of output; no reason to keep an ever-growing buffer around while
      // waiting for something that should show up almost immediately.
      if (frontendOutputBuffer.length > 8000) {
        frontendOutputBuffer = frontendOutputBuffer.slice(-8000)
      }
      const match = frontendOutputBuffer.match(/Local:\s+https?:\/\/localhost:(\d+)/)
      if (match) {
        frontendReady = true
        const port = Number(match[1])
        run.frontendPort = port
        send('sandbox:frontend-ready', { url: `http://localhost:${port}`, port })
      }
    })
    frontendDev.stderr.on('data', (d: Buffer) => send('sandbox:log', { source: 'frontend', line: d.toString() }))
    frontendDev.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) send('sandbox:error', { source: 'frontend', message: `Frontend dev server exited with code ${code}` })
    })
    } else {
      // NEW: honest, explicit signal for the backend-only case -- no
      // frontend was ever attempted, so there's genuinely no "frontend
      // ready" event coming. Without this, the renderer would just wait
      // forever for one, showing "Awaiting server URL..." indefinitely
      // even after the backend is confirmed running.
      send('sandbox:log', { source: 'system', line: 'No frontend in this response -- running the backend only.' })
    }

    // -------- Backend (only if one was actually built alongside it) --------
    if (hasBackend) {
      const serverDir = path.join(scratchDir, 'server')
      send('sandbox:log', { source: 'backend', line: 'Installing backend dependencies...' })
      await new Promise<void>((resolve, reject) => {
        const install = spawn('npm', ['install'], { cwd: serverDir, shell: true, env: cleanInstallEnv() })
        install.stdout.on('data', (d: Buffer) => send('sandbox:log', { source: 'backend', line: d.toString() }))
        install.stderr.on('data', (d: Buffer) => send('sandbox:log', { source: 'backend', line: d.toString() }))
        install.on('exit', (code: number | null) => code === 0 ? resolve() : reject(new Error(`Backend npm install exited with code ${code}`)))
      })

      // FIXED: see currentBackendProcess's own note above -- always kill
      // whatever's currently holding the fixed backend port before
      // spawning a new one, regardless of which run it belonged to.
      // This catches same-session collisions; it does NOT catch a
      // process orphaned by an earlier, already-closed app session,
      // since currentBackendProcess is a fresh, empty variable on
      // every app launch. killWhateverIsOnPort (below) is the part
      // that actually closes that second, confirmed-real gap.
      if (currentBackendProcess) {
        try { currentBackendProcess.kill() } catch { /* already gone */ }
        currentBackendProcess = null
        // Killing a process doesn't guarantee the OS has released the
        // port the instant kill() returns -- a brief wait here is
        // cheap insurance against the exact same EADDRINUSE race,
        // just one step later (the old process's socket lingering in
        // TIME_WAIT/closing state for a moment after the process itself
        // is gone).
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      // FIXED: confirmed real failure -- EADDRINUSE on the very FIRST
      // native boot of a fresh app session, when currentBackendProcess
      // was still null and had nothing to kill. Asks the OS directly
      // what's actually bound to the port, regardless of which app
      // session (this one or an earlier, already-closed one) put it
      // there. See killWhateverIsOnPort's own note for the full
      // reasoning; safe to always call, even when nothing needs
      // clearing.
      await killWhateverIsOnPort(NATIVE_BACKEND_PORT)

      const backendDev = spawn('npm', ['run', 'dev'], {
        cwd: serverDir,
        shell: true,
        env: { ...process.env, PORT: String(NATIVE_BACKEND_PORT) }
      })
      run.backend = backendDev
      currentBackendProcess = backendDev
      backendDev.stdout.on('data', (d: Buffer) => send('sandbox:log', { source: 'backend', line: d.toString() }))
      // NEW: previously only stdout was scanned; EADDRINUSE and most
      // other Node crash dumps go to STDERR, not stdout -- meaning this
      // specific, confirmed real failure was never actually detected as
      // an error by this check before, even though the raw text was
      // visible in the container output log.
      let backendStderrTail = ''
      backendDev.stderr.on('data', (d: Buffer) => {
        const line = d.toString()
        send('sandbox:log', { source: 'backend', line })
        backendStderrTail = (backendStderrTail + line).slice(-4000)
      })
      backendDev.on('exit', (code: number | null) => {
        // Reference-checked, not unconditional -- a NEWER backend
        // process's own currentBackendProcess assignment must not get
        // silently cleared by an OLDER process's exit handler firing
        // late (e.g. from the kill() above resolving asynchronously).
        if (currentBackendProcess === backendDev) currentBackendProcess = null
        if (code !== null && code !== 0) {
          // FIXED: previously just "exited with code N" -- gave no hint
          // this was EADDRINUSE (or anything else) without digging
          // through the raw log separately. Surfaces the real crash
          // reason directly in the error self-healing and the UI both
          // see.
          const reason = /EADDRINUSE/.test(backendStderrTail)
            ? `port ${NATIVE_BACKEND_PORT} was already in use by another process`
            : `exited with code ${code}`
          send('sandbox:error', { source: 'backend', message: `Backend server ${reason}` })
        }
      })

      // Genuine port probe, not a log-line guess -- see waitForPort's own
      // note on why this is the more trustworthy signal here.
      const backendUp = await waitForPort(NATIVE_BACKEND_PORT, 30000)
      if (backendUp) {
        send('sandbox:backend-ready', { url: `http://localhost:${NATIVE_BACKEND_PORT}`, port: NATIVE_BACKEND_PORT })
        // NEW: when there's no frontend at all (a direct-chat-to-Dwight
        // response, correctly identified as backend-only now that it's
        // properly prefixed), the backend coming up IS the whole run
        // succeeding -- there's no separate frontend-ready event ever
        // coming to tell the renderer the run is actually done.
        if (!hasFrontend) {
          send('sandbox:backend-only-complete', { url: `http://localhost:${NATIVE_BACKEND_PORT}`, port: NATIVE_BACKEND_PORT })
        }
      } else {
        send('sandbox:error', { source: 'backend', message: `Backend did not start listening on port ${NATIVE_BACKEND_PORT} within 30s.` })
      }
    }

    return { success: true }
  } catch (err: any) {
    send('sandbox:error', { source: 'system', message: err.message })
    return { success: false, error: err.message }
  }
})

typedIpc.handle('sandbox:stopNative', async (_event: any, { runId }: { runId: string }) => {
  await stopNativeRun(runId)
  return { success: true }
})

// Nothing left running in the background after the app itself closes.
app.on('before-quit', () => {
  for (const runId of activeNativeRuns.keys()) {
    stopNativeRun(runId)
  }
})


typedIpc.handle('fs:write', async (_event: any, { targetDirectory, files, overwriteConfirmed }: { targetDirectory: string; files: Record<string, string>; overwriteConfirmed?: boolean }) => {
  try {
    const writtenPaths: string[] = []
    const skippedPaths: string[] = []
    const resolvedTarget = path.resolve(targetDirectory)

    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.resolve(resolvedTarget, relativePath)

      const isInsideTarget =
        absolutePath === resolvedTarget || absolutePath.startsWith(resolvedTarget + path.sep)
      if (!isInsideTarget) {
        throw new Error(`Refused to write outside target directory: "${relativePath}" resolved to ${absolutePath}`)
      }

      // NEW: unless overwriting was explicitly confirmed, leave existing
      // files alone. Previously this silently replaced whatever was
      // there -- fine for an empty output folder, potentially destructive
      // when pointed at a real project.
      if (!overwriteConfirmed) {
        try {
          await fs.access(absolutePath)
          skippedPaths.push(relativePath)
          continue
        } catch {
          // Doesn't exist -- safe to write.
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, content, 'utf-8')
      writtenPaths.push(absolutePath)
    }

    return { success: true, writtenFiles: writtenPaths, skippedFiles: skippedPaths }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// NEW: a real ZIP download -- for someone who wants the code to take
// elsewhere and deploy themselves, without needing to know or care what
// "target folder" or "Push to Local" mean. Opens a real native save
// dialog and writes a genuine, complete .zip -- same merged file set
// (including a server/ subfolder when a backend was built alongside the
// frontend) that Push to Local would write, just packaged as one
// portable file instead of a live folder.
typedIpc.handle('fs:downloadZip', async (_event: any, { files, suggestedName }: { files: Record<string, string>; suggestedName?: string }) => {
  try {
    const zip = new JSZip()
    for (const [relativePath, content] of Object.entries(files)) {
      zip.file(relativePath, content)
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Download Project as ZIP',
      defaultPath: `${suggestedName || 'branch-hq-project'}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }]
    })
    if (canceled || !filePath) {
      return { success: false, canceled: true }
    }

    await fs.writeFile(filePath, buffer)
    return { success: true, savedTo: filePath }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// ============================================================================
// GITHUB INTEGRATION (foundation) -- real, but scoped honestly. Personal
// Access Token auth, not full OAuth (which needs Branch HQ registered as
// a real GitHub developer app -- a separate step, not something doable
// from this codebase alone). Creates a new PRIVATE repo by default and
// pushes to it using real git commands, the same scratch-directory and
// process-spawning pattern already proven by the native execution
// engine. Vercel deployment deliberately isn't built yet -- connecting
// the resulting GitHub repo to Vercel through Vercel's own UI gets most
// of the way there for free, without needing a second integration.
// ============================================================================

typedIpc.handle('credentials:setGithubToken', async (_event: any, token: string) => {
  return await setGithubToken(token)
})

typedIpc.handle('credentials:hasGithubToken', async () => {
  return { hasToken: await hasGithubToken() }
})

typedIpc.handle('credentials:clearGithubToken', async () => {
  await clearGithubToken()
  return { success: true }
})

function detectGit(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], (err: Error | null) => resolve(!err))
  })
}

typedIpc.handle('git:pushToGithub', async (_event: any, { files, repoName, isPrivate }: { files: Record<string, string>; repoName: string; isPrivate: boolean }) => {
  try {
    const token = await getGithubTokenForInternalUse()
    if (!token) {
      return { success: false, error: 'No GitHub token is set up yet -- add one in Settings first.' }
    }

    const gitAvailable = await detectGit()
    if (!gitAvailable) {
      return { success: false, error: 'git does not appear to be installed on this machine. Install it, then try again.' }
    }

    // Real repo creation via GitHub's REST API. Private by default --
    // this is very likely to contain real, possibly proprietary code,
    // and a private default is the safer choice than a public one.
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: repoName, private: isPrivate })
    })

    if (!createRes.ok) {
      const errBody = await createRes.json().catch(() => ({}))
      const message = errBody?.errors?.[0]?.message || errBody?.message || `GitHub returned status ${createRes.status}`
      return { success: false, error: `Could not create the repo: ${message}` }
    }

    const repoData = await createRes.json()
    const owner = repoData.owner?.login
    const htmlUrl = repoData.html_url
    // The token is embedded directly in the HTTPS remote URL -- a
    // standard, well-established way to authenticate a git push with a
    // PAT, without needing to configure SSH keys.
    const authedRemote = `https://${token}@github.com/${owner}/${repoName}.git`

    const scratchDir = path.join(os.tmpdir(), 'branch-hq-github-push', `${Date.now()}`)
    await fs.mkdir(scratchDir, { recursive: true })
    await writeFilesToScratch(scratchDir, files)

    const runGit = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
      // FIXED: confirmed real bug -- shell:true concatenates args into
      // one unquoted command string, so any argument containing a space
      // (like "Branch HQ" in the commit author name and message) gets
      // split into separate words by the shell, and the stray "HQ"
      // token gets interpreted as a git subcommand ("git: 'HQ' is not
      // a git command"). git is a real native binary on every platform,
      // unlike npm which sometimes needs shell resolution on Windows --
      // removing shell:true here lets spawn() pass each argument
      // correctly and directly, spaces included, with no shell parsing.
      const proc = spawn('git', args, { cwd: scratchDir, env: cleanInstallEnv() })
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('exit', (code: number | null) => code === 0 ? resolve() : reject(new Error(stderr || `git ${args[0]} exited with code ${code}`)))
    })

    await runGit(['init'])
    await runGit(['add', '-A'])
    await runGit(['-c', 'user.email=branch-hq@local', '-c', 'user.name=Branch HQ', 'commit', '-m', 'Initial commit from Branch HQ'])
    await runGit(['branch', '-M', 'main'])
    await runGit(['remote', 'add', 'origin', authedRemote])
    await runGit(['push', '-u', 'origin', 'main'])

    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {})

    return { success: true, repoUrl: htmlUrl }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// NEW: real file upload/attachment. Scoped deliberately to genuinely
// text-extractable documents (PDF, plain text/markdown) -- a well-
// reasoned first version, not a full multimodal rearchitecture. Image
// upload would need actual vision-model support (base64 image content
// in the API call shape), which is a separate, larger piece of work,
// not folded in here silently.
const MAX_UPLOADED_TEXT_CHARS = 12000

typedIpc.handle('file:extractText', async (_event: any, { fileName, fileBytes }: { fileName: string; fileBytes: ArrayBuffer }) => {
  try {
    const buffer = Buffer.from(fileBytes)
    const lowerName = fileName.toLowerCase()
    let text: string

    if (lowerName.endsWith('.pdf')) {
      const parsed = await pdfParse(buffer)
      text = parsed.text
    } else if (lowerName.endsWith('.txt') || lowerName.endsWith('.md') || lowerName.endsWith('.csv') || lowerName.endsWith('.json')) {
      text = buffer.toString('utf-8')
    } else {
      return {
        success: false,
        error: `"${fileName}" isn't a supported file type yet -- PDF, .txt, .md, .csv, and .json are supported. Images and other formats aren't extractable as text yet.`
      }
    }

    const truncated = text.length > MAX_UPLOADED_TEXT_CHARS
    const finalText = truncated ? text.slice(0, MAX_UPLOADED_TEXT_CHARS) + '\n... (truncated)' : text

    if (finalText.trim().length === 0) {
      return { success: false, error: `"${fileName}" was read, but no extractable text was found in it (it may be a scanned/image-only PDF, which isn't supported yet).` }
    }

    return { success: true, text: finalText, truncated }
  } catch (err: any) {
    return { success: false, error: `Could not read "${fileName}": ${err.message}` }
  }
})

// ============================================================================
// MULTI-DEVICE PAIRING (Phase 1: discovery + secure pairing only -- no
// task handoff yet, deliberately staged separately). See
// deviceIdentity.ts for the cryptographic foundation (Ed25519 identity,
// signing, the human-verification code) and devicePairing.ts for the
// full protocol writeup and trusted-peer storage. This section is the
// actual network transport: a small local HTTP server other Branch HQ
// instances on the LAN can reach to request pairing, the signed
// outbound calls this instance makes to THEM, and the IPC surface this
// app's own renderer uses to drive the whole flow.
//
// HONESTY NOTE, the same kind this file already carries for the native
// execution engine: the cryptography itself (signing, verification, the
// verification-code derivation) was tested standalone with a real
// sign/verify/tamper round-trip before being wired in here, and that
// confidence is real. The actual multi-device network exchange --
// two real Electron processes on two real machines completing this
// full handshake -- has not been. Treat this as a carefully-reasoned
// first version, not something to trust untested.
// ============================================================================

const PREFERRED_PAIRING_PORT = 47821
let pairingHttpServer: http.Server | null = null
let pairingServerActualPort: number | null = null
let mainWindowRef: BrowserWindow | null = null

function sendToRenderer(channel: string, payload: any) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload)
  }
}

// NEW: confirmed real, long-standing UX gap -- the entire multi-agent
// pipeline previously ran as one single, opaque request-response.
// Nothing reached the chat until EVERYTHING (every agent, every Gate 1
// retry) had genuinely finished, which could legitimately take
// minutes -- indistinguishable from a hang the whole time it ran. This
// wraps addMessage to also push the new message to the renderer the
// instant it's actually created, not just once at the very end. Every
// addMessage call site in this file now goes through this wrapper
// instead, so this one change covers all of them without needing to
// touch each site's own logic individually.
async function addMessageAndBroadcast(...args: Parameters<typeof addMessage>) {
  const message = await addMessage(...args)
  sendToRenderer('chat:message-added', { conversationId: args[0], message })
  return message
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      // A crude but real cap -- nothing in this handshake should ever
      // legitimately need more than a few KB; refusing to buffer past
      // 1MB is cheap protection against a malformed or hostile sender
      // trying to exhaust memory with an oversized body.
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// NEW: needed for invite-based pairing -- the shareable invite string
// has to embed an IP address the OTHER device can actually reach over
// the LAN, not 'localhost' (which only ever means "this same machine"
// to whoever receives it). Picks the first non-internal IPv4 address,
// which is the ordinary case for a normal LAN connection; falls back
// to localhost rather than throwing if nothing suitable is found (an
// invite generated on a genuinely offline machine just won't be usable
// by another device, which is an honest, expected limitation, not a
// crash).
function getLocalLanAddress(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

async function startPairingServer(): Promise<void> {
  const identity = await getDeviceIdentity()

  pairingHttpServer = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url) {
        return sendJson(res, 404, { error: 'Not found' })
      }

      // -------- Incoming pairing request (this device is the responder) --------
      if (req.url === '/pairing/request') {
        const body = await readJsonBody(req)
        const { fromDeviceId, fromDeviceName, fromPublicKeyPem, nonce, signature } = body
        if (!fromDeviceId || !fromPublicKeyPem || !signature) {
          return sendJson(res, 400, { error: 'Malformed pairing request' })
        }
        // Proves the sender genuinely holds the private key for the
        // public key it's claiming -- not yet proof of WHICH real
        // device that is; the human verification code is what actually
        // establishes that.
        const payload = JSON.stringify({ fromDeviceId, fromPublicKeyPem, nonce })
        if (!verifySignature(fromPublicKeyPem, payload, signature)) {
          return sendJson(res, 401, { error: 'Invalid signature' })
        }
        // NEW: an already-trusted device re-sending a pairing request
        // (e.g. its user double-clicked "Pair," or it retried after a
        // dropped connection) shouldn't trigger a fresh human
        // confirmation prompt for a pairing that already exists --
        // just confirm the existing trust directly.
        if (await isPeerTrusted(fromDeviceId)) {
          return sendJson(res, 200, { received: true, alreadyTrusted: true })
        }
        const pending = createPendingIncomingRequest({
          fromDeviceId,
          fromDeviceName: fromDeviceName || 'Unknown Device',
          fromPublicKeyPem,
          myPublicKeyPem: identity.publicKeyPem
        })
        sendToRenderer('pairing:incoming-request', pending)
        return sendJson(res, 200, { received: true })
      }

      // -------- Peer accepted and is confirming back (this device is the requester) --------
      if (req.url === '/pairing/confirm') {
        const body = await readJsonBody(req)
        const { deviceId, deviceName, publicKeyPem, requestId, nonce, signature } = body
        if (!deviceId || !publicKeyPem || !signature) {
          return sendJson(res, 400, { error: 'Malformed confirmation' })
        }
        const payload = JSON.stringify({ deviceId, publicKeyPem, requestId, nonce })
        if (!verifySignature(publicKeyPem, payload, signature)) {
          return sendJson(res, 401, { error: 'Invalid signature' })
        }
        const outgoing = getPendingOutgoingRequest(deviceId)
        if (!outgoing) {
          return sendJson(res, 409, { error: 'No matching outgoing pairing request -- it may have expired.' })
        }
        markOutgoingAwaitingLocalConfirmation(deviceId)
        sendToRenderer('pairing:peer-confirmed', {
          targetDeviceId: deviceId,
          targetDeviceName: deviceName || outgoing.targetDeviceName,
          targetPublicKeyPem: publicKeyPem,
          verificationCode: outgoing.verificationCode,
          // Echoed straight through to finalize -- lets the responder
          // look its own pending record up directly by id, rather than
          // needing a less precise deviceId-based search.
          peerRequestId: requestId
        })
        return sendJson(res, 200, { received: true })
      }

      // -------- Invite-based pairing (this device generated the invite) --------
      // NEW: a genuinely different, simpler flow from the three above --
      // see devicePairing.ts's own note on the security reasoning. No
      // human confirmation step on this side: the request only reaches
      // here at all if the caller presented the exact secret embedded
      // in an invite THIS device generated and chose to share, which is
      // itself the consent.
      if (req.url === '/pairing/invite-request') {
        const body = await readJsonBody(req)
        const { fromDeviceId, fromDeviceName, fromPublicKeyPem, inviteCode, inviteSecret, nonce, signature } = body
        if (!fromDeviceId || !fromPublicKeyPem || !inviteCode || !inviteSecret || !signature) {
          return sendJson(res, 400, { error: 'Malformed invite pairing request' })
        }
        const payload = JSON.stringify({ fromDeviceId, fromPublicKeyPem, inviteCode, inviteSecret, nonce })
        if (!verifySignature(fromPublicKeyPem, payload, signature)) {
          return sendJson(res, 401, { error: 'Invalid signature' })
        }
        // Deliberately vague on failure (see consumeAndValidateInvite's
        // own note) -- wrong code, wrong secret, expired, and
        // already-used all produce the exact same response, so a wrong
        // guess can't be used to narrow down a real invite.
        if (!consumeAndValidateInvite(inviteCode, inviteSecret)) {
          return sendJson(res, 403, { error: 'That invite is invalid, expired, or has already been used.' })
        }
        await addTrustedPeer({
          deviceId: fromDeviceId,
          deviceName: fromDeviceName || 'Unknown Device',
          publicKeyPem: fromPublicKeyPem,
          pairedAt: Date.now()
        })
        // Informational only -- nothing for this device's user to
        // click or decide, since generating and sharing the invite
        // already was the decision.
        sendToRenderer('pairing:invite-completed', { deviceId: fromDeviceId, deviceName: fromDeviceName || 'Unknown Device' })
        return sendJson(res, 200, { deviceId: identity.deviceId, deviceName: identity.deviceName, publicKeyPem: identity.publicKeyPem })
      }

      // -------- Finalize (this device is the original responder) --------
      if (req.url === '/pairing/finalize') {
        const body = await readJsonBody(req)
        const { deviceId, deviceName, publicKeyPem, requestId, confirmed, nonce, signature } = body
        if (!deviceId || !publicKeyPem || !requestId || !signature) {
          return sendJson(res, 400, { error: 'Malformed finalize' })
        }
        const payload = JSON.stringify({ deviceId, publicKeyPem, requestId, confirmed, nonce })
        if (!verifySignature(publicKeyPem, payload, signature)) {
          return sendJson(res, 401, { error: 'Invalid signature' })
        }
        const pending = getPendingIncomingRequest(requestId)
        if (!pending || pending.fromDeviceId !== deviceId) {
          return sendJson(res, 409, { error: 'No matching pending request -- it may have expired.' })
        }
        consumePendingIncomingRequest(requestId)
        if (confirmed) {
          await addTrustedPeer({
            deviceId,
            deviceName: deviceName || pending.fromDeviceName,
            publicKeyPem,
            pairedAt: Date.now()
          })
          sendToRenderer('pairing:completed', { deviceId, deviceName: deviceName || pending.fromDeviceName })
        } else {
          sendToRenderer('pairing:cancelled-by-peer', { deviceId, deviceName: deviceName || pending.fromDeviceName })
        }
        return sendJson(res, 200, { acknowledged: true })
      }

      return sendJson(res, 404, { error: 'Not found' })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message || 'Internal error' })
    }
  })

  await new Promise<void>((resolve) => {
    pairingHttpServer!.listen(PREFERRED_PAIRING_PORT, () => {
      const address = pairingHttpServer!.address()
      pairingServerActualPort = typeof address === 'object' && address ? address.port : PREFERRED_PAIRING_PORT
      resolve()
    })
    // Preferred port taken -- fall back to an OS-assigned free one.
    // Discovery always advertises whatever port actually ended up in
    // use (see startDiscovery's pairingPort param below), so peers
    // never need to assume the preferred port specifically.
    pairingHttpServer!.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        pairingHttpServer!.listen(0, () => {
          const address = pairingHttpServer!.address()
          pairingServerActualPort = typeof address === 'object' && address ? address.port : 0
          resolve()
        })
      }
    })
  })
}

// NEW: a small helper for the outbound side -- every signed request
// this device sends to a peer follows the same shape (build a
// canonical payload, sign it with this device's own key, POST it, and
// never let a network failure here escape as an unhandled crash --
// pairing with an unreachable device should fail gracefully, not take
// the whole app down with it).
async function postSignedToPeer(host: string, port: number, urlPath: string, bodyWithoutSignature: Record<string, any>): Promise<{ ok: boolean; status: number; data: any }> {
  const identity = await getDeviceIdentity()
  const payload = JSON.stringify(bodyWithoutSignature)
  const signature = signPayload(identity.privateKeyPem, payload)
  const fullBody = { ...bodyWithoutSignature, signature }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`http://${host}:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullBody),
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, data }
  } catch (err: any) {
    clearTimeout(timeoutId)
    return { ok: false, status: 0, data: { error: err.message || 'Request failed' } }
  }
}

typedIpc.handle('devices:getIdentity', async () => {
  const identity = await getDeviceIdentity()
  return { deviceId: identity.deviceId, deviceName: identity.deviceName, publicKeyPem: identity.publicKeyPem }
})

typedIpc.handle('devices:setName', async (_event: any, name: string) => {
  const identity = await setDeviceName(name)
  // Re-advertise under the new name -- a stale advertised name would
  // otherwise persist on the network until the next app restart.
  stopDiscovery()
  startDiscovery({
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    publicKeyPem: identity.publicKeyPem,
    pairingPort: pairingServerActualPort || PREFERRED_PAIRING_PORT
  })
  return { success: true, deviceName: identity.deviceName }
})

typedIpc.handle('devices:listDiscovered', async () => {
  const trusted = await getTrustedPeers()
  const trustedIds = new Set(trusted.map(p => p.deviceId))
  return listDiscoveredDevices().map(d => ({ ...d, isTrusted: trustedIds.has(d.deviceId) }))
})

typedIpc.handle('devices:listTrusted', async () => {
  return await getTrustedPeers()
})

typedIpc.handle('devices:removeTrusted', async (_event: any, deviceId: string) => {
  await removeTrustedPeer(deviceId)
  return { success: true }
})

typedIpc.handle('devices:listPendingIncoming', async () => {
  return listPendingIncomingRequests()
})

// NEW: step 1 of the handshake -- this device (the requester) sends a
// signed pairing request to a discovered peer, and immediately computes
// its own copy of the human verification code (it already has both
// public keys at this point: its own, and the peer's from discovery).
// NEW: invite-based pairing -- generates a shareable string (embedding
// a single-use code+secret and this device's real LAN address) that
// works without either device needing mDNS discovery to succeed at
// all. See devicePairing.ts's own note on the security reasoning.
typedIpc.handle('devices:generateInvite', async () => {
  const invite = createPairingInvite()
  const inviteString = `BHQ1:${invite.code}:${invite.secret}:${getLocalLanAddress()}:${pairingServerActualPort || PREFERRED_PAIRING_PORT}`
  return { success: true, inviteString, expiresInMinutes: 10 }
})

// NEW: the receiving half -- parses a shareable invite string, connects
// DIRECTLY to the embedded address (skipping discovery entirely), and
// completes pairing in one round-trip if the invite is valid. No
// separate local confirmation step needed here either: pasting an
// invite someone personally sent you, from a specific device you meant
// to pair with, is itself the decision.
typedIpc.handle('devices:pairViaInvite', async (_event: any, inviteString: string) => {
  const parts = (inviteString || '').trim().split(':')
  if (parts.length !== 5 || parts[0] !== 'BHQ1') {
    return { success: false, error: "That doesn't look like a valid Branch HQ invite." }
  }
  const [, code, secret, host, portStr] = parts
  const port = Number(portStr)
  if (!code || !secret || !host || !port || Number.isNaN(port)) {
    return { success: false, error: 'That invite looks incomplete or corrupted.' }
  }

  const identity = await getDeviceIdentity()
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = await postSignedToPeer(host, port, '/pairing/invite-request', {
    fromDeviceId: identity.deviceId,
    fromDeviceName: identity.deviceName,
    fromPublicKeyPem: identity.publicKeyPem,
    inviteCode: code,
    inviteSecret: secret,
    nonce
  })

  if (!result.ok) {
    return { success: false, error: result.data?.error || 'Could not reach that device -- check the invite is still valid and both devices can reach each other on the network.' }
  }

  const { deviceId, deviceName, publicKeyPem } = result.data
  if (!deviceId || !publicKeyPem) {
    return { success: false, error: 'The other device responded, but not with a valid identity -- pairing was not completed.' }
  }
  await addTrustedPeer({ deviceId, deviceName: deviceName || 'Unknown Device', publicKeyPem, pairedAt: Date.now() })
  return { success: true, deviceName: deviceName || 'Unknown Device' }
})

// NEW: worldwide (non-LAN) pairing, via an explicitly user-configured
// relay -- see settingsStore.ts's relayServerUrl and
// relay-server/README.md for the full reasoning. Reuses the exact same
// invite code+secret mechanism and Ed25519 signing already built for
// LAN pairing -- the only thing that changes is the TRANSPORT: instead
// of a direct HTTP POST to a LAN IP, both devices connect out to the
// same relay over WebSocket and exchange the identical signed payloads
// through it. The relay itself never needs to understand any of this
// content -- see the relay server's own file for that reasoning.
typedIpc.handle('devices:generateWorldwideInvite', async () => {
  const settings = await getSettings()
  if (!settings.relayServerUrl) {
    return { success: false, error: 'Set a relay server URL in Settings first -- worldwide pairing needs one to actually connect two devices that aren\'t on the same network.' }
  }

  const identity = await getDeviceIdentity()
  const invite = createPairingInvite()

  try {
    const socket = new WebSocket(settings.relayServerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', (err) => reject(err))
    })
    socket.send(JSON.stringify({ type: 'register', code: invite.code }))

    // Stays open in the background listening for a redemption -- this
    // IPC call itself returns immediately once the invite string is
    // ready to share, it doesn't block on someone actually using it.
    socket.on('message', async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type !== 'relay') return
        const { fromDeviceId, fromDeviceName, fromPublicKeyPem, inviteSecret, nonce, signature } = msg.payload || {}
        if (!fromDeviceId || !fromPublicKeyPem || !inviteSecret || !signature) return

        const payload = JSON.stringify({ fromDeviceId, fromPublicKeyPem, inviteSecret, nonce })
        if (!verifySignature(fromPublicKeyPem, payload, signature)) return
        if (!consumeAndValidateInvite(invite.code, inviteSecret)) return

        await addTrustedPeer({
          deviceId: fromDeviceId,
          deviceName: fromDeviceName || 'Unknown Device',
          publicKeyPem: fromPublicKeyPem,
          pairedAt: Date.now()
        })

        // Respond with this device's own identity, signed, so the
        // other side can complete pairing on its end too.
        const myNonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const myPayload = JSON.stringify({ deviceId: identity.deviceId, publicKeyPem: identity.publicKeyPem, nonce: myNonce })
        socket.send(JSON.stringify({
          type: 'relay',
          payload: {
            deviceId: identity.deviceId,
            deviceName: identity.deviceName,
            publicKeyPem: identity.publicKeyPem,
            nonce: myNonce,
            signature: signPayload(identity.privateKeyPem, myPayload)
          }
        }))

        sendToRenderer('pairing:invite-completed', { deviceId: fromDeviceId, deviceName: fromDeviceName || 'Unknown Device' })
        socket.close()
      } catch {
        // A malformed relayed message is just ignored -- the relay
        // itself can't produce one (it only ever forwards verbatim),
        // so this would only happen from a genuinely broken or
        // adversarial peer, not a real usage pattern to recover from.
      }
    })

    // Matches the invite's own TTL -- if nobody redeems it in time,
    // stop listening rather than holding the connection open forever.
    setTimeout(() => { try { socket.close() } catch {} }, 10 * 60 * 1000)
  } catch (err: any) {
    return { success: false, error: `Could not reach the relay server: ${err.message}` }
  }

  const inviteString = `BHQW1:${invite.code}:${invite.secret}:${settings.relayServerUrl}`
  return { success: true, inviteString, expiresInMinutes: 10 }
})

typedIpc.handle('devices:redeemWorldwideInvite', async (_event: any, inviteString: string) => {
  const raw = (inviteString || '').trim()
  const firstColon = raw.indexOf(':')
  const secondColon = raw.indexOf(':', firstColon + 1)
  const thirdColon = raw.indexOf(':', secondColon + 1)
  if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
    return { success: false, error: "That doesn't look like a valid worldwide invite." }
  }
  const prefix = raw.slice(0, firstColon)
  const code = raw.slice(firstColon + 1, secondColon)
  const secret = raw.slice(secondColon + 1, thirdColon)
  // NEW: the relay URL is everything after the third colon, taken as
  // one piece rather than split further -- a real wss:// URL contains
  // its own colons (wss://host:port), which a naive full split would
  // have broken apart incorrectly.
  const relayUrl = raw.slice(thirdColon + 1)
  if (prefix !== 'BHQW1' || !code || !secret || !relayUrl) {
    return { success: false, error: "That doesn't look like a valid worldwide invite." }
  }

  const identity = await getDeviceIdentity()

  try {
    const socket = new WebSocket(relayUrl)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', (err) => reject(err))
    })

    const result = await new Promise<{ success: boolean; deviceName?: string; error?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Timed out waiting for the other device -- check the invite is still valid.' })
        try { socket.close() } catch {}
      }, 15000)

      socket.on('message', async (rawMsg: any) => {
        try {
          const msg = JSON.parse(rawMsg.toString())
          if (msg.type === 'matched') {
            const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
            const payload = JSON.stringify({ fromDeviceId: identity.deviceId, fromPublicKeyPem: identity.publicKeyPem, inviteSecret: secret, nonce })
            socket.send(JSON.stringify({
              type: 'relay',
              payload: {
                fromDeviceId: identity.deviceId,
                fromDeviceName: identity.deviceName,
                fromPublicKeyPem: identity.publicKeyPem,
                inviteSecret: secret,
                nonce,
                signature: signPayload(identity.privateKeyPem, payload)
              }
            }))
          } else if (msg.type === 'relay') {
            const { deviceId, deviceName, publicKeyPem, nonce, signature } = msg.payload || {}
            if (!deviceId || !publicKeyPem || !signature) return
            const peerPayload = JSON.stringify({ deviceId, publicKeyPem, nonce })
            if (!verifySignature(publicKeyPem, peerPayload, signature)) {
              clearTimeout(timeout)
              resolve({ success: false, error: 'The other device responded with an invalid signature -- pairing was not completed.' })
              return
            }
            await addTrustedPeer({ deviceId, deviceName: deviceName || 'Unknown Device', publicKeyPem, pairedAt: Date.now() })
            clearTimeout(timeout)
            resolve({ success: true, deviceName: deviceName || 'Unknown Device' })
            try { socket.close() } catch {}
          } else if (msg.type === 'error') {
            clearTimeout(timeout)
            resolve({ success: false, error: msg.message || 'The relay rejected this invite.' })
          }
        } catch {
          // A malformed message from the relay/peer -- let the timeout
          // above handle it rather than resolving on bad data.
        }
      })

      socket.send(JSON.stringify({ type: 'join', code }))
    })

    return result
  } catch (err: any) {
    return { success: false, error: `Could not reach the relay server: ${err.message}` }
  }
})

typedIpc.handle('devices:initiatePairing', async (_event: any, targetDeviceId: string) => {
  const target = listDiscoveredDevices().find(d => d.deviceId === targetDeviceId)
  if (!target) return { success: false, error: 'That device is no longer visible on the network.' }

  const identity = await getDeviceIdentity()
  const pending = createPendingOutgoingRequest({
    targetDeviceId: target.deviceId,
    targetDeviceName: target.deviceName,
    targetPublicKeyPem: target.publicKeyPem,
    myPublicKeyPem: identity.publicKeyPem
  })

  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = await postSignedToPeer(target.host, target.port, '/pairing/request', {
    fromDeviceId: identity.deviceId,
    fromDeviceName: identity.deviceName,
    fromPublicKeyPem: identity.publicKeyPem,
    nonce
  })

  if (!result.ok) {
    consumePendingOutgoingRequest(target.deviceId)
    return { success: false, error: result.data?.error || 'Could not reach that device.' }
  }

  return { success: true, verificationCode: pending.verificationCode, targetDeviceName: target.deviceName }
})

// NEW: step 2 -- the responder's human decides. On accept, sends the
// signed confirmation back to the requester; on reject, just discards
// the pending request and the requester's attempt will time out
// naturally (see PENDING_REQUEST_TTL_MS in devicePairing.ts) rather
// than needing an explicit "you were rejected" message -- a real,
// deliberate choice: distinguishing "declined" from "never seen" to
// the requester isn't necessary for this to work correctly, and not
// sending it avoids a small information-disclosure question about
// whether declining should be silent or explicit.
typedIpc.handle('devices:respondToIncomingRequest', async (_event: any, { requestId, accept }: { requestId: string; accept: boolean }) => {
  const pending = getPendingIncomingRequest(requestId)
  if (!pending) return { success: false, error: 'That pairing request is no longer available (it may have expired).' }

  if (!accept) {
    consumePendingIncomingRequest(requestId)
    return { success: true, accepted: false }
  }

  const identity = await getDeviceIdentity()
  // The peer that originally reached out is only known by its
  // advertised discovery info -- look it up the same way outgoing
  // pairing does, since incoming requests don't carry a callback
  // address of their own (HTTP requests aren't naturally bidirectional).
  const target = listDiscoveredDevices().find(d => d.deviceId === pending.fromDeviceId)
  if (!target) {
    return { success: false, error: 'That device is no longer visible on the network -- cannot send a confirmation back.' }
  }

  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = await postSignedToPeer(target.host, target.port, '/pairing/confirm', {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    publicKeyPem: identity.publicKeyPem,
    requestId,
    nonce
  })

  if (!result.ok) {
    return { success: false, error: result.data?.error || 'Could not reach that device to confirm pairing.' }
  }

  // Deliberately NOT added to trusted peers yet -- this device only
  // trusts the requester once ITS OWN human also confirms (via
  // devices:finalizeOutgoingPairing on the requester's side triggering
  // a /pairing/finalize call back here). Accepting here starts the
  // final leg of the handshake; it doesn't complete it alone.
  return { success: true, accepted: true, verificationCode: pending.verificationCode }
})

// NEW: step 3 -- the requester's human sees the peer's confirmation and
// the matching code, and makes the FINAL call. Only on confirm does
// this device actually add the peer as trusted locally, and only then
// does the peer learn to do the same via /pairing/finalize.
typedIpc.handle('devices:finalizeOutgoingPairing', async (_event: any, { targetDeviceId, peerRequestId, confirmed }: { targetDeviceId: string; peerRequestId: string; confirmed: boolean }) => {
  const outgoing = getPendingOutgoingRequest(targetDeviceId)
  if (!outgoing) return { success: false, error: 'That pairing attempt is no longer active (it may have expired).' }

  consumePendingOutgoingRequest(targetDeviceId)

  if (confirmed) {
    await addTrustedPeer({
      deviceId: outgoing.targetDeviceId,
      deviceName: outgoing.targetDeviceName,
      publicKeyPem: outgoing.targetPublicKeyPem,
      pairedAt: Date.now()
    })
  }

  const target = listDiscoveredDevices().find(d => d.deviceId === targetDeviceId)
  if (!target) {
    // Trust was still recorded locally above if confirmed -- only the
    // final handshake message to the PEER couldn't be delivered. The
    // peer's own copy of this pairing simply won't complete until it
    // hears otherwise; not a reason to undo what this side already
    // decided.
    return { success: confirmed, error: confirmed ? 'Paired locally, but could not notify the other device (it left the network).' : undefined }
  }

  const identity = await getDeviceIdentity()
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  await postSignedToPeer(target.host, target.port, '/pairing/finalize', {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    publicKeyPem: identity.publicKeyPem,
    requestId: peerRequestId,
    confirmed,
    nonce
  })

  return { success: true }
})

// 7. Window Configuration
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#131314',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // NEW: required for the sandbox <webview> (WebContainer content,
      // loaded into its own session partition -- see sandboxSession
      // above) to be usable at all. Electron disables the <webview> tag
      // by default specifically because a webview loading untrusted
      // content with the host page's own privileges is a real risk --
      // that's exactly why sandboxWebview.ts (its preload) exposes a
      // deliberately tiny bridge (run/log/ready/error/document-ready
      // only) instead of the main preload's full API surface, and why
      // it's pinned to its own non-persistent, non-default session.
      webviewTag: true
    }
  })

  // NEW: lets the pairing HTTP server (which has no direct access to
  // this local variable, since it's set up separately in
  // app.whenReady()) push events -- an incoming pairing request, a
  // peer's confirmation -- to this window's renderer as they happen.
  mainWindowRef = mainWindow

  // NEW: previously nothing was configured here at all, and modern
  // Electron blocks target="_blank"/window.open by default unless a
  // handler explicitly allows it -- meaning the "Open Externally" link
  // in the sandbox panel was very likely doing nothing when clicked.
  // This routes it to the OS's real default browser. Worth knowing
  // honestly: a WebContainer preview URL depends on cross-origin
  // isolation and virtual networking specific to the context that
  // booted it (see sandboxSession above) -- opening it in a genuinely
  // separate browser process may not always render correctly, since
  // that separate process never gets those same headers. This fix makes
  // the click actually do something real; it does not guarantee the
  // WebContainer preview specifically will load outside the app every
  // time.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // FIXED: this handler used to carry all the COOP/COEP forcing logic
  // too, gated behind willUseWebContainerFallback / activeNativePorts /
  // resourceType checks -- see the removed code and comment trail above
  // sandboxSession for the full history of why that approach kept
  // producing new edge cases instead of actually resolving the
  // conflict. All isolation-header logic now lives entirely on
  // sandboxSession instead, which is the only session that ever hosts
  // WebContainer content. This handler's only remaining job is
  // defensive: strip whatever CSP an embedded native dev server or
  // Express backend might send on its own, since a restrictive one
  // could otherwise block this page from framing it -- nothing here
  // adds isolation headers, and nothing here needs to distinguish
  // native ports from anything else anymore.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    delete responseHeaders['Content-Security-Policy']
    delete responseHeaders['content-security-policy']
    callback({ responseHeaders })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.disableHardwareAcceleration()

// NEW: WebContainers run project code in a different origin than
// Branch HQ's own app -- a "third-party" context by Chromium's
// definition. Since Chrome 115, third-party contexts have service
// workers blocked by default unless third-party storage partitioning is
// explicitly disabled, which is exactly what produced the "Enable
// Storage Partitioning" screen. Left as a per-user browser setting,
// whether a client hits this depends on their own Chromium version and
// privacy settings -- unpredictable, and a bad thing to hit mid-demo.
// Setting it here, before the app is ready, means it's baked into
// Branch HQ itself -- no client ever needs to touch a flag manually.
// Genuinely worth confirming this clears the screen when tested; this
// is a strong, well-supported fix for the documented cause, not one
// I've been able to run and watch resolve it myself.
app.commandLine.appendSwitch('disable-features', 'ThirdPartyStoragePartitioning')

// NEW: "InvalidStateError: Failed to register a ServiceWorker" is a
// well-documented Electron pattern (VS Code's own webviews hit this
// exact error regularly) with two common real causes: a stale, corrupted
// service worker registration left over from an earlier run, or a race
// registering too soon after a fresh launch. Since this app gets
// restarted often during active development, with different CSP/session
// configurations each time, stale leftover registrations are a real risk
// worth proactively clearing rather than leaving for someone to
// diagnose by hand in DevTools each time it happens.
app.whenReady().then(async () => {
  await session.defaultSession.clearStorageData({ storages: ['serviceworkers'] }).catch(() => {})
  // NEW: must happen after app.whenReady() -- see setupSandboxSession's
  // own note on why this crashed when it ran at module scope instead.
  // Before createWindow() so the partition and its headers exist before
  // any webview could possibly try to use them.
  setupSandboxSession()
  createWindow()

  // NEW: multi-device pairing startup -- after createWindow() so
  // mainWindowRef is already set (the pairing server needs it to push
  // events the instant they happen, e.g. an incoming request arriving
  // before anyone's even looking at a Devices panel).
  try {
    await startPairingServer()
    const identity = await getDeviceIdentity()
    startDiscovery({
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      publicKeyPem: identity.publicKeyPem,
      pairingPort: pairingServerActualPort || PREFERRED_PAIRING_PORT
    })
  } catch (err: any) {
    // Never let a LAN-discovery/pairing startup failure (a restricted
    // network, a firewall blocking multicast, a port genuinely
    // unavailable even after fallback) take down the rest of the app --
    // this is a real, but non-essential, capability.
    console.error('[Device Pairing] Failed to start -- continuing without it:', err.message)
  }
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { stopDiscovery() })