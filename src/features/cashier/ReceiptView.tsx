import { formatEtb } from '@/lib/domain/decimal'
import { formatEthiopianDateTime, formatInternationalDateTime } from '@/lib/domain/ethiopian-time'
import type { Receipt } from '@/lib/supabase/payments'

/**
 * The printable receipt, rendered from the server's receipt document (fn_confirm_payment / fn_get_receipt). Every value is
 * text in React (no HTML injection); amounts come from the server. Dates show the Ethiopian calendar and clock (Arabic numerals)
 * and the international time, in the restaurant's time zone.
 */
export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const tz = receipt.restaurant?.timezone ?? 'Africa/Addis_Ababa'
  const o = receipt.order
  const isReversal = receipt.kind === 'reversal'
  return (
    <article
      aria-label={`Receipt ${receipt.receipt_no}`}
      className="receipt-print mx-auto w-full max-w-sm bg-white p-4 font-mono text-sm text-ink"
    >
      <header className="text-center">
        <p className="text-base font-semibold">{receipt.restaurant?.name}</p>
        {receipt.restaurant?.address && <p>{receipt.restaurant.address}</p>}
        {receipt.restaurant?.phone && <p>Tel: {receipt.restaurant.phone}</p>}
        {receipt.restaurant?.tin && <p>TIN: {receipt.restaurant.tin}</p>}
      </header>
      <hr className="my-2 border-dashed border-line" />
      {isReversal && <p className="text-center font-semibold uppercase">Payment reversal</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3">
        <dt>Receipt</dt>
        <dd className="text-right">{receipt.receipt_no}</dd>
        {o && (
          <>
            <dt>Order</dt>
            <dd className="text-right">{o.order_no}</dd>
            {o.table_label && (
              <>
                <dt>Table</dt>
                <dd className="text-right">{o.table_label}</dd>
              </>
            )}
          </>
        )}
        <dt>Date</dt>
        <dd className="text-right font-amharic">{formatEthiopianDateTime(receipt.created_at, tz)}</dd>
        <dt className="sr-only">International time</dt>
        <dd className="col-span-2 text-right text-xs text-muted-foreground">
          {formatInternationalDateTime(receipt.created_at, tz)}
        </dd>
      </dl>
      {o && !isReversal && (
        <>
          <hr className="my-2 border-dashed border-line" />
          <table className="w-full">
            <caption className="sr-only">Items</caption>
            <thead>
              <tr className="text-left text-xs">
                <th scope="col">Item</th>
                <th scope="col" className="text-right">
                  Qty
                </th>
                <th scope="col" className="text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((l, i) => (
                <tr key={`${l.name}-${i}`}>
                  <td className="break-words pr-2">{l.name}</td>
                  <td className="text-right">{l.qty}</td>
                  <td className="text-right">{formatEtb(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <hr className="my-2 border-dashed border-line" />
          <dl className="grid grid-cols-[1fr_auto] gap-x-3">
            <dt>Subtotal</dt>
            <dd className="text-right">{formatEtb(o.subtotal)}</dd>
            <dt>VAT ({o.vat_rate}%)</dt>
            <dd className="text-right">{formatEtb(o.vat_amount)}</dd>
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold">{formatEtb(o.total)}</dd>
          </dl>
        </>
      )}
      <hr className="my-2 border-dashed border-line" />
      <dl className="grid grid-cols-[1fr_auto] gap-x-3">
        <dt>
          {isReversal ? 'Refunded' : 'Paid'} ({receipt.method})
        </dt>
        <dd className="text-right font-semibold">{formatEtb(receipt.amount)}</dd>
        {receipt.reference && (
          <>
            <dt>{isReversal ? 'Reason' : 'Reference'}</dt>
            <dd className="break-all text-right">{receipt.reference}</dd>
          </>
        )}
        {receipt.tendered != null && (
          <>
            <dt>Received</dt>
            <dd className="text-right">{formatEtb(receipt.tendered)}</dd>
            <dt>Change</dt>
            <dd className="text-right">{formatEtb(receipt.change ?? 0)}</dd>
          </>
        )}
        {receipt.received_by && (
          <>
            <dt>Cashier</dt>
            <dd className="text-right">{receipt.received_by}</dd>
          </>
        )}
      </dl>
      {receipt.reversed && !isReversal && (
        <p className="mt-2 text-center font-semibold uppercase text-status-cancelled">Reversed</p>
      )}
      <p className="mt-3 text-center text-xs">Thank you</p>
    </article>
  )
}
