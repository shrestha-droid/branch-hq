import { createClient } from '@supabase/supabase-js'

// Ensure these are accessed via your environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase public credentials')
}

// Instantiate with forced HTTPS underlying the client
export const supabase = createClient(supabaseUrl, supabaseAnonKey)