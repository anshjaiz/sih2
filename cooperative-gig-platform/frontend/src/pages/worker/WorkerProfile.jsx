import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import toast from 'react-hot-toast';

export default function WorkerProfile() {
  const { t } = useTranslation();
  const [profile, setProfile] = useState(null);
  const [reliability, setReliability] = useState(null);
  const [loading, setLoading] = useState(true);
  const [allSkills, setAllSkills] = useState([]);
  const [newSkillId, setNewSkillId] = useState('');
  const [form, setForm] = useState({
    bio: '', city: '', area: '', address: '', experienceYears: 0, serviceAreaRadiusKm: 15,
  });

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.get('/workers/profile');
        setProfile(res.data);
        setForm({
          bio: res.data.bio || '',
          city: res.data.city || '',
          area: res.data.area || '',
          address: res.data.address || '',
          experienceYears: res.data.experienceYears || 0,
          serviceAreaRadiusKm: res.data.serviceAreaRadiusKm || 15,
        });
        const skillsRes = await api.get('/services/skills/list');
        setAllSkills(skillsRes.data || []);
        api.get('/workers/me/reliability')
          .then((r) => setReliability(r.data || null))
          .catch(() => setReliability(null));
      } catch (e) {
        console.error(e);
      }
      setLoading(false);
    };
    load();
  }, []);

  const handleUpdate = async (e) => {
    e.preventDefault();
    try {
      await api.put('/workers/profile', form);
      toast.success(t('toast.profileUpdated', 'Profile updated!'));
    } catch (err) {
      toast.error(err.message || t('toast.failed', 'Failed'));
    }
  };

  const handleAddSkill = async () => {
    if (!newSkillId) return toast.error(t('toast.selectSkillFirst', 'Select a skill first'));
    const selected = allSkills.find((s) => s._id === newSkillId);
    try {
      await api.post('/workers/skills', {
        skillId: newSkillId,
        name: selected ? selected.name : '',
        yearsOfExperience: 1,
      });
      toast.success(t('toast.skillAdded', 'Skill added. It will match jobs only after admin verification.'));
      const res = await api.get('/workers/profile');
      setProfile(res.data);
      setNewSkillId('');
    } catch (err) {
      toast.error(err.message || t('toast.failed', 'Failed'));
    }
  };

  if (loading) {
    return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600"></div></div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h2 className="text-xl font-bold text-gray-900">{t('prof.title', 'My Profile')}</h2>

      {/* Status badge */}
      <div className={`card ${
        profile?.verificationStatus === 'VERIFIED' ? 'bg-green-50 border-green-200' :
        profile?.verificationStatus === 'REJECTED' ? 'bg-red-50 border-red-200' :
        'bg-yellow-50 border-yellow-200'
      }`}>
        <p className="font-medium">
          {t('prof.statusLabel', 'Status:')} <span className="font-bold">{profile?.verificationStatus}</span>
          {profile?.verificationStatus === 'VERIFIED' && ' ✅'}
          {profile?.verificationStatus === 'PENDING' && ' ⏳'}
          {profile?.verificationStatus === 'REJECTED' && ' ❌'}
        </p>
        <p className="text-sm text-gray-600 mt-1">{t('prof.completenessMsg', 'Profile completeness affects your matching score')}</p>
      </div>

      {/* Reliability / Merit card */}
      {reliability && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold">{t('prof.reliabilityScore', 'Reliability Score')}</h3>
              <p className="text-xs text-gray-500">
                {reliability.reliability?.score >= 80
                  ? t('prof.goodStanding', 'Good standing — keep it up!')
                  : reliability.reliability?.score >= 60
                  ? t('prof.watchOut', 'Watch out — complete jobs on time to recover points.')
                  : reliability.reliability?.score >= 40
                  ? t('prof.lowReliability', 'Low reliability — frequent failures may limit new jobs.')
                  : t('prof.suspended', 'You are currently suspended from accepting new jobs. Appeal penalties or contact admin.')}
              </p>
            </div>
            <div className="text-right">
              <span className={`text-3xl font-black ${
                reliability.reliability?.score >= 80 ? 'text-green-600'
                : reliability.reliability?.score >= 60 ? 'text-yellow-600'
                : reliability.reliability?.score >= 40 ? 'text-orange-600'
                : 'text-red-600'
              }`}>{reliability.reliability?.score}</span>
              <span className="text-gray-400">/100</span>
            </div>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2.5 mb-3">
            <div
              className={`h-2.5 rounded-full ${
                reliability.reliability?.score >= 80 ? 'bg-green-500'
                : reliability.reliability?.score >= 60 ? 'bg-yellow-500'
                : reliability.reliability?.score >= 40 ? 'bg-orange-500'
                : 'bg-red-500'
              }`}
              style={{ width: `${reliability.reliability?.score || 0}%` }}
            ></div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="badge badge-info">{t('prof.level', 'Level:')} {reliability.reliability?.level}</span>
            <span className={`badge ${
              ['TEMPORARILY_SUSPENDED', 'DEACTIVATION_REVIEW'].includes(reliability.reliability?.level)
                ? 'badge-danger'
                : reliability.reliability?.level === 'WARNING'
                ? 'badge-warning'
                : 'badge-success'
            }`}>{t('prof.statusBadge', 'Status:')} {reliability.reliability?.level?.replace(/_/g, ' ')}</span>
            <span className="badge badge-gray">✅ {reliability.reliability?.completedCount || 0} {t('prof.completed', 'completed')}</span>
            <span className="badge badge-gray">⏱ {reliability.reliability?.onTimeCount || 0} {t('prof.onTime', 'on-time')}</span>
            <span className="badge badge-gray">🚫 {reliability.reliability?.noShowCount || 0} {t('prof.noShows', 'no-shows')}</span>
            <span className="badge badge-gray">⏰ {reliability.reliability?.lateCount || 0} {t('prof.late', 'late')}</span>
          </div>
          {reliability.recentEvents?.length > 0 && (
            <div className="mt-3 space-y-1 max-h-40 overflow-y-auto">
              {reliability.recentEvents.map((ev) => (
                <div key={ev._id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1">
                  <span className="text-gray-600">{ev.eventType} — {ev.reason}</span>
                  <span className={`font-medium ${ev.points >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {ev.points >= 0 ? '+' : ''}{ev.points} ({ev.previousScore} → {ev.newScore})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Basic Info */}
      <form onSubmit={handleUpdate} className="card space-y-4">
        <h3 className="font-semibold">{t('prof.basicInfo', 'Basic Information')}</h3>
        <div>
          <label className="label-text">{t('prof.bio', 'Bio')}</label>
          <textarea className="input-field" rows={3} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder={t('prof.bioPlaceholder', 'Tell customers about your experience...')} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text">{t('prof.city', 'City')}</label>
            <input className="input-field" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Hyderabad" />
          </div>
          <div>
            <label className="label-text">{t('prof.area', 'Area')}</label>
            <input className="input-field" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} placeholder="Kukatpally" />
          </div>
        </div>
        <div>
          <label className="label-text">{t('prof.address', 'Address')}</label>
          <input className="input-field" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={t('prof.addressPlaceholder', 'Full address')} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text">{t('prof.experienceYears', 'Experience (years)')}</label>
            <input type="number" className="input-field" value={form.experienceYears} onChange={(e) => setForm({ ...form, experienceYears: parseInt(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="label-text">{t('prof.serviceRadius', 'Service radius (km)')}</label>
            <input type="number" className="input-field" value={form.serviceAreaRadiusKm} onChange={(e) => setForm({ ...form, serviceAreaRadiusKm: parseInt(e.target.value) || 15 })} />
          </div>
        </div>
        <button type="submit" className="btn-primary">{t('prof.saveProfile', 'Save Profile')}</button>
      </form>

      {/* Skills */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{t('prof.skills', 'Skills')}</h3>
          <div className="flex gap-2">
            <select className="input-field text-sm max-w-[200px]" value={newSkillId} onChange={(e) => setNewSkillId(e.target.value)}>
              <option value="">{t('prof.selectSkill', 'Select skill…')}</option>
              {allSkills
                .filter((s) => !(profile?.skills || []).some((ps) => ps.skill === s._id || (ps.name || '').toLowerCase() === (s.name || '').toLowerCase()))
                .map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
            </select>
            <button onClick={handleAddSkill} className="btn-primary text-sm">+ {t('prof.add', 'Add')}</button>
          </div>
        </div>
        {profile?.skills?.length > 0 ? (
          <div className="space-y-2">
            {profile.skills.map((sk) => (
              <div key={sk._id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{sk.name}</span>
                  <span className="text-xs text-gray-500">{sk.yearsOfExperience} {t('prof.years', 'years')}</span>
                </div>
                <span className={`badge ${sk.verified ? 'badge-success' : 'badge-warning'}`}>
                  {sk.verified ? t('prof.verified', '✓ Verified') : t('prof.pendingApproval', '⏳ Pending approval')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-400 text-sm">{t('prof.noSkills', 'No skills added yet')}</p>
        )}
      </div>
    </div>
  );
}
