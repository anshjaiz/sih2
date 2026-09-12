import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import {
  HiOutlineUser,
  HiOutlineExclamationTriangle,
  HiOutlineScale,
  HiOutlineCurrencyRupee,
  HiOutlineShieldCheck,
  HiOutlineCalendar,
} from 'react-icons/hi2';

export default function Profile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [cancellations, setCancellations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, cl] = await Promise.all([
          api.get('/customers/profile'),
          api.get('/customers/cancellations'),
        ]);
        setProfile(p.data || p);
        setCancellations(cl.data || []);
      } catch {
        /* handled by interceptor toast-free */
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const now = Date.now();
  const suspended =
    profile?.suspensionStatus === 'SUSPENDED' &&
    (!profile.suspendedUntil || new Date(profile.suspendedUntil).getTime() > now);

  const score = profile?.reliabilityScore ?? 100;
  const levelLabel =
    score >= 80
      ? t('custprof.levelGood')
      : score >= 60
      ? t('custprof.levelFair')
      : score >= 40
      ? t('custprof.levelLow')
      : t('custprof.levelCritical');
  const levelColor =
    score >= 80 ? 'text-emerald-600' : score >= 60 ? 'text-amber-600' : 'text-red-600';

  const balance = profile?.outstandingCancellationBalance || 0;

  const stageLabel = (stage) =>
    t(`custprof.stage.${stage}`, { defaultValue: stage || '—' });

  const fmt = (d) =>
    d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#183d31]" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <HiOutlineUser className="w-7 h-7 text-[#183d31]" />
        <div>
          <h2 className="text-xl font-bold text-gray-900">{t('custprof.title')}</h2>
          <p className="text-sm text-gray-500">{t('custprof.subtitle')}</p>
        </div>
      </div>

      {/* Suspension screen */}
      {suspended && (
        <div className="card border-red-200 bg-red-50">
          <div className="flex items-start gap-3">
            <HiOutlineExclamationTriangle className="w-6 h-6 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-red-700">{t('custprof.suspendedTitle')}</h3>
              <p className="text-sm text-red-600 mt-1">
                {profile.suspendedUntil
                  ? t('custprof.suspendedUntil', { date: fmt(profile.suspendedUntil) })
                  : t('custprof.suspendedNoDate')}
              </p>
              {profile.suspensionReason && (
                <p className="text-xs text-red-500 mt-1">{profile.suspensionReason}</p>
              )}
              <p className="text-sm text-red-600 mt-3">
                {t('custprof.suspendedAfter')} <span className="font-semibold">
                  {profile.suspendedUntil ? fmt(profile.suspendedUntil) : '—'}
                </span>.
              </p>
              <p className="text-xs text-red-500 mt-2">{t('custprof.suspendedContact')}</p>
              <button
                onClick={() => navigate('/customer/complaints')}
                className="mt-3 text-sm font-medium text-red-700 underline hover:text-red-800"
              >
                {t('custprof.contactSupport')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reliability / cancellation status */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <HiOutlineShieldCheck className="w-5 h-5 text-[#183d31]" />
            <h3 className="font-semibold text-gray-800">{t('custprof.reliabilityTitle')}</h3>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-gray-900">{Math.round(score)}</span>
            <span className="text-sm text-gray-500">/ 100</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-[#183d31] rounded-full transition-all"
              style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
            />
          </div>
          <p className={`text-sm font-medium mt-2 ${levelColor}`}>{levelLabel}</p>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <HiOutlineScale className="w-5 h-5 text-[#183d31]" />
            <h3 className="font-semibold text-gray-800">{t('custprof.cancellationStatus')}</h3>
          </div>
          <p className="text-sm text-gray-600">
            {t('custprof.eligibleCount')}{' '}
            <span className="font-semibold text-gray-900">
              {profile?.cancellationStats?.eligibleCancellationCount ?? 0}
            </span>
          </p>
          <p className="text-sm text-gray-600 mt-1">
            {t('custprof.meritScore')}{' '}
            <span className="font-semibold text-gray-900">{profile?.meritScore ?? 100}</span>
          </p>
          <p className="text-xs text-gray-400 mt-2">{t('custprof.thresholdHint')}</p>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <HiOutlineCurrencyRupee className="w-5 h-5 text-[#183d31]" />
            <h3 className="font-semibold text-gray-800">{t('custprof.outstandingBalance')}</h3>
          </div>
          <p className={`text-2xl font-bold ${balance > 0 ? 'text-red-600' : 'text-gray-900'}`}>
            ₹{balance.toLocaleString('en-IN')}
          </p>
          <p className="text-xs text-gray-400 mt-2">{t('custprof.outstandingHint')}</p>
        </div>
      </div>

      {/* Cancellation history */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <HiOutlineCalendar className="w-5 h-5 text-[#183d31]" />
          <h3 className="font-semibold text-gray-800">{t('custprof.historyTitle')}</h3>
        </div>

        {cancellations.length === 0 ? (
          <p className="text-sm text-gray-400 py-6 text-center">{t('custprof.historyEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-400">
                  <th className="py-2 pr-3 font-medium">{t('custprof.hDate')}</th>
                  <th className="py-2 pr-3 font-medium">{t('custprof.hService')}</th>
                  <th className="py-2 pr-3 font-medium">{t('custprof.hStage')}</th>
                  <th className="py-2 pr-3 font-medium text-right">{t('custprof.hFee')}</th>
                  <th className="py-2 font-medium">{t('custprof.hReason')}</th>
                </tr>
              </thead>
              <tbody>
                {cancellations.map((c) => (
                  <tr key={c.id} className="border-b border-gray-50">
                    <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{fmt(c.cancelledAt)}</td>
                    <td className="py-2 pr-3 text-gray-800 font-medium">{c.serviceName}</td>
                    <td className="py-2 pr-3 text-gray-500">{stageLabel(c.stage)}</td>
                    <td className="py-2 pr-3 text-right">
                      {c.customerPenaltyAmount > 0 ? (
                        <span className="text-red-600 font-medium">+₹{c.customerPenaltyAmount}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="py-2 text-gray-500 max-w-[180px] truncate" title={c.reason}>
                      {c.reason || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}