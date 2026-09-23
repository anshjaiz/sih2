import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { getPayableTeams, payTeamMember } from '../../services/collaboratorService';

const inr = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function TeamPayments() {
  const { t } = useTranslation();
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getPayableTeams();
      setTeams(Array.isArray(res?.data) ? res.data : []);
    } catch (e) {
      toast.error(e?.response?.data?.message || t('collab.paymentsLoadFailed', 'Could not load payments'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handlePay = async (teamId, memberId, amount) => {
    setPaying(memberId);
    try {
      const res = await payTeamMember(teamId, memberId, amount);
      toast.success(res?.message || t('collab.paySuccess', 'Helper paid'));
      await load();
    } catch (e) {
      toast.error(e?.message || t('collab.payFailed', 'Payment failed'));
    } finally {
      setPaying(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600"></div>
      </div>
    );
  }

  if (!teams.length) {
    return (
      <div className="text-center py-16 text-gray-400">
        <div className="text-4xl mb-2">💸</div>
        {t('collab.noPayments', 'No helper payments to make yet.')}
        <br />
        {t('collab.noPaymentsHint', 'Once you lead a job with collaborators and it is completed, you can pay your helpers from here.')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">
        {t('collab.paymentsHint', 'Pay your helpers for completed jobs. Payments come out of your available wallet balance.')}
      </p>
      {teams.map((team) => (
        <div key={team.teamId} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-gray-800">
                {team.booking?.service || t('collab.job', 'Job')}
                <span className="ml-2 text-xs font-normal text-gray-500">{team.booking?.bookingNumber}</span>
              </p>
              <p className="text-xs text-gray-500">{team.booking?.address} · {team.booking?.city}</p>
            </div>
            <span className="badge bg-emerald-100 text-emerald-700 text-xs">
              {t('collab.completed', 'Completed')}
            </span>
          </div>
          <ul className="divide-y divide-gray-100">
            {team.members.map((m) => {
              const remaining = Math.max(0, m.remaining || 0);
              return (
                <li key={m.memberId} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex-1 min-w-[180px]">
                    <p className="font-medium text-gray-800">{m.workerName}</p>
                    <p className="text-xs text-gray-500">{m.role || 'Helper'}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {t('collab.estimate', 'Estimate')}: {inr(m.paymentEstimate)} ·{' '}
                      {t('collab.paid', 'Paid')}: {inr(m.paidAmount)}
                    </p>
                  </div>
                  <div className="text-right">
                    {m.paid || remaining <= 0 ? (
                      <span className="badge bg-emerald-100 text-emerald-700">
                        ✓ {t('collab.paidInFull', 'Paid in full')}
                      </span>
                    ) : (
                      <button
                        onClick={() => handlePay(team.teamId, m.memberId, remaining)}
                        disabled={paying === m.memberId}
                        className="btn-primary text-sm px-3 py-1.5"
                      >
                        {paying === m.memberId
                          ? t('collab.paying', 'Paying…')
                          : `${t('collab.pay', 'Pay')} ${inr(remaining)}`}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}