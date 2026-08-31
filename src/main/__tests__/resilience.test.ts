import { describe, it, expect } from 'vitest'
import { looksTransient } from '../resilience'

describe('looksTransient', () => {
  it('recognizes the real Gemini 503 error actually hit in testing', () => {
    // The exact shape of error thrown by GeminiProvider on a real
    // overload response from Google's side.
    const err = new Error('Gemini API Error (503): {"error":{"code":503,"message":"This model is currently experiencing high demand."}}')
    expect(looksTransient(err)).toBe(true)
  })

  it('recognizes a request timeout', () => {
    const err = new Error('API Request timed out after 40 seconds.')
    expect(looksTransient(err)).toBe(true)
  })

  it('recognizes a local connection refused (e.g. Ollama not running)', () => {
    const err = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434')
    expect(looksTransient(err)).toBe(true)
  })

  it('does NOT treat a missing API key as transient -- retrying would just waste time on a permanent problem', () => {
    const err = new Error('Missing GEMINI_API_KEY in environment.')
    expect(looksTransient(err)).toBe(false)
  })

  it('does NOT treat a 400 (bad request) as transient', () => {
    const err = new Error('Gemini API Error (400): invalid request body')
    expect(looksTransient(err)).toBe(false)
  })

  it('does NOT treat a self-heal giving-up message as transient', () => {
    const err = new Error("Self-healing gave up after 2 attempts -- the code still doesn't run.")
    expect(looksTransient(err)).toBe(false)
  })

  it('handles an error with no message gracefully instead of throwing', () => {
    expect(() => looksTransient({})).not.toThrow()
    expect(looksTransient({})).toBe(false)
  })
})