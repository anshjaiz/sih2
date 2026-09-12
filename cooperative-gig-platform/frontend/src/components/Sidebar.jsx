import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HiOutlineHome, HiOutlineBriefcase, HiOutlineUser, HiOutlineCurrencyRupee,
  HiOutlineHeart, HiOutlineChartBar, HiOutlineCog, HiOutlineLogout,
  HiOutlineBell, HiOutlineMenu, HiOutlineX, HiOutlineFire,
  HiOutlineExclamation, HiOutlineMap, HiOutlineClock,
  HiOutlineClipboardList, HiOutlineUsers, HiOutlineShieldCheck,
} from 'react-icons/hi';
import { HiOutlineExclamationTriangle } from 'react-icons/hi2';

const ICON_CLASS = 'w-5 h-5';

export default function Sidebar({ role, collapsed, setCollapsed }) {
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const navItems = {
    customer: [
      { to: '/customer', icon: HiOutlineHome, label: t('nav.dashboard'), end: true },
      { to: '/customer/services', icon: HiOutlineBriefcase, label: t('nav.services') },
      { to: '/customer/bookings', icon: HiOutlineClipboardList, label: t('nav.myBookings') },
      { to: '/customer/payments', icon: HiOutlineCurrencyRupee, label: t('nav.payments') },
      { to: '/customer/complaints', icon: HiOutlineExclamationTriangle, label: t('nav.myComplaints') },
      { to: '/customer/profile', icon: HiOutlineUser, label: t('nav.myProfile') },
    ],
    worker: [
      { to: '/worker', icon: HiOutlineHome, label: t('nav.dashboard'), end: true },
      { to: '/worker/jobs', icon: HiOutlineBriefcase, label: t('nav.jobRequests') },
      { to: '/worker/active', icon: HiOutlineClock, label: t('nav.activeJobs') },
      { to: '/worker/history', icon: HiOutlineClipboardList, label: t('nav.jobHistory') },
      { to: '/worker/profile', icon: HiOutlineUser, label: t('nav.myProfile') },
      { to: '/worker/earnings', icon: HiOutlineCurrencyRupee, label: t('nav.earnings') },
      { to: '/worker/collaborations', icon: HiOutlineUsers, label: t('nav.collaborations') },
      { to: '/worker/complaints', icon: HiOutlineExclamationTriangle, label: t('nav.complaints') },
      { to: '/worker/welfare', icon: HiOutlineHeart, label: t('nav.welfare') },
    ],
    admin: [
      { to: '/admin', icon: HiOutlineHome, label: t('nav.dashboard'), end: true },
      { to: '/admin/workers', icon: HiOutlineUsers, label: t('nav.workers') },
      { to: '/admin/bookings', icon: HiOutlineClipboardList, label: t('nav.bookings') },
      { to: '/admin/payments', icon: HiOutlineCurrencyRupee, label: t('nav.payments') },
      { to: '/admin/complaints', icon: HiOutlineExclamationTriangle, label: t('nav.complaints') },
      { to: '/admin/analytics', icon: HiOutlineChartBar, label: t('nav.analytics') },
      { to: '/admin/demand', icon: HiOutlineMap, label: t('nav.demandHeatmap') },
      { to: '/admin/forecast', icon: HiOutlineFire, label: t('nav.aiForecasting') },
      { to: '/admin/reliability', icon: HiOutlineShieldCheck, label: t('nav.reliability') },
      { to: '/admin/suspensions', icon: HiOutlineFire, label: t('nav.suspensions') },
      { to: '/admin/welfare', icon: HiOutlineHeart, label: t('nav.workerWelfare') },
      { to: '/admin/settings', icon: HiOutlineCog, label: t('nav.settings') },
    ],
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <aside className={`flex flex-col border-r border-[#dfe5dc] bg-[#183d31] text-white transition-all duration-300 ${collapsed ? 'w-16' : 'w-64'} fixed h-full z-40`}>
      {/* Logo */}
      <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
        {!collapsed && (
          <div className="flex flex-col min-w-0">
            <span className="truncate text-sm font-bold text-white">{t('app.name')}</span>
            <span className="truncate text-[10px] leading-tight text-emerald-100/60">{t('app.platformTagline')}</span>
          </div>
        )}
        <button onClick={() => setCollapsed(!collapsed)} className="rounded-md p-1 text-emerald-100/60 hover:bg-white/10 hover:text-white">
          {collapsed ? <HiOutlineMenu className="w-5 h-5" /> : <HiOutlineX className="w-5 h-5" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {(navItems[role] || []).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `sidebar-link sidebar-link-dark ${isActive ? 'active' : ''}`
            }
            title={collapsed ? item.label : ''}
          >
            <item.icon className={ICON_CLASS} />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* User + Logout */}
      <div className="border-t border-white/10 px-3 py-4">
        {!collapsed && (
          <div className="mb-2 truncate px-4 text-xs text-emerald-100/70">{user?.name}</div>
        )}
        <button
          onClick={handleLogout}
          className="sidebar-link w-full text-left text-rose-200 hover:bg-rose-400/10 hover:text-white"
        >
          <HiOutlineLogout className={ICON_CLASS} />
          {!collapsed && <span>{t('nav.logout')}</span>}
        </button>
      </div>
    </aside>
  );
}
