import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSelector from '../../components/LanguageSelector';
import { HiOutlineUser, HiOutlineBriefcase, HiOutlineShieldCheck } from 'react-icons/hi2';
import { HiArrowRight } from 'react-icons/hi';

export default function Login() {
  const { t } = useTranslation();

  const roles = [
    {
      to: '/customer/login',
      icon: HiOutlineUser,
      accent: 'from-brand-600 to-brand-800',
      name: t('nav.customer'),
      tagline: t('auth.continueAsCustomer'),
    },
    {
      to: '/worker/login',
      icon: HiOutlineBriefcase,
      accent: 'from-amber-500 to-orange-600',
      name: t('nav.worker'),
      tagline: t('auth.continueAsWorker'),
    },
    {
      to: '/admin/login',
      icon: HiOutlineShieldCheck,
      accent: 'from-gray-700 to-gray-900',
      name: t('nav.admin'),
      tagline: t('auth.continueAsAdmin'),
    },
  ];

  return (
    <div className="auth-page flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-3xl">
        <div className="mb-8 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <span className="auth-mark">{t('app.shortName')}</span>
            <span className="text-sm font-bold tracking-wide text-[#245f4e] hidden sm:inline">
              {t('nav.brandName')}
            </span>
          </Link>
          <LanguageSelector />
        </div>

        <div className="card overflow-hidden">
          <div className="bg-gradient-to-r from-brand-700 to-brand-900 p-8 text-center">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.25em] text-amber-300">
              {t('auth.welcome')}
            </p>
            <h1 className="text-3xl font-bold text-white">{t('auth.chooseRole')}</h1>
            <p className="mt-2 text-sm text-emerald-100">{t('auth.chooseRoleSub')}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-3">
            {roles.map((role) => (
              <Link
                key={role.to}
                to={role.to}
                className="group rounded-xl border border-gray-200 p-5 transition-colors hover:border-brand-400 hover:bg-brand-50/40"
              >
                <div className={`mb-3 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${role.accent} text-white`}>
                  <role.icon className="h-6 w-6" />
                </div>
                <p className="font-semibold text-gray-900">{role.name}</p>
                <p className="mt-1 text-sm text-gray-500">{role.tagline}</p>
                <p className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-700">
                  {t('auth.continue')} <HiArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </p>
              </Link>
            ))}
          </div>

          <div className="border-t border-gray-100 bg-gray-50 p-4 text-center text-sm text-gray-600">
            <span>{t('auth.dontHaveAccount')}</span>{' '}
            <Link to="/register" className="font-semibold text-brand-700 hover:underline">
              {t('auth.registerNow')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
