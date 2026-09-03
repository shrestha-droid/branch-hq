// NEW: vertical starter-kits. The problem this solves: every request
// currently regenerates a data model and structure from scratch, even
// though an agency's real client base clusters around a handful of
// repeat request shapes (a salon wants booking, a shop wants inventory,
// a service business wants leads). Regenerating structure from zero
// every time is exactly where Dwight's multi-file discipline gets
// tested fresh on every single request -- a proven, known-good shape to
// customize WITHIN cuts both cost and failure rate at once, compared to
// inventing the data model from scratch each time.
//
// Deliberately scoped to guidance text, not full pre-built apps: a
// pre-written app would be wrong the moment a client's actual business
// doesn't match the assumed shape exactly, and silently forcing a
// generic template onto a specific request is worse than building from
// the request itself. This is scaffold KNOWLEDGE (proven field names, a
// sane relationship shape, the edge cases a first draft usually misses)
// handed to the specialists as extra context -- they still write the
// actual code, tailored to what was actually asked for.
//
// Only three verticals to start, chosen as genuinely common repeat
// categories for a local services agency, not an attempt to cover every
// possible business type speculatively. Add more here as real, repeated
// client requests reveal which categories are actually worth it --
// resist adding a vertical for a request that's only come up once.

export interface VerticalStarterKit {
  id: string
  name: string
  // Matched against the user's own request text, case-insensitively.
  // Deliberately simple substring keywords, not a classifier -- a false
  // negative (a real match gets missed) just means the request proceeds
  // exactly as it would have before this existed; a false positive risks
  // steering a request toward the wrong data model, which is the worse
  // failure, so keywords are kept specific rather than broad.
  keywords: string[]
  // Injected into BOTH Dwight's and Jim's instructions when matched --
  // proven field names and structure, not prescribed UI or exact
  // endpoints, so the specialists still design the actual implementation
  // around what was specifically asked for.
  guidance: string
}

export const VERTICAL_STARTER_KITS: VerticalStarterKit[] = [
  {
    id: 'booking',
    name: 'Booking / Appointments',
    keywords: ['booking', 'appointment', 'schedule a', 'scheduling', 'reservation', 'book a slot', 'salon', 'clinic booking'],
    guidance: `[KNOWN-GOOD STARTING SHAPE -- Booking/Appointments: a proven data model for this category, from real repeat client requests. Customize it to what was specifically asked for -- do not treat this as a rigid template.]
Core entity is typically a Booking: id, customerName, customerContact, serviceName, startTime (ISO), endTime (ISO), status ('confirmed' | 'cancelled' | 'completed'), notes, createdAt, updatedAt.
Common real requirement usually missed on a first draft: preventing double-booking -- before creating a booking, check for any existing booking on the same resource (staff member/room/slot) whose time range overlaps the requested one, and reject with a clear 409 conflict if it does, rather than silently allowing two bookings for the same slot.
A separate Service or Resource entity (name, durationMinutes, price) is usually worth it once there's more than one bookable thing (multiple staff, multiple rooms) -- ask the request's own detail level, don't over-build a multi-resource system for a single-provider business that doesn't need one.
Common frontend need: a day or week view is far more useful to a real business than a flat list, even if not explicitly requested -- but only add this complexity if the request's scope genuinely supports it.`
  },
  {
    id: 'inventory',
    name: 'Inventory / Retail POS-lite',
    keywords: ['inventory', 'stock', 'point of sale', 'pos system', 'pos ', 'retail', 'products and quantity', 'stock management'],
    guidance: `[KNOWN-GOOD STARTING SHAPE -- Inventory/Retail: a proven data model for this category, from real repeat client requests. Customize it to what was specifically asked for -- do not treat this as a rigid template.]
Core entity is typically a Product: id, name, sku, quantityOnHand, unitPrice, lowStockThreshold, category, createdAt, updatedAt.
Common real requirement usually missed on a first draft: quantity changes should go through a dedicated adjustment operation (e.g. POST /api/products/:id/adjust with a signed delta and a reason), not a raw PUT that overwrites quantityOnHand directly -- a raw overwrite loses the actual history of what happened (a sale vs. a restock vs. a correction) and makes two concurrent adjustments silently clobber each other.
A lowStockThreshold field is genuinely useful even for a simple request -- flagging items at or below it (in the list response, not just the UI) is a small addition with real business value.
Do not build a full point-of-sale checkout/payment flow unless it's explicitly asked for -- "inventory management" and "point of sale" are related but different scopes; default to the narrower one (tracking stock) unless the request specifically describes selling/checkout.`
  },
  {
    id: 'crm-leads',
    name: 'Simple CRM / Leads',
    keywords: ['crm', 'leads', 'lead tracking', 'customer relationship', 'sales pipeline', 'contact management'],
    guidance: `[KNOWN-GOOD STARTING SHAPE -- Simple CRM/Leads: a proven data model for this category, from real repeat client requests. Customize it to what was specifically asked for -- do not treat this as a rigid template.]
Core entity is typically a Lead (or Contact): id, name, email, phone, company, status ('new' | 'contacted' | 'qualified' | 'won' | 'lost'), source, notes, createdAt, updatedAt.
Common real requirement usually missed on a first draft: a lead's status history has real business value -- even a simple array of { status, changedAt } on the lead itself (appended to, not overwritten, on each status change) is far more useful to a real business than only ever showing the current status with no record of the journey.
Search/filter by status and a free-text search across name/company/notes is close to always wanted for this category, even when the request doesn't spell it out -- worth including by default here specifically, unlike features that should stay request-scoped elsewhere.
Do not build email-sending or calendar-sync integrations unless explicitly asked -- those depend on real third-party credentials/OAuth that this system doesn't have a path for yet; a "notes" or "next follow-up date" field covers most of what a simple CRM request actually needs without that dependency.`
  }
]

// NEW: simple substring matching against the user's own request text.
// Returns the first match only -- a request naming two different
// verticals at once is rare enough, and ambiguous enough, that guessing
// which one takes priority would be worse than just using whichever
// keyword happened to appear first in the list. Returns undefined for
// the (expected to be) common case of no match, which callers should
// treat as "proceed exactly as before this existed."
export function detectVerticalStarterKit(userPrompt: string): VerticalStarterKit | undefined {
  const lower = userPrompt.toLowerCase()
  return VERTICAL_STARTER_KITS.find(kit => kit.keywords.some(kw => lower.includes(kw)))
}