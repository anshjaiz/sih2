import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import LanguageSelector from '../components/LanguageSelector';
import NotificationBell from '../components/NotificationBell';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';

export default function DashboardLayout({ role }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { user } = useAuth();
  const { t } = useTranslation();

  const roleLabel = {
    customer: t('roles.customer'),
    worker: t('roles.worker'),
    admin: t('roles.admin'),
  };

  return (
    <div className="dashboard-shell flex h-screen overflow-hidden">
      <Sidebar role={role} collapsed={sidebarCollapsed} setCollapsed={setSidebarCollapsed} />

      {/* Main content */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${sidebarCollapsed ? 'ml-16' : 'ml-64'}`}>
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[#e3e5dc] bg-[#fffdf8]/90 px-6 backdrop-blur-md">
          <div>
            <h1 className="font-bold tracking-tight text-[#17211b]">{roleLabel[role] || t('nav.dashboard')}</h1>
            <p className="text-xs text-[#7a857c]">{t('app.name')}</p>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSelector compact />
            <NotificationBell />
            <div className="text-sm text-gray-700 hidden sm:block">
              <span className="font-semibold text-[#35443a]">{user?.name}</span>
              <span className="text-gray-400 ml-2 text-xs">({user?.role})</span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="dashboard-main flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
