import { useCallback, useEffect, useState } from 'react';
import api from '../../services/api';
import toast from 'react-hot-toast';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const PAYMENT_STATUS = {
  PENDING: 'bg-gray-100 text-gray-600',
  CREATED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-emerald-100 text-emerald-700',
  SUCCESS: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  REFUNDED: 'bg-orange-100 text-orange-700',
};

const PAYOUT_STATUS = {
  PENDING: 'bg-yellow-100 text-yellow-700',
  PROCESSING: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

export default function AdminPayments() {
  const [overview, setOverview] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [payments, setPayments] = useState([]);
  const [compensations, setCompensations] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState('');

  const reload = useCallback(async () => {
    try {
      const [ov, po, co] = await Promise.all([
        api.get('/admin/payments/overview'),
        api.get('/admin/payouts'),
        api.get('/admin/payments/compensations'),
      ]);
      setOverview(ov.data?.overview || {});
      setPayouts(po.data || []);
      setCompensations(co.data || []);
    } catch (err) {
      toast.error(err.message || 'Could not load payments');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPayments = useCallback(async () => {
    try {
      const res = await api.get(`/admin/payments${filter ? `?status=${filter}` : ''}`);
      setPayments(res.data || []);
    } catch { /* non-fatal */ }
  }, [filter]);

  useEffect(() => {
    reload();
    loadPayments();
  }, [reload, loadPayments]);

  const updatePayout = async (id, body, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setActing(id);
    try {
      await api.put(`/admin/payouts/${id}/status`, body);
      toast.success('Payout updated');
      reload();
    } catch (err) {
      toast.error(err.message || 'Could not update payout');
    } finally {
      setActing('');
    }
  };

  const processPayout = (p) => updatePayout(p._id, { status: 'PROCESSING' }, 'Mark this withdrawal as being processed?');
  const completePayout = (p) => {
    const txRef = window.prompt('Transaction / UTR reference (optional):') || '';
    updatePayout(p._id, { status: 'COMPLETED', transactionReference: txRef }, 'Confirm payout completed? Funds are marked as paid out to the worker.');
  };
  const failPayout = (p) => {
    const reason = window.prompt('Failure reason (shown to the worker):') || 'Could not process payout';
    updatePayout(p._id, { status: 'FAILED', failureReason: reason }, 'Mark this payout as failed? Held funds return to the worker.');
  };
  const cancelPayout = (p) => updatePayout(p._id, { status: 'CANCELLED' }, 'Cancel this withdrawal? This is only allowed while it is pending.');

  if (loading) {
    return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600"></div></div>;
  }

  const StatCard = ({ label, value, sub, cls }) => (
    <div className="card">
      <p className="text-sm text-gray-500 font-medium">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${cls || ''}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-900">Payments &amp; Payouts</h2>

      {/* ── Overview ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Collected" value={inr(overview.totalCollected)} sub={`${overview.paidPaymentsCount || 0} payments`} cls="text-emerald-700" />
        <StatCard label="Platform Revenue" value={inr(overview.platformRevenue)} sub="5% service fee" cls="text-brand-700" />
        <StatCard label="Worker Earnings Paid" value={inr(overview.workerEarnings)} sub="Held in worker wallets" cls="text-blue-700" />
        <StatCard label="Refunds" value={inr(overview.refunds)} sub={`${overview.refundCount || 0} refunded`} cls="text-orange-600" />
        <StatCard label="Pending Payouts" value={inr(overview.pendingPayouts)} sub={`${overview.pendingPayoutCount || 0} awaiting review`} cls="text-yellow-700" />
        <StatCard label="Completed Payouts" value={inr(overview.completedPayouts)} sub="Paid out to workers" cls="text-emerald-700" />
        <StatCard label="Worker Compensation Paid" value={inr(overview.workerCompensationPaid)} sub={`${overview.workerCompensationCount || 0} credits from cancellations`} cls="text-violet-700" />
        <StatCard label="Paid Bookings" value={overview.paidBookings || 0} sub="Bookings PAID" />
        <StatCard label="Failed Payments" value={overview.failedCount || 0} sub="Retry / investigate" cls="text-red-600" />
      </div>

      {/* ── Payments table ── */}
      <div className="card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold">Payments</h3>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="input-field w-auto text-sm py-1.5">
            <option value="">All statuses</option>
            {Object.keys(PAYMENT_STATUS).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-5 py-3">Customer</th>
                <th className="px-5 py-3">Booking</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3 text-right">Fee</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.length === 0 && (
                <tr><td colSpan="6" className="px-5 py-8 text-center text-gray-400">No payments found</td></tr>
              )}
              {payments.slice(0, 100).map((p) => (
                <tr key={p._id} className="hover:bg-gray-50/60">
                  <td className="px-5 py-3">{p.customer?.email || '—'}</td>
                  <td className="px-5 py-3 text-gray-500">{p.booking?.bookingNumber || '—'}</td>
                  <td className="px-5 py-3 text-gray-500">{p.paidAt || p.createdAt ? new Date(p.paidAt || p.createdAt).toLocaleDateString() : '—'}</td>
                  <td className="px-5 py-3 text-right font-bold">{inr(p.amount)}</td>
                  <td className="px-5 py-3 text-right text-gray-500">{inr(p.platformFee)}</td>
                  <td className="px-5 py-3"><span className={`badge ${PAYMENT_STATUS[p.status] || 'bg-gray-100 text-gray-600'}`}>{p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Compensation transfers (cancellation travel compensation) ── */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold">Worker Compensation Transfers</h3>
          <p className="text-xs text-gray-400 mt-0.5">Travel compensation credited to workers when a customer cancels after the worker set out.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-5 py-3">Worker</th>
                <th className="px-5 py-3">Booking</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {compensations.length === 0 && (
                <tr><td colSpan="4" className="px-5 py-8 text-center text-gray-400">No compensation transfers yet</td></tr>
              )}
              {compensations.map((c) => (
                <tr key={c._id} className="hover:bg-gray-50/60">
                  <td className="px-5 py-3">
                    {c.worker?.user?.name || c.worker?.user?.email || c.worker?._id?.toString().slice(0, 8) || '—'}
                  </td>
                  <td className="px-5 py-3 text-gray-500">
                    {c.booking ? `${c.booking.bookingNumber}${c.booking.serviceSnapshot?.name ? ` • ${c.booking.serviceSnapshot.name}` : ''}` : '—'}
                  </td>
                  <td className="px-5 py-3 text-gray-500">{new Date(c.createdAt || c.updatedAt).toLocaleString()}</td>
                  <td className="px-5 py-3 text-right font-bold text-violet-700">{inr(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Payouts (worker withdrawals) ── */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold">Withdrawal Requests (Payouts)</h3>
          <p className="text-xs text-gray-400 mt-0.5">Review worker withdrawals. Funds are held from the worker&apos;s balance until paid out.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-5 py-3">Payout</th>
                <th className="px-5 py-3">Worker</th>
                <th className="px-5 py-3">Method</th>
                <th className="px-5 py-3">Requested</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payouts.length === 0 && (
                <tr><td colSpan="7" className="px-5 py-8 text-center text-gray-400">No withdrawal requests</td></tr>
              )}
              {payouts.map((p) => (
                <tr key={p._id} className="hover:bg-gray-50/60">
                  <td className="px-5 py-3 font-medium">{p.payoutNumber}</td>
                  <td className="px-5 py-3">
                    {p.payoutMethodId?.accountHolderName || 'Worker'}
                    <span className="block text-[10px] text-gray-400">{p.payoutNumber}</span>
                  </td>
                  <td className="px-5 py-3 text-gray-500">
                    {p.payoutMethodId ? `${p.payoutMethodId.type === 'BANK' ? 'Bank • ' : 'UPI • '}${p.payoutMethodId.type === 'BANK' ? p.payoutMethodId.accountNumber : p.payoutMethodId.upiId}` : '—'}
                  </td>
                  <td className="px-5 py-3 text-gray-500">{new Date(p.requestedAt).toLocaleString()}</td>
                  <td className="px-5 py-3 text-right font-bold">{inr(p.amount)}</td>
                  <td className="px-5 py-3"><span className={`badge ${PAYOUT_STATUS[p.status] || 'bg-gray-100 text-gray-600'}`}>{p.status}</span></td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {p.status === 'PENDING' && (
                        <>
                          <button onClick={() => processPayout(p)} disabled={!!acting} className="btn-primary text-[11px] px-2 py-1">Process</button>
                          <button onClick={() => cancelPayout(p)} disabled={!!acting} className="btn-secondary text-[11px] px-2 py-1">Cancel</button>
                        </>
                      )}
                      {p.status === 'PROCESSING' && (
                        <>
                          <button onClick={() => completePayout(p)} disabled={!!acting} className="btn-success text-[11px] px-2 py-1">Complete</button>
                          <button onClick={() => failPayout(p)} disabled={!!acting} className="btn-danger text-[11px] px-2 py-1">Fail</button>
                        </>
                      )}
                    </div>
                    {p.status === 'COMPLETED' && p.transactionReference && (
                      <span className="text-[10px] text-gray-400">Ref: {p.transactionReference}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}