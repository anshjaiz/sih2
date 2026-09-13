import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../../components/LanguageSelector';
import toast from 'react-hot-toast';
import { HiOutlineBriefcase, HiOutlineHomeModern, HiOutlineShieldCheck, HiOutlineUsers } from 'react-icons/hi2';

export default function Register() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', role: 'customer' });
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.phone || !form.password) {
      toast.error(t('toast.fillAllFields'));
      return;
    }
    if (form.password.length < 6) {
      toast.error(t('toast.passwordMin'));
      return;
    }
    setLoading(true);
    try {
      const result = await register(form);
      if (result.success) {
        toast.success(result.message || t('toast.registerSuccess'));
        navigate('/login');
      } else {
        toast.error(result.message || t('toast.registrationFailed'));
      }
    } catch (err) {
      toast.error(err.message || t('toast.registrationFailed'));
    }
    setLoading(false);
  };

  return (
    <div className="auth-page flex items-center justify-center p-4 sm:p-8">
      <div className="absolute top-4 right-4"><LanguageSelector /></div>
      <div className="auth-shell grid w-full max-w-5xl overflow-hidden rounded-[1.25rem] lg:grid-cols-[0.92fr_1.08fr]">
        <div className="auth-story hidden p-10 lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3"><span className="auth-mark">{t('app.shortName')}</span><span className="text-sm font-semibold tracking-wide text-emerald-50">SHRAMIK SETU</span></div>
            <div className="mt-20 max-w-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200">Join the collective</p>
              <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight">Your skills deserve a stronger network.</h2>
              <p className="mt-5 text-sm leading-6 text-emerald-50/75">Find meaningful work, grow your livelihood, and be part of a community that has your back.</p>
            </div>
          </div>
          <div className="relative z-10 grid grid-cols-3 gap-3 text-xs text-emerald-50/80">
            <div><HiOutlineUsers className="mb-2 h-5 w-5 text-amber-200" /><span>One community</span></div>
            <div><HiOutlineShieldCheck className="mb-2 h-5 w-5 text-amber-200" /><span>Secure platform</span></div>
            <div><HiOutlineBriefcase className="mb-2 h-5 w-5 text-amber-200" /><span>Real livelihoods</span></div>
          </div>
        </div>

        <div className="p-6 sm:p-10">
          <div className="mb-8 lg:hidden"><div className="flex items-center gap-3"><span className="auth-mark">{t('app.shortName')}</span><span className="text-sm font-bold tracking-wide text-[#245f4e]">SHRAMIK SETU</span></div></div>
          <div className="mb-8">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#c18b25]">Start your journey</p>
            <h1 className="text-3xl font-bold tracking-tight text-[#17211b]">{t('auth.createAccount')}</h1>
            <p className="mt-2 text-sm text-[#68756b]">{t('auth.joinTagline')}</p>
          </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-semibold text-[#35443a]">{t('auth.iAmA')}</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setForm({ ...form, role: 'customer' })}
                className={`auth-role ${
                  form.role === 'customer'
                    ? 'selected'
                    : 'hover:border-[#9eb5a6]'
                }`}
              >
                <HiOutlineHomeModern className="mb-2 h-5 w-5" />
                <span className="block font-bold">{t('roles.customer')}</span>
                <span className="mt-1 block text-xs opacity-70">Book trusted help</span>
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, role: 'worker' })}
                className={`auth-role ${
                  form.role === 'worker'
                    ? 'selected'
                    : 'hover:border-[#9eb5a6]'
                }`}
              >
                <HiOutlineBriefcase className="mb-2 h-5 w-5" />
                <span className="block font-bold">{t('roles.worker')}</span>
                <span className="mt-1 block text-xs opacity-70">Offer your skills</span>
              </button>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-[#35443a]">{t('auth.fullName')}</label>
            <input
              name="name"
              type="text"
              className="auth-input"
              placeholder={t('auth.namePlaceholder')}
              value={form.name}
              onChange={handleChange}
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-[#35443a]">{t('auth.email')}</label>
            <input
              name="email"
              type="email"
              className="auth-input"
              placeholder={t('auth.emailPlaceholder')}
              value={form.email}
              onChange={handleChange}
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-[#35443a]">{t('auth.phone')}</label>
            <input
              name="phone"
              type="tel"
              className="auth-input"
              placeholder={t('auth.phonePlaceholder')}
              value={form.phone}
              onChange={handleChange}
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-[#35443a]">{t('auth.password')}</label>
            <input
              name="password"
              type="password"
              className="auth-input"
              placeholder={t('auth.passwordPlaceholder')}
              value={form.password}
              onChange={handleChange}
              required
              minLength={6}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="auth-button flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span>
                {t('auth.creatingAccount')}
              </>
            ) : (
              t('auth.createAccount')
            )}
          </button>
        </form>

        <div className="mt-7 text-center text-sm text-[#68756b]">
          {t('auth.alreadyHaveAccount')}{' '}
          <Link to="/login" className="font-bold text-[#245f4e] hover:text-[#183b32]">{t('auth.signIn')}</Link>
        </div>
        </div>
      </div>
    </div>
  );
}