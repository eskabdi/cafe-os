// GENERATED (public schema) by postgres-meta v0.91.0, the generator behind `supabase gen types typescript`, from all
// supabase/migrations applied to a throwaway Postgres 15 + scripts/db/shim. Do not hand-edit; regenerate after every migration:
//   pnpm dlx supabase gen types typescript --local > src/lib/supabase/types.ts
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          created_at: string
          detail: Json | null
          id: string
          platform_admin_id: string | null
          restaurant_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          detail?: Json | null
          id?: string
          platform_admin_id?: string | null
          restaurant_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          detail?: Json | null
          id?: string
          platform_admin_id?: string | null
          restaurant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_log_platform_admin_id_fkey"
            columns: ["platform_admin_id"]
            isOneToOne: false
            referencedRelation: "platform_admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_audit_log_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          created_at: string
          event: string
          id: string
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          restaurant_id: string
          table_name: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          created_at?: string
          event: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          restaurant_id: string
          table_name?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          event?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          restaurant_id?: string
          table_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          normalized_name: string | null
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          normalized_name?: string | null
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_sessions: {
        Row: {
          created_at: string
          customer_name: string | null
          customer_phone: string | null
          expires_at: string
          id: string
          last_seen_at: string | null
          qr_credential_id: string
          restaurant_id: string
          session_token_hash: string
          status: string
          table_session_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          expires_at: string
          id?: string
          last_seen_at?: string | null
          qr_credential_id: string
          restaurant_id: string
          session_token_hash: string
          status?: string
          table_session_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_name?: string | null
          customer_phone?: string | null
          expires_at?: string
          id?: string
          last_seen_at?: string | null
          qr_credential_id?: string
          restaurant_id?: string
          session_token_hash?: string
          status?: string
          table_session_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_sessions_qr_fk"
            columns: ["restaurant_id", "qr_credential_id"]
            isOneToOne: false
            referencedRelation: "qr_credentials"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "customer_sessions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_sessions_table_session_fk"
            columns: ["restaurant_id", "table_session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      day_sessions: {
        Row: {
          cash_collected: number | null
          cash_expenses: number | null
          cash_variance: number | null
          close_note: string | null
          closed_at: string | null
          closed_by: string | null
          counted_cash: number | null
          created_at: string
          day_no: number
          expected_cash: number | null
          expense_snapshot: Json | null
          expenses_total: number | null
          gross_collected: number | null
          id: string
          inventory_variance: number | null
          net_profit: number | null
          opened_at: string
          opened_by: string | null
          opening_float: number
          order_count: number | null
          payment_snapshot: Json | null
          restaurant_id: string
          station_snapshot: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          cash_collected?: number | null
          cash_expenses?: number | null
          cash_variance?: number | null
          close_note?: string | null
          closed_at?: string | null
          closed_by?: string | null
          counted_cash?: number | null
          created_at?: string
          day_no: number
          expected_cash?: number | null
          expense_snapshot?: Json | null
          expenses_total?: number | null
          gross_collected?: number | null
          id?: string
          inventory_variance?: number | null
          net_profit?: number | null
          opened_at?: string
          opened_by?: string | null
          opening_float?: number
          order_count?: number | null
          payment_snapshot?: Json | null
          restaurant_id: string
          station_snapshot?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          cash_collected?: number | null
          cash_expenses?: number | null
          cash_variance?: number | null
          close_note?: string | null
          closed_at?: string | null
          closed_by?: string | null
          counted_cash?: number | null
          created_at?: string
          day_no?: number
          expected_cash?: number | null
          expense_snapshot?: Json | null
          expenses_total?: number | null
          gross_collected?: number | null
          id?: string
          inventory_variance?: number | null
          net_profit?: number | null
          opened_at?: string
          opened_by?: string | null
          opening_float?: number
          order_count?: number | null
          payment_snapshot?: Json | null
          restaurant_id?: string
          station_snapshot?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "day_sessions_closed_by_fk"
            columns: ["restaurant_id", "closed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "day_sessions_opened_by_fk"
            columns: ["restaurant_id", "opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "day_sessions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          normalized_name: string | null
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          normalized_name?: string | null
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          category_name_snapshot: string | null
          created_at: string
          created_by: string | null
          day_session_id: string | null
          description: string | null
          expense_category_id: string
          expense_date: string
          id: string
          method_affects_drawer_snapshot: boolean | null
          method_name_snapshot: string | null
          payment_method_id: string
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          category_name_snapshot?: string | null
          created_at?: string
          created_by?: string | null
          day_session_id?: string | null
          description?: string | null
          expense_category_id: string
          expense_date: string
          id?: string
          method_affects_drawer_snapshot?: boolean | null
          method_name_snapshot?: string | null
          payment_method_id: string
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          category_name_snapshot?: string | null
          created_at?: string
          created_by?: string | null
          day_session_id?: string | null
          description?: string | null
          expense_category_id?: string
          expense_date?: string
          id?: string
          method_affects_drawer_snapshot?: boolean | null
          method_name_snapshot?: string | null
          payment_method_id?: string
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_category_fk"
            columns: ["restaurant_id", "expense_category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "expenses_created_by_fk"
            columns: ["restaurant_id", "created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "expenses_day_fk"
            columns: ["restaurant_id", "day_session_id"]
            isOneToOne: false
            referencedRelation: "day_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "expenses_method_fk"
            columns: ["restaurant_id", "payment_method_id"]
            isOneToOne: false
            referencedRelation: "payment_methods"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "expenses_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          command: string
          created_at: string
          created_by: string | null
          id: string
          key: string
          request_hash: string | null
          restaurant_id: string
          result: Json | null
        }
        Insert: {
          command: string
          created_at?: string
          created_by?: string | null
          id?: string
          key: string
          request_hash?: string | null
          restaurant_id: string
          result?: Json | null
        }
        Update: {
          command?: string
          created_at?: string
          created_by?: string | null
          id?: string
          key?: string
          request_hash?: string | null
          restaurant_id?: string
          result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_keys_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredients: {
        Row: {
          consumed_today: number
          cost_per_unit: number
          created_at: string
          id: string
          is_active: boolean
          min_level: number
          name: string
          normalized_name: string | null
          opening_stock: number
          received_today: number
          restaurant_id: string
          station_id: string
          stock: number
          unit: string
          updated_at: string
        }
        Insert: {
          consumed_today?: number
          cost_per_unit?: number
          created_at?: string
          id?: string
          is_active?: boolean
          min_level?: number
          name: string
          normalized_name?: string | null
          opening_stock?: number
          received_today?: number
          restaurant_id: string
          station_id: string
          stock?: number
          unit: string
          updated_at?: string
        }
        Update: {
          consumed_today?: number
          cost_per_unit?: number
          created_at?: string
          id?: string
          is_active?: boolean
          min_level?: number
          name?: string
          normalized_name?: string | null
          opening_stock?: number
          received_today?: number
          restaurant_id?: string
          station_id?: string
          stock?: number
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingredients_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ingredients_station_fk"
            columns: ["restaurant_id", "station_id"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      installments: {
        Row: {
          amount: number
          created_at: string
          due_date: string
          id: string
          no: number
          paid: boolean
          paid_at: string | null
          payment_id: string | null
          restaurant_id: string
          updated_at: string
          voucher_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          due_date: string
          id?: string
          no: number
          paid?: boolean
          paid_at?: string | null
          payment_id?: string | null
          restaurant_id: string
          updated_at?: string
          voucher_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          due_date?: string
          id?: string
          no?: number
          paid?: boolean
          paid_at?: string | null
          payment_id?: string | null
          restaurant_id?: string
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "installments_payment_fk"
            columns: ["restaurant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "installments_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installments_voucher_fk"
            columns: ["restaurant_id", "voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      kiosk_devices: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          last_seen_at: string | null
          name: string
          restaurant_id: string
          revoked_at: string | null
          token_hash: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_seen_at?: string | null
          name: string
          restaurant_id: string
          revoked_at?: string | null
          token_hash: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_seen_at?: string | null
          name?: string
          restaurant_id?: string
          revoked_at?: string | null
          token_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "kiosk_devices_created_by_fk"
            columns: ["restaurant_id", "created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "kiosk_devices_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_items: {
        Row: {
          category_id: string
          created_at: string
          description: string | null
          emoji: string | null
          id: string
          image_path: string | null
          is_active: boolean
          name: string
          normalized_name: string | null
          price: number
          restaurant_id: string
          sort_order: number
          station_id: string
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          description?: string | null
          emoji?: string | null
          id?: string
          image_path?: string | null
          is_active?: boolean
          name: string
          normalized_name?: string | null
          price: number
          restaurant_id: string
          sort_order?: number
          station_id: string
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          description?: string | null
          emoji?: string | null
          id?: string
          image_path?: string | null
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          price?: number
          restaurant_id?: string
          sort_order?: number
          station_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_category_fk"
            columns: ["restaurant_id", "category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "menu_items_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_items_station_fk"
            columns: ["restaurant_id", "station_id"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      order_items: {
        Row: {
          created_at: string
          id: string
          item_status: string
          menu_item_id: string
          name_snapshot: string
          note: string | null
          order_id: string
          price_snapshot: number
          qty: number
          ready_at: string | null
          restaurant_id: string
          served_at: string | null
          started_at: string | null
          station_id: string
          station_name_snapshot: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_status?: string
          menu_item_id: string
          name_snapshot: string
          note?: string | null
          order_id: string
          price_snapshot: number
          qty: number
          ready_at?: string | null
          restaurant_id: string
          served_at?: string | null
          started_at?: string | null
          station_id: string
          station_name_snapshot: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          item_status?: string
          menu_item_id?: string
          name_snapshot?: string
          note?: string | null
          order_id?: string
          price_snapshot?: number
          qty?: number
          ready_at?: string | null
          restaurant_id?: string
          served_at?: string | null
          started_at?: string | null
          station_id?: string
          station_name_snapshot?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_menu_fk"
            columns: ["restaurant_id", "menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "order_items_order_fk"
            columns: ["restaurant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "order_items_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_station_fk"
            columns: ["restaurant_id", "station_id"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      orders: {
        Row: {
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_key: string | null
          created_at: string
          created_by: string | null
          created_by_name_snapshot: string | null
          customer_name: string | null
          customer_note: string | null
          customer_phone: string | null
          customer_session_id: string | null
          day_session_id: string
          id: string
          order_no: string
          order_type: string
          payment_status: string
          public_token_hash: string | null
          ready_at: string | null
          restaurant_id: string
          served_at: string | null
          source: string
          station_ids: string[]
          status: string
          stock_consumed: boolean
          subtotal: number
          table_id: string | null
          table_label_snapshot: string | null
          table_session_id: string | null
          total: number
          updated_at: string
          vat_amount: number
          vat_rate_snapshot: number
        }
        Insert: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_key?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name_snapshot?: string | null
          customer_name?: string | null
          customer_note?: string | null
          customer_phone?: string | null
          customer_session_id?: string | null
          day_session_id: string
          id?: string
          order_no: string
          order_type?: string
          payment_status?: string
          public_token_hash?: string | null
          ready_at?: string | null
          restaurant_id: string
          served_at?: string | null
          source?: string
          station_ids?: string[]
          status?: string
          stock_consumed?: boolean
          subtotal: number
          table_id?: string | null
          table_label_snapshot?: string | null
          table_session_id?: string | null
          total: number
          updated_at?: string
          vat_amount: number
          vat_rate_snapshot: number
        }
        Update: {
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_key?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name_snapshot?: string | null
          customer_name?: string | null
          customer_note?: string | null
          customer_phone?: string | null
          customer_session_id?: string | null
          day_session_id?: string
          id?: string
          order_no?: string
          order_type?: string
          payment_status?: string
          public_token_hash?: string | null
          ready_at?: string | null
          restaurant_id?: string
          served_at?: string | null
          source?: string
          station_ids?: string[]
          status?: string
          stock_consumed?: boolean
          subtotal?: number
          table_id?: string | null
          table_label_snapshot?: string | null
          table_session_id?: string | null
          total?: number
          updated_at?: string
          vat_amount?: number
          vat_rate_snapshot?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_cancelled_by_fk"
            columns: ["restaurant_id", "cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "orders_created_by_fk"
            columns: ["restaurant_id", "created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "orders_customer_session_fk"
            columns: ["restaurant_id", "customer_session_id"]
            isOneToOne: false
            referencedRelation: "customer_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "orders_day_fk"
            columns: ["restaurant_id", "day_session_id"]
            isOneToOne: false
            referencedRelation: "day_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "orders_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_table_fk"
            columns: ["restaurant_id", "table_id"]
            isOneToOne: false
            referencedRelation: "tables"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "orders_table_session_fk"
            columns: ["restaurant_id", "table_session_id"]
            isOneToOne: false
            referencedRelation: "table_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      payment_methods: {
        Row: {
          affects_cash_drawer: boolean
          color: string | null
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          normalized_name: string | null
          requires_reference: boolean
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          affects_cash_drawer?: boolean
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          normalized_name?: string | null
          requires_reference?: boolean
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          affects_cash_drawer?: boolean
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          requires_reference?: boolean
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_methods_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          day_session_id: string
          id: string
          installment_no: number | null
          kind: string
          method_affects_drawer_snapshot: boolean
          method_name_snapshot: string
          order_id: string | null
          payment_method_id: string
          receipt_no: string
          reference: string | null
          restaurant_id: string
          reversed_payment_id: string | null
          voucher_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          day_session_id: string
          id?: string
          installment_no?: number | null
          kind: string
          method_affects_drawer_snapshot: boolean
          method_name_snapshot: string
          order_id?: string | null
          payment_method_id: string
          receipt_no: string
          reference?: string | null
          restaurant_id: string
          reversed_payment_id?: string | null
          voucher_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          day_session_id?: string
          id?: string
          installment_no?: number | null
          kind?: string
          method_affects_drawer_snapshot?: boolean
          method_name_snapshot?: string
          order_id?: string | null
          payment_method_id?: string
          receipt_no?: string
          reference?: string | null
          restaurant_id?: string
          reversed_payment_id?: string | null
          voucher_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_created_by_fk"
            columns: ["restaurant_id", "created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "payments_day_fk"
            columns: ["restaurant_id", "day_session_id"]
            isOneToOne: false
            referencedRelation: "day_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "payments_method_fk"
            columns: ["restaurant_id", "payment_method_id"]
            isOneToOne: false
            referencedRelation: "payment_methods"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "payments_order_fk"
            columns: ["restaurant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "payments_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_reversed_fk"
            columns: ["restaurant_id", "reversed_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "payments_voucher_fk"
            columns: ["restaurant_id", "voucher_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      permissions: {
        Row: {
          created_at: string
          description: string
          id: string
          key: string
          module: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          key: string
          module: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          key?: string
          module?: string
          sort_order?: number
        }
        Relationships: []
      }
      plans: {
        Row: {
          created_at: string
          features: Json
          id: string
          is_active: boolean
          max_menu_items: number | null
          max_staff: number | null
          name: string
          price_etb_monthly: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          features?: Json
          id?: string
          is_active?: boolean
          max_menu_items?: number | null
          max_staff?: number | null
          name: string
          price_etb_monthly: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          features?: Json
          id?: string
          is_active?: boolean
          max_menu_items?: number | null
          max_staff?: number | null
          name?: string
          price_etb_monthly?: number
          updated_at?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          full_name: string
          id: string
          is_active: boolean
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id: string
          is_active?: boolean
          role: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          is_active?: boolean
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_invoices: {
        Row: {
          amount: number
          created_at: string
          id: string
          method: string | null
          paid_at: string | null
          period_end: string
          period_start: string
          reference: string | null
          restaurant_id: string
          status: string
          subscription_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          method?: string | null
          paid_at?: string | null
          period_end: string
          period_start: string
          reference?: string | null
          restaurant_id: string
          status: string
          subscription_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          method?: string | null
          paid_at?: string | null
          period_end?: string
          period_start?: string
          reference?: string | null
          restaurant_id?: string
          status?: string
          subscription_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_invoices_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_invoices_subscription_fk"
            columns: ["restaurant_id", "subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      profile_secrets: {
        Row: {
          failed_attempts: number
          locked_until: string | null
          must_change_pin: boolean
          pin_change_pending: boolean
          pin_change_requested_at: string | null
          pin_changed_at: string
          pin_hash: string
          pin_length: number
          profile_id: string
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          failed_attempts?: number
          locked_until?: string | null
          must_change_pin?: boolean
          pin_change_pending?: boolean
          pin_change_requested_at?: string | null
          pin_changed_at?: string
          pin_hash: string
          pin_length?: number
          profile_id: string
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          failed_attempts?: number
          locked_until?: string | null
          must_change_pin?: boolean
          pin_change_pending?: boolean
          pin_change_requested_at?: string | null
          pin_changed_at?: string
          pin_hash?: string
          pin_length?: number
          profile_id?: string
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_secrets_profile_fk"
            columns: ["restaurant_id", "profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "profile_secrets_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_secrets_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          auth_method: string
          created_at: string
          first_name: string
          full_name: string | null
          id: string
          identity_rotation_pending: boolean
          is_active: boolean
          last_name: string | null
          middle_name: string | null
          restaurant_id: string
          role_id: string
          short_name: string | null
          updated_at: string
          username: string
        }
        Insert: {
          auth_method: string
          created_at?: string
          first_name: string
          full_name?: string | null
          id: string
          identity_rotation_pending?: boolean
          is_active?: boolean
          last_name?: string | null
          middle_name?: string | null
          restaurant_id: string
          role_id: string
          short_name?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          auth_method?: string
          created_at?: string
          first_name?: string
          full_name?: string | null
          id?: string
          identity_rotation_pending?: boolean
          is_active?: boolean
          last_name?: string | null
          middle_name?: string | null
          restaurant_id?: string
          role_id?: string
          short_name?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_role_fk"
            columns: ["restaurant_id", "role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      qr_credentials: {
        Row: {
          created_at: string
          id: string
          issued_at: string
          issued_by: string | null
          restaurant_id: string
          revoked_at: string | null
          revoked_by: string | null
          status: string
          table_id: string
          token_hash: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          issued_at?: string
          issued_by?: string | null
          restaurant_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          table_id: string
          token_hash: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          issued_at?: string
          issued_by?: string | null
          restaurant_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          table_id?: string
          token_hash?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "qr_credentials_issued_by_fk"
            columns: ["restaurant_id", "issued_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "qr_credentials_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qr_credentials_revoked_by_fk"
            columns: ["restaurant_id", "revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "qr_credentials_table_fk"
            columns: ["restaurant_id", "table_id"]
            isOneToOne: false
            referencedRelation: "tables"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      recipe_lines: {
        Row: {
          created_at: string
          id: string
          ingredient_id: string
          menu_item_id: string
          qty_per_serving: number
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          ingredient_id: string
          menu_item_id: string
          qty_per_serving: number
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          ingredient_id?: string
          menu_item_id?: string
          qty_per_serving?: number
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_lines_ingredient_fk"
            columns: ["restaurant_id", "ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "recipe_lines_menu_fk"
            columns: ["restaurant_id", "menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "recipe_lines_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_session_settings: {
        Row: {
          idle_warning_seconds: number
          pin_pad_idle_seconds: number
          restaurant_id: string
          signout_seconds: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          idle_warning_seconds?: number
          pin_pad_idle_seconds?: number
          restaurant_id: string
          signout_seconds?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          idle_warning_seconds?: number
          pin_pad_idle_seconds?: number
          restaurant_id?: string
          signout_seconds?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_session_settings_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: true
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restaurant_session_settings_updated_by_fk"
            columns: ["restaurant_id", "updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      restaurants: {
        Row: {
          address: string | null
          auto_consume_stock: boolean
          branding: Json
          created_at: string
          custom_domain: string | null
          id: string
          name: string
          onboarded_at: string | null
          opening_float: number
          phone: string | null
          slug: string
          status: string
          status_before_suspension: string | null
          stock_stepup_threshold: number
          suspended_at: string | null
          suspension_reason: string | null
          timezone: string
          tin: string | null
          updated_at: string
          vat_rate: number
        }
        Insert: {
          address?: string | null
          auto_consume_stock?: boolean
          branding?: Json
          created_at?: string
          custom_domain?: string | null
          id?: string
          name: string
          onboarded_at?: string | null
          opening_float?: number
          phone?: string | null
          slug: string
          status?: string
          status_before_suspension?: string | null
          stock_stepup_threshold?: number
          suspended_at?: string | null
          suspension_reason?: string | null
          timezone?: string
          tin?: string | null
          updated_at?: string
          vat_rate?: number
        }
        Update: {
          address?: string | null
          auto_consume_stock?: boolean
          branding?: Json
          created_at?: string
          custom_domain?: string | null
          id?: string
          name?: string
          onboarded_at?: string | null
          opening_float?: number
          phone?: string | null
          slug?: string
          status?: string
          status_before_suspension?: string | null
          stock_stepup_threshold?: number
          suspended_at?: string | null
          suspension_reason?: string | null
          timezone?: string
          tin?: string | null
          updated_at?: string
          vat_rate?: number
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          created_at: string
          permission_id: string
          restaurant_id: string
          role_id: string
        }
        Insert: {
          created_at?: string
          permission_id: string
          restaurant_id: string
          role_id: string
        }
        Update: {
          created_at?: string
          permission_id?: string
          restaurant_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_fk"
            columns: ["restaurant_id", "role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      role_station_access: {
        Row: {
          created_at: string
          restaurant_id: string
          role_id: string
          station_id: string
        }
        Insert: {
          created_at?: string
          restaurant_id: string
          role_id: string
          station_id: string
        }
        Update: {
          created_at?: string
          restaurant_id?: string
          role_id?: string
          station_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_station_access_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_station_access_role_fk"
            columns: ["restaurant_id", "role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "role_station_access_station_fk"
            columns: ["restaurant_id", "station_id"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      roles: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          is_system: boolean
          name: string
          normalized_name: string | null
          restaurant_id: string
          sort_order: number
          system_key: string | null
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          name: string
          normalized_name?: string | null
          restaurant_id: string
          sort_order?: number
          system_key?: string | null
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          name?: string
          normalized_name?: string | null
          restaurant_id?: string
          sort_order?: number
          system_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "roles_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      stations: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          normalized_name: string | null
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          normalized_name?: string | null
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stations_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          created_at: string
          created_by: string | null
          day_session_id: string | null
          id: string
          ingredient_id: string
          note: string | null
          order_id: string | null
          qty_delta: number
          reason: string
          restaurant_id: string
          reverses_movement_id: string | null
          station_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          day_session_id?: string | null
          id?: string
          ingredient_id: string
          note?: string | null
          order_id?: string | null
          qty_delta: number
          reason: string
          restaurant_id: string
          reverses_movement_id?: string | null
          station_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          day_session_id?: string | null
          id?: string
          ingredient_id?: string
          note?: string | null
          order_id?: string | null
          qty_delta?: number
          reason?: string
          restaurant_id?: string
          reverses_movement_id?: string | null
          station_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_created_by_fk"
            columns: ["restaurant_id", "created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_day_fk"
            columns: ["restaurant_id", "day_session_id"]
            isOneToOne: false
            referencedRelation: "day_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_ingredient_fk"
            columns: ["restaurant_id", "ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_order_fk"
            columns: ["restaurant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_reverses_fk"
            columns: ["restaurant_id", "reverses_movement_id"]
            isOneToOne: false
            referencedRelation: "stock_movements"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_station_fk"
            columns: ["restaurant_id", "station_id"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string
          current_period_start: string
          id: string
          plan_id: string
          restaurant_id: string
          status: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end: string
          current_period_start?: string
          id?: string
          plan_id: string
          restaurant_id: string
          status: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string
          current_period_start?: string
          id?: string
          plan_id?: string
          restaurant_id?: string
          status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: true
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      table_areas: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          normalized_name: string | null
          restaurant_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          normalized_name?: string | null
          restaurant_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          restaurant_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "table_areas_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      table_sessions: {
        Row: {
          closed_at: string | null
          created_at: string
          day_session_id: string | null
          expires_at: string | null
          guest_count: number | null
          id: string
          opened_at: string
          opened_by: string | null
          restaurant_id: string
          status: string
          table_id: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          day_session_id?: string | null
          expires_at?: string | null
          guest_count?: number | null
          id?: string
          opened_at?: string
          opened_by?: string | null
          restaurant_id: string
          status?: string
          table_id: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          day_session_id?: string | null
          expires_at?: string | null
          guest_count?: number | null
          id?: string
          opened_at?: string
          opened_by?: string | null
          restaurant_id?: string
          status?: string
          table_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "table_sessions_day_fk"
            columns: ["restaurant_id", "day_session_id"]
            isOneToOne: false
            referencedRelation: "day_sessions"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "table_sessions_opened_by_fk"
            columns: ["restaurant_id", "opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "table_sessions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "table_sessions_table_fk"
            columns: ["restaurant_id", "table_id"]
            isOneToOne: false
            referencedRelation: "tables"
            referencedColumns: ["restaurant_id", "id"]
          },
        ]
      }
      tables: {
        Row: {
          capacity: number
          created_at: string
          id: string
          is_active: boolean
          label: string
          normalized_label: string | null
          qr_enabled: boolean
          restaurant_id: string
          sort_order: number
          status: string
          table_area_id: string
          updated_at: string
        }
        Insert: {
          capacity?: number
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          normalized_label?: string | null
          qr_enabled?: boolean
          restaurant_id: string
          sort_order?: number
          status?: string
          table_area_id: string
          updated_at?: string
        }
        Update: {
          capacity?: number
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          normalized_label?: string | null
          qr_enabled?: boolean
          restaurant_id?: string
          sort_order?: number
          status?: string
          table_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tables_area_fk"
            columns: ["restaurant_id", "table_area_id"]
            isOneToOne: false
            referencedRelation: "table_areas"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "tables_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_counters: {
        Row: {
          counter_key: string
          last_value: number
          restaurant_id: string
          updated_at: string
        }
        Insert: {
          counter_key: string
          last_value?: number
          restaurant_id: string
          updated_at?: string
        }
        Update: {
          counter_key?: string
          last_value?: number
          restaurant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_counters_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      user_notifications: {
        Row: {
          created_at: string
          id: string
          kind: string
          payload: Json
          read_at: string | null
          recipient_id: string
          restaurant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          payload?: Json
          read_at?: string | null
          recipient_id: string
          restaurant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          payload?: Json
          read_at?: string | null
          recipient_id?: string
          restaurant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_notifications_recipient_fk"
            columns: ["restaurant_id", "recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "user_notifications_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      vouchers: {
        Row: {
          created_at: string
          created_by: string | null
          customer_name: string
          customer_phone: string | null
          down_payment: number
          down_payment_method_id: string | null
          id: string
          installment_count: number
          interval_days: number
          order_id: string
          restaurant_id: string
          total: number
          updated_at: string
          voucher_no: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_name: string
          customer_phone?: string | null
          down_payment?: number
          down_payment_method_id?: string | null
          id?: string
          installment_count: number
          interval_days: number
          order_id: string
          restaurant_id: string
          total: number
          updated_at?: string
          voucher_no: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_name?: string
          customer_phone?: string | null
          down_payment?: number
          down_payment_method_id?: string | null
          id?: string
          installment_count?: number
          interval_days?: number
          order_id?: string
          restaurant_id?: string
          total?: number
          updated_at?: string
          voucher_no?: string
        }
        Relationships: [
          {
            foreignKeyName: "vouchers_created_by_fk"
            columns: ["restaurant_id", "created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "vouchers_down_method_fk"
            columns: ["restaurant_id", "down_payment_method_id"]
            isOneToOne: false
            referencedRelation: "payment_methods"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "vouchers_order_fk"
            columns: ["restaurant_id", "order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["restaurant_id", "id"]
          },
          {
            foreignKeyName: "vouchers_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_restaurant_id: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      current_role_id: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      current_station_ids: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      current_tenant_writable: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      current_user_id: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      fn_active_session_window: {
        Args: Record<PropertyKey, never>
        Returns: unknown
      }
      fn_adjust_stock: {
        Args: {
          p_ingredient_id: string
          p_qty_delta: number
          p_reason: string
          p_idempotency_key: string
        }
        Returns: Json
      }
      fn_apply_recipe_consumption: {
        Args: { p_order_id: string; p_menu_item_id: string; p_qty: number }
        Returns: number
      }
      fn_approve_pin_change: {
        Args: { p_profile_id: string }
        Returns: Json
      }
      fn_auth_password_verification_hook: {
        Args: { event: Json }
        Returns: Json
      }
      fn_caller_covers_role: {
        Args: { p_role_id: string }
        Returns: boolean
      }
      fn_change_user_role: {
        Args: { p_profile_id: string; p_role_id: string }
        Returns: Json
      }
      fn_check_idempotency_key: {
        Args: { p_key: string }
        Returns: undefined
      }
      fn_complete_forced_pin_change: {
        Args: {
          p_profile_id: string
          p_pin_digest: string
          p_pin_length?: number
        }
        Returns: Json
      }
      fn_complete_identity_rotation: {
        Args: { p_profile_id: string }
        Returns: Json
      }
      fn_create_ingredient: {
        Args: {
          p_name: string
          p_station_id: string
          p_unit: string
          p_min_level?: number
          p_cost_per_unit?: number
          p_initial_stock?: number
        }
        Returns: Json
      }
      fn_create_menu_item: {
        Args: {
          p_name: string
          p_category_id: string
          p_station_id: string
          p_price: number
          p_description?: string
          p_emoji?: string
          p_image_path?: string
          p_sort_order?: number
        }
        Returns: Json
      }
      fn_create_staff_profile: {
        Args: {
          p_auth_user_id: string
          p_first_name: string
          p_middle_name: string
          p_last_name: string
          p_username: string
          p_role_id: string
        }
        Returns: Json
      }
      fn_decide_pin_change: {
        Args: { p_profile_id: string; p_approve: boolean }
        Returns: Json
      }
      fn_err: {
        Args: { p_code: string; p_detail?: string }
        Returns: undefined
      }
      fn_get_open_day: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      fn_get_restaurant_settings: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      fn_get_session_context: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      fn_get_session_timers: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      fn_idempotency_begin: {
        Args: { p_key: string; p_command: string; p_request_hash: string }
        Returns: Json
      }
      fn_idempotency_complete: {
        Args: { p_key: string; p_command: string; p_result: Json }
        Returns: undefined
      }
      fn_ingredient_json: {
        Args: { p_id: string }
        Returns: Json
      }
      fn_kiosk_context: {
        Args: { p_token_hash: string; p_slug: string; p_touch?: boolean }
        Returns: string
      }
      fn_kiosk_roster: {
        Args: { p_token_hash: string; p_slug: string }
        Returns: Json
      }
      fn_kiosk_terminal_bootstrap: {
        Args: { p_token_hash: string; p_slug: string }
        Returns: Json
      }
      fn_kiosk_tile_eligible: {
        Args: { p_token_hash: string; p_slug: string; p_profile_id: string }
        Returns: boolean
      }
      fn_list_kiosks: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      fn_list_pending_pin_changes: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      fn_list_stock_movements: {
        Args: {
          p_ingredient_id?: string
          p_limit?: number
          p_before?: string
          p_before_id?: string
        }
        Returns: Json
      }
      fn_mark_notification_read: {
        Args: { p_id: string }
        Returns: Json
      }
      fn_menu_check_image: {
        Args: { p_rid: string; p_path: string }
        Returns: undefined
      }
      fn_menu_check_refs: {
        Args: { p_rid: string; p_category_id: string; p_station_id: string }
        Returns: undefined
      }
      fn_menu_item_json: {
        Args: { p_id: string }
        Returns: Json
      }
      fn_next_number: {
        Args: {
          p_restaurant_id: string
          p_key: string
          p_prefix: string
          p_pad?: number
        }
        Returns: string
      }
      fn_pin_eligible: {
        Args: { p_profile_id: string }
        Returns: boolean
      }
      fn_pin_length_for_role: {
        Args: { p_role_id: string }
        Returns: number
      }
      fn_pin_length_for_role_name: {
        Args: { p_name: string }
        Returns: number
      }
      fn_pin_lock_duration: {
        Args: { p_failed: number }
        Returns: unknown
      }
      fn_pin_restricted: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      fn_platform_mfa_satisfied: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      fn_post_stock_movement: {
        Args: {
          p_rid: string
          p_ingredient_id: string
          p_delta: number
          p_reason: string
          p_note: string
          p_order_id?: string
          p_reverses?: string
        }
        Returns: Json
      }
      fn_prepare_staff_creation: {
        Args: { p_username: string; p_role_id: string }
        Returns: Json
      }
      fn_provision_tenant: {
        Args: {
          p_name: string
          p_slug: string
          p_owner_user_id: string
          p_owner_email: string
          p_owner_first_name: string
          p_owner_middle_name: string
          p_owner_last_name: string
          p_plan_id: string
          p_owner_username?: string
          p_require_confirmed?: boolean
        }
        Returns: Json
      }
      fn_reactivate_tenant: {
        Args: { p_restaurant_id: string; p_reason: string }
        Returns: Json
      }
      fn_receive_stock: {
        Args: {
          p_ingredient_id: string
          p_qty: number
          p_idempotency_key: string
          p_note?: string
        }
        Returns: Json
      }
      fn_register_kiosk: {
        Args: { p_name: string }
        Returns: Json
      }
      fn_register_pin_failure: {
        Args: { p_profile_id: string }
        Returns: Json
      }
      fn_reject_pin_change: {
        Args: { p_profile_id: string }
        Returns: Json
      }
      fn_require_aal2: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      fn_require_step_up: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      fn_reset_pin_lockout: {
        Args: { p_profile_id: string }
        Returns: Json
      }
      fn_reset_session_timers: {
        Args: Record<PropertyKey, never>
        Returns: Json
      }
      fn_resolve_tenant_slug: {
        Args: { p_slug: string }
        Returns: Json
      }
      fn_reverse_order_consumption: {
        Args: { p_order_id: string }
        Returns: number
      }
      fn_reverse_stock_movement: {
        Args: {
          p_movement_id: string
          p_reason: string
          p_idempotency_key: string
        }
        Returns: Json
      }
      fn_revoke_kiosk: {
        Args: { p_kiosk_id: string }
        Returns: Json
      }
      fn_seed_tenant_defaults: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      fn_session_timers_json: {
        Args: { p_restaurant_id: string }
        Returns: Json
      }
      fn_set_ingredient_active: {
        Args: { p_ingredient_id: string; p_active: boolean }
        Returns: Json
      }
      fn_set_menu_item_active: {
        Args: { p_menu_item_id: string; p_active: boolean }
        Returns: Json
      }
      fn_set_recipe: {
        Args: { p_menu_item_id: string; p_lines: Json }
        Returns: Json
      }
      fn_set_stock_stepup_threshold: {
        Args: { p_threshold: number }
        Returns: Json
      }
      fn_set_user_pin: {
        Args: {
          p_profile_id: string
          p_pin_digest: string
          p_pin_length?: number
        }
        Returns: undefined
      }
      fn_slug_is_reserved: {
        Args: { p_slug: string }
        Returns: boolean
      }
      fn_staff_email: {
        Args: { p_username: string; p_slug: string }
        Returns: string
      }
      fn_staff_has_active_session: {
        Args: { p_profile_id: string }
        Returns: boolean
      }
      fn_staff_login_blocked: {
        Args: { p_profile_id: string; p_kiosk_token_hash?: string }
        Returns: Json
      }
      fn_staff_precheck: {
        Args: { p_rid: string; p_username: string; p_role_id: string }
        Returns: string
      }
      fn_stock_day: {
        Args: { p_rid: string }
        Returns: string
      }
      fn_stock_step_up: {
        Args: { p_rid: string; p_qty: number; p_cost: number }
        Returns: undefined
      }
      fn_stock_stepup_threshold: {
        Args: { p_rid: string }
        Returns: number
      }
      fn_store_session_timers: {
        Args: {
          p_idle_warning_seconds: number
          p_signout_seconds: number
          p_pin_pad_idle_seconds: number
          p_reset: boolean
        }
        Returns: Json
      }
      fn_suspend_tenant: {
        Args: { p_restaurant_id: string; p_reason: string }
        Returns: Json
      }
      fn_tenant_status_guard: {
        Args: { p_write?: boolean }
        Returns: string
      }
      fn_update_ingredient: {
        Args: { p_ingredient_id: string; p_patch: Json }
        Returns: Json
      }
      fn_update_menu_item: {
        Args: { p_menu_item_id: string; p_patch: Json }
        Returns: Json
      }
      fn_update_role_permissions: {
        Args: {
          p_role_id: string
          p_permission_keys: string[]
          p_station_ids: string[]
        }
        Returns: Json
      }
      fn_update_session_timers: {
        Args: {
          p_idle_warning_seconds: number
          p_signout_seconds: number
          p_pin_pad_idle_seconds: number
        }
        Returns: Json
      }
      fn_user_auth_method: {
        Args: { p_user_id: string }
        Returns: string
      }
      fn_verify_pin: {
        Args: { p_profile_id: string; p_pin_digest: string }
        Returns: Json
      }
      fn_write_admin_audit: {
        Args: { p_action: string; p_restaurant_id: string; p_detail?: Json }
        Returns: undefined
      }
      fn_write_audit: {
        Args: { p_event: string; p_record?: Json; p_restaurant_id?: string }
        Returns: undefined
      }
      has_permission: {
        Args: { p_key: string }
        Returns: boolean
      }
      has_station_access: {
        Args: { p_station_id: string }
        Returns: boolean
      }
      is_order_owner: {
        Args: { p_order_id: string }
        Returns: boolean
      }
      is_platform_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_platform_super_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_service_role: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      is_tenant_admin: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
