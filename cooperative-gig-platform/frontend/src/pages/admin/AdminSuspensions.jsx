import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import toast from 'react-hot-toast';

const TABS = [
  ['customers', 'Customers'],
  ['workers', 'Workers'],
  ['logs', 'Audit log'],
];

const FILTERS = [
  ['all', 'All'],
  ['suspended', 'Currently suspended'],
  ['recent', 'Recently suspended'],
  ['highCancels', 'High cancellation count'],
  ['lowScore', 'Low reliability'],
  ['auto', 'Automatic suspension'],
];

const ACTIONS = [
  '',
  'CUSTOMER_AUTO_SUSPENDED',
  'CUSTOMER_UNSUSPENDED',
  'WORKER_AUTO_SUSPENDED',
  'WORKER_UNSUSPENDED',
  'CANCELLATION_PENALTY_APPLIED',
  'WORKER_COMPENSATION_CREATED',
  'MERIT_SCORE_CHANGED',
];

const scoreColor = (s) =>
  s >= 80 ? 'text-green-600' : s >= 60 ? 'text-yellow-600' : s >= 40 ? 'text-orange-600' : 'text-red-600';

const fmt = (d) =>
  d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function AdminSuspensions() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('customers');
  const [filter, setFilter] = useState('all');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(false);
  const [promptFor, setPromptFor] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const endpoint = () =>
    tab === 'logs'
      ? '/admin/suspensions/logs'
      : tab === 'workers'
      ? '/admin/suspensions/workers'
      : '/admin/suspensions/customers';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ filter, page, limit: 20 });
      if (search) params.set('search', search);
      if (action) params.set('action', action);
      const res = await api.get(`${endpoint()}?${params}`);
      setData(res.data || []);
      setMeta(res.meta || {});
    } catch (e) {
      toast.error(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [tab, filter, search, action, page]);

  useEffect(() => {
    load();
  }, [load]);

  const resetPaging = () => setPage(1);

  const doUnsuspend = async () => {
    if (!promptFor) return;
    setBusy(true);
    try {
      const base =
        promptFor.type === 'workers' ? '/admin/suspensions/workers' : '/admin/suspensions/customers';
      await api.post(`${base}/${promptFor.id}/unsuspend`, { reason });
      toast.success(t('admSusp.unsuspendSuccess'));
      setPromptFor(null);
      setReason('');
      load();
    } catch (e) {
      toast.error(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const openUnsuspend = (type, row) =>
    setPromptFor({ type, id: row.id, name: row.name || row.email || row._id || 'user' });

  const statusBadge = (row) => {
    if (tab === 'customers') {
      const active = row.suspensionStatus !== 'SUSPENDED' || (row.suspendedUntil && new Date(row.suspendedUntil).getTime() <= Date.now());
      return (
        <span className={`badge ${active ? 'badge-success' : 'badge-danger'}`}>
          {active ? 'ACTIVE' : 'SUSPENDED'}
        </span>
      );
    }
    if (tab === 'logs') return null;
    const suspended =
      row.isActive === false || ['TEMPORARILY_SUSPENDED', 'DEACTIVATION_REVIEW'].includes(row.accountStatus);
    return (
      <span className={`badge ${suspended ? 'badge-danger' : 'badge-success'}`}>
        {suspended ? row.accountStatus || 'SUSPENDED' : 'ACTIVE'}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">{t('admSusp.title')}</h2>
        <p className="text-sm text-gray-500">{t('admSusp.subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              resetPaging();
              setAction('');
            }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium ${tab === k ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {t(`admSusp.tab.${k}`, { defaultValue: label })}
          </button>
        ))}
      </div>

      {tab !== 'logs' && (
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => {
                setFilter(k);
                resetPaging();
              }}
              className={`px-3 py-1 rounded-full text-xs font-medium ${filter === k ? 'bg-[#183d31] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {t(`admSusp.filter.${k}`, { defaultValue: label })}
            </button>
          ))}
        </div>
      )}

      {tab === 'logs' && (
        <div className="flex items-center gap-3">
          <select value={action} onChange={(e) => { setAction(e.target.value); resetPaging(); }} className="input-field max-w-xs">
            {ACTIONS.map((a) => (
              <option key={a || 'all'} value={a}>{a ? a.replace(/_/g, ' ') : t('admSusp.allActions')}</option>
            ))}
          </select>
          <span className="text-sm text-gray-500">{meta.total} {t('admSusp.entries')}</span>
        </div>
      )}

      {tab !== 'logs' && (
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPaging(); }}
            placeholder={t('admSusp.searchPlaceholder')}
            className="input-field max-w-sm"
          />
          <span className="text-sm text-gray-500">{meta.total} {t('admSusp.records')}</span>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600" />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          {tab === 'customers' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="pb-3 font-medium">Customer</th>
                  <th className="pb-3 font-medium">Customer ID</th>
                  <th className="pb-3 font-medium">Reli score</th>
                  <th className="pb-3 font-medium">Eligible cancels</th>
                  <th className="pb-3 font-medium">Reason</th>
                  <th className="pb-3 font-medium">Suspended at</th>
                  <th className="pb-3 font-medium">Suspended until</th>
                  <th className="pb-3 font-medium">Balance</th>
                  <th className="pb-3 font-medium">Auto</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.length === 0 && (
                  <tr><td colSpan={11} className="py-10 text-center text-gray-400">{t('admSusp.empty')}</td></tr>
                )}
                {data.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="py-3">
                      <p className="font-medium">{row.name || '—'}</p>
                      <p className="text-xs text-gray-500">{row.email} {row.phone ? `· ${row.phone}` : ''}</p>
                    </td>
                    <td className="py-3 text-gray-500 text-xs whitespace-nowrap">{row.userId ? String(row.userId).slice(-8) : '—'}</td>
                    <td className={`py-3 font-bold ${scoreColor(row.reliabilityScore)}`}>{row.reliabilityScore ?? 100}</td>
                    <td className="py-3 text-gray-600">{row.eligibleCancellationCount}</td>
                    <td className="py-3 text-gray-500 max-w-[160px] truncate" title={row.suspensionReason}>{row.suspensionReason || '—'}</td>
                    <td className="py-3 text-gray-500 whitespace-nowrap">{fmt(row.suspendedAt)}</td>
                    <td className="py-3 text-gray-500 whitespace-nowrap">{fmt(row.suspendedUntil)}</td>
                    <td className={`py-3 font-semibold ${row.outstandingCancellationBalance > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                      ₹{Number(row.outstandingCancellationBalance || 0).toLocaleString('en-IN')}
                    </td>
                    <td className="py-3">
                      {row.autoSuspended ? <span className="badge badge-info">auto</span> : <span className="badge badge-gray">manual</span>}
                    </td>
                    <td className="py-3">{statusBadge(row)}</td>
                    <td className="py-3 text-right">
                      <button onClick={() => openUnsuspend('customers', row)} className="btn-secondary text-xs px-3 py-1.5">
                        {t('admSusp.unsuspend')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'workers' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="pb-3 font-medium">Worker</th>
                  <th className="pb-3 font-medium">Reli score</th>
                  <th className="pb-3 font-medium">Eligible cancels</th>
                  <th className="pb-3 font-medium">Reason</th>
                  <th className="pb-3 font-medium">Suspended until</th>
                  <th className="pb-3 font-medium">Auto</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.length === 0 && (
                  <tr><td colSpan={8} className="py-10 text-center text-gray-400">{t('admSusp.empty')}</td></tr>
                )}
                {data.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50">
                    <td className="py-3">
                      <p className="font-medium">{row.name || '—'}</p>
                      <p className="text-xs text-gray-500">{row.email} {row.phone ? `· ${row.phone}` : ''}</p>
                    </td>
                    <td className={`py-3 font-bold ${scoreColor(row.reliability ?? 100)}`}>{row.reliability ?? 100}</td>
                    <td className="py-3 text-gray-600">{row.eligibleCancellationCount}</td>
                    <td className="py-3 text-gray-500 max-w-[160px] truncate" title={row.suspensionNote}>{row.suspensionNote || '—'}</td>
                    <td className="py-3 text-gray-500 whitespace-nowrap">{fmt(row.suspendedUntil)}</td>
                    <td className="py-3">
                      {row.autoSuspended ? <span className="badge badge-info">auto</span> : <span className="badge badge-gray">manual</span>}
                    </td>
                    <td className="py-3">{statusBadge(row)}</td>
                    <td className="py-3 text-right">
                      <button onClick={() => openUnsuspend('workers', row)} className="btn-secondary text-xs px-3 py-1.5">
                        {t('admSusp.unsuspend')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'logs' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="pb-3 font-medium">Action</th>
                  <th className="pb-3 font-medium">Performed by</th>
                  <th className="pb-3 font-medium">Target</th>
                  <th className="pb-3 font-medium">Reason</th>
                  <th className="pb-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.length === 0 && (
                  <tr><td colSpan={5} className="py-10 text-center text-gray-400">{t('admSusp.empty')}</td></tr>
                )}
                {data.map((log) => (
                  <tr key={log._id} className="hover:bg-gray-50">
                    <td className="py-3">
                      <span className="badge badge-info">{String(log.action || '').replace(/_/g, ' ')}</span>
                    </td>
                    <td className="py-3 text-gray-700">{log.performedBy?.name || log.performedBy?.email || '—'}</td>
                    <td className="py-3 text-gray-700">
                      {log.targetUser ? `${log.targetUser.name || ''} ${log.targetUser.email ? `· ${log.targetUser.email}` : ''}` : log.targetProfile || '—'}
                      {log.targetRole ? <span className="ml-1 text-xs text-gray-400">({log.targetRole})</span> : null}
                    </td>
                    <td className="py-3 text-gray-500 max-w-[200px] truncate" title={log.reason}>{log.reason || '—'}</td>
                    <td className="py-3 text-gray-500 whitespace-nowrap">{fmt(log.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {meta.pages > 1 && (
            <div className="flex justify-center gap-2 mt-4">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-secondary text-sm">← Prev</button>
              <span className="text-sm text-gray-500 py-2">{page} / {meta.pages}</span>
              <button onClick={() => setPage((p) => p + 1)} disabled={page >= meta.pages} className="btn-secondary text-sm">Next →</button>
            </div>
          )}
        </div>
      )}

      {promptFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <h3 className="font-bold text-gray-900">{t('admSusp.unsuspendPromptTitle')}</h3>
            <p className="text-sm text-gray-500 mt-1">
              {t('admSusp.unsuspendPromptFor')} <span className="font-semibold text-gray-800">{promptFor.name}</span>
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={t('admSusp.unsuspendReasonPlaceholder')}
              className="input-field mt-4 w-full"
            />
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => { setPromptFor(null); setReason(''); }} className="btn-secondary">{t('common.cancel')}</button>
              <button onClick={doUnsuspend} disabled={busy} className="btn-primary">
                {busy ? '…' : t('admSusp.confirmUnsuspend')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}