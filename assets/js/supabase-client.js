// Shared Supabase client. The same-origin site pages use the browser's persisted auth session.
import { cfg, configured } from "./core.js";

let client = null;

export function getSupabaseClient() {
  if (!configured || !window.supabase) return null;
  if (!client) {
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { flowType: "implicit", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}
