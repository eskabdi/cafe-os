// PLACEHOLDER. Overwritten by:
//   pnpm dlx supabase gen types typescript --local > src/lib/supabase/types.ts
// Re-run after every migration. Do not hand-edit once generated.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: Record<string, never>
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
