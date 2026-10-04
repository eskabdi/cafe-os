// PLACEHOLDER. Overwritten by:
//   pnpm dlx supabase gen types typescript --local > src/lib/supabase/types.ts
// Re-run after every migration. Do not hand-edit once generated.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: Record<string, never>
    Views: Record<string, never>
    // Hand-extended until `supabase gen types` can run (needs Docker): only the RPCs added by migration 0025.
    Functions: {
      fn_get_session_timers: { Args: Record<string, never>; Returns: Json }
      fn_update_session_timers: {
        Args: { p_idle_warning_seconds: number; p_signout_seconds: number; p_pin_pad_idle_seconds: number }
        Returns: Json
      }
      fn_reset_session_timers: { Args: Record<string, never>; Returns: Json }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
