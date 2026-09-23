import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import toast from 'react-hot-toast';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function Earnings() {
  const { t } = useTranslation();
  const [wallet, setWallet] = useState(null);
  const [methods, setMethods] = useState([]);
  const [legacy, setLegacy] = useState({ summary: {}, payments: [] });
  const [loading, setLoading] = useState(true);

  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawForm, setWithdrawForm] = useState({ amount: '', payoutMethodId: '' });

  const [methodForm, setMethodForm] = useState({ type: 'BANK', accountHolderName: '', accountNumber: '', ifsc: '', upiId: '' });
  const [addingMethod, setAddingMethod] = useState(false);

  const payoutStatusLabel = (s) => ({
    PENDING: t('wallet.awaitingReview'),
    PROCESSING: t('wallet.processing'),
    COMPLETED: t('wallet.paidOut'),
    FAILED: t('common.cancelled'),
    CANCELLED: t('common.cancelled'),
  }[s] || s);

  const payoutStatusCls = (s) => ({
    PENDING: 'bg-yellow-100 text-yellow-700',
    PROCESSING: 'bg-blue-100 text-blue-700',
    COMPLETED: 'bg-emerald-100 text-emerald-700',
    FAILED: 'bg-red-100 text-red-700',
    CANCELLED: 'bg-gray-100 text-gray-600',
  }[s] || 'bg-gray-100 text-gray-600');

  const txnStatusCls = (s) => ({
    PENDING: 'bg-yellow-100 text-yellow-700',
    COMPLETED: 'bg-emerald-100 text-emerald-700',
    FAILED: 'bg-red-100 text-red-700',
    REVERSED: 'bg-gray-100 text-gray-600',
  }[s] || 'bg-gray-100 text-gray-600');

  const reload = useCallback(async () => {
    try {
      const [w, m, e] = await Promise.all([
        api.get('/wallet'),
        api.get('/wallet/payout-methods'),
        api.get('/workers/earnings'),
      ]);
      setWallet(w.data);
      setMethods(m.data || []);
      setLegacy(e.data || { summary: {}, payments: [] });
    } catch (err) {
      toast.error(err.message || t('wallet.couldNotLoad'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const summary = wallet?.summary || {};
  const transactions = wallet?.transactions || [];
  const payouts = wallet?.payouts || [];
  const legacySummary = legacy.summary || {};
  const payments = legacy.payments || [];

  const handleWithdraw = async (e) => {
    e.preventDefault();
    if (!withdrawForm.amount || Number(withdrawForm.amount) <= 0) {
      toast.error(t('wallet.enterAmountError'));
      return;
    }
    if (Number(withdrawForm.amount) > summary.availableBalance) {
      toast.error(t('wallet.exceedsBalance'));
      return;
    }
    try {
      setWithdrawing(true);
      await api.post('/wallet/payouts', {
        amount: Number(withdrawForm.amount),
        payoutMethodId: withdrawForm.payoutMethodId || undefined,
      });
      toast.success(t('wallet.withdrawalRequested'));
      setWithdrawOpen(false);
      setWithdrawForm({ amount: '', payoutMethodId: '' });
      reload();
    } catch (err) {
      toast.error(err.message || t('wallet.withdrawalFailed'));
    } finally {
      setWithdrawing(false);
    }
  };

  const handleAddMethod = async (e) => {
    e.preventDefault();
    try {
      setAddingMethod(true);
      await api.post('/wallet/payout-methods', methodForm);
      toast.success(t('wallet.methodAdded'));
      setMethodForm({ type: 'BANK', accountHolderName: '', accountNumber: '', ifsc: '', upiId: '' });
      reload();
    } catch (err) {
      toast.error(err.message || t('wallet.couldNotAddMethod'));
    } finally {
      setAddingMethod(false);
    }
  };

  const handleDeleteMethod = async (id) => {
    if (!window.confirm(t('wallet.removeMethodConfirm'))) return;
    try {
      await api.delete(`/wallet/payout-methods/${id}`);
      toast.success(t('wallet.methodRemoved'));
      reload();
    } catch (err) {
      toast.error(err.message || t('wallet.couldNotRemoveMethod'));
    }
  };

  if (loading) {
    return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600"></div></div>;
  }

  const chartData = payments.slice(0, 10).map((p, i) => ({
    name: p.booking?.serviceSnapshot?.name || `${t('wallet.job')} ${i + 1}`,
    gross: p.workerGross || p.amount,
    net: p.workerNetEarnings || p.amount,
  }));

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-900">{t('wallet.title')}</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-green-50 border-green-200">
          <p className="text-sm text-green-700 font-medium">{t('wallet.availableBalance')}</p>
          <p className="text-2xl font-bold text-green-800 mt-1">{inr(summary.availableBalance)}</p>
          <p className="text-xs text-green-600 mt-1">{t('wallet.readyToWithdraw')}</p>
        </div>
        <div className="card bg-yellow-50 border-yellow-200">
          <p className="text-sm text-yellow-700 font-medium">{t('wallet.pendingRelease')}</p>
          <p className="text-2xl font-bold text-yellow-800 mt-1">{inr(summary.pendingBalance)}</p>
          <p className="text-xs text-yellow-600 mt-1">{t('wallet.releasedOnComplete')}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-600 font-medium">{t('wallet.lifetimeEarnings')}</p>
          <p className="text-2xl font-bold mt-1">{inr(summary.totalEarned)}</p>
          <p className="text-xs text-gray-400 mt-1">{t('wallet.netAfterFees')}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-600 font-medium">{t('wallet.totalWithdrawn')}</p>
          <p className="text-2xl font-bold mt-1">{inr(summary.totalWithdrawn)}</p>
          <p className="text-xs text-gray-400 mt-1">{t('wallet.lifetimePayouts')}</p>
        </div>
      </div>

      {summary.availableBalance > 0 && (
        <div className="card bg-brand-50 border-brand-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold text-brand-800">{t('wallet.youHaveToWithdraw', { amount: inr(summary.availableBalance) })}</p>
              <p className="text-xs text-brand-600 mt-0.5">{t('wallet.withdrawalsReviewed')}</p>
            </div>
            <button onClick={() => setWithdrawOpen(true)} className="btn-primary text-sm">{t('wallet.withdrawFunds')}</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-sm text-gray-600 font-medium">{t('wallet.grossAmount')}</p>
          <p className="text-2xl font-bold mt-1">{inr(legacySummary.totalGross)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-600 font-medium">{t('wallet.coopContribution')}</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">{inr(legacySummary.totalCoopDeduction)}</p>
          <p className="text-xs text-gray-500">{t('wallet.forWelfareFund')}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-600 font-medium">{t('wallet.platformFeePaid')}</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{inr(legacySummary.totalPlatformFee)}</p>
        </div>
      </div>

      {chartData.length > 0 && (
        <div className="card">
          <h3 className="font-semibold mb-4">{t('wallet.recentEarnings')}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis />
              <Tooltip />
              <Bar dataKey="gross" fill="#93c5fd" name={t('wallet.gross')} radius={[4, 4, 0, 0]} />
              <Bar dataKey="net" fill="#22c55e" name={t('wallet.net')} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="font-semibold mb-4">{t('wallet.payoutMethods')}</h3>
          {methods.length === 0 ? (
            <p className="text-gray-400 text-sm mb-3">{t('wallet.noPayoutMethods')}</p>
          ) : (
            <ul className="space-y-2 mb-4">
              {methods.map((m) => (
                <li key={m._id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">
                      {m.type === 'BANK' ? `🏦 ${t('wallet.bankAccount')}` : `📱 ${t('wallet.upi')}`}
                      {m.isDefault && <span className="badge bg-brand-100 text-brand-700 ml-2">{t('wallet.default')}</span>}
                    </p>
                    <p className="text-xs text-gray-500">
                      {m.type === 'BANK'
                        ? `${m.accountHolderName || ''} • ${m.accountNumber} • ${m.ifsc}`
                        : m.upiId}
                    </p>
                  </div>
                  <button onClick={() => handleDeleteMethod(m._id)} className="text-xs text-red-500 hover:text-red-700">{t('wallet.remove')}</button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={handleAddMethod} className="space-y-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMethodForm({ ...methodForm, type: 'BANK' })}
                className={`btn text-sm flex-1 ${methodForm.type === 'BANK' ? 'btn-primary' : 'btn-secondary'}`}
              >{t('wallet.bankAccount')}</button>
              <button
                type="button"
                onClick={() => setMethodForm({ ...methodForm, type: 'UPI' })}
                className={`btn text-sm flex-1 ${methodForm.type === 'UPI' ? 'btn-primary' : 'btn-secondary'}`}
              >{t('wallet.upi')}</button>
            </div>
            {methodForm.type === 'BANK' ? (
              <>
                <input placeholder={t('wallet.accountHolderName')} value={methodForm.accountHolderName} onChange={(e) => setMethodForm({ ...methodForm, accountHolderName: e.target.value })} className="input-field" required />
                <input placeholder={t('wallet.accountNumber')} value={methodForm.accountNumber} onChange={(e) => setMethodForm({ ...methodForm, accountNumber: e.target.value })} className="input-field" required />
                <input placeholder={t('wallet.ifsc')} value={methodForm.ifsc} onChange={(e) => setMethodForm({ ...methodForm, ifsc: e.target.value })} className="input-field" required />
              </>
            ) : (
              <input placeholder={t('wallet.upiId')} value={methodForm.upiId} onChange={(e) => setMethodForm({ ...methodForm, upiId: e.target.value })} className="input-field" required />
            )}
            <button type="submit" disabled={addingMethod} className="btn btn-primary text-sm">
              {addingMethod ? t('wallet.saving') : t('wallet.addPayoutMethod')}
            </button>
          </form>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-4">{t('wallet.withdrawalHistory')}</h3>
          {payouts.length === 0 ? (
            <p className="text-gray-400 text-sm">{t('wallet.noWithdrawals')}</p>
          ) : (
            <div className="space-y-3 max-h-[420px] overflow-y-auto">
              {payouts.map((p) => (
                <div key={p._id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{p.payoutNumber}</p>
                    <p className="text-xs text-gray-500">{p.status === 'PENDING' ? t('wallet.awaitingReview') : new Date(p.requestedAt).toLocaleString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold">₹{p.amount.toLocaleString('en-IN')}</p>
                    <span className={`badge ${payoutStatusCls(p.status)}`}>{payoutStatusLabel(p.status)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{t('wallet.ledger')}</h3>
          <span className="text-xs text-gray-400">{t('wallet.auditTrail')}</span>
        </div>
        {transactions.length === 0 ? (
          <p className="text-gray-400 text-sm">{t('wallet.noActivity')}</p>
        ) : (
          <div className="space-y-3 max-h-[440px] overflow-y-auto">
            {transactions.map((t2) => (
              <div key={t2._id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-sm font-medium">
                    {t2.type === 'JOB_EARNING' ? `💰 ${t('wallet.jobEarning')}` : t2.type === 'HELPER_EARNING' ? `🤝 ${t('wallet.helperEarning')}` : t2.type === 'HELPER_PAYMENT' ? `💸 ${t('wallet.helperPayment')}` : t2.type === 'WITHDRAWAL' ? `🏦 ${t('wallet.withdrawal')}` : t2.type}
                    {t2.booking?.serviceSnapshot?.name ? ` — ${t2.booking.serviceSnapshot.name}` : ''}
                  </p>
                  <p className="text-xs text-gray-500">{t2.description || ''}{t2.reference ? ` (${t2.reference})` : ''}</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-bold ${t2.type === 'JOB_EARNING' || t2.type === 'HELPER_EARNING' ? 'text-green-600' : t2.type === 'HELPER_PAYMENT' ? 'text-red-600' : 'text-gray-700'}`}>
                    {t2.type === 'WITHDRAWAL' && t2.status === 'REVERSED' ? '+' : t2.type === 'WITHDRAWAL' || t2.type === 'HELPER_PAYMENT' ? '−' : '+'}{inr(t2.amount)}
                  </p>
                  <span className={`badge ${txnStatusCls(t2.status)}`}>{t2.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {withdrawOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">{t('wallet.withdrawFunds')}</h3>
              <button onClick={() => setWithdrawOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <form onSubmit={handleWithdraw} className="p-6 space-y-4">
              <p className="text-sm text-gray-500">
                {t('wallet.availableBalanceLabel')}: <span className="font-bold text-green-700">{inr(summary.availableBalance)}</span>
              </p>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('wallet.amount')} (₹)</label>
                <input
                  type="number"
                  min="1"
                  max={summary.availableBalance}
                  value={withdrawForm.amount}
                  onChange={(e) => setWithdrawForm({ ...withdrawForm, amount: e.target.value })}
                  className="input-field mt-1"
                  placeholder={t('wallet.enterAmount')}
                  required
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('wallet.payoutMethod')}</label>
                <select
                  value={withdrawForm.payoutMethodId}
                  onChange={(e) => setWithdrawForm({ ...withdrawForm, payoutMethodId: e.target.value })}
                  className="input-field mt-1"
                >
                  <option value="">{t('wallet.selectMethod')}</option>
                  {methods.map((m) => (
                    <option key={m._id} value={m._id}>
                      {m.type === 'BANK'
                        ? `${m.accountHolderName || 'Bank'} ${m.accountNumber} • ${m.ifsc}`
                        : `UPI ${m.upiId}`}
                    </option>
                  ))}
                </select>
                {methods.length === 0 && (
                  <p className="text-xs text-orange-500 mt-1">{t('wallet.addMethodFirst')}</p>
                )}
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setWithdrawOpen(false)} className="btn-secondary text-sm">{t('common.cancel')}</button>
                <button type="submit" disabled={withdrawing} className="btn-primary text-sm">
                  {withdrawing ? t('wallet.requesting') : t('wallet.requestWithdrawal')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}