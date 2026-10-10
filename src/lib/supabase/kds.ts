import { z } from 'zod'
import type { KdsLine } from '@/lib/domain/kds'
import { supabase } from './client'
import { callRpc } from './rpc'
import { uuid } from './schemas'

// Station display (Phase 5). Reads are RLS-scoped (order_items_select: orders.view + station access); writes go through
// fn_set_station_items_status (start / ready for THIS station's lines). Realtime on order_items, filtered by the station id
// (RLS still applies to every event).

export const kdsKey = (rid: string, stationId: string) => ['kds', rid, stationId] as const

const rowSchema = z.object({
  id: uuid,
  order_id: uuid,
  line_no: z.number().nullable(),
  name_snapshot: z.string(),
  qty: z.number().int(),
  note: z.string().nullable(),
  item_status: z.enum(['pending', 'preparing', 'ready']),
  orders: z.object({
    order_no: z.string(),
    table_label_snapshot: z.string().nullable(),
    order_type: z.string(),
    status: z.string(),
    created_at: z.string(),
  }),
})

/** The open (pending / preparing / ready) lines of one station, with their order header. */
export async function fetchStationLines(stationId: string): Promise<KdsLine[]> {
  const { data, error } = await supabase
    .from('order_items')
    .select('id,order_id,line_no,name_snapshot,qty,note,item_status,orders!inner(order_no,table_label_snapshot,order_type,status,created_at)')
    .eq('station_id', stationId)
    .in('item_status', ['pending', 'preparing', 'ready'])
    .not('orders.status', 'in', '(cancelled,served)')
    .order('created_at', { ascending: true })
    .limit(300)
  if (error) throw new Error('kds_unavailable')
  return z
    .array(rowSchema)
    .parse(data ?? [])
    .map((r) => ({
      id: r.id,
      orderId: r.order_id,
      orderNo: r.orders.order_no,
      tableLabel: r.orders.table_label_snapshot,
      orderType: r.orders.order_type,
      orderCreatedAt: r.orders.created_at,
      lineNo: r.line_no,
      name: r.name_snapshot,
      qty: r.qty,
      note: r.note,
      status: r.item_status,
    }))
}

/** Start ("preparing") or finish ("ready") this station's lines of an order; the server rolls up the order status. */
export async function setStationStatus(orderId: string, stationId: string, status: 'preparing' | 'ready'): Promise<void> {
  z.object({ id: uuid }).passthrough().parse(
    await callRpc('fn_set_station_items_status', { p_order_id: orderId, p_station_id: stationId, p_status: status }),
  )
}

/**
 * Realtime for one station: `onInsert` for a new line (an order was fired to this station: the sound), `onChange` for any
 * change. RLS filters every event to what the user may read.
 */
export function subscribeToStation(stationId: string, handlers: { onInsert: () => void; onChange: () => void }): () => void {
  const channel = supabase
    .channel(`kds-${stationId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_items', filter: `station_id=eq.${stationId}` }, () => {
      handlers.onInsert()
      handlers.onChange()
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'order_items', filter: `station_id=eq.${stationId}` }, handlers.onChange)
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}
