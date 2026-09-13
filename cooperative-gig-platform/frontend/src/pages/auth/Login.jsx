import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../../components/LanguageSelector';
import toast from 'react-hot-toast';
import { HiEye, HiEyeOff } from 'react-icons/hi';
import { HiOutlineShieldCheck, HiOutlineSparkles, HiOutlineUsers } from 'react-icons/hi2';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error(t('toast.fillAllFields'));
      return;
    }
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.success) {
        toast.success(t('toast.loginSuccess'));
        const role = result.data.user.role;
        navigate(`/${role === 'worker' ? 'worker' : role === 'admin' ? 'admin' : 'customer'}`);
      } else {
        toast.error(result.message || t('toast.loginFailed'));
      }
    } catch (err) {
      toast.error(err.message || t('toast.loginFailed'));
    }
    setLoading(false);
  };

  return (
    <div className="auth-page flex items-center justify-center p-4 sm:p-8">
      <div className="absolute top-4 right-4"><LanguageSelector /></div>
      <div className="auth-shell grid w-full max-w-5xl overflow-hidden rounded-[1.25rem] lg:grid-cols-[0.92fr_1.08fr]">
        <div className="auth-story hidden p-10 lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <span className="auth-mark">{t('app.shortName')}</span>
              <span className="text-sm font-semibold tracking-wide text-emerald-50">SHRAMIK SETU</span>
            </div>
            <div className="mt-20 max-w-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200">Work with dignity</p>
              <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight">Better work happens when we work together.</h2>
              <p className="mt-5 text-sm leading-6 text-emerald-50/75">A trusted cooperative for skilled people and the communities they serve.</p>
            </div>
          </div>
          <div className="relative z-10 grid grid-cols-3 gap-3 text-xs text-emerald-50/80">
            <div><HiOutlineUsers className="mb-2 h-5 w-5 text-amber-200" /><span>People first</span></div>
            <div><HiOutlineShieldCheck className="mb-2 h-5 w-5 text-amber-200" /><span>Trusted service</span></div>
            <div><HiOutlineSparkles className="mb-2 h-5 w-5 text-amber-200" /><span>Fair opportunity</span></div>
          </div>
        </div>

        <div className="p-6 sm:p-10">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-3"><span className="auth-mark">{t('app.shortName')}</span><span className="text-sm font-bold tracking-wide text-[#245f4e]">SHRAMIK SETU</span></div>
          </div>
          <div className="mb-8">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-[#c18b25]">Welcome back</p>
            <h1 className="text-3xl font-bold tracking-tight text-[#17211b]">{t('auth.signIn')}</h1>
            <p className="mt-2 text-sm text-[#68756b]">{t('auth.signInTitle')}</p>
          </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-semibold text-[#35443a]">{t('auth.email')}</label>
            <input
              type="email"
              className="auth-input"
              placeholder={t('auth.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-[#35443a]">{t('auth.password')}</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                className="auth-input pr-10"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8a958b] hover:text-[#245f4e]"
              >
                {showPassword ? <HiEyeOff className="w-5 h-5" /> : <HiEye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
              <span className="text-[#68756b]">{t('auth.rememberMe')}</span>
            </label>
            <Link to="/forgot-password" className="font-semibold text-[#245f4e] hover:text-[#183b32]">
              {t('auth.forgotPassword')}
            </Link>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="auth-button flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></span>
                {t('auth.signingIn')}
              </>
            ) : (
              t('auth.signIn')
            )}
          </button>
        </form>

        <div className="mt-7 text-center text-sm text-[#68756b]">
          {t('auth.dontHaveAccount')}{' '}
          <Link to="/register" className="font-bold text-[#245f4e] hover:text-[#183b32]">{t('auth.registerNow')}</Link>
        </div>

        <div className="mt-7 rounded-lg border border-[#e5e4d9] bg-[#f7f5ef] p-4 text-xs text-[#68756b]">
          <p className="mb-2 font-bold text-[#35443a]">{t('auth.demoCredentials')}</p>
          <p>{t('auth.adminCreds')}</p>
          <p>{t('auth.customerCreds')}</p>
          <p>{t('auth.workerCreds')}</p>
        </div>
        </div>
      </div>
    </div>
  );
}