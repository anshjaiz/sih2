import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../../components/LanguageSelector';
import toast from 'react-hot-toast';
import { HiEye, HiEyeOff } from 'react-icons/hi';
import { HiOutlineSparkles, HiOutlineUsers, HiOutlineShieldCheck } from 'react-icons/hi2';

const MODE_META = {
  customer: {
    titleKey: 'auth.customerRoleTitle',
    subKey: 'auth.customerRoleSub',
    goto: '/customer',
    loginLinkKey: 'auth.workerLoginLink',
    loginLinkTo: '/worker/login',
    adminLinkKey: 'auth.adminLoginLink',
    adminLinkTo: '/admin/login',
    register: true,
    regTxtKey: 'auth.registerNow',
  },
  worker: {
    titleKey: 'auth.workerRoleTitle',
    subKey: 'auth.workerRoleSub',
    goto: '/worker',
    loginLinkKey: 'auth.customerLoginLink',
    loginLinkTo: '/customer/login',
    adminLinkKey: 'auth.adminLoginLink',
    adminLinkTo: '/admin/login',
    register: true,
    regTxtKey: 'auth.registerNow',
  },
  admin: {
    titleKey: 'auth.adminRoleTitle',
    subKey: 'auth.adminRoleSub',
    goto: '/admin',
    loginLinkKey: 'auth.customerLoginLink',
    loginLinkTo: '/customer/login',
    workerLinkKey: 'auth.workerLoginLink',
    workerLinkTo: '/worker/login',
    register: false,
  },
};

export default function RoleLogin({ mode = 'customer' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const meta = MODE_META[mode];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error(t('auth.requiredFields'));
      return;
    }
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.success) {
        const role = result.data?.user?.role;
        if (role !== mode) {
          // Role guard: a Customer cred <;> a Worker/Admin log-in page (or vice
          // versa) must be refused here, not silently routed into that dashboard.
          toast.error(t('auth.wrongRole', { roleKey: meta.titleKey && t(mode === 'customer' ? 'nav.worker' : 'nav.customer') }));
          setLoading(false);
          return;
        }
        toast.success(t('auth.loginSuccess'));
        navigate(meta.goto);
      } else {
        toast.error(result.message || t('auth.loginFailed'));
      }
    } catch (err) {
      toast.error(err.message || t('auth.loginFailed'));
    }
    setLoading(false);
  };

  return (
    <div className="auth-page flex items-center justify-center p-4 sm:p-8">
      <div className="auth-shell grid w-full max-w-5xl overflow-hidden rounded-[1.25rem] lg:grid-cols-[1.08fr_0.92fr]">
        <div className="bg-white p-6 sm:p-12">
          <LanguageSelector />
          <div className="mt-8">
            <h1 className="text-2xl font-bold text-gray-900">{t(meta.titleKey)}</h1>
            <p className="mt-2 text-gray-600">{t(meta.subKey)}</p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-4">
              <div>
                <label className="auth-label" htmlFor="email">{t('auth.email')}</label>
                <input id="email" type="email" className="auth-input" placeholder={t('auth.emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div>
                <label className="auth-label" htmlFor="password">{t('auth.password')}</label>
                <div className="relative">
                  <input id="password" type={showPassword ? 'text' : 'password'} className="auth-input pr-12" placeholder={t('auth.passwordPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" onClick={() => setShowPassword((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" aria-label="Toggle password">
                    {showPassword ? <HiEyeOff /> : <HiEye />}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                  <input type="checkbox" className="checkbox" id="remember" />
                  <span>{t('auth.rememberMe')}</span>
                </label>
                <Link to="/forgot-password" className="text-sm text-brand-700 hover:underline">{t('auth.forgotPassword')}</Link>
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full">
                {loading ? t('auth.signingIn') : t('auth.signIn')}
              </button>
              <Link to="/forgot-password" className="block text-center text-sm text-brand-700 hover:underline">{t('auth.forgotPassword')}</Link>
            </form>

            <div className="mt-6 text-center text-sm text-gray-600">
              {meta.register ? (
                <>
                  {t('auth.dontHaveAccount')}{' '}
                  <Link to="/register" className="font-medium text-brand-700 hover:underline">{t(meta.regTxtKey)}</Link>
                </>
              ) : null}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-center text-sm text-gray-600">
              <Link to={meta.loginLinkTo} className="text-brand-700 hover:underline">{t(meta.loginLinkKey)}</Link>
              <span className="mx-1 text-gray-300">•</span>
              <Link to={meta.adminLinkTo} className="text-brand-700 hover:underline">{t(meta.adminLinkKey)}</Link>
            </div>
            <div className="mt-3 text-center">
              <Link to="/login" className="text-sm text-gray-500 hover:underline">{t('auth.backToRoleSelect')}</Link>
            </div>
          </div>
        </div>

        <div className="hidden lg:flex relative flex-col justify-center overflow-hidden bg-gradient-to-br from-[#245f4e] to-[#0c2f26] p-10 text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.12)_1px,transparent_1px)]" style={{ backgroundSize: '24px 24px' }} />
          <div className="relative z-10">
            <p className="font-display text-xs uppercase tracking-[0.3em] text-[#f5b301]">{t('auth.employeeNameOrg')}</p>
            <h2 className="mt-3 text-2xl font-bold">{t('auth.whatIsShramikSetu')}</h2>
            <p className="mt-3 text-sm text-emerald-50/85">{t('auth.platformDesc')}</p>
            <div className="mt-8 space-y-4">
              <div className="flex items-start gap-3">
                <HiOutlineUsers className="mt-0.5 h-5 w-5 text-[#f5b301]" />
                <div><p className="font-medium">{t('auth.instantConnect')}</p></div>
              </div>
              <div className="flex items-start gap-3">
                <HiOutlineSparkles className="mt-0.5 h-5 w-5 text-[#f5b301]" />
                <div><p className="font-medium">{t('auth.fairWages')}</p></div>
              </div>
              <div className="flex items-start gap-3">
                <HiOutlineShieldCheck className="mt-0.5 h-5 w-5 text-[#f5b301]" />
                <div><p className="font-medium">{t('auth.securePayments')}</p></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
